'use client';

// =====================================================================================
// components/SlotPicker.tsx
// Marketplace — Selector de día/horario para "Selecciona tu horario" (paso 1 de 4).
// Client Component (Next.js App Router). Es la parte INTERACTIVA de la pantalla; el
// Server Component la envuelve con app bar, resumen del profesional y nota de cierre.
//
// Contrato: paginas/marketplace-seleccion-horario.md
//   · §Estados: Cargando mes / Con días / Consultando horarios / Con horarios / Día sin
//     slots / Horario elegido / Error.
//   · §Jerarquía 3–6: calendario mensual → horarios del día → resumen → CTA "Continuar".
//   · §Visibilidad condicional: horarios solo tras elegir fecha; CTA activo solo con
//     horario elegido; cambiar de fecha limpia el horario; cambiar de mes limpia
//     fecha/horario fuera de rango.
//   · §Navegación: "Continuar" → PÁGINA marketplace-tus-datos, propagando {slug, starts_at}.
//   · §No debe: crear hold/paciente/cita, pedir teléfono, iniciar OTP/Stripe, confiar en
//     precio/duración del frontend, ni afirmar que el horario quedó apartado.
// + MARKETPLACE.md § get_marketplace_available_days / get_marketplace_availability (motor
//   único de disponibilidad) y § create_or_replace_marketplace_slot_hold (~L617).
//
// "SIN DISPONIBILIDAD" (nota del arnés): este componente NO calcula disponibilidad. La
// verdad la producen los RPC del backend (motor único). Aquí solo se PINTA lo que devuelven
// los Route Handlers propios (anon key server-side) y se propaga `starts_at` (ISO UTC).
//
// INVARIANTES DE SEGURIDAD que respeta este archivo:
//   - NUNCA habla con Supabase ni usa service_role: sólo `fetch` a Route Handlers propios
//     del MISMO origen (anon key server-side para lecturas; el hold es privilegiado y vive
//     ENTERO en el servidor). El navegador jamás ve la anon/service key.
//   - NO persiste nada en localStorage. El único estado que viaja hacia adelante es
//     {slug, starts_at} por la URL. Esta pantalla NO crea hold/paciente/cita (§No debe): el
//     hold, la cookie firmada y el pago se resuelven server-side en pasos POSTERIORES (la
//     página "Tus datos" revalida y crea el hold); la cita SOLO nace del webhook firmado.
//   - NO confía en precio/duración/modalidad/tz del frontend: lo que se muestra viene del
//     RPC (prop `service`) y sólo es informativo; el backend lo re-deriva bajo lock.
//   - Sin datos clínicos ni de pago. tz del PROFESIONAL es la autoritativa; si el paciente
//     está en otra zona, se añade una etiqueta (dato de cliente, no del servidor).
//
// DISEÑO: sólo tokens de styles/tokens.css (sin colores hardcodeados). Morado (--purple-600)
// reservado a la acción (día/chip elegido + CTA). Foco visible heredado de :focus-visible.
// `.num` (tabular-nums) en horas para que las cifras no "bailen". UI en español (es-MX).
//
// NOTA de nomenclatura: el propósito de la tarea habla de modos "day/time"; los Server
// Components que montan este componente pasan `mode="days"` y `mode="hours"`. Se implementan
// esos dos valores (integración autoritativa con dias/page.tsx y horarios/page.tsx). AMBOS
// modos sólo SELECCIONAN y propagan {slug, starts_at} a "Tus datos"; NINGUNO crea el hold
// (§No debe: esta pantalla no aparta el slot; lo hace la página siguiente, server-side).
// =====================================================================================

import { useCallback, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';

// -------------------------------------------------------------------------------------
// Tipos — espejo ESTRUCTURAL del allowlist público de los contratos (mismos shapes que
// exponen dias/page.tsx y horarios/page.tsx). Ni un campo privado más.
// -------------------------------------------------------------------------------------

/** Servicio del marketplace (siempre `online`). Precio/duración son SÓLO informativos. */
export interface MarketplaceServiceMeta {
  display_name: string; // "Cita individual" (etiqueta orientada al paciente)
  price_mxn: number;
  duration_minutes: number;
  modality: 'online'; // marketplace es online-only (MARKETPLACE.md §disponibilidad)
}

/** Un día con ≥1 horario (salida de `get_marketplace_available_days`). */
export interface AvailableDay {
  date: string; // "YYYY-MM-DD" en la tz del profesional
  weekday: number; // índice que fije el RPC (no se usa para pintar: se deriva de `date`)
}

/** Un horario libre (salida de `get_marketplace_availability`). */
export interface AvailabilitySlot {
  starts_at: string; // ISO UTC — el ÚNICO identificador que se propaga al hold/siguiente paso
  ends_at: string; // ISO UTC
  starts_at_local: string; // "HH:mm" (o ISO local) en tz del profesional
  ends_at_local: string;
}

/** Respuesta de los Route Handlers de días (anon key server-side). */
interface DaysResponse {
  available_days: AvailableDay[];
  service?: MarketplaceServiceMeta;
}

/** Respuesta de los Route Handlers de horarios (anon key server-side). */
interface SlotsResponse {
  slots: AvailabilitySlot[];
  service?: MarketplaceServiceMeta;
}

// --- Props: unión discriminada por `mode`. -------------------------------------------

/** Modo "days": pantalla completa (calendario + horarios inline + CTA sin hold). */
interface DaysModeProps {
  mode: 'days';
  slug: string;
  service: MarketplaceServiceMeta;
  timezone: string; // IANA, tz del profesional (autoritativa)
  initialRange: { fromDate: string; toDate: string }; // rango SSR del primer paint
  initialDays: AvailableDay[];
  initialError: boolean;
  daysEndpoint: string; // GET ?from_date=&to_date= → { available_days, service }
  slotsEndpoint: string; // GET ?date=            → { slots, service }
  /** "Continuar" → PÁGINA "Tus datos" con {slug, starts_at}. NO crea hold (lo hace esa página). */
  continueHrefBase: string;
}

/** Modo "hours": sólo horarios de un día; al continuar propaga {slug, starts_at} SIN crear hold. */
interface HoursModeProps {
  mode: 'hours';
  slug: string;
  date: string; // "YYYY-MM-DD" del día elegido
  service: MarketplaceServiceMeta;
  timezone: string;
  initialSlots: AvailabilitySlot[];
  initialError: boolean;
  slotsEndpoint: string; // GET ?date= → { slots, service } (Reintentar / refresh)
  /** PÁGINA "Tus datos" (identificación), con {slug, starts_at}. Esa página revalida y crea el
      hold server-side (§Navegación). Esta pantalla NO crea el hold (§No debe). */
  identificationHrefBase: string;
}

export type SlotPickerProps = DaysModeProps | HoursModeProps;

// -------------------------------------------------------------------------------------
// Utilidades de fecha/hora (presentación es-MX; identificadores en inglés).
// -------------------------------------------------------------------------------------

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const HHMM = /^\d{2}:\d{2}/;

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

/** "YYYY-MM-DD" de hoy en una tz IANA (evita correr el día por el offset UTC). */
function todayInTimeZone(timeZone: string): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
}

/** tz local del PACIENTE (dato de cliente). Puede diferir de la del profesional. */
function patientTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || '';
  } catch {
    return '';
  }
}

/** Ancla "YYYY-MM-DD" al mediodía UTC-neutro para formatear sin ambigüedad de medianoche. */
function anchorNoon(isoDate: string): Date {
  return new Date(`${isoDate}T12:00:00Z`);
}

/** "Jue 16 jul" en la tz del profesional (para el resumen de la selección). */
function shortDayLabel(isoDate: string, timeZone: string): string {
  if (!ISO_DATE.test(isoDate)) return '';
  return new Intl.DateTimeFormat('es-MX', {
    timeZone,
    weekday: 'short',
    day: 'numeric',
    month: 'short',
  }).format(anchorNoon(isoDate));
}

/** "julio de 2026" (encabezado del calendario), capitalizado por CSS. */
function monthLabel(year: number, month0: number): string {
  return new Intl.DateTimeFormat('es-MX', {
    year: 'numeric',
    month: 'long',
  }).format(new Date(Date.UTC(year, month0, 1, 12)));
}

/**
 * "HH:mm" para un chip. `*_local` ya viene en la tz del profesional: si es "HH:mm" se usa
 * tal cual; si es ISO se formatea EN la tz del profesional (fallback robusto).
 */
function hhmm(local: string, timeZone: string): string {
  if (HHMM.test(local)) return local.slice(0, 5);
  const d = new Date(local);
  if (Number.isNaN(d.getTime())) return local;
  return new Intl.DateTimeFormat('es-MX', {
    timeZone,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(d);
}

/** "17:00–17:50" a partir de un slot, en la tz del profesional. */
function slotRange(slot: AvailabilitySlot, timeZone: string): string {
  return `${hhmm(slot.starts_at_local, timeZone)}–${hhmm(slot.ends_at_local, timeZone)}`;
}

/** Etiqueta corta de zona ("CDMX", "GMT-6", …) derivada de la tz del profesional. */
function tzShortLabel(timeZone: string): string {
  const parts = new Intl.DateTimeFormat('es-MX', {
    timeZone,
    timeZoneName: 'short',
  }).formatToParts(new Date());
  return parts.find((p) => p.type === 'timeZoneName')?.value ?? timeZone;
}

/** Días del mes (0-index) y offset lunes-primero para pintar la rejilla. */
function monthGrid(year: number, month0: number): { leadingBlanks: number; days: string[] } {
  const first = new Date(Date.UTC(year, month0, 1));
  // getUTCDay: 0=domingo…6=sábado ⇒ a lunes-primero: (d+6)%7.
  const leadingBlanks = (first.getUTCDay() + 6) % 7;
  const total = new Date(Date.UTC(year, month0 + 1, 0)).getUTCDate();
  const days: string[] = [];
  for (let d = 1; d <= total; d += 1) {
    days.push(`${year}-${pad2(month0 + 1)}-${pad2(d)}`);
  }
  return { leadingBlanks, days };
}

/** Números "YYYY-MM" comparables para saber si una fecha cae en el mes visible. */
function ym(isoDate: string): string {
  return isoDate.slice(0, 7);
}

// -------------------------------------------------------------------------------------
// Componente. Dispatch por modo (la lógica de horarios es común y se comparte).
// -------------------------------------------------------------------------------------

export function SlotPicker(props: SlotPickerProps) {
  if (props.mode === 'hours') return <HoursPicker {...props} />;
  return <DaysPicker {...props} />;
}

export default SlotPicker;

// =====================================================================================
// MODO "days": calendario mensual + horarios inline + resumen + CTA (sin hold).
// =====================================================================================

function DaysPicker({
  slug,
  service,
  timezone,
  initialRange,
  initialDays,
  initialError,
  daysEndpoint,
  slotsEndpoint,
  continueHrefBase,
}: DaysModeProps) {
  const router = useRouter();
  const today = useMemo(() => todayInTimeZone(timezone), [timezone]);

  // Mes visible: arranca en el mes de `fromDate` del rango SSR.
  const [view, setView] = useState<{ year: number; month0: number }>(() => {
    const [y, m] = initialRange.fromDate.split('-');
    return { year: Number(y), month0: Number(m) - 1 };
  });

  // Conjunto de días disponibles (merge acumulativo de todo lo consultado en la sesión).
  const [availableDays, setAvailableDays] = useState<Set<string>>(
    () => new Set(initialDays.map((d) => d.date)),
  );
  const [daysLoading, setDaysLoading] = useState(false);
  const [daysError, setDaysError] = useState(initialError);

  // Sub-estado de horarios (compartido con la selección y el CTA).
  const slotsState = useSlotSelection(timezone);

  // --- Consulta de días de un rango (cambio de mes / Reintentar). Anon key server-side. ---
  const loadDays = useCallback(
    async (fromDate: string, toDate: string) => {
      setDaysLoading(true);
      setDaysError(false);
      try {
        const url = `${daysEndpoint}?from_date=${encodeURIComponent(fromDate)}&to_date=${encodeURIComponent(toDate)}`;
        const res = await fetch(url, { headers: { accept: 'application/json' } });
        if (!res.ok) throw new Error('days_failed');
        const data = (await res.json()) as DaysResponse;
        setAvailableDays((prev) => {
          const next = new Set(prev);
          for (const d of data.available_days) next.add(d.date);
          return next;
        });
      } catch {
        // §Estados "Error": no rompe la pantalla; el calendario ofrece "Reintentar".
        setDaysError(true);
      } finally {
        setDaysLoading(false);
      }
    },
    [daysEndpoint],
  );

  // --- Cambio de mes: nueva consulta del rango (§Jerarquía.3) + limpieza fuera de rango. ---
  const goToMonth = useCallback(
    (year: number, month0: number) => {
      const firstOfMonth = `${year}-${pad2(month0 + 1)}-01`;
      const lastDay = new Date(Date.UTC(year, month0 + 1, 0)).getUTCDate();
      const lastOfMonth = `${year}-${pad2(month0 + 1)}-${pad2(lastDay)}`;
      // El RPC exige from_date >= today_local: se recorta el inicio del rango a hoy.
      const fromDate = firstOfMonth < today ? today : firstOfMonth;

      setView({ year, month0 });
      // §Visibilidad condicional: cambiar de mes limpia fecha/horario fuera de rango.
      if (!slotsState.selectedDate || ym(slotsState.selectedDate) !== `${year}-${pad2(month0 + 1)}`) {
        slotsState.reset();
      }
      void loadDays(fromDate, lastOfMonth);
    },
    [today, loadDays, slotsState],
  );

  // Navegación de meses (no se retrocede a meses ya pasados por completo).
  const currentYm = `${todayInTimeZone(timezone).slice(0, 7)}`;
  const viewYm = `${view.year}-${pad2(view.month0 + 1)}`;
  const canGoPrev = viewYm > currentYm;

  const grid = useMemo(() => monthGrid(view.year, view.month0), [view]);

  return (
    <section aria-label="Elegir día y horario">
      {/* 3. Calendario mensual. Días con cupo activos; sin cupo deshabilitados; elegido en morado. */}
      <div className="card" style={{ padding: 'var(--s16)', marginBottom: 'var(--s16)' }}>
        {/* Encabezado del mes + navegación. */}
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            marginBottom: 'var(--s12)',
          }}
        >
          <button
            type="button"
            className="btn-secondary"
            onClick={() => {
              const m = view.month0 - 1;
              goToMonth(m < 0 ? view.year - 1 : view.year, (m + 12) % 12);
            }}
            disabled={!canGoPrev || daysLoading}
            aria-label="Mes anterior"
            style={{ width: 'var(--min-touch)', minWidth: 'var(--min-touch)', padding: 0 }}
          >
            <span aria-hidden="true">‹</span>
          </button>
          <h3
            aria-live="polite"
            style={{
              fontFamily: 'var(--font-display)',
              fontWeight: 600,
              fontSize: 15,
              color: 'var(--ink-900)',
              margin: 0,
              textTransform: 'capitalize',
            }}
          >
            {monthLabel(view.year, view.month0)}
          </h3>
          <button
            type="button"
            className="btn-secondary"
            onClick={() => {
              const m = view.month0 + 1;
              goToMonth(m > 11 ? view.year + 1 : view.year, m % 12);
            }}
            disabled={daysLoading}
            aria-label="Mes siguiente"
            style={{ width: 'var(--min-touch)', minWidth: 'var(--min-touch)', padding: 0 }}
          >
            <span aria-hidden="true">›</span>
          </button>
        </div>

        {daysError ? (
          // §Estados "Error": fallo de red al consultar el mes.
          <RetryBlock
            message="No pudimos consultar los horarios"
            onRetry={() => goToMonth(view.year, view.month0)}
          />
        ) : (
          <>
            {/* Cabecera de días (lunes-primero, es-MX). */}
            <div
              role="presentation"
              style={{
                display: 'grid',
                gridTemplateColumns: 'repeat(7, 1fr)',
                gap: 'var(--s4)',
                marginBottom: 'var(--s4)',
              }}
            >
              {['L', 'M', 'M', 'J', 'V', 'S', 'D'].map((d, i) => (
                <span
                  key={`${d}-${i}`}
                  aria-hidden="true"
                  style={{
                    textAlign: 'center',
                    fontSize: 12,
                    color: 'var(--ink-500)',
                    padding: 'var(--s4) 0',
                  }}
                >
                  {d}
                </span>
              ))}
            </div>

            {/* Rejilla de días. §Estados "Cargando mes" ⇒ atenuada. */}
            <div
              role="grid"
              aria-label="Días disponibles"
              aria-busy={daysLoading}
              style={{
                display: 'grid',
                gridTemplateColumns: 'repeat(7, 1fr)',
                gap: 'var(--s4)',
                opacity: daysLoading ? 0.55 : 1,
                transition: 'opacity .15s ease',
              }}
            >
              {Array.from({ length: grid.leadingBlanks }).map((_, i) => (
                <span key={`blank-${i}`} aria-hidden="true" />
              ))}
              {grid.days.map((dateStr) => {
                const enabled = availableDays.has(dateStr) && dateStr >= today;
                const selected = slotsState.selectedDate === dateStr;
                const dayNum = Number(dateStr.slice(-2));
                return (
                  <button
                    key={dateStr}
                    type="button"
                    role="gridcell"
                    disabled={!enabled || daysLoading}
                    aria-pressed={selected}
                    aria-label={`${shortDayLabel(dateStr, timezone)}${enabled ? '' : ', sin horarios'}`}
                    className="num"
                    onClick={() => slotsState.selectDate(dateStr, slotsEndpoint)}
                    style={{
                      minHeight: 40,
                      border: selected ? '0' : '1px solid var(--border)',
                      borderRadius: 'var(--radius-round)',
                      background: selected ? 'var(--purple-600)' : 'var(--surface)',
                      color: selected
                        ? 'var(--white)'
                        : enabled
                          ? 'var(--ink-900)'
                          : 'var(--ink-300)',
                      fontWeight: selected ? 700 : 500,
                      fontSize: 14,
                      cursor: enabled && !daysLoading ? 'pointer' : 'not-allowed',
                    }}
                  >
                    {dayNum}
                  </button>
                );
              })}
            </div>
          </>
        )}
      </div>

      {/* 4–5. Horarios del día + resumen (visibles SÓLO tras elegir fecha). */}
      <DayHeaderAndSlots timezone={timezone} state={slotsState} slotsEndpoint={slotsEndpoint} />

      {/* 6. CTA "Continuar": navega a "Tus datos" con {slug, starts_at}. NO crea hold aquí
          (§No debe: esta pantalla no aparta el slot; lo hace la página siguiente). */}
      <ContinueBar
        service={service}
        timezone={timezone}
        selectedSlot={slotsState.selectedSlot}
        selectedDate={slotsState.selectedDate}
        busy={false}
        label="Continuar"
        onContinue={() => {
          if (!slotsState.selectedSlot) return;
          // §Navegación: propaga {slug, starts_at} a "Tus datos" (que revalida y crea el hold).
          const qs = new URLSearchParams({ slug, starts_at: slotsState.selectedSlot.starts_at });
          router.push(`${continueHrefBase}?${qs.toString()}`);
        }}
      />
    </section>
  );
}

// =====================================================================================
// MODO "hours": sólo horarios de un día. Al continuar propaga {slug, starts_at} a "Tus datos".
// NO crea hold aquí (§No debe): la página siguiente revalida y lo crea server-side.
// =====================================================================================

function HoursPicker({
  slug,
  date,
  service,
  timezone,
  initialSlots,
  initialError,
  slotsEndpoint,
  identificationHrefBase,
}: HoursModeProps) {
  const router = useRouter();
  const state = useSlotSelection(timezone, { date, slots: initialSlots, error: initialError });

  // --- Continuar: esta pantalla NO crea el hold ni toca cookies/Supabase (§No debe). Sólo
  //     propaga {slug, starts_at} a "Tus datos"; ESA página revalida bajo lock y crea el hold
  //     server-side (+cookie firmada). El slot NO queda apartado por navegar aquí (§Navegación). ---
  const onContinue = useCallback(() => {
    if (!state.selectedSlot) return;
    const qs = new URLSearchParams({ slug, starts_at: state.selectedSlot.starts_at });
    router.push(`${identificationHrefBase}?${qs.toString()}`);
  }, [state.selectedSlot, slug, identificationHrefBase, router]);

  return (
    <section aria-label="Elegir horario">
      <DayHeaderAndSlots
        timezone={timezone}
        state={state}
        slotsEndpoint={slotsEndpoint}
        hideDayHeader // el encabezado del día ya lo pinta el Server Component en modo horarios.
      />

      {/* 6. CTA "Continuar": propaga {slug, starts_at} a "Tus datos" (§Navegación). No aparta el slot. */}
      <ContinueBar
        service={service}
        timezone={timezone}
        selectedSlot={state.selectedSlot}
        selectedDate={state.selectedDate}
        busy={false}
        label="Continuar"
        onContinue={onContinue}
      />
    </section>
  );
}

// =====================================================================================
// Hook de selección de horarios: fetch de slots por día + selección de chip. Compartido
// por ambos modos. NO calcula disponibilidad; sólo pinta lo que devuelve el RPC.
// =====================================================================================

interface SlotSelection {
  selectedDate: string | null;
  slots: AvailabilitySlot[];
  slotsLoading: boolean;
  slotsError: boolean;
  selectedSlot: AvailabilitySlot | null;
  timezone: string;
  /** Elige un día y consulta sus horarios (limpia el horario previo — §Visibilidad condicional). */
  selectDate: (date: string, slotsEndpoint: string) => void;
  /** Reintenta la consulta de horarios del día actual. */
  reload: (slotsEndpoint: string) => Promise<void>;
  /** Selecciona/deselecciona un chip de horario. */
  selectSlot: (slot: AvailabilitySlot) => void;
  /** Limpia sólo el horario elegido (deja la fecha). */
  clearSelection: () => void;
  /** Limpia fecha + horario + slots (cambio de mes fuera de rango). */
  reset: () => void;
}

function useSlotSelection(
  timezone: string,
  initial?: { date: string; slots: AvailabilitySlot[]; error: boolean },
): SlotSelection {
  const [selectedDate, setSelectedDate] = useState<string | null>(initial?.date ?? null);
  const [slots, setSlots] = useState<AvailabilitySlot[]>(initial?.slots ?? []);
  const [slotsLoading, setSlotsLoading] = useState(false);
  const [slotsError, setSlotsError] = useState(initial?.error ?? false);
  const [selectedSlot, setSelectedSlot] = useState<AvailabilitySlot | null>(null);

  const fetchSlots = useCallback(async (date: string, slotsEndpoint: string) => {
    setSlotsLoading(true);
    setSlotsError(false);
    try {
      const url = `${slotsEndpoint}?date=${encodeURIComponent(date)}`;
      const res = await fetch(url, { headers: { accept: 'application/json' } });
      if (!res.ok) throw new Error('slots_failed');
      const data = (await res.json()) as SlotsResponse;
      setSlots(data.slots);
    } catch {
      setSlots([]);
      setSlotsError(true);
    } finally {
      setSlotsLoading(false);
    }
  }, []);

  const selectDate = useCallback(
    (date: string, slotsEndpoint: string) => {
      // §Visibilidad condicional: cambiar de fecha limpia el horario previo.
      setSelectedDate(date);
      setSelectedSlot(null);
      setSlots([]);
      void fetchSlots(date, slotsEndpoint);
    },
    [fetchSlots],
  );

  const reload = useCallback(
    async (slotsEndpoint: string) => {
      if (selectedDate) await fetchSlots(selectedDate, slotsEndpoint);
    },
    [selectedDate, fetchSlots],
  );

  const selectSlot = useCallback((slot: AvailabilitySlot) => {
    // Toggle por `starts_at` (identificador estable que se propaga hacia adelante).
    setSelectedSlot((prev) => (prev?.starts_at === slot.starts_at ? null : slot));
  }, []);

  const clearSelection = useCallback(() => setSelectedSlot(null), []);

  const reset = useCallback(() => {
    setSelectedDate(null);
    setSelectedSlot(null);
    setSlots([]);
    setSlotsError(false);
  }, []);

  return {
    selectedDate,
    slots,
    slotsLoading,
    slotsError,
    selectedSlot,
    timezone,
    selectDate,
    reload,
    selectSlot,
    clearSelection,
    reset,
  };
}

// =====================================================================================
// Sub-componentes de presentación.
// =====================================================================================

/**
 * Encabezado del día (opcional) + chips de horario. Cubre los estados: Consultando horarios,
 * Con horarios, Día sin slots y Error (§Estados). Sólo se muestra tras elegir fecha.
 */
function DayHeaderAndSlots({
  timezone,
  state,
  slotsEndpoint,
  hideDayHeader,
}: {
  timezone: string;
  state: SlotSelection;
  slotsEndpoint: string;
  hideDayHeader?: boolean;
}) {
  const { selectedDate, slots, slotsLoading, slotsError, selectedSlot } = state;
  const patientTz = useMemo(() => patientTimeZone(), []);
  const crossTz = patientTz && patientTz !== timezone;

  // §Visibilidad condicional: sin fecha elegida no se muestran horarios.
  if (!selectedDate) {
    return (
      <p style={{ color: 'var(--ink-500)', fontSize: 13, margin: 'var(--s8) 0 var(--s16)' }}>
        Elige un día del calendario para ver los horarios disponibles.
      </p>
    );
  }

  return (
    <div style={{ marginBottom: 'var(--s16)' }}>
      {!hideDayHeader && (
        // 4. "Jueves 16 de julio · Hora local <tz>" (tz del PROFESIONAL es la autoritativa).
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
            {new Intl.DateTimeFormat('es-MX', {
              timeZone: timezone,
              weekday: 'long',
              day: 'numeric',
              month: 'long',
            }).format(anchorNoon(selectedDate))}
          </h2>
          <p style={{ color: 'var(--ink-500)', fontSize: 13, margin: 0 }}>
            Hora local {tzShortLabel(timezone)}
          </p>
        </div>
      )}

      {/* Etiqueta cross-tz: si el paciente está en otra zona, se avisa (dato de cliente). */}
      {crossTz && (
        <p
          style={{
            background: 'var(--purple-100)',
            color: 'var(--purple-700)',
            fontSize: 12,
            borderRadius: 'var(--radius-round)',
            padding: 'var(--s8) var(--s12)',
            margin: '0 0 var(--s12)',
          }}
        >
          Los horarios están en la zona del profesional ({tzShortLabel(timezone)}). Tu zona local
          es distinta; confirma bien la hora.
        </p>
      )}

      {slotsError ? (
        // §Estados "Error".
        <RetryBlock
          message="No pudimos consultar los horarios"
          onRetry={() => void state.reload(slotsEndpoint)}
        />
      ) : slotsLoading ? (
        // §Estados "Consultando horarios".
        <p aria-live="polite" style={{ color: 'var(--ink-500)', fontSize: 13, margin: 0 }}>
          Consultando horarios…
        </p>
      ) : slots.length === 0 ? (
        // §Estados "Día sin slots".
        <p style={{ color: 'var(--ink-500)', fontSize: 14, margin: 0 }}>
          Ya no hay horarios para este día.
        </p>
      ) : (
        // §Estados "Con horarios": chips (uno seleccionable). tabular-nums en las horas.
        <div
          role="group"
          aria-label="Horarios disponibles"
          style={{ display: 'flex', flexWrap: 'wrap', gap: 'var(--s8)' }}
        >
          {slots.map((slot) => {
            const selected = selectedSlot?.starts_at === slot.starts_at;
            return (
              <button
                key={slot.starts_at}
                type="button"
                className="num"
                aria-pressed={selected}
                onClick={() => state.selectSlot(slot)}
                style={{
                  minHeight: 'var(--min-touch)',
                  padding: '0 var(--s16)',
                  border: selected ? '0' : '1px solid var(--ink-300)',
                  borderRadius: 'var(--radius-round)',
                  background: selected ? 'var(--purple-600)' : 'var(--surface)',
                  color: selected ? 'var(--white)' : 'var(--ink-900)',
                  fontWeight: selected ? 700 : 500,
                  fontSize: 14,
                  cursor: 'pointer',
                }}
              >
                {hhmm(slot.starts_at_local, timezone)}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

/**
 * Resumen de la selección + CTA "Continuar". §Jerarquía 5–6: el CTA está deshabilitado hasta
 * elegir un horario. El resumen ("Jue 16 jul · 17:00–17:50 · En línea") sólo aparece con
 * horario elegido. Precio/duración informativos (del RPC), nunca autoritativos.
 */
function ContinueBar({
  service,
  timezone,
  selectedSlot,
  selectedDate,
  busy,
  label,
  onContinue,
}: {
  service: MarketplaceServiceMeta;
  timezone: string;
  selectedSlot: AvailabilitySlot | null;
  selectedDate: string | null;
  busy: boolean;
  label: string;
  onContinue: () => void;
}) {
  return (
    <div>
      {/* 5. Resumen seleccionado (sólo con horario elegido). */}
      {selectedSlot && selectedDate && (
        <p
          className="num"
          style={{
            color: 'var(--ink-900)',
            fontWeight: 600,
            fontSize: 14,
            margin: '0 0 var(--s12)',
          }}
        >
          {shortDayLabel(selectedDate, timezone)} · {slotRange(selectedSlot, timezone)} · En línea
          <span style={{ color: 'var(--ink-500)', fontWeight: 400 }}>
            {' '}
            · {service.duration_minutes} min
          </span>
        </p>
      )}

      {/* 6. CTA primario (uno por pantalla). Deshabilitado hasta elegir horario. */}
      <button
        type="button"
        className="cta-primary"
        style={{ width: '100%' }}
        disabled={!selectedSlot || busy}
        aria-disabled={!selectedSlot || busy}
        onClick={onContinue}
      >
        {label}
      </button>
    </div>
  );
}

/** Bloque de error recuperable con "Reintentar" (§Estados "Error"). */
function RetryBlock({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <div role="alert" style={{ textAlign: 'center', padding: 'var(--s12) 0' }}>
      <p style={{ color: 'var(--ink-700)', fontSize: 14, margin: '0 0 var(--s12)' }}>{message}</p>
      <button type="button" className="btn-secondary" onClick={onRetry}>
        Reintentar
      </button>
    </div>
  );
}
