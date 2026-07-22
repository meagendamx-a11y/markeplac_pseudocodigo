// =====================================================================================
// app/page.tsx — Landing del marketplace (paciente). Ruta pública raíz `/`.
//
// Contrato: paginas/marketplace-landing.md (jerarquía de secciones, navegación y "pendiente
//           de pulido") + FLUJOS_NAVEGACION.md § Marketplace (fila `/` → landing; CTA a
//           listado/afinidad). Sistema visual: DISENO_UI.md §1 (morado solo para lo importante)
//           y §8 (contraste AA, foco visible, touch mínimo, textos UI en español).
//
// Responsabilidad del archivo (y SOLO esto):
//   Página de marketing ESTÁTICA. Explica la propuesta y lleva a (a) buscar psicólogo
//   [/psicologos] y (b) el test de afinidad. Sin lógica transaccional, sin estados de datos.
//
// INVARIANTES DE SEGURIDAD (MARKETPLACE.md) — aquí se cumplen por AUSENCIA de superficie:
//   - Es un Server Component puro de presentación: NO lee/escribe cookies, NO toca el
//     service_role, NI Supabase, NI Stripe, NI el estado de hold/cita/pago. No hay nada
//     autoritativo en el cliente porque no hay cliente: no se hidrata estado ni datos privados.
//   - Sin datos clínicos ni de pago. No muestra slots ni disponibilidad puntual (el contrato
//     prohíbe "promesas de disponibilidad" en la landing): la reserva real vive en el flujo
//     de agendado por :slug, no aquí.
//   - Sin colores hardcodeados: todo color/tamaño/radio sale de los tokens de DISENO_UI
//     (styles/tokens.css, cargado por app/layout.tsx). #E8E6FF (--purple-200) jamás como
//     texto ni botón (§1,§8): solo tint de superficie.
//
// Al ser estática, es idónea para SSR/prerender (SEO por `/`); la metadata base la aporta
// app/layout.tsx (marca neutra). No requiere `generateMetadata` propio (no hay datos por slug).
// =====================================================================================

import type { CSSProperties } from 'react';
import Link from 'next/link';

// -------------------------------------------------------------------------------------
// Rutas de destino (única fuente: FLUJOS_NAVEGACION.md § Marketplace).
//   ROUTE_LISTADO  → `/psicologos`     (Listado / directorio).
//   ROUTE_PROFESIONAL → `/profesionales` (Landing del profesional / "Soy profesional").
//   ROUTE_AFINIDAD → Test de afinidad. FLUJOS lo lista SIN ruta canónica fija (se llega
//     "desde la landing / listado"); se centraliza aquí para que el pulido lo confirme sin
//     tocar el markup. `/psicologos/afinidad` lo mantiene dentro del espacio del paciente.
// -------------------------------------------------------------------------------------
const ROUTE_LISTADO = '/psicologos';
const ROUTE_PROFESIONAL = '/profesionales';
const ROUTE_AFINIDAD = '/psicologos/afinidad';

// -------------------------------------------------------------------------------------
// Estilos como objetos que consumen los tokens CSS (var(--*)). Se usan junto a las clases
// utilitarias de tokens.css (.cta-primary, .btn-secondary, .card). No se declara ni un color
// literal: cada valor referencia un token de DISENO_UI §2/§4.
// NOTA de jerarquía visual (DISENO_UI §1 "morado solo para lo importante · CTA único"):
//   el ÚNICO ACCIÓN primaria (morado sólido, .cta-primary) es "Buscar psicólogo(s)" — se
//   repite al inicio (hero) y al cierre porque es la MISMA acción de conversión, no dos
//   primarios en competencia. El test de afinidad es una vía ALTERNATIVA → botón secundario.
// -------------------------------------------------------------------------------------

const page: CSSProperties = {
  // Ancho de contenido cómodo para lectura; centrado. El fondo lavanda lo pone tokens.css (body).
  maxWidth: 1120,
  margin: '0 auto',
  padding: `0 var(--s20)`,
};

const appBar: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  gap: 'var(--s16)',
  minHeight: 64,
  padding: `var(--s16) 0`,
};

const brand: CSSProperties = {
  fontFamily: 'var(--font-display)',
  fontWeight: 800,
  fontSize: 20,
  color: 'var(--purple-700)', // marca sobre fondo claro: morado de texto, no el de acción (§2).
  textDecoration: 'none',
  letterSpacing: '-0.01em',
};

const navLink: CSSProperties = {
  fontFamily: 'var(--font-body)',
  fontWeight: 600,
  fontSize: 14,
  color: 'var(--ink-700)',
  textDecoration: 'none',
};

// Sección genérica: espaciado vertical amplio (escala 4/8, §4) para una landing "respirable".
const section: CSSProperties = { padding: `var(--s32) 0` };

const sectionTitle: CSSProperties = {
  fontFamily: 'var(--font-display)',
  fontWeight: 700,
  fontSize: 28,
  lineHeight: 1.2,
  color: 'var(--ink-900)',
  margin: `0 0 var(--s8)`,
  letterSpacing: '-0.01em',
};

const lead: CSSProperties = {
  fontFamily: 'var(--font-body)',
  fontSize: 16,
  lineHeight: 1.55,
  color: 'var(--ink-500)', // texto muted; el título ya lleva el contraste alto (AA garantizado).
  margin: 0,
};

// Rejilla responsiva de tarjetas sin media queries: auto-fit reparte columnas según el ancho.
const cardGrid: CSSProperties = {
  display: 'grid',
  gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))',
  gap: 'var(--s16)',
  marginTop: 'var(--s24)',
};

const cardBody: CSSProperties = { padding: 'var(--s20)' };

const cardHeading: CSSProperties = {
  fontFamily: 'var(--font-display)',
  fontWeight: 600,
  fontSize: 17,
  color: 'var(--ink-900)',
  margin: `0 0 var(--s4)`,
};

const cardText: CSSProperties = {
  fontFamily: 'var(--font-body)',
  fontSize: 14,
  lineHeight: 1.5,
  color: 'var(--ink-500)',
  margin: 0,
};

// Chip de confianza: superficie tintada (--purple-100) + texto morado de lectura (--purple-700).
// #E8E6FF (--purple-200) NO se usa como texto/relleno de botón (§1,§8).
const trustChip: CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: 'var(--s8)',
  padding: `var(--s8) var(--s12)`,
  background: 'var(--purple-100)',
  color: 'var(--purple-700)',
  fontFamily: 'var(--font-body)',
  fontWeight: 600,
  fontSize: 13,
  borderRadius: 'var(--radius-round)',
};

// Punto/indicador del chip (decorativo): usa el morado de acción como acento pequeño.
const chipDot: CSSProperties = {
  width: 8,
  height: 8,
  borderRadius: '50%',
  background: 'var(--purple-600)',
};

// -------------------------------------------------------------------------------------
// Datos de la página (copy PLACEHOLDER, marcado como pendiente de pulido en el contrato).
// Se modela como datos y no como JSX suelto para que el ritual de pulido edite texto sin
// tocar estructura. Nada de esto es dato privado ni disponibilidad real.
// -------------------------------------------------------------------------------------

/** §3 Cómo funciona / valor — 3 tarjetas (contrato: conoce antes de elegir · horarios reales · reserva con claridad). */
const VALOR = [
  {
    title: 'Conoce antes de elegir',
    text: 'Lee el enfoque, las áreas y la experiencia de cada profesional para decidir con calma.',
  },
  {
    title: 'Horarios reales',
    text: 'Ve profesionales con agenda abierta y elige un espacio que encaje con tu semana.',
  },
  {
    title: 'Reserva con claridad',
    text: 'Precios transparentes y confirmación clara: sabes qué reservas y cuánto cuesta.',
  },
] as const;

/** §5 Tu primera sesión en 3 pasos. */
const PASOS = [
  { n: 1, title: 'Cuéntanos qué buscas', text: 'Un test breve orienta tu búsqueda hacia lo que necesitas.' },
  { n: 2, title: 'Explora profesionales', text: 'Compara enfoques, áreas y precios en un mismo lugar.' },
  { n: 3, title: 'Elige horario y reserva', text: 'Escoge el espacio disponible que mejor te acomode.' },
] as const;

/** §6 Señales de confianza — 4 tarjetas (perfiles claros · áreas y enfoques · precios transparentes · horarios disponibles). */
const CONFIANZA = [
  { title: 'Perfiles claros', text: 'Cada profesional muestra su formación y su forma de trabajar.' },
  { title: 'Áreas y enfoques', text: 'Filtra por lo que te importa: ansiedad, pareja, duelo y más.' },
  { title: 'Precios transparentes', text: 'El costo de la sesión se muestra antes de reservar.' },
  { title: 'Horarios disponibles', text: 'Solo ves profesionales que hoy pueden recibirte.' },
] as const;

// -------------------------------------------------------------------------------------
// Componente. Server Component por defecto (sin 'use client'): se renderiza en el servidor,
// ideal para SEO de `/`. No recibe props ni consulta datos.
// -------------------------------------------------------------------------------------

export default function MarketplaceLandingPage() {
  return (
    <>
      {/* 1. APP BAR — logo + "Soy profesional" (→ landing profesional). */}
      <header style={page}>
        <nav style={appBar} aria-label="Barra principal">
          <Link href="/" style={brand} aria-label="Agenda Psi — inicio">
            Agenda Psi
          </Link>
          <Link href={ROUTE_PROFESIONAL} style={navLink}>
            Soy profesional
          </Link>
        </nav>
      </header>

      <main style={page}>
        {/* 2. HERO — título + subtítulo + CTA primario "Buscar psicólogo" + chip de confianza.
             La imagen del contrato queda como placeholder de pulido (branding pendiente). */}
        <section style={{ ...section, paddingTop: 'var(--s24)' }} aria-labelledby="hero-title">
          <div style={{ maxWidth: 680 }}>
            <span style={trustChip}>
              <span style={chipDot} aria-hidden="true" />
              Profesional validado
            </span>

            <h1
              id="hero-title"
              style={{
                fontFamily: 'var(--font-display)',
                fontWeight: 800,
                fontSize: 40,
                lineHeight: 1.12,
                letterSpacing: '-0.02em',
                color: 'var(--ink-900)',
                margin: `var(--s16) 0 var(--s12)`,
              }}
            >
              Encuentra un psicólogo que conecte contigo
            </h1>

            <p style={{ ...lead, fontSize: 18 }}>
              Compara profesionales validados, conoce su enfoque y agenda tu primera sesión en
              línea, con precios claros y sin complicaciones.
            </p>

            {/* CTA ÚNICO primario de la página (morado sólido). Navega al listado. */}
            <div style={{ marginTop: 'var(--s24)' }}>
              <Link href={ROUTE_LISTADO} className="cta-primary">
                Buscar psicólogo
              </Link>
            </div>
          </div>
        </section>

        {/* 3. CÓMO FUNCIONA / VALOR — "Buscar apoyo no debería sentirse complicado" + 3 tarjetas. */}
        <section style={section} aria-labelledby="valor-title">
          <h2 id="valor-title" style={sectionTitle}>
            Buscar apoyo no debería sentirse complicado
          </h2>
          <p style={lead}>Te damos lo justo para elegir con confianza, sin ruido.</p>

          <div style={cardGrid}>
            {VALOR.map((c) => (
              <article key={c.title} className="card">
                <div style={cardBody}>
                  <h3 style={cardHeading}>{c.title}</h3>
                  <p style={cardText}>{c.text}</p>
                </div>
              </article>
            ))}
          </div>
        </section>

        {/* 4. "¿No sabes por dónde empezar?" → CTA "Hacer test de afinidad" (vía ALTERNATIVA:
             botón secundario para no competir con el primario morado). */}
        <section style={section} aria-labelledby="afinidad-title">
          <article
            className="card"
            style={{ background: 'var(--purple-50)', borderColor: 'var(--purple-300)' }}
          >
            <div
              style={{
                ...cardBody,
                display: 'flex',
                flexWrap: 'wrap',
                alignItems: 'center',
                justifyContent: 'space-between',
                gap: 'var(--s16)',
                padding: 'var(--s24)',
              }}
            >
              <div style={{ maxWidth: 620 }}>
                <h2 id="afinidad-title" style={{ ...sectionTitle, fontSize: 24, marginBottom: 'var(--s4)' }}>
                  ¿No sabes por dónde empezar?
                </h2>
                <p style={lead}>
                  Responde unas preguntas breves y te orientamos hacia profesionales afines a lo
                  que buscas.
                </p>
              </div>
              <Link href={ROUTE_AFINIDAD} className="btn-secondary">
                Hacer test de afinidad
              </Link>
            </div>
          </article>
        </section>

        {/* 5. "Tu primera sesión en 3 pasos". */}
        <section style={section} aria-labelledby="pasos-title">
          <h2 id="pasos-title" style={sectionTitle}>
            Tu primera sesión en 3 pasos
          </h2>

          <ol
            style={{
              listStyle: 'none',
              margin: 'var(--s24) 0 0',
              padding: 0,
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))',
              gap: 'var(--s16)',
            }}
          >
            {PASOS.map((p) => (
              <li key={p.n} className="card">
                <div style={cardBody}>
                  {/* Número del paso: círculo tintado + morado de lectura (no #E8E6FF como texto). */}
                  <span
                    className="num"
                    style={{
                      display: 'inline-flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      width: 36,
                      height: 36,
                      borderRadius: '50%',
                      background: 'var(--purple-100)',
                      color: 'var(--purple-700)',
                      fontFamily: 'var(--font-display)',
                      fontWeight: 700,
                      fontSize: 16,
                      marginBottom: 'var(--s12)',
                    }}
                    aria-hidden="true"
                  >
                    {p.n}
                  </span>
                  <h3 style={cardHeading}>{p.title}</h3>
                  <p style={cardText}>{p.text}</p>
                </div>
              </li>
            ))}
          </ol>
        </section>

        {/* 6. SEÑALES DE CONFIANZA — 4 tarjetas. */}
        <section style={section} aria-labelledby="confianza-title">
          <h2 id="confianza-title" style={sectionTitle}>
            Por qué reservar con Agenda Psi
          </h2>

          <div style={cardGrid}>
            {CONFIANZA.map((c) => (
              <article key={c.title} className="card">
                <div style={cardBody}>
                  <h3 style={cardHeading}>{c.title}</h3>
                  <p style={cardText}>{c.text}</p>
                </div>
              </article>
            ))}
          </div>
        </section>

        {/* 7. CIERRE — repite la MISMA acción de conversión (morado) al final del recorrido. */}
        <section
          style={{ ...section, textAlign: 'center', paddingBottom: 'var(--s32)' }}
          aria-labelledby="cierre-title"
        >
          <h2 id="cierre-title" style={{ ...sectionTitle, fontSize: 30 }}>
            Da el primer paso cuando estés listo
          </h2>
          <p style={{ ...lead, maxWidth: 560, margin: '0 auto var(--s24)' }}>
            Explora profesionales validados y encuentra a quien mejor conecte contigo.
          </p>
          <Link href={ROUTE_LISTADO} className="cta-primary">
            Buscar psicólogos validados
          </Link>
        </section>
      </main>

      {/* 8. FOOTER — Agenda Psi · Privacidad · Ayuda · Soy profesional. */}
      <footer
        style={{
          borderTop: '1px solid var(--border)',
          background: 'var(--surface)',
          marginTop: 'var(--s24)',
        }}
      >
        <div
          style={{
            ...page,
            display: 'flex',
            flexWrap: 'wrap',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: 'var(--s16)',
            padding: `var(--s24) var(--s20)`,
          }}
        >
          <span style={{ ...brand, fontSize: 16 }}>Agenda Psi</span>
          <nav
            aria-label="Enlaces de pie"
            style={{ display: 'flex', flexWrap: 'wrap', gap: 'var(--s20)' }}
          >
            {/* Rutas de pulido: Privacidad/Ayuda se enlazarán a sus páginas legales/soporte
                cuando existan; se dejan como destinos declarados (no #). */}
            <Link href="/privacidad" style={navLink}>
              Privacidad
            </Link>
            <Link href="/ayuda" style={navLink}>
              Ayuda
            </Link>
            <Link href={ROUTE_PROFESIONAL} style={navLink}>
              Soy profesional
            </Link>
          </nav>
        </div>
      </footer>
    </>
  );
}
