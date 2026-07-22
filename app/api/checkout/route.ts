// =====================================================================================
// app/api/checkout/route.ts
// Marketplace — Route Handler POST /api/checkout. Materializa la función de contrato
// `create_marketplace_checkout_from_hold`: para un hold vigente con teléfono verificado,
// crea la Stripe Checkout Session (sin crear cita ni pago) y devuelve la URL a la que el
// navegador se redirige. Next.js App Router · SERVER-ONLY (nunca corre en el navegador).
//
// Contrato: MARKETPLACE.md § `create_marketplace_checkout_from_hold` (~L742) —
//   · Ruta canónica del contrato: `POST /psicologos/:slug/agendar/checkout`. Este handler es
//     el endpoint del arnés (`/api/checkout`) que lo materializa; `slug` y `hold_id` viajan en
//     el body. Ambos apuntan a la MISMA función lógica.
//   · Entrada { slug, hold_id } + cookie firmada del flujo (con `verified_phone`).
//   · Salida checkout{ url, expires_at } + hold{ público } + next_action.
//   · Errores BOOKING_SESSION_*, PHONE_NOT_VERIFIED, HOLD_NOT_FOUND, HOLD_EXPIRED,
//     CHECKOUT_ALREADY_STARTED, CHECKOUT_EXPIRED, MARKETPLACE_BLOCKED_EXISTING_PATIENT,
//     MARKETPLACE_PROFILE_NOT_FOUND, MARKETPLACE_SERVICE_UNAVAILABLE, SLOT_UNAVAILABLE,
//     STRIPE_CHECKOUT_FAILED.
//   También MARKETPLACE.md § marketplace-pago.md (paso 4 de 4) y § Máquina de estados (~L272).
//
// FRONTERA Node/Postgres — por qué la función lógica se materializa en DOS llamadas RPC:
//   El contrato describe `create_marketplace_checkout_from_hold` como UNA operación: lock →
//   validar → crear Session Stripe → congelar `amount` → persistir `stripe_checkout_session_id`
//   → alinear `expires_at`. Pero una RPC de Postgres NO puede hablar HTTP con Stripe (y jamás
//   se hace HTTP bajo el `agenda_lock`, MARKETPLACE.md §807). Por eso este handler orquesta:
//     Fase `prepare` (RPC, service_role): `FOR UPDATE` sobre el hold, revalida cookie/teléfono
//        contra `patient_phone`, revalida `whatsapp_links` (→ MARKETPLACE_BLOCKED_EXISTING_PATIENT),
//        revalida que el slot siga protegido (→ SLOT_UNAVAILABLE), **congela `slot_holds.amount`**
//        (INC-6) y devuelve los ids/monto necesarios. Si el hold YA tiene Session, la devuelve
//        para recuperarla (idempotencia por hold).
//     Stripe (lib/stripe): `createCheckoutFromHold` con idempotencyKey `marketplace_checkout:{hold_id}`.
//     Fase `attach` (RPC, service_role): re-`FOR UPDATE`, comprueba que nadie adjuntó otra Session
//        entretanto (carrera de doble pestaña ⇒ CHECKOUT_ALREADY_STARTED), guarda
//        `stripe_checkout_session_id` y alinea `expires_at`/`checkout_expires_at` a la ventana Stripe.
//   La `stripe_checkout_session_id` persistida es el ancla de idempotencia: dos pestañas no
//   generan dos cobros; el webhook además valida contra el snapshot del hold.
//
// INVARIANTES DE SEGURIDAD DUROS (MARKETPLACE.md) que este archivo materializa:
//   1) La cita NO nace aquí. Este handler NO crea patients/appointments/marketplace_payments ni
//      marca el hold `converted`: la cita SOLO la crea el webhook firmado
//      `handle_stripe_checkout_completed`. La URL `success` de Stripe NO confirma nada; la pantalla
//      de resultado hace polling (MARKETPLACE.md §780, marketplace-pago.md §6).
//   2) El `service_role` JAMÁS llega al navegador: `rpcService` vive en lib/supabase-server
//      (`import 'server-only'`), igual que el cliente Stripe (lib/stripe, `import 'server-only'`).
//      El browser hace `POST {slug, hold_id}` y luego `window.location = url`; NUNCA habla con
//      Supabase ni con la Secret Key de Stripe.
//   3) El backend NO confía en el frontend: precio, moneda y success/cancel URLs se resuelven
//      SERVER-SIDE. `amount` es el SNAPSHOT congelado del hold (`slot_holds.amount`), no un precio
//      del cliente (MARKETPLACE.md §780). `professional_id`/`service_id` se re-resuelven desde el
//      `slug` en la RPC; de la cookie tampoco: el estado real (hold vigente, teléfono verificado)
//      se revalida bajo lock.
//   4) La cookie la fija el SERVIDOR (firmada+cifrada, allowlist estricta, lib/session-cookie).
//      `verified_phone` se toma de ahí y se pasa a la RPC para revalidar `patient_phone`; NUNCA
//      del body. Nada de OTP/Stripe/PII cruda en la respuesta.
//   5) Sin datos clínicos ni de pago en la respuesta: al cliente solo van la `url` de Stripe, el
//      vencimiento y los campos públicos del hold. La `stripe_checkout_session_id` NO se devuelve
//      (viaja sola en la success URL que arma Stripe). Los errores se mapean a códigos de dominio.
// =====================================================================================

import { NextResponse } from 'next/server';

import { rpcService, MarketplaceRpcError } from '../../../lib/supabase-server';
import {
  createCheckoutFromHold,
  getStripe,
  StripeGatewayError,
} from '../../../lib/stripe';
import {
  getBookingSession,
  type BookingSession,
} from '../../../lib/session-cookie';

// Checkout depende de disponibilidad viva (el hold vence, el slot puede ocuparse) y usa
// service_role + crypto de la cookie + Stripe ⇒ jamás cachear, y ejecutar en Node.
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

// -------------------------------------------------------------------------------------
// Tipos públicos del hold (espejo del sub-objeto que ya devuelve /api/hold). Sin
// precio/tz-verdad/PII/clínico: solo horario y vencimiento.
// -------------------------------------------------------------------------------------

/** Estado del hold (MARKETPLACE.md § hold_status). En este paso debe seguir `held`. */
type HoldStatus = 'held' | 'expired' | 'converted';

/** Sub-objeto público del hold que SÍ ve el cliente. */
interface HoldPublic {
  id: string;
  starts_at: string; // ISO UTC (autoritativo del backend)
  ends_at: string; // ISO UTC
  starts_at_local: string; // rótulo en la tz del PROFESIONAL (autoritativa)
  ends_at_local: string;
  expires_at: string; // ISO UTC — tras `attach`, alineado a la ventana de Stripe (≥ 30 min)
  status: HoldStatus;
}

// -------------------------------------------------------------------------------------
// Salidas de las fases RPC (server-side). Espejo de `create_marketplace_checkout_from_hold`.
// -------------------------------------------------------------------------------------

/**
 * Fase `prepare`: lock + validación + congelado de `amount`. Devuelve los datos mínimos que el
 * handler necesita para crear la Session en Stripe (todo autoritativo, re-resuelto desde el slug),
 * o —si el hold ya arrancó Checkout— la `stripe_checkout_session_id` existente para recuperarla.
 */
interface CheckoutPrepareResult {
  /** true ⇒ el hold ya tiene Session; recuperar de Stripe en vez de crear otra (idempotencia). */
  has_existing_checkout: boolean;
  /** Session ya adjunta al hold (solo si `has_existing_checkout`). */
  stripe_checkout_session_id: string | null;
  /** Ids re-resueltos desde el slug — NUNCA se confían al cliente. */
  professional_id: string;
  service_id: string;
  /** Ancla del flujo; el webhook revalida que la metadata de la Session coincida (§803). */
  marketplace_session_id: string;
  /** SNAPSHOT congelado del hold (`slot_holds.amount == default_price`), en MXN. */
  amount: number;
  /** Nombre del profesional para el line item (display, no autoritativo). */
  professional_name: string | null;
  /** Campos públicos del hold, para reflejar el contador en la pantalla si hace falta. */
  hold: HoldPublic;
}

/**
 * Fase `attach`: persiste `stripe_checkout_session_id` y alinea `expires_at`/`checkout_expires_at`
 * a la ventana Stripe, bajo `FOR UPDATE`. Si otra pestaña adjuntó primero ⇒ CHECKOUT_ALREADY_STARTED.
 */
interface CheckoutAttachResult {
  hold: HoldPublic;
}

// -------------------------------------------------------------------------------------
// Validación de entrada (barrera de forma; la de negocio la hace la RPC bajo lock).
// -------------------------------------------------------------------------------------

interface CheckoutRequestBody {
  slug: string;
  hold_id: string;
}

/** Error de forma ⇒ se mapea a INVALID_INPUT (422). */
class InputError extends Error {}

/** UUID v4-ish (forma; la RPC valida existencia real). */
const UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

function parseBody(raw: unknown): CheckoutRequestBody {
  if (!raw || typeof raw !== 'object') throw new InputError('Body ausente o no-JSON.');
  const o = raw as Record<string, unknown>;

  const slug = typeof o.slug === 'string' ? o.slug.trim() : '';
  if (!slug || slug.length > 200) throw new InputError('slug inválido.');

  const hold_id = typeof o.hold_id === 'string' ? o.hold_id.trim() : '';
  if (!UUID_RE.test(hold_id)) throw new InputError('hold_id inválido (se espera uuid).');

  return { slug, hold_id };
}

// -------------------------------------------------------------------------------------
// POST /api/checkout
// -------------------------------------------------------------------------------------

export async function POST(req: Request): Promise<NextResponse> {
  // 1) Forma. Cualquier fallo ⇒ INVALID_INPUT (422).
  let body: CheckoutRequestBody;
  try {
    body = parseBody(await req.json().catch(() => null));
  } catch (e) {
    if (e instanceof InputError) return errorJson('INVALID_INPUT', 422, e.message);
    return errorJson('INVALID_INPUT', 422);
  }

  // 2) Cookie del flujo (NO autoritativa, pero es de dónde sale `verified_phone`). Sin cookie
  //    vigente no hay flujo ⇒ BOOKING_SESSION_REQUIRED. Precondiciones baratas antes de tocar DB:
  //    · el hold del body debe ser el `active_hold_id` de la cookie (Invariante 2: no operar un
  //      hold ajeno al flujo) ⇒ BOOKING_SESSION_MISMATCH.
  //    · debe existir `verified_phone` ⇒ si no, el paciente aún no pasó el OTP (PHONE_NOT_VERIFIED).
  //    La RPC revalida TODO a fondo bajo lock (vigencia OTP, patient_phone, whatsapp_links).
  const session: BookingSession | null = await getBookingSession();
  if (!session) return flowError('BOOKING_SESSION_REQUIRED', 'verify_phone');
  if (session.active_hold_id !== body.hold_id) {
    return flowError('BOOKING_SESSION_MISMATCH', 'restart_booking');
  }
  if (!session.verified_phone) return flowError('PHONE_NOT_VERIFIED', 'verify_phone');

  // 3) Fase `prepare` (PRIVILEGIADA). En UNA transacción corta: `FOR UPDATE` del hold; revalida
  //    vigencia y que sea del mismo flujo (`marketplace_session_id`); `patient_phone == verified_phone`;
  //    revalida `whatsapp_links` (ya-paciente ⇒ hold `expired` + MARKETPLACE_BLOCKED_EXISTING_PATIENT);
  //    servicio con `default_price > 0` en MXN; slot aún protegido (sin cita/otro hold). Congela
  //    `slot_holds.amount` y devuelve ids/monto. NO crea cita/paciente/pago, NO llama a Stripe.
  let prep: CheckoutPrepareResult;
  try {
    prep = await rpcService<CheckoutPrepareResult>('create_marketplace_checkout_from_hold', {
      phase: 'prepare',
      slug: body.slug,
      hold_id: body.hold_id,
      // La RPC re-resuelve professional/service/precio desde el slug; el teléfono viene de la
      // cookie firmada (server-side), jamás del body, y se compara contra `patient_phone`.
      verified_phone: session.verified_phone,
      marketplace_session_id: session.marketplace_session_id,
    });
  } catch (e) {
    return mapError(e);
  }

  // Defensa en profundidad: el profesional re-resuelto por la RPC debe coincidir con el de la
  // cookie (no mezclar profesionales dentro de un mismo flujo, MARKETPLACE.md § cookie).
  if (session.professional_id && session.professional_id !== prep.professional_id) {
    return flowError('BOOKING_SESSION_MISMATCH', 'restart_booking');
  }

  // 4) Idempotencia por hold: si ya había una Session, recuperarla de Stripe en vez de crear otra
  //    (doble pestaña / reintento). `open` ⇒ continuar en su URL; `complete` ⇒ ya se pagó, ir a
  //    resultado (polling); `expired` ⇒ CHECKOUT_EXPIRED (MARKETPLACE.md §768-770).
  if (prep.has_existing_checkout && prep.stripe_checkout_session_id) {
    return recoverExistingCheckout(prep.stripe_checkout_session_id, prep.hold);
  }

  // 5) Crear la Stripe Checkout Session. Precio/moneda/URLs 100% server-side; `amount` es el
  //    snapshot congelado del hold. IdempotencyKey `marketplace_checkout:{hold_id}` (dentro del
  //    helper) evita Sessions duplicadas ante reintentos de red.
  let checkout: { stripeCheckoutSessionId: string; url: string; expiresAt: string };
  try {
    checkout = await createCheckoutFromHold({
      holdId: body.hold_id,
      slug: body.slug,
      professionalId: prep.professional_id,
      serviceId: prep.service_id,
      marketplaceSessionId: prep.marketplace_session_id,
      amount: prep.amount, // SNAPSHOT del hold (MARKETPLACE.md §766), no del cliente
      professionalName: prep.professional_name ?? undefined,
    });
  } catch (e) {
    return mapError(e);
  }

  // 6) Fase `attach` (PRIVILEGIADA): re-`FOR UPDATE`, persiste `stripe_checkout_session_id` y
  //    alinea `expires_at`/`checkout_expires_at` a la ventana Stripe. Si entre `prepare` y aquí
  //    otra pestaña adjuntó una Session distinta ⇒ CHECKOUT_ALREADY_STARTED: recuperamos la que
  //    ganó la carrera (no cobramos dos veces). La Session que acabamos de crear queda huérfana
  //    y Stripe la expira por TTL.
  let attach: CheckoutAttachResult;
  try {
    attach = await rpcService<CheckoutAttachResult>('create_marketplace_checkout_from_hold', {
      phase: 'attach',
      hold_id: body.hold_id,
      marketplace_session_id: session.marketplace_session_id,
      stripe_checkout_session_id: checkout.stripeCheckoutSessionId,
      checkout_expires_at: checkout.expiresAt, // alinea expires_at del hold a la ventana Stripe
    });
  } catch (e) {
    if (e instanceof MarketplaceRpcError && e.code === 'CHECKOUT_ALREADY_STARTED') {
      // Carrera: ganó otra pestaña. Recuperar la Session que quedó adjunta al hold.
      const winning = await safeExistingSessionId(body.hold_id, session.marketplace_session_id);
      if (winning) return recoverExistingCheckout(winning, prep.hold);
      // No se pudo resolver la ganadora ⇒ que el cliente continúe el checkout existente.
      return flowError('CHECKOUT_ALREADY_STARTED', 'continue_checkout');
    }
    return mapError(e);
  }

  // 7) Respuesta: SOLO la URL de Stripe + vencimiento + hold público. El cliente hace
  //    `window.location = checkout.url`. NO devolvemos `stripe_checkout_session_id` (viaja solo en
  //    la success URL que arma Stripe). Al volver, la pantalla de resultado hace POLLING; el
  //    `success` de Stripe NO confirma la cita (MARKETPLACE.md §780, marketplace-pago.md §6).
  return NextResponse.json(
    {
      checkout: { url: checkout.url, expires_at: checkout.expiresAt },
      hold: attach.hold,
      next_action: 'redirect_to_stripe' as const,
    },
    { status: 200, headers: { 'cache-control': 'no-store' } },
  );
}

// -------------------------------------------------------------------------------------
// Recuperación de un Checkout existente (idempotencia por hold / carrera de doble pestaña).
// -------------------------------------------------------------------------------------

/**
 * Consulta el estado de una Session ya adjunta al hold y decide la siguiente acción SIN crear
 * otra Session ni cobrar de nuevo (MARKETPLACE.md §768-770). No muta dominio: solo lee de Stripe.
 */
async function recoverExistingCheckout(
  stripeCheckoutSessionId: string,
  hold: HoldPublic,
): Promise<NextResponse> {
  let s: { status: string | null; url: string | null; expires_at: number | null };
  try {
    const retrieved = await getStripe().checkout.sessions.retrieve(stripeCheckoutSessionId);
    s = { status: retrieved.status ?? null, url: retrieved.url ?? null, expires_at: retrieved.expires_at ?? null };
  } catch (err) {
    // No poder consultar Stripe no debe filtrar internos; es un fallo del riel de pago.
    return mapError(new StripeGatewayError('STRIPE_CHECKOUT_FAILED', 'No se pudo recuperar la Session.', err));
  }

  // `complete` ⇒ el pago ya ocurrió (el webhook confirma la cita); el cliente va a resultado a
  // hacer polling, no reintenta pago.
  if (s.status === 'complete') {
    return NextResponse.json(
      { next_action: 'poll_result' as const, hold },
      { status: 200, headers: { 'cache-control': 'no-store' } },
    );
  }
  // `expired` ⇒ la ventana de Stripe venció sin pago ⇒ reiniciar reserva.
  if (s.status === 'expired' || !s.url) {
    return flowError('CHECKOUT_EXPIRED', 'restart_booking');
  }
  // `open` ⇒ continuar el pago en la MISMA URL (continue_checkout).
  const expiresAt = s.expires_at ? new Date(s.expires_at * 1000).toISOString() : hold.expires_at;
  return NextResponse.json(
    {
      checkout: { url: s.url, expires_at: expiresAt },
      hold,
      next_action: 'continue_checkout' as const,
    },
    { status: 200, headers: { 'cache-control': 'no-store' } },
  );
}

/**
 * Lee (best-effort) la `stripe_checkout_session_id` que quedó adjunta al hold tras perder una
 * carrera de `attach`. Reusa la fase `prepare` en modo idempotente: si el hold ya tiene Session,
 * la devuelve. Cualquier fallo ⇒ null (el caller cae a `continue_checkout` genérico).
 */
async function safeExistingSessionId(
  holdId: string,
  marketplaceSessionId: string,
): Promise<string | null> {
  try {
    const again = await rpcService<CheckoutPrepareResult>('create_marketplace_checkout_from_hold', {
      phase: 'prepare',
      hold_id: holdId,
      marketplace_session_id: marketplaceSessionId,
    });
    return again.has_existing_checkout ? again.stripe_checkout_session_id : null;
  } catch {
    return null;
  }
}

// -------------------------------------------------------------------------------------
// Mapeo de errores de dominio → HTTP, sin filtrar internos de Postgres/Stripe.
// Códigos: MARKETPLACE.md § create_marketplace_checkout_from_hold (§774-777).
// -------------------------------------------------------------------------------------

function mapError(e: unknown): NextResponse {
  if (e instanceof MarketplaceRpcError) {
    switch (e.code) {
      case 'INVALID_INPUT':
        return errorJson(e.code, 422);
      case 'MARKETPLACE_PROFILE_NOT_FOUND':
      case 'MARKETPLACE_SERVICE_UNAVAILABLE':
      case 'HOLD_NOT_FOUND':
        return errorJson(e.code, 404);
      case 'PHONE_NOT_VERIFIED':
        return flowError(e.code, 'verify_phone');
      case 'HOLD_EXPIRED':
      case 'CHECKOUT_EXPIRED':
        // El horario se liberó / la ventana de pago venció ⇒ reiniciar la reserva.
        return flowError(e.code, 'restart_booking');
      case 'CHECKOUT_ALREADY_STARTED':
        // Ya hay Checkout en curso: el cliente continúa el pago existente (no se re-cobra).
        return flowError(e.code, 'continue_checkout');
      case 'MARKETPLACE_BLOCKED_EXISTING_PATIENT':
        // El teléfono ya es paciente de ESTE profesional (whatsapp_links): la 1ª sesión de
        // marketplace no aplica; el hold pasó a `expired`. Continúa por WhatsApp (chatbot).
        // Token de flujo canónico del módulo: `continue_whatsapp` (MARKETPLACE.md §728/§733;
        // mismo que /api/otp/verify y el router en agendar/page.tsx), no `whatsapp`.
        return flowError(e.code, 'continue_whatsapp');
      case 'SLOT_UNAVAILABLE':
        return errorJson(e.code, 409);
      case 'BOOKING_SESSION_REQUIRED':
      case 'BOOKING_SESSION_EXPIRED':
      case 'BOOKING_SESSION_MISMATCH':
        return errorJson(e.code, 409);
      default:
        return errorJson('CHECKOUT_FAILED', 500);
    }
  }
  if (e instanceof StripeGatewayError) {
    // Falla del riel Stripe (crear/recuperar Session). 502: dependencia externa; 500 si es
    // configuración ausente. Nunca se filtra el detalle interno de Stripe.
    if (e.code === 'STRIPE_CONFIG_MISSING') return errorJson('CHECKOUT_FAILED', 500);
    return errorJson('STRIPE_CHECKOUT_FAILED', 502);
  }
  // No es error de dominio (red/infra) ⇒ 500 opaco.
  return errorJson('CHECKOUT_FAILED', 500);
}

// -------------------------------------------------------------------------------------
// Helpers de respuesta (siempre no-cacheable).
// -------------------------------------------------------------------------------------

/** Error de flujo con pista de siguiente pantalla para el cliente (no muta nada). */
function flowError(code: string, next_action: string): NextResponse {
  return NextResponse.json(
    { error: code, next_action },
    { status: 409, headers: { 'cache-control': 'no-store' } },
  );
}

/** JSON de error homogéneo. `detail` solo para forma (INVALID_INPUT). */
function errorJson(code: string, status: number, detail?: string): NextResponse {
  return NextResponse.json(
    detail ? { error: code, detail } : { error: code },
    { status, headers: { 'cache-control': 'no-store' } },
  );
}
