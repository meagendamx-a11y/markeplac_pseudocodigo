// =====================================================================================
// app/api/hold/route.ts
// Marketplace — Route Handler POST /api/hold. Aparta (o reemplaza) el slot elegido por
// 30 min ANTES del OTP, y sella el `active_hold_id` en la cookie firmada del flujo.
// Next.js App Router · SERVER-ONLY (nunca corre en el navegador).
//
// Contrato: MARKETPLACE.md § `create_or_replace_marketplace_slot_hold` (~L617) —
//   · Ruta canónica del contrato: `POST /psicologos/:slug/agendar/hold`. Este handler es
//     el endpoint del arnés (`/api/hold`) que lo materializa; el `slug` viaja en el body
//     (el navegador ya lo tiene desde la pantalla de horarios). Ambos apuntan al MISMO RPC.
//   · Entrada { slug, starts_at, first_name?, last_name? } + cookie de entrada/salida.
//   · Salida hold{ id, starts_at, ends_at, starts_at_local, ends_at_local, expires_at,
//     status } + cookie con `active_hold_id`/`professional_id`/`expires_at` actualizados.
//   · Errores INVALID_INPUT, MARKETPLACE_PROFILE_NOT_FOUND, MARKETPLACE_SERVICE_UNAVAILABLE,
//     INVALID_SLOT_STEP, SLOT_TOO_SOON, SLOT_UNAVAILABLE, CHECKOUT_ALREADY_STARTED,
//     HOLD_LIMIT_REACHED (+ BOOKING_SESSION_* de la cookie).
//   También MARKETPLACE.md § Cookie `marketplace_booking_session` (~L191) y § Rate limiting
//   y topes de abuso (~L1520): el intento de hold se registra en `otp_send_attempts`
//   (kind='hold') POR IP dentro del RPC; por eso este handler debe pasarle la IP del cliente.
//
// INVARIANTES DE SEGURIDAD DUROS (MARKETPLACE.md) que este archivo materializa:
//   1) Un hold NO es una cita. Aquí NO se crea cita/paciente/pago ni se inicia OTP/Checkout:
//      la cita SOLO nace del webhook firmado `handle_stripe_checkout_completed`. Este handler
//      solo aparta el slot bajo lock (SLOT_UNAVAILABLE si ya no está libre).
//   2) El `service_role` JAMÁS llega al navegador: la operación es privilegiada (escribe
//      `slot_holds`/`otp_send_attempts`, tabla service-role-only) y se ejecuta SOLO aquí, en el
//      servidor, vía `rpcService` (lib/supabase-server, con `import 'server-only'`). El browser
//      hace `POST {slug, starts_at}`; NUNCA habla con Supabase.
//   3) El backend NO confía en el frontend: `professional_id`, `service_id`, `ends_at`, precio,
//      duración y tz se re-resuelven en el RPC a partir del `slug`. De la cookie tampoco: el
//      estado real (hold vigente) se revalida bajo lock con `marketplace_session_id`.
//   4) La cookie la fija el SERVIDOR: firmada+cifrada, Secure/HttpOnly/SameSite=Lax, allowlist
//      estricta (lib/session-cookie). NUNCA localStorage; nada de OTP/Stripe/PII cruda/clínico.
//   5) Sin datos clínicos ni de pago en la respuesta: solo se devuelven los campos públicos del
//      hold (horario y vencimiento). Los errores se mapean a códigos de dominio sin filtrar
//      internos de Postgres/Stripe.
// =====================================================================================

import { NextResponse } from 'next/server';

import { rpcService, MarketplaceRpcError } from '../../../lib/supabase-server';
import {
  getBookingSession,
  setBookingSession,
  replaceBookingSession,
  BookingSessionError,
} from '../../../lib/session-cookie';

// Un hold depende de disponibilidad viva (holds/citas cambian minuto a minuto) y escribe
// cookie ⇒ jamás cachear, y ejecutar en Node (crypto de la cookie, service_role).
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

// -------------------------------------------------------------------------------------
// Tipos — espejo EXACTO de la salida de `create_or_replace_marketplace_slot_hold`
// (MARKETPLACE.md ~L649). Se incluyen `marketplace_session_id`/`professional_id` porque el
// RPC los re-resuelve/genera y el SERVIDOR los necesita para sellar la cookie; NO se
// reenvían al cliente (solo viaja el sub-objeto `hold`).
// -------------------------------------------------------------------------------------

/** Estado del hold (MARKETPLACE.md § hold_status): al crear siempre entra en `held`. */
type HoldStatus = 'held' | 'expired' | 'converted';

/** Sub-objeto público del hold que SÍ ve el cliente. Sin precio/tz-verdad/PII/clínico. */
interface HoldPublic {
  id: string; // uuid del hold recién creado/refrescado
  starts_at: string; // ISO UTC (autoritativo del backend, no del frontend)
  ends_at: string; // ISO UTC = starts_at + duración real (duration + buffer), lo calcula el RPC
  starts_at_local: string; // rótulo en la tz del PROFESIONAL (autoritativa)
  ends_at_local: string;
  expires_at: string; // ISO UTC — TTL del hold (now + 30 min)
  status: HoldStatus;
}

/** Salida completa del RPC (server-side). */
interface HoldRpcResult {
  hold: HoldPublic;
  marketplace_session_id: string; // el RPC lo genera si la cookie no traía uno vigente
  professional_id: string; // re-resuelto desde el slug — NUNCA se confía al cliente
  cookie_updated: true;
}

// -------------------------------------------------------------------------------------
// Validación de entrada (barrera de forma; la de negocio la hace el RPC bajo lock).
// -------------------------------------------------------------------------------------

interface HoldRequestBody {
  slug: string;
  starts_at: string; // ISO-8601 UTC, alineado a step 30 (lo revalida el RPC: INVALID_SLOT_STEP)
  first_name?: string; // opcionales aquí: el create_or_replace los refresca sobre el mismo hold
  last_name?: string;
}

const MAX_NAME_LEN = 120; // tope defensivo; el backend valida a fondo.

/** Normaliza y valida la forma mínima. Lanza códigos de dominio, no detalles internos. */
function parseBody(raw: unknown): HoldRequestBody {
  if (!raw || typeof raw !== 'object') throw new InputError('Body ausente o no-JSON.');
  const o = raw as Record<string, unknown>;

  const slug = typeof o.slug === 'string' ? o.slug.trim() : '';
  if (!slug || slug.length > 200) throw new InputError('slug inválido.');

  const starts_at = typeof o.starts_at === 'string' ? o.starts_at.trim() : '';
  // Solo se comprueba que sea una fecha parseable; el step-30 y el lead son del backend.
  if (!starts_at || Number.isNaN(Date.parse(starts_at))) {
    throw new InputError('starts_at inválido (se espera ISO-8601 UTC).');
  }

  const first_name = optName(o.first_name);
  const last_name = optName(o.last_name);

  return { slug, starts_at, first_name, last_name };
}

function optName(v: unknown): string | undefined {
  if (v == null) return undefined;
  if (typeof v !== 'string') throw new InputError('Nombre con tipo inválido.');
  const t = v.trim();
  if (!t) return undefined;
  if (t.length > MAX_NAME_LEN) throw new InputError('Nombre demasiado largo.');
  return t;
}

/** Error de forma ⇒ se mapea a INVALID_INPUT (422). */
class InputError extends Error {}

// -------------------------------------------------------------------------------------
// IP del cliente — la necesita el RPC para registrar el intento en `otp_send_attempts`
// (kind='hold') y aplicar el tope por IP/ventana (MARKETPLACE.md § Rate limiting, ~L1542).
// En producción confía SOLO en el header que ponga tu edge/reverse-proxy de confianza.
// -------------------------------------------------------------------------------------

function clientIp(req: Request): string | null {
  const fwd = req.headers.get('x-forwarded-for');
  if (fwd) return fwd.split(',')[0]!.trim() || null; // primer salto = cliente
  return req.headers.get('x-real-ip')?.trim() || null;
}

// -------------------------------------------------------------------------------------
// POST /api/hold
// -------------------------------------------------------------------------------------

export async function POST(req: Request): Promise<NextResponse> {
  // 1) Parseo/validación de forma. Cualquier fallo ⇒ INVALID_INPUT (422).
  let body: HoldRequestBody;
  try {
    body = parseBody(await req.json().catch(() => null));
  } catch (e) {
    if (e instanceof InputError) return errorJson('INVALID_INPUT', 422, e.message);
    return errorJson('INVALID_INPUT', 422);
  }

  // 2) Se localiza el flujo por la cookie (NO es autoritativa): de existir, se reutiliza su
  //    `marketplace_session_id` para que el hold quede atado a la MISMA sesión anónima. Si no
  //    hay cookie o venció, se pasa `null` y el RPC genera un id nuevo, que sella la cookie.
  const current = await getBookingSession();
  const ip = clientIp(req);

  // 3) Operación PRIVILEGIADA (service_role, SOLO servidor). El RPC, en UNA transacción:
  //    lockea la fila del profesional; reemplaza el hold del mismo flujo si NO tiene Checkout
  //    (mismo slot ⇒ refresca expires_at; otro slot ⇒ el anterior a `expired`); revalida
  //    disponibilidad bajo lock (SLOT_UNAVAILABLE si ya no está libre); inserta el hold `held`
  //    con patient_phone=NULL, nombres y expires_at=now()+30min; y registra el intento en
  //    `otp_send_attempts`(kind='hold'). NO crea cita/paciente/pago, NO inicia OTP/Checkout.
  let result: HoldRpcResult;
  try {
    result = await rpcService<HoldRpcResult>('create_or_replace_marketplace_slot_hold', {
      // Los nombres de estos parámetros ligan con la firma SQL de la función.
      slug: body.slug,
      starts_at: body.starts_at, // el RPC re-resuelve professional/service/ends_at/precio/tz
      first_name: body.first_name ?? null,
      last_name: body.last_name ?? null,
      marketplace_session_id: current?.marketplace_session_id ?? null, // null ⇒ el RPC lo genera
      ip_address: ip, // append-only en otp_send_attempts(kind='hold'); tope por IP/ventana
    });
  } catch (e) {
    return mapRpcError(e);
  }

  // 4) Sellado de la cookie por el SERVIDOR (firmada+cifrada, allowlist estricta). Se persiste
  //    `active_hold_id`/`professional_id` y se refresca `expires_at` (MARKETPLACE.md § cookie,
  //    "Actualizar"). Se preservan los demás campos del flujo (first/last name capturados,
  //    affinity_filters, etc.). Fuente de verdad del hold sigue siendo la DB, no esta cookie.
  try {
    const sameSession =
      current != null && current.marketplace_session_id === result.marketplace_session_id;

    if (sameSession) {
      // Refresco dentro de la misma sesión ⇒ patch con version++ (setBookingSession valida el
      // invariante de no-mezcla de profesionales: si difiere ⇒ BOOKING_SESSION_MISMATCH).
      await setBookingSession({
        professional_id: result.professional_id,
        active_hold_id: result.hold.id,
        first_name: body.first_name ?? current!.first_name,
        last_name: body.last_name ?? current!.last_name,
      });
    } else {
      // Sesión nueva (o cookie ausente/vencida): se sella con el `marketplace_session_id` que
      // GENERÓ el RPC, para que cookie y DB compartan la MISMA ancla del flujo. Reemplazo
      // deliberado (no aplica el guard de mismatch: es el inicio de un flujo).
      await replaceBookingSession({
        marketplace_session_id: result.marketplace_session_id,
        professional_id: result.professional_id,
        active_hold_id: result.hold.id,
        first_name: body.first_name ?? current?.first_name ?? null,
        last_name: body.last_name ?? current?.last_name ?? null,
        // affinity_filters/verified_phone se preservan si venían en el flujo previo.
        affinity_filters: current?.affinity_filters ?? null,
        verified_phone: current?.verified_phone ?? null,
        phone_verified_at: current?.phone_verified_at ?? null,
      });
    }
  } catch (e) {
    if (e instanceof BookingSessionError) {
      // Cambio de profesional dentro de una cookie viva ⇒ el flujo se reinicia (el hold recién
      // creado quedará huérfano y lo recogerá el cron `expire_marketplace_slot_holds`).
      return errorJson(e.code, 409, e.message);
    }
    throw e; // fallo real de cookie (p. ej. secreto ausente) ⇒ 500 genérico del framework.
  }

  // 5) Respuesta al cliente: SOLO los campos públicos del hold. Nada de session_id/professional_id
  //    internos, ni precio/tz-verdad/PII/clínico. La cookie ya viaja en el Set-Cookie de arriba.
  return NextResponse.json(
    { hold: result.hold, next_action: 'verify_phone' as const },
    { status: 201, headers: { 'cache-control': 'no-store' } },
  );
}

// -------------------------------------------------------------------------------------
// Mapeo de errores de dominio del RPC → HTTP, sin filtrar internos. Códigos: MARKETPLACE.md
// § create_or_replace_marketplace_slot_hold (~L653) + § Rate limiting.
// -------------------------------------------------------------------------------------

function mapRpcError(e: unknown): NextResponse {
  if (e instanceof MarketplaceRpcError) {
    switch (e.code) {
      case 'INVALID_INPUT':
      case 'INVALID_SLOT_STEP':
      case 'SLOT_TOO_SOON':
        return errorJson(e.code, 422);
      case 'MARKETPLACE_PROFILE_NOT_FOUND':
      case 'MARKETPLACE_SERVICE_UNAVAILABLE':
        return errorJson(e.code, 404);
      case 'SLOT_UNAVAILABLE':
        // El slot se ocupó bajo el lock: el paciente debe elegir otro horario.
        return errorJson(e.code, 409);
      case 'CHECKOUT_ALREADY_STARTED':
        // Ya hay un hold con Checkout iniciado: NO se reemplaza; se continúa el pago existente.
        return NextResponse.json(
          { error: e.code, next_action: 'continue_checkout' as const },
          { status: 409, headers: { 'cache-control': 'no-store' } },
        );
      case 'HOLD_LIMIT_REACHED':
        // Tope de holds concurrentes por profesional o por IP/ventana ⇒ throttling.
        return errorJson(e.code, 429);
      case 'BOOKING_SESSION_EXPIRED':
      case 'BOOKING_SESSION_MISMATCH':
      case 'BOOKING_SESSION_REQUIRED':
        return errorJson(e.code, 409);
      default:
        // Código desconocido ⇒ 500 opaco (no se expone el mensaje interno de Postgres).
        return errorJson('HOLD_FAILED', 500);
    }
  }
  // No es un error de dominio (red/infra) ⇒ 500 opaco.
  return errorJson('HOLD_FAILED', 500);
}

/** JSON de error homogéneo, siempre no-cacheable. `detail` solo para forma (INVALID_INPUT). */
function errorJson(code: string, status: number, detail?: string): NextResponse {
  return NextResponse.json(
    detail ? { error: code, detail } : { error: code },
    { status, headers: { 'cache-control': 'no-store' } },
  );
}
