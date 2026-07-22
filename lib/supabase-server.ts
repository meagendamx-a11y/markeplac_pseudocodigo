// =====================================================================================
// lib/supabase-server.ts — Cliente Supabase SOLO servidor para el marketplace paciente.
//
// Contrato: MARKETPLACE.md § RLS / seguridad (líneas ~1273-1287) + § Funciones (tabla índice)
//           y SEGURIDAD_RLS.md §244 ("La clave service_role JAMÁS se embebe en la app").
//
// INVARIANTES DUROS que este módulo materializa:
//   1. El `service_role` JAMÁS llega al navegador. Este archivo es server-only: el import
//      `server-only` hace fallar el BUILD si alguien lo importa desde un Client Component.
//      Además la clave se lee de `SUPABASE_SERVICE_ROLE_KEY` (SIN prefijo NEXT_PUBLIC_, que
//      es lo único que Next.js expone al bundle del cliente).
//   2. Dos superficies de acceso, nunca una sola:
//        - anon key  → lecturas PÚBLICAS del directorio/perfil/disponibilidad/resultado.
//        - service key → operaciones PRIVILEGIADAS que tocan tablas service-role-only
//          (`slot_holds`, `stripe_webhook_events`) o Twilio/Stripe: holds, OTP, checkout,
//          webhook. El browser NUNCA habla con Supabase para esto; pasa por Route Handlers
//          propios que llaman a estos helpers.
//   3. Ninguna sesión de Auth se persiste aquí: el marketplace es anónimo (paciente sin
//      login); el estado autoritativo vive en la base vía `marketplace_session_id` +
//      `active_hold_id`, no en un token de cliente.
//
// NOTA sobre tokens.css: `styles/tokens.css` (var(--purple-600), .cta-primary, …) aplica a
// UI/TSX; este es un módulo de infraestructura server-only sin markup, así que no consume
// tokens de diseño (no hay superficie visual que estilizar).
// =====================================================================================

import 'server-only'; // Guard de build: importar esto desde el cliente ⇒ error de compilación.

import { createClient, type SupabaseClient } from '@supabase/supabase-js';

// -------------------------------------------------------------------------------------
// Configuración de entorno (leída SOLO en el servidor).
// -------------------------------------------------------------------------------------

/** URL del proyecto Supabase. Pública por naturaleza (aparece en peticiones del cliente). */
const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;

/** Clave anónima: RLS aplicada, apta para lecturas públicas. Segura en cliente y servidor. */
const SUPABASE_ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

/**
 * Clave de rol de servicio: RLS BYPASSEADA. SIN prefijo NEXT_PUBLIC_ a propósito, para que
 * Next.js nunca la inyecte en el bundle del navegador (SEGURIDAD_RLS.md §244). Solo se lee
 * cuando se pide el cliente privilegiado, para que las rutas puramente públicas no fallen si
 * la variable no está presente en ese entorno.
 */
const SUPABASE_SERVICE_ROLE_KEY_VAR = 'SUPABASE_SERVICE_ROLE_KEY';

if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
  throw new Error(
    '[supabase-server] Faltan NEXT_PUBLIC_SUPABASE_URL / NEXT_PUBLIC_SUPABASE_ANON_KEY.',
  );
}

// Opciones comunes: marketplace anónimo ⇒ sin persistir/refrescar sesión de Auth.
const COMMON_OPTIONS = {
  auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
} as const;

// -------------------------------------------------------------------------------------
// Singletons perezosos (una instancia por proceso de servidor).
// -------------------------------------------------------------------------------------

let _publicClient: SupabaseClient | null = null;
let _serviceClient: SupabaseClient | null = null;

/**
 * Cliente con la ANON key. RLS aplicada. Úsalo SOLO para lecturas públicas del marketplace
 * (directorio, perfil, disponibilidad, resultado de reserva). Nunca para escribir.
 */
export function getPublicClient(): SupabaseClient {
  if (_publicClient) return _publicClient;
  _publicClient = createClient(SUPABASE_URL!, SUPABASE_ANON_KEY!, COMMON_OPTIONS);
  return _publicClient;
}

/**
 * Cliente con la SERVICE_ROLE key. RLS BYPASSEADA. Úsalo SOLO en Route Handlers / Server
 * Components para operaciones privilegiadas (holds, OTP, checkout, webhook). NUNCA lo
 * expongas ni devuelvas su resultado crudo con columnas restringidas al cliente
 * (allowlist de columnas, MARKETPLACE.md §1280).
 *
 * Lanza si la clave no está en el entorno: preferimos fallar cerrado antes que degradar
 * silenciosamente una operación privilegiada a la anon key.
 */
export function getServiceClient(): SupabaseClient {
  if (_serviceClient) return _serviceClient;
  const serviceKey = process.env[SUPABASE_SERVICE_ROLE_KEY_VAR];
  if (!serviceKey) {
    throw new Error(
      `[supabase-server] Falta ${SUPABASE_SERVICE_ROLE_KEY_VAR} (clave server-only). ` +
        'No se ejecuta una operación privilegiada sin ella.',
    );
  }
  _serviceClient = createClient(SUPABASE_URL!, serviceKey, COMMON_OPTIONS);
  return _serviceClient;
}

// -------------------------------------------------------------------------------------
// Errores de dominio de las RPC.
// -------------------------------------------------------------------------------------

/**
 * Error tipado que envuelve las fallas de una RPC de marketplace. `code` transporta el
 * error de dominio del contrato (p.ej. `SLOT_UNAVAILABLE`, `INVALID_INPUT`,
 * `MARKETPLACE_BLOCKED_EXISTING_PATIENT`, `CHECKOUT_ALREADY_STARTED`) para que el Route
 * Handler decida el status HTTP y el mensaje al paciente sin filtrar detalles internos.
 */
export class MarketplaceRpcError extends Error {
  readonly code: string;
  readonly fn: string;
  readonly details?: string;

  constructor(fn: string, code: string, message: string, details?: string) {
    super(message);
    this.name = 'MarketplaceRpcError';
    this.fn = fn;
    this.code = code;
    this.details = details;
  }
}

// -------------------------------------------------------------------------------------
// Helpers rpc<T>().
// -------------------------------------------------------------------------------------

/** Nombres de las RPC públicas del marketplace (contrato MARKETPLACE.md § Funciones). */
export type PublicMarketplaceRpc =
  | 'search_marketplace_profiles'
  | 'get_marketplace_profile'
  | 'get_marketplace_available_days'
  | 'get_marketplace_availability'
  | 'get_marketplace_booking_result';

/** Nombres de las RPC privilegiadas (escriben tablas service-role-only / Twilio / Stripe). */
export type PrivilegedMarketplaceRpc =
  | 'create_or_replace_marketplace_slot_hold'
  | 'start_marketplace_phone_verification'
  | 'verify_marketplace_phone_otp'
  | 'create_marketplace_checkout_from_hold'
  | 'handle_stripe_checkout_completed'
  | 'expire_marketplace_slot_holds';

type RpcArgs = Record<string, unknown> | undefined;

/**
 * Ejecuta una RPC y devuelve `data` tipado como `T`, o lanza `MarketplaceRpcError`.
 * Extrae el `code` de dominio desde el error de Postgres (RAISE EXCEPTION USING
 * ERRCODE/MESSAGE), con `data.error` como respaldo si la RPC lo devuelve en la fila.
 */
async function runRpc<T>(
  client: SupabaseClient,
  fn: string,
  args: RpcArgs,
): Promise<T> {
  const { data, error } = await client.rpc(fn, args ?? {});

  if (error) {
    // Postgres expone el texto de la excepción en `message`; muchos contratos usan el
    // propio texto como código de dominio (INVALID_INPUT, SLOT_UNAVAILABLE, …).
    const code = extractCode(error.message) ?? error.code ?? 'RPC_ERROR';
    throw new MarketplaceRpcError(fn, code, error.message, error.details ?? undefined);
  }

  // Algunas RPC modelan el error de dominio como fila `{ error: 'CODE' }` en vez de RAISE.
  if (data && typeof data === 'object' && 'error' in (data as Record<string, unknown>)) {
    const code = String((data as Record<string, unknown>).error);
    throw new MarketplaceRpcError(fn, code, code);
  }

  return data as T;
}

/** Devuelve el token en MAYÚSCULAS_CON_GUION del mensaje si parece un código de dominio. */
function extractCode(message: string): string | undefined {
  const match = message.match(/\b[A-Z][A-Z0-9_]{2,}\b/);
  return match?.[0];
}

/**
 * `rpcPublic<T>` — llama una RPC pública con la ANON key. Para lecturas del marketplace.
 * @example const rows = await rpcPublic<Profile[]>('search_marketplace_profiles', filters);
 */
export function rpcPublic<T>(fn: PublicMarketplaceRpc, args?: RpcArgs): Promise<T> {
  return runRpc<T>(getPublicClient(), fn, args);
}

/**
 * `rpcService<T>` — llama una RPC privilegiada con la SERVICE_ROLE key. SOLO server-side,
 * SOLO para operaciones que escriben tablas service-role-only o disparan Twilio/Stripe.
 * @example await rpcService<HoldResult>('create_or_replace_marketplace_slot_hold', input);
 */
export function rpcService<T>(fn: PrivilegedMarketplaceRpc, args?: RpcArgs): Promise<T> {
  return runRpc<T>(getServiceClient(), fn, args);
}

/**
 * `rpc<T>` — forma genérica: elige superficie por `mode` ('public' | 'service').
 * Prefiere `rpcPublic` / `rpcService` (nombres tipados). Este existe para call-sites que
 * deciden la superficie en runtime.
 */
export function rpc<T>(
  mode: 'public' | 'service',
  fn: string,
  args?: RpcArgs,
): Promise<T> {
  const client = mode === 'service' ? getServiceClient() : getPublicClient();
  return runRpc<T>(client, fn, args);
}
