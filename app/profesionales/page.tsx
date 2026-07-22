// app/profesionales/page.tsx
// -----------------------------------------------------------------------------
// Landing de captación profesional (/profesionales).
// Contrato: agenda-psi-database/paginas/landing-profesional.md
//   - Ruta pública para psicólogos ("Soy profesional"). Objetivo: explicar el
//     valor (menos tareas administrativas) y llevar a prueba gratis / registro.
//   - "Una sola vista estática. Responsive." (§ Estados de la pantalla).
//   - Sin lógica transaccional: el alta real vive en el flujo de registro/perfil
//     (perfil-profesional.md). Aquí NO hay RPC de dominio (§ Funciones que llama).
//
// Seguridad (MARKETPLACE.md): al ser marketing 100% estático NO toca cookie de
// sesión, service_role, anon key ni datos clínicos/de pago. Es un Server
// Component sin estado; los CTAs son navegación pura (registro / login).
//
// Diseño (DISENO_UI §1,§8): morado SOLO para marca y el CTA único por sección;
// #E8E6FF (--purple-200) jamás como texto/botón, solo tint. Contraste AA, foco
// visible (heredado de tokens.css), textos UI en español, ids en inglés.
// Usa exclusivamente los tokens de styles/tokens.css (var(--*), .cta-primary,
// .btn-secondary, .card). Nada hardcodeado.
// -----------------------------------------------------------------------------

import type { Metadata } from 'next';
import Link from 'next/link';

// Página estática: se prerenderiza en build (SSR/SEO por ruta pública).
export const dynamic = 'force-static';

export const metadata: Metadata = {
  title: 'Agenda Psi para psicólogos · Menos tareas administrativas',
  description:
    'Organiza tu consulta psicológica sin perder tiempo en tareas administrativas: agenda, ficha del paciente, recordatorios y confirmaciones por WhatsApp, reprogramación y pagos. Prueba gratis.',
  alternates: { canonical: '/profesionales' },
};

// Rutas de navegación (contrato § Navegación). El alta real vive en el flujo de
// registro/onboarding; iniciar sesión va a /login. Se centralizan para adaptar.
const ROUTE_SIGNUP = '/registro';
const ROUTE_LOGIN = '/login';

// --- Datos de contenido (copy provisional; "copy final" es fase de pulido) -----

// § 4. "Todo lo que necesitas para gestionar tu consulta"
const FEATURES: ReadonlyArray<{ title: string; body: string }> = [
  { title: 'Agenda', body: 'Todas tus citas en un solo lugar, sin cuadernos ni notas sueltas.' },
  { title: 'Ficha del paciente', body: 'Historial y datos de cada persona, ordenados y a la mano.' },
  { title: 'Servicios y tarifas', body: 'Define tus modalidades y precios una vez y reutilízalos.' },
  { title: 'Horarios flexibles', body: 'Configura tu disponibilidad real, con bloqueos y excepciones.' },
  { title: 'Recordatorios automáticos', body: 'Menos ausencias: cada cita recuerda a tu paciente por ti.' },
  { title: 'Confirmación por WhatsApp', body: 'La confirmación llega por el canal que tus pacientes ya usan.' },
  { title: 'Reprogramación', body: 'Mueve o reagenda citas sin cadenas de mensajes interminables.' },
  { title: 'Pagos y comprobantes', body: 'Cobros y comprobantes registrados, sin perder el rastro del dinero.' },
];

// § 3. "Agenda Psi te ayuda con lo administrativo" (dolor → solución).
const PAINS: ReadonlyArray<{ pain: string; relief: string }> = [
  { pain: 'Mensajes a horas inusuales para agendar', relief: 'Tus pacientes agendan solos; tú revisas cuando puedes.' },
  { pain: 'Cancelaciones y cambios de última hora', relief: 'Reprograma en segundos y avisa automáticamente.' },
  { pain: 'Pagos que se pierden o se olvidan', relief: 'Cada cobro queda registrado con su comprobante.' },
];

// § 5. "Lo que cambia cuando dejas de administrar todo a mano" (beneficios).
const BENEFITS: ReadonlyArray<string> = [
  'Recuperas horas cada semana que hoy se van en coordinar citas.',
  'Menos ausencias y huecos gracias a recordatorios y confirmaciones.',
  'Una imagen profesional y ordenada frente a tus pacientes.',
  'Tranquilidad: sabes qué se pagó, qué falta y qué viene después.',
];

// § 6. "Hecha para psicólogos que trabajan y quieren trabajar mejor" (ICP).
const ICP: ReadonlyArray<string> = [
  'Psicólogas y psicólogos independientes con consulta privada.',
  'Quienes hoy mueven y confirman citas por WhatsApp.',
  'Quienes atienden en línea, presencial o ambas.',
  'Quienes quieren dedicar su tiempo a atender, no a administrar.',
];

export default function LandingProfesionalPage() {
  return (
    <main className="landing">
      {/* Estilos co-locados: solo layout/tipografía de la página. Todos los
          valores salen de tokens.css (var(--*)); las clases .cta-primary /
          .btn-secondary / .card provienen del sistema global. */}
      <style>{PAGE_CSS}</style>

      {/* ── 1. App bar: logo + iniciar sesión ─────────────────────────────── */}
      <header className="appbar">
        <div className="appbar__inner">
          <Link href="/" className="brand" aria-label="Agenda Psi — inicio">
            <span className="brand__mark" aria-hidden="true" />
            <span className="brand__name">Agenda Psi</span>
          </Link>
          <Link href={ROUTE_LOGIN} className="btn-secondary">
            Iniciar sesión
          </Link>
        </div>
      </header>

      {/* ── 2. Hero + CTA único "Prueba gratis" + chip WhatsApp ───────────── */}
      <section className="hero" aria-labelledby="hero-title">
        <div className="hero__copy">
          <p className="chip chip--whatsapp">Confirmaciones por WhatsApp</p>
          <h1 id="hero-title" className="hero__title">
            Organiza tu consulta psicológica sin perder tiempo en tareas
            administrativas
          </h1>
          <p className="hero__sub">
            Agenda, recordatorios, confirmaciones y pagos en un solo lugar.
            Dedica tu tiempo a atender, no a coordinar mensajes.
          </p>
          <div className="hero__actions">
            {/* CTA único de la sección (DISENO_UI §1): morado sólido. */}
            <Link href={ROUTE_SIGNUP} className="cta-primary">
              Prueba gratis
            </Link>
            <span className="hero__note">Sin tarjeta para empezar.</span>
          </div>
        </div>
        {/* Visual del hero: placeholder tintado (branding e imágenes = fase de
            pulido). Decorativo → aria-hidden. */}
        <div className="hero__visual card" aria-hidden="true">
          <div className="hero__visual-tint" />
        </div>
      </section>

      {/* ── 3. "Agenda Psi te ayuda con lo administrativo" (dolor → solución) ─ */}
      <section className="section" aria-labelledby="pains-title">
        <h2 id="pains-title" className="section__title">
          Agenda Psi te ayuda con lo administrativo
        </h2>
        <ul className="grid grid--3" role="list">
          {PAINS.map(({ pain, relief }) => (
            <li key={pain} className="card pain">
              <p className="pain__label">Antes</p>
              <p className="pain__text">{pain}</p>
              <p className="pain__label pain__label--relief">Con Agenda Psi</p>
              <p className="pain__relief">{relief}</p>
            </li>
          ))}
        </ul>
      </section>

      {/* ── 4. "Todo lo que necesitas para gestionar tu consulta" ─────────── */}
      <section className="section" aria-labelledby="features-title">
        <h2 id="features-title" className="section__title">
          Todo lo que necesitas para gestionar tu consulta
        </h2>
        <ul className="grid grid--4" role="list">
          {FEATURES.map(({ title, body }) => (
            <li key={title} className="card feature">
              <span className="feature__dot" aria-hidden="true" />
              <h3 className="feature__title">{title}</h3>
              <p className="feature__body">{body}</p>
            </li>
          ))}
        </ul>
      </section>

      {/* ── 5. "Lo que cambia cuando dejas de administrar todo a mano" ─────── */}
      <section className="section section--tint" aria-labelledby="benefits-title">
        <h2 id="benefits-title" className="section__title">
          Lo que cambia cuando dejas de administrar todo a mano
        </h2>
        <ul className="benefits" role="list">
          {BENEFITS.map((benefit) => (
            <li key={benefit} className="benefit">
              <span className="benefit__check" aria-hidden="true">
                ✓
              </span>
              <span>{benefit}</span>
            </li>
          ))}
        </ul>
      </section>

      {/* ── 6. "Hecha para psicólogos que trabajan y quieren trabajar mejor" ─ */}
      <section className="section" aria-labelledby="icp-title">
        <h2 id="icp-title" className="section__title">
          Hecha para psicólogos que trabajan y quieren trabajar mejor
        </h2>
        <ul className="grid grid--2" role="list">
          {ICP.map((item) => (
            <li key={item} className="card icp">
              {item}
            </li>
          ))}
        </ul>
      </section>

      {/* ── 7. Prueba social / propósito ──────────────────────────────────── */}
      <section className="section proof" aria-labelledby="proof-title">
        <h2 id="proof-title" className="proof__title">
          Construida con psicólogos reales, para la práctica real.
        </h2>
      </section>

      {/* ── 8. Cierre + CTA único "Prueba gratis" ─────────────────────────── */}
      <section className="section closing" aria-labelledby="closing-title">
        <div className="card closing__card">
          <h2 id="closing-title" className="closing__title">
            ¿Quieres pasar menos tiempo administrando y más tiempo atendiendo?
          </h2>
          <Link href={ROUTE_SIGNUP} className="cta-primary">
            Prueba gratis
          </Link>
        </div>
      </section>

      {/* ── 9. Footer ─────────────────────────────────────────────────────── */}
      <footer className="footer">
        <div className="footer__inner">
          <span className="brand__name">Agenda Psi</span>
          <nav className="footer__nav" aria-label="Enlaces del pie de página">
            <Link href={ROUTE_LOGIN}>Iniciar sesión</Link>
            <Link href={ROUTE_SIGNUP}>Prueba gratis</Link>
          </nav>
          <span className="footer__legal">
            © {new Date().getFullYear()} Agenda Psi
          </span>
        </div>
      </footer>
    </main>
  );
}

// -----------------------------------------------------------------------------
// Estilos de la página. SOLO layout/tipografía; color/radio/espaciado desde
// tokens.css. Mobile-first + breakpoints; foco visible lo aporta tokens.css.
// -----------------------------------------------------------------------------
const PAGE_CSS = `
.landing { display: block; }

/* Contenedor de anchura de lectura, centrado. */
.appbar__inner, .hero, .section, .footer__inner {
  max-width: 1120px;
  margin: 0 auto;
  padding-left: var(--s20);
  padding-right: var(--s20);
}

/* 1. App bar */
.appbar { border-bottom: 1px solid var(--border); background: var(--surface); }
.appbar__inner {
  display: flex; align-items: center; justify-content: space-between;
  min-height: 64px;
}
.brand { display: inline-flex; align-items: center; gap: var(--s8); text-decoration: none; }
.brand__mark {
  width: 22px; height: 22px; border-radius: var(--radius-round);
  background: var(--purple-600);
}
.brand__name {
  font-family: var(--font-display); font-weight: 700; font-size: 18px;
  color: var(--ink-900);
}

/* 2. Hero */
.hero {
  display: grid; grid-template-columns: 1fr; gap: var(--s24);
  padding-top: var(--s32); padding-bottom: var(--s32);
}
.hero__title {
  font-family: var(--font-display); font-weight: 800;
  font-size: clamp(28px, 5vw, 44px); line-height: 1.12;
  color: var(--ink-900); margin: var(--s16) 0 var(--s12);
}
.hero__sub {
  font-size: 18px; line-height: 1.5; color: var(--ink-700);
  max-width: 46ch; margin: 0 0 var(--s24);
}
.hero__actions { display: flex; align-items: center; gap: var(--s16); flex-wrap: wrap; }
.hero__note { font-size: 14px; color: var(--ink-500); }
.hero__visual {
  min-height: 260px; overflow: hidden; padding: 0;
  background: var(--purple-50);
}
.hero__visual-tint {
  /* Placeholder tintado: #E8E6FF SOLO como tint, nunca texto/botón (§1,§8). */
  width: 100%; height: 100%;
  background: linear-gradient(135deg, var(--purple-100), var(--purple-200));
}

/* Chip (§ Hero: "Chip WhatsApp"). */
.chip {
  display: inline-flex; align-items: center; gap: var(--s8);
  padding: 6px var(--s12); border-radius: var(--radius-round);
  background: var(--purple-100); color: var(--purple-700);
  font-size: 13px; font-weight: 600;
}

/* Secciones genéricas */
.section { padding-top: var(--s32); padding-bottom: var(--s32); }
.section--tint { background: var(--purple-50); }
.section__title {
  font-family: var(--font-display); font-weight: 700;
  font-size: clamp(22px, 3vw, 30px); line-height: 1.2;
  color: var(--ink-900); margin: 0 0 var(--s24);
}

/* Grids responsivos */
.grid { display: grid; gap: var(--s16); grid-template-columns: 1fr; list-style: none; padding: 0; margin: 0; }
@media (min-width: 640px) {
  .hero { grid-template-columns: 1.1fr 0.9fr; align-items: center; }
  .grid--2 { grid-template-columns: repeat(2, 1fr); }
  .grid--3 { grid-template-columns: repeat(2, 1fr); }
  .grid--4 { grid-template-columns: repeat(2, 1fr); }
}
@media (min-width: 960px) {
  .grid--3 { grid-template-columns: repeat(3, 1fr); }
  .grid--4 { grid-template-columns: repeat(4, 1fr); }
}

/* 3. Dolor → solución */
.pain { padding: var(--s20); display: flex; flex-direction: column; gap: var(--s4); }
.pain__label {
  font-size: 12px; font-weight: 700; letter-spacing: .04em; text-transform: uppercase;
  color: var(--ink-500); margin: 0;
}
.pain__label--relief { color: var(--purple-700); margin-top: var(--s12); }
.pain__text { color: var(--ink-700); margin: 0; }
.pain__relief { color: var(--ink-900); font-weight: 600; margin: 0; }

/* 4. Features */
.feature { padding: var(--s20); display: flex; flex-direction: column; gap: var(--s8); }
.feature__dot {
  width: 12px; height: 12px; border-radius: var(--radius-round);
  background: var(--purple-600);
}
.feature__title {
  font-family: var(--font-display); font-weight: 600; font-size: 16px;
  color: var(--ink-900); margin: 0;
}
.feature__body { font-size: 14px; line-height: 1.45; color: var(--ink-700); margin: 0; }

/* 5. Beneficios */
.benefits { list-style: none; padding: 0; margin: 0; display: grid; gap: var(--s16); }
@media (min-width: 640px) { .benefits { grid-template-columns: repeat(2, 1fr); } }
.benefit {
  display: flex; align-items: flex-start; gap: var(--s12);
  font-size: 16px; color: var(--ink-900);
}
.benefit__check {
  flex: 0 0 auto; width: 24px; height: 24px; border-radius: var(--radius-round);
  display: inline-flex; align-items: center; justify-content: center;
  background: var(--success-100); color: var(--success-700);
  font-weight: 700; font-size: 14px;
}

/* 6. ICP */
.icp { padding: var(--s20); color: var(--ink-700); line-height: 1.45; }

/* 7. Prueba social */
.proof { text-align: center; }
.proof__title {
  font-family: var(--font-display); font-weight: 700;
  font-size: clamp(20px, 3vw, 28px); color: var(--ink-900);
  max-width: 24ch; margin: 0 auto;
}

/* 8. Cierre */
.closing__card {
  padding: var(--s32); text-align: center;
  display: flex; flex-direction: column; align-items: center; gap: var(--s24);
  background: var(--purple-50);
}
.closing__title {
  font-family: var(--font-display); font-weight: 700;
  font-size: clamp(22px, 3vw, 30px); color: var(--ink-900);
  max-width: 30ch; margin: 0;
}

/* 9. Footer */
.footer { border-top: 1px solid var(--border); background: var(--surface); margin-top: var(--s32); }
.footer__inner {
  display: flex; align-items: center; justify-content: space-between;
  gap: var(--s16); flex-wrap: wrap; min-height: 72px;
  padding-top: var(--s16); padding-bottom: var(--s16);
}
.footer__nav { display: flex; gap: var(--s20); }
.footer__nav a { color: var(--purple-700); text-decoration: none; font-size: 14px; }
.footer__legal { color: var(--ink-500); font-size: 13px; }
`;
