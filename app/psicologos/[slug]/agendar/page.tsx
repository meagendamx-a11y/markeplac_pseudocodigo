// =====================================================================================
// app/psicologos/[slug]/agendar/page.tsx
// Marketplace — Identificación + verificación de WhatsApp (pasos 2 y 3 de 4).
// Next.js App Router, SSR. Server Component orquestador.
//
// Contrato (dos páginas del spec fusionadas en esta ruta):
//   - paginas/marketplace-tus-datos.md          (paso 2): captura nombre/apellidos/WhatsApp
//        y AQUÍ SÍ se crea el hold (create_or_replace_marketplace_slot_hold).
//   - paginas/marketplace-verificar-whatsapp.md  (paso 3): OTP por WhatsApp (Twilio Verify)
//        antes de pagar (start/verify_marketplace_phone_verification/_otp).
//   + MARKETPLACE.md § create_or_replace_marketplace_slot_hold (~L629),
//        § start_marketplace_phone_verification (~L672), § verify_marketplace_phone_otp (~L706),
//        § create_marketplace_checkout_from_hold (~L742), § cookie (~L199).
//
// Responsabilidad de ESTE archivo (y SOLO esto): Server Component que
//   1. valida el `starts_at` recibido por la URL desde el selector (paso 1);
//   2. lee —server-side— la cookie firmada de booking para (a) prellenar nombre/apellidos
//      (NO autoritativo) y (b) detectar estados que se resuelven antes de renderizar el
//      formulario: ya-bloqueado (EXISTING_PATIENT → WhatsApp) y checkout ya iniciado (resume);
//   3. consulta —con la ANON key (lectura pública)— el resumen del profesional/servicio para
//      pintar la tarjeta "Tu sesión" (nombre, "Jue 16 jul · 17:00–17:50 · En línea", precio);
//   4. delega TODA la interacción (formulario → /api/hold → /api/otp/start → <OtpForm> →
//      /api/otp/verify → /api/checkout) al Client Component <AgendarFlow>, que compone <OtpForm>.
//
//   Esta página NO crea el hold, NO envía/valida OTP, NO crea checkout ni cita: solo lee lo
//   público, lee la cookie para ramificar, y monta el flujo cliente. Toda mutación pasa por
//   Route Handlers propios (service_role server-only), nunca por Supabase/Stripe desde el navegador.
//
// INVARIANTES DE SEGURIDAD DUROS (MARKETPLACE.md) que aplican aquí:
//   - service_role JAMÁS en el navegador: esta página solo usa `rpcPublic` (anon) para la
//     lectura del resumen. El hold/OTP/checkout viven en /api/* (server-only) que el cliente
//     invoca; el browser nunca habla con Supabase/Stripe directo para operaciones privilegiadas.
//   - Cookie firmada Secure/HttpOnly/SameSite=Lax puesta por el SERVIDOR (lib/session-cookie).
//     Se lee aquí server-side; jamás localStorage. Nada autoritativo en la cookie: el estado
//     real (hold/pago) se re-resuelve en la base con marketplace_session_id + active_hold_id.
//   - El teléfono NO verificado NUNCA se persiste (ni en cookie ni en DB): por eso el flujo
//     identificación→OTP es UN Client Component (<AgendarFlow>) que mantiene el teléfono solo
//     en memoria hasta que verify_marketplace_phone_otp lo escribe en slot_holds.patient_phone
//     y en cookie.verified_phone (marketplace-tus-datos §"No debe" / verificar-whatsapp §"No debe").
//   - La URL de éxito de Stripe NO confirma la cita: /api/checkout solo devuelve la URL de
//     Stripe para redirigir; la confirmación (webhook firmado + polling en /resultado) es de
//     otra pantalla. Aquí no se crea ni afirma cita/pago.
//   - Hacia el backend solo viaja lo mínimo ({slug} por ruta, {starts_at} por URL, nombres y
//     phone por el body de /api/*). El backend NO confía en professional_id/service_id/precio/
//     tz/ends_at del frontend (MARKETPLACE.md §634): re-resuelve todo por slug bajo lock.
//
// SEO: paso privado del booking ⇒ `robots: noindex` (layout §metadata deja indexable solo
// directorio/perfil público).
// =====================================================================================

import Link from 'next/link';

import { rpcPublic, MarketplaceRpcError } from '../../../../lib/supabase-server';
import { getBookingSession } from '../../../../lib/session-cookie';
import { AgendarFlow } from '../../../../components/AgendarFlow';

// Estado en vivo (holds/citas y la propia cookie cambian minuto a minuto) ⇒ nunca cachear.
export const dynamic = 'force-dynamic';

// -------------------------------------------------------------------------------------
// Tipos — espejo EXACTO del allowlist público del contrato (mismos que el paso 1). Ni un
// campo privado más: precio/duración/tz SIEMPRE salen del RPC, nunca del frontend.
// -------------------------------------------------------------------------------------

/** Servicio del marketplace (siempre `online`). Precio/duración vienen SIEMPRE del RPC. */
interface MarketplaceServiceMeta {
  display_name: string; // "Cita individual" (etiqueta orientada al paciente)
  price_mxn: number;
  duration_minutes: number;
  modality: 'online'; // marketplace online-only (MARKETPLACE.md § disponibilidad)
}

/** Estado de agenda del perfil (gate del flujo de reserva). */
interface ProfileBooking {
  timezone: string; // IANA, tz del profesional (p. ej. "America/Mexico_City")
  scheduling_enabled: boolean;
  is_bookable: boolean; // scheduling_enabled AND hay disponibilidad futura
}

/** Subconjunto de `get_marketplace_profile` que ESTA pantalla necesita para el resumen. */
interface ProfileSummary {
  slug: string;
  display_name: string;
  photo_url: string | null;
  is_verified: boolean;
  marketplace_service: MarketplaceServiceMeta;
  booking: ProfileBooking;
}

// -------------------------------------------------------------------------------------
// Contrato de red del cliente (Route Handlers propios, service_role server-only). Estos
// paths son los que <AgendarFlow>/<OtpForm> invocan; cada uno re-resuelve profesional +
// hold desde la cookie (marketplace_session_id + active_hold_id), NO desde el body del
// cliente. Se documentan aquí porque esta página es la que los cablea (rol Orchestrator).
//
//   POST /api/hold        { starts_at, first_name, last_name }  (slug por la ruta de origen)
//       → { hold: { id, starts_at, ends_at, expires_at, status } }               [200]
//       · SLOT_UNAVAILABLE / INVALID_SLOT_STEP / SLOT_TOO_SOON → volver al selector [409/422]
//       · CHECKOUT_ALREADY_STARTED { next_action: continue_checkout }             [409]
//       · HOLD_LIMIT_REACHED                                                       [429]
//     (el Route Handler llama create_or_replace_marketplace_slot_hold y setBookingSession:
//      escribe active_hold_id/professional_id/expires_at en la cookie firmada.)
//
//   POST /api/otp/start   { phone }                (hold_id se toma de la cookie, no del body)
//       → { verification_required: true, phone_masked, hold_expires_at }          [200]
//       → { verification_required: false, next_action: create_checkout }          [200] (ya vigente)
//       · OTP_RATE_LIMITED [429] · HOLD_EXPIRED [409] · INVALID_PHONE [422]
//     (llama start_marketplace_phone_verification; el teléfono NO se guarda en cookie aquí.)
//
//   POST /api/otp/verify  { otp_code }             (hold_id/phone/slug se re-resuelven server-side)
//       → { verified: true, marketplace_allowed: true, next_action: create_checkout } [200]
//       → { verified: true, marketplace_allowed: false,
//           reason: MARKETPLACE_BLOCKED_EXISTING_PATIENT, next_action: continue_whatsapp } [200]
//       · INVALID_OTP / OTP_EXPIRED_OR_NOT_FOUND / OTP_MAX_ATTEMPTS_REACHED       [401/422]
//       · HOLD_EXPIRED [409]
//     (llama verify_marketplace_phone_otp: escribe slot_holds.patient_phone + cookie.verified_phone.)
//
//   POST /api/checkout    { }                      (hold_id se toma de la cookie)
//       → { url }  (URL de Stripe Checkout — redirigir con window.location.assign)  [200]
//       · MARKETPLACE_BLOCKED_EXISTING_PATIENT [409] · HOLD_EXPIRED [409] · STRIPE_CHECKOUT_FAILED [502]
//     (llama create_marketplace_checkout_from_hold; NO crea cita/pago — eso es del webhook.)
// -------------------------------------------------------------------------------------

/** Paths de los Route Handlers propios (server-only). Fijos por el enunciado del flujo. */
const ENDPOINTS = {
  hold: '/api/hold',
  otpStart: '/api/otp/start',
  otpVerify: '/api/otp/verify',
  checkout: '/api/checkout',
} as const;

/** TTL del hold: 30 min (MARKETPLACE.md §629, paso 4). Alimenta el chip "Apartado por MM:SS". */
const HOLD_TTL_SECONDS = 30 * 60;

// -------------------------------------------------------------------------------------
// Página. `params` y `searchParams` (Next 15) llegan como Promise. `slug` identifica al
// profesional; `starts_at` (ISO UTC) viene del selector (paso 1) por la URL.
// -------------------------------------------------------------------------------------

export default async function AgendarIdentificacionPage({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string }>;
  searchParams: Promise<{ starts_at?: string }>;
}) {
  const { slug } = await params;
  const { starts_at: startsAtParam } = await searchParams;

  const selectorHref = `/psicologos/${slug}/agendar/dias`; // volver a "Selecciona horario"

  // --- 0) `starts_at` obligatorio y bien formado. Sin slot no hay nada que apartar. El
  //     backend revalida step-30/lead/disponibilidad bajo lock; aquí solo un guard de forma
  //     para no montar el flujo con una URL rota (marketplace-tus-datos §Jerarquía.2). ---
  const startsAt = normalizeStartsAt(startsAtParam);
  if (!startsAt) {
    return (
      <Shell slug={slug}>
        <StateCard
          title="Elige un horario para continuar"
          body="Necesitamos que selecciones un día y una hora antes de capturar tus datos."
          ctaHref={selectorHref}
          ctaLabel="Elegir horario"
        />
      </Shell>
    );
  }

  // --- 1) Cookie de booking (server-side). NO autoritativa: solo prellena y ramifica. El
  //     estado real del hold/pago se re-resuelve en la base en cada Route Handler. ---
  const session = await getBookingSession();

  // Estado "Ya eres paciente" resuelto ANTES de renderizar el formulario: si un verify previo
  // dejó blocked_reason en la cookie, no reabrimos el flujo de pago; mandamos a WhatsApp
  // (verificar-whatsapp §Estados "Ya es paciente"). No revelamos con qué profesional.
  const isBlockedExistingPatient =
    !!session?.blocked_reason && session.blocked_reason.includes('EXISTING_PATIENT');

  // --- 2) Resumen del profesional (ANON key). Fija identidad + service (precio/duración) + tz.
  //     Un fallo aquí NO debe filtrar detalle interno: se degrada a "no disponible". ---
  let profile: ProfileSummary | null = null;
  try {
    profile = await rpcPublic<ProfileSummary>('get_marketplace_profile', { slug });
  } catch (err) {
    if (!(err instanceof MarketplaceRpcError || err instanceof Error)) throw err;
    profile = null;
  }

  const notBookable = !profile || !profile.booking.is_bookable;
  if (notBookable) {
    return (
      <Shell slug={slug}>
        <StateCard
          title="Este profesional ya no está disponible"
          body="Explora otros psicólogos verificados para agendar tu sesión."
          ctaHref="/psicologos"
          ctaLabel="Ver profesionales"
        />
      </Shell>
    );
  }

  // A partir de aquí `profile` es no-null.
  const p = profile as ProfileSummary;
  const service = p.marketplace_service;

  return (
    <Shell slug={slug} backHref={selectorHref} backLabel="Volver a elegir horario">
      <div style={{ maxWidth: 560, margin: '0 auto', padding: 'var(--s20) var(--s16) var(--s32)' }}>
        {/* Tarjeta "Tu sesión": informativa (neutra, sin morado — no es la acción principal).
            Foto · nombre · ✔ · "Cita individual · Jue 16 jul · 17:00–17:50 · En línea · $precio".
            Todo del RPC público (verificar/tus-datos §Jerarquía.2). */}
        <section
          className="card"
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 'var(--s12)',
            padding: 'var(--s16)',
            marginBottom: 'var(--s20)',
          }}
        >
          {p.photo_url ? (
            // eslint-disable-next-line @next/next/no-img-element -- avatar remoto (Storage público)
            <img
              src={p.photo_url}
              alt=""
              width={48}
              height={48}
              style={{
                width: 48,
                height: 48,
                borderRadius: 'var(--radius-round)',
                objectFit: 'cover',
                flexShrink: 0,
              }}
            />
          ) : (
            <span
              aria-hidden="true"
              style={{
                width: 48,
                height: 48,
                borderRadius: 'var(--radius-round)',
                background: 'var(--purple-100)', // tint de marca, NUNCA como texto/CTA (§1,§8)
                flexShrink: 0,
              }}
            />
          )}
          <div style={{ minWidth: 0 }}>
            <p
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 'var(--s4)',
                fontFamily: 'var(--font-display)',
                fontWeight: 600,
                fontSize: 15,
                color: 'var(--ink-900)',
                margin: '0 0 2px',
              }}
            >
              {p.display_name}
              {p.is_verified && (
                <span
                  title="Profesional validado"
                  aria-label="Profesional validado"
                  style={{ color: 'var(--success-600)', fontSize: 14, lineHeight: 1 }}
                >
                  ✔
                </span>
              )}
            </p>
            <p className="num" style={{ color: 'var(--ink-500)', fontSize: 13, margin: 0 }}>
              {service.display_name} · {formatSlotRange(startsAt, service.duration_minutes, p.booking.timezone)}
            </p>
            <p className="num" style={{ color: 'var(--ink-500)', fontSize: 13, margin: '2px 0 0' }}>
              En línea · {service.duration_minutes} min · {formatPriceMXN(service.price_mxn)}
            </p>
          </div>
        </section>

        {isBlockedExistingPatient ? (
          // Estado "Ya eres paciente" (resuelto server-side por la cookie): sin pago aquí, se
          // continúa por WhatsApp con el profesional (verificar-whatsapp §Navegación).
          <StateCard
            variant="inline"
            title="Ya eres paciente de este profesional"
            body="Para agendar una sesión de seguimiento, continúa tu conversación por WhatsApp con el profesional."
            ctaHref={`/psicologos/${slug}/continuar-por-whatsapp`}
            ctaLabel="Continuar por WhatsApp"
          />
        ) : (
          // Flujo interactivo (identificación → hold → OTP → checkout). Client Component que
          // compone <OtpForm>. Recibe SOLO datos de presentación y los paths de los Route
          // Handlers; el teléfono sin verificar vive únicamente en su estado en memoria.
          <AgendarFlow
            slug={slug}
            startsAt={startsAt}
            // Prellenado NO autoritativo desde la cookie (marketplace-tus-datos §Jerarquía.3).
            prefill={{
              firstName: session?.first_name ?? null,
              lastName: session?.last_name ?? null,
            }}
            // Reanudación: si ya existe un checkout iniciado para este flujo, /api/hold
            // devolverá CHECKOUT_ALREADY_STARTED y el flujo ofrecerá continuarlo. Señal previa
            // por si la cookie ya trae hold activo (no autoritativo, solo mejora UX de arranque).
            hasActiveHold={!!session?.active_hold_id}
            endpoints={ENDPOINTS}
            holdTtlSeconds={HOLD_TTL_SECONDS}
            // Destinos de salida por estado (verificar/tus-datos §Estados):
            selectorHref={selectorHref} // SLOT_UNAVAILABLE / HOLD_EXPIRED → volver a elegir
            // MARKETPLACE_BLOCKED_EXISTING_PATIENT (en verify) → handoff a WhatsApp. Es un
            // Route de servidor que resuelve el número del profesional y redirige; el número
            // NUNCA se expone en el cliente (MARKETPLACE.md § cookie, PII fuera del browser).
            whatsappHandoffHref={`/psicologos/${slug}/continuar-por-whatsapp`}
          />
        )}

        {/* Aviso de hold (tus-datos §Jerarquía.4). El contador en vivo "Apartado por MM:SS"
            lo pinta <AgendarFlow> una vez creado el hold; este texto es el estado previo. */}
        {!isBlockedExistingPatient && (
          <p style={{ color: 'var(--ink-500)', fontSize: 13, textAlign: 'center', margin: 'var(--s16) 0 0' }}>
            Al continuar, apartaremos este horario durante 30 minutos mientras verificas tu número y completas el pago.
          </p>
        )}
      </div>
    </Shell>
  );
}

// -------------------------------------------------------------------------------------
// Shell — app bar (← + marca) + <main>. La barra de pasos "Paso 2/3 de 4" depende del paso
// interactivo, así que la renderiza <AgendarFlow> (cliente); aquí solo el chrome estático.
// -------------------------------------------------------------------------------------

function Shell({
  slug,
  backHref,
  backLabel,
  children,
}: {
  slug: string;
  backHref?: string;
  backLabel?: string;
  children: React.ReactNode;
}) {
  return (
    <main style={{ minHeight: '100vh' }}>
      <header
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 'var(--s12)',
          padding: 'var(--s16) var(--s20)',
          borderBottom: '1px solid var(--border)',
          background: 'var(--surface)',
          position: 'sticky',
          top: 0,
          zIndex: 1,
        }}
      >
        <Link
          href={backHref ?? `/psicologos/${slug}`}
          aria-label={backLabel ?? 'Volver'}
          className="btn-secondary"
          style={{ textDecoration: 'none', width: 'var(--min-touch)', minWidth: 'var(--min-touch)', padding: 0 }}
        >
          <span aria-hidden="true">←</span>
        </Link>
        <h1
          style={{
            fontFamily: 'var(--font-display)',
            fontWeight: 700,
            fontSize: 18,
            color: 'var(--ink-900)',
            margin: 0,
          }}
        >
          Agenda tu sesión
        </h1>
      </header>
      {children}
    </main>
  );
}

// -------------------------------------------------------------------------------------
// StateCard — estados no-formulario (sin slot, perfil no disponible, ya-paciente). Un solo
// CTA morado por tarjeta (DISENO_UI §1: morado solo para la acción importante).
// -------------------------------------------------------------------------------------

function StateCard({
  title,
  body,
  ctaHref,
  ctaLabel,
  variant = 'page',
}: {
  title: string;
  body: string;
  ctaHref: string;
  ctaLabel: string;
  variant?: 'page' | 'inline';
}) {
  const content = (
    <section
      className="card"
      role="alert"
      style={{ padding: 'var(--s24)', textAlign: 'center', marginTop: variant === 'page' ? 'var(--s8)' : 0 }}
    >
      <p style={{ color: 'var(--ink-900)', fontWeight: 600, margin: '0 0 var(--s12)' }}>{title}</p>
      <p style={{ color: 'var(--ink-500)', fontSize: 14, margin: '0 0 var(--s16)' }}>{body}</p>
      <Link href={ctaHref} className="cta-primary" style={{ textDecoration: 'none' }}>
        {ctaLabel}
      </Link>
    </section>
  );

  if (variant === 'inline') return content;
  return <div style={{ maxWidth: 560, margin: '0 auto', padding: 'var(--s20) var(--s16) var(--s32)' }}>{content}</div>;
}

// -------------------------------------------------------------------------------------
// Utilidades de presentación (server-side). Textos UI en español (es-MX); identificadores
// en inglés (DISENO_UI §1). Formatos SIEMPRE en la tz del profesional para no desfasar el día.
// -------------------------------------------------------------------------------------

/** Valida y normaliza `starts_at` a ISO UTC. Devuelve null si falta o no es una fecha válida. */
function normalizeStartsAt(raw: string | undefined): string | null {
  if (!raw) return null;
  const t = Date.parse(raw);
  if (Number.isNaN(t)) return null;
  return new Date(t).toISOString();
}

/** "Jue 16 jul · 17:00–17:50" en la tz del profesional (inicio + duración = fin). */
function formatSlotRange(startIso: string, durationMinutes: number, timeZone: string): string {
  const start = new Date(startIso);
  const end = new Date(start.getTime() + durationMinutes * 60_000);

  const day = new Intl.DateTimeFormat('es-MX', {
    timeZone,
    weekday: 'short',
    day: 'numeric',
    month: 'short',
  }).format(start);

  const time = (d: Date) =>
    new Intl.DateTimeFormat('es-MX', { timeZone, hour: '2-digit', minute: '2-digit', hour12: false }).format(d);

  // Capitaliza el día ("jue 16 jul" → "Jue 16 jul") sin romper acentos.
  const dayLabel = day.charAt(0).toUpperCase() + day.slice(1);
  return `${dayLabel} · ${time(start)}–${time(end)}`;
}

/** Formatea MXN sin decimales (precios enteros del catálogo). */
function formatPriceMXN(amount: number): string {
  return new Intl.NumberFormat('es-MX', {
    style: 'currency',
    currency: 'MXN',
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  }).format(amount);
}

// -------------------------------------------------------------------------------------
// SEO: paso privado del booking ⇒ noindex (el layout deja indexable solo directorio/perfil).
// Título específico; sin datos de paciente/pago en la metadata.
// -------------------------------------------------------------------------------------

export const metadata = {
  title: 'Tus datos y verificación',
  robots: { index: false, follow: false },
};
