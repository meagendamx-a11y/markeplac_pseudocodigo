// =====================================================================================
// app/layout.tsx — Root layout del marketplace paciente (Next.js App Router, SSR).
//
// Contrato: DISENO_UI.md §0 (marca / dos audiencias, un solo sistema) y §3 (tipografía:
//           Display=Sora 600/700/800, Body=IBM Plex Sans 400/500/600/700). Cross-ref de
//           navegación pública por :slug y "meta social solo con allowlist pública":
//           MARKETPLACE.md § "Deep-link / meta social" (~L540) y § cookie/dominio único (~L199).
//
// Responsabilidad del archivo (y SOLO esto):
//   1. Cargar la hoja de tokens del sistema de diseño (styles/tokens.css) UNA vez, en la raíz.
//   2. Autohospedar las fuentes Sora / IBM Plex Sans con next/font (sin CDN externo) y
//      exponerlas como las MISMAS variables que consume tokens.css (--font-display / --font-body),
//      de modo que el documento no dependa de fuentes de sistema.
//   3. Fijar el idioma del documento en es-MX (textos de UI en español; DISENO_UI §1/§8).
//   4. Declarar la metadata BASE de SEO. Es la capa neutra: cada página pública (p. ej.
//      /psicologos/[slug]) SOBREESCRIBE title/description/OG con datos del allowlist público
//      vía su propio `generateMetadata`; los pasos privados del booking marcan `robots.noindex`.
//
// INVARIANTES DE SEGURIDAD (MARKETPLACE.md) que aplican aquí:
//   - Este layout es un Server Component puro de estructura: NO toca cookies, NI el
//     service_role, NI Supabase, NI Stripe. No hay estado autoritativo en el cliente.
//   - La metadata base no incluye ningún dato de paciente/pago; el detalle social lo pone
//     cada página desde campos públicos (nombre, foto, extracto de about_me). Aquí solo va
//     marca genérica del marketplace.
//   - Sin colores hardcodeados: el color de chrome del navegador (theme-color) refleja el
//     token de marca --purple-600 documentado en DISENO_UI §2 (única fuente del valor).
// =====================================================================================

import type { Metadata, Viewport } from 'next';
import { Sora, IBM_Plex_Sans } from 'next/font/google';

// Los tokens del sistema de diseño (paleta, tipografía, radios, .cta-primary, .card, …).
// Fuente única: DISENO_UI.md materializada como CSS. Importarla en la raíz garantiza que
// las variables (var(--purple-600), etc.) existan para TODO el árbol.
import '../styles/tokens.css';

// -------------------------------------------------------------------------------------
// Fuentes autohospedadas (next/font: cero requests a un CDN de terceros, sin CLS).
// Los pesos son EXACTAMENTE los de DISENO_UI §3; cada familia se publica en la variable
// CSS que tokens.css ya referencia como fallback literal, por lo que aquí solo se "rellena"
// con la fuente real. `display: 'swap'` evita texto invisible durante la carga.
// -------------------------------------------------------------------------------------

/** Display — títulos de pantalla, CTA, cifras clave (DISENO_UI §3: Sora 600/700/800). */
const sora = Sora({
  subsets: ['latin'],
  weight: ['600', '700', '800'],
  variable: '--font-display',
  display: 'swap',
});

/** Body — texto, labels, inputs, datos, botones secundarios (DISENO_UI §3: Plex 400..700). */
const ibmPlexSans = IBM_Plex_Sans({
  subsets: ['latin'],
  weight: ['400', '500', '600', '700'],
  variable: '--font-body',
  display: 'swap',
});

// -------------------------------------------------------------------------------------
// Metadata BASE de SEO. Neutra y de marca; las páginas por :slug la especializan.
// `metadataBase` permite que las URLs OG/canónicas relativas de las páginas se resuelvan
// contra el dominio único del marketplace (MARKETPLACE.md § cookie/dominio único).
// -------------------------------------------------------------------------------------

/**
 * Dominio público del marketplace. Se lee de entorno para no fijar el host en el código;
 * el fallback es solo para desarrollo/preview. NEXT_PUBLIC_ es correcto: es una URL pública,
 * no un secreto (a diferencia del service_role, que jamás lleva ese prefijo).
 */
const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL ?? 'https://agendapsi.mx';

export const metadata: Metadata = {
  metadataBase: new URL(SITE_URL),
  title: {
    // Cada página pública pasa su propio título; se compone como "<Perfil> · Agenda Psi".
    default: 'Agenda Psi — Encuentra a tu psicólogo y agenda en línea',
    template: '%s · Agenda Psi',
  },
  description:
    'Agenda Psi conecta pacientes con psicólogos verificados en México. ' +
    'Encuentra un profesional, elige tu horario y agenda tu sesión en línea de forma segura.',
  applicationName: 'Agenda Psi',
  // Marketplace público → indexable por defecto. Los pasos del booking (hold, tus datos,
  // verificación, pago, resultado) declaran `robots: { index: false }` en su propia metadata.
  robots: {
    index: true,
    follow: true,
  },
  openGraph: {
    type: 'website',
    siteName: 'Agenda Psi',
    locale: 'es_MX',
    url: SITE_URL,
    title: 'Agenda Psi — Encuentra a tu psicólogo y agenda en línea',
    description:
      'Psicólogos verificados en México. Encuentra, elige horario y agenda tu sesión en línea.',
  },
  twitter: {
    card: 'summary_large_image',
    title: 'Agenda Psi',
    description:
      'Psicólogos verificados en México. Encuentra, elige horario y agenda tu sesión en línea.',
  },
  // No teléfonos autodetectados: evita que iOS convierta cifras (precios, horarios) en links.
  formatDetection: { telephone: false, email: false, address: false },
};

// `viewport` va separado de `metadata` (convención de Next 15).
export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  // theme-color = --purple-600 (#574FA8) de DISENO_UI §2. La meta theme-color no puede leer
  // variables CSS, por eso se refleja el valor del token aquí; la FUENTE sigue siendo el token.
  themeColor: '#574FA8',
};

// -------------------------------------------------------------------------------------
// Root layout. `lang="es-MX"` (audiencia paciente en español, DISENO_UI §1/§8). Las clases
// `sora.variable` / `ibmPlexSans.variable` publican --font-display / --font-body en el <html>,
// que tokens.css consume (body { font-family: var(--font-body) }).
// -------------------------------------------------------------------------------------

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="es-MX" className={`${sora.variable} ${ibmPlexSans.variable}`}>
      {/* El estilo base del <body> (fondo lavanda --purple-50, color --ink-900, tipografía
          body) lo aplica tokens.css; no se hardcodea nada aquí. */}
      <body>{children}</body>
    </html>
  );
}
