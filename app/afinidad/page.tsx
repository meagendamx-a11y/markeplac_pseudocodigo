// =====================================================================================
// app/afinidad/page.tsx — Marketplace · Test de afinidad (ligero) — Next.js App Router, SSR.
//
// Contrato: paginas/marketplace-afinidad.md  +  MARKETPLACE.md § "Test de afinidad (ligero)".
//   - NO es agente de IA, NO crea tabla nueva, NO produce score/ranking.
//   - Solo mapea respuestas → filtros del catálogo EXISTENTE (`catalog_options`:
//     area/population/approach) + `max_price_mxn`.
//   - La salida es EXACTAMENTE el objeto de filtros de `search_marketplace_profiles`:
//       { area_ids, population_ids, approach_ids, max_price_mxn }.
//   - Estados de pantalla (§ Estados): Intro · Pregunta N · Resultado · Ya realizado.
//
// POR QUÉ ES UN SERVER COMPONENT SIN JS DE CLIENTE (decisión de arquitectura + seguridad):
//   El único efecto persistente del test —escribir `affinity_filters` — DEBE hacerlo el
//   SERVIDOR en la cookie firmada (Secure·HttpOnly·SameSite=Lax); JAMÁS localStorage
//   (MARKETPLACE.md § cookie; SEGURIDAD DURA). Por eso el cuestionario es un formulario
//   multipaso 100% servidor: el "estado del wizard" (paso + respuestas acumuladas) viaja en
//   la URL (searchParams) y en inputs ocultos, no en estado de cliente ni en storage. El
//   commit final pasa por una Server Action que firma la cookie y redirige al listado. Así:
//     · no hay respuestas crudas ni datos clínicos en el navegador (solo ids de catálogo),
//     · no hay superficie de escritura de cookie desde JS,
//     · la validación (allowlist de ids contra `catalog_options`) ocurre en el servidor.
//
// SEGURIDAD (MARKETPLACE.md):
//   - service_role NUNCA aquí: catálogo se lee con la ANON key (lectura pública) vía
//     lib/supabase-server (server-only). Este árbol nunca escribe DB ni toca holds/pago.
//   - La cookie la escribe `setBookingSession` (lib/session-cookie, server-only): allowlist
//     estricta; `affinity_filters` es NO autoritativo y NO clínico (solo ids de catálogo).
//   - Cada id que se persiste se valida contra `catalog_options` (MARKETPLACE.md §L399):
//     cualquier id inexistente se descarta antes de firmar la cookie (anti cookie-poisoning).
//
// DISEÑO (DISENO_UI · styles/tokens.css): sin colores hardcodeados (todo var(--*)); la
//   "regla del morado" = UN solo CTA primario morado por pantalla (el resto es .btn-secondary
//   o enlace de texto); foco visible heredado de tokens.css; UI en español, ids en inglés.
// =====================================================================================

import type { ReactNode } from 'react';
import Link from 'next/link';
import { redirect } from 'next/navigation';

import { getPublicClient } from '../../lib/supabase-server';
import {
  getBookingSession,
  setBookingSession,
  type AffinityFilters,
} from '../../lib/session-cookie';

// El resultado depende de la cookie de sesión y del catálogo vivo ⇒ nunca cachear.
export const dynamic = 'force-dynamic';

// -------------------------------------------------------------------------------------
// Catálogo: se lee de `catalog_options` (misma fuente que los filtros del listado).
// type ∈ ('area','population','approach'); solo `is_active`; ordenado por display_order.
// -------------------------------------------------------------------------------------

type CatalogType = 'area' | 'population' | 'approach';

interface CatalogOption {
  id: string; // uuid — el id que viaja como filtro; jamás texto libre del paciente
  label: string; // etiqueta en español para la UI
  description: string | null;
}

interface Catalog {
  area: CatalogOption[];
  population: CatalogOption[];
  approach: CatalogOption[];
  /** id → type, para validar la allowlist en la Server Action (anti cookie-poisoning). */
  validIds: Map<string, CatalogType>;
}

/**
 * Lee las opciones de catálogo con la ANON key (lectura pública, server-only). Agrupa por
 * type y construye el set de ids válidos. Si la lectura falla, devuelve grupos vacíos: el
 * test se degrada a "solo precio" en vez de romper (la pantalla sigue siendo usable).
 */
async function loadCatalog(): Promise<Catalog> {
  const empty: Catalog = { area: [], population: [], approach: [], validIds: new Map() };

  const { data, error } = await getPublicClient()
    .from('catalog_options')
    .select('id, type, label, description, display_order')
    .eq('is_active', true)
    .order('display_order', { ascending: true, nullsFirst: false })
    .order('label', { ascending: true });

  if (error || !data) return empty;

  const catalog: Catalog = { area: [], population: [], approach: [], validIds: new Map() };
  for (const row of data as Array<{ id: string; type: CatalogType; label: string; description: string | null }>) {
    if (row.type !== 'area' && row.type !== 'population' && row.type !== 'approach') continue;
    catalog[row.type].push({ id: row.id, label: row.label, description: row.description });
    catalog.validIds.set(row.id, row.type);
  }
  return catalog;
}

// -------------------------------------------------------------------------------------
// Presupuesto por sesión → `max_price_mxn` (opcional). NO es catálogo: son techos de precio
// predefinidos (no clínicos). "Sin límite"/Saltar ⇒ undefined. Allowlist de valores server-side.
// -------------------------------------------------------------------------------------

const PRICE_PRESETS: ReadonlyArray<{ value: number; label: string }> = [
  { value: 500, label: 'Hasta $500' },
  { value: 800, label: 'Hasta $800' },
  { value: 1200, label: 'Hasta $1,200' },
  { value: 2000, label: 'Hasta $2,000' },
];
const PRICE_VALUES = new Set<number>(PRICE_PRESETS.map((p) => p.value));

// -------------------------------------------------------------------------------------
// Modelo de preguntas. Se construye desde el catálogo: una pregunta por dimensión con
// opciones; si una dimensión no tiene opciones activas, esa pregunta NO aparece y M baja
// (§ "opcionales … si el catálogo lo soporta"). El precio es siempre opcional.
// -------------------------------------------------------------------------------------

/** Clave del filtro de salida — EXACTAMENTE las de `search_marketplace_profiles`. */
type FilterKey = 'population_ids' | 'area_ids' | 'approach_ids' | 'max_price_mxn';

type Question =
  | { key: 'population_ids'; kind: 'single'; title: string; help: string; options: CatalogOption[] }
  | { key: 'area_ids'; kind: 'multi'; title: string; help: string; options: CatalogOption[] }
  | { key: 'approach_ids'; kind: 'multi'; title: string; help: string; options: CatalogOption[] }
  | { key: 'max_price_mxn'; kind: 'price'; title: string; help: string };

/** Orden y copy de las preguntas (§ Jerarquía / preguntas). Solo se incluyen las que aplican. */
function buildQuestions(catalog: Catalog): Question[] {
  const qs: Question[] = [];
  if (catalog.population.length > 0) {
    qs.push({
      key: 'population_ids',
      kind: 'single',
      title: '¿Para quién buscas apoyo?',
      help: 'Elige una opción.',
      options: catalog.population,
    });
  }
  if (catalog.area.length > 0) {
    qs.push({
      key: 'area_ids',
      kind: 'multi',
      title: '¿Qué te gustaría trabajar?',
      help: 'Puedes elegir varias.',
      options: catalog.area,
    });
  }
  if (catalog.approach.length > 0) {
    qs.push({
      key: 'approach_ids',
      kind: 'multi',
      title: '¿Con qué enfoque te sentirías más a gusto?',
      help: 'Opcional. Puedes elegir varias o saltar.',
      options: catalog.approach,
    });
  }
  // El presupuesto va al final y siempre es opcional (§4: "¿Tienes un presupuesto por sesión?").
  qs.push({
    key: 'max_price_mxn',
    kind: 'price',
    title: '¿Tienes un presupuesto por sesión?',
    help: 'Opcional. Úsalo como techo; puedes saltarlo.',
  });
  return qs;
}

// -------------------------------------------------------------------------------------
// Estado acumulado del wizard: viaja en la URL / inputs ocultos (no en cliente/storage).
// -------------------------------------------------------------------------------------

interface Answers {
  area_ids: string[];
  population_ids: string[];
  approach_ids: string[];
  max_price_mxn: number | null;
}

type RawSearchParams = Record<string, string | string[] | undefined>;

/** Lee un multivaluado admitiendo `?k=a&k=b` y `?k=a,b`; recorta y descarta vacíos. */
function readIdList(raw: string | string[] | undefined): string[] {
  if (!raw) return [];
  const values = Array.isArray(raw) ? raw : [raw];
  return values
    .flatMap((v) => v.split(','))
    .map((v) => v.trim())
    .filter((v) => v.length > 0);
}

function readPrice(raw: string | string[] | undefined): number | null {
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (!value) return null;
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) && PRICE_VALUES.has(n) ? n : null;
}

/** Solo forma: la validación fuerte (ids ∈ catálogo) la hace la Server Action al firmar. */
function readAnswers(params: RawSearchParams): Answers {
  return {
    area_ids: readIdList(params.area_ids),
    population_ids: readIdList(params.population_ids),
    approach_ids: readIdList(params.approach_ids),
    max_price_mxn: readPrice(params.max_price_mxn),
  };
}

/** `step` numérico ≥ 0; ausente/NaN ⇒ -1 (Intro / Ya realizado según cookie). */
function readStep(raw: string | string[] | undefined): number {
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (value == null) return -1;
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) && n >= 0 ? n : -1;
}

// -------------------------------------------------------------------------------------
// URL builders (SSR, sin JS): "Siguiente" es un submit GET del <form>; "Saltar" y "Repetir"
// son enlaces que sólo mueven el paso conservando lo ya respondido.
// -------------------------------------------------------------------------------------

function toQuery(answers: Answers, step: number, omit?: FilterKey): string {
  const qs = new URLSearchParams();
  if (omit !== 'population_ids') answers.population_ids.forEach((id) => qs.append('population_ids', id));
  if (omit !== 'area_ids') answers.area_ids.forEach((id) => qs.append('area_ids', id));
  if (omit !== 'approach_ids') answers.approach_ids.forEach((id) => qs.append('approach_ids', id));
  if (omit !== 'max_price_mxn' && answers.max_price_mxn !== null) {
    qs.set('max_price_mxn', String(answers.max_price_mxn));
  }
  qs.set('step', String(step));
  return `/afinidad?${qs.toString()}`;
}

/** Querystring de filtros para el listado (mismo shape que consume /psicologos). */
function listadoQuery(filters: AffinityFilters): string {
  const qs = new URLSearchParams();
  (filters.population_ids ?? []).forEach((id) => qs.append('population_ids', id));
  (filters.area_ids ?? []).forEach((id) => qs.append('area_ids', id));
  (filters.approach_ids ?? []).forEach((id) => qs.append('approach_ids', id));
  if (typeof filters.max_price_mxn === 'number') qs.set('max_price_mxn', String(filters.max_price_mxn));
  const s = qs.toString();
  return s ? `/psicologos?${s}` : '/psicologos';
}

// =====================================================================================
// Server Action: COMMIT del test. Único punto que persiste el resultado.
//   1. Reconstruye las respuestas desde el FormData del paso Resultado.
//   2. Valida cada id contra `catalog_options` (allowlist; descarta lo que no exista).
//   3. Firma la cookie con `setBookingSession({ affinity_filters })` (server-only).
//   4. Redirige al listado con los MISMOS filtros en la URL (el listado los reaplica).
// No envía respuestas crudas al backend ni crea filas: solo escribe ids de catálogo en la
// cookie no autoritativa (§ "No debe").
// =====================================================================================

async function applyAffinity(formData: FormData): Promise<void> {
  'use server';

  const catalog = await loadCatalog();

  // Allowlist: solo ids que EXISTEN en catalog_options y con el type correcto sobreviven.
  const keepByType = (name: FilterKey, type: CatalogType): string[] =>
    formData
      .getAll(name)
      .map((v) => String(v).trim())
      .filter((id) => catalog.validIds.get(id) === type);

  const population_ids = keepByType('population_ids', 'population');
  const area_ids = keepByType('area_ids', 'area');
  const approach_ids = keepByType('approach_ids', 'approach');

  const rawPrice = formData.get('max_price_mxn');
  const price = rawPrice != null ? Number.parseInt(String(rawPrice), 10) : NaN;
  const max_price_mxn = Number.isFinite(price) && PRICE_VALUES.has(price) ? price : undefined;

  // Construye el objeto de filtros SOLO con dimensiones no vacías (shape de search_marketplace_profiles).
  const filters: AffinityFilters = {};
  if (area_ids.length) filters.area_ids = area_ids;
  if (population_ids.length) filters.population_ids = population_ids;
  if (approach_ids.length) filters.approach_ids = approach_ids;
  if (max_price_mxn !== undefined) filters.max_price_mxn = max_price_mxn;

  const hasAny = Object.keys(filters).length > 0;

  // Firma la cookie (Secure·HttpOnly·SameSite=Lax) con la allowlist de la sesión de marketplace.
  // Si el paciente saltó todo, no ensuciamos la cookie: se va al listado sin filtros.
  if (hasAny) {
    await setBookingSession({ affinity_filters: filters });
  }

  // Redirige con los filtros en la URL: el listado es la fuente visible de filtros (la cookie
  // solo decide el affordance "Afinidad aplicada"). redirect() lanza; va fuera de try/catch.
  redirect(listadoQuery(filters));
}

// =====================================================================================
// Página (Server Component). searchParams (Next 15) es Promise.
// =====================================================================================

export default async function AfinidadPage({
  searchParams,
}: {
  searchParams: Promise<RawSearchParams>;
}) {
  const params = await searchParams;
  const step = readStep(params.step);
  const answers = readAnswers(params);

  const [catalog, session] = await Promise.all([loadCatalog(), getBookingSession()]);
  const questions = buildQuestions(catalog);
  const total = questions.length;

  // ¿Ya hay afinidad aplicada en la cookie? (§ estado "Ya realizado")
  const applied = session?.affinity_filters ?? null;
  const hasApplied =
    !!applied &&
    ((applied.area_ids?.length ?? 0) > 0 ||
      (applied.population_ids?.length ?? 0) > 0 ||
      (applied.approach_ids?.length ?? 0) > 0 ||
      typeof applied.max_price_mxn === 'number');

  return (
    <main className="afin">
      <style>{PAGE_CSS}</style>

      {/* App bar mínima: volver al directorio (navegación pura, sin CTA morado aquí). */}
      <header className="afin__bar">
        <Link href="/psicologos" className="afin__brand" aria-label="Agenda Psi — volver al directorio">
          Agenda Psi
        </Link>
        <Link href="/psicologos" className="btn-secondary afin__close">
          {hasApplied ? 'Volver' : 'Cancelar'}
        </Link>
      </header>

      <div className="afin__wrap">
        {step < 0 && hasApplied
          ? renderYaRealizado(applied!, catalog, questions)
          : step < 0
          ? renderIntro()
          : step >= total
          ? renderResultado(answers, catalog)
          : renderPregunta(questions[step]!, step, total, answers)}
      </div>
    </main>
  );
}

// -------------------------------------------------------------------------------------
// Estado: INTRO (§ "primera vez"). Portada breve + "Empezar". Único CTA morado.
// -------------------------------------------------------------------------------------

function renderIntro() {
  return (
    <section className="card afin__panel" aria-labelledby="afin-intro-title">
      <span className="afin__kicker">Test de afinidad</span>
      <h1 id="afin-intro-title" className="afin__title">
        ¿No sabes por dónde empezar?
      </h1>
      <p className="afin__lede">
        Responde unas preguntas rápidas y filtramos el directorio por ti. Toma 2–3 minutos y
        no guardamos información clínica: solo usamos tus respuestas para acotar la búsqueda.
      </p>
      <ul className="afin__points" role="list">
        <li>Una pregunta a la vez, sin prisa.</li>
        <li>Puedes saltar cualquier pregunta.</li>
        <li>Al terminar verás profesionales que encajan con lo que buscas.</li>
      </ul>
      <div className="afin__actions">
        {/* Empezar = ir al primer paso (sin respuestas aún). */}
        <Link href="/afinidad?step=0" className="cta-primary">
          Empezar
        </Link>
        <Link href="/psicologos" className="afin__link">
          Prefiero explorar el directorio
        </Link>
      </div>
    </section>
  );
}

// -------------------------------------------------------------------------------------
// Estado: PREGUNTA N (§ "en curso"). 1 pregunta por paso + progreso "N de M" + "Saltar".
// El <form method="get"> arma la URL del siguiente paso conservando lo acumulado.
// -------------------------------------------------------------------------------------

function renderPregunta(q: Question, index: number, total: number, answers: Answers) {
  const stepNumber = index + 1;
  const progress = Math.round((stepNumber / (total + 1)) * 100); // +1: el paso Resultado cierra la barra
  // Respuestas de pasos previos que se conservan como inputs ocultos; se OMITE la clave de
  // esta pregunta para que la respuesta actual la reemplace si el paciente vuelve atrás.
  const carry = hiddenCarry(answers, q.key);
  const skipHref = toQuery(answers, stepNumber, q.key); // avanzar sin responder esta

  return (
    <section className="afin__panel" aria-labelledby="afin-q-title">
      {/* Progreso accesible. */}
      <div className="afin__progress">
        <span className="afin__step num">
          Pregunta {stepNumber} de {total}
        </span>
        <div
          className="afin__bar-track"
          role="progressbar"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={progress}
          aria-label={`Progreso: ${stepNumber} de ${total}`}
        >
          <div className="afin__bar-fill" style={{ width: `${progress}%` }} />
        </div>
      </div>

      <form method="get" action="/afinidad" className="card afin__form">
        {carry}
        <input type="hidden" name="step" value={stepNumber} />

        <fieldset className="afin__fieldset">
          <legend id="afin-q-title" className="afin__q-title">
            {q.title}
          </legend>
          <p className="afin__q-help">{q.help}</p>

          <div className="afin__options">
            {q.kind === 'price'
              ? PRICE_PRESETS.map((p) => (
                  <label key={p.value} className="afin__option">
                    <input
                      type="radio"
                      name="max_price_mxn"
                      value={p.value}
                      defaultChecked={answers.max_price_mxn === p.value}
                    />
                    <span className="afin__option-label">{p.label}</span>
                  </label>
                ))
              : q.options.map((opt) => {
                  const selected = currentSelection(answers, q.key).includes(opt.id);
                  return (
                    <label key={opt.id} className="afin__option">
                      <input
                        type={q.kind === 'single' ? 'radio' : 'checkbox'}
                        name={q.key}
                        value={opt.id}
                        defaultChecked={selected}
                      />
                      <span className="afin__option-body">
                        <span className="afin__option-label">{opt.label}</span>
                        {opt.description ? (
                          <span className="afin__option-desc">{opt.description}</span>
                        ) : null}
                      </span>
                    </label>
                  );
                })}
          </div>
        </fieldset>

        <div className="afin__actions">
          {/* Único CTA morado de la pantalla. */}
          <button type="submit" className="cta-primary">
            {stepNumber === total ? 'Ver resumen' : 'Continuar'}
          </button>
          {/* "Saltar": enlace de texto, conserva lo acumulado y avanza sin responder ésta. */}
          <Link href={skipHref} className="afin__link">
            Saltar
          </Link>
        </div>
      </form>

      {/* Volver al paso anterior (o a la intro desde el primero: intro = step ausente < 0). */}
      <div className="afin__back">
        <Link href={index === 0 ? '/afinidad' : toQuery(answers, index - 1)} className="afin__link">
          ← Atrás
        </Link>
      </div>
    </section>
  );
}

// -------------------------------------------------------------------------------------
// Estado: RESULTADO (§ "respondió todo"). Resumen de filtros derivados + "Ver profesionales".
// "Ver profesionales" hace POST a la Server Action (firma cookie + redirige al listado).
// -------------------------------------------------------------------------------------

function renderResultado(answers: Answers, catalog: Catalog) {
  const summary = summarize(answers, catalog);
  const nothing = summary.length === 0;

  return (
    <section className="afin__panel" aria-labelledby="afin-result-title">
      <div className="afin__progress">
        <div
          className="afin__bar-track"
          role="progressbar"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={100}
          aria-label="Progreso: completado"
        >
          <div className="afin__bar-fill" style={{ width: '100%' }} />
        </div>
      </div>

      <div className="card afin__form">
        <span className="afin__kicker">Listo</span>
        <h1 id="afin-result-title" className="afin__title">
          Esto es lo que buscaremos por ti
        </h1>

        {nothing ? (
          <p className="afin__lede">
            No elegiste filtros. Puedes ver todo el directorio o repetir el test para acotar.
          </p>
        ) : (
          <dl className="afin__summary">
            {summary.map((row) => (
              <div key={row.label} className="afin__summary-row">
                <dt className="afin__summary-key">{row.label}</dt>
                <dd className="afin__summary-val">
                  {row.chips.map((chip) => (
                    <span key={chip} className="afin__chip">
                      {chip}
                    </span>
                  ))}
                </dd>
              </div>
            ))}
          </dl>
        )}

        {/* Commit: POST a la Server Action con las respuestas acumuladas como inputs ocultos.
            La acción valida ids contra el catálogo, firma la cookie y redirige a /psicologos. */}
        <form action={applyAffinity} className="afin__actions">
          {hiddenCarry(answers, null)}
          <button type="submit" className="cta-primary">
            {nothing ? 'Ver todo el directorio' : 'Ver profesionales'}
          </button>
          {/* Repetir: enlace de texto que reinicia el cuestionario (reemplaza al terminar). */}
          <Link href="/afinidad?step=0" className="afin__link">
            Repetir test
          </Link>
        </form>
      </div>
    </section>
  );
}

// -------------------------------------------------------------------------------------
// Estado: YA REALIZADO (§ "hay affinity_filters en cookie"). "Afinidad aplicada" + "Repetir".
// -------------------------------------------------------------------------------------

function renderYaRealizado(applied: AffinityFilters, catalog: Catalog, _questions: Question[]) {
  const summary = summarize(appliedToAnswers(applied), catalog);

  return (
    <section className="card afin__panel" aria-labelledby="afin-done-title">
      <span className="afin__kicker afin__kicker--ok">Afinidad aplicada</span>
      <h1 id="afin-done-title" className="afin__title">
        Ya tienes filtros de afinidad activos
      </h1>
      <p className="afin__lede">
        El directorio se está mostrando acotado a lo que elegiste. Puedes verlo así o repetir el
        test para cambiar los filtros.
      </p>

      {summary.length > 0 ? (
        <dl className="afin__summary">
          {summary.map((row) => (
            <div key={row.label} className="afin__summary-row">
              <dt className="afin__summary-key">{row.label}</dt>
              <dd className="afin__summary-val">
                {row.chips.map((chip) => (
                  <span key={chip} className="afin__chip">
                    {chip}
                  </span>
                ))}
              </dd>
            </div>
          ))}
        </dl>
      ) : null}

      <div className="afin__actions">
        {/* Único CTA morado: ir al listado con la afinidad ya aplicada. */}
        <Link href={listadoQuery(applied)} className="cta-primary">
          Ver profesionales
        </Link>
        <Link href="/afinidad?step=0" className="afin__link">
          Repetir test
        </Link>
      </div>
    </section>
  );
}

// -------------------------------------------------------------------------------------
// Helpers de render puros (sin efectos): selección actual, inputs ocultos, resumen legible.
// -------------------------------------------------------------------------------------

/** Ids ya seleccionados para la clave de una pregunta de catálogo (para defaultChecked). */
function currentSelection(answers: Answers, key: Question['key']): string[] {
  switch (key) {
    case 'population_ids':
      return answers.population_ids;
    case 'area_ids':
      return answers.area_ids;
    case 'approach_ids':
      return answers.approach_ids;
    default:
      return [];
  }
}

/**
 * Inputs ocultos que conservan las respuestas acumuladas entre pasos. `omit` excluye la
 * clave de la pregunta en curso para que la respuesta nueva la reemplace (no se dupliquen).
 */
function hiddenCarry(answers: Answers, omit: FilterKey | null) {
  const nodes: ReactNode[] = [];
  const push = (name: FilterKey, ids: string[]) => {
    if (omit === name) return;
    ids.forEach((id, i) => nodes.push(<input key={`${name}-${i}-${id}`} type="hidden" name={name} value={id} />));
  };
  push('population_ids', answers.population_ids);
  push('area_ids', answers.area_ids);
  push('approach_ids', answers.approach_ids);
  if (omit !== 'max_price_mxn' && answers.max_price_mxn !== null) {
    nodes.push(<input key="price" type="hidden" name="max_price_mxn" value={answers.max_price_mxn} />);
  }
  return <>{nodes}</>;
}

/** Convierte los filtros de la cookie al shape `Answers` para reusar `summarize`. */
function appliedToAnswers(applied: AffinityFilters): Answers {
  return {
    area_ids: applied.area_ids ?? [],
    population_ids: applied.population_ids ?? [],
    approach_ids: applied.approach_ids ?? [],
    max_price_mxn: typeof applied.max_price_mxn === 'number' ? applied.max_price_mxn : null,
  };
}

/** Resumen legible: resuelve ids → labels del catálogo; ignora ids que ya no existan. */
function summarize(answers: Answers, catalog: Catalog): Array<{ label: string; chips: string[] }> {
  const labelOf = (list: CatalogOption[], ids: string[]): string[] =>
    ids.map((id) => list.find((o) => o.id === id)?.label).filter((l): l is string => !!l);

  const rows: Array<{ label: string; chips: string[] }> = [];
  const pop = labelOf(catalog.population, answers.population_ids);
  const area = labelOf(catalog.area, answers.area_ids);
  const app = labelOf(catalog.approach, answers.approach_ids);

  if (pop.length) rows.push({ label: 'Para quién', chips: pop });
  if (area.length) rows.push({ label: 'Temas', chips: area });
  if (app.length) rows.push({ label: 'Enfoque', chips: app });
  if (answers.max_price_mxn !== null) {
    const preset = PRICE_PRESETS.find((p) => p.value === answers.max_price_mxn);
    rows.push({ label: 'Presupuesto', chips: [preset?.label ?? `Hasta $${answers.max_price_mxn}`] });
  }
  return rows;
}

// -------------------------------------------------------------------------------------
// Estilos: SOLO layout/tipografía; color/radio/espaciado desde tokens.css (var(--*)).
// Regla del morado: el morado sólido solo en .cta-primary; el resto usa tint/neutros.
// Foco visible lo aporta tokens.css; aquí reforzamos área táctil ≥ --min-touch.
// -------------------------------------------------------------------------------------

const PAGE_CSS = `
.afin { min-height: 100vh; background: var(--purple-50); }

.afin__bar {
  display: flex; align-items: center; justify-content: space-between;
  gap: var(--s16); padding: var(--s16) var(--s20);
  border-bottom: 1px solid var(--border); background: var(--surface);
}
.afin__brand {
  font-family: var(--font-display); font-weight: 800; font-size: 18px;
  color: var(--ink-900); text-decoration: none;
}
.afin__close { text-decoration: none; }

.afin__wrap { max-width: 640px; margin: 0 auto; padding: var(--s24) var(--s16) var(--s32); }

.afin__panel { display: block; }
.card.afin__panel, .afin__form.card { padding: var(--s24); }

/* Encabezados / copy */
.afin__kicker {
  display: inline-block; font-family: var(--font-display); font-weight: 700;
  font-size: 12px; letter-spacing: .06em; text-transform: uppercase;
  color: var(--purple-700); background: var(--purple-100);
  padding: 4px var(--s12); border-radius: var(--radius-round); margin-bottom: var(--s12);
}
.afin__kicker--ok { color: var(--success-700); background: var(--success-100); }
.afin__title {
  font-family: var(--font-display); font-weight: 700;
  font-size: clamp(22px, 4vw, 30px); line-height: 1.18;
  color: var(--ink-900); margin: 0 0 var(--s12);
}
.afin__lede { color: var(--ink-700); font-size: 16px; line-height: 1.5; margin: 0 0 var(--s16); }
.afin__points { margin: 0 0 var(--s24); padding-left: var(--s20); color: var(--ink-700); }
.afin__points li { margin: var(--s4) 0; }

/* Progreso */
.afin__progress { margin-bottom: var(--s16); }
.afin__step { display: block; color: var(--ink-500); font-size: 13px; margin-bottom: var(--s8); }
.afin__bar-track {
  height: 8px; border-radius: var(--radius-round);
  background: var(--ink-100); overflow: hidden;
}
.afin__bar-fill {
  height: 100%; border-radius: var(--radius-round);
  background: var(--purple-600); transition: width .2s ease;
}

/* Formulario / preguntas */
.afin__form { margin: 0; }
.afin__fieldset { border: 0; margin: 0; padding: 0; }
.afin__q-title {
  font-family: var(--font-display); font-weight: 700; font-size: 20px;
  color: var(--ink-900); padding: 0; margin: 0 0 var(--s4);
}
.afin__q-help { color: var(--ink-500); font-size: 14px; margin: 0 0 var(--s16); }

.afin__options { display: grid; gap: var(--s12); }

/* Opción como tarjeta seleccionable; área táctil generosa. */
.afin__option {
  display: flex; align-items: flex-start; gap: var(--s12);
  min-height: var(--min-touch);
  padding: var(--s12) var(--s16);
  border: 1px solid var(--border); border-radius: var(--radius-md);
  background: var(--surface); cursor: pointer;
}
.afin__option:hover { border-color: var(--purple-300); background: var(--purple-50); }
.afin__option input { margin-top: 2px; width: 18px; height: 18px; accent-color: var(--purple-600); }
/* Estado seleccionado: tint morado (nunca morado sólido en superficie). */
.afin__option:has(input:checked) {
  border-color: var(--purple-600); background: var(--purple-100);
}
.afin__option-body { display: flex; flex-direction: column; gap: 2px; }
.afin__option-label { color: var(--ink-900); font-weight: 600; font-size: 15px; }
.afin__option-desc { color: var(--ink-500); font-size: 13px; line-height: 1.4; }

/* Acciones: un solo CTA morado + enlaces de texto. */
.afin__actions {
  display: flex; align-items: center; flex-wrap: wrap; gap: var(--s16);
  margin-top: var(--s24);
}
.afin__link {
  color: var(--purple-700); text-decoration: none; font-size: 14px; font-weight: 600;
  min-height: var(--min-touch); display: inline-flex; align-items: center;
}
.afin__link:hover { text-decoration: underline; }
.afin__back { margin-top: var(--s16); }

/* Resumen de filtros derivados */
.afin__summary { margin: var(--s8) 0 var(--s8); display: grid; gap: var(--s16); }
.afin__summary-row { display: grid; gap: var(--s8); }
.afin__summary-key {
  font-size: 12px; font-weight: 700; letter-spacing: .04em; text-transform: uppercase;
  color: var(--ink-500);
}
.afin__summary-val { display: flex; flex-wrap: wrap; gap: var(--s8); margin: 0; }
.afin__chip {
  display: inline-flex; align-items: center;
  padding: 6px var(--s12); border-radius: var(--radius-round);
  background: var(--purple-100); color: var(--purple-700);
  font-size: 13px; font-weight: 600;
}
`;
