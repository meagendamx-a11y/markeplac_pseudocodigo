'use client';

// =====================================================================================
// components/FilterBar.tsx — Barra de búsqueda + filtros del directorio del marketplace.
//
// Contrato: paginas/marketplace-listado.md
//   · §Jerarquía.3: Buscador (search, por nombre) + botón Filtros (área/población/enfoque/
//     precio) + botón Test de afinidad (FAB/chip).
//   · §Navegación (decisión de widget): Filtros → DIÁLOGO/SHEET (multi-select de catálogo +
//     rango de precio) → re-consulta. Test de afinidad → PÁGINA /afinidad (regresa con
//     affinity_filters aplicados).
//   · §Visibilidad condicional: sin affinity_filters ⇒ botón "Test de afinidad"; con filtros
//     ⇒ chip "Afinidad aplicada" + "Repetir".
//   · §No debe: aceptar orden del cliente (el orden lo fija el servidor). Esta barra NO envía
//     ningún parámetro de orden; solo acota el conjunto (filtros) — la relajación progresiva
//     y su banner los decide/pinta el servidor (search_marketplace_profiles / page.tsx), no
//     este componente (el precio y `search` son límites DUROS que no entran a la relajación,
//     MARKETPLACE.md §L423-424).
//
// RESPONSABILIDAD (y SOLO esto): componente de cliente que traduce la interacción del paciente
// (escribir un nombre, elegir filtros de catálogo/precio, abrir el test de afinidad) en una
// NAVEGACIÓN de la URL de /psicologos. El estado vive en el QUERYSTRING (shareable/SSR/SEO),
// no en estado de cliente persistente. La página (Server Component) re-consulta con esos
// searchParams; este componente nunca llama a `search_marketplace_profiles` ni reordena.
//
// INVARIANTES DE SEGURIDAD (MARKETPLACE.md / SEGURIDAD DURA) que aplican aquí:
//   · NADA en localStorage (§cookie, "No usar localStorage"): el estado va en la URL. La cookie
//     `affinity_filters` es Secure·HttpOnly y la escribe el SERVIDOR (allowlist estricta) — por
//     eso este cliente NO la lee (HttpOnly la oculta a JS); recibe `affinityApplied` YA
//     resuelto por el servidor (page.tsx la leyó con next/headers) y solo pinta el affordance.
//   · service_role JAMÁS en el navegador: este componente no habla con Supabase. El catálogo
//     de opciones se pide, si hace falta, a un Route Handler PÚBLICO (`/api/marketplace/catalog`,
//     ANON key server-side, allowlist id/label — sin datos privados/clínicos). Si el fetch
//     falla, el sheet se degrada a "solo precio + nombre" (misma filosofía que app/afinidad),
//     nunca rompe la pantalla.
//   · Sin datos clínicos ni de pago en el cliente: solo se manejan ids de catálogo (uuid) y un
//     techo de precio — exactamente el shape público de `search_marketplace_profiles`.
//
// DISEÑO (DISENO_UI · styles/tokens.css): sin colores hardcodeados (todo var(--*)); regla del
// morado = UN solo CTA primario morado por superficie (aquí: "Aplicar filtros" DENTRO del
// sheet; la barra usa .btn-secondary / chips tintados). Foco visible heredado de tokens.css;
// área táctil ≥ --min-touch; UI en español (ids/props en inglés).
// =====================================================================================

import { useCallback, useEffect, useId, useMemo, useRef, useState, type FormEvent } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';

// -------------------------------------------------------------------------------------
// Tipos. `ActiveFilters` es el shape que pinta la URL (mismo que arma page.tsx). Estructural:
// coincide con `SearchFilters` de app/psicologos/page.tsx sin acoplarse a su definición.
// -------------------------------------------------------------------------------------

/** Filtros vigentes tal como llegan desde la URL (page.tsx los parsea de los searchParams). */
export interface ActiveFilters {
  area_ids: string[];
  population_ids: string[];
  approach_ids: string[];
  max_price_mxn: number | null;
  search: string | null;
  page: number;
}

/** Dimensiones de catálogo filtrables. Mismo vocabulario que `catalog_options.type`. */
type CatalogDimension = 'area' | 'population' | 'approach';

/** Opción de catálogo para pintar en el sheet. NUNCA texto libre del paciente: id + etiqueta. */
export interface CatalogOption {
  id: string; // uuid — el id que viaja como filtro
  label: string; // etiqueta en español
  description?: string | null;
}

/** Catálogo agrupado por dimensión (misma fuente pública que usa app/afinidad). */
export interface CatalogGroups {
  area: CatalogOption[];
  population: CatalogOption[];
  approach: CatalogOption[];
}

const EMPTY_CATALOG: CatalogGroups = { area: [], population: [], approach: [] };

interface FilterBarProps {
  /** Filtros vigentes (desde la URL) — snapshot inicial del buscador y del sheet. */
  initialFilters: ActiveFilters;
  /** ¿Hay `affinity_filters` en la cookie? Lo resuelve el SERVIDOR (cookie HttpOnly). */
  affinityApplied: boolean;
  /**
   * Catálogo ya cargado en el servidor (opcional). Si se provee, el sheet no hace fetch
   * (mejor: evita el round-trip y es testeable). Si se omite, se pide perezosamente al abrir.
   */
  catalogOptions?: CatalogGroups;
  /** Endpoint público del catálogo (override para tests). Server-only lee la ANON key detrás. */
  catalogEndpoint?: string;
}

// -------------------------------------------------------------------------------------
// Presupuesto: mismos presets no clínicos que app/afinidad (techos de precio predefinidos).
// El precio es un límite DURO del paciente (no entra a la relajación, MARKETPLACE.md §L424).
// -------------------------------------------------------------------------------------

const PRICE_PRESETS: ReadonlyArray<{ value: number; label: string }> = [
  { value: 500, label: 'Hasta $500' },
  { value: 800, label: 'Hasta $800' },
  { value: 1200, label: 'Hasta $1,200' },
  { value: 2000, label: 'Hasta $2,000' },
];

const DEFAULT_CATALOG_ENDPOINT = '/api/marketplace/catalog';

// -------------------------------------------------------------------------------------
// Construcción de la URL de /psicologos. ESPEJO de `buildQuery` en page.tsx para que el
// servidor parsee idéntico: ids repetidos (?area_ids=a&area_ids=b), precio/nombre como set,
// y SIEMPRE se resetea la paginación (un cambio de filtros invalida la página actual).
// -------------------------------------------------------------------------------------

function buildListadoUrl(filters: {
  area_ids: string[];
  population_ids: string[];
  approach_ids: string[];
  max_price_mxn: number | null;
  search: string | null;
}): string {
  const qs = new URLSearchParams();
  filters.area_ids.forEach((id) => qs.append('area_ids', id));
  filters.population_ids.forEach((id) => qs.append('population_ids', id));
  filters.approach_ids.forEach((id) => qs.append('approach_ids', id));
  if (filters.max_price_mxn !== null) qs.set('max_price_mxn', String(filters.max_price_mxn));
  if (filters.search && filters.search.trim().length > 0) qs.set('search', filters.search.trim());
  // NOTA: no se escribe `page` ⇒ el servidor cae a page=1 (reset intencional al filtrar).
  const s = qs.toString();
  return s ? `/psicologos?${s}` : '/psicologos';
}

/** Normaliza la respuesta del endpoint de catálogo a `CatalogGroups` (defensivo, allowlist). */
function normalizeCatalog(raw: unknown): CatalogGroups {
  if (!raw || typeof raw !== 'object') return EMPTY_CATALOG;
  const o = raw as Record<string, unknown>;
  const pick = (key: CatalogDimension): CatalogOption[] => {
    const list = o[key];
    if (!Array.isArray(list)) return [];
    return list
      .map((row): CatalogOption | null => {
        if (!row || typeof row !== 'object') return null;
        const r = row as Record<string, unknown>;
        if (typeof r.id !== 'string' || typeof r.label !== 'string') return null;
        return {
          id: r.id,
          label: r.label,
          description: typeof r.description === 'string' ? r.description : null,
        };
      })
      .filter((x): x is CatalogOption => x !== null);
  };
  return { area: pick('area'), population: pick('population'), approach: pick('approach') };
}

// =====================================================================================
// Componente
// =====================================================================================

export function FilterBar({
  initialFilters,
  affinityApplied,
  catalogOptions,
  catalogEndpoint = DEFAULT_CATALOG_ENDPOINT,
}: FilterBarProps) {
  const router = useRouter();
  const dialogTitleId = useId();

  // --- Buscador por nombre. Controlado; se confirma al enviar el <form> (Enter o botón). ---
  const [search, setSearch] = useState<string>(initialFilters.search ?? '');

  // --- Estado del sheet de filtros. ---
  const [sheetOpen, setSheetOpen] = useState(false);

  // Draft de selección DENTRO del sheet: no toca la URL hasta "Aplicar" (evita re-consultas
  // por cada clic). Se re-siembra desde los filtros vigentes cada vez que se abre.
  const [draftArea, setDraftArea] = useState<string[]>(initialFilters.area_ids);
  const [draftPopulation, setDraftPopulation] = useState<string[]>(initialFilters.population_ids);
  const [draftApproach, setDraftApproach] = useState<string[]>(initialFilters.approach_ids);
  const [draftPrice, setDraftPrice] = useState<number | null>(initialFilters.max_price_mxn);

  // --- Catálogo: prop (SSR) o fetch perezoso al abrir. Degrada a "solo precio" si falla. ---
  const [catalog, setCatalog] = useState<CatalogGroups>(catalogOptions ?? EMPTY_CATALOG);
  const [catalogStatus, setCatalogStatus] = useState<'idle' | 'loading' | 'ready' | 'error'>(
    catalogOptions ? 'ready' : 'idle',
  );

  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const sheetRef = useRef<HTMLDivElement | null>(null);

  // Nº de filtros de catálogo/precio activos (para el badge del botón "Filtros"). `search`
  // se muestra en el propio input, así que no cuenta aquí.
  const activeCount = useMemo(
    () =>
      initialFilters.area_ids.length +
      initialFilters.population_ids.length +
      initialFilters.approach_ids.length +
      (initialFilters.max_price_mxn !== null ? 1 : 0),
    [initialFilters],
  );

  // Carga perezosa del catálogo la primera vez que se abre el sheet (si no vino por prop).
  useEffect(() => {
    if (!sheetOpen || catalogStatus !== 'idle') return;
    let cancelled = false;
    setCatalogStatus('loading');
    fetch(catalogEndpoint, { headers: { Accept: 'application/json' } })
      .then((res) => {
        if (!res.ok) throw new Error(`catalog ${res.status}`);
        return res.json();
      })
      .then((json) => {
        if (cancelled) return;
        setCatalog(normalizeCatalog(json));
        setCatalogStatus('ready');
      })
      .catch(() => {
        // Degradación (no romper la pantalla): el sheet queda con "solo precio + nombre".
        if (cancelled) return;
        setCatalog(EMPTY_CATALOG);
        setCatalogStatus('error');
      });
    return () => {
      cancelled = true;
    };
  }, [sheetOpen, catalogStatus, catalogEndpoint]);

  // Abrir: re-sembrar el draft desde los filtros vigentes (la URL es la verdad).
  const openSheet = useCallback(() => {
    setDraftArea(initialFilters.area_ids);
    setDraftPopulation(initialFilters.population_ids);
    setDraftApproach(initialFilters.approach_ids);
    setDraftPrice(initialFilters.max_price_mxn);
    setSheetOpen(true);
  }, [initialFilters]);

  // Cerrar: devolver el foco al disparador (accesibilidad).
  const closeSheet = useCallback(() => {
    setSheetOpen(false);
    triggerRef.current?.focus();
  }, []);

  // Escape cierra + foco inicial dentro del sheet al abrir.
  useEffect(() => {
    if (!sheetOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        closeSheet();
      }
    };
    document.addEventListener('keydown', onKey);
    // Mover el foco al panel (contenedor con tabIndex=-1) al montar.
    sheetRef.current?.focus();
    return () => document.removeEventListener('keydown', onKey);
  }, [sheetOpen, closeSheet]);

  // Toggle de una opción en un draft multi-select (dimensión = OR interno, se acumulan).
  const toggle = useCallback(
    (dimension: CatalogDimension, id: string) => {
      const setter =
        dimension === 'area'
          ? setDraftArea
          : dimension === 'population'
          ? setDraftPopulation
          : setDraftApproach;
      setter((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));
    },
    [],
  );

  const draftFor = (dimension: CatalogDimension): string[] =>
    dimension === 'area' ? draftArea : dimension === 'population' ? draftPopulation : draftApproach;

  // Enviar el buscador por nombre: navegar conservando los filtros de catálogo/precio vigentes.
  const submitSearch = useCallback(
    (e: FormEvent<HTMLFormElement>) => {
      e.preventDefault();
      const trimmed = search.trim();
      router.push(
        buildListadoUrl({
          area_ids: initialFilters.area_ids,
          population_ids: initialFilters.population_ids,
          approach_ids: initialFilters.approach_ids,
          max_price_mxn: initialFilters.max_price_mxn,
          search: trimmed.length > 0 ? trimmed : null,
        }),
      );
    },
    [search, router, initialFilters],
  );

  // Aplicar filtros del sheet: combinar draft (catálogo/precio) con el `search` vigente y navegar.
  const applyFilters = useCallback(() => {
    setSheetOpen(false);
    triggerRef.current?.focus();
    const trimmed = search.trim();
    router.push(
      buildListadoUrl({
        area_ids: draftArea,
        population_ids: draftPopulation,
        approach_ids: draftApproach,
        max_price_mxn: draftPrice,
        search: trimmed.length > 0 ? trimmed : null,
      }),
    );
  }, [router, draftArea, draftPopulation, draftApproach, draftPrice, search]);

  // Limpiar (dentro del sheet): vacía SOLO el draft de catálogo/precio; el `search` se
  // conserva en la barra (es un límite independiente). No navega hasta "Aplicar".
  const clearDraft = useCallback(() => {
    setDraftArea([]);
    setDraftPopulation([]);
    setDraftApproach([]);
    setDraftPrice(null);
  }, []);

  const dimensions: ReadonlyArray<{ key: CatalogDimension; title: string }> = [
    { key: 'area', title: 'Áreas / motivo de consulta' },
    { key: 'population', title: 'Para quién es la consulta' },
    { key: 'approach', title: 'Enfoque terapéutico' },
  ];

  return (
    <div className="fb">
      <style>{FILTER_BAR_CSS}</style>

      {/* --- Fila de controles: Buscador · Filtros · Afinidad. --- */}
      <div className="fb__row">
        {/* Buscador por nombre. Envío por Enter o por el botón (SSR-friendly: navega la URL). */}
        <form className="fb__search" role="search" onSubmit={submitSearch}>
          <label htmlFor="fb-search" className="fb__sr-only">
            Buscar por nombre
          </label>
          <input
            id="fb-search"
            type="search"
            className="fb__input"
            placeholder="Buscar por nombre…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            autoComplete="off"
            enterKeyHint="search"
          />
          <button type="submit" className="btn-secondary fb__search-btn">
            Buscar
          </button>
        </form>

        {/* Botón Filtros → abre el sheet. Badge con el nº de filtros de catálogo/precio activos. */}
        <button
          ref={triggerRef}
          type="button"
          className="btn-secondary fb__filters-btn"
          aria-haspopup="dialog"
          aria-expanded={sheetOpen}
          onClick={openSheet}
        >
          Filtros
          {activeCount > 0 ? (
            <span className="fb__badge num" aria-label={`${activeCount} filtros activos`}>
              {activeCount}
            </span>
          ) : null}
        </button>

        {/* Afinidad: chip "aplicada" + "Repetir" si hay cookie; si no, entrada "Test de afinidad". */}
        {affinityApplied ? (
          <div className="fb__affinity">
            <span className="fb__chip fb__chip--ok" role="status">
              Afinidad aplicada
            </span>
            <Link href="/afinidad?step=0" className="fb__link">
              Repetir
            </Link>
          </div>
        ) : (
          <Link href="/afinidad" className="fb__chip fb__chip--cta">
            Test de afinidad
          </Link>
        )}
      </div>

      {/* --- Sheet/diálogo de filtros (multi-select de catálogo + rango de precio). --- */}
      {sheetOpen ? (
        <div className="fb__scrim" onClick={closeSheet}>
          {/* stopPropagation: clic dentro del panel no cierra. */}
          <div
            ref={sheetRef}
            className="fb__sheet card"
            role="dialog"
            aria-modal="true"
            aria-labelledby={dialogTitleId}
            tabIndex={-1}
            onClick={(e) => e.stopPropagation()}
          >
            <div className="fb__sheet-head">
              <h2 id={dialogTitleId} className="fb__sheet-title">
                Filtrar profesionales
              </h2>
              <button
                type="button"
                className="fb__icon-btn"
                aria-label="Cerrar filtros"
                onClick={closeSheet}
              >
                ✕
              </button>
            </div>

            <div className="fb__sheet-body">
              {/* Aviso si el catálogo no cargó: el sheet sigue usable con precio (degradación). */}
              {catalogStatus === 'error' ? (
                <p className="fb__notice" role="status">
                  No pudimos cargar las categorías; puedes filtrar por precio o buscar por nombre.
                </p>
              ) : null}

              {catalogStatus === 'loading' ? (
                <p className="fb__notice" role="status">
                  Cargando categorías…
                </p>
              ) : null}

              {/* Multi-select por dimensión (intra-dimensión = OR; inter = AND; lo resuelve la RPC). */}
              {dimensions.map(({ key, title }) => {
                const options = catalog[key];
                if (options.length === 0) return null;
                const selected = draftFor(key);
                return (
                  <fieldset key={key} className="fb__group">
                    <legend className="fb__group-title">{title}</legend>
                    <div className="fb__options">
                      {options.map((opt) => (
                        <label key={opt.id} className="fb__option">
                          <input
                            type="checkbox"
                            name={`${key}_ids`}
                            value={opt.id}
                            checked={selected.includes(opt.id)}
                            onChange={() => toggle(key, opt.id)}
                          />
                          <span className="fb__option-label">{opt.label}</span>
                        </label>
                      ))}
                    </div>
                  </fieldset>
                );
              })}

              {/* Rango de precio (techo). Radios: presets + "Sin límite". Límite DURO. */}
              <fieldset className="fb__group">
                <legend className="fb__group-title">Precio por sesión</legend>
                <div className="fb__options fb__options--wrap">
                  <label className="fb__option fb__option--pill">
                    <input
                      type="radio"
                      name="max_price_mxn"
                      checked={draftPrice === null}
                      onChange={() => setDraftPrice(null)}
                    />
                    <span className="fb__option-label">Sin límite</span>
                  </label>
                  {PRICE_PRESETS.map((p) => (
                    <label key={p.value} className="fb__option fb__option--pill">
                      <input
                        type="radio"
                        name="max_price_mxn"
                        value={p.value}
                        checked={draftPrice === p.value}
                        onChange={() => setDraftPrice(p.value)}
                      />
                      <span className="fb__option-label num">{p.label}</span>
                    </label>
                  ))}
                </div>
              </fieldset>
            </div>

            {/* Acciones del sheet. Único CTA morado de ESTA superficie: "Aplicar filtros". */}
            <div className="fb__sheet-foot">
              <button type="button" className="fb__link fb__clear" onClick={clearDraft}>
                Limpiar filtros
              </button>
              <button type="button" className="cta-primary fb__apply" onClick={applyFilters}>
                Aplicar filtros
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}

// -------------------------------------------------------------------------------------
// Estilos: SOLO layout/tipografía; color/radio/espaciado desde tokens.css (var(--*)).
// Regla del morado: morado sólido únicamente en .cta-primary ("Aplicar filtros", dentro del
// sheet). El resto = neutros/tints. Foco visible lo aporta tokens.css. Área táctil ≥ --min-touch.
// -------------------------------------------------------------------------------------

const FILTER_BAR_CSS = `
.fb { display: block; }

.fb__row {
  display: flex; flex-wrap: wrap; align-items: center; gap: var(--s12);
}

/* Buscador ocupa el espacio disponible; en móvil pasa a ancho completo. */
.fb__search { display: flex; gap: var(--s8); flex: 1 1 240px; min-width: 200px; }
.fb__input {
  flex: 1 1 auto; min-width: 0; min-height: var(--min-touch);
  padding: 0 var(--s12);
  font-family: var(--font-body); font-size: 15px; color: var(--ink-900);
  background: var(--surface); border: 1px solid var(--border);
  border-radius: var(--radius-md);
}
.fb__input::placeholder { color: var(--ink-500); }
.fb__search-btn { flex: 0 0 auto; }

.fb__filters-btn { position: relative; display: inline-flex; align-items: center; gap: var(--s8); }
.fb__badge {
  display: inline-flex; align-items: center; justify-content: center;
  min-width: 20px; height: 20px; padding: 0 6px;
  font-size: 12px; font-weight: 700; line-height: 1;
  color: var(--white); background: var(--purple-600);
  border-radius: var(--radius-round);
}

/* Afinidad: chip tintado (nunca morado sólido — la regla del morado se reserva al CTA). */
.fb__affinity { display: inline-flex; align-items: center; gap: var(--s8); }
.fb__chip {
  display: inline-flex; align-items: center; min-height: var(--min-touch);
  padding: 0 var(--s16); border-radius: var(--radius-round);
  font-family: var(--font-body); font-weight: 600; font-size: 14px;
  text-decoration: none;
}
.fb__chip--cta { color: var(--purple-700); background: var(--purple-100); border: 1px solid var(--purple-300); }
.fb__chip--cta:hover { background: var(--purple-200); }
.fb__chip--ok { color: var(--success-700); background: var(--success-100); }
.fb__link {
  color: var(--purple-700); text-decoration: none; font-size: 14px; font-weight: 600;
  min-height: var(--min-touch); display: inline-flex; align-items: center;
  background: transparent; border: 0; cursor: pointer; padding: 0 var(--s4);
}
.fb__link:hover { text-decoration: underline; }

/* --- Sheet / diálogo modal --- */
.fb__scrim {
  position: fixed; inset: 0; z-index: 50;
  background: var(--scrim); backdrop-filter: blur(1.5px);
  display: flex; align-items: flex-end; justify-content: center;
}
.fb__sheet {
  width: 100%; max-width: 560px; max-height: 88vh;
  display: flex; flex-direction: column;
  border-radius: var(--radius-sheet) var(--radius-sheet) 0 0;
  overflow: hidden;
}
@media (min-width: 640px) {
  .fb__scrim { align-items: center; padding: var(--s24); }
  .fb__sheet { border-radius: var(--radius-xl); max-height: 82vh; }
}

.fb__sheet-head {
  display: flex; align-items: center; justify-content: space-between; gap: var(--s16);
  padding: var(--s20) var(--s24); border-bottom: 1px solid var(--border);
}
.fb__sheet-title {
  font-family: var(--font-display); font-weight: 700; font-size: 18px;
  color: var(--ink-900); margin: 0;
}
.fb__icon-btn {
  min-width: var(--min-touch); min-height: var(--min-touch);
  display: inline-flex; align-items: center; justify-content: center;
  background: transparent; border: 0; border-radius: var(--radius-md);
  color: var(--ink-500); font-size: 16px; cursor: pointer;
}
.fb__icon-btn:hover { background: var(--purple-50); color: var(--ink-900); }

.fb__sheet-body { padding: var(--s20) var(--s24); overflow-y: auto; }
.fb__notice {
  margin: 0 0 var(--s16); padding: var(--s12) var(--s16);
  background: var(--purple-100); color: var(--purple-700);
  border: 1px solid var(--purple-300); border-radius: var(--radius-md);
  font-size: 14px;
}

.fb__group { border: 0; margin: 0 0 var(--s24); padding: 0; }
.fb__group-title {
  font-family: var(--font-display); font-weight: 700; font-size: 14px;
  color: var(--ink-700); padding: 0; margin: 0 0 var(--s12);
}
.fb__options { display: grid; gap: var(--s8); }
.fb__options--wrap { display: flex; flex-wrap: wrap; }

.fb__option {
  display: inline-flex; align-items: center; gap: var(--s12);
  min-height: var(--min-touch); padding: var(--s8) var(--s12);
  border: 1px solid var(--border); border-radius: var(--radius-md);
  background: var(--surface); cursor: pointer;
}
.fb__option:hover { border-color: var(--purple-300); background: var(--purple-50); }
.fb__option input { width: 18px; height: 18px; accent-color: var(--purple-600); }
/* Estado seleccionado: tint morado (jamás morado sólido en superficie). */
.fb__option:has(input:checked) { border-color: var(--purple-600); background: var(--purple-100); }
.fb__option-label { color: var(--ink-900); font-weight: 600; font-size: 14px; }
.fb__option--pill { border-radius: var(--radius-round); }

.fb__sheet-foot {
  display: flex; align-items: center; justify-content: space-between; gap: var(--s16);
  padding: var(--s16) var(--s24); border-top: 1px solid var(--border);
  background: var(--surface);
}
.fb__apply { flex: 0 0 auto; }
.fb__clear { flex: 0 0 auto; }

/* Etiqueta accesible sólo para lectores de pantalla. */
.fb__sr-only {
  position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px;
  overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; border: 0;
}
`;
