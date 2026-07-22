'use client';

// =====================================================================================
// components/OtpForm.tsx
// Marketplace — "Verifica tu WhatsApp" (paso 3 de 4). Client Component (Next.js App Router).
// Es la parte INTERACTIVA de la pantalla; el Server Component la envuelve con el app bar
// (← + "Paso 3 de 4") y el resumen del profesional.
//
// Contrato: paginas/marketplace-verificar-whatsapp.md
//   · §Funciones que llama: start_marketplace_phone_verification / verify_marketplace_phone_otp
//     (aquí, a través de CALLBACKS a los Route Handlers /api/otp/start y /api/otp/verify:
//     este componente NO hace fetch ni conoce endpoints; recibe onSendCode/onVerifyCode).
//   · §Estados: Código enviado · Verificando · Código inválido · Rate-limited · Ya es
//     paciente · Hold expiró · Verificado.
//   · §Jerarquía 2–6: ícono WhatsApp + "Ingresa el código" + "Enviamos … al +52 ·· ··· 5678"
//     + "Cambiar número"; 6 casillas; "Reenviar código" (con contador); chip
//     "Horario apartado por MM:SS"; CTA "Verificar código".
//   · §Visibilidad condicional: el contador de reenvío bloquea el reenvío hasta 0; el contador
//     del hold refleja `hold.expires_at` real (0 ⇒ "hold expiró"); "Cambiar número" reinicia
//     la captura y el envío del OTP.
//   · §Navegación: Verificar OK → PÁGINA marketplace-pago (onVerified); ya-paciente → salida a
//     WhatsApp (sin pago); hold expiró → volver a elegir horario.
//   · §No debe: persistir el OTP; crear checkout/cita; escribir patient_phone sin OTP aprobado;
//     revelar si el número existe como paciente de OTRO profesional.
// + MARKETPLACE.md § start/verify_marketplace_phone_otp (~L668-740), § Rate limiting (~L1520),
//   § Cookie marketplace_booking_session (allowlist; "Nunca contiene" OTP/PII/clínico/pago).
//
// INVARIANTES DE SEGURIDAD que respeta este archivo:
//   - NUNCA habla con Supabase ni ve service_role: toda mutación sensible ocurre en los Route
//     Handlers propios (server-only), que este componente invoca por CALLBACK. El navegador solo
//     teclea phone (E.164) + código y renderiza el veredicto.
//   - El código OTP vive SOLO en memoria de React mientras se teclea; no se persiste, no se
//     guarda en localStorage/cookie ni se re-emite tras verificar (§cookie "Nunca contiene").
//   - NADA en localStorage: el hilo del flujo (hold_id, marketplace_session_id) lo re-resuelve
//     el servidor desde la cookie firmada; aquí ni se lee ni se envía.
//   - Sin datos clínicos/de pago; el número solo se muestra ENMASCARADO (phone_masked que
//     devuelve la RPC). No se revela si el teléfono es paciente de otro profesional.
//
// DISEÑO (DISENO_UI · styles/tokens.css): sin colores hardcodeados (todo var(--*)); regla del
// morado = UN solo CTA primario morado por pantalla (aquí: "Enviar/Verificar código"). "Reenviar"
// y "Cambiar número" son acciones neutras/enlace para no competir con él. Foco visible heredado
// de :focus-visible. `.num` (tabular-nums) en casillas y contadores. UI en español (es-MX).
// =====================================================================================

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties, KeyboardEvent as ReactKeyboardEvent } from 'react';

// -------------------------------------------------------------------------------------
// Tipos del contrato de red (espejo del allowlist que devuelven los Route Handlers).
// -------------------------------------------------------------------------------------

/** Salida de POST /api/otp/start (MARKETPLACE.md § start, Salida ~L696). Solo campos públicos. */
export interface OtpStartData {
  verification_required: boolean;
  channel?: 'whatsapp';
  phone_masked?: string; // "+52 ·· ··· 5678" — enmascarado por la RPC, nunca crudo.
  hold_expires_at?: string; // ISO UTC — TTL del hold para el contador (§Jerarquía.5).
  next_action?: 'create_checkout';
}

/** Salida de POST /api/otp/verify (MARKETPLACE.md § verify, Salida ~L730). Solo el veredicto. */
export interface OtpVerifyData {
  verified: boolean;
  marketplace_allowed: boolean;
  reason?: 'MARKETPLACE_BLOCKED_EXISTING_PATIENT';
  next_action?: 'create_checkout' | 'continue_whatsapp';
  hold_expires_at?: string; // ISO UTC (no sensible), para refrescar el contador del hold.
}

/**
 * Resultado uniforme de un callback a un Route Handler. La página envuelve el `fetch`:
 * respuesta 2xx ⇒ { ok: true, data }; error de dominio ⇒ { ok: false, code } con el `code`
 * que el handler expone en `{ error: CODE }` (nunca el detalle interno de Postgres/Twilio).
 * Así OtpForm permanece PRESENTACIONAL y testeable (no acopla fetch ni service_role).
 */
export type OtpResult<T> =
  | { ok: true; data: T }
  | { ok: false; code: string; next_action?: string };

export interface OtpFormProps {
  /** Teléfono E.164 ya capturado en "Tus datos" (respaldo para prellenar). Puede venir vacío. */
  initialPhone?: string;
  /**
   * Enmascarado del teléfono, si la página lo trae de un `start` previo. Si no, se enmascara
   * localmente a partir de `initialPhone` (solo para pintar; el server usa el phone real).
   */
  initialPhoneMasked?: string;
  /** `hold.expires_at` (ISO UTC) del hold ya creado en el paso anterior (contador del hold). */
  holdExpiresAt?: string;
  /**
   * Si es true y hay `initialPhone` válido, se envía el OTP al montar (la pantalla llega en
   * estado "Código enviado" — §Estados). Si es false, arranca en captura del número.
   */
  autoSend?: boolean;
  /** Cooldown de reenvío en segundos tras cada envío exitoso (§Jerarquía.4). */
  resendCooldownSeconds?: number;

  // --- Callbacks a los Route Handlers (la página los cablea con fetch + cookie firmada). ---
  /** POST /api/otp/start { phone } (hold_id/slug salen de la cookie server-side). */
  onSendCode: (phone: string) => Promise<OtpResult<OtpStartData>>;
  /** POST /api/otp/verify { otp_code, phone } (hold_id/slug re-resueltos server-side). */
  onVerifyCode: (phone: string, otpCode: string) => Promise<OtpResult<OtpVerifyData>>;

  // --- Navegación (decisión de widget, §Navegación). La resuelve la página, no este componente. ---
  /** Verificado + permitido ⇒ avanzar a PÁGINA marketplace-pago. */
  onVerified: (data: OtpVerifyData) => void;
  /** Hold expiró (contador a 0 o HOLD_EXPIRED) ⇒ volver a elegir horario. */
  onHoldExpired: () => void;
  /**
   * URL de continuación por WhatsApp para el caso "ya es paciente de ESTE profesional". La
   * construye el SERVIDOR (deep link a wa.me / número del negocio); aquí solo se enlaza. No
   * contiene PII ni revela nada de otros profesionales (§No debe).
   */
  whatsappUrl?: string;
  /** Sesión/cookie ausente o vencida ⇒ reiniciar la identificación (BOOKING_SESSION_*). */
  onSessionExpired?: () => void;
}

const OTP_LENGTH = 6; // 6 casillas (§Jerarquía.3); Twilio Verify de 6 dígitos (§2).
const DEFAULT_RESEND_COOLDOWN = 45; // segundos; el server-side rate-limit es la barrera real.

/** E.164: '+' seguido de 8..15 dígitos, primer dígito no-cero (mismo criterio que los handlers). */
const E164 = /^\+[1-9]\d{7,14}$/;

// -------------------------------------------------------------------------------------
// Utilidades de presentación.
// -------------------------------------------------------------------------------------

/** Enmascara un E.164 para pintar ("+52 ·· ··· 5678"): deja lada + últimos 4, el resto en ·. */
function maskPhone(phone: string): string {
  if (!E164.test(phone)) return phone;
  const cc = phone.slice(0, 3); // "+52" (aprox.; solo display, el server tiene el real)
  const last4 = phone.slice(-4);
  const hiddenCount = Math.max(phone.length - cc.length - 4, 0);
  const dots = '·'.repeat(Math.min(hiddenCount, 6));
  return `${cc} ${dots} ${last4}`.replace(/\s+/g, ' ').trim();
}

/** Segundos → "MM:SS" (para el contador del hold y el de reenvío). Nunca negativo. */
function mmss(totalSeconds: number): string {
  const s = Math.max(0, Math.floor(totalSeconds));
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `${m < 10 ? '0' : ''}${m}:${r < 10 ? '0' : ''}${r}`;
}

/** Segundos restantes hasta un instante ISO (0 si ya pasó o el ISO es inválido). */
function secondsUntil(iso: string | null, nowMs: number): number {
  if (!iso) return 0;
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return 0;
  return Math.max(0, Math.round((t - nowMs) / 1000));
}

/** Mensaje al paciente por código de error de dominio (nunca detalle interno). */
function messageForCode(code: string): string {
  switch (code) {
    case 'INVALID_OTP':
      return 'El código no es correcto. Revísalo e inténtalo de nuevo.';
    case 'OTP_EXPIRED_OR_NOT_FOUND':
      return 'El código expiró. Pide uno nuevo con "Reenviar código".';
    case 'OTP_RATE_LIMITED':
    case 'OTP_MAX_ATTEMPTS_REACHED':
      return 'Demasiados intentos. Espera un momento antes de volver a intentar.';
    case 'INVALID_PHONE':
      return 'Ese número no es válido. Escríbelo con lada, por ejemplo +52 55 1234 5678.';
    case 'OTP_SEND_FAILED':
      return 'No pudimos enviar el código por WhatsApp. Inténtalo de nuevo.';
    case 'OTP_CHECK_FAILED':
      return 'No pudimos verificar el código. Inténtalo de nuevo.';
    default:
      return 'Algo salió mal. Inténtalo de nuevo.';
  }
}

// -------------------------------------------------------------------------------------
// Estados de la pantalla (§Estados). Terminal = existing_patient / hold_expired / verified.
// -------------------------------------------------------------------------------------

type Phase = 'capture' | 'code' | 'existing_patient' | 'hold_expired' | 'verified';

// =====================================================================================
// Componente.
// =====================================================================================

export function OtpForm({
  initialPhone = '',
  initialPhoneMasked,
  holdExpiresAt,
  autoSend = false,
  resendCooldownSeconds = DEFAULT_RESEND_COOLDOWN,
  onSendCode,
  onVerifyCode,
  onVerified,
  onHoldExpired,
  whatsappUrl,
  onSessionExpired,
}: OtpFormProps) {
  // Fase inicial: si ya hay un phone válido y autoSend, arrancamos directo en "código".
  const [phase, setPhase] = useState<Phase>(() =>
    autoSend && E164.test(initialPhone) ? 'code' : 'capture',
  );

  // Teléfono (E.164). El input crudo se normaliza a E.164 al enviar; en pantalla se enmascara.
  const [phone, setPhone] = useState<string>(initialPhone);
  const [phoneMasked, setPhoneMasked] = useState<string>(
    initialPhoneMasked ?? (E164.test(initialPhone) ? maskPhone(initialPhone) : ''),
  );

  // 6 dígitos del OTP (solo en memoria; nunca se persiste — §No debe / §seguridad).
  const [digits, setDigits] = useState<string[]>(() => Array(OTP_LENGTH).fill(''));
  const inputsRef = useRef<Array<HTMLInputElement | null>>([]);

  const [sending, setSending] = useState(false); // envío/reenvío de OTP en curso.
  const [verifying, setVerifying] = useState(false); // "Verificando" (§Estados).
  const [errorCode, setErrorCode] = useState<string | null>(null);

  // Contadores: hold (cuenta regresiva del hold real) y reenvío (cooldown local).
  const [holdExpiresIso, setHoldExpiresIso] = useState<string | null>(holdExpiresAt ?? null);
  const [resendUntilMs, setResendUntilMs] = useState<number | null>(null);

  // Tick de 1s para los contadores; solo corre cuando hay algo que contar.
  const [nowMs, setNowMs] = useState<number>(() => Date.now());
  const needTick =
    (phase === 'code' && !!holdExpiresIso) || (resendUntilMs != null && resendUntilMs > Date.now());
  useEffect(() => {
    if (!needTick) return;
    const id = window.setInterval(() => setNowMs(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, [needTick]);

  const holdSecondsLeft = useMemo(
    () => secondsUntil(holdExpiresIso, nowMs),
    [holdExpiresIso, nowMs],
  );
  const resendSecondsLeft = useMemo(
    () => (resendUntilMs == null ? 0 : Math.max(0, Math.round((resendUntilMs - nowMs) / 1000))),
    [resendUntilMs, nowMs],
  );

  // §Visibilidad condicional: el contador del hold a 0 (estando en "código") ⇒ "hold expiró".
  useEffect(() => {
    if (phase === 'code' && holdExpiresIso && holdSecondsLeft === 0) {
      setPhase('hold_expired');
    }
  }, [phase, holdExpiresIso, holdSecondsLeft]);

  const otpCode = digits.join('');
  const otpComplete = otpCode.length === OTP_LENGTH && /^\d{6}$/.test(otpCode);

  // --- Reparto de un resultado de callback a la UI (mapeo error de dominio → estado). ---
  const applyStartResult = useCallback(
    (res: OtpResult<OtpStartData>): boolean => {
      if (res.ok) {
        // "verification_required: false" ⇒ el teléfono ya estaba verificado y vigente en la
        // cookie: no se envió OTP, se avanza directo (el server no reenvía — MARKETPLACE.md
        // § start, "si la cookie ya tiene verified_phone vigente, no reenvía").
        if (res.data.verification_required === false) {
          setPhase('verified');
          onVerified({
            verified: true,
            marketplace_allowed: true,
            next_action: res.data.next_action ?? 'create_checkout',
          });
          return true;
        }
        if (res.data.phone_masked) setPhoneMasked(res.data.phone_masked);
        if (res.data.hold_expires_at) setHoldExpiresIso(res.data.hold_expires_at);
        setPhase('code');
        return true;
      }
      // Errores de dominio del handler de start.
      if (res.code === 'HOLD_EXPIRED' || res.code === 'HOLD_NOT_FOUND') {
        setPhase('hold_expired');
        return false;
      }
      if (res.code === 'BOOKING_SESSION_REQUIRED' || res.code === 'BOOKING_SESSION_EXPIRED') {
        onSessionExpired?.();
        return false;
      }
      setErrorCode(res.code);
      return false;
    },
    [onVerified, onSessionExpired],
  );

  // --- Enviar / reenviar el código (§Jerarquía.4). El rate-limit real vive server-side. ---
  const sendCode = useCallback(
    async (targetPhone: string) => {
      if (sending) return;
      if (!E164.test(targetPhone)) {
        setErrorCode('INVALID_PHONE');
        return;
      }
      setSending(true);
      setErrorCode(null);
      try {
        const res = await onSendCode(targetPhone);
        const okStart = applyStartResult(res);
        if (okStart) {
          // Cooldown de reenvío desde este envío (§Visibilidad condicional: bloquea hasta 0).
          setResendUntilMs(Date.now() + resendCooldownSeconds * 1000);
        }
      } catch {
        // Falla de red del callback: no revelamos internals; el paciente reintenta.
        setErrorCode('OTP_SEND_FAILED');
      } finally {
        setSending(false);
      }
    },
    [sending, onSendCode, applyStartResult, resendCooldownSeconds],
  );

  // Auto-envío al montar (si la página lo pidió y hay phone válido).
  const autoSentRef = useRef(false);
  useEffect(() => {
    if (autoSend && !autoSentRef.current && E164.test(initialPhone)) {
      autoSentRef.current = true;
      void sendCode(initialPhone);
    }
  }, [autoSend, initialPhone, sendCode]);

  // --- Verificar el código (§Jerarquía.6). El veredicto real lo da Twilio dentro de la RPC. ---
  const verify = useCallback(async () => {
    if (verifying || !otpComplete) return;
    if (!E164.test(phone)) {
      setErrorCode('INVALID_PHONE');
      return;
    }
    setVerifying(true);
    setErrorCode(null);
    try {
      const res = await onVerifyCode(phone, otpCode);
      if (res.ok) {
        // Ya-paciente de ESTE profesional: llega como 200 con marketplace_allowed=false
        // (§Estados "Ya es paciente"; MARKETPLACE.md § verify, next_action continue_whatsapp).
        if (res.data.marketplace_allowed === false) {
          setPhase('existing_patient');
          return;
        }
        if (res.data.verified) {
          setPhase('verified');
          onVerified(res.data);
          return;
        }
        // verified=false sin lanzar ⇒ tratar como código inválido (nunca como éxito).
        setErrorCode('INVALID_OTP');
        return;
      }
      // Errores de dominio del handler de verify.
      if (res.code === 'HOLD_EXPIRED' || res.code === 'HOLD_NOT_FOUND') {
        setPhase('hold_expired');
        return;
      }
      if (res.code === 'MARKETPLACE_BLOCKED_EXISTING_PATIENT') {
        setPhase('existing_patient');
        return;
      }
      if (res.code === 'BOOKING_SESSION_REQUIRED' || res.code === 'BOOKING_SESSION_EXPIRED') {
        onSessionExpired?.();
        return;
      }
      // Código inválido / rate-limited / expirado ⇒ error inline; se limpian las casillas para
      // que el paciente reintente (§Estados "Código inválido" / "Rate-limited").
      setErrorCode(res.code);
      if (res.code === 'INVALID_OTP' || res.code === 'OTP_EXPIRED_OR_NOT_FOUND') {
        setDigits(Array(OTP_LENGTH).fill(''));
        inputsRef.current[0]?.focus();
      }
    } catch {
      setErrorCode('OTP_CHECK_FAILED');
    } finally {
      setVerifying(false);
    }
  }, [verifying, otpComplete, phone, otpCode, onVerifyCode, onVerified, onSessionExpired]);

  // --- "Cambiar número" (§Visibilidad condicional): reinicia captura y limpia el código. ---
  const changeNumber = useCallback(() => {
    setPhase('capture');
    setDigits(Array(OTP_LENGTH).fill(''));
    setErrorCode(null);
    setResendUntilMs(null);
    // No se re-envía OTP aquí: el paciente confirma el número y pulsa "Enviar código".
  }, []);

  // -----------------------------------------------------------------------------------
  // Handlers de las 6 casillas: solo dígitos, auto-avance, backspace y pegar.
  // -----------------------------------------------------------------------------------

  const setDigitAt = useCallback((index: number, value: string) => {
    setDigits((prev) => {
      const next = [...prev];
      next[index] = value;
      return next;
    });
  }, []);

  const onDigitChange = useCallback(
    (index: number, raw: string) => {
      const only = raw.replace(/\D/g, '');
      if (only.length > 1) {
        // Pegado de varios dígitos: se reparten desde la casilla actual.
        setDigits((prev) => {
          const next = [...prev];
          for (let i = 0; i < only.length && index + i < OTP_LENGTH; i += 1) {
            next[index + i] = only[i]!;
          }
          return next;
        });
        const lastFilled = Math.min(index + only.length, OTP_LENGTH - 1);
        inputsRef.current[lastFilled]?.focus();
        return;
      }
      setDigitAt(index, only);
      if (only && index < OTP_LENGTH - 1) inputsRef.current[index + 1]?.focus();
    },
    [setDigitAt],
  );

  const onDigitKeyDown = useCallback(
    (index: number, e: ReactKeyboardEvent<HTMLInputElement>) => {
      if (e.key === 'Backspace' && !digits[index] && index > 0) {
        inputsRef.current[index - 1]?.focus();
        setDigitAt(index - 1, '');
      } else if (e.key === 'Enter' && otpComplete) {
        void verify();
      }
    },
    [digits, setDigitAt, otpComplete, verify],
  );

  // =====================================================================================
  // Render por fase.
  // =====================================================================================

  // Estilos compartidos.
  const cardStyle: CSSProperties = { padding: 'var(--s20)' };
  const helpText: CSSProperties = { color: 'var(--ink-500)', fontSize: 13, margin: 0 };
  const isRateLimited =
    errorCode === 'OTP_RATE_LIMITED' || errorCode === 'OTP_MAX_ATTEMPTS_REACHED';

  // --- Terminal: verificado (transición; la página ya navega a pago). -----------------
  if (phase === 'verified') {
    return (
      <section aria-label="Teléfono verificado" aria-live="polite">
        <p className="card" style={{ ...cardStyle, color: 'var(--ink-700)', margin: 0 }}>
          Teléfono verificado. Continuando al pago…
        </p>
      </section>
    );
  }

  // --- Terminal: hold expiró (§Estados "Hold expiró"). --------------------------------
  if (phase === 'hold_expired') {
    return (
      <section aria-label="El horario se liberó" role="alert">
        <div className="card" style={cardStyle}>
          <h2 style={titleStyle}>Se liberó tu horario</h2>
          <p style={{ ...helpText, marginBottom: 'var(--s16)' }}>
            El apartado de 30 minutos venció. Vuelve a elegir un horario para continuar.
          </p>
          <button type="button" className="cta-primary" style={{ width: '100%' }} onClick={onHoldExpired}>
            Elegir otro horario
          </button>
        </div>
      </section>
    );
  }

  // --- Terminal: ya es paciente (§Estados "Ya es paciente"). No paga aquí; va a WhatsApp. ---
  if (phase === 'existing_patient') {
    return (
      <section aria-label="Ya eres paciente de este profesional" aria-live="polite">
        <div className="card" style={cardStyle}>
          <WhatsappBadge />
          <h2 style={titleStyle}>Ya eres paciente de este profesional</h2>
          <p style={{ ...helpText, marginBottom: 'var(--s16)' }}>
            Para agendar tu próxima sesión continúa por WhatsApp; ahí retomamos tu historial sin
            volver a empezar.
          </p>
          {whatsappUrl ? (
            // Enlace construido por el servidor; sin PII ni datos de otros profesionales (§No debe).
            <a
              className="cta-primary"
              style={{ width: '100%', textDecoration: 'none' }}
              href={whatsappUrl}
              rel="noopener noreferrer"
            >
              Continuar por WhatsApp
            </a>
          ) : (
            <p style={helpText}>Te contactaremos por WhatsApp para continuar.</p>
          )}
        </div>
      </section>
    );
  }

  // --- Fase de captura del número (o "Cambiar número"). -------------------------------
  if (phase === 'capture') {
    return (
      <section aria-label="Confirma tu número de WhatsApp">
        <div className="card" style={cardStyle}>
          <WhatsappBadge />
          <h2 style={titleStyle}>Confirma tu WhatsApp</h2>
          <p style={{ ...helpText, marginBottom: 'var(--s16)' }}>
            Te enviaremos un código de 6 dígitos por WhatsApp para verificar tu número.
          </p>

          <label htmlFor="otp-phone" style={labelStyle}>
            Número con lada (ej. +52 55 1234 5678)
          </label>
          <input
            id="otp-phone"
            type="tel"
            inputMode="tel"
            autoComplete="tel"
            className="num"
            placeholder="+52 55 1234 5678"
            value={phone}
            onChange={(e) => {
              setPhone(e.target.value.replace(/[^\d+]/g, ''));
              if (errorCode) setErrorCode(null);
            }}
            aria-invalid={errorCode === 'INVALID_PHONE'}
            style={inputStyle}
          />

          {errorCode && (
            <p role="alert" style={errorTextStyle}>
              {messageForCode(errorCode)}
            </p>
          )}

          <button
            type="button"
            className="cta-primary"
            style={{ width: '100%', marginTop: 'var(--s16)' }}
            disabled={sending || !E164.test(phone)}
            aria-disabled={sending || !E164.test(phone)}
            onClick={() => void sendCode(phone)}
          >
            {sending ? 'Enviando…' : 'Enviar código'}
          </button>
        </div>
      </section>
    );
  }

  // --- Fase "código enviado": 6 casillas + reenvío + chip del hold + CTA verificar. ---
  return (
    <section aria-label="Ingresa el código de verificación">
      <div className="card" style={cardStyle}>
        <WhatsappBadge />
        <h2 style={titleStyle}>Ingresa el código</h2>
        <p style={helpText}>
          Enviamos un código de 6 dígitos por WhatsApp al{' '}
          <span className="num" style={{ color: 'var(--ink-900)', fontWeight: 600 }}>
            {phoneMasked || 'tu número'}
          </span>
          .
        </p>

        {/* 2. "Cambiar número": reinicia captura (acción neutra, no morada). */}
        <button
          type="button"
          onClick={changeNumber}
          style={linkButtonStyle}
        >
          Cambiar número
        </button>

        {/* 5. Chip "Horario apartado por MM:SS" — cuenta regresiva del hold real. */}
        {holdExpiresIso && (
          <div
            aria-live="off"
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 'var(--s8)',
              background: 'var(--purple-100)',
              color: 'var(--purple-700)',
              borderRadius: 'var(--radius-round)',
              padding: 'var(--s8) var(--s12)',
              margin: 'var(--s16) 0',
              fontSize: 13,
            }}
          >
            <span aria-hidden="true">⏱</span>
            <span>
              Horario apartado por{' '}
              <span className="num" style={{ fontWeight: 700 }}>
                {mmss(holdSecondsLeft)}
              </span>
            </span>
          </div>
        )}

        {/* 3. Seis casillas del código. Dígitos en memoria; nunca se persisten (§seguridad). */}
        <div
          role="group"
          aria-label="Código de 6 dígitos"
          style={{ display: 'flex', gap: 'var(--s8)', margin: 'var(--s12) 0' }}
        >
          {digits.map((d, i) => (
            <input
              key={i}
              ref={(el) => {
                inputsRef.current[i] = el;
              }}
              type="text"
              inputMode="numeric"
              autoComplete={i === 0 ? 'one-time-code' : 'off'}
              maxLength={1}
              className="num"
              aria-label={`Dígito ${i + 1} de ${OTP_LENGTH}`}
              aria-invalid={errorCode === 'INVALID_OTP'}
              value={d}
              disabled={verifying}
              onChange={(e) => onDigitChange(i, e.target.value)}
              onKeyDown={(e) => onDigitKeyDown(i, e)}
              style={{
                width: 44,
                height: 52,
                textAlign: 'center',
                fontSize: 20,
                fontWeight: 700,
                color: 'var(--ink-900)',
                background: 'var(--surface)',
                border:
                  errorCode === 'INVALID_OTP'
                    ? '1px solid var(--danger-600)'
                    : '1px solid var(--ink-300)',
                borderRadius: 'var(--radius-md)',
              }}
            />
          ))}
        </div>

        {/* Errores inline: código inválido / rate-limited / expirado (§Estados). */}
        {errorCode && (
          <p role="alert" style={errorTextStyle}>
            {messageForCode(errorCode)}
          </p>
        )}

        {/* 4. Reenviar código (con contador de cooldown). Acción neutra, no morada. */}
        <div style={{ margin: 'var(--s12) 0 var(--s16)' }}>
          {resendSecondsLeft > 0 || isRateLimited ? (
            <span className="num" style={helpText}>
              {isRateLimited
                ? 'Espera un momento para reenviar'
                : `Reenviar en ${mmss(resendSecondsLeft)}`}
            </span>
          ) : (
            <button
              type="button"
              onClick={() => void sendCode(phone)}
              disabled={sending}
              style={linkButtonStyle}
            >
              {sending ? 'Reenviando…' : 'Reenviar código'}
            </button>
          )}
        </div>

        {/* 6. CTA primario (uno por pantalla): Verificar código. */}
        <button
          type="button"
          className="cta-primary"
          style={{ width: '100%' }}
          disabled={!otpComplete || verifying}
          aria-disabled={!otpComplete || verifying}
          onClick={() => void verify()}
        >
          {verifying ? 'Verificando…' : 'Verificar código'}
        </button>
      </div>
    </section>
  );
}

export default OtpForm;

// =====================================================================================
// Sub-componentes / estilos de presentación (solo tokens; sin colores hardcodeados).
// =====================================================================================

/**
 * Insignia de WhatsApp: círculo tintado morado (§tint) con un glifo de mensaje. Se usa el
 * morado de marca (no el verde de WhatsApp) para no introducir un color fuera de los tokens
 * (DISENO_UI §2: nada ad-hoc). El texto "WhatsApp" queda accesible vía aria-label.
 */
function WhatsappBadge() {
  return (
    <div
      role="img"
      aria-label="Verificación por WhatsApp"
      style={{
        width: 48,
        height: 48,
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        background: 'var(--purple-100)',
        color: 'var(--purple-700)',
        borderRadius: 'var(--radius-round)',
        marginBottom: 'var(--s12)',
      }}
    >
      <svg width="24" height="24" viewBox="0 0 24 24" fill="none" aria-hidden="true">
        <path
          d="M4 5.5A1.5 1.5 0 0 1 5.5 4h13A1.5 1.5 0 0 1 20 5.5v9A1.5 1.5 0 0 1 18.5 16H9l-4 3.5V5.5Z"
          stroke="currentColor"
          strokeWidth="1.6"
          strokeLinejoin="round"
        />
        <path
          d="m8.5 10 2 2 3.5-3.5"
          stroke="currentColor"
          strokeWidth="1.6"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    </div>
  );
}

const titleStyle: CSSProperties = {
  fontFamily: 'var(--font-display)',
  fontWeight: 700,
  fontSize: 20,
  color: 'var(--ink-900)',
  margin: '0 0 var(--s4)',
};

const labelStyle: CSSProperties = {
  display: 'block',
  fontSize: 13,
  color: 'var(--ink-700)',
  fontWeight: 600,
  marginBottom: 'var(--s8)',
};

const inputStyle: CSSProperties = {
  width: '100%',
  boxSizing: 'border-box',
  minHeight: 'var(--min-touch)',
  padding: '0 var(--s12)',
  fontSize: 16,
  color: 'var(--ink-900)',
  background: 'var(--surface)',
  border: '1px solid var(--ink-300)',
  borderRadius: 'var(--radius-md)',
};

const errorTextStyle: CSSProperties = {
  color: 'var(--danger-600)',
  fontSize: 13,
  margin: 'var(--s8) 0 0',
};

/** Botón que se ve como enlace (acciones neutras "Cambiar número" / "Reenviar"): morado de link. */
const linkButtonStyle: CSSProperties = {
  background: 'none',
  border: 0,
  padding: 0,
  color: 'var(--purple-700)',
  fontFamily: 'var(--font-body)',
  fontWeight: 600,
  fontSize: 14,
  cursor: 'pointer',
  textDecoration: 'underline',
  minHeight: 'var(--min-touch)',
};
