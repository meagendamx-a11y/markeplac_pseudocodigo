// =====================================================================================
// app/api/otp/start/route.ts
// -------------------------------------------------------------------------------------
// Route Handler: POST /api/otp/start — inicia la verificación del teléfono por WhatsApp.
//
// Contrato: MARKETPLACE.md § "start_marketplace_phone_verification" (líneas ~668-704)
//           + § "Rate limiting y topes de abuso" (a) (líneas ~1520-1535)
//           + contrato de red del cliente en
//             app/psicologos/[slug]/agendar/page.tsx (ENDPOINTS.otpStart, líneas ~104-108):
//               POST /api/otp/start { phone }   (hold_id se toma de la COOKIE, no del body)
//                 → { verification_required: true, channel, phone_masked, hold_expires_at } [200]
//                 → { verification_required: false, next_action: 'create_checkout' }        [200]
//                 · OTP_RATE_LIMITED [429] · HOLD_EXPIRED [409] · INVALID_PHONE [422]
//
// QUÉ HACE ESTA CAPA (y qué NO):
//   - Re-resuelve el hilo del flujo desde la COOKIE FIRMADA (marketplace_session_id,
//     professional_id, active_hold_id, first_name, last_name, verified_phone), NUNCA desde
//     el body: el body solo aporta el `phone` (y, opcional, un `slug` de conveniencia). Así
//     el atacante no puede pedir OTP para un hold que no es suyo (MARKETPLACE.md § cookie,
//     Invariante 2: toda mutación revalida marketplace_session_id + hold vigentes).
//   - Delega TODA la lógica sensible a la RPC privilegiada `start_marketplace_phone_verification`
//     vía `rpcService` (service_role SOLO en el servidor; jamás en el navegador). La RPC es el
//     PRODUCTOR de `otp_send_attempts` (kind='otp') y quien decide `OTP_RATE_LIMITED` contando
//     por ventana (phone / IP / marketplace_session_id+professional_id) — este handler solo le
//     pasa la IP del cliente para esa contabilidad.
//   - Actualiza la cookie con first_name/last_name (+version) tras enviar el OTP (paso 4 del
//     flujo). El TELÉFONO NO se guarda en la cookie aquí: `verified_phone` solo se sella en
//     /api/otp/verify tras aprobar el código (MARKETPLACE.md línea 108 del contrato de red).
//   - NO verifica el OTP, NO consulta patients/whatsapp_links (eso es post-OTP, en verify),
//     NO toca slot_holds.patient_phone, NO crea Checkout ni persiste el código.
//
// SEGURIDAD:
//   - service_role solo aquí (server-only, vía lib/supabase-server). Nunca al cliente.
//   - Respuesta al paciente: solo `phone_masked` que devuelve la RPC; sin PII cruda, sin
//     datos clínicos ni de pago (MARKETPLACE.md § cookie, "Nunca contiene").
//   - El código OTP no entra ni sale por esta ruta.
// =====================================================================================

import { NextResponse, type NextRequest } from 'next/server';

// Imports relativos: el repo no define alias `@/` en tsconfig (mismo estilo que
// app/psicologos/[slug]/agendar/page.tsx). Desde app/api/otp/start/ son 4 niveles a la raíz.
import {
  requireBookingSession,
  setBookingSession,
  BookingSessionError,
} from '../../../../lib/session-cookie';
import { rpcService, MarketplaceRpcError } from '../../../../lib/supabase-server';

// crypto (session-cookie) + service_role ⇒ runtime Node, y nunca cachear una mutación.
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// -------------------------------------------------------------------------------------
// Tipos del contrato
// -------------------------------------------------------------------------------------

/** Body aceptado. El único campo autoritativo es `phone`; `slug` es conveniencia opcional
 *  (el cliente vive bajo /psicologos/[slug] y puede pasarlo). first_name/last_name se leen
 *  de la cookie (capturados en el paso del hold); el body solo los usa como respaldo. */
interface OtpStartBody {
  phone?: unknown;
  slug?: unknown;
  first_name?: unknown;
  last_name?: unknown;
}

/** Salida de `start_marketplace_phone_verification` (MARKETPLACE.md § Salida, línea ~696). */
interface StartVerificationResult {
  verification_required: boolean;
  channel?: 'whatsapp';
  phone_masked?: string;
  hold_expires_at?: string;
  next_action?: 'create_checkout';
}

// -------------------------------------------------------------------------------------
// Validación de entrada (defensa en profundidad; la RPC revalida en DB)
// -------------------------------------------------------------------------------------

/** E.164: '+' seguido de 8..15 dígitos, primer dígito no-cero. La RPC vuelve a validar
 *  y responde INVALID_PHONE si no cumple (MARKETPLACE.md § Validación, "phone E.164"). */
const E164 = /^\+[1-9]\d{7,14}$/;

/** IP del cliente para el rate-limit persistente por IP de la RPC (§ Rate limiting (a)).
 *  Primer salto de x-forwarded-for; respaldo x-real-ip. `null` si no hay (la RPC hace
 *  INSERT append-only en otp_send_attempts que "nunca falla por formato"). */
function clientIp(req: NextRequest): string | null {
  const xff = req.headers.get('x-forwarded-for');
  if (xff) {
    const first = xff.split(',')[0]?.trim();
    if (first) return first;
  }
  return req.headers.get('x-real-ip')?.trim() || null;
}

// -------------------------------------------------------------------------------------
// Mapeo error de dominio → HTTP. Se apega al contrato de red del cliente (page.tsx §104-108)
// y a los errores declarados de la RPC (MARKETPLACE.md línea ~699). Solo se expone el `code`;
// nunca el detalle interno del error (evita filtración; MARKETPLACE.md § allowlist de columnas).
// -------------------------------------------------------------------------------------

function httpStatusForCode(code: string): number {
  switch (code) {
    case 'OTP_RATE_LIMITED':
      return 429; // demasiados envíos por alguna ventana (phone/IP/sesión).
    case 'HOLD_EXPIRED':
    case 'HOLD_NOT_FOUND':
    case 'CHECKOUT_ALREADY_STARTED':
    case 'BOOKING_SESSION_MISMATCH':
      return 409; // conflicto de estado del flujo (el slot/hold ya no está disponible como se pidió).
    case 'INVALID_PHONE':
    case 'INVALID_INPUT':
      return 422; // entrada malformada.
    case 'BOOKING_SESSION_REQUIRED':
    case 'BOOKING_SESSION_EXPIRED':
      return 401; // falta/venció la cookie del flujo: reiniciar identificación.
    case 'OTP_SEND_FAILED':
      return 502; // fallo aguas abajo (Twilio). El paciente puede reintentar.
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
  // 1) Body. Solo confiamos en `phone` (autoritativo del paciente) — el resto del hilo sale
  //    de la cookie. Un body ilegible ⇒ INVALID_INPUT (no revelamos parsers internos).
  let body: OtpStartBody;
  try {
    body = (await req.json()) as OtpStartBody;
  } catch {
    return errorResponse('INVALID_INPUT');
  }

  const phone = typeof body.phone === 'string' ? body.phone.trim() : '';
  if (!E164.test(phone)) {
    // Falla cerrado antes de tocar la RPC/Twilio (MARKETPLACE.md § Validación, INVALID_PHONE).
    return errorResponse('INVALID_PHONE');
  }

  // 2) Cookie firmada = fuente del hilo. Sin cookie/hold ⇒ el paciente debe reiniciar el flujo.
  //    (El hold_id JAMÁS se lee del body: MARKETPLACE.md contrato de red, línea 104.)
  //    `requireBookingSession` distingue REQUIRED (no hay cookie) de EXPIRED (venció): ambos
  //    son errores DECLARADOS de la RPC (MARKETPLACE.md línea ~699); usar `getBookingSession`
  //    colapsaría el caso EXPIRED en REQUIRED y ese código nunca se emitiría.
  let session: Awaited<ReturnType<typeof requireBookingSession>>;
  try {
    session = await requireBookingSession();
  } catch (err) {
    if (err instanceof BookingSessionError) return errorResponse(err.code);
    return errorResponse('BOOKING_SESSION_REQUIRED');
  }
  if (!session.professional_id || !session.active_hold_id) {
    // Cookie sin profesional/hold: no hay nada que verificar todavía.
    return errorResponse('BOOKING_SESSION_REQUIRED');
  }

  // first_name/last_name: prellenados en el paso del hold y guardados en la cookie
  // (allowlist). El body solo sirve de respaldo. La RPC los exige para el registro del intento.
  const firstName =
    session.first_name ?? (typeof body.first_name === 'string' ? body.first_name : null);
  const lastName =
    session.last_name ?? (typeof body.last_name === 'string' ? body.last_name : null);
  if (!firstName || !lastName) {
    // Deberían venir del hold; si faltan, el flujo está incompleto.
    return errorResponse('INVALID_INPUT');
  }

  // slug de conveniencia (el cliente lo conoce). NO es autoridad: la RPC cruza el profile
  // resuelto contra el professional_id de la cookie ("professional_id coincide", § Validación).
  const slug = typeof body.slug === 'string' ? body.slug : null;

  // 3) RPC privilegiada. TODO lo sensible (hold vigente sin checkout, no-reenvío si el
  //    verified_phone de la cookie ya cubre este phone, INSERT en otp_send_attempts ANTES de
  //    Twilio, conteo por ventana ⇒ OTP_RATE_LIMITED, Twilio Verify sin persistir el código)
  //    ocurre dentro de la RPC. Le pasamos el hilo de la cookie + la IP para el rate-limit.
  let result: StartVerificationResult;
  try {
    result = await rpcService<StartVerificationResult>('start_marketplace_phone_verification', {
      p_slug: slug,
      p_hold_id: session.active_hold_id, // ← de la cookie, no del body
      p_first_name: firstName,
      p_last_name: lastName,
      p_phone: phone,
      p_marketplace_session_id: session.marketplace_session_id,
      // Campos de cookie que el edge/BFF pasa server-side (nombres con prefijo p_cookie_*
      // según la firma real de la RPC). El professional_id/active_hold_id de la cookie sirven
      // para contrastar contra el slug y el hold; jamás llegan del body.
      p_cookie_professional_id: session.professional_id,
      p_cookie_active_hold_id: session.active_hold_id,
      // Estado de verificación previo (para "si la cookie ya tiene verified_phone = phone
      // vigente ⇒ no reenvía OTP", MARKETPLACE.md § Validación / Flujo paso "ya verificado").
      p_cookie_verified_phone: session.verified_phone,
      p_cookie_phone_verified_at: session.phone_verified_at,
      // Rate-limit persistente por IP (§ Rate limiting (a): "por IP: ventana propia").
      p_ip_address: clientIp(req),
    });
  } catch (err) {
    if (err instanceof MarketplaceRpcError) return errorResponse(err.code);
    // No filtrar el error crudo al cliente.
    return errorResponse('OTP_SEND_FAILED');
  }

  // 4) Caso "ya verificado": no se envió OTP; no se escribe cookie (el phone NO se persiste
  //    aquí). El cliente avanza directo al checkout.
  if (result.verification_required === false) {
    return NextResponse.json(
      { verification_required: false, next_action: result.next_action ?? 'create_checkout' },
      { status: 200 },
    );
  }

  // 5) OTP enviado: actualizar la cookie con first_name/last_name (+version) — paso 4 del
  //    flujo. El teléfono NO entra a la cookie aquí (solo verify sella verified_phone).
  try {
    await setBookingSession({ first_name: firstName, last_name: lastName });
  } catch (err) {
    // Un fallo escribiendo la cookie no debe "reenviar" un OTP ya mandado. La cookie no es
    // autoritativa (el estado real vive en DB), así que degradamos silenciosamente salvo el
    // caso de invariante de no-mezcla de profesional.
    if (err instanceof BookingSessionError && err.code === 'BOOKING_SESSION_MISMATCH') {
      return errorResponse('BOOKING_SESSION_MISMATCH');
    }
    // otros fallos: continuamos; el OTP ya viaja por WhatsApp.
  }

  // 6) Salida al cliente: solo phone_masked (sin PII cruda) + datos no sensibles del flujo.
  return NextResponse.json(
    {
      verification_required: true,
      channel: result.channel ?? 'whatsapp',
      phone_masked: result.phone_masked,
      hold_expires_at: result.hold_expires_at,
    },
    { status: 200 },
  );
}
