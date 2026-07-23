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
// UNA SOLA RPC (alineado a create_marketplace_checkout_from_hold.sql):
//   La función es UNA operación indivisible con la firma
//     create_marketplace_checkout_from_hold(p_slug, p_hold_id, p_marketplace_session_id,
//                                            p_verified_phone) RETURNS jsonb.
//   Bajo el `FOR UPDATE` del hold hace todo: lock → revalidar cookie/teléfono contra
//   `patient_phone` → revalidar `whatsapp_links` (→ MARKETPLACE_BLOCKED_EXISTING_PATIENT) →
//   revalidar que el slot siga protegido (→ SLOT_UNAVAILABLE) → **congelar `slot_holds.amount`**
//   (INC-6) → crear la Stripe Checkout Session (modelada por los helpers server-side
//   `_mp_stripe_create_checkout_session` / `_mp_stripe_retrieve_checkout_session`, orquestados
//   por el edge en el despliegue real) → persistir `stripe_checkout_session_id` → alinear
//   `expires_at`/`checkout_expires_at` a la ventana Stripe → devolver la URL. Este handler NO
//   orquesta Stripe ni encadena fases: llama a la RPC una vez y traduce su `jsonb` a HTTP.
//   La idempotencia es por clave natural del hold (uq_slot_holds_checkout): si el hold ya tenía
//   Session, la RPC la recupera de Stripe y responde `continue_checkout` (open) / `view_result`
//   (complete) / CHECKOUT_EXPIRED (expired) — sin crear ni cobrar dos veces.
//
// INVARIANTES DE SEGURIDAD DUROS (MARKETPLACE.md) que este archivo materializa:
//   1) La cita NO nace aquí. Este handler NO crea patients/appointments/marketplace_payments ni
//      marca el hold `converted`: la cita SOLO la crea el webhook firmado
//      `handle_stripe_checkout_completed`. La URL `success` de Stripe NO confirma nada; la pantalla
//      de resultado hace polling (MARKETPLACE.md §780, marketplace-pago.md §6).
//   2) El `service_role` JAMÁS llega al navegador: `rpcService` vive en lib/supabase-server
//      (`import 'server-only'`). El browser hace `POST {slug, hold_id}` y luego
//      `window.location = url`; NUNCA habla con Supabase ni con la Secret Key de Stripe.
//   3) El backend NO confía en el frontend: precio, moneda y success/cancel URLs se resuelven
//      SERVER-SIDE dentro de la RPC. `amount` es el SNAPSHOT congelado del hold
//      (`slot_holds.amount`), no un precio del cliente (MARKETPLACE.md §780).
//      `professional_id`/`service_id` se re-resuelven desde el `slug`; de la cookie tampoco: el
//      estado real (hold vigente, teléfono verificado) se revalida bajo lock.
//   4) La cookie la fija el SERVIDOR (firmada+cifrada, allowlist estricta, lib/session-cookie).
//      `verified_phone` y `marketplace_session_id` se toman de ahí y se pasan a la RPC como
//      `p_verified_phone` / `p_marketplace_session_id`; NUNCA del body.
//   5) Sin datos clínicos ni de pago en la respuesta: al cliente solo van la `url` de Stripe, el
//      vencimiento y los campos públicos del hold. La `stripe_checkout_session_id` NO se devuelve
//      (viaja sola en la success URL que arma Stripe). Los errores se mapean a códigos de dominio.
// =====================================================================================

import { NextResponse } from 'next/server';

import { rpcService, MarketplaceRpcError } from '../../../lib/supabase-server';
import {
  getBookingSession,
  type BookingSession,
} from '../../../lib/session-cookie';

// Checkout depende de disponibilidad viva (el hold vence, el slot puede ocuparse) y usa
// service_role + crypto de la cookie ⇒ jamás cachear, y ejecutar en Node.
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

// -------------------------------------------------------------------------------------
// Tipos públicos del hold (espejo del sub-objeto `hold` que devuelve la RPC). Sin
// precio-del-cliente/tz-verdad/PII/clínico: solo estado, horario y vencimiento.
// -------------------------------------------------------------------------------------

/** Estado del hold (MARKETPLACE.md § hold_status). En este paso debe seguir `held`. */
type HoldStatus = 'held' | 'expired' | 'converted';

/**
 * Sub-objeto público del hold que devuelve la RPC. En la rama `view_result` (pago ya
 * completado) la RPC solo emite `{ id, status }`; por eso el resto es opcional.
 */
interface HoldPublic {
  id: string;
  status: HoldStatus;
  starts_at?: string; // ISO UTC (autoritativo del backend)
  ends_at?: string; // ISO UTC
  expires_at?: string; // ISO UTC — alineado a la ventana de Stripe (≥ 30 min)
  amount?: number; // SNAPSHOT congelado del hold (MXN), solo en la creación
}

// -------------------------------------------------------------------------------------
// Salida de `create_marketplace_checkout_from_hold` (jsonb). Unión de sus ramas:
//   · creación         → { checkout{url,...}, hold, next_action:'redirect_to_checkout' }
//   · recuperación open → { checkout{url,...}, hold, next_action:'continue_checkout', idempotent }
//   · pago completado   → { checkout{status:'complete'}, hold{id,status}, next_action:'view_result' }
//   · ya-paciente       → { marketplace_allowed:false, reason, next_action:'continue_whatsapp' }
// (los estados terminales — HOLD_EXPIRED, CHECKOUT_EXPIRED, SLOT_UNAVAILABLE,
//  CHECKOUT_ALREADY_STARTED, STRIPE_CHECKOUT_FAILED — llegan como RAISE ⇒ MarketplaceRpcError.)
// -------------------------------------------------------------------------------------

interface CheckoutResult {
  /** Rama "ya es paciente de este profesional": se devuelve como fila, no como excepción. */
  marketplace_allowed?: false;
  reason?: string;
  /** Datos de la Session (creada o recuperada). `url` ausente cuando el pago ya se completó. */
  checkout?: {
    stripe_checkout_session_id?: string; // NUNCA se reenvía al cliente (Invariante 5)
    url?: string;
    expires_at?: string;
    status?: string; // 'complete' ⇒ ya pagado
  };
  hold?: HoldPublic;
  next_action:
    | 'redirect_to_checkout'
    | 'continue_checkout'
    | 'view_result'
    | 'continue_whatsapp';
  idempotent?: boolean;
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

  // 2) Cookie del flujo (NO autoritativa, pero es de dónde salen `verified_phone` y
  //    `marketplace_session_id`). Sin cookie vigente no hay flujo ⇒ BOOKING_SESSION_REQUIRED.
  //    Precondiciones baratas antes de tocar DB:
  //    · el hold del body debe ser el `active_hold_id` de la cookie (Invariante 2: no operar un
  //      hold ajeno al flujo) ⇒ BOOKING_SESSION_MISMATCH.
  //    · debe existir `verified_phone` ⇒ si no, el paciente aún no pasó el OTP (PHONE_NOT_VERIFIED).
  //    La RPC revalida TODO a fondo bajo lock (vigencia, patient_phone, whatsapp_links, slot).
  const session: BookingSession | null = await getBookingSession();
  if (!session) return flowError('BOOKING_SESSION_REQUIRED', 'verify_phone');
  if (session.active_hold_id !== body.hold_id) {
    return flowError('BOOKING_SESSION_MISMATCH', 'restart_booking');
  }
  if (!session.verified_phone) return flowError('PHONE_NOT_VERIFIED', 'verify_phone');

  // 3) RPC ÚNICA (PRIVILEGIADA). Firma real: (p_slug, p_hold_id, p_marketplace_session_id,
  //    p_verified_phone). La RPC re-resuelve professional/service/precio desde el slug; el
  //    teléfono y la sesión vienen de la cookie firmada (server-side), jamás del body. Ella
  //    crea/recupera la Session en Stripe bajo el `FOR UPDATE` y congela `slot_holds.amount`.
  let result: CheckoutResult;
  try {
    result = await rpcService<CheckoutResult>('create_marketplace_checkout_from_hold', {
      p_slug: body.slug,
      p_hold_id: body.hold_id,
      p_marketplace_session_id: session.marketplace_session_id,
      p_verified_phone: session.verified_phone,
    });
  } catch (e) {
    return mapError(e);
  }

  // 4) Rama "ya es paciente de ESTE profesional": la RPC expiró el hold y la devuelve como fila
  //    (no excepción). La 1ª sesión de marketplace no aplica ⇒ continuar por WhatsApp (chatbot).
  //    Token canónico del módulo: `continue_whatsapp` (MARKETPLACE.md §728/§733).
  if (result.marketplace_allowed === false) {
    return flowError(
      result.reason ?? 'MARKETPLACE_BLOCKED_EXISTING_PATIENT',
      result.next_action ?? 'continue_whatsapp',
    );
  }

  // 5) Pago ya completado (idempotencia por hold): no hay URL que abrir. El webhook confirma la
  //    cita; el cliente va a la pantalla de resultado a hacer POLLING, no reintenta pago
  //    (MARKETPLACE.md §780, marketplace-pago.md §6).
  if (result.next_action === 'view_result' || result.checkout?.status === 'complete') {
    return NextResponse.json(
      { next_action: 'poll_result' as const, hold: result.hold ?? null },
      { status: 200, headers: { 'cache-control': 'no-store' } },
    );
  }

  // 6) Checkout listo (creado ⇒ redirect_to_checkout, o recuperado 'open' ⇒ continue_checkout):
  //    SOLO la URL de Stripe + vencimiento + hold público. El cliente hace
  //    `window.location = checkout.url`. NO devolvemos `stripe_checkout_session_id` (Invariante 5:
  //    viaja solo en la success URL que arma Stripe). El `success` de Stripe NO confirma la cita.
  const url = result.checkout?.url;
  if (!url) return errorJson('CHECKOUT_FAILED', 500);
  const nextAction =
    result.next_action === 'continue_checkout' ? 'continue_checkout' : 'redirect_to_stripe';
  return NextResponse.json(
    {
      checkout: { url, expires_at: result.checkout?.expires_at },
      hold: result.hold ?? null,
      next_action: nextAction as 'redirect_to_stripe' | 'continue_checkout',
    },
    { status: 200, headers: { 'cache-control': 'no-store' } },
  );
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
        // Ya hay Checkout en curso (carrera): el cliente continúa el pago existente (no se re-cobra).
        return flowError(e.code, 'continue_checkout');
      case 'MARKETPLACE_BLOCKED_EXISTING_PATIENT':
        // Defensa por si el contrato lo emitiera como RAISE en vez de fila: mismo token de flujo.
        return flowError(e.code, 'continue_whatsapp');
      case 'SLOT_UNAVAILABLE':
        return errorJson(e.code, 409);
      case 'STRIPE_CHECKOUT_FAILED':
        // Stripe rechazó/falló la creación de la Session (riel de pago externo).
        return errorJson(e.code, 502);
      case 'BOOKING_SESSION_REQUIRED':
      case 'BOOKING_SESSION_EXPIRED':
      case 'BOOKING_SESSION_MISMATCH':
        return errorJson(e.code, 409);
      default:
        return errorJson('CHECKOUT_FAILED', 500);
    }
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
