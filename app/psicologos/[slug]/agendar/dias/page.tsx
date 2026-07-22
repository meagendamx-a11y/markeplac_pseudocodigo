// =====================================================================================
// app/psicologos/[slug]/agendar/dias/page.tsx
// Marketplace — "Selecciona tu horario" (paso 1 de 4). Next.js App Router, SSR.
//
// Contrato: paginas/marketplace-seleccion-horario.md (ruta, estados, jerarquía, "No debe")
//           + MARKETPLACE.md § get_marketplace_available_days (~L557) y
//             § get_marketplace_profile (~L505) — allowlist público, service metadata,
//             booking{timezone, scheduling_enabled, is_bookable}.
//
// Responsabilidad del archivo (y SOLO esto): Server Component que
//   1. resuelve el slug y consulta —con la ANON key (lectura pública)— el resumen del
//      profesional (`get_marketplace_profile`) y los días con cupo del rango inicial
//      (`get_marketplace_available_days`);
//   2. pinta la app bar, la tarjeta-resumen del profesional y la nota de cierre;
//   3. delega la interacción del calendario a <SlotPicker mode="days" …>: cambio de mes,
//      selección de día → horarios, selección de horario y CTA "Continuar".
//   Esta página es SOLO lectura/selección: NO crea hold, NO toca la cookie de booking,
//   NO afirma que el horario quedó apartado (marketplace-seleccion-horario §"No debe").
//
// INVARIANTES DE SEGURIDAD (MARKETPLACE.md) que aplican aquí:
//   - Lecturas PÚBLICAS ⇒ ANON key vía `rpcPublic` (lib/supabase-server, server-only). El
//     service_role JAMÁS entra a este árbol: esta pantalla no escribe nada (ni holds, ni
//     pago, ni OTP). Las re-consultas del cliente (mes/día) pasan por Route Handlers propios
//     que vuelven a usar la anon key server-side, nunca Supabase directo desde el navegador.
//   - El backend re-resuelve profesional/servicio internamente y NO confía en precio/
//     duración/modalidad del frontend (marketplace-seleccion-horario §Funciones): el
//     `service` que se pinta viene del RPC; hacia adelante solo viaja `{slug, starts_at}` y
//     la siguiente pantalla revalida y crea el hold.
//   - Sin datos clínicos ni de pago; sin estado autoritativo en el cliente. El único dato
//     que la selección propaga es `starts_at` (ISO UTC) por la URL; el hold/cita/pago se
//     resuelven después en la base (marketplace-tus-datos).
//
// SEO: paso privado del flujo de booking ⇒ `robots: noindex` (layout §metadata: los pasos
// del booking se marcan noindex; el contenido indexable es el directorio/perfil público).
// =====================================================================================

import Link from 'next/link';

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

/** Un día con ≥1 horario disponible (salida de `get_marketplace_available_days`). */
export interface AvailableDay {
  date: string; // "YYYY-MM-DD" en la tz del profesional
  weekday: number; // 0=domingo … 6=sábado (o el índice que fije el RPC)
}

/** Salida de `get_marketplace_available_days`: días + metadata pública del servicio. */
export interface AvailableDaysResult {
  available_days: AvailableDay[];
  service: MarketplaceServiceMeta;
}

// -------------------------------------------------------------------------------------
// Rango inicial del calendario. La verdad la fija el RPC (`from_date >= today_local`,
// rango ≤ 60 días); aquí solo proponemos una ventana razonable para el primer paint.
// El cambio de mes lo re-consulta <SlotPicker> por su cuenta (Route Handler propio).
// -------------------------------------------------------------------------------------

const INITIAL_WINDOW_DAYS = 34; // mes visible + colchón; el RPC recorta a hoy_local / ≤60.

/** "YYYY-MM-DD" de hoy en una tz IANA (evita adelantar/atrasar el día por el offset UTC). */
function todayInTimeZone(timeZone: string): string {
  // en-CA da directamente el formato ISO "YYYY-MM-DD".
  return new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
}

/** Suma `days` naturales a un "YYYY-MM-DD" y devuelve "YYYY-MM-DD" (aritmética en UTC). */
function addDays(isoDate: string, days: number): string {
  const d = new Date(`${isoDate}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

// -------------------------------------------------------------------------------------
// Página. `params` (Next 15) llega como Promise. `slug` identifica al profesional; el
// backend re-resuelve profesional/servicio a partir de él (no confiamos en nada más).
// -------------------------------------------------------------------------------------

export default async function SeleccionHorarioDiasPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;

  // --- 1) Resumen del profesional (ANON key). Fija identidad + service + tz + gate. ---
  //     Se consulta en el servidor (no se "reusa" estado de cliente) para que la entrada
  //     por deep-link o recarga funcione y para que precio/duración salgan del RPC, no del
  //     frontend (marketplace-seleccion-horario §Funciones).
  let profile: ProfileSummary | null = null;
  let profileErrored = false;
  try {
    profile = await rpcPublic<ProfileSummary>('get_marketplace_profile', { slug });
  } catch (err) {
    // MARKETPLACE_PROFILE_NOT_FOUND / MARKETPLACE_SERVICE_UNAVAILABLE / red ⇒ "no disponible".
    profileErrored = err instanceof MarketplaceRpcError || err instanceof Error;
    if (!profileErrored) throw err;
  }

  // Estado "Perfil no disponible": perfil inexistente, servicio caído o agenda no habilitada
  // (marketplace-seleccion-horario §Estados). No revelamos detalle interno del error.
  const notBookable = !profile || !profile.booking.is_bookable;

  return (
    <main style={{ minHeight: '100vh' }}>
      {/* 1. App bar: ← "Selecciona horario" (marketplace-seleccion-horario §Jerarquía.1). */}
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
        {/* Volver al perfil público del profesional (origen del flujo). */}
        <Link
          href={`/psicologos/${slug}`}
          aria-label="Volver al perfil"
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
          <BookableContent slug={slug} profile={profile as ProfileSummary} />
        )}
      </div>
    </main>
  );
}

// -------------------------------------------------------------------------------------
// Contenido cuando el perfil ES agendable: resumen + calendario (SlotPicker) + nota.
// Se separa para hacer la carga inicial de días SOLO cuando tiene sentido (perfil OK).
// -------------------------------------------------------------------------------------

async function BookableContent({
  slug,
  profile,
}: {
  slug: string;
  profile: ProfileSummary;
}) {
  const { booking, marketplace_service: service } = profile;

  // Rango inicial en la tz del profesional (el RPC valida from_date >= today_local y ≤60d).
  const fromDate = todayInTimeZone(booking.timezone);
  const toDate = addDays(fromDate, INITIAL_WINDOW_DAYS);

  // --- 2) Días con cupo del rango inicial (ANON key). Un fallo NO rompe la pantalla: se
  //     pasa `initialError` a <SlotPicker>, que ofrece "Reintentar" dentro del calendario
  //     (marketplace-seleccion-horario §Estados "Error"). ---
  let initialDays: AvailableDay[] = [];
  let initialError = false;
  try {
    const result = await rpcPublic<AvailableDaysResult>('get_marketplace_available_days', {
      slug,
      from_date: fromDate,
      to_date: toDate,
    });
    initialDays = result.available_days;
  } catch (err) {
    initialError = err instanceof MarketplaceRpcError || err instanceof Error;
    if (!initialError) throw err;
  }

  return (
    <>
      {/* 2. Resumen del profesional: tarjeta informativa (NO es la acción principal, por eso
          neutra, sin morado). Foto · nombre · ✔ validado · "Cita individual · En línea · N min · $precio".
          Datos del RPC público, nunca del frontend (marketplace-seleccion-horario §Jerarquía.2). */}
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
          // eslint-disable-next-line @next/next/no-img-element -- avatar de origen remoto (Storage público)
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
              // Insignia de validación (is_verified derivado de perfil aprobado).
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
            {service.display_name} · En línea · {service.duration_minutes} min ·{' '}
            {formatPriceMXN(service.price_mxn)}
          </p>
        </div>
      </section>

      {/*
        3–6. Calendario, horarios del día, resumen de selección y CTA "Continuar".
        Todo interactivo ⇒ <SlotPicker> (Client Component). Recibe:
          - la carga inicial de días (SSR, primer paint sin flash) y su `initialError`;
          - el rango inicial y la tz del profesional (rótulo "Hora local …" y etiqueta si el
            paciente está en otra zona — marketplace-seleccion-horario §Jerarquía.4);
          - el `service` (para el resumen inferior; su precio/duración salen del RPC);
          - los Route Handlers propios que re-consultan por mes/día con la ANON key
            server-side (el navegador NUNCA habla con Supabase directo);
          - la base del href de "Continuar", que propaga SOLO {slug, starts_at} a la
            siguiente pantalla (que revalida y crea el hold).
        SlotPicker NO crea hold, NO toca la cookie ni afirma que el slot quedó apartado.
      */}
      <SlotPicker
        mode="days"
        slug={slug}
        service={service}
        timezone={booking.timezone}
        initialRange={{ fromDate, toDate }}
        initialDays={initialDays}
        initialError={initialError}
        // Route Handlers propios (anon key server-side). Contrato de red del cliente:
        //   GET daysEndpoint?from_date=&to_date=  → { available_days, service }
        //   GET slotsEndpoint?date=               → { slots, service }
        daysEndpoint={`/psicologos/${slug}/agendar/dias/api`}
        slotsEndpoint={`/psicologos/${slug}/agendar/horarios/api`}
        // "Continuar" → PÁGINA marketplace-tus-datos, pasando {slug, starts_at} (ISO UTC).
        continueHrefBase={`/psicologos/${slug}/agendar/datos`}
      />

      {/* 7. Nota de cierre: la disponibilidad se confirma en el paso de datos (NO aquí).
          Refuerza el invariante "No afirmar que el horario quedó apartado". */}
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
// Utilidades de presentación.
// -------------------------------------------------------------------------------------

/** Formatea MXN sin decimales (precios enteros del catálogo). Textos UI en español (es-MX). */
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
// Título específico de la pantalla; sin datos de paciente/pago en la metadata.
// -------------------------------------------------------------------------------------

export const metadata = {
  title: 'Selecciona horario',
  robots: { index: false, follow: false },
};
