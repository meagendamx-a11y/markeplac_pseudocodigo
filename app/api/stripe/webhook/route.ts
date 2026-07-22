// =====================================================================================
// app/api/stripe/webhook/route.ts
// Marketplace — Route Handler POST /webhooks/stripe (montado en /api/stripe/webhook).
// Materializa la función de contrato `handle_stripe_checkout_completed`: recibe el webhook
// de Stripe, verifica la firma sobre el RAW body ANTES de parsear, y delega a la RPC
// idempotente que —dentro de una transacción con lock— crea patient + appointment +
// marketplace_payment, o persiste `requires_support`. Next.js App Router · SERVER-ONLY.
//
// Contrato: MARKETPLACE.md § `handle_stripe_checkout_completed` (~L783-858),
//   § Tabla `stripe_webhook_events` (~L184-189), § Casos borde / requires_support (~L302-308),
//   § Concurrencia (advisory lock, HTTP nunca bajo el lock, ~L806-807).
//
// FRONTERA Node/Postgres — por qué la función lógica se materializa aquí + una RPC:
//   El contrato describe `handle_stripe_checkout_completed` como UNA operación (verificar
//   firma → idempotencia por event_id → validar Session → transacción con lock que crea
//   cita/pago o marca needs_support). Pero una RPC de Postgres NO puede verificar la firma
//   HMAC del webhook ni hablar HTTP con Stripe, y "toda la verificación de firma ocurre ANTES
//   del lock, nunca HTTP bajo el lock" (MARKETPLACE.md §806-807). Por eso este handler:
//     1) lee el RAW body y verifica la firma (lib/stripe.verifyWebhookSignature) → autentica;
//     2) filtra el tipo de evento (`checkout.session.completed`);
//     3) pasa el evento YA VERIFICADO (event_id, type, created, payload) a la RPC
//        `handle_stripe_checkout_completed`, que hace idempotencia + validación de monto/
//        moneda/estado + la transacción con `agenda_lock(professional_id)`.
//   La creación de cita/pago vive EXCLUSIVAMENTE en la RPC; este archivo jamás inserta
//   patients/appointments/marketplace_payments.
//
// INVARIANTES DE SEGURIDAD DUROS (MARKETPLACE.md) que este archivo materializa:
//   1) La firma se verifica sobre el RAW body ANTES de parsear (§797). Por eso leemos
//      `await req.text()` (nunca `req.json()`: reserializar rompería la firma) y NO tocamos
//      el cuerpo hasta que `verifyWebhookSignature` devuelve el `Stripe.Event` reconstruido.
//      Sin firma válida ⇒ 400, sin ejecutar dominio.
//   2) La cita SOLO nace del webhook firmado y de forma IDEMPOTENTE por `event_id`
//      (§798-799, tabla `stripe_webhook_events`). Un reintento de Stripe con el mismo evento
//      NO duplica cita/pago: la RPC hace `insert stripe_webhook_events(event_id …)` y, si ya
//      estaba `processed`, retorna éxito no-op. Este handler no confía en la URL `success`
//      (esa pantalla hace polling); confía SOLO en el evento firmado.
//   3) El `service_role` JAMÁS llega al navegador: la RPC se invoca con `rpcService`, que vive
//      en lib/supabase-server (`import 'server-only'`), igual que el cliente Stripe. El browser
//      nunca ejecuta este endpoint: lo llama Stripe server-to-server.
//   4) El backend NO confía en el frontend: precio/moneda/monto se validan en la RPC contra el
//      SNAPSHOT del hold (`amount_total == slot_holds.amount * 100`, §800), no contra el precio
//      vivo ni contra dato alguno del cliente. Aquí no se acepta ni un campo del navegador.
//   5) `requires_support` se PERSISTE, no se pierde (§302-308): los casos no resolubles
//      (ya-paciente post-pago, slot en conflicto final, pago sin fila modelable) los graba la
//      RPC como `stripe_webhook_events.processing_status='needs_support'`. Cuando eso ocurre el
//      dinero YA se cobró y reintentar no ayuda ⇒ respondemos 2xx para que Stripe DEJE de
//      reintentar; el caso queda en la cola de soporte, no en un bucle de webhooks.
//   6) Sin datos clínicos ni de pago en la respuesta: a Stripe solo le importa el status HTTP.
//      El body es un ACK mínimo (`{ received: true, ... }`); nunca filtra internos de la DB.
//
// POLÍTICA DE STATUS (clave para no perder dinero ni entrar en bucles):
//   · 400  — firma inválida (evento no autenticado). No se ejecuta dominio.
//   · 2xx  — evento AUTENTICADO y ya resuelto por la RPC de forma DEFINITIVA: procesado,
//            no-op idempotente, ignorado (tipo no soportado) o `requires_support` persistido.
//            En todos estos casos reintentar NO cambia el resultado ⇒ Stripe debe parar.
//   · 5xx  — SOLO fallo TRANSITORIO/inesperado (DB caída, config ausente, excepción no
//            mapeada). Aquí SÍ queremos que Stripe REINTENTE para no perder el evento.
//   Regla money-safe: nunca 5xx sobre un evento cuyo cobro ya ocurrió salvo que el fallo sea
//   transitorio; nunca 2xx sobre un fallo transitorio (perderíamos el evento).
//
// NOTA sobre tokens.css: este es un endpoint server-only sin markup; no hay superficie visual
// que estilizar, así que no consume tokens de diseño (`styles/tokens.css` aplica a UI/TSX).
// =====================================================================================

import { NextResponse } from 'next/server';

import { rpcService, MarketplaceRpcError } from '../../../../lib/supabase-server';
import { verifyWebhookSignature, StripeGatewayError } from '../../../../lib/stripe';

// Webhook: verifica firma HMAC sobre el RAW body + usa service_role + crea dominio ⇒ jamás
// cachear y ejecutar en Node (el runtime Edge no garantiza el body crudo intacto para la firma).
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/** Único tipo de evento que crea/confirma cita (MARKETPLACE.md §787, §798). */
const HANDLED_EVENT_TYPE = 'checkout.session.completed' as const;

// -------------------------------------------------------------------------------------
// Salida de la RPC `handle_stripe_checkout_completed` (MARKETPLACE.md §849-850).
// -------------------------------------------------------------------------------------

/**
 * `{ ok: true, processed: true }` cuando el evento creó (o resolvió) el dominio;
 * `{ ok: true, processed: false, reason: "already_processed" }` en el no-op idempotente.
 * `requires_support` también retorna `ok: true` (la RPC ya persistió `needs_support`): el
 * pago se recibió y el caso quedó grabado para soporte, no es un error a reintentar.
 */
interface WebhookRpcResult {
  ok: true;
  processed: boolean;
  reason?: 'already_processed' | 'requires_support' | string;
}

// -------------------------------------------------------------------------------------
// POST /api/stripe/webhook  (ruta de contrato: POST /webhooks/stripe)
// -------------------------------------------------------------------------------------

export async function POST(req: Request): Promise<NextResponse> {
  // 1) RAW body ANTES de cualquier parseo (MARKETPLACE.md §797). `req.text()` devuelve el
  //    cuerpo tal como llegó; NUNCA `req.json()` aquí: reserializar invalidaría la firma HMAC.
  let rawBody: string;
  try {
    rawBody = await req.text();
  } catch {
    // No poder leer el cuerpo es transitorio/infra ⇒ 500 para que Stripe reintente.
    return ack('read_body_failed', false, 500);
  }

  const signature = req.headers.get('stripe-signature');

  // 2) Verificar la firma sobre el RAW body. Esto es lo ÚNICO que autentica el webhook: sin
  //    firma válida no ejecutamos dominio (posible atacante o payload manipulado) ⇒ 400.
  //    (La reconstrucción del evento la hace lib/stripe con el signing secret server-only.)
  let event: { id: string; type: string; created: number };
  try {
    const verified = verifyWebhookSignature(rawBody, signature);
    event = { id: verified.id, type: verified.type, created: verified.created };
  } catch (e) {
    if (e instanceof StripeGatewayError && e.code === 'INVALID_STRIPE_SIGNATURE') {
      // Evento NO autenticado ⇒ 400, sin tocar la base. No es un reintento útil.
      return ack('invalid_signature', false, 400);
    }
    // STRIPE_CONFIG_MISSING (falta el signing secret): es config, transitorio una vez corregido
    // ⇒ 500 para que Stripe reintente y no perdamos el evento cuando el secreto esté presente.
    return ack('config_missing', false, 500);
  }

  // 3) Filtrar el tipo de evento. Solo `checkout.session.completed` crea cita (§798,
  //    UNSUPPORTED_STRIPE_EVENT). Cualquier otro tipo se ACKea 2xx (ignorado) para que Stripe
  //    deje de enviarlo; no es un error ni algo que reintentar.
  if (event.type !== HANDLED_EVENT_TYPE) {
    return ack('ignored', false, 200, { ignored: true, type: event.type });
  }

  // 4) Delegar a la RPC idempotente y transaccional. Le pasamos el evento YA VERIFICADO:
  //      · event_id     → clave de idempotencia + fila en `stripe_webhook_events` (§805).
  //      · type/payload → la RPC re-lee el objeto Session del payload para validar
  //                       status/payment_status/mode/currency/amount_total/PaymentIntent
  //                       contra el SNAPSHOT del hold (§799-803). NO confiamos en el cliente.
  //      · event_created→ necesario para la "regla de hold resoluble" (§810-811:
  //                       resoluble solo si `event.created <= slot_holds.expires_at`).
  //    La firma NO se re-verifica dentro de Postgres (ya se verificó en Node, antes del lock,
  //    MARKETPLACE.md §806-807: jamás HTTP/verificación de firma bajo el `agenda_lock`).
  let result: WebhookRpcResult;
  try {
    result = await rpcService<WebhookRpcResult>('handle_stripe_checkout_completed', {
      event_id: event.id,
      type: event.type,
      event_created: event.created,
      // El payload viaja como JSON crudo verificado; la RPC lo persiste tal cual en
      // `stripe_webhook_events.payload (jsonb)` y extrae de ahí la Session (§184-189).
      payload: JSON.parse(rawBody),
    });
  } catch (e) {
    return mapError(e);
  }

  // 5) Éxito (procesado, no-op idempotente o requires_support persistido): 2xx. El evento quedó
  //    resuelto de forma definitiva; Stripe no debe reintentar.
  return ack(result.reason ?? (result.processed ? 'processed' : 'no_op'), result.processed, 200);
}

// -------------------------------------------------------------------------------------
// Mapeo de errores de la RPC → HTTP, con criterio money-safe (2xx = no reintentar,
// 5xx = reintentar). Códigos: MARKETPLACE.md §852-855.
// -------------------------------------------------------------------------------------

function mapError(e: unknown): NextResponse {
  if (e instanceof MarketplaceRpcError) {
    switch (e.code) {
      // Evento AUTENTICADO pero permanentemente no procesable o ya resuelto por la RPC. En
      // todos estos casos reintentar NO cambia el desenlace (o el dinero ya se cobró y el caso
      // quedó en `needs_support`) ⇒ 2xx para que Stripe DEJE de reintentar.
      case 'UNSUPPORTED_STRIPE_EVENT':
        return ack('ignored', false, 200, { ignored: true });
      case 'REQUIRES_SUPPORT':
      case 'HOLD_NOT_RESOLVABLE':
      case 'SLOT_UNAVAILABLE':
        // Casos borde §302-308: pago recibido pero cita no creable (ya-paciente / slot en
        // conflicto / hold no resoluble). La RPC ya persistió `needs_support`; a soporte, no a
        // un bucle de reintentos.
        return ack('requires_support', false, 200);
      case 'HOLD_NOT_FOUND':
      case 'CHECKOUT_SESSION_INVALID':
      case 'PAYMENT_NOT_PAID':
      case 'INVALID_AMOUNT':
      case 'INVALID_CURRENCY':
      case 'PAYMENT_INTENT_MISSING':
        // Evento firmado que no cuadra con un checkout de marketplace válido/pagado. La RPC lo
        // dejó registrado (idempotencia por event_id); reintentar no lo volverá válido ⇒ 2xx
        // para no entrar en bucle. (No es 400: el evento SÍ venía firmado por Stripe.)
        return ack('unprocessable', false, 200, { code: e.code });
      case 'INVALID_STRIPE_SIGNATURE':
        // Defensa en profundidad si la RPC re-verificara: evento no autenticado ⇒ 400.
        return ack('invalid_signature', false, 400);
      default:
        // Código desconocido ⇒ tratamos como transitorio para no perder el evento: 500 (Stripe
        // reintenta). Preferimos un reintento de más que descartar un cobro sin conciliar.
        return ack('rpc_error', false, 500);
    }
  }
  if (e instanceof StripeGatewayError) {
    // Config ausente u otra falla de riel al procesar ⇒ transitorio ⇒ 500 (reintentar).
    return ack('gateway_error', false, 500);
  }
  // Excepción no tipada (red/infra/DB) ⇒ 500 para que Stripe reintente.
  return ack('unexpected_error', false, 500);
}

// -------------------------------------------------------------------------------------
// ACK homogéneo: a Stripe solo le importa el status. Body mínimo, sin filtrar internos de la
// DB ni datos clínicos/de pago (Invariante 6). Siempre no-cacheable.
// -------------------------------------------------------------------------------------

function ack(
  status: string,
  processed: boolean,
  httpStatus: number,
  extra?: Record<string, unknown>,
): NextResponse {
  return NextResponse.json(
    { received: true, processed, status, ...(extra ?? {}) },
    { status: httpStatus, headers: { 'cache-control': 'no-store' } },
  );
}
