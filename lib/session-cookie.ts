// lib/session-cookie.ts
// -----------------------------------------------------------------------------
// Cookie de sesión del paciente anónimo del marketplace.
// Contrato: agenda-psi-database/MARKETPLACE.md § "Cookie `marketplace_booking_session`".
//
// El paciente del marketplace NO tiene sesión de Supabase. El hilo del flujo se
// transporta en ESTA cookie, firmada Y cifrada por el backend. La cookie sólo
// LOCALIZA el flujo (marketplace_session_id + active_hold_id); NUNCA es la fuente
// de verdad: hold, cita y pago se re-resuelven siempre en la base de datos
// (MARKETPLACE.md § cookie, Invariante 1).
//
// SEGURIDAD (invariantes duros MARKETPLACE.md):
//  - Secure · HttpOnly · SameSite=Lax; la escribe el SERVIDOR. Jamás localStorage
//    (evita lectura por JS / XSS).
//  - Cifrada con AEAD (AES-256-GCM): "firmada" evita manipulación y "cifrada" evita
//    que la PII (verified_phone, first_name, last_name) sea legible al decodificar
//    (MARKETPLACE.md § cookie, "campos con PII exigen cookie cifrada"). GCM da ambas
//    cosas a la vez: confidencialidad + autenticación/integridad.
//  - Allowlist ESTRICTA: sólo los campos del contrato pueden vivir en la cookie;
//    todo lo demás se descarta al leer y al escribir.
//  - Nada autoritativo ni clínico: sin OTP, sin PaymentIntent/checkout de Stripe,
//    sin precio/duración/modalidad como verdad, sin filas de patients. El estado
//    real siempre sale de DB.
//
// Este módulo es SERVER-ONLY. En un proyecto real, añade `import 'server-only'`
// arriba para que el bundler rompa el build si se importa desde el navegador.
// -----------------------------------------------------------------------------

import { cookies } from 'next/headers';
import {
  randomBytes,
  randomUUID,
  createCipheriv,
  createDecipheriv,
  scryptSync,
  timingSafeEqual,
} from 'node:crypto';

// Guarda dura: el service_role / secretos de cookie jamás en el navegador.
if (typeof window !== 'undefined') {
  throw new Error('session-cookie.ts es server-only y no puede ejecutarse en el navegador.');
}

// -----------------------------------------------------------------------------
// Constantes de la cookie
// -----------------------------------------------------------------------------

const COOKIE_NAME = 'marketplace_booking_session';
const TOKEN_VERSION = 'v1'; // prefijo del payload; permite rotar formato/clave.
const SESSION_TTL_MS = 60 * 60 * 1000; // 60 min. TTL de la cookie (el hold tiene el suyo, 30 min).

// AES-256-GCM
const IV_BYTES = 12;
const TAG_BYTES = 16;
const KEY_BYTES = 32;
// Salt fijo de app SÓLO para derivar clave cuando el secreto no viene ya como 32 bytes.
const KDF_SALT = 'agenda-psi:marketplace_booking_session:v1';

// -----------------------------------------------------------------------------
// Tipos — la allowlist como contrato de TypeScript (MARKETPLACE.md § cookie, tabla)
// -----------------------------------------------------------------------------

/** Filtros del test de afinidad: NO autoritativo, NO clínico — sólo ids de catálogo. */
export interface AffinityFilters {
  area_ids?: string[];
  population_ids?: string[];
  approach_ids?: string[];
  max_price_mxn?: number;
}

/**
 * Campos permitidos en la cookie. Cualquier otra clave se descarta.
 * `verified_phone` en E.164; `phone_verified_at`/`expires_at` en ISO-8601.
 */
export interface BookingSession {
  marketplace_session_id: string; // uuid — ancla del flujo
  professional_id: string | null; // uuid — si cambia ⇒ cookie inválida (MISMATCH)
  active_hold_id: string | null; // uuid — hold vigente que reserva el paciente
  first_name: string | null; // prellenado, no autoritativo
  last_name: string | null; // prellenado, no autoritativo
  verified_phone: string | null; // E.164, verificado por OTP en este flujo
  phone_verified_at: string | null; // ISO — vigencia del OTP
  blocked_reason: string | null; // p. ej. EXISTING_PATIENT
  affinity_filters: AffinityFilters | null; // sólo ids de catálogo
  expires_at: string; // ISO — expiración de la cookie
  version: number; // se incrementa en cada escritura; detecta cookies rancias
}

// Claves de la allowlist. Fuente única: MARKETPLACE.md § cookie (tabla de campos).
// Exportada para tests/documentación viva del contrato.
export const ALLOWED_COOKIE_KEYS = [
  'marketplace_session_id',
  'professional_id',
  'active_hold_id',
  'first_name',
  'last_name',
  'verified_phone',
  'phone_verified_at',
  'blocked_reason',
  'affinity_filters',
  'expires_at',
  'version',
] as const satisfies readonly (keyof BookingSession)[];

/** Parche parcial: sólo campos "de negocio" (los de sistema los gestiona este módulo). */
export type BookingSessionPatch = Partial<
  Omit<BookingSession, 'marketplace_session_id' | 'expires_at' | 'version'>
>;

// -----------------------------------------------------------------------------
// Taxonomía de errores de sesión (MARKETPLACE.md § cookie, "Errores de sesión")
// -----------------------------------------------------------------------------

export type BookingSessionErrorCode =
  | 'BOOKING_SESSION_REQUIRED' // falta cookie donde se exige
  | 'BOOKING_SESSION_EXPIRED' // vencida
  | 'BOOKING_SESSION_MISMATCH'; // profesional/hold no coinciden con la cookie

export class BookingSessionError extends Error {
  readonly code: BookingSessionErrorCode;
  constructor(code: BookingSessionErrorCode, message?: string) {
    super(message ?? code);
    this.name = 'BookingSessionError';
    this.code = code;
  }
}

// -----------------------------------------------------------------------------
// Clave de cifrado (server-only)
// -----------------------------------------------------------------------------

let cachedKey: Buffer | null = null;

/**
 * Deriva la clave AES-256 desde MARKETPLACE_COOKIE_SECRET (env del SERVIDOR).
 * Si el secreto ya decodifica a 32 bytes (base64url/hex), se usa tal cual; de lo
 * contrario se deriva con scrypt sobre un salt fijo de app. El secreto NUNCA llega
 * al navegador (este módulo es server-only).
 */
function getKey(): Buffer {
  if (cachedKey) return cachedKey;

  const secret = process.env.MARKETPLACE_COOKIE_SECRET;
  if (!secret) {
    throw new Error('Falta MARKETPLACE_COOKIE_SECRET (secreto de servidor para la cookie de booking).');
  }

  // Intenta interpretar el secreto como 32 bytes ya listos (hex o base64url).
  let raw: Buffer | null = null;
  if (/^[0-9a-fA-F]{64}$/.test(secret)) {
    raw = Buffer.from(secret, 'hex');
  } else {
    try {
      const b = Buffer.from(secret, 'base64url');
      if (b.length === KEY_BYTES) raw = b;
    } catch {
      raw = null;
    }
  }

  cachedKey = raw ?? scryptSync(secret, KDF_SALT, KEY_BYTES);
  return cachedKey;
}

// -----------------------------------------------------------------------------
// Sellado / apertura del token (AES-256-GCM: cifra + autentica)
// -----------------------------------------------------------------------------

function seal(session: BookingSession): string {
  const key = getKey();
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const plaintext = Buffer.from(JSON.stringify(session), 'utf8');
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  // Formato: v1.<base64url(iv | tag | ciphertext)>
  const packed = Buffer.concat([iv, tag, ciphertext]).toString('base64url');
  return `${TOKEN_VERSION}.${packed}`;
}

/** Abre y verifica el token. Devuelve null si es inválido, manipulado o mal formado. */
function open(token: string | undefined): BookingSession | null {
  if (!token) return null;
  const dot = token.indexOf('.');
  if (dot < 0) return null;

  const version = token.slice(0, dot);
  // Comparación en tiempo constante del prefijo de versión.
  const vBuf = Buffer.from(version);
  const expBuf = Buffer.from(TOKEN_VERSION);
  if (vBuf.length !== expBuf.length || !timingSafeEqual(vBuf, expBuf)) return null;

  try {
    const packed = Buffer.from(token.slice(dot + 1), 'base64url');
    if (packed.length < IV_BYTES + TAG_BYTES) return null;
    const iv = packed.subarray(0, IV_BYTES);
    const tag = packed.subarray(IV_BYTES, IV_BYTES + TAG_BYTES);
    const ciphertext = packed.subarray(IV_BYTES + TAG_BYTES);

    const decipher = createDecipheriv('aes-256-gcm', getKey(), iv);
    decipher.setAuthTag(tag); // si el token fue manipulado, .final() lanza.
    const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);

    const parsed = JSON.parse(plaintext.toString('utf8')) as unknown;
    return normalize(parsed);
  } catch {
    // Firma inválida, manipulación, JSON corrupto ⇒ como si no hubiera cookie.
    return null;
  }
}

// -----------------------------------------------------------------------------
// Allowlist: normaliza cualquier objeto al shape exacto de BookingSession
// -----------------------------------------------------------------------------

function normalize(input: unknown): BookingSession | null {
  if (!input || typeof input !== 'object') return null;
  const o = input as Record<string, unknown>;

  const sid = typeof o.marketplace_session_id === 'string' ? o.marketplace_session_id : null;
  const expires_at = typeof o.expires_at === 'string' ? o.expires_at : null;
  if (!sid || !expires_at) return null; // campos de sistema obligatorios

  const str = (k: string): string | null => (typeof o[k] === 'string' ? (o[k] as string) : null);

  let affinity_filters: AffinityFilters | null = null;
  if (o.affinity_filters && typeof o.affinity_filters === 'object') {
    const a = o.affinity_filters as Record<string, unknown>;
    const ids = (k: string): string[] | undefined =>
      Array.isArray(a[k]) ? (a[k] as unknown[]).filter((x): x is string => typeof x === 'string') : undefined;
    affinity_filters = {
      area_ids: ids('area_ids'),
      population_ids: ids('population_ids'),
      approach_ids: ids('approach_ids'),
      max_price_mxn: typeof a.max_price_mxn === 'number' ? a.max_price_mxn : undefined,
    };
  }

  // Se construye SÓLO con claves de la allowlist; todo lo demás se ignora.
  return {
    marketplace_session_id: sid,
    professional_id: str('professional_id'),
    active_hold_id: str('active_hold_id'),
    first_name: str('first_name'),
    last_name: str('last_name'),
    verified_phone: str('verified_phone'),
    phone_verified_at: str('phone_verified_at'),
    blocked_reason: str('blocked_reason'),
    affinity_filters,
    expires_at,
    version: typeof o.version === 'number' ? o.version : 0,
  };
}

function isExpired(session: BookingSession): boolean {
  const t = Date.parse(session.expires_at);
  return Number.isNaN(t) || t <= Date.now();
}

function cookieOptions() {
  // Secure · HttpOnly · SameSite=Lax (MARKETPLACE.md § cookie, "Atributos").
  return {
    httpOnly: true,
    secure: true,
    sameSite: 'lax' as const,
    path: '/',
    maxAge: Math.floor(SESSION_TTL_MS / 1000),
  };
}

// -----------------------------------------------------------------------------
// API pública: get / set / clear (+ helpers de invariantes)
// -----------------------------------------------------------------------------

/**
 * Lee la cookie. Devuelve la sesión normalizada (allowlist) o `null` si no existe,
 * está manipulada o venció. No lanza: leer nunca debe romper el flujo público.
 * NOTA: nada de lo devuelto es autoritativo — re-resuelve hold/cita/pago en DB.
 */
export async function getBookingSession(): Promise<BookingSession | null> {
  const jar = await cookies();
  const session = open(jar.get(COOKIE_NAME)?.value);
  if (!session) return null;
  if (isExpired(session)) return null;
  return session;
}

/**
 * Igual que getBookingSession pero EXIGE cookie válida y no vencida.
 * Lanza BookingSessionError REQUIRED/EXPIRED (MARKETPLACE.md § cookie, errores).
 */
export async function requireBookingSession(): Promise<BookingSession> {
  const jar = await cookies();
  const session = open(jar.get(COOKIE_NAME)?.value);
  if (!session) throw new BookingSessionError('BOOKING_SESSION_REQUIRED');
  if (isExpired(session)) throw new BookingSessionError('BOOKING_SESSION_EXPIRED');
  return session;
}

/**
 * Crea/actualiza la cookie con un parche de campos de la allowlist.
 * - Genera `marketplace_session_id` si la cookie no existe o venció (ciclo de vida).
 * - Incrementa `version` en cada escritura y refresca `expires_at`.
 * - Invalida si el `professional_id` entrante difiere del de la cookie:
 *   lanza BOOKING_SESSION_MISMATCH y NO mezcla profesionales (Invariante 2).
 * Devuelve la sesión resultante ya sellada en la cookie.
 */
export async function setBookingSession(patch: BookingSessionPatch): Promise<BookingSession> {
  const jar = await cookies();
  const current = open(jar.get(COOKIE_NAME)?.value);
  const base = current && !isExpired(current) ? current : null;

  // Invalidación por cambio de profesional (MARKETPLACE.md § cookie, "Invalidar").
  if (
    base &&
    base.professional_id &&
    patch.professional_id != null &&
    patch.professional_id !== base.professional_id
  ) {
    // El caller decide si reiniciar; aquí protegemos el invariante de no-mezcla.
    throw new BookingSessionError(
      'BOOKING_SESSION_MISMATCH',
      'El professional_id del request no coincide con el de la cookie.',
    );
  }

  const now = Date.now();
  const next: BookingSession = {
    marketplace_session_id: base?.marketplace_session_id ?? randomUUID(),
    professional_id: patch.professional_id ?? base?.professional_id ?? null,
    active_hold_id: patch.active_hold_id ?? base?.active_hold_id ?? null,
    first_name: patch.first_name ?? base?.first_name ?? null,
    last_name: patch.last_name ?? base?.last_name ?? null,
    verified_phone: patch.verified_phone ?? base?.verified_phone ?? null,
    phone_verified_at: patch.phone_verified_at ?? base?.phone_verified_at ?? null,
    blocked_reason: patch.blocked_reason ?? base?.blocked_reason ?? null,
    affinity_filters: patch.affinity_filters ?? base?.affinity_filters ?? null,
    expires_at: new Date(now + SESSION_TTL_MS).toISOString(),
    version: (base?.version ?? 0) + 1,
  };

  jar.set(COOKIE_NAME, seal(next), cookieOptions());
  return next;
}

/**
 * Sella una cookie ya explícita (reemplazo total), útil al reiniciar el flujo con
 * un profesional distinto. Fija `expires_at` y `version` de sistema; el resto pasa
 * por la allowlist. No valida mismatch: es un reemplazo deliberado.
 */
export async function replaceBookingSession(
  session: Partial<BookingSession> & { professional_id: string | null },
): Promise<BookingSession> {
  const jar = await cookies();
  const now = Date.now();
  const normalized = normalize({
    ...session,
    marketplace_session_id: session.marketplace_session_id ?? randomUUID(),
    expires_at: new Date(now + SESSION_TTL_MS).toISOString(),
    version: 1,
  });
  if (!normalized) throw new Error('replaceBookingSession: sesión inválida tras normalizar.');
  jar.set(COOKIE_NAME, seal(normalized), cookieOptions());
  return normalized;
}

/** Borra la cookie. Perderla sólo cuesta reiniciar el flujo, nunca dinero ni cita. */
export async function clearBookingSession(): Promise<void> {
  const jar = await cookies();
  jar.set(COOKIE_NAME, '', { ...cookieOptions(), maxAge: 0 });
}

/**
 * Verifica que la cookie corresponde a `professional_id` (y opcionalmente al hold).
 * Lanza REQUIRED/EXPIRED/MISMATCH. Úsalo en toda mutación del flujo (Invariante 2:
 * toda mutación revalida marketplace_session_id + hold vigentes bajo lock en DB;
 * esto es la primera barrera antes de tocar la base).
 */
export async function assertBookingSession(opts: {
  professionalId?: string;
  holdId?: string;
}): Promise<BookingSession> {
  const session = await requireBookingSession();
  if (opts.professionalId && session.professional_id !== opts.professionalId) {
    throw new BookingSessionError('BOOKING_SESSION_MISMATCH', 'professional_id no coincide.');
  }
  if (opts.holdId && session.active_hold_id !== opts.holdId) {
    throw new BookingSessionError('BOOKING_SESSION_MISMATCH', 'active_hold_id no coincide.');
  }
  return session;
}

export const __COOKIE_NAME_FOR_TESTS = COOKIE_NAME;
