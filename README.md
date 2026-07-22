# markeplac_pseudocodigo — Marketplace paciente (superficie web, pseudocódigo)

Superficie **pública/paciente** de Agenda Psi: directorio de psicólogos, perfil público,
selección de horario, identificación + OTP, pago con Stripe y resultado. **Fuente de verdad
del comportamiento:** `agenda-psi-database` (`MARKETPLACE.md`, `FLUJOS_NAVEGACION.md` §
Marketplace, `paginas/marketplace-*.md`) y del **look:** `DISENO_UI.md` (mismos tokens que la
app, audiencia más cálida).

## Stack (asumido — confirmable)

**Next.js (App Router) + TypeScript + React**, SSR para las páginas públicas (SEO por
`:slug`), **cookie de sesión firmada `Secure/HttpOnly/SameSite=Lax`** puesta por el servidor
(nunca `localStorage` — evita XSS, MARKETPLACE.md § cookie), y **Stripe Checkout** por
redirección. Los tokens de diseño viven en `styles/tokens.css` (variables CSS = espejo de
`app_tokens.dart`). *Se eligió Next.js por ser el default natural para un directorio público
con SSR+SEO+cookies+Stripe; el usuario puede cambiarlo (decisión de cierre).*

## Principios duros (MARKETPLACE.md)

- **La URL `success` de Stripe NO confirma la cita — solo el webhook firmado**
  (`handle_stripe_checkout_completed`) la crea. La pantalla de resultado hace **polling**.
- **Estado real siempre en la base** (hold / cita / pago), con `marketplace_session_id` +
  `active_hold_id` como llaves; la cookie solo transporta el ancla y datos para prellenar
  (allowlist estricta; nada autoritativo).
- **Sin datos clínicos ni de pago sensibles en el cliente.** El `service_role` JAMÁS vive
  aquí; el navegador solo habla con endpoints del servidor (Route Handlers) que llaman a las
  RPC públicas de marketplace con la anon key o service key **solo en el servidor**.
- **Rating fuera del `ORDER BY`** del directorio; sin slots en la tarjeta del listado.

## Estructura

```
app/                      # rutas Next.js (App Router)
  page.tsx                #   / landing marketing
  psicologos/page.tsx     #   /psicologos directorio (search_marketplace_profiles)
  psicologos/[slug]/…     #   perfil, agendar/dias, agendar/horarios, agendar, resultado
  profesionales/page.tsx  #   /profesionales captación
  api/…                   #   Route Handlers: hold, OTP, checkout, webhook, polling
components/               # componentes React (tokens de tokens.css)
lib/                      # cliente Supabase (server-only), cookie firmada, Stripe
styles/tokens.css         # ✅ sistema de diseño como variables CSS
```

## Rutas → pantallas → funciones (FLUJOS_NAVEGACION.md § Marketplace)

| Ruta | Pantalla | Funciones backend |
|---|---|---|
| `/` | Landing | — (marketing) |
| `/psicologos` | Directorio | `search_marketplace_profiles` |
| Test de afinidad | Cuestionario → `affinity_filters` (cookie) | — (mapea a filtros) |
| `/profesionales` | Captación profesional | — (marketing) |
| `/psicologos/:slug` | Perfil público | `get_marketplace_profile` |
| `/psicologos/:slug/agendar/dias`·`/horarios` | Selección de horario | `get_marketplace_available_days` · `get_marketplace_availability` |
| `/psicologos/:slug/agendar` | Identificación + OTP | `create_or_replace_marketplace_slot_hold` · `start_marketplace_phone_verification` · `verify_marketplace_phone_otp` |
| Checkout | Redirect a Stripe | `create_marketplace_checkout_from_hold` |
| `/psicologos/:slug/agendar/resultado` | Resultado (polling) | `get_marketplace_booking_result` |

## Estado

- ✅ Fundación: `styles/tokens.css`, estructura, README, PLAN.
- ⏳ **B8:** páginas + componentes + Route Handlers (server) desde los contratos `paginas/marketplace-*.md`.
