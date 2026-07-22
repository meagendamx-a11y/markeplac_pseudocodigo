// =====================================================================================
// app/psicologos/page.tsx — Directorio público del marketplace (Next.js App Router, SSR).
//
// Contrato: paginas/marketplace-listado.md (ruta /psicologos, estados, jerarquía, "No debe")
//           + MARKETPLACE.md § search_marketplace_profiles (~L376-448): entrada, salida,
//           rotación diaria, rating FUERA del ORDER BY, relaxed_filters, SIN slots en tarjeta.
//
// Responsabilidad (y SOLO esto): Server Component que
//   1. traduce los searchParams de la URL a la entrada de `search_marketplace_profiles`,
//   2. la invoca con la ANON key (lectura pública) y pinta los cinco estados de pantalla,
//   3. delega la interacción a <FilterBar> (diálogo de filtros) y <ProfileCard> (tarjeta).
//   Esta página NO re-decide reglas del contrato; solo las pinta (marketplace-listado §Fuente).
//
// INVARIANTES DE SEGURIDAD (MARKETPLACE.md) que aplican aquí:
//   - Lectura PÚBLICA ⇒ ANON key vía `rpcPublic` (lib/supabase-server, server-only). El
//     service_role JAMÁS entra a este árbol; este componente corre en el servidor pero solo
//     lee el directorio con la superficie pública (nunca escribe, nunca toca holds/pago).
//   - El ORDEN lo fija el servidor (rotación diaria determinística); esta página NO envía
//     ningún parámetro de orden ni reordena por rating (marketplace-listado §No debe).
//   - SIN disponibilidad/slots en la tarjeta (D-B): no se consulta ni se pinta agenda aquí.
//   - Los filtros aplicados viajan en la URL (shareable/SSR/SEO), no en estado de cliente.
//     La cookie `affinity_filters` es NO autoritativa: solo decide el affordance del FAB
//     ("Test de afinidad" vs "Afinidad aplicada"); el conjunto real de filtros es el de la URL.
//   - Nada clínico/privado se maneja aquí: la salida ya viene con allowlist público desde la RPC.
// =====================================================================================

import { cookies } from 'next/headers';
import Link from 'next/link';

import { rpcPublic, MarketplaceRpcError } from '../../lib/supabase-server';
import { FilterBar } from '../../components/FilterBar';
import { ProfileCard } from '../../components/ProfileCard';

// Directorio público → cada carga refleja la rotación diaria del servidor; no cachear la RPC.
export const dynamic = 'force-dynamic';

// -------------------------------------------------------------------------------------
// Tipos de la salida de `search_marketplace_profiles` (MARKETPLACE.md ~L428-431).
// Espejo EXACTO del allowlist público del contrato: ni un campo privado más.
// -------------------------------------------------------------------------------------

/** Opción de catálogo tal como la devuelve la RPC para pintar chips (sin ids sensibles). */
export interface CatalogChip {
  id: string;
  label: string;
}

/** Agregado de reseñas `published` compute-on-read. `count=0` ⇒ "Sin opiniones aún". */
export interface ProfileRating {
  average: number;
  count: number;
}

/** Servicio de marketplace mostrado en la tarjeta (individual · en línea · 50 min · precio). */
export interface MarketplaceService {
  display_name: string;
  price_mxn: number;
  duration_minutes: number;
}

/** Una tarjeta del directorio. NO trae teléfono/INE/slots/fixed_meeting_url (allowlist §L439). */
export interface DirectoryProfile {
  slug: string;
  display_name: string;
  photo_url: string | null;
  is_verified: boolean;
  years_experience: number | null;
  about_me_excerpt: string; // ≤200 chars, ya recortado por la RPC
  catalog: {
    areas: CatalogChip[]; // top 3
    populations: CatalogChip[];
    approaches: CatalogChip[];
  };
  rating: ProfileRating;
  marketplace_service: MarketplaceService;
}

/** Qué dimensiones soltó la relajación progresiva: `none` | lista | `all` (~L426). */
type RelaxedFilters = 'none' | 'all' | Array<'approaches' | 'populations' | 'areas'>;

/** Salida completa: tarjetas + paginación + bandera de relajación. */
export interface SearchProfilesResult {
  profiles: DirectoryProfile[];
  page: number;
  page_size: number;
  total_count: number;
  total_pages: number;
  has_previous: boolean;
  has_next: boolean;
  relaxed_filters: RelaxedFilters;
}

// -------------------------------------------------------------------------------------
// Entrada de la RPC construida desde la URL. Todos los filtros opcionales; page_size fijo 10.
// -------------------------------------------------------------------------------------

const PAGE_SIZE = 10; // Fijo/limitado a 10 en el MVP (INVALID_INPUT si excede) — MARKETPLACE.md §L387.

interface SearchFilters {
  area_ids: string[];
  population_ids: string[];
  approach_ids: string[];
  max_price_mxn: number | null;
  search: string | null;
  page: number;
}

/** Los searchParams de Next 15 llegan como Promise; cada clave es string | string[] | undefined. */
type RawSearchParams = Record<string, string | string[] | undefined>;

// -------------------------------------------------------------------------------------
// Helpers de parseo de la URL → filtros. El saneo profundo (existencia/type de cada id,
// comodines de `search`) lo hace la RPC (SECURITY DEFINER); aquí solo normalizamos forma.
// -------------------------------------------------------------------------------------

/** Lee un multivaluado admitiendo `?area_ids=a&area_ids=b` y `?area_ids=a,b`. */
function readIdList(raw: string | string[] | undefined): string[] {
  if (!raw) return [];
  const values = Array.isArray(raw) ? raw : [raw];
  return values
    .flatMap((v) => v.split(','))
    .map((v) => v.trim())
    .filter((v) => v.length > 0);
}

/** Precio techo: entero > 0 o null (la RPC valida el rango real). */
function readPrice(raw: string | string[] | undefined): number | null {
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (!value) return null;
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/** Página ≥ 1 (default 1). */
function readPage(raw: string | string[] | undefined): number {
  const value = Array.isArray(raw) ? raw[0] : raw;
  const n = Number.parseInt(value ?? '1', 10);
  return Number.isFinite(n) && n > 0 ? n : 1;
}

/** Nombre a buscar: recortado; vacío ⇒ null. La RPC quita comodines crudos. */
function readSearch(raw: string | string[] | undefined): string | null {
  const value = Array.isArray(raw) ? raw[0] : raw;
  const trimmed = value?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : null;
}

function parseFilters(params: RawSearchParams): SearchFilters {
  return {
    area_ids: readIdList(params.area_ids),
    population_ids: readIdList(params.population_ids),
    approach_ids: readIdList(params.approach_ids),
    max_price_mxn: readPrice(params.max_price_mxn),
    search: readSearch(params.search),
    page: readPage(params.page),
  };
}

/** ¿Hay algún filtro activo? Distingue "Vacío (con filtros)" de "Vacío (sin filtros)". */
function hasActiveFilters(f: SearchFilters): boolean {
  return (
    f.area_ids.length > 0 ||
    f.population_ids.length > 0 ||
    f.approach_ids.length > 0 ||
    f.max_price_mxn !== null ||
    f.search !== null
  );
}

/** Reconstruye el querystring conservando filtros y fijando `page` (para la paginación). */
function buildQuery(f: SearchFilters, page: number): string {
  const qs = new URLSearchParams();
  f.area_ids.forEach((id) => qs.append('area_ids', id));
  f.population_ids.forEach((id) => qs.append('population_ids', id));
  f.approach_ids.forEach((id) => qs.append('approach_ids', id));
  if (f.max_price_mxn !== null) qs.set('max_price_mxn', String(f.max_price_mxn));
  if (f.search) qs.set('search', f.search);
  if (page > 1) qs.set('page', String(page));
  const s = qs.toString();
  return s ? `/psicologos?${s}` : '/psicologos';
}

// -------------------------------------------------------------------------------------
// Copys de la relajación progresiva (MARKETPLACE.md §L419-423). Solo pintamos lo que la
// RPC ya decidió; no re-decidimos qué se soltó.
// -------------------------------------------------------------------------------------

function relaxedBannerText(relaxed: RelaxedFilters, filtersActive: boolean): string | null {
  if (relaxed === 'none') return null;
  if (relaxed === 'all') {
    return filtersActive
      ? 'No hay profesionales que cumplan todos tus filtros, pero te mostramos otras opciones.'
      : null; // sin filtros previos, "all" es simplemente el directorio por rotación: sin aviso.
  }
  return 'Ajustamos tu búsqueda: te mostramos también profesionales que no cubren todos tus filtros.';
}

// =====================================================================================
// Página. searchParams (Next 15) es Promise; se resuelve en el servidor antes de renderizar.
// El estado "Cargando" (skeleton de 10 tarjetas, marketplace-listado §Estados) lo cubre el
// `loading.tsx` hermano vía Suspense mientras esta RPC resuelve — no se pinta aquí.
// =====================================================================================

export default async function DirectorioPsicologosPage({
  searchParams,
}: {
  searchParams: Promise<RawSearchParams>;
}) {
  const params = await searchParams;
  const filters = parseFilters(params);
  const filtersActive = hasActiveFilters(filters);

  // FAB de afinidad: la cookie NO autoritativa `affinity_filters` solo cambia el affordance
  // (marketplace-listado §Visibilidad). El conjunto real de filtros ya viene de la URL.
  const cookieStore = await cookies();
  const affinityApplied = cookieStore.get('affinity_filters') != null;

  // --- Llamada a la RPC pública (ANON key). Un fallo de red/dominio ⇒ estado "Error". ---
  let result: SearchProfilesResult | null = null;
  let errored = false;
  try {
    result = await rpcPublic<SearchProfilesResult>('search_marketplace_profiles', {
      area_ids: filters.area_ids,
      population_ids: filters.population_ids,
      approach_ids: filters.approach_ids,
      max_price_mxn: filters.max_price_mxn,
      search: filters.search,
      page: filters.page,
      page_size: PAGE_SIZE, // fijo: el cliente no negocia el tamaño de página
    });
  } catch (err) {
    // No filtramos detalles internos al usuario; el código de dominio queda para logs/handler.
    errored = err instanceof MarketplaceRpcError || err instanceof Error;
    if (!errored) throw err;
  }

  return (
    <main style={{ minHeight: '100vh' }}>
      {/* 1. App bar: logo Agenda Psi + acceso "Soy profesional" (marketplace-listado §Jerarquía.1). */}
      <header
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 'var(--s16)',
          padding: 'var(--s16) var(--s20)',
          borderBottom: '1px solid var(--border)',
          background: 'var(--surface)',
        }}
      >
        <Link
          href="/psicologos"
          style={{
            fontFamily: 'var(--font-display)',
            fontWeight: 800,
            fontSize: 18,
            color: 'var(--ink-900)',
            textDecoration: 'none',
          }}
        >
          Agenda Psi
        </Link>
        {/* Enlace neutro: el morado se reserva para el CTA único de la pantalla (DISENO_UI §1). */}
        <Link href="/landing-profesional" className="btn-secondary" style={{ textDecoration: 'none' }}>
          Soy profesional
        </Link>
      </header>

      <div style={{ maxWidth: 880, margin: '0 auto', padding: 'var(--s24) var(--s16) var(--s32)' }}>
        {/* 2. Encabezado. */}
        <section style={{ marginBottom: 'var(--s24)' }}>
          <h1
            style={{
              fontFamily: 'var(--font-display)',
              fontWeight: 700,
              fontSize: 26,
              lineHeight: 1.2,
              color: 'var(--ink-900)',
              margin: '0 0 var(--s8)',
            }}
          >
            Psicólogos validados para acompañarte
          </h1>
          <p style={{ color: 'var(--ink-500)', fontSize: 15, margin: 0 }}>
            Encuentra un profesional verificado, elige tu horario y agenda tu sesión en línea.
          </p>
        </section>

        {/* 3. Buscador + Filtros + Test de afinidad. Interacción ⇒ Client Component; recibe los
            filtros actuales (desde la URL) y el estado del FAB, y re-consulta navegando la URL. */}
        <FilterBar
          initialFilters={filters}
          affinityApplied={affinityApplied}
        />

        {/* --- Estado ERROR (fallo de red) — marketplace-listado §Estados. --- */}
        {errored || !result ? (
          <section
            className="card"
            role="alert"
            style={{ padding: 'var(--s24)', textAlign: 'center', marginTop: 'var(--s20)' }}
          >
            <p style={{ color: 'var(--ink-900)', fontWeight: 600, margin: '0 0 var(--s12)' }}>
              No pudimos cargar el directorio
            </p>
            <p style={{ color: 'var(--ink-500)', fontSize: 14, margin: '0 0 var(--s16)' }}>
              Revisa tu conexión e inténtalo de nuevo.
            </p>
            {/* Reintentar = recargar la misma URL con los mismos filtros. */}
            <Link href={buildQuery(filters, filters.page)} className="cta-primary" style={{ textDecoration: 'none' }}>
              Reintentar
            </Link>
          </section>
        ) : result.total_count === 0 ? (
          // --- Estado VACÍO. Distingue con/sin filtros (marketplace-listado §Estados). ---
          <section
            className="card"
            style={{ padding: 'var(--s24)', textAlign: 'center', marginTop: 'var(--s20)' }}
          >
            {filtersActive ? (
              <>
                <p style={{ color: 'var(--ink-900)', fontWeight: 600, margin: '0 0 var(--s12)' }}>
                  Sin resultados con esos filtros
                </p>
                <p style={{ color: 'var(--ink-500)', fontSize: 14, margin: '0 0 var(--s16)' }}>
                  Prueba con menos filtros o amplía el precio máximo.
                </p>
                <Link href="/psicologos" className="btn-secondary" style={{ textDecoration: 'none' }}>
                  Limpiar filtros
                </Link>
              </>
            ) : (
              <p style={{ color: 'var(--ink-700)', fontWeight: 600, margin: 0 }}>
                Aún no hay profesionales disponibles.
              </p>
            )}
          </section>
        ) : (
          // --- Estado CON RESULTADOS. ---
          <section style={{ marginTop: 'var(--s20)' }}>
            {/* Banner de relajación progresiva, si la RPC soltó dimensiones. */}
            {(() => {
              const banner = relaxedBannerText(result.relaxed_filters, filtersActive);
              return banner ? (
                <p
                  role="status"
                  style={{
                    background: 'var(--purple-100)',
                    color: 'var(--purple-700)',
                    border: '1px solid var(--purple-300)',
                    borderRadius: 'var(--radius-md)',
                    padding: 'var(--s12) var(--s16)',
                    fontSize: 14,
                    margin: '0 0 var(--s16)',
                  }}
                >
                  {banner}
                </p>
              ) : null;
            })()}

            {/* 4. Contador. */}
            <p className="num" style={{ color: 'var(--ink-500)', fontSize: 14, margin: '0 0 var(--s16)' }}>
              {result.total_count}{' '}
              {result.total_count === 1 ? 'profesional encontrado' : 'profesionales encontrados'}
            </p>

            {/* 5. Tarjetas (una por resultado). ProfileCard NO recibe ni pinta slots (D-B). */}
            <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'grid', gap: 'var(--s16)' }}>
              {result.profiles.map((profile) => (
                <li key={profile.slug}>
                  <ProfileCard profile={profile} />
                </li>
              ))}
            </ul>

            {/* 6. Paginación: Anterior · Página N de M · Siguiente (10 por página). Como enlaces
                (SSR/shareable); los botones inexistentes se degradan a texto deshabilitado. */}
            {result.total_pages > 1 && (
              <nav
                aria-label="Paginación de resultados"
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  gap: 'var(--s12)',
                  marginTop: 'var(--s24)',
                }}
              >
                {result.has_previous ? (
                  <Link
                    href={buildQuery(filters, result.page - 1)}
                    className="btn-secondary"
                    rel="prev"
                    style={{ textDecoration: 'none' }}
                  >
                    Anterior
                  </Link>
                ) : (
                  <span className="btn-secondary" aria-disabled="true" style={{ opacity: 0.5 }}>
                    Anterior
                  </span>
                )}

                <span className="num" style={{ color: 'var(--ink-500)', fontSize: 14 }}>
                  Página {result.page} de {result.total_pages}
                </span>

                {result.has_next ? (
                  <Link
                    href={buildQuery(filters, result.page + 1)}
                    className="btn-secondary"
                    rel="next"
                    style={{ textDecoration: 'none' }}
                  >
                    Siguiente
                  </Link>
                ) : (
                  <span className="btn-secondary" aria-disabled="true" style={{ opacity: 0.5 }}>
                    Siguiente
                  </span>
                )}
              </nav>
            )}
          </section>
        )}
      </div>
    </main>
  );
}
