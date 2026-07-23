// =====================================================================================
// app/api/otp/verify/route.ts
// -------------------------------------------------------------------------------------
// Route Handler: POST /api/otp/verify — valida el código OTP, sella el teléfono como
// verificado en la cookie y decide si el marketplace sigue permitido o hay que derivar
// a WhatsApp por tratarse de un paciente existente del profesional.
//
// Contrato: MARKETPLACE.md § "verify_marketplace_phone_otp" (líneas ~706-740)
//           + § "Cookie marketplace_booking_session" (allowlist, ciclo de vida, invariantes)
//           + contrato de red del cliente en
//             app/psicologos/[slug]/agendar/page.tsx (ENDPOINTS.otpVerify, líneas ~110-116):
//               POST /api/otp/verify { otp_code }   (hold_id/slug se re-resuelven server-side;
//                 el phone lo aporta <AgendarFlow>, que lo mantiene SOLO en memoria hasta que
//                 verify lo escribe en slot_holds.patient_phone — page.tsx línea ~38)
//                 → { verified: true, marketplace_allowed: true,  next_action: create_checkout }   [200]
//                 → { verified: true, marketplace_allowed: false,
//                     reason: MARKETPLACE_BLOCKED_EXISTING_PATIENT, next_action: continue_whatsapp } [200]
//                 · INVALID_OTP / OTP_EXPIRED_OR_NOT_FOUND / OTP_MAX_ATTEMPTS_REACHED  [401/422/429]
//
// QUÉ HACE ESTA CAPA (y qué NO):
//   - Re-resuelve el hilo del flujo desde la COOKIE CIFRADA (marketplace_session_id,
//     professional_id, active_hold_id), NUNCA desde el body: del body solo se aceptan las
//     dos piezas de input del paciente — `otp_code` (autoritativo) y `phone` (el que el
//     paciente tecleó y al que start mandó el OTP; Twilio comprueba phone+code juntos, así
//     que falsear el phone solo hace fallar el VerificationCheck). El `hold_id`/`slug` JAMÁS
//     se leen del body (MARKETPLACE.md § cookie, Invariante 2: toda mutación revalida
//     marketplace_session_id + hold vigentes; contrato de red, línea 110).
//   - Delega TODA la lógica sensible a la RPC privilegiada `verify_marketplace_phone_otp`
//     (service_role SOLO en el servidor; jamás en el navegador): Twilio VerificationCheck
//     FUERA de transacción; luego transacción corta con FOR UPDATE sobre el hold que revalida
//     held/vigente/sin Checkout; escribe slot_holds.patient_phone; consulta whatsapp_links por
//     (professional_id, phone) y, si el teléfono ya es paciente de ESTE profesional, expira el
//     hold y responde MARKETPLACE_BLOCKED_EXISTING_PATIENT (MARKETPLACE.md § verify, Flujo 1-6).
//   - Sella el resultado en la COOKIE (en esta arquitectura Next.js el "escribe cookie" del
//     contrato lo materializa el Route Handler, no la función de Postgres):
//       · permitido      → verified_phone + phone_verified_at (+version).
//       · bloqueado       → conserva verified_phone + phone_verified_at, LIMPIA active_hold_id
//                           y marca blocked_reason=EXISTING_PATIENT (MARKETPLACE.md § verify,
//                           paso 5: "limpiar active_hold_id, conservar verified_phone").
//   - NO crea pacientes/citas/Checkout, NO expone si el teléfono existe con OTROS
//     profesionales, NO persiste el OTP ni lo devuelve, NO manda datos clínicos/de pago al
//     cliente (MARKETPLACE.md § verify, "No debe"; § cookie, "Nunca contiene").
//
// SEGURIDAD:
//   - service_role solo aquí (server-only, vía lib/supabase-server). Nunca al cliente.
//   - El código OTP entra por el body y muere en la RPC/Twilio: nunca se guarda ni se
//     re-emite en la respuesta (MARKETPLACE.md § cookie, "Nunca contiene: OTP/código").
//   - Respuesta al paciente: solo `verified`/`marketplace_allowed`/`reason`/`next_action`
//     y, como conveniencia no sensible, `hold_expires_at`. Sin PII cruda, sin phone, sin
//     saber si es paciente de otros profesionales.
// =====================================================================================

import { NextResponse, type NextRequest } from 'next/server';

// Imports relativos: el repo no define alias `@/` en tsconfig (mismo estilo que
// app/api/otp/start/route.ts). Desde app/api/otp/verify/ son 4 niveles a la raíz.
import {
  getBookingSession,
  setBookingSession,
  replaceBookingSession,
  BookingSessionError,
} from '../../../../lib/session-cookie';
import { rpcService, MarketplaceRpcError } from '../../../../lib/supabase-server';

// crypto (session-cookie) + service_role ⇒ runtime Node, y nunca cachear una mutación.
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// -------------------------------------------------------------------------------------
// Tipos del contrato
// -------------------------------------------------------------------------------------

/** Body aceptado. Autoritativo del paciente: `otp_code` (siempre) y `phone` (el que tecleó;
 *  <AgendarFlow> lo mantiene en memoria — page.tsx ~L38). `slug` es conveniencia opcional
 *  (el cliente vive bajo /psicologos/[slug]); NO es autoridad: la RPC cruza el perfil resuelto
 *  contra el professional_id de la cookie. `hold_id` NUNCA se acepta del body. */
interface OtpVerifyBody {
  otp_code?: unknown;
  phone?: unknown;
  slug?: unknown;
}

/** Salida de `verify_marketplace_phone_otp` (MARKETPLACE.md § Salida, líneas ~730-734). */
interface VerifyOtpResult {
  verified: boolean;
  marketplace_allowed: boolean;
  reason?: 'MARKETPLACE_BLOCKED_EXISTING_PATIENT';
  next_action?: 'create_checkout' | 'continue_whatsapp';
  // Datos NO sensibles del hold para pintar la pantalla; nunca patient_phone ni datos de pago.
  hold?: { hold_id?: string; expires_at?: string; status?: string };
  // Instante de verificación que fija la RPC; si no lo devuelve, el handler usa now().
  phone_verified_at?: string;
}

// -------------------------------------------------------------------------------------
// Validación de entrada (defensa en profundidad; la RPC + Twilio revalidan de verdad)
// -------------------------------------------------------------------------------------

/** E.164: '+' seguido de 8..15 dígitos, primer dígito no-cero (mismo criterio que start). */
const E164 = /^\+[1-9]\d{7,14}$/;

/** OTP de Twilio Verify: 4..8 dígitos. Solo un pre-filtro de forma; el veredicto real lo da
 *  Twilio VerificationCheck dentro de la RPC (MARKETPLACE.md § verify, paso 2). */
const OTP_CODE = /^\d{4,8}$/;

// -------------------------------------------------------------------------------------
// Mapeo error de dominio → HTTP. Se apega a los errores declarados de la RPC
// (MARKETPLACE.md línea ~736) y al contrato de red del cliente (page.tsx §110-116).
// Solo se expone el `code`; jamás el detalle interno (evita filtración; § allowlist).
// -------------------------------------------------------------------------------------

function httpStatusForCode(code: string): number {
  switch (code) {
    case 'OTP_MAX_ATTEMPTS_REACHED':
      return 429; // demasiados intentos de código: throttle (coherente con OTP_RATE_LIMITED en start).
    case 'INVALID_OTP':
    case 'INVALID_PHONE':
    case 'INVALID_INPUT':
      return 422; // entrada malformada / código incorrecto.
    case 'OTP_EXPIRED_OR_NOT_FOUND':
      return 401; // no hay verificación viva: el paciente debe reiniciar el envío del OTP.
    case 'HOLD_EXPIRED':
    case 'HOLD_NOT_FOUND':
    case 'CHECKOUT_ALREADY_STARTED':
    case 'BOOKING_SESSION_MISMATCH':
      return 409; // conflicto de estado del flujo (hold/checkout ya no está como se pidió).
    case 'BOOKING_SESSION_REQUIRED':
    case 'BOOKING_SESSION_EXPIRED':
      return 401; // falta/venció la cookie del flujo: reiniciar identificación.
    case 'MARKETPLACE_PROFILE_NOT_FOUND':
      return 404;
    case 'OTP_CHECK_FAILED':
      return 502; // fallo aguas abajo (Twilio); el paciente puede reintentar.
    default:
      return 500;
  }
}

/** Respuesta de error uniforme: solo `{ error: CODE }` (+ next_action cuando el contrato lo
 *  define, p. ej. CHECKOUT_ALREADY_STARTED → continuar al checkout ya iniciado). */
function errorResponse(code: string): NextResponse {
  const body: { error: string; next_action?: string } = { error: code };
  if (code === 'CHECKOUT_ALREADY_STARTED') body.next_action = 'continue_checkout';
  return NextResponse.json(body, { status: httpStatusForCode(code) });
}

// -------------------------------------------------------------------------------------
// Handler
// -------------------------------------------------------------------------------------

export async function POST(req: NextRequest): Promise<NextResponse> {
  // 1) Body. Solo confiamos en `otp_code` y `phone` (input del paciente) — el resto del hilo
  //    (hold_id/session/professional) sale de la cookie. Un body ilegible ⇒ INVALID_INPUT.
  let body: OtpVerifyBody;
  try {
    body = (await req.json()) as OtpVerifyBody;
  } catch {
    return errorResponse('INVALID_INPUT');
  }

  const otpCode = typeof body.otp_code === 'string' ? body.otp_code.trim() : '';
  if (!OTP_CODE.test(otpCode)) {
    // Falla cerrado antes de tocar la RPC/Twilio (MARKETPLACE.md § verify, INVALID_OTP).
    return errorResponse('INVALID_OTP');
  }

  // 2) Cookie cifrada = fuente del hilo. Sin cookie/hold ⇒ el paciente debe reiniciar el flujo.
  //    (El hold_id JAMÁS se lee del body: contrato de red, línea 110.)
  const session = await getBookingSession();
  if (!session) return errorResponse('BOOKING_SESSION_REQUIRED');
  if (!session.professional_id || !session.active_hold_id) {
    // Cookie sin profesional/hold: no hay nada que verificar todavía.
    return errorResponse('BOOKING_SESSION_REQUIRED');
  }

  // 3) Teléfono. Primero el que teclea el paciente (lo tiene <AgendarFlow> en memoria); como
  //    respaldo, el verified_phone ya sellado en la cookie (reintento idempotente del mismo
  //    número). Si ninguno es E.164 ⇒ INVALID_PHONE (la RPC vuelve a validar).
  const phoneInput = typeof body.phone === 'string' ? body.phone.trim() : '';
  const phone = E164.test(phoneInput) ? phoneInput : session.verified_phone;
  if (!phone || !E164.test(phone)) {
    return errorResponse('INVALID_PHONE');
  }

  // slug de conveniencia (el cliente lo conoce). NO es autoridad: la RPC cruza el perfil
  // resuelto contra el professional_id de la cookie (MARKETPLACE.md § verify, Flujo 1).
  const slug = typeof body.slug === 'string' ? body.slug : null;

  // 4) RPC privilegiada. TODO lo sensible (Twilio VerificationCheck fuera de transacción;
  //    transacción corta con FOR UPDATE que revalida held/vigente/sin Checkout; escribir
  //    slot_holds.patient_phone; consultar whatsapp_links por (professional_id, phone) y
  //    bloquear si es paciente de ESTE profesional) ocurre dentro de la RPC. Le pasamos el
  //    hilo de la cookie + el phone + el otp_code. La cookie del navegador la sella el handler.
  let result: VerifyOtpResult;
  try {
    result = await rpcService<VerifyOtpResult>('verify_marketplace_phone_otp', {
      p_slug: slug,
      p_hold_id: session.active_hold_id, // ← de la cookie, no del body
      p_phone: phone,
      p_otp_code: otpCode,
      p_marketplace_session_id: session.marketplace_session_id,
      // Estado de verificación previo: "si la cookie ya tiene verified_phone = phone vigente,
      // saltar Twilio" (MARKETPLACE.md § verify, Flujo 2). Nombres p_cookie_* según la firma
      // real de la RPC (que NO declara professional_id: el tenant se deriva del slug + hold).
      p_cookie_verified_phone: session.verified_phone,
      p_cookie_phone_verified_at: session.phone_verified_at,
    });
  } catch (err) {
    if (err instanceof MarketplaceRpcError) return errorResponse(err.code);
    // No filtrar el error crudo al cliente; un fallo no clasificado del check ⇒ reintentar.
    return errorResponse('OTP_CHECK_FAILED');
  }

  // La RPC no debería devolver verified=false sin lanzar (sin `approved` de Twilio rechaza sin
  // tocar nada); si aun así llega, lo tratamos como código inválido, no como éxito.
  if (!result.verified) {
    return errorResponse('INVALID_OTP');
  }

  const phoneVerifiedAt = result.phone_verified_at ?? new Date().toISOString();

  // 5a) Rama BLOQUEADA: el teléfono ya es paciente de ESTE profesional. La RPC ya expiró el
  //     hold en DB; aquí sellamos la cookie del contrato: conservar verified_phone +
  //     phone_verified_at, LIMPIAR active_hold_id y marcar blocked_reason=EXISTING_PATIENT.
  //     Se usa replaceBookingSession porque el merge por `??` de setBookingSession no puede
  //     poner active_hold_id en null (null ?? base = base); esta rama es terminal (el paciente
  //     sigue por WhatsApp), así que un reemplazo explícito del hilo es lo correcto.
  if (result.marketplace_allowed === false) {
    try {
      await replaceBookingSession({
        marketplace_session_id: session.marketplace_session_id,
        professional_id: session.professional_id, // mismo profesional: no hay mezcla
        active_hold_id: null, // ← limpiar (hold expirado en DB)
        first_name: session.first_name,
        last_name: session.last_name,
        verified_phone: phone, // conservar
        phone_verified_at: phoneVerifiedAt, // conservar
        blocked_reason: 'EXISTING_PATIENT',
        affinity_filters: session.affinity_filters,
      });
    } catch {
      // La cookie no es autoritativa (el hold ya está expirado en DB). Un fallo al sellarla
      // no debe romper el handoff: igual respondemos BLOQUEADO.
    }
    return NextResponse.json(
      {
        verified: true,
        marketplace_allowed: false,
        reason: result.reason ?? 'MARKETPLACE_BLOCKED_EXISTING_PATIENT',
        next_action: result.next_action ?? 'continue_whatsapp',
      },
      { status: 200 },
    );
  }

  // 5b) Rama PERMITIDA: sellar verified_phone + phone_verified_at en la cookie (+version).
  //     A partir de aquí el cliente avanza al checkout (create_marketplace_checkout_from_hold).
  try {
    const next = await setBookingSession({
      verified_phone: phone,
      phone_verified_at: phoneVerifiedAt,
    });
    // setBookingSession fusiona con `??`, así que `blocked_reason: null` NO limpiaría un
    // EXISTING_PATIENT heredado de un intento previo (null ?? base = base). page.tsx (~L177)
    // ramifica a WhatsApp con SOLO ver blocked_reason en la cookie, así que un valor obsoleto
    // desviaría por error a un paciente que sí puede pagar. Si quedó sellado, lo limpiamos con
    // un reemplazo explícito conservando el resto del hilo (session_id, hold, PII, version).
    if (next.blocked_reason) {
      await replaceBookingSession({ ...next, blocked_reason: null });
    }
  } catch (err) {
    // Cambio de profesional entre requests ⇒ no mezclar profesionales (Invariante 2).
    if (err instanceof BookingSessionError && err.code === 'BOOKING_SESSION_MISMATCH') {
      return errorResponse('BOOKING_SESSION_MISMATCH');
    }
    // Otros fallos al sellar: la verificación en DB ya ocurrió (patient_phone escrito). La
    // cookie es reemplazable; degradamos silenciosamente y dejamos que el cliente continúe.
  }

  // 6) Salida al cliente: solo el veredicto + next_action + hold_expires_at (no sensible).
  //    Nunca el phone, nunca datos clínicos/de pago (MARKETPLACE.md § cookie, "Nunca contiene").
  return NextResponse.json(
    {
      verified: true,
      marketplace_allowed: true,
      next_action: result.next_action ?? 'create_checkout',
      hold_expires_at: result.hold?.expires_at,
    },
    { status: 200 },
  );
}
