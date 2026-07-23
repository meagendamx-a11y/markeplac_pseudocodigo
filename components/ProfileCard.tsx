import Link from 'next/link';

import type { DirectoryProfile, NextAvailableSlot } from '../app/psicologos/page';

/** Precio en MXN sin decimales. Cifras tabulares vía la clase `.num` en el nodo contenedor. */
function formatPrice(mxn: number): string {
  return new Intl.NumberFormat('es-MX', {
    style: 'currency',
    currency: 'MXN',
    maximumFractionDigits: 0,
  }).format(mxn);
}

/** Iniciales para el placeholder cuando `photo_url` es null (allowlist puede no traer foto). */
function initials(name: string): string {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0]?.toUpperCase() ?? '')
    .join('');
}

/**
 * Etiqueta corta "Hoy · 17:00" / "Mañana · 10:00" / "Mié 16 · 16:00" a partir de
 * `starts_at_local` (naive, ya en hora local del profesional — no se re-convierte tz
 * aquí). Compara por fecha calendario, no por 24h exactas, para que "Hoy"/"Mañana"
 * coincidan con la percepción del paciente.
 */
function formatSlotChip(starts_at_local: string): string {
  const [datePart, timePart] = starts_at_local.split('T');
  const slot = new Date(`${datePart}T00:00:00`);
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const diffDays = Math.round((slot.getTime() - today.getTime()) / 86_400_000);
  const hhmm = (timePart ?? '00:00:00').slice(0, 5);

  if (diffDays === 0) return `Hoy · ${hhmm}`;
  if (diffDays === 1) return `Mañana · ${hhmm}`;
  const weekday = new Intl.DateTimeFormat('es-MX', { weekday: 'short' }).format(slot);
  return `${weekday.charAt(0).toUpperCase()}${weekday.slice(1)} ${slot.getDate()} · ${hhmm}`;
}

// Chip informativo de horario próximo. NO es un link (§MARKETPLACE.md D-B: los chips no
// navegan directo a crear un hold; "Elegir horario" siempre revalida disponibilidad real).
function SlotChip({ slot }: { slot: NextAvailableSlot }) {
  return (
    <span
      className="num"
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        padding: '4px var(--s12)',
        background: 'var(--purple-100)',
        color: 'var(--purple-700)',
        borderRadius: 'var(--radius-round)',
        fontSize: 13,
        fontWeight: 600,
        whiteSpace: 'nowrap',
      }}
    >
      {formatSlotChip(slot.starts_at_local)}
    </span>
  );
}

// Chip descriptivo (área / enfoque). Fondo tintado --ink-100; etiqueta de contenido, NO acción.
function DescriptorChip({ label }: { label: string }) {
  return (
    <span
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        padding: '2px var(--s12)',
        background: 'var(--ink-100)',
        color: 'var(--ink-700)',
        borderRadius: 'var(--radius-round)',
        fontSize: 13,
        lineHeight: '20px',
        whiteSpace: 'nowrap',
      }}
    >
      {label}
    </span>
  );
}

export function ProfileCard({ profile }: { profile: DirectoryProfile }) {
  const {
    slug, display_name, photo_url, is_verified, years_experience,
    about_me_excerpt, catalog, rating, marketplace_service, next_available_slots,
  } = profile;

  const perfilHref = `/psicologos/${slug}`;
  const horarioHref = `/psicologos/${slug}/agendar`;
  const hasReviews = rating.count > 0;
  const hasSlots = next_available_slots.length > 0;
  const serviceLine = [
    marketplace_service.display_name, 'En línea', `${marketplace_service.duration_minutes} min`,
  ].join(' · ');

  return (
    <article className="card" style={{ display: 'flex', flexDirection: 'column', gap: 'var(--s12)', padding: 'var(--s20)' }}>
      <header style={{ display: 'flex', gap: 'var(--s16)', alignItems: 'flex-start' }}>
        {photo_url ? (
          // eslint-disable-next-line @next/next/no-img-element -- pseudocódigo; en real: next/image
          <img src={photo_url} alt="" width={64} height={64}
            style={{ width: 64, height: 64, borderRadius: 'var(--radius-round)', objectFit: 'cover', flex: '0 0 auto', background: 'var(--purple-100)' }} />
        ) : (
          <span aria-hidden="true"
            style={{ width: 64, height: 64, flex: '0 0 auto', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', borderRadius: 'var(--radius-round)', background: 'var(--purple-100)', color: 'var(--purple-700)', fontFamily: 'var(--font-display)', fontWeight: 700, fontSize: 20 }}>
            {initials(display_name)}
          </span>
        )}
        <div style={{ minWidth: 0, flex: 1 }}>
          <h2 style={{ fontFamily: 'var(--font-display)', fontWeight: 700, fontSize: 18, lineHeight: 1.25, color: 'var(--ink-900)', margin: '0 0 var(--s4)' }}>
            <Link href={perfilHref} style={{ color: 'inherit', textDecoration: 'none' }}>{display_name}</Link>
          </h2>
          <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 'var(--s8)' }}>
            {is_verified && (
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, color: 'var(--success-700)', fontSize: 13, fontWeight: 600 }}>
                <span aria-hidden="true">✔</span> Profesional validado
              </span>
            )}
            {years_experience != null && years_experience > 0 && (
              <span className="num" style={{ color: 'var(--ink-500)', fontSize: 13 }}>
                {years_experience} {years_experience === 1 ? 'año' : 'años'} de experiencia
              </span>
            )}
          </div>
          <div style={{ marginTop: 'var(--s4)' }}>
            {hasReviews ? (
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 14 }}>
                <span aria-hidden="true" style={{ color: 'var(--amber-600)' }}>★</span>
                <span className="num" style={{ color: 'var(--ink-900)', fontWeight: 600 }}>{rating.average.toFixed(1)}</span>
                <span className="num" style={{ color: 'var(--ink-500)' }}>({rating.count} {rating.count === 1 ? 'opinión' : 'opiniones'})</span>
              </span>
            ) : (
              <span style={{ color: 'var(--ink-500)', fontSize: 14 }}>Sin opiniones aún</span>
            )}
          </div>
        </div>
      </header>

      {(catalog.approaches.length > 0 || catalog.areas.length > 0) && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 'var(--s8)' }}>
          {catalog.approaches.map((c) => <DescriptorChip key={`ap-${c.id}`} label={c.label} />)}
          {catalog.areas.map((c) => <DescriptorChip key={`ar-${c.id}`} label={c.label} />)}
        </div>
      )}

      {about_me_excerpt && (
        <p style={{ color: 'var(--ink-700)', fontSize: 14, lineHeight: 1.5, margin: 0 }}>{about_me_excerpt}</p>
      )}

      <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'baseline', justifyContent: 'space-between', gap: 'var(--s8)', paddingTop: 'var(--s12)', borderTop: '1px solid var(--border)' }}>
        <span style={{ color: 'var(--ink-500)', fontSize: 13 }}>{serviceLine}</span>
        <span className="num" style={{ fontFamily: 'var(--font-display)', fontWeight: 700, fontSize: 18, color: 'var(--ink-900)' }}>
          {formatPrice(marketplace_service.price_mxn)}
        </span>
      </div>

      {/*
        Próximos horarios (decisión revisada de D-B, ver MARKETPLACE.md). Informativo,
        NO clicable: los chips nunca navegan directo a crear un hold. Vacío ⇒ mensaje +
        se oculta "Elegir horario" (solo queda "Ver perfil").
      */}
      {hasSlots ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--s8)' }}>
          <span style={{ color: 'var(--ink-500)', fontSize: 13, fontWeight: 500 }}>Próximos horarios</span>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 'var(--s8)' }}>
            {next_available_slots.map((s) => <SlotChip key={s.starts_at} slot={s} />)}
          </div>
        </div>
      ) : (
        <span style={{ color: 'var(--ink-500)', fontSize: 13 }}>Sin horarios disponibles próximamente</span>
      )}

      <div style={{ display: 'flex', gap: 'var(--s12)', marginTop: 'var(--s4)' }}>
        <Link href={perfilHref} className="btn-secondary" style={{ flex: 1, textDecoration: 'none' }}>Ver perfil</Link>
        {hasSlots && (
          <Link href={horarioHref} className="cta-primary" style={{ flex: 1, textDecoration: 'none' }}>Elegir horario</Link>
        )}
      </div>
    </article>
  );
}
