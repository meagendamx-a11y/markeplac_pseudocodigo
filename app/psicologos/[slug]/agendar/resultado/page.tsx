'use client';

// =====================================================================================
// app/psicologos/[slug]/agendar/resultado/page.tsx
// Marketplace — "Resultado de la reserva" (retorno de Stripe Checkout success/cancel).
// Next.js App Router. CLIENT COMPONENT: la responsabilidad central de esta pantalla es el
// POLLING, que es inherentemente de cliente.
//
// Contrato: paginas/marketplace-resultado.md (ruta, estados, jerarquía, visibilidad, "No debe")
//           + MARKETPLACE.md:
//             · § get_marketplace_booking_result (~L860): entrada {slug, stripe_checkout_session_id,
//               hold_id?, result_hint?}; localiza el hold por cookie `active_hold_id`; el estado
//               SALE DE DB (+ Stripe read-only solo si la DB aún no tiene resultado final);
//               salida { status, next_action, poll_after_seconds?, appointment?, professional,
//               service, payment?, checkout_url?, support_reference? }. NO trata `success` en la
//               URL como pago confirmado.
//             · § Máquina de estados del booking (~L272): checkout_open · checkout_cancelled ·
//               payment_processing · confirmed · checkout_expired · requires_support.
//             · § "Las 3 carreras que van a needs_support" (~L301): ya-paciente post-pago, slot
//               en conflicto (EXCLUDE) y pago sin fila modelable ⇒ aquí aterrizan como
//               `requires_support` con `support_reference` (NUNCA se ocultan).
//
// INVARIANTES DE SEGURIDAD DUROS (MARKETPLACE.md) que aplican aquí:
//   - La URL `success` de Stripe NO confirma la cita: SOLO el webhook firmado
//     (handle_stripe_checkout_completed) crea cita+pago. Esta pantalla NUNCA declara "reservado"
//     por haber vuelto con `success`; arranca SIEMPRE en estado de consulta y hace *polling*
//     sobre get_marketplace_booking_result hasta un estado terminal. NUNCA crea/duplica la cita
//     ni reintenta el cobro desde el cliente.
//   - El navegador habla con un Route Handler propio (GET /api/booking-result), no con Supabase.
//     Ese endpoint es server-only: lee la cookie firmada (Secure/HttpOnly/SameSite=Lax) para
//     localizar `active_hold_id`, usa el service_role SOLO en el servidor y llama al RPC. El
//     `service_role` JAMÁS entra a este bundle de cliente. La cookie es HttpOnly ⇒ este JS no la
//     lee (ni debe); el estado real se resuelve en DB con marketplace_session_id + active_hold_id.
//   - Sin datos clínicos ni de pago sensibles en el cliente: solo se pintan datos mínimos de la
//     cita (fecha/hora/profesional) cuando `confirmed` y un monto ya cobrado; nada de tarjetas,
//     PaymentIntent, ni PII más allá de lo que el RPC devuelve para el recibo.
//
// SEO: paso privado del flujo de booking ⇒ noindex. Al ser Client Component no puede exportar
// `metadata`; el noindex del subárbol /agendar lo fija su `layout.tsx` (robots index:false).
// =====================================================================================

import Link from 'next/link';
import { use, useCallback, useEffect, useRef, useState, type ReactNode } from 'react';

// -------------------------------------------------------------------------------------
// Tipos — espejo EXACTO de la salida pública de get_marketplace_booking_result
// (MARKETPLACE.md ~L883). Ni un campo autoritativo/clínico de más.
// -------------------------------------------------------------------------------------

/** Estados del resultado (MARKETPLACE.md § Estados del resultado de booking, ~L250). */
export type BookingResultStatus =
  | 'payment_processing' // Stripe pagó, webhook aún no termina ⇒ POLLING (NO reintentar pago)
  | 'confirmed' // cita + pago existen en DB ⇒ fin feliz
  | 'checkout_open' // Checkout creado, sin pagar ⇒ volver a Stripe
  | 'checkout_cancelled' // volvió sin pagar (no terminal) ⇒ reintentar si el hold sigue vivo
  | 'checkout_expired' // sesión de Stripe/hold venció sin pago ⇒ reiniciar reserva
  | 'requires_support'; // pago recibido pero no resoluble ⇒ soporte con support_reference

/** Detalle mínimo de la cita — SOLO se envía/pinta cuando `confirmed`. */
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
  display_name: string; // "Cita individual"
  duration_minutes: number;
  modality: 'online';
}

/** Recibo mínimo: monto ya cobrado. Sin tarjeta ni PaymentIntent (dato sensible fuera). */
export interface PaymentSummary {
  amount_mxn: number;
}

/** Salida completa de get_marketplace_booking_result (MARKETPLACE.md ~L883). */
export interface BookingResult {
  status: BookingResultStatus;
  next_action: string; // p.ej. continue_checkout | retry_checkout | restart | contact_support | done
  poll_after_seconds?: number; // presente/útil solo en payment_processing
  appointment?: AppointmentSummary; // solo en confirmed
  professional: ProfessionalSummary;
  service: ServiceSummary;
  payment?: PaymentSummary; // solo en confirmed
  checkout_url?: string; // reanudar/reintentar Stripe (checkout_open/cancelled con hold vivo)
  support_reference?: string; // solo en requires_support
}

/** Error tipado que puede devolver el Route Handler (taxonomía del contrato). */
interface BookingResultError {
  error: string; // INVALID_INPUT | BOOKING_SESSION_* | HOLD_NOT_FOUND | STRIPE_LOOKUP_FAILED | ...
}

// Fase de la máquina de POLLING de la propia pantalla (distinta del status del backend):
//   loading  → consulta inicial en curso (primer paint tras volver de Stripe)
//   polling  → hay un resultado no terminal (payment_processing); reconsultando en bucle
//   settled  → resultado terminal (confirmed/checkout_*/requires_support): se detiene
//   error    → fallo de red/HTTP al consultar; se ofrece "Reintentar" sin declarar nada
type Phase = 'loading' | 'polling' | 'settled' | 'error';

// -------------------------------------------------------------------------------------
// Constantes de polling. `poll_after_seconds` del backend manda; estos son solo topes/pisos
// de seguridad para no martillar el endpoint ni colgar el bucle indefinidamente.
// -------------------------------------------------------------------------------------

const DEFAULT_POLL_SECONDS = 3; // si el backend no sugiere cadencia
const MIN_POLL_SECONDS = 2; // piso: nunca por debajo (evita loop agresivo)
const MAX_POLL_ATTEMPTS = 40; // ~2 min a 3s: tras esto seguimos, pero avisamos que tarda

// El endpoint propio (server-only) que envuelve el RPC. El navegador NO habla con Supabase.
const BOOKING_RESULT_ENDPOINT = '/api/booking-result';

// -------------------------------------------------------------------------------------
// Página. En Next 15 `params`/`searchParams` llegan como Promises también en Client
// Components: se desenvuelven con `use()`. `slug` identifica al profesional; de la query de
// retorno de Stripe se leen `session_id` (stripe_checkout_session_id) y `result` (hint
// success|cancel). NINGUNO se trata como verdad: solo alimentan al RPC, que resuelve en DB.
// -------------------------------------------------------------------------------------

export default function ResultadoReservaPage({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string }>;
  searchParams: Promise<{ session_id?: string; result?: string }>;
}) {
  const { slug } = use(params);
  const { session_id: stripeSessionId, result: resultHint } = use(searchParams);

  const [phase, setPhase] = useState<Phase>('loading');
  const [result, setResult] = useState<BookingResult | null>(null);
  const [attempts, setAttempts] = useState(0);

  // Refs de control del bucle: evitan solapes y fugas al desmontar.
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const inFlightRef = useRef(false);
  const cancelledRef = useRef(false);

  // Una consulta al endpoint propio. Read-only: nunca crea cita/pago ni reintenta cobro.
  const fetchOnce = useCallback(async (): Promise<BookingResult> => {
    const qs = new URLSearchParams({ slug });
    // Se pasan como PISTAS al RPC (stripe_checkout_session_id + result_hint). El estado real lo
    // decide el backend leyendo DB (y Stripe read-only solo si la DB aún no concluyó); `success`
    // en la URL NO cuenta como confirmación (MARKETPLACE.md § invariante clave, ~L296).
    if (stripeSessionId) qs.set('session_id', stripeSessionId);
    if (resultHint) qs.set('result', resultHint);

    const res = await fetch(`${BOOKING_RESULT_ENDPOINT}?${qs.toString()}`, {
      method: 'GET',
      // Cookie firmada (HttpOnly) enviada automáticamente al ser mismo origen; el JS no la lee.
      credentials: 'same-origin',
      headers: { accept: 'application/json' },
      cache: 'no-store', // estado en vivo: jamás cachear
    });

    const body = (await res.json().catch(() => null)) as
      | BookingResult
      | BookingResultError
      | null;

    if (!res.ok || !body || 'error' in body) {
      // Errores de sesión/entrada/Stripe del contrato ⇒ se tratan como fallo de consulta
      // recuperable; NO se declara ningún estado del booking a partir de un error.
      throw new Error((body as BookingResultError | null)?.error ?? `HTTP_${res.status}`);
    }
    return body;
  }, [slug, stripeSessionId, resultHint]);

  // Bucle de polling: consulta, decide si el estado es terminal y agenda la siguiente vuelta.
  const poll = useCallback(async () => {
    if (inFlightRef.current || cancelledRef.current) return;
    inFlightRef.current = true;
    try {
      const next = await fetchOnce();
      if (cancelledRef.current) return;

      setResult(next);
      setAttempts((n) => n + 1);

      if (next.status === 'payment_processing') {
        // No terminal ⇒ seguimos consultando SIN reintentar el cobro (MARKETPLACE.md ~L291).
        setPhase('polling');
        const secs = Math.max(MIN_POLL_SECONDS, next.poll_after_seconds ?? DEFAULT_POLL_SECONDS);
        timerRef.current = setTimeout(() => void poll(), secs * 1000);
      } else {
        // confirmed / checkout_* / requires_support ⇒ estado terminal: detenemos el bucle.
        setPhase('settled');
      }
    } catch {
      if (cancelledRef.current) return;
      // Fallo de red/HTTP: mostramos "no pudimos consultar" con Reintentar; conservamos el
      // último `result` si lo había (no lo borramos: seguimos sin declarar nada nuevo).
      setPhase('error');
    } finally {
      inFlightRef.current = false;
    }
  }, [fetchOnce]);

  // Arranque + limpieza. Consulta inicial al montar; cancela timers/fetch al desmontar.
  useEffect(() => {
    cancelledRef.current = false;
    void poll();
    return () => {
      cancelledRef.current = true;
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, [poll]);

  // Reintento manual: reanuda el bucle desde donde quedó (no reinicia el flujo ni el pago).
  const retry = useCallback(() => {
    if (timerRef.current) clearTimeout(timerRef.current);
    setPhase(result?.status === 'payment_processing' ? 'polling' : 'loading');
    void poll();
  }, [poll, result]);

  return (
    <main style={{ minHeight: '100vh' }}>
      {/* App bar mínima: título de la pantalla. Sin ← : no hay "atrás" seguro desde el retorno
          de pago (podría reenviar a Stripe). La navegación se ofrece como CTA contextual. */}
      <header
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 'var(--s12)',
          padding: 'var(--s16) var(--s20)',
          borderBottom: '1px solid var(--border)',
          background: 'var(--surface)',
        }}
      >
        <h1
          style={{
            fontFamily: 'var(--font-display)',
            fontWeight: 700,
            fontSize: 18,
            color: 'var(--ink-900)',
            margin: 0,
          }}
        >
          Tu reserva
        </h1>
      </header>

      <div style={{ maxWidth: 520, margin: '0 auto', padding: 'var(--s24) var(--s16) var(--s32)' }}>
        <ResultBody
          phase={phase}
          result={result}
          attempts={attempts}
          slug={slug}
          onRetry={retry}
        />
      </div>
    </main>
  );
}

// -------------------------------------------------------------------------------------
// Cuerpo por estado (jerarquía del contrato: 1. estado grande · 2. detalle si confirmed ·
// 3. mensaje de canal WhatsApp · 4. CTA contextual único).
// -------------------------------------------------------------------------------------

function ResultBody({
  phase,
  result,
  attempts,
  slug,
  onRetry,
}: {
  phase: Phase;
  result: BookingResult | null;
  attempts: number;
  slug: string;
  onRetry: () => void;
}) {
  // --- Consulta inicial en curso, aún sin datos ⇒ spinner neutro. Nunca "reservado". ---
  if (phase === 'loading' && !result) {
    return (
      <StateCard
        tone="processing"
        icon={<Spinner />}
        title="Consultando tu reserva…"
        message="Estamos verificando el estado de tu pago. No cierres esta página."
      />
    );
  }

  // --- Error de red/HTTP al consultar (marketplace-resultado §Estados "Error de red"). ---
  if (phase === 'error') {
    return (
      <StateCard
        tone="danger"
        icon={<GlyphAlert />}
        title="No pudimos consultar el estado"
        message="Revisa tu conexión. Tu pago no se pierde: podemos volver a consultar."
        primary={
          <button type="button" className="cta-primary" onClick={onRetry}>
            Reintentar
          </button>
        }
      />
    );
  }

  // A partir de aquí hay `result`. `phase==='polling'` implica payment_processing en curso.
  if (!result) {
    // Guarda defensiva (no debería ocurrir): trata como consulta en curso.
    return (
      <StateCard
        tone="processing"
        icon={<Spinner />}
        title="Consultando tu reserva…"
        message="Estamos verificando el estado de tu pago."
      />
    );
  }

  switch (result.status) {
    // --- payment_processing: Stripe cobró, el webhook aún no termina. POLLING activo. ---
    // NO se declara confirmado; NO se reintenta el cobro (MARKETPLACE.md ~L291).
    case 'payment_processing':
      return (
        <StateCard
          tone="processing"
          icon={<Spinner />}
          title="Estamos confirmando tu pago…"
          message="Recibimos tu pago y estamos asegurando tu cita. Esto suele tardar unos segundos; no cierres ni recargues."
          footer={<WhatsAppNote />}
          note={
            attempts >= MAX_POLL_ATTEMPTS
              ? 'Está tardando más de lo normal. Seguimos verificando automáticamente.'
              : undefined
          }
        />
      );

    // --- confirmed: cita + pago existen en DB. Fin feliz + detalle + canal WhatsApp. ---
    case 'confirmed':
      return (
        <StateCard
          tone="success"
          icon={<GlyphCheck />}
          title="¡Cita confirmada!"
          message="Tu sesión quedó agendada."
          detail={<AppointmentDetail result={result} />}
          footer={<WhatsAppNote confirmed />}
          primary={
            // CTA único: próximos pasos. (Ruta de "próximos pasos" por definir en el flujo;
            // se enlaza al perfil del profesional como destino seguro existente.)
            <Link
              href={`/psicologos/${slug}`}
              className="cta-primary"
              style={{ textDecoration: 'none' }}
            >
              Ver mis próximos pasos
            </Link>
          }
        />
      );

    // --- checkout_open / checkout_cancelled: no pagó (no terminal). Reintentar si hay hold. ---
    case 'checkout_open':
    case 'checkout_cancelled':
      return (
        <StateCard
          tone="warning"
          icon={<GlyphInfo />}
          title="No completaste el pago"
          message="Tu horario sigue apartado por unos minutos. Puedes retomar el pago para confirmar tu cita."
          primary={
            result.checkout_url ? (
              // Reanudar/Reintentar en Stripe. El cliente NO cobra: solo redirige a Checkout.
              <a
                href={result.checkout_url}
                className="cta-primary"
                style={{ textDecoration: 'none' }}
              >
                Reintentar pago
              </a>
            ) : (
              // Sin checkout_url (hold ya no vivo) ⇒ reiniciar reserva.
              <Link
                href={`/psicologos/${slug}/agendar/dias`}
                className="cta-primary"
                style={{ textDecoration: 'none' }}
              >
                Elegir otro horario
              </Link>
            )
          }
          secondary={
            <Link
              href={`/psicologos/${slug}/agendar/dias`}
              className="btn-secondary"
              style={{ textDecoration: 'none' }}
            >
              Cambiar horario
            </Link>
          }
        />
      );

    // --- checkout_expired: la sesión de Stripe o el hold venció sin pago ⇒ reiniciar. ---
    case 'checkout_expired':
      return (
        <StateCard
          tone="warning"
          icon={<GlyphClock />}
          title="Se venció la sesión de pago"
          message="Tu horario apartado expiró. Puedes iniciar de nuevo la reserva; los lugares se liberan para otras personas."
          primary={
            <Link
              href={`/psicologos/${slug}/agendar/dias`}
              className="cta-primary"
              style={{ textDecoration: 'none' }}
            >
              Reiniciar reserva
            </Link>
          }
        />
      );

    // --- requires_support: pago recibido pero no resoluble (las 3 carreras ~L301). NUNCA se
    // oculta; se muestra el support_reference para que el equipo lo levante. ---
    case 'requires_support':
      return (
        <StateCard
          tone="warning"
          icon={<GlyphSupport />}
          title="Recibimos tu pago; un asesor lo revisa"
          message="Tu pago quedó registrado, pero necesitamos revisar tu cita manualmente. Un asesor te contactará para confirmarla o reembolsarte."
          detail={
            result.support_reference ? (
              <SupportReference reference={result.support_reference} />
            ) : undefined
          }
          footer={<WhatsAppNote />}
          primary={
            <a
              href={supportHref(result.support_reference)}
              className="cta-primary"
              style={{ textDecoration: 'none' }}
            >
              Contactar soporte
            </a>
          }
        />
      );

    default:
      // Estado desconocido: no inventamos resultado. Ofrecemos reconsultar.
      return (
        <StateCard
          tone="processing"
          icon={<Spinner />}
          title="Consultando tu reserva…"
          message="Estamos verificando el estado de tu pago."
          primary={
            <button type="button" className="cta-primary" onClick={onRetry}>
              Actualizar estado
            </button>
          }
        />
      );
  }
}

// -------------------------------------------------------------------------------------
// Tarjeta de estado reutilizable. `tone` mapea a los semánticos de tokens.css (§2). El morado
// se reserva SOLO para el CTA (DISENO_UI §1): el ícono de estado usa el color semántico, no morado.
// -------------------------------------------------------------------------------------

type Tone = 'success' | 'processing' | 'warning' | 'danger';

function StateCard({
  tone,
  icon,
  title,
  message,
  note,
  detail,
  footer,
  primary,
  secondary,
}: {
  tone: Tone;
  icon: ReactNode;
  title: string;
  message: string;
  note?: string;
  detail?: ReactNode;
  footer?: ReactNode;
  primary?: ReactNode;
  secondary?: ReactNode;
}) {
  const ring = toneRing(tone);
  return (
    <section
      className="card"
      role="status"
      aria-live="polite"
      style={{ padding: 'var(--s24)', textAlign: 'center' }}
    >
      {/* 1. Estado grande: ícono en círculo tintado con el semántico + título. */}
      <span
        aria-hidden="true"
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          width: 64,
          height: 64,
          borderRadius: 'var(--radius-round)',
          background: ring.bg,
          color: ring.fg,
          marginBottom: 'var(--s16)',
        }}
      >
        {icon}
      </span>

      <h2
        style={{
          fontFamily: 'var(--font-display)',
          fontWeight: 700,
          fontSize: 22,
          color: 'var(--ink-900)',
          margin: '0 0 var(--s8)',
        }}
      >
        {title}
      </h2>
      <p style={{ color: 'var(--ink-500)', fontSize: 15, lineHeight: 1.5, margin: 0 }}>
        {message}
      </p>

      {note && (
        <p style={{ color: 'var(--ink-500)', fontSize: 13, margin: 'var(--s12) 0 0' }}>{note}</p>
      )}

      {/* 2. Detalle (solo confirmed / referencia de soporte). */}
      {detail && <div style={{ marginTop: 'var(--s20)' }}>{detail}</div>}

      {/* 3. Mensaje de canal (WhatsApp). */}
      {footer && <div style={{ marginTop: 'var(--s20)' }}>{footer}</div>}

      {/* 4. CTA contextual único (morado) + secundario neutro opcional. */}
      {(primary || secondary) && (
        <div
          style={{
            display: 'flex',
            flexDirection: 'column',
            gap: 'var(--s12)',
            marginTop: 'var(--s24)',
          }}
        >
          {primary}
          {secondary}
        </div>
      )}
    </section>
  );
}

/** Mapea el tono al par (fondo tint, color) de tokens.css. Nunca usa morado como estado. */
function toneRing(tone: Tone): { bg: string; fg: string } {
  switch (tone) {
    case 'success':
      return { bg: 'var(--success-100)', fg: 'var(--success-600)' };
    case 'warning':
      return { bg: 'var(--amber-100)', fg: 'var(--amber-600)' };
    case 'danger':
      return { bg: 'var(--danger-100)', fg: 'var(--danger-600)' };
    case 'processing':
    default:
      // "Procesando" usa el tint de marca como superficie (NO como texto/CTA — §1,§8).
      return { bg: 'var(--purple-100)', fg: 'var(--purple-700)' };
  }
}

// -------------------------------------------------------------------------------------
// Detalle de la cita — SOLO en confirmed. Datos mínimos (sin nada clínico/sensible).
// -------------------------------------------------------------------------------------

function AppointmentDetail({ result }: { result: BookingResult }) {
  const { appointment, professional, service, payment } = result;
  if (!appointment) return null;

  const when = formatAppointmentWhen(appointment.starts_at, appointment.timezone);

  return (
    <div
      style={{
        textAlign: 'left',
        border: '1px solid var(--border)',
        borderRadius: 'var(--radius-lg)',
        padding: 'var(--s16)',
        background: 'var(--purple-50)',
      }}
    >
      <DetailRow label="Profesional" value={professional.display_name} />
      <DetailRow label="Servicio" value={`${service.display_name} · En línea`} />
      <DetailRow label="Fecha" value={when.date} />
      <DetailRow label="Hora" value={`${when.time} (${when.tzLabel})`} />
      {payment && (
        <DetailRow label="Pagado" value={formatPriceMXN(payment.amount_mxn)} numeric last />
      )}
    </div>
  );
}

function DetailRow({
  label,
  value,
  numeric,
  last,
}: {
  label: string;
  value: string;
  numeric?: boolean;
  last?: boolean;
}) {
  return (
    <div
      style={{
        display: 'flex',
        justifyContent: 'space-between',
        gap: 'var(--s12)',
        padding: 'var(--s8) 0',
        borderBottom: last ? 'none' : '1px solid var(--border)',
      }}
    >
      <span style={{ color: 'var(--ink-500)', fontSize: 13 }}>{label}</span>
      <span
        className={numeric ? 'num' : undefined}
        style={{ color: 'var(--ink-900)', fontSize: 14, fontWeight: 600, textAlign: 'right' }}
      >
        {value}
      </span>
    </div>
  );
}

// -------------------------------------------------------------------------------------
// Referencia de soporte — SOLO en requires_support (visibilidad condicional del contrato).
// -------------------------------------------------------------------------------------

function SupportReference({ reference }: { reference: string }) {
  return (
    <div
      style={{
        border: '1px solid var(--amber-100)',
        background: 'var(--amber-100)',
        borderRadius: 'var(--radius-md)',
        padding: 'var(--s12) var(--s16)',
      }}
    >
      <p style={{ color: 'var(--amber-700)', fontSize: 13, margin: '0 0 2px' }}>
        Referencia de soporte
      </p>
      <p
        className="num"
        style={{ color: 'var(--ink-900)', fontSize: 15, fontWeight: 700, margin: 0 }}
      >
        {reference}
      </p>
    </div>
  );
}

// -------------------------------------------------------------------------------------
// Nota de canal: la confirmación/recordatorio llegan por WhatsApp
// (marketplace_booking_confirmed). Jerarquía §3.
// -------------------------------------------------------------------------------------

function WhatsAppNote({ confirmed }: { confirmed?: boolean }) {
  return (
    <p style={{ color: 'var(--ink-500)', fontSize: 13, lineHeight: 1.5, margin: 0 }}>
      {confirmed
        ? 'Te enviaremos la confirmación y los recordatorios por WhatsApp.'
        : 'Cuando quede lista, recibirás la confirmación por WhatsApp.'}
    </p>
  );
}

// -------------------------------------------------------------------------------------
// Utilidades de presentación (textos UI en es-MX; identificadores en inglés).
// -------------------------------------------------------------------------------------

/** Enlace de soporte con la referencia (canal real por definir; mailto como destino seguro). */
function supportHref(reference?: string): string {
  const subject = reference
    ? `Reserva marketplace — ref ${reference}`
    : 'Reserva marketplace';
  return `mailto:soporte@agendapsi.mx?subject=${encodeURIComponent(subject)}`;
}

/** MXN sin decimales (precios enteros del catálogo). */
function formatPriceMXN(amount: number): string {
  return new Intl.NumberFormat('es-MX', {
    style: 'currency',
    currency: 'MXN',
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  }).format(amount);
}

/**
 * Formatea el instante de la cita EN LA TZ DEL PROFESIONAL (autoritativa):
 *   - date: "Jueves 16 de julio de 2026"
 *   - time: "10:00"
 *   - tzLabel: etiqueta corta de zona ("CDMX"/"GMT-6")
 */
function formatAppointmentWhen(
  isoUtc: string,
  timeZone: string,
): { date: string; time: string; tzLabel: string } {
  const dt = new Date(isoUtc);

  const date = new Intl.DateTimeFormat('es-MX', {
    timeZone,
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  }).format(dt);

  const time = new Intl.DateTimeFormat('es-MX', {
    timeZone,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(dt);

  const tzParts = new Intl.DateTimeFormat('es-MX', {
    timeZone,
    timeZoneName: 'short',
  }).formatToParts(dt);
  const tzLabel = tzParts.find((p) => p.type === 'timeZoneName')?.value ?? timeZone;

  // Capitaliza la primera letra del día (es-MX lo devuelve en minúscula).
  const capital = date.charAt(0).toUpperCase() + date.slice(1);
  return { date: capital, time, tzLabel };
}

// -------------------------------------------------------------------------------------
// Íconos inline (SVG, currentColor). Sin dependencias externas ni imágenes remotas.
// -------------------------------------------------------------------------------------

function Spinner() {
  // Spinner accesible por color semántico (currentColor). Anima con CSS inline vía <style>.
  return (
    <>
      <style>{`@keyframes apspin { to { transform: rotate(360deg); } }`}</style>
      <svg
        width="28"
        height="28"
        viewBox="0 0 24 24"
        fill="none"
        style={{ animation: 'apspin 0.9s linear infinite' }}
      >
        <circle cx="12" cy="12" r="9" stroke="currentColor" strokeOpacity="0.25" strokeWidth="2.5" />
        <path d="M21 12a9 9 0 0 0-9-9" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" />
      </svg>
    </>
  );
}

function GlyphCheck() {
  return (
    <svg width="30" height="30" viewBox="0 0 24 24" fill="none">
      <path d="M20 6 9 17l-5-5" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function GlyphInfo() {
  return (
    <svg width="28" height="28" viewBox="0 0 24 24" fill="none">
      <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="2" />
      <path d="M12 11v5" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" />
      <circle cx="12" cy="7.5" r="1.2" fill="currentColor" />
    </svg>
  );
}

function GlyphClock() {
  return (
    <svg width="28" height="28" viewBox="0 0 24 24" fill="none">
      <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="2" />
      <path d="M12 7.5V12l3 2" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function GlyphAlert() {
  return (
    <svg width="28" height="28" viewBox="0 0 24 24" fill="none">
      <path d="M12 4 2.5 20h19L12 4Z" stroke="currentColor" strokeWidth="2" strokeLinejoin="round" />
      <path d="M12 10v4" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" />
      <circle cx="12" cy="17" r="1.2" fill="currentColor" />
    </svg>
  );
}

function GlyphSupport() {
  return (
    <svg width="28" height="28" viewBox="0 0 24 24" fill="none">
      <path
        d="M4 12a8 8 0 0 1 16 0v4a3 3 0 0 1-3 3h-2"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
      />
      <rect x="3" y="11" width="3.5" height="6" rx="1.5" stroke="currentColor" strokeWidth="2" />
      <rect x="17.5" y="11" width="3.5" height="6" rx="1.5" stroke="currentColor" strokeWidth="2" />
    </svg>
  );
}
