// =====================================================================================
// lib/stripe.ts — Cliente Stripe SOLO servidor + helpers de Checkout y verificación de
// firma para el marketplace paciente.
//
// Contrato: MARKETPLACE.md § Stripe / § Vendedor formal y comisión (líneas ~10-31),
//           § create_marketplace_checkout_from_hold (líneas ~742-781),
//           § handle_stripe_checkout_completed (líneas ~783-858),
//           § get_marketplace_booking_result (líneas ~860-888).
//
// INVARIANTES DUROS que este módulo materializa (MARKETPLACE.md):
//   1. La cita se crea SOLO tras el webhook firmado. Este archivo NUNCA crea
//      patients/appointments/marketplace_payments: solo (a) crea la Stripe Session para un
//      hold ya validado por el servidor, y (b) verifica la firma del webhook sobre el RAW
//      body. La lógica de dominio (transacción, locks, idempotencia por event_id) vive en
//      las RPC del backend, no aquí.
//   2. Secretos SOLO en el servidor. `STRIPE_SECRET_KEY` y `STRIPE_WEBHOOK_SECRET` NO llevan
//      prefijo NEXT_PUBLIC_ (lo único que Next.js filtra al bundle del navegador). El import
//      `server-only` hace fallar el BUILD si alguien importa este módulo desde un Client
//      Component. El browser jamás toca la Secret Key de Stripe: habla con Route Handlers
//      propios que llaman a estos helpers.
//   3. Precio/moneda/URLs NUNCA vienen del frontend (MARKETPLACE.md §780). El monto es el
//      SNAPSHOT congelado del hold (`slot_holds.amount`, INC-6), la moneda es MXN fija, y las
//      success/cancel URLs se construyen server-side contra `APP_URL`. `createCheckoutFromHold`
//      recibe un input ya validado por la RPC; no acepta datos autoritativos del cliente.
//   4. La firma se verifica sobre el RAW body ANTES de parsear (MARKETPLACE.md §797): por eso
//      `verifyWebhookSignature` toma `rawBody: string | Buffer`, nunca un objeto ya parseado.
//
// NOTA sobre tokens.css: `styles/tokens.css` aplica a UI/TSX; este es un módulo de
// infraestructura server-only sin markup, así que no consume tokens de diseño (no hay
// superficie visual que estilizar).
// =====================================================================================

import 'server-only'; // Guard de build: importar esto desde el cliente ⇒ error de compilación.

import Stripe from 'stripe';

// -------------------------------------------------------------------------------------
// Configuración de entorno (leída SOLO en el servidor).
// -------------------------------------------------------------------------------------

/** Secret Key de la cuenta de EMPRESA de Stripe de Agenda PSI (vendedor formal, §14-18). */
const STRIPE_SECRET_KEY_VAR = 'STRIPE_SECRET_KEY';

/** Signing secret del endpoint de webhook (`whsec_…`). Verifica firma sobre el raw body. */
const STRIPE_WEBHOOK_SECRET_VAR = 'STRIPE_WEBHOOK_SECRET';

/**
 * Origen público de la app (p.ej. `https://agendapsi.mx`). Se usa SOLO para construir las
 * success/cancel URLs server-side; es público por naturaleza, de ahí el prefijo NEXT_PUBLIC_.
 */
const APP_URL = process.env.NEXT_PUBLIC_APP_URL;

/**
 * Versión de API fijada a la que compila el SDK instalado (`stripe@^17`). Pinnear evita que
 * un cambio de default de Stripe altere el shape de la Session/Event bajo nuestros pies.
 * Mantener sincronizada con la versión del paquete al actualizar el SDK.
 */
const STRIPE_API_VERSION = '2024-09-30.acacia' satisfies Stripe.LatestApiVersion;

/** Moneda fija del marketplace: todos los importes son MXN (MARKETPLACE.md §12). */
const MARKETPLACE_CURRENCY = 'mxn' as const;

/** Ventana mínima del Checkout: ≥ 30 min (MARKETPLACE.md §768). Stripe exige ≥ 30 min. */
const CHECKOUT_TTL_SECONDS = 30 * 60;

// -------------------------------------------------------------------------------------
// Error tipado del riel Stripe.
// -------------------------------------------------------------------------------------

/**
 * Envuelve fallas del riel Stripe con un `code` de dominio del contrato (p.ej.
 * `STRIPE_CHECKOUT_FAILED`, `INVALID_STRIPE_SIGNATURE`, `CHECKOUT_EXPIRED`) para que el Route
 * Handler mapee status HTTP y mensaje al paciente sin filtrar detalles internos de Stripe.
 */
export class StripeGatewayError extends Error {
  readonly code: string;
  readonly cause?: unknown;

  constructor(code: string, message: string, cause?: unknown) {
    super(message);
    this.name = 'StripeGatewayError';
    this.code = code;
    this.cause = cause;
  }
}

// -------------------------------------------------------------------------------------
// Cliente Stripe (singleton perezoso, una instancia por proceso de servidor).
// -------------------------------------------------------------------------------------

let _stripe: Stripe | null = null;

/**
 * Cliente Stripe server-only. Lanza si falta la Secret Key: preferimos fallar cerrado antes
 * que intentar una operación de pago sin credenciales. Se lee perezosamente para que las
 * rutas puramente públicas (directorio/perfil) no revienten si la variable no está en ese
 * entorno.
 */
export function getStripe(): Stripe {
  if (_stripe) return _stripe;
  const secretKey = process.env[STRIPE_SECRET_KEY_VAR];
  if (!secretKey) {
    throw new StripeGatewayError(
      'STRIPE_CONFIG_MISSING',
      `[stripe] Falta ${STRIPE_SECRET_KEY_VAR} (secret server-only). No se opera pago sin ella.`,
    );
  }
  _stripe = new Stripe(secretKey, {
    apiVersion: STRIPE_API_VERSION,
    // El SDK trae fetch por defecto en runtimes modernos (Node 18+ / Edge). Sin telemetría.
    telemetry: false,
    appInfo: { name: 'agenda-psi-marketplace' },
  });
  return _stripe;
}

// -------------------------------------------------------------------------------------
// createCheckoutFromHold — crea la Stripe Checkout Session para un hold ya validado.
// -------------------------------------------------------------------------------------

/**
 * Input server-side para crear el Checkout. Lo arma la RPC/Route Handler DESPUÉS de validar
 * cookie, hold vigente y teléfono verificado (MARKETPLACE.md §756-762). NADA de esto viene
 * del cliente: `amount` es el snapshot congelado del hold (`slot_holds.amount`, INC-6), no un
 * precio enviado por el navegador.
 */
export interface CheckoutHoldInput {
  /** `slot_holds.id` — se sella como `client_reference_id` y clave de idempotencia. */
  readonly holdId: string;
  /** Slug del profesional; solo para construir las success/cancel URLs server-side. */
  readonly slug: string;
  /** `professional_id` — metadata mínima para reconciliar en el webhook. */
  readonly professionalId: string;
  /** `service_id` del servicio de marketplace (siempre `online`, §48-56). */
  readonly serviceId: string;
  /** `marketplace_session_id` de la cookie firmada; el webhook revalida que coincida (§803). */
  readonly marketplaceSessionId: string;
  /**
   * Monto en MXN, SNAPSHOT congelado del hold (`slot_holds.amount == default_price`, §766).
   * Entero o decimal de pesos; el `unit_amount` de Stripe se calcula ×100 en centavos.
   * El webhook valida `amount_total == slot_holds.amount * 100` contra ESTE snapshot (§800).
   */
  readonly amount: number;
  /** Nombre del profesional para el line item (display); no autoritativo. */
  readonly professionalName?: string;
}

/** Resultado que consume la RPC para persistir en `slot_holds` y devolver al cliente. */
export interface CheckoutSessionResult {
  readonly stripeCheckoutSessionId: string;
  /** URL de Stripe a la que se redirige al paciente. */
  readonly url: string;
  /** Vencimiento de la Session (ISO-8601), para alinear `checkout_expires_at`/`expires_at`. */
  readonly expiresAt: string;
}

/**
 * Crea la Stripe Checkout Session para un hold vigente. NO crea cita ni pago (§779): eso es
 * exclusivo del webhook firmado. La persistencia en `slot_holds` (session id, amount,
 * expiración) y la revalidación transaccional del slot las hace la RPC llamadora; aquí solo
 * hablamos con Stripe.
 *
 * Idempotencia: usa la clave `marketplace_checkout:{hold_id}` (§768) para que un reintento de
 * red no duplique Sessions. Si el hold ya arrancó Checkout, es la RPC quien decide recuperar
 * la Session existente antes de invocar esto.
 *
 * @throws {StripeGatewayError} `STRIPE_CHECKOUT_FAILED` ante cualquier falla de Stripe.
 */
export async function createCheckoutFromHold(
  hold: CheckoutHoldInput,
): Promise<CheckoutSessionResult> {
  if (!APP_URL) {
    throw new StripeGatewayError(
      'STRIPE_CONFIG_MISSING',
      '[stripe] Falta NEXT_PUBLIC_APP_URL para construir las success/cancel URLs.',
    );
  }
  // Monto → centavos entero. Se calcula server-side desde el snapshot del hold, jamás del
  // cliente (§780). Redondeo defensivo para evitar arrastre de flotante en el ×100.
  const unitAmount = Math.round(hold.amount * 100);
  if (!Number.isInteger(unitAmount) || unitAmount <= 0) {
    throw new StripeGatewayError(
      'STRIPE_CHECKOUT_FAILED',
      `[stripe] Monto inválido para el hold ${hold.holdId}: ${hold.amount}.`,
    );
  }

  // success/cancel URLs construidas server-side (§765). La página de resultado (§860) NO
  // confirma la cita con `success`: hace polling. Por eso solo pasamos identificadores para
  // localizar el hold (checkout_session_id vía template en success; hold_id en ambas, que la
  // RPC también resuelve por cookie.active_hold_id).
  const base = `${APP_URL.replace(/\/+$/, '')}/psicologos/${encodeURIComponent(hold.slug)}/agendar/resultado`;
  const successUrl =
    `${base}?checkout_session_id={CHECKOUT_SESSION_ID}` +
    `&hold_id=${encodeURIComponent(hold.holdId)}&result_hint=success`;
  const cancelUrl =
    `${base}?hold_id=${encodeURIComponent(hold.holdId)}&result_hint=cancel`;

  // Metadata MÍNIMA (§764): solo lo que el webhook necesita para reconciliar. Sin OTP, sin
  // dato clínico, sin PII más allá de identificadores (MARKETPLACE.md § cookie, §221-222).
  const metadata: Record<string, string> = {
    hold_id: hold.holdId,
    marketplace_session_id: hold.marketplaceSessionId,
    professional_id: hold.professionalId,
    service_id: hold.serviceId,
  };

  const expiresAtUnix = Math.floor(Date.now() / 1000) + CHECKOUT_TTL_SECONDS;

  try {
    const session = await getStripe().checkout.sessions.create(
      {
        mode: 'payment',
        // client_reference_id: ancla el hold a la Session (§764).
        client_reference_id: hold.holdId,
        currency: MARKETPLACE_CURRENCY,
        expires_at: expiresAtUnix,
        success_url: successUrl,
        cancel_url: cancelUrl,
        metadata,
        // Espejo de metadata en el PaymentIntent: 2ª barrera de trazabilidad/idempotencia
        // (`stripe_payment_intent_id`, §132), sin datos sensibles.
        payment_intent_data: { metadata },
        line_items: [
          {
            quantity: 1,
            price_data: {
              currency: MARKETPLACE_CURRENCY,
              unit_amount: unitAmount,
              product_data: {
                name: hold.professionalName
                  ? `Primera sesión — ${hold.professionalName}`
                  : 'Primera sesión (marketplace)',
              },
            },
          },
        ],
      },
      // Idempotencia de red por hold (§768): reintento seguro sin Sessions duplicadas.
      { idempotencyKey: `marketplace_checkout:${hold.holdId}` },
    );

    if (!session.url) {
      throw new StripeGatewayError(
        'STRIPE_CHECKOUT_FAILED',
        `[stripe] Session ${session.id} creada sin URL de redirección.`,
      );
    }

    return {
      stripeCheckoutSessionId: session.id,
      url: session.url,
      // `expires_at` viene en segundos Unix; lo normalizamos a ISO para persistir (§767).
      expiresAt: new Date((session.expires_at ?? expiresAtUnix) * 1000).toISOString(),
    };
  } catch (err) {
    if (err instanceof StripeGatewayError) throw err;
    throw new StripeGatewayError(
      'STRIPE_CHECKOUT_FAILED',
      `[stripe] Falló crear el Checkout para el hold ${hold.holdId}.`,
      err,
    );
  }
}

// -------------------------------------------------------------------------------------
// verifyWebhookSignature — verifica la firma del webhook sobre el RAW body.
// -------------------------------------------------------------------------------------

/**
 * Verifica la firma de Stripe sobre el RAW body (MARKETPLACE.md §797: ANTES de parsear) y
 * devuelve el `Stripe.Event` reconstruido. El Route Handler DEBE leer el cuerpo crudo
 * (`await request.text()` con el body parser desactivado) y pasar el header `Stripe-Signature`
 * tal cual: cualquier reserialización rompe la firma.
 *
 * Esto es lo ÚNICO que autentica el webhook. La idempotencia por `event_id`, la validación de
 * `checkout.session.completed`, montos, etc., y la creación de cita/pago viven en
 * `handle_stripe_checkout_completed` (§783-858), no aquí.
 *
 * @param rawBody  Cuerpo HTTP sin parsear (string o Buffer) tal como llegó.
 * @param signature Header `Stripe-Signature` de la petición.
 * @throws {StripeGatewayError} `INVALID_STRIPE_SIGNATURE` si la firma no valida o falta secret.
 */
export function verifyWebhookSignature(
  rawBody: string | Buffer,
  signature: string | null | undefined,
): Stripe.Event {
  const webhookSecret = process.env[STRIPE_WEBHOOK_SECRET_VAR];
  if (!webhookSecret) {
    // Falla cerrado: sin signing secret NO se procesa ningún webhook.
    throw new StripeGatewayError(
      'STRIPE_CONFIG_MISSING',
      `[stripe] Falta ${STRIPE_WEBHOOK_SECRET_VAR}; no se verifica ningún webhook.`,
    );
  }
  if (!signature) {
    throw new StripeGatewayError(
      'INVALID_STRIPE_SIGNATURE',
      '[stripe] Falta el header Stripe-Signature.',
    );
  }
  try {
    return getStripe().webhooks.constructEvent(rawBody, signature, webhookSecret);
  } catch (err) {
    // `constructEvent` lanza si la firma o el timestamp no validan ⇒ código de dominio.
    throw new StripeGatewayError(
      'INVALID_STRIPE_SIGNATURE',
      '[stripe] Firma de webhook inválida.',
      err,
    );
  }
}
