// =====================================================================================
// app/psicologos/[slug]/page.tsx — Perfil público del marketplace (Next.js App Router, SSR).
//
// Contrato: paginas/marketplace-perfil.md (ruta /psicologos/:slug, estados, jerarquía,
//           visibilidad condicional, "No debe") + MARKETPLACE.md § get_marketplace_profile
//           (~L476-555): entrada {slug}, allowlist de salida, E-10 (desactivado vs 404),
//           gate de agenda (scheduling_enabled / is_bookable) y § Deep-link/meta social (~L540).
//
// Responsabilidad (y SOLO esto): Server Component que, para un `slug` público,
//   1. lee el perfil con `get_marketplace_profile` (ANON key, lectura pública),
//   2. pinta los estados de la pantalla (cargando/público/404/desactivado(E-10)/agenda apagada/
//      sin horarios/error) sin re-decidir reglas del contrato (solo las pinta),
//   3. es el destino del deep-link compartido: genera OG/meta SOLO con campos del allowlist.
//   NO crea hold/paciente/cita, NO inicia Stripe, NO escribe cookie: eso vive en el flujo de
//   selección de horario (marketplace-seleccion-horario.md), al que esta página solo enlaza.
//
// INVARIANTES DE SEGURIDAD (MARKETPLACE.md) que aplican aquí:
//   - Lectura PÚBLICA ⇒ ANON key vía `rpcPublic` (lib/supabase-server, server-only). El
//     service_role JAMÁS entra a este árbol; esta página nunca escribe ni toca holds/pago.
//   - Solo se renderizan campos del allowlist público que ya devuelve la RPC. NUNCA
//     professional_id, teléfono, fixed_meeting_url, INE, número de cédula, notas internas
//     ni reseñas no `published` (marketplace-perfil §No debe / MARKETPLACE.md §L552).
//   - El CTA «Agendar» solo aparece si `is_bookable=true` (gate de agenda, MARKETPLACE.md
//     §L531): un perfil aprobado sin agenda real NO promete disponibilidad falsa.
//   - E-10: slug nunca-aprobado ⇒ 404 "no disponible" (no revela existencia); perfil que ya
//     fue público y hoy inactivo ⇒ "desactivado" (el link ya existía, no filtra info nueva).
//   - La meta social (deep-link) usa SOLO nombre/foto/extracto de about_me; nada privado.
// =====================================================================================

import { cache } from 'react';
import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import Link from 'next/link';

import { rpcPublic, MarketplaceRpcError } from '../../../lib/supabase-server';

// Perfil público → refleja estado en vivo (aprobado/suspendido, agenda); no cachear la RPC.
export const dynamic = 'force-dynamic';

// -------------------------------------------------------------------------------------
// Tipos: espejo EXACTO del allowlist de salida de `get_marketplace_profile`
// (MARKETPLACE.md §L506-538). Ni un campo privado más.
// -------------------------------------------------------------------------------------

/** Opción de catálogo para chips (sin ids sensibles). */
interface CatalogChip {
  id: string;
  label: string;
}

/** Reseña `published` proyectada por la RPC: sin apellido, sin appointment_id (§L515). */
interface PublicReview {
  rating: number;
  comment: string;
  patient_first_name: string;
  published_at: string;
}

/** Agregado de reseñas compute-on-read. `count=0` ⇒ "Aún no tiene opiniones" (§L527). */
interface ReviewsAggregate {
  average: number;
  count: number;
  items: PublicReview[]; // hasta 3 `published`
}

/** Servicio de marketplace (etiqueta orientada al paciente: "Cita individual", §L523). */
interface MarketplaceService {
  display_name: string;
  price_mxn: number;
  duration_minutes: number;
  modality: string; // siempre 'online' en el flujo del marketplace (aserción defensiva §L498)
}

/** Gate de agenda (§L528-538): `is_bookable = scheduling_enabled AND hay disponibilidad futura`. */
interface BookingMeta {
  timezone: string; // tz del profesional (IANA)
  scheduling_enabled: boolean;
  is_bookable: boolean;
}

/** El enum del mayor grado aprobado; la ETIQUETA visible es `degree_label` (derivada, §L507). */
type AcademicDegree = 'licenciatura' | 'maestria' | 'doctorado';

/** Perfil público activo tal como lo devuelve la RPC (allowlist §L506-516). */
interface ActiveProfile {
  status: 'active';
  display_name: string;
  photo_url: string | null;
  is_verified: boolean; // derivado de `approved` (§L519); alimenta "✔ Profesional validado"
  academic_degree: AcademicDegree;
  degree_label: string; // derivada del enum en el servidor; NUNCA fija a licenciatura (§L508)
  years_experience: number | null;
  about_me: string;
  laboral_experience: string | null; // solo si tiene contenido (§L511)
  intro_video_url: string | null; // nullable ⇒ sin tarjeta vacía (perfil §6)
  catalog: {
    areas: CatalogChip[];
    populations: CatalogChip[];
    approaches: CatalogChip[];
  };
  marketplace_service: MarketplaceService;
  reviews: ReviewsAggregate;
  booking: BookingMeta;
}

/** Perfil que ya fue público y hoy está inactivo (E-10, §L543-546). La RPC lo marca así en
 *  vez de un 404, porque quien tiene el link ya conocía la existencia del perfil. */
interface DeactivatedProfile {
  status: 'deactivated';
}

type ProfilePayload = ActiveProfile | DeactivatedProfile;

/** Resultado normalizado que consume la página (discrimina los estados del contrato). */
type LoadResult =
  | { kind: 'active'; profile: ActiveProfile }
  | { kind: 'deactivated' }
  | { kind: 'not_found' } // slug nunca-aprobado o servicio no disponible ⇒ "no disponible"
  | { kind: 'error' }; // fallo de red/servidor ⇒ "No pudimos cargar el perfil" + Reintentar

// -------------------------------------------------------------------------------------
// Vista previa de horarios (perfil §4): `get_marketplace_available_days` es READ público.
// NO hay batch de slots en el perfil; solo días con ≥1 slot para orientar (§L557-584).
// -------------------------------------------------------------------------------------

interface AvailableDay {
  date: string; // YYYY-MM-DD
  weekday: number; // 0..6 (metadata de la RPC)
}

interface AvailableDaysResult {
  available_days: AvailableDay[];
}

const PREVIEW_WINDOW_DAYS = 21; // ventana corta para el preview (la RPC exige rango ≤ 60, §L572)
const PREVIEW_MAX_CHIPS = 6; // cuántos días mostramos antes de "Ver más horarios"

// -------------------------------------------------------------------------------------
// Carga del perfil, memoizada por render con React `cache()` para que `generateMetadata` y
// el componente compartan UNA sola llamada a la RPC (supabase-js no deduplica solo).
// -------------------------------------------------------------------------------------

const loadProfile = cache(async (slug: string): Promise<LoadResult> => {
  try {
    const data = await rpcPublic<ProfilePayload>('get_marketplace_profile', { slug });
    // El contrato modela el perfil desactivado como un estado explícito (no como error).
    if (data.status === 'deactivated') return { kind: 'deactivated' };
    return { kind: 'active', profile: data };
  } catch (err) {
    if (err instanceof MarketplaceRpcError) {
      // Nunca-aprobado o servicio mal-configurado ⇒ "no disponible" (no revela existencia).
      if (
        err.code === 'MARKETPLACE_PROFILE_NOT_FOUND' ||
        err.code === 'INVALID_SLUG' ||
        err.code === 'MARKETPLACE_SERVICE_UNAVAILABLE'
      ) {
        return { kind: 'not_found' };
      }
      return { kind: 'error' };
    }
    if (err instanceof Error) return { kind: 'error' };
    throw err;
  }
});

/** Preview de días disponibles (perfil §4). Falla suave: si no carga, el perfil sigue visible. */
async function loadPreviewDays(slug: string, timezone: string): Promise<AvailableDay[] | null> {
  try {
    const res = await rpcPublic<AvailableDaysResult>('get_marketplace_available_days', {
      slug,
      from_date: localDateInTz(timezone, 0), // hoy en la tz del profesional (§L571)
      to_date: localDateInTz(timezone, PREVIEW_WINDOW_DAYS),
    });
    return res.available_days ?? [];
  } catch {
    // El preview es accesorio: un fallo aquí NO tumba el perfil (perfil §Estados "Sin horarios").
    return null;
  }
}

// -------------------------------------------------------------------------------------
// Helpers de presentación puros (no re-deciden reglas del contrato).
// -------------------------------------------------------------------------------------

/** Fecha `YYYY-MM-DD` en la tz del profesional, +offsetDays. Node expone Intl con timeZone. */
function localDateInTz(timeZone: string, offsetDays: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + offsetDays);
  // en-CA da el formato ISO (YYYY-MM-DD) directamente y respeta la zona horaria.
  return new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(d);
}

/** Etiqueta corta y en español de una fecha YYYY-MM-DD para los chips del preview. */
function formatDayChip(dateIso: string, timeZone: string): string {
  // Interpretamos la fecha como mediodía local para evitar corrimientos de día por DST.
  const dt = new Date(`${dateIso}T12:00:00`);
  return new Intl.DateTimeFormat('es-MX', {
    timeZone,
    weekday: 'short',
    day: 'numeric',
    month: 'short',
  }).format(dt);
}

/** Extracto de `about_me` para la descripción social (deep-link, §L540). Solo campo público. */
function excerpt(text: string, max = 160): string {
  const clean = text.replace(/\s+/g, ' ').trim();
  return clean.length <= max ? clean : `${clean.slice(0, max - 1).trimEnd()}…`;
}

/** Ruta del flujo de selección de horario (marketplace-seleccion-horario, §Navegación). */
function bookingHref(slug: string, startsAt?: string): string {
  return startsAt
    ? `/psicologos/${slug}/agendar?starts_at=${encodeURIComponent(startsAt)}`
    : `/psicologos/${slug}/agendar`;
}

// -------------------------------------------------------------------------------------
// generateMetadata (SSR/SEO por :slug). Deep-link social: SOLO campos del allowlist público
// (nombre, foto, extracto de about_me). Estados no-públicos ⇒ noindex y copy genérico (§L540).
// -------------------------------------------------------------------------------------

export async function generateMetadata({
  params,
}: {
  params: Promise<{ slug: string }>;
}): Promise<Metadata> {
  const { slug } = await params;
  const result = await loadProfile(slug);

  // 404 / desactivado / error ⇒ nada indexable y sin datos que no deban filtrarse.
  if (result.kind !== 'active') {
    return {
      title: 'Perfil no disponible',
      robots: { index: false, follow: false },
    };
  }

  const p = result.profile;
  const description = excerpt(p.about_me);
  const images = p.photo_url ? [{ url: p.photo_url }] : undefined;

  return {
    title: p.display_name, // se compone como "<Nombre> · Agenda Psi" (template del layout)
    description,
    alternates: { canonical: `/psicologos/${slug}` },
    robots: { index: true, follow: true },
    openGraph: {
      type: 'profile',
      title: p.display_name,
      description,
      url: `/psicologos/${slug}`,
      images,
    },
    twitter: {
      card: 'summary_large_image',
      title: p.display_name,
      description,
      images: p.photo_url ? [p.photo_url] : undefined,
    },
  };
}

// =====================================================================================
// Página. `params` (Next 15) es Promise. El estado "Cargando" (skeleton de identidad/servicio/
// horarios, perfil §Estados) lo cubre el `loading.tsx` hermano vía Suspense mientras la RPC
// resuelve — no se pinta aquí.
// =====================================================================================

export default async function PerfilProfesionalPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const result = await loadProfile(slug);

  // --- Estado NO ENCONTRADO (slug nunca-aprobado / servicio no disponible). ---
  // notFound() renderiza el not-found.tsx del segmento: "Este perfil no está disponible"
  // (no revela si el slug existió alguna vez). E-10 para nunca-aprobado.
  if (result.kind === 'not_found') notFound();

  // --- Estado ERROR (fallo de red). Reintentar = recargar la misma URL. ---
  if (result.kind === 'error') {
    return (
      <PageShell slug={slug}>
        <section
          className="card"
          role="alert"
          style={{ padding: 'var(--s24)', textAlign: 'center', margin: 'var(--s24) 0' }}
        >
          <p style={{ color: 'var(--ink-900)', fontWeight: 600, margin: '0 0 var(--s12)' }}>
            No pudimos cargar el perfil
          </p>
          <p style={{ color: 'var(--ink-500)', fontSize: 14, margin: '0 0 var(--s16)' }}>
            Revisa tu conexión e inténtalo de nuevo.
          </p>
          <Link href={`/psicologos/${slug}`} className="cta-primary" style={{ textDecoration: 'none' }}>
            Reintentar
          </Link>
        </section>
      </PageShell>
    );
  }

  // --- Estado DESACTIVADO (E-10): perfil que ya fue público y hoy está inactivo. ---
  if (result.kind === 'deactivated') {
    return (
      <PageShell slug={slug}>
        <section
          className="card"
          style={{ padding: 'var(--s24)', textAlign: 'center', margin: 'var(--s24) 0' }}
        >
          <p style={{ color: 'var(--ink-900)', fontWeight: 600, margin: '0 0 var(--s12)' }}>
            Este perfil está desactivado por el momento
          </p>
          <Link href="/psicologos" className="btn-secondary" style={{ textDecoration: 'none' }}>
            Volver a profesionales
          </Link>
        </section>
      </PageShell>
    );
  }

  // --- Estado PÚBLICO: perfil completo. ---
  const p = result.profile;

  // Preview de horarios solo si es reservable; si no, no prometemos disponibilidad falsa.
  const previewDays = p.booking.is_bookable
    ? (await loadPreviewDays(slug, p.booking.timezone))?.slice(0, PREVIEW_MAX_CHIPS) ?? []
    : [];

  return (
    <PageShell slug={slug} stickyCta={p.booking.is_bookable ? slug : null}>
      <article style={{ margin: 'var(--s20) 0' }}>
        {/* 2. IDENTIDAD (perfil §Jerarquía.2). */}
        <section style={{ display: 'flex', gap: 'var(--s16)', alignItems: 'flex-start' }}>
          {/* Foto: campo público. `alt` describe sin exponer datos privados. */}
          {p.photo_url ? (
            // eslint-disable-next-line @next/next/no-img-element -- URL pública remota; sin loader de dominio en pseudocódigo
            <img
              src={p.photo_url}
              alt={`Foto de ${p.display_name}`}
              width={88}
              height={88}
              style={{
                width: 88,
                height: 88,
                borderRadius: 'var(--radius-xl)',
                objectFit: 'cover',
                border: '1px solid var(--border)',
                flexShrink: 0,
              }}
            />
          ) : (
            <div
              aria-hidden="true"
              style={{
                width: 88,
                height: 88,
                borderRadius: 'var(--radius-xl)',
                background: 'var(--purple-100)',
                flexShrink: 0,
              }}
            />
          )}

          <div style={{ minWidth: 0 }}>
            {/* ✔ Profesional validado: insignia derivada de is_verified (§L519). Verde semántico. */}
            {p.is_verified && (
              <span
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: 'var(--s4)',
                  background: 'var(--success-100)',
                  color: 'var(--success-700)',
                  borderRadius: 'var(--radius-round)',
                  padding: '2px var(--s8)',
                  fontSize: 12,
                  fontWeight: 600,
                  marginBottom: 'var(--s8)',
                }}
              >
                <span aria-hidden="true">✔</span> Profesional validado
              </span>
            )}

            <h1
              style={{
                fontFamily: 'var(--font-display)',
                fontWeight: 700,
                fontSize: 24,
                lineHeight: 1.2,
                color: 'var(--ink-900)',
                margin: '0 0 var(--s4)',
              }}
            >
              {p.display_name}
            </h1>

            {p.years_experience != null && p.years_experience > 0 && (
              <p className="num" style={{ color: 'var(--ink-500)', fontSize: 14, margin: '0 0 var(--s4)' }}>
                {p.years_experience}{' '}
                {p.years_experience === 1 ? 'año de experiencia' : 'años de experiencia'}
              </p>
            )}

            {/* Rating: promedio + conteo; count=0 ⇒ sin estrellas (§L527). */}
            {p.reviews.count > 0 ? (
              <p className="num" style={{ color: 'var(--ink-700)', fontSize: 14, margin: 0 }}>
                <span aria-hidden="true" style={{ color: 'var(--amber-600)' }}>★</span>{' '}
                {p.reviews.average.toFixed(1)}{' '}
                <span style={{ color: 'var(--ink-500)' }}>
                  ({p.reviews.count} {p.reviews.count === 1 ? 'opinión' : 'opiniones'})
                </span>
              </p>
            ) : (
              <p style={{ color: 'var(--ink-500)', fontSize: 14, margin: 0 }}>Aún no tiene opiniones</p>
            )}
          </div>
        </section>

        {/* 3. CREDENCIAL + SERVICIO (tarjetas, perfil §Jerarquía.3). */}
        <section style={{ display: 'grid', gap: 'var(--s12)', marginTop: 'var(--s20)' }}>
          {/* Cédula profesional: SIN número (D del MVP, §L517). Solo insignia + degree_label. */}
          <div className="card" style={{ padding: 'var(--s16)' }}>
            <p style={{ color: 'var(--ink-500)', fontSize: 12, margin: '0 0 var(--s4)' }}>
              Cédula profesional
            </p>
            <p style={{ color: 'var(--ink-900)', fontWeight: 600, fontSize: 15, margin: 0 }}>
              {/* degree_label ya viene derivado del enum academic_degree (§L508); no se re-deriva. */}
              {p.is_verified && (
                <span style={{ color: 'var(--success-700)', marginRight: 'var(--s8)' }}>
                  <span aria-hidden="true">✔</span> Verificada
                </span>
              )}
              {p.degree_label}
            </p>
          </div>

          {/* Servicio: "Cita individual · En línea · N min · $precio" (§L523). */}
          <div className="card" style={{ padding: 'var(--s16)' }}>
            <p style={{ color: 'var(--ink-900)', fontWeight: 600, fontSize: 15, margin: '0 0 var(--s4)' }}>
              {p.marketplace_service.display_name}
            </p>
            <p className="num" style={{ color: 'var(--ink-500)', fontSize: 14, margin: 0 }}>
              En línea · {p.marketplace_service.duration_minutes} min ·{' '}
              {formatPrice(p.marketplace_service.price_mxn)}
            </p>
          </div>
        </section>

        {/* 4. HORARIOS DISPONIBLES (preview) — visibilidad condicional por scheduling_enabled. */}
        <ScheduleSection slug={slug} booking={p.booking} previewDays={previewDays} />

        {/* 5. SOBRE MÍ (§Jerarquía.5). */}
        {p.about_me.trim().length > 0 && (
          <Block title="Sobre mí">
            <p style={{ color: 'var(--ink-700)', fontSize: 15, lineHeight: 1.6, margin: 0, whiteSpace: 'pre-line' }}>
              {p.about_me}
            </p>
          </Block>
        )}

        {/* 6. VIDEO DE PRESENTACIÓN — solo si intro_video_url != null (§Jerarquía.6 / Visibilidad). */}
        {p.intro_video_url && (
          <Block title="Video de presentación">
            <Link
              href={p.intro_video_url}
              className="btn-secondary"
              target="_blank"
              rel="noopener noreferrer nofollow"
              style={{ textDecoration: 'none' }}
            >
              Ver video de presentación
            </Link>
          </Block>
        )}

        {/* 7. ESPECIALIDADES: Áreas · Enfoques · Poblaciones (separadas, §Jerarquía.7). */}
        {(p.catalog.areas.length > 0 || p.catalog.approaches.length > 0 || p.catalog.populations.length > 0) && (
          <Block title="Especialidades">
            <ChipGroup label="Áreas" chips={p.catalog.areas} />
            <ChipGroup label="Enfoques" chips={p.catalog.approaches} />
            <ChipGroup label="Poblaciones" chips={p.catalog.populations} />
          </Block>
        )}

        {/* 8. EXPERIENCIA PROFESIONAL — solo si laboral_experience tiene contenido (§Visibilidad). */}
        {p.laboral_experience && p.laboral_experience.trim().length > 0 && (
          <Block title="Experiencia profesional">
            <p style={{ color: 'var(--ink-700)', fontSize: 15, lineHeight: 1.6, margin: 0, whiteSpace: 'pre-line' }}>
              {p.laboral_experience}
            </p>
          </Block>
        )}

        {/* 9. OPINIONES — solo si count>0. Hasta 3 `published`; sin apellido/appointment (§L515). */}
        {p.reviews.count > 0 && (
          <Block title="Opiniones">
            <p className="num" style={{ color: 'var(--ink-700)', fontSize: 14, margin: '0 0 var(--s12)' }}>
              <span aria-hidden="true" style={{ color: 'var(--amber-600)' }}>★</span>{' '}
              {p.reviews.average.toFixed(1)} · {p.reviews.count}{' '}
              {p.reviews.count === 1 ? 'opinión' : 'opiniones'}
            </p>

            <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'grid', gap: 'var(--s12)' }}>
              {p.reviews.items.map((review, i) => (
                <li key={`${review.patient_first_name}-${review.published_at}-${i}`} className="card" style={{ padding: 'var(--s16)' }}>
                  <p className="num" style={{ color: 'var(--amber-600)', fontSize: 13, margin: '0 0 var(--s4)' }} aria-label={`${review.rating} de 5`}>
                    {'★'.repeat(Math.max(0, Math.min(5, Math.round(review.rating))))}
                  </p>
                  <p style={{ color: 'var(--ink-700)', fontSize: 14, lineHeight: 1.5, margin: '0 0 var(--s8)' }}>
                    {review.comment}
                  </p>
                  <p style={{ color: 'var(--ink-500)', fontSize: 12, margin: 0 }}>
                    {review.patient_first_name}
                  </p>
                </li>
              ))}
            </ul>

            {/* «Ver todas» solo si hay más de las mostradas (§Jerarquía.9). */}
            {p.reviews.count > p.reviews.items.length && (
              <Link
                href={`/psicologos/${slug}/opiniones`}
                className="btn-secondary"
                style={{ textDecoration: 'none', marginTop: 'var(--s12)' }}
              >
                Ver todas las opiniones
              </Link>
            )}
          </Block>
        )}
      </article>
    </PageShell>
  );
}

// =====================================================================================
// Subcomponentes de presentación (mismo archivo: la tarea entrega SOLO este archivo).
// Todos Server Components sin estado; el flujo interactivo vive en la página de selección.
// =====================================================================================

/** Cascarón con app bar (← volver) y, opcionalmente, el CTA sticky «Agendar cita». */
function PageShell({
  slug,
  children,
  stickyCta,
}: {
  slug: string;
  children: React.ReactNode;
  stickyCta?: string | null;
}) {
  return (
    <main style={{ minHeight: '100vh', paddingBottom: stickyCta ? 96 : 'var(--s32)' }}>
      {/* 1. App bar: ← volver al listado (perfil §Jerarquía.1). */}
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
          zIndex: 10,
        }}
      >
        <Link
          href="/psicologos"
          aria-label="Volver a profesionales"
          style={{ color: 'var(--ink-900)', textDecoration: 'none', fontSize: 20, lineHeight: 1 }}
        >
          <span aria-hidden="true">←</span>
        </Link>
        <span style={{ fontFamily: 'var(--font-display)', fontWeight: 700, fontSize: 16, color: 'var(--ink-700)' }}>
          Profesionales
        </span>
      </header>

      <div style={{ maxWidth: 720, margin: '0 auto', padding: '0 var(--s16)' }}>{children}</div>

      {/* 10. CTA STICKY: «Agendar cita». Único morado de la pantalla (DISENO_UI §1). Solo si
          is_bookable (gate de agenda §L531). Por encima del safe area; no tapa la última opinión
          gracias al paddingBottom del <main>. */}
      {stickyCta && (
        <div
          style={{
            position: 'fixed',
            left: 0,
            right: 0,
            bottom: 0,
            padding: 'var(--s12) var(--s16)',
            paddingBottom: 'calc(var(--s12) + env(safe-area-inset-bottom, 0px))',
            background: 'var(--surface)',
            borderTop: '1px solid var(--border)',
            zIndex: 20,
          }}
        >
          <div style={{ maxWidth: 720, margin: '0 auto' }}>
            <Link
              href={bookingHref(stickyCta)}
              className="cta-primary"
              style={{ textDecoration: 'none', width: '100%' }}
            >
              Agendar cita
            </Link>
          </div>
        </div>
      )}
    </main>
  );
}

/** Sección de horarios (perfil §4): pinta los sub-estados del gate de agenda (§L528-538). */
function ScheduleSection({
  slug,
  booking,
  previewDays,
}: {
  slug: string;
  booking: BookingMeta;
  previewDays: AvailableDay[];
}) {
  // Agenda apagada (scheduling_enabled=false): sin chips, aviso; el CTA sticky ni se muestra.
  if (!booking.scheduling_enabled) {
    return (
      <Block title="Horarios disponibles">
        <p style={{ color: 'var(--ink-500)', fontSize: 14, margin: 0 }}>
          Este profesional aún no tiene horarios disponibles.
        </p>
      </Block>
    );
  }

  // scheduling_enabled=true pero sin disponibilidad futura ⇒ NO se promete slot (§L531): sin
  // CTA primario, pero se ofrece revalidar la agenda real desde la página de selección.
  if (!booking.is_bookable || previewDays.length === 0) {
    return (
      <Block title="Horarios disponibles">
        <p style={{ color: 'var(--ink-500)', fontSize: 14, margin: '0 0 var(--s12)' }}>
          Sin horarios próximos.
        </p>
        <Link href={bookingHref(slug)} className="btn-secondary" style={{ textDecoration: 'none' }}>
          Ver más horarios
        </Link>
      </Block>
    );
  }

  // Preview con disponibilidad: chips de día → página de selección (revalida el slot real).
  return (
    <Block title="Horarios disponibles">
      {/* tz del profesional; la etiqueta de la tz del paciente y los slots exactos se resuelven
          en la página de selección (perfil §4, no se calcula el calendario completo aquí). */}
      <p style={{ color: 'var(--ink-500)', fontSize: 12, margin: '0 0 var(--s12)' }}>
        Horario del profesional ({booking.timezone}). Confirmas la hora en tu zona al elegir.
      </p>
      <ul style={{ listStyle: 'none', margin: '0 0 var(--s12)', padding: 0, display: 'flex', flexWrap: 'wrap', gap: 'var(--s8)' }}>
        {previewDays.map((day) => (
          <li key={day.date}>
            <Link
              href={`${bookingHref(slug)}?date=${day.date}`}
              className="btn-secondary"
              style={{ textDecoration: 'none', padding: '0 var(--s12)' }}
            >
              {formatDayChip(day.date, booking.timezone)}
            </Link>
          </li>
        ))}
      </ul>
      <Link
        href={bookingHref(slug)}
        style={{ color: 'var(--purple-700)', fontWeight: 600, fontSize: 14, textDecoration: 'none' }}
      >
        Ver más horarios
      </Link>
    </Block>
  );
}

/** Bloque de sección con título Display (Sora) uniforme. */
function Block({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section style={{ marginTop: 'var(--s24)' }}>
      <h2
        style={{
          fontFamily: 'var(--font-display)',
          fontWeight: 700,
          fontSize: 18,
          color: 'var(--ink-900)',
          margin: '0 0 var(--s12)',
        }}
      >
        {title}
      </h2>
      {children}
    </section>
  );
}

/** Grupo de chips descriptivos (fondo ink-100, §DISENO_UI). Se omite si la lista está vacía. */
function ChipGroup({ label, chips }: { label: string; chips: CatalogChip[] }) {
  if (chips.length === 0) return null;
  return (
    <div style={{ marginBottom: 'var(--s12)' }}>
      <p style={{ color: 'var(--ink-500)', fontSize: 12, margin: '0 0 var(--s8)' }}>{label}</p>
      <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexWrap: 'wrap', gap: 'var(--s8)' }}>
        {chips.map((chip) => (
          <li
            key={chip.id}
            style={{
              background: 'var(--ink-100)',
              color: 'var(--ink-700)',
              borderRadius: 'var(--radius-round)',
              padding: '4px var(--s12)',
              fontSize: 13,
            }}
          >
            {chip.label}
          </li>
        ))}
      </ul>
    </div>
  );
}

/** Precio en MXN sin decimales (cifras tabulares vía clase .num en el nodo contenedor). */
function formatPrice(mxn: number): string {
  return new Intl.NumberFormat('es-MX', {
    style: 'currency',
    currency: 'MXN',
    maximumFractionDigits: 0,
  }).format(mxn);
}
