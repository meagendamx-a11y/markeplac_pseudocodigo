// =====================================================================================
// app/psicologos/[slug]/agendar/horarios/page.tsx
// Marketplace — "Selecciona tu horario", vista de HORARIOS del día (paso 1 de 4, sub-paso).
// Next.js App Router, SSR.
//
// Contrato: paginas/marketplace-seleccion-horario.md (ruta, estados, jerarquía, "No debe")
//           + MARKETPLACE.md:
//             · § get_marketplace_availability (~L589): horarios de un día (online-only),
//               slot_step=30, duración real = duration + buffer, resta holds vigentes/lead.
//             · § get_marketplace_profile (~L505): resumen público (foto/nombre/validado/
//               service/booking{timezone, scheduling_enabled, is_bookable}).
//             · § create_or_replace_marketplace_slot_hold (~L617): el hold se aparta
//               SIEMPRE server-side (POST /psicologos/:slug/agendar/hold), con cookie
//               firmada de entrada/salida; el frontend NO lo crea ni confía en precio/tz.
//
// Responsabilidad del archivo (y SOLO esto): Server Component que
//   1. resuelve `slug` (params) + `date` (searchParams);
//   2. si falta/es inválida la fecha ⇒ vuelve a la vista de días (única fuente del calendario);
//   3. con la ANON key (lectura pública) consulta el resumen del profesional
//      (`get_marketplace_profile`) y los horarios libres del día (`get_marketplace_availability`);
//   4. pinta app bar, tarjeta-resumen del profesional, encabezado del día ("Jueves 16 de
//      julio · Hora local …") y delega los chips + selección a <SlotPicker mode="hours" …>.
//
// Frontera de esta página respecto al hold (decisión del arnés): a diferencia del texto
// literal de marketplace-seleccion-horario §"No debe" (que ubica el hold en la pantalla de
// datos), este árbol de rutas mueve la creación del hold al momento de ELEGIR el horario para
// entrar a identificación. El invariante DURO se conserva intacto: el hold lo crea el SERVIDOR
// (Route Handler POST /psicologos/:slug/agendar/hold, que usa rpcService +
// create_or_replace_marketplace_slot_hold y fija la cookie firmada). El navegador SOLO hace
// POST {slug, starts_at} a ese endpoint; NUNCA habla con Supabase, NUNCA crea cita/pago (eso
// es exclusivo del webhook firmado) y NUNCA escribe la cookie. Un hold ≠ una cita: es una
// reserva temporal (30 min) revalidada bajo lock. Los nombres se capturan en el paso de datos,
// que refresca el MISMO hold (semántica create_or_replace).
//
// INVARIANTES DE SEGURIDAD (MARKETPLACE.md) que aplican aquí:
//   - Lecturas PÚBLICAS ⇒ ANON key vía `rpcPublic` (lib/supabase-server, server-only). El
//     service_role JAMÁS entra a este árbol de UI: esta pantalla no escribe nada.
//   - El backend re-resuelve profesional/servicio y NO confía en precio/duración/modalidad/tz
//     del frontend: lo que se pinta viene del RPC; hacia adelante solo viaja `{slug, starts_at}`
//     (ISO UTC). La disponibilidad se revalida bajo lock al crear el hold (SLOT_UNAVAILABLE).
//   - Sin datos clínicos ni de pago en el cliente. tz del PROFESIONAL es la autoritativa
//     (marketplace-seleccion-horario §Jerarquía.4); si el paciente está en otra, <SlotPicker>
//     añade la etiqueta (dato de cliente, no del servidor).
//
// SEO: paso privado del flujo de booking ⇒ `robots: noindex` (indexable solo directorio/perfil).
// =====================================================================================

import Link from 'next/link';
import { redirect } from 'next/navigation';

import { rpcPublic, MarketplaceRpcError } from '../../../../../lib/supabase-server';
import { SlotPicker } from '../../../../../components/SlotPicker';

// Disponibilidad en tiempo real (holds/citas cambian minuto a minuto) ⇒ nunca cachear.
export const dynamic = 'force-dynamic';

// -------------------------------------------------------------------------------------
// Tipos — espejo EXACTO del allowlist público de los contratos. Ni un campo privado más.
// -------------------------------------------------------------------------------------

/** Servicio del marketplace (siempre `online`). Precio/duración vienen SIEMPRE del RPC. */
export interface MarketplaceServiceMeta {
  display_name: string; // "Cita individual" (etiqueta orientada al paciente)
  price_mxn: number;
  duration_minutes: number;
  modality: 'online'; // el marketplace es online-only (MARKETPLACE.md §disponibilidad)
}

/**
 * Metadata del servicio que devuelve `get_marketplace_availability` (MARKETPLACE.md ~L610).
 * Superset informativo del resumen; `slot_step_minutes`/`buffer_after_minutes` explican el
 * mallado de los chips, pero NADA de esto es autoritativo: el backend lo re-deriva al hold.
 */
export interface AvailabilityServiceMeta extends MarketplaceServiceMeta {
  buffer_after_minutes: number;
  slot_step_minutes: number; // 30 (MARKETPLACE.md §Regla de slot)
}

/** Estado de agenda del perfil (gate del flujo de reserva). */
export interface ProfileBooking {
  timezone: string; // IANA, tz del profesional (p. ej. "America/Mexico_City")
  scheduling_enabled: boolean;
  is_bookable: boolean; // scheduling_enabled AND hay disponibilidad futura
}

/** Subconjunto de `get_marketplace_profile` que ESTA pantalla necesita para el resumen. */
export interface ProfileSummary {
  slug: string;
  display_name: string;
  photo_url: string | null;
  is_verified: boolean;
  marketplace_service: MarketplaceServiceMeta;
  booking: ProfileBooking;
}

/**
 * Un horario libre (salida de `get_marketplace_availability`, MARKETPLACE.md ~L610).
 * `starts_at`/`ends_at` en UTC (lo único que viaja hacia adelante); los `_local` son para
 * pintar en la tz del profesional sin recalcular en cliente.
 */
export interface AvailabilitySlot {
  starts_at: string; // ISO UTC — el ÚNICO identificador que se propaga al hold
  ends_at: string; // ISO UTC
  starts_at_local: string; // "HH:mm" (o ISO local) en tz del profesional
  ends_at_local: string;
}

/** Salida de `get_marketplace_availability`: horarios del día + metadata pública del servicio. */
export interface AvailabilityResult {
  slots: AvailabilitySlot[];
  service: AvailabilityServiceMeta;
}

// -------------------------------------------------------------------------------------
// Validación de la fecha recibida por querystring. La VERDAD la fija el RPC (INVALID_DATE,
// lead del paciente, ≥ today_local); aquí solo rechazamos formatos claramente inválidos para
// no disparar RPCs con basura y para poder volver al calendario con una URL limpia.
// -------------------------------------------------------------------------------------

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** `true` si `s` es "YYYY-MM-DD" y representa una fecha real (rechaza 2026-13-40, etc.). */
function isValidIsoDate(s: string | undefined): s is string {
  if (!s || !ISO_DATE.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

// -------------------------------------------------------------------------------------
// Página. En Next 15 `params` y `searchParams` llegan como Promises. `slug` identifica al
// profesional (el backend re-resuelve todo a partir de él); `date` selecciona el día.
// -------------------------------------------------------------------------------------

export default async function SeleccionHorarioHorariosPage({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string }>;
  searchParams: Promise<{ date?: string }>;
}) {
  const { slug } = await params;
  const { date } = await searchParams;

  // Sin fecha (o fecha corrupta) no hay horarios que mostrar: el calendario es la única fuente
  // de días. Volvemos a la vista de días en lugar de inventar un día (marketplace-seleccion-
  // horario §"Visibilidad condicional": horarios solo tras elegir fecha).
  if (!isValidIsoDate(date)) {
    redirect(`/psicologos/${slug}/agendar/dias`);
  }

  // --- 1) Resumen del profesional (ANON key). Fija identidad + service + tz + gate. ---
  //     En el servidor (no se "reusa" estado de cliente) para que el deep-link/recarga con
  //     ?date funcione y para que precio/duración salgan del RPC, no del frontend.
  let profile: ProfileSummary | null = null;
  try {
    profile = await rpcPublic<ProfileSummary>('get_marketplace_profile', { slug });
  } catch (err) {
    // MARKETPLACE_PROFILE_NOT_FOUND / MARKETPLACE_SERVICE_UNAVAILABLE / red ⇒ "no disponible".
    if (!(err instanceof MarketplaceRpcError || err instanceof Error)) throw err;
  }

  // Estado "Perfil no disponible": perfil inexistente, servicio caído o agenda no habilitada
  // (marketplace-seleccion-horario §Estados). No revelamos detalle interno del error.
  const notBookable = !profile || !profile.booking.is_bookable;

  return (
    <main style={{ minHeight: '100vh' }}>
      {/* 1. App bar: ← "Selecciona horario" (marketplace-seleccion-horario §Jerarquía.1).
          El ← vuelve a la vista de DÍAS (paso previo del mismo sub-flujo), no al perfil. */}
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
          href={`/psicologos/${slug}/agendar/dias`}
          aria-label="Volver a elegir día"
          className="btn-secondary"
          style={{
            textDecoration: 'none',
            width: 'var(--min-touch)',
            minWidth: 'var(--min-touch)',
            padding: 0,
          }}
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
          Selecciona horario
        </h1>
      </header>

      <div style={{ maxWidth: 560, margin: '0 auto', padding: 'var(--s20) var(--s16) var(--s32)' }}>
        {notBookable ? (
          // --- Estado "Perfil no disponible" (marketplace-seleccion-horario §Estados). ---
          <section
            className="card"
            role="alert"
            style={{ padding: 'var(--s24)', textAlign: 'center', marginTop: 'var(--s8)' }}
          >
            <p style={{ color: 'var(--ink-900)', fontWeight: 600, margin: '0 0 var(--s12)' }}>
              Este profesional ya no está disponible
            </p>
            <p style={{ color: 'var(--ink-500)', fontSize: 14, margin: '0 0 var(--s16)' }}>
              Explora otros psicólogos verificados para agendar tu sesión.
            </p>
            <Link href="/psicologos" className="cta-primary" style={{ textDecoration: 'none' }}>
              Ver profesionales
            </Link>
          </section>
        ) : (
          // profile es no-null aquí (notBookable cubre el null). Se afirma para el tipado.
          <BookableSlots slug={slug} date={date} profile={profile as ProfileSummary} />
        )}
      </div>
    </main>
  );
}

// -------------------------------------------------------------------------------------
// Contenido cuando el perfil ES agendable: resumen + encabezado del día + horarios (SlotPicker).
// Se separa para consultar horarios SOLO cuando tiene sentido (perfil OK).
// -------------------------------------------------------------------------------------

async function BookableSlots({
  slug,
  date,
  profile,
}: {
  slug: string;
  date: string;
  profile: ProfileSummary;
}) {
  const { booking, marketplace_service: service } = profile;

  // --- 2) Horarios del día (ANON key). Un fallo NO rompe la pantalla: se pasa `initialError`
  //     a <SlotPicker>, que ofrece "Reintentar" (marketplace-seleccion-horario §Estados
  //     "Error"). `slots` vacío ⇒ estado "Ya no hay horarios para este día". ---
  let slots: AvailabilitySlot[] = [];
  let availabilityService: AvailabilityServiceMeta | null = null;
  let initialError = false;
  try {
    const result = await rpcPublic<AvailabilityResult>('get_marketplace_availability', {
      slug,
      date,
    });
    slots = result.slots;
    availabilityService = result.service;
  } catch (err) {
    // INVALID_DATE / MARKETPLACE_* / red ⇒ estado de error recuperable dentro del picker.
    if (!(err instanceof MarketplaceRpcError || err instanceof Error)) throw err;
    initialError = true;
  }

  // Precio/duración a mostrar salen del RPC de disponibilidad si respondió; si no, del resumen
  // del perfil (mismo servicio). NUNCA del frontend (marketplace-seleccion-horario §Funciones).
  const shownService: MarketplaceServiceMeta = availabilityService ?? service;

  const dayLabel = formatDayLabel(date, booking.timezone);

  return (
    <>
      {/* 2. Resumen del profesional: tarjeta informativa (neutra, sin morado: no es la acción
          principal). Foto · nombre · ✔ validado · "Cita individual · En línea · N min · $precio".
          Datos del RPC público (marketplace-seleccion-horario §Jerarquía.2). */}
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
        {profile.photo_url ? (
          // eslint-disable-next-line @next/next/no-img-element -- avatar remoto (Storage público)
          <img
            src={profile.photo_url}
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
          // Placeholder tintado (tint de marca, nunca como texto/CTA — DISENO_UI §1,§8).
          <span
            aria-hidden="true"
            style={{
              width: 48,
              height: 48,
              borderRadius: 'var(--radius-round)',
              background: 'var(--purple-100)',
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
            {profile.display_name}
            {profile.is_verified && (
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
            {shownService.display_name} · En línea · {shownService.duration_minutes} min ·{' '}
            {formatPriceMXN(shownService.price_mxn)}
          </p>
        </div>
      </section>

      {/* 4. Encabezado del día: "Jueves 16 de julio · Hora local <tz>" — tz del PROFESIONAL
          es la autoritativa (marketplace-seleccion-horario §Jerarquía.4). Si el paciente está
          en otra zona, <SlotPicker> añade la etiqueta (dato de cliente). */}
      <div style={{ marginBottom: 'var(--s12)' }}>
        <h2
          style={{
            fontFamily: 'var(--font-display)',
            fontWeight: 600,
            fontSize: 16,
            color: 'var(--ink-900)',
            margin: '0 0 2px',
            textTransform: 'capitalize',
          }}
        >
          {dayLabel.weekdayAndDate}
        </h2>
        <p style={{ color: 'var(--ink-500)', fontSize: 13, margin: 0 }}>
          Hora local {dayLabel.tzLabel}
        </p>
      </div>

      {/*
        4–6. Chips de horario, resumen de la selección y CTA "Continuar" ⇒ <SlotPicker
        mode="hours"> (Client Component). Recibe:
          - `initialSlots` (SSR, primer paint sin flash) y su `initialError`;
          - `date` + `timezone` del profesional (rótulos y etiqueta cross-tz);
          - `service` (para el resumen inferior; precio/duración salen del RPC);
          - `holdEndpoint`: Route Handler propio POST /psicologos/:slug/agendar/hold (alias del
            "/api/hold" del arnés). Al elegir un horario, el picker hace
            POST { starts_at } → el SERVIDOR crea el hold (create_or_replace_marketplace_slot_hold),
            fija la cookie firmada y responde; el picker recién entonces navega a identificación.
            El navegador NUNCA crea el hold ni toca Supabase/cookie.
          - `identificationHrefBase`: destino tras el hold (paso "Tus datos"); recibe SOLO
            {slug, starts_at} y refresca el MISMO hold con los nombres capturados.
        Errores del hold que el picker debe manejar sin crear cita:
          SLOT_UNAVAILABLE (el slot se ocupó bajo lock ⇒ recargar horarios),
          CHECKOUT_ALREADY_STARTED (ya hay Checkout ⇒ continuar ese flujo),
          HOLD_LIMIT_REACHED / SLOT_TOO_SOON (mensaje al paciente).
      */}
      <SlotPicker
        mode="hours"
        slug={slug}
        date={date}
        service={shownService}
        timezone={booking.timezone}
        initialSlots={slots}
        initialError={initialError}
        // Re-consulta de horarios (Reintentar / refresh tras SLOT_UNAVAILABLE): anon key
        // server-side. GET → { slots, service }. El navegador nunca habla con Supabase directo.
        slotsEndpoint={`/psicologos/${slug}/agendar/horarios/api`}
        // Creación del hold: privilegiada, SIEMPRE server-side. POST { starts_at } → hold+cookie.
        holdEndpoint={`/psicologos/${slug}/agendar/hold`}
        // Tras el hold ⇒ PÁGINA "Tus datos" (identificación), con {slug, starts_at} (ISO UTC).
        identificationHrefBase={`/psicologos/${slug}/agendar/datos`}
      />

      {/* 7. Nota de cierre: el horario NO queda apartado por verlo; se aparta al elegirlo (hold
          server-side) y se confirma al continuar con tus datos. Refuerza que ver ≠ reservar. */}
      <p
        style={{
          color: 'var(--ink-500)',
          fontSize: 13,
          textAlign: 'center',
          margin: 'var(--s20) 0 0',
        }}
      >
        Confirmaremos la disponibilidad al continuar con tus datos.
      </p>
    </>
  );
}

// -------------------------------------------------------------------------------------
// Utilidades de presentación (textos UI en español es-MX; identificadores en inglés).
// -------------------------------------------------------------------------------------

/** Formatea MXN sin decimales (precios enteros del catálogo). */
function formatPriceMXN(amount: number): string {
  return new Intl.NumberFormat('es-MX', {
    style: 'currency',
    currency: 'MXN',
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  }).format(amount);
}

/**
 * Deriva el encabezado del día EN LA TZ DEL PROFESIONAL a partir de "YYYY-MM-DD":
 *   - `weekdayAndDate`: "Jueves 16 de julio" (capitalizado en el render).
 *   - `tzLabel`: nombre corto de la zona (p. ej. "CDMX"/"GMT-6") derivado de la MISMA tz.
 * Se ancla el día al mediodía UTC-neutro y se formatea EN `timeZone` para que el rótulo no se
 * corra por el offset (mismo criterio que la vista de días).
 */
function formatDayLabel(
  isoDate: string,
  timeZone: string,
): { weekdayAndDate: string; tzLabel: string } {
  // Mediodía local aproximado: fija el instante lejos de los bordes del día para que el
  // formateo en `timeZone` devuelva la fecha correcta sin ambigüedad de medianoche.
  const anchor = new Date(`${isoDate}T12:00:00Z`);

  const weekdayAndDate = new Intl.DateTimeFormat('es-MX', {
    timeZone,
    weekday: 'long',
    day: 'numeric',
    month: 'long',
  }).format(anchor);

  // Etiqueta corta de zona ("CDMX", "GMT-6", …) según lo que exponga la plataforma.
  const tzParts = new Intl.DateTimeFormat('es-MX', {
    timeZone,
    timeZoneName: 'short',
  }).formatToParts(anchor);
  const tzLabel = tzParts.find((p) => p.type === 'timeZoneName')?.value ?? timeZone;

  return { weekdayAndDate, tzLabel };
}

// -------------------------------------------------------------------------------------
// SEO: paso privado del booking ⇒ noindex (el layout deja indexable solo directorio/perfil).
// -------------------------------------------------------------------------------------

export const metadata = {
  title: 'Selecciona horario',
  robots: { index: false, follow: false },
};
