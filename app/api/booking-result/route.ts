// =====================================================================================
// app/api/booking-result/route.ts
// Marketplace — Route Handler GET /api/booking-result. Materializa la función de contrato
// `get_marketplace_booking_result`: consulta el estado del booking tras volver de Stripe,
// SIN crear cita ni mutar dominio (es la fuente del polling de la pantalla de resultado).
// Next.js App Router · SERVER-ONLY (nunca corre en el navegador).
//
// Contrato: paginas/marketplace-resultado.md (estados/jerarquía/"No debe") + MARKETPLACE.md:
//   · Ruta canónica del contrato: `GET /psicologos/:slug/agendar/resultado`. Este handler es
//     el endpoint del arnés (`/api/booking-result`) que lo materializa; `slug`/`session_id`/
//     `result` viajan en la query (el navegador los tiene del retorno de Stripe). Ambos
//     apuntan al MISMO query lógico (MARKETPLACE.md § get_marketplace_booking_result, ~L860).
//   · Entrada { slug, stripe_checkout_session_id?, hold_id?, result_hint? } + cookie firmada.
//     El hold se localiza por `cookie.active_hold_id`; `session_id`/`result` son solo PISTAS
//     que el RPC cruza (NO son verdad). El estado real SALE DE DB (~L874-881).
//   · Salida { status, next_action, poll_after_seconds?, appointment?, professional, service,
//     payment?, checkout_url?, support_reference? } (~L883). Read-only: NO escribe (~L872).
//   · Errores INVALID_INPUT, BOOKING_SESSION_REQUIRED, BOOKING_SESSION_MISMATCH,
//     MARKETPLACE_PROFILE_NOT_FOUND, HOLD_NOT_FOUND, CHECKOUT_SESSION_NOT_FOUND,
//     STRIPE_SESSION_MISMATCH, STRIPE_LOOKUP_FAILED (~L886).
//
// FRONTERA Node/Postgres — por qué puede haber DOS pasos:
//   El contrato describe el query como UNA operación que "Lee ... y, SOLO si la DB aún no
//   tiene resultado final, la Stripe Session (read-only)" (~L871). Pero una función de
//   Postgres NO puede hablar HTTP con Stripe. Por eso el RPC resuelve TODO lo que se decide
//   con DB (marketplace_payments ⇒ confirmed; webhook_events needs_support ⇒ requires_support;
//   slot_holds converted/expired ⇒ requires_support/checkout_expired) y, para el único caso
//   que exige mirar Stripe (`held` con Checkout y DB aún sin veredicto, ~L877-880), devuelve
//   un centinela `resolve_via_stripe` con la `stripe_checkout_session_id`. Entonces ESTE
//   handler hace la lectura read-only de Stripe y deriva el estado. Es el mismo patrón
//   Node-orquesta-Stripe de /api/checkout, respetando "jamás HTTP bajo el lock" (§807).
//
// INVARIANTES DE SEGURIDAD DUROS (MARKETPLACE.md) que este archivo materializa:
//   1) La URL `success` de Stripe NO confirma la cita: SOLO el webhook firmado
//      (`handle_stripe_checkout_completed`) la crea. Aquí NUNCA se declara "reservado" por
//      haber vuelto con `success`; `complete/paid` en Stripe se traduce a `payment_processing`
//      (que sigue haciendo polling), no a `confirmed` (marketplace-resultado.md §"No debe").
//      Este endpoint es de SOLO LECTURA: no crea/duplica cita ni reintenta el cobro.
//   2) El `service_role` JAMÁS llega al navegador. Este es un query público (cookie): usa la
//      ANON key vía `rpcPublic` (el RPC es SECURITY DEFINER y lee `slot_holds`/webhook_events
//      por dentro). El browser habla con este Route Handler propio, nunca con Supabase ni con
//      la Secret Key de Stripe (la lectura de Stripe la hace `lib/stripe`, server-only).
//   3) El backend NO confía en el frontend. El hold se localiza por la COOKIE firmada
//      (`active_hold_id` + `marketplace_session_id`), no por el `session_id` de la query, que
//      solo es una pista cruzada por el RPC (STRIPE_SESSION_MISMATCH si no corresponde). El
//      estado real se re-resuelve en DB (marketplace_session_id/hold), nunca de la cookie.
//   4) Sin datos clínicos ni de pago sensibles en la respuesta: se devuelve una allowlist
//      estricta con los campos públicos del contrato. NUNCA se filtran ids internos
//      (professional_id, marketplace_session_id, hold_id, stripe_checkout_session_id) ni
//      PaymentIntent/tarjeta; el `appointment`/`payment` solo viajan en `confirmed`, y el
//      `support_reference` solo en `requires_support`. Los errores se mapean a códigos de
//      dominio sin exponer internos de Postgres/Stripe.
// =====================================================================================

import { NextResponse } from 'next/server';

import { rpcPublic, MarketplaceRpcError } from '../../../lib/supabase-server';
import { getStripe, StripeGatewayError } from '../../../lib/stripe';
import { getBookingSession, type BookingSession } from '../../../lib/session-cookie';

// El resultado depende de estado vivo (webhook en curso, hold que vence, Stripe) ⇒ jamás
// cachear. Node runtime: crypto de la cookie + SDK de Stripe.
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

// -------------------------------------------------------------------------------------
// Tipos — espejo EXACTO de la salida pública de `get_marketplace_booking_result`
// (MARKETPLACE.md ~L883). Ni un campo autoritativo/clínico de más.
// -------------------------------------------------------------------------------------

/** Estados del resultado (MARKETPLACE.md § Máquina de estados del booking, ~L285). */
export type BookingResultStatus =
  | 'payment_processing' // Stripe pagó, webhook aún no termina ⇒ POLLING (NO reintentar pago)
  | 'confirmed' // cita + pago existen en DB ⇒ fin feliz
  | 'checkout_open' // Checkout creado, sin pagar ⇒ volver a Stripe
  | 'checkout_cancelled' // volvió sin pagar (no terminal) ⇒ reintentar si el hold sigue vivo
  | 'checkout_expired' // sesión de Stripe/hold venció sin pago ⇒ reiniciar reserva
  | 'requires_support'; // pago recibido pero no resoluble ⇒ soporte con support_reference

/** Detalle mínimo de la cita — SOLO se envía cuando `confirmed`. */
export interface AppointmentSummary {
  starts_at: string; // ISO UTC
  ends_at: string; // ISO UTC
  timezone: string; // IANA (tz del profesional) para rotular sin recalcular
}

/** Identidad pública del profesional (subconjunto del RPC). */
export interface ProfessionalSummary {
  slug: string;
  display_name: string;
  photo_url: string | null;
}

/** Servicio (siempre online). Precio/duración vienen del RPC, nunca del cliente. */
export interface ServiceSummary {
  display_name: string; // "Primera sesión"
  duration_minutes: number;
  modality: 'online';
}

/** Recibo mínimo: monto ya cobrado. Sin tarjeta ni PaymentIntent (dato sensible fuera). */
export interface PaymentSummary {
  amount_mxn: number;
}

/** Salida pública allowlisted que ve el cliente (MARKETPLACE.md ~L883). */
export interface BookingResultPublic {
  status: BookingResultStatus;
  next_action: string; // done | poll_result | continue_checkout | retry_checkout | restart_booking | contact_support
  poll_after_seconds?: number; // presente/útil solo en payment_processing
  appointment?: AppointmentSummary; // solo en confirmed
  professional: ProfessionalSummary;
  service: ServiceSummary;
  payment?: PaymentSummary; // solo en confirmed
  checkout_url?: string; // reanudar/reintentar Stripe (checkout_open/cancelled con hold vivo)
  support_reference?: string; // solo en requires_support
}

/**
 * Salida CRUDA del RPC (server-side). Además del shape público, puede traer el centinela
 * `resolve_via_stripe` cuando el hold está `held` con Checkout y la DB aún no tiene veredicto:
 * en ese caso el `status` NO es terminal y ESTE handler completa el estado leyendo Stripe.
 */
interface BookingResultRpc extends Omit<BookingResultPublic, 'status'> {
  status: BookingResultStatus | 'stripe_lookup_required';
  /** Solo presente con `status === 'stripe_lookup_required'`: qué Session consultar en Stripe. */
  resolve_via_stripe?: {
    stripe_checkout_session_id: string;
  };
}

// -------------------------------------------------------------------------------------
// Cadencia de polling: pisos/topes de seguridad. `poll_after_seconds` del backend manda.
// -------------------------------------------------------------------------------------

const DEFAULT_POLL_SECONDS = 3; // si el backend no sugiere cadencia para payment_processing
const MIN_POLL_SECONDS = 2; // piso: nunca por debajo (evita loop agresivo del cliente)

// -------------------------------------------------------------------------------------
// Validación de entrada (barrera de forma; la de negocio/pertenencia la hace el RPC).
// -------------------------------------------------------------------------------------

interface BookingResultQuery {
  slug: string;
  /** Pista: `stripe_checkout_session_id` de la success URL de Stripe (NO es verdad). */
  stripe_checkout_session_id: string | null;
  /** Pista: `success` | `cancel` de la success/cancel URL de Stripe (NO es verdad). */
  result_hint: 'success' | 'cancel' | null;
}

/** Error de forma ⇒ se mapea a INVALID_INPUT (422). */
class InputError extends Error {}

/**
 * Lee y valida los query params. Acepta los nombres que envía la pantalla
 * (`session_id`/`result`) y sus alias del contrato/Stripe (`checkout_session_id`/
 * `stripe_checkout_session_id`/`result_hint`), por robustez ante ambos orígenes.
 */
function parseQuery(url: URL): BookingResultQuery {
  const q = url.searchParams;

  const slug = (q.get('slug') ?? '').trim();
  if (!slug || slug.length > 200) throw new InputError('slug inválido.');

  // Session id de Stripe: prefijo `cs_...`; se acepta como pista, el RPC la cruza contra el hold.
  const rawSession =
    q.get('session_id') ??
    q.get('checkout_session_id') ??
    q.get('stripe_checkout_session_id') ??
    '';
  const sid = rawSession.trim();
  // Tope defensivo de longitud; forma laxa (Stripe controla el formato real).
  const stripe_checkout_session_id = sid && sid.length <= 200 ? sid : null;

  const rawHint = (q.get('result') ?? q.get('result_hint') ?? '').trim().toLowerCase();
  const result_hint =
    rawHint === 'success' || rawHint === 'cancel' ? (rawHint as 'success' | 'cancel') : null;

  return { slug, stripe_checkout_session_id, result_hint };
}

// -------------------------------------------------------------------------------------
// GET /api/booking-result
// -------------------------------------------------------------------------------------

export async function GET(req: Request): Promise<NextResponse> {
  // 1) Forma de la query. Cualquier fallo ⇒ INVALID_INPUT (422).
  let query: BookingResultQuery;
  try {
    query = parseQuery(new URL(req.url));
  } catch (e) {
    if (e instanceof InputError) return errorJson('INVALID_INPUT', 422, e.message);
    return errorJson('INVALID_INPUT', 422);
  }

  // 2) Cookie del flujo: es el LOCALIZADOR de confianza del hold (no autoritativa para el
  //    estado, pero sí para "qué hold es este flujo"). Sin cookie no se puede consultar de
  //    forma segura un resultado ⇒ BOOKING_SESSION_REQUIRED. El session_id de la query, al ser
  //    manipulable, jamás sustituye a la cookie: solo se pasa como pista que el RPC cruza.
  const session: BookingSession | null = await getBookingSession();
  if (!session) return errorJson('BOOKING_SESSION_REQUIRED', 409);
  if (!session.active_hold_id) {
    // Cookie viva pero sin hold ⇒ este flujo nunca llegó a apartar slot: nada que consultar.
    return errorJson('HOLD_NOT_FOUND', 404);
  }

  // 3) Query PÚBLICO (ANON key, SECURITY DEFINER). Read-only: NO escribe (contrato ~L872). El
  //    RPC localiza el hold por `active_hold_id`; valida que cookie/hold/profesional/slug
  //    correspondan; y resuelve el estado desde DB (marketplace_payments ⇒ confirmed;
  //    webhook_events needs_support ⇒ requires_support; slot_holds converted/expired ⇒ ...).
  //    Si el hold está `held` con Checkout y la DB aún no concluyó, devuelve el centinela
  //    `stripe_lookup_required` para que el estado se derive leyendo Stripe (paso 5).
  let raw: BookingResultRpc;
  try {
    raw = await rpcPublic<BookingResultRpc>('get_marketplace_booking_result', {
      // Los nombres ligan con la firma SQL del contrato (§Entrada, ~L865).
      slug: query.slug,
      // Ancla de confianza: el hold y la sesión salen de la COOKIE firmada, no de la query.
      hold_id: session.active_hold_id,
      marketplace_session_id: session.marketplace_session_id,
      // Pistas del retorno de Stripe (el RPC las cruza; no las trata como verdad).
      stripe_checkout_session_id: query.stripe_checkout_session_id,
      result_hint: query.result_hint,
    });
  } catch (e) {
    return mapError(e);
  }

  // Defensa en profundidad: el profesional que devuelve el RPC (via slug) debe coincidir con el
  // de la cookie — no consultar el resultado de un hold ajeno al flujo (§ cookie, no-mezcla).
  if (session.professional_id && raw.professional?.slug && raw.professional.slug !== query.slug) {
    return errorJson('BOOKING_SESSION_MISMATCH', 409);
  }

  // 4) Si el RPC ya dio un estado (terminal o payment_processing resuelto por webhook_events),
  //    se devuelve tal cual, allowlisted.
  if (raw.status !== 'stripe_lookup_required') {
    return ok(toPublic({ ...raw, status: raw.status }));
  }

  // 5) Único caso que exige mirar Stripe (read-only): hold `held` con Checkout, DB sin veredicto
  //    (MARKETPLACE.md ~L877-880). Se deriva el estado de la Session, SIN crear/mutar nada y SIN
  //    tratar `complete` como cita confirmada (eso es del webhook).
  const csid = raw.resolve_via_stripe?.stripe_checkout_session_id;
  if (!csid) {
    // El RPC pidió lookup pero no dio la Session ⇒ no hay Checkout que consultar.
    return errorJson('CHECKOUT_SESSION_NOT_FOUND', 404);
  }
  return resolveViaStripe(csid, query.result_hint, raw);
}

// -------------------------------------------------------------------------------------
// Derivación del estado leyendo la Stripe Session (read-only). NO confirma la cita: el
// webhook es el único que la crea. Mapeo del contrato (MARKETPLACE.md ~L877-880):
//   complete/paid ⇒ payment_processing · open+cancel ⇒ checkout_cancelled · open ⇒
//   checkout_open · expired ⇒ checkout_expired.
// -------------------------------------------------------------------------------------

async function resolveViaStripe(
  stripeCheckoutSessionId: string,
  resultHint: 'success' | 'cancel' | null,
  base: BookingResultRpc,
): Promise<NextResponse> {
  let s: { status: string | null; paymentStatus: string | null; url: string | null };
  try {
    const retrieved = await getStripe().checkout.sessions.retrieve(stripeCheckoutSessionId);
    s = {
      status: retrieved.status ?? null,
      paymentStatus: retrieved.payment_status ?? null,
      url: retrieved.url ?? null,
    };
  } catch (err) {
    // No poder consultar Stripe es un fallo recuperable del riel (la pantalla reintenta el
    // polling). No se filtra el detalle interno de Stripe.
    return mapError(
      err instanceof StripeGatewayError
        ? err
        : new StripeGatewayError('STRIPE_LOOKUP_FAILED', 'No se pudo consultar la Session.', err),
    );
  }

  // `complete` + `paid` ⇒ el pago ocurrió, pero la cita la crea el WEBHOOK: seguimos en
  // payment_processing (polling), NUNCA confirmed desde aquí (marketplace-resultado.md §"No debe").
  if (s.status === 'complete' && s.paymentStatus === 'paid') {
    return ok(
      toPublic({
        ...base,
        status: 'payment_processing',
        next_action: 'poll_result',
        poll_after_seconds: base.poll_after_seconds,
        // Sin checkout_url/appointment/payment: aún no hay cita ni reanudación de pago.
        checkout_url: undefined,
      }),
    );
  }

  // `expired` (o sin URL para reanudar) ⇒ la ventana de Stripe/hold venció sin pago ⇒ reiniciar.
  if (s.status === 'expired' || (!s.url && s.status !== 'complete')) {
    return ok(toPublic({ ...base, status: 'checkout_expired', next_action: 'restart_booking' }));
  }

  // `open` ⇒ Checkout creado sin pagar. Si el paciente volvió por `cancel` ⇒ checkout_cancelled;
  // si no ⇒ checkout_open. En ambos, `checkout_url` = url viva de Stripe para retomar el pago.
  const cancelled = resultHint === 'cancel';
  return ok(
    toPublic({
      ...base,
      status: cancelled ? 'checkout_cancelled' : 'checkout_open',
      next_action: cancelled ? 'retry_checkout' : 'continue_checkout',
      checkout_url: s.url ?? undefined,
    }),
  );
}

// -------------------------------------------------------------------------------------
// Allowlist de salida: construye SOLO los campos públicos del contrato y descarta cualquier
// otro (ids internos, centinelas, PII). La visibilidad condicional (marketplace-resultado.md
// §Visibilidad) se materializa aquí: appointment/payment solo en confirmed; support_reference
// solo en requires_support; poll_after_seconds solo en payment_processing.
// -------------------------------------------------------------------------------------

function toPublic(r: Omit<BookingResultRpc, 'status' | 'resolve_via_stripe'> & {
  status: BookingResultStatus;
}): BookingResultPublic {
  const out: BookingResultPublic = {
    status: r.status,
    next_action: r.next_action ?? defaultNextAction(r.status),
    professional: {
      slug: r.professional.slug,
      display_name: r.professional.display_name,
      photo_url: r.professional.photo_url ?? null,
    },
    service: {
      display_name: r.service.display_name,
      duration_minutes: r.service.duration_minutes,
      modality: 'online',
    },
  };

  // payment_processing: cadencia de polling (piso de seguridad; el backend puede subirla).
  if (r.status === 'payment_processing') {
    out.poll_after_seconds = Math.max(MIN_POLL_SECONDS, r.poll_after_seconds ?? DEFAULT_POLL_SECONDS);
  }

  // confirmed: SOLO aquí viajan detalle de cita y recibo (visibilidad condicional del contrato).
  if (r.status === 'confirmed') {
    if (r.appointment) {
      out.appointment = {
        starts_at: r.appointment.starts_at,
        ends_at: r.appointment.ends_at,
        timezone: r.appointment.timezone,
      };
    }
    if (r.payment) out.payment = { amount_mxn: r.payment.amount_mxn };
  }

  // checkout_open/cancelled: URL viva para retomar el pago (si el hold sigue vivo).
  if ((r.status === 'checkout_open' || r.status === 'checkout_cancelled') && r.checkout_url) {
    out.checkout_url = r.checkout_url;
  }

  // requires_support: SOLO aquí la referencia de soporte (NUNCA se oculta; §"No debe").
  if (r.status === 'requires_support' && r.support_reference) {
    out.support_reference = r.support_reference;
  }

  return out;
}

/** next_action por defecto según estado, si el RPC no lo especificó. */
function defaultNextAction(status: BookingResultStatus): string {
  switch (status) {
    case 'confirmed':
      return 'done';
    case 'payment_processing':
      return 'poll_result';
    case 'checkout_open':
      return 'continue_checkout';
    case 'checkout_cancelled':
      return 'retry_checkout';
    case 'checkout_expired':
      return 'restart_booking';
    case 'requires_support':
      return 'contact_support';
  }
}

// -------------------------------------------------------------------------------------
// Mapeo de errores de dominio → HTTP, sin filtrar internos de Postgres/Stripe.
// Códigos: MARKETPLACE.md § get_marketplace_booking_result (~L886).
// -------------------------------------------------------------------------------------

function mapError(e: unknown): NextResponse {
  if (e instanceof MarketplaceRpcError) {
    switch (e.code) {
      case 'INVALID_INPUT':
        return errorJson(e.code, 422);
      case 'MARKETPLACE_PROFILE_NOT_FOUND':
      case 'HOLD_NOT_FOUND':
      case 'CHECKOUT_SESSION_NOT_FOUND':
        return errorJson(e.code, 404);
      case 'STRIPE_SESSION_MISMATCH':
      case 'BOOKING_SESSION_MISMATCH':
      case 'BOOKING_SESSION_REQUIRED':
      case 'BOOKING_SESSION_EXPIRED':
        return errorJson(e.code, 409);
      default:
        // Código desconocido ⇒ 500 opaco (no se expone el mensaje interno de Postgres).
        return errorJson('BOOKING_RESULT_FAILED', 500);
    }
  }
  if (e instanceof StripeGatewayError) {
    // Falla del riel Stripe al derivar el estado. La pantalla trata cualquier error como
    // fallo de consulta recuperable y sigue el polling; no se filtra el detalle de Stripe.
    if (e.code === 'STRIPE_CONFIG_MISSING') return errorJson('BOOKING_RESULT_FAILED', 500);
    return errorJson('STRIPE_LOOKUP_FAILED', 502);
  }
  // No es error de dominio (red/infra) ⇒ 500 opaco.
  return errorJson('BOOKING_RESULT_FAILED', 500);
}

// -------------------------------------------------------------------------------------
// Helpers de respuesta (siempre no-cacheable: estado en vivo).
// -------------------------------------------------------------------------------------

/** 200 con el resultado público (allowlisted). Nunca cacheable. */
function ok(body: BookingResultPublic): NextResponse {
  return NextResponse.json(body, { status: 200, headers: { 'cache-control': 'no-store' } });
}

/** JSON de error homogéneo, siempre no-cacheable. `detail` solo para forma (INVALID_INPUT). */
function errorJson(code: string, status: number, detail?: string): NextResponse {
  return NextResponse.json(
    detail ? { error: code, detail } : { error: code },
    { status, headers: { 'cache-control': 'no-store' } },
  );
}
