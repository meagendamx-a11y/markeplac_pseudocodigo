'use client';

// =====================================================================================
// app/resena/[token]/page.tsx
// Marketplace — "Formulario de reseña por link seguro" (paciente en seguimiento, >4 sesiones).
// Next.js App Router. CLIENT COMPONENT: la pantalla es un formulario interactivo (selector de
// estrellas, contador de caracteres, estados de envío), responsabilidades inherentes de cliente.
//
// Contrato: paginas/marketplace-resena.md (ruta, funciones, estados, jerarquía, "No debe")
//           + MARKETPLACE.md § Reseñas (~L1424) y § submit_marketplace_review (~L1448):
//             · Entrada { token, rating (1..5), comment? }. `SECURITY DEFINER`, autoriza el
//               TOKEN (no una sesión de Supabase; el paciente no tiene login).
//             · UPSERT sobre la MISMA fila (una por paciente-profesional) → moderation_status
//               = 'pending'. NUNCA publica directo (moderación admin es la 2ª barrera).
//             · Errores: INVALID_TOKEN, TOKEN_EXPIRED, NOT_ELIGIBLE, INVALID_RATING, INVALID_INPUT.
//             · Editable dentro de la ventana: reenvío válido antes de token_expires_at EDITA
//               la reseña (no falla) y vuelve a 'pending'.
//
// INVARIANTES DE SEGURIDAD DUROS (MARKETPLACE.md § Reseñas) que aplican aquí:
//   - El texto de la reseña NUNCA pasa por el LLM del agente: esto es un FORMULARIO WEB, no un
//     chat. En esta pantalla no existe ninguna llamada a un agente/tool: el comentario viaja
//     directo del <textarea> al Route Handler → RPC. (Patrón "link seguro", no "tool del agente":
//     evita prompt-injection y no amplía la superficie de tools del agente — MARKETPLACE.md ~L1435.)
//   - El comentario se RENDERIZA COMO TEXTO PLANO CON ESCAPE: React escapa `{comment}` por
//     defecto; en este archivo NUNCA se usa dangerouslySetInnerHTML ni se inyecta HTML crudo
//     (MARKETPLACE.md § RLS y seguridad, "render como texto plano con escape", ~L1514).
//   - service_role JAMÁS en el navegador: el cliente habla con Route Handlers propios
//     (server-only) que sostienen el service_role y llaman a la RPC. Este bundle no importa
//     supabase-server ni claves; solo hace fetch a /api/resena/*.
//   - NO se aceptan ni envían patient_id / professional_id desde el cliente: la identidad
//     (paciente, profesional) se deriva del TOKEN en el servidor (contrato § No debe, ~L1482).
//     El único secreto que porta el cliente es el token de su propio link (se lo mandó WhatsApp);
//     lo enviamos en el BODY (no en query string) para no sembrarlo en logs de request nuevos.
//   - Errores GENÉRICOS que no revelan si el token existe: INVALID_TOKEN → "Este enlace no es
//     válido" (no dice si existe). Rate-limit por IP vive en la capa edge del endpoint de submit
//     (anti-fuerza-bruta del token), no en el cliente (MARKETPLACE.md § Errores, ~L1480).
//   - Sin datos clínicos ni de otros pacientes: la pantalla solo muestra el nombre del
//     PROFESIONAL (resuelto por el token, el paciente no lo teclea) y, si edita, su propia
//     reseña previa (contrato § No debe: no mostrar datos de otros pacientes).
//
// SEO: link privado enviado por WhatsApp ⇒ este subárbol es noindex (lo fija el layout de
// /resena con robots index:false). Al ser Client Component no exporta `metadata`.
//
// NOTA DE ARQUITECTURA (gap del contrato): el estado "Formulario"/"Editable" del contrato
// exige mostrar el nombre del profesional y precargar la reseña previa. Eso requiere una
// LECTURA por token que MARKETPLACE.md § Reseñas hoy NO especifica como RPC (solo define el
// SUBMIT y prohíbe SELECT anon directo sobre `reviews`). Este cliente consume un Route Handler
// server-only `POST /api/resena/contexto` que debe envolver esa lectura mínima (allowlist:
// professional_name + rating/comment PROPIOS del token) con los mismos errores genéricos. Se
// deja señalado como pieza de backend a formalizar en el contrato (ver notes de la tarea).
// =====================================================================================

import { use, useCallback, useEffect, useRef, useState, type ReactNode } from 'react';

// -------------------------------------------------------------------------------------
// Endpoints server-only (el navegador NUNCA habla con Supabase; el service_role vive allí).
//   · POST /api/resena/contexto { token }  → { professional_name, existing?: {rating, comment} }
//                                            | { error: INVALID_TOKEN | TOKEN_EXPIRED | NOT_ELIGIBLE }
//   · POST /api/resena          { token, rating, comment? } → { status: 'pending_moderation' }
//                                            | { error: INVALID_TOKEN | TOKEN_EXPIRED | NOT_ELIGIBLE
//                                                     | INVALID_RATING | INVALID_INPUT }
// -------------------------------------------------------------------------------------

const CONTEXT_ENDPOINT = '/api/resena/contexto';
const SUBMIT_ENDPOINT = '/api/resena';

// Límite del comentario = 1000 (MARKETPLACE.md paso 2: len(comment) ≤ 1000 → INVALID_INPUT).
const COMMENT_MAX = 1000;

// -------------------------------------------------------------------------------------
// Tipos — espejo EXACTO de lo que devuelven los Route Handlers. Ni un campo autoritativo
// (patient_id/professional_id/appointment/token_hash) de más: el contrato lo prohíbe.
// -------------------------------------------------------------------------------------

/** Taxonomía de error del submit (MARKETPLACE.md § Errores, ~L1479). Reusada por el contexto
 *  para los errores de token/elegibilidad (mismos códigos, mismo trato genérico). */
type ReviewErrorCode =
  | 'INVALID_TOKEN' // token no existe/forjado ⇒ mensaje genérico (no revela existencia)
  | 'TOKEN_EXPIRED' // fuera de la ventana de envío/edición
  | 'NOT_ELIGIBLE' // ya no cumple >4 sesiones atendidas (revalidado en servidor)
  | 'INVALID_RATING' // rating fuera de 1..5
  | 'INVALID_INPUT'; // comentario > 1000 / body malformado

/** Contexto de pantalla resuelto por el token (allowlist mínima). `existing` solo trae la
 *  reseña PROPIA del token (estado "Editable"): nunca datos de otros pacientes. */
interface ReviewContext {
  professional_name: string; // resuelto por el token; el paciente NO lo teclea
  existing?: { rating: number; comment: string | null }; // precarga si ya reseñó en la ventana
}

/** Salida del submit (MARKETPLACE.md paso 6: DEVOLVER { status: 'pending_moderation' }). */
interface SubmitResult {
  status: 'pending_moderation';
}

interface ApiError {
  error: ReviewErrorCode | string;
}

// Fase de la pantalla (máquina local, distinta de los estados de dominio del contrato):
//   loading    → resolviendo el contexto por token (primer paint)
//   form       → token válido/vigente: se muestra el formulario (nuevo o precargado=Editable)
//   submitting → envío en curso: spinner en el CTA
//   submitted  → éxito: "¡Gracias! Tu opinión está en revisión"
//   invalid    → INVALID_TOKEN  → "Este enlace no es válido"
//   expired    → TOKEN_EXPIRED  → "Este enlace ya venció"
//   ineligible → NOT_ELIGIBLE   → "Aún no puedes dejar una reseña"
//   neterror   → fallo de red/HTTP al resolver el contexto (recuperable, sin declarar dominio)
type Phase =
  | 'loading'
  | 'form'
  | 'submitting'
  | 'submitted'
  | 'invalid'
  | 'expired'
  | 'ineligible'
  | 'neterror';

// -------------------------------------------------------------------------------------
// Página. En Next 15 `params` llega como Promise también en Client Components ⇒ `use()`.
// El token vive en la RUTA (/resena/[token]); es el link que WhatsApp envió al paciente.
// -------------------------------------------------------------------------------------

export default function ResenaPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = use(params);

  const [phase, setPhase] = useState<Phase>('loading');
  const [context, setContext] = useState<ReviewContext | null>(null);

  // Estado del formulario. Se prellenan al resolver "Editable" (reseña previa del propio token).
  const [rating, setRating] = useState<number>(0); // 0 = sin elegir (CTA deshabilitado)
  const [comment, setComment] = useState<string>('');

  // Error de submit para pintar en línea sin perder lo tecleado (rating/comment se conservan).
  const [submitError, setSubmitError] = useState<ReviewErrorCode | null>(null);

  const cancelledRef = useRef(false);

  // Mapea un código de dominio (token/elegibilidad) a la fase terminal correspondiente.
  const phaseForCode = (code: string): Phase => {
    switch (code) {
      case 'INVALID_TOKEN':
        return 'invalid';
      case 'TOKEN_EXPIRED':
        return 'expired';
      case 'NOT_ELIGIBLE':
        return 'ineligible';
      default:
        return 'neterror';
    }
  };

  // Resolución inicial del contexto por token (server-only). El token viaja en el BODY, no en
  // query string, para no sembrarlo en logs nuevos; el link ya lo tiene el navegador de todos modos.
  const loadContext = useCallback(async () => {
    setPhase('loading');
    try {
      const res = await fetch(CONTEXT_ENDPOINT, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({ token }),
        cache: 'no-store', // estado en vivo; jamás cachear (la ventana del token puede vencer)
      });
      const body = (await res.json().catch(() => null)) as ReviewContext | ApiError | null;
      if (cancelledRef.current) return;

      if (!res.ok || !body || 'error' in body) {
        setPhase(phaseForCode((body as ApiError | null)?.error ?? `HTTP_${res.status}`));
        return;
      }

      setContext(body);
      // Estado "Editable": precarga la reseña previa (upsert sobre la misma fila).
      if (body.existing) {
        setRating(body.existing.rating);
        setComment(body.existing.comment ?? '');
      }
      setPhase('form');
    } catch {
      if (cancelledRef.current) return;
      setPhase('neterror'); // fallo de red: recuperable, no se declara ningún estado de dominio
    }
  }, [token]);

  useEffect(() => {
    cancelledRef.current = false;
    void loadContext();
    return () => {
      cancelledRef.current = true;
    };
  }, [loadContext]);

  // Envío de la reseña. El comentario viaja tal cual (texto plano) al Route Handler → RPC:
  // no toca ningún LLM/agente. La RPC revalida rating (1..5), longitud (≤1000) y RE-VERIFICA
  // elegibilidad (>4 attended) bajo lock (MARKETPLACE.md pasos 2 y 4).
  const submit = useCallback(async () => {
    // Guarda cliente: rating requerido (1..5). El servidor revalida con INVALID_RATING igual.
    if (rating < 1 || rating > 5) {
      setSubmitError('INVALID_RATING');
      return;
    }
    if (comment.length > COMMENT_MAX) {
      setSubmitError('INVALID_INPUT');
      return;
    }

    setSubmitError(null);
    setPhase('submitting');
    try {
      const res = await fetch(SUBMIT_ENDPOINT, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        // Solo { token, rating, comment }: NUNCA patient_id/professional_id (se derivan del token).
        // `comment` opcional: si está vacío se manda null (comentario es opcional; solo rating obliga).
        body: JSON.stringify({
          token,
          rating,
          comment: comment.trim().length > 0 ? comment : null,
        }),
        cache: 'no-store',
      });
      const body = (await res.json().catch(() => null)) as SubmitResult | ApiError | null;
      if (cancelledRef.current) return;

      if (!res.ok || !body || 'error' in body) {
        const code = ((body as ApiError | null)?.error ?? `HTTP_${res.status}`) as string;
        // Token vencido/robado o elegibilidad perdida entre carga y envío ⇒ estado terminal.
        if (code === 'INVALID_TOKEN' || code === 'TOKEN_EXPIRED' || code === 'NOT_ELIGIBLE') {
          setPhase(phaseForCode(code));
          return;
        }
        // INVALID_RATING / INVALID_INPUT / red: error en línea, se conserva lo tecleado.
        setSubmitError(
          code === 'INVALID_RATING' || code === 'INVALID_INPUT'
            ? (code as ReviewErrorCode)
            : 'INVALID_INPUT',
        );
        setPhase('form');
        return;
      }

      setPhase('submitted'); // { status: 'pending_moderation' } — recuerda que se publica tras revisión
    } catch {
      if (cancelledRef.current) return;
      setSubmitError('INVALID_INPUT'); // fallo de red: se puede reintentar sin perder lo tecleado
      setPhase('form');
    }
  }, [token, rating, comment]);

  return (
    <main style={{ minHeight: '100vh' }}>
      <header
        style={{
          display: 'flex',
          alignItems: 'center',
          padding: 'var(--s16) var(--s20)',
          borderBottom: '1px solid var(--border)',
          background: 'var(--surface)',
        }}
      >
        <h1
          style={{
            fontFamily: 'var(--font-display)',
            fontWeight: 700,
            fontSize: 18,
            color: 'var(--ink-900)',
            margin: 0,
          }}
        >
          Tu reseña
        </h1>
      </header>

      <div style={{ maxWidth: 520, margin: '0 auto', padding: 'var(--s24) var(--s16) var(--s32)' }}>
        <ResenaBody
          phase={phase}
          context={context}
          rating={rating}
          comment={comment}
          submitError={submitError}
          onRating={setRating}
          onComment={setComment}
          onSubmit={submit}
          onRetryLoad={loadContext}
        />
      </div>
    </main>
  );
}

// -------------------------------------------------------------------------------------
// Cuerpo por estado (contrato § Estados de la pantalla).
// -------------------------------------------------------------------------------------

function ResenaBody({
  phase,
  context,
  rating,
  comment,
  submitError,
  onRating,
  onComment,
  onSubmit,
  onRetryLoad,
}: {
  phase: Phase;
  context: ReviewContext | null;
  rating: number;
  comment: string;
  submitError: ReviewErrorCode | null;
  onRating: (n: number) => void;
  onComment: (s: string) => void;
  onSubmit: () => void;
  onRetryLoad: () => void;
}) {
  // --- Resolviendo el token (primer paint). ---
  if (phase === 'loading') {
    return (
      <StateCard
        tone="processing"
        icon={<Spinner />}
        title="Cargando…"
        message="Estamos preparando tu formulario de reseña."
      />
    );
  }

  // --- Token inválido: mensaje GENÉRICO (no revela si el token existe). ---
  if (phase === 'invalid') {
    return (
      <StateCard
        tone="warning"
        icon={<GlyphInfo />}
        title="Este enlace no es válido"
        message="Revisa que hayas abierto el enlace completo que te enviamos por WhatsApp."
      />
    );
  }

  // --- Token vencido: sin reintento de adivinanza. ---
  if (phase === 'expired') {
    return (
      <StateCard
        tone="warning"
        icon={<GlyphClock />}
        title="Este enlace ya venció"
        message="El periodo para dejar tu reseña terminó. Si quieres compartir tu opinión, escríbenos por WhatsApp."
      />
    );
  }

  // --- No elegible (aún no >4 sesiones atendidas; revalidado en servidor). ---
  if (phase === 'ineligible') {
    return (
      <StateCard
        tone="warning"
        icon={<GlyphInfo />}
        title="Aún no puedes dejar una reseña"
        message="Las reseñas están disponibles para pacientes en seguimiento. Gracias por tu interés."
      />
    );
  }

  // --- Enviada: la reseña quedó en moderación (nunca se publica directo). ---
  if (phase === 'submitted') {
    return (
      <StateCard
        tone="success"
        icon={<GlyphCheck />}
        title="¡Gracias! Tu opinión está en revisión"
        message="La revisamos antes de publicarla en el perfil del profesional. No necesitas hacer nada más."
      />
    );
  }

  // --- Fallo de red al resolver el contexto: recuperable, sin declarar estado de dominio. ---
  if (phase === 'neterror') {
    return (
      <StateCard
        tone="danger"
        icon={<GlyphAlert />}
        title="No pudimos cargar el formulario"
        message="Revisa tu conexión e inténtalo de nuevo."
        primary={
          <button type="button" className="cta-primary" onClick={onRetryLoad}>
            Reintentar
          </button>
        }
      />
    );
  }

  // --- form / submitting: el formulario de reseña. ---
  const submitting = phase === 'submitting';
  return (
    <ReviewForm
      professionalName={context?.professional_name ?? 'tu profesional'}
      isEditing={Boolean(context?.existing)}
      rating={rating}
      comment={comment}
      submitError={submitError}
      submitting={submitting}
      onRating={onRating}
      onComment={onComment}
      onSubmit={onSubmit}
    />
  );
}

// -------------------------------------------------------------------------------------
// Formulario (contrato § Jerarquía):
//   1. Encabezado "¿Cómo fue tu experiencia con [Nombre]?" (nombre resuelto por el token).
//   2. Rating: selector de estrellas 1–5 (requerido).
//   3. Comentario: textarea opcional, límite 1000 (contador), nota "se publica tras revisión".
//   4. CTA "Enviar reseña" (deshabilitado sin rating).
//   5. Aviso "Tu reseña se revisa antes de publicarse."
// -------------------------------------------------------------------------------------

function ReviewForm({
  professionalName,
  isEditing,
  rating,
  comment,
  submitError,
  submitting,
  onRating,
  onComment,
  onSubmit,
}: {
  professionalName: string;
  isEditing: boolean;
  rating: number;
  comment: string;
  submitError: ReviewErrorCode | null;
  submitting: boolean;
  onRating: (n: number) => void;
  onComment: (s: string) => void;
  onSubmit: () => void;
}) {
  const remaining = COMMENT_MAX - comment.length;
  const overLimit = remaining < 0;
  const canSubmit = rating >= 1 && rating <= 5 && !overLimit && !submitting;

  return (
    <form
      className="card"
      onSubmit={(e) => {
        e.preventDefault(); // envío por fetch, no navegación (el token no debe ir a query string)
        if (canSubmit) onSubmit();
      }}
      style={{ padding: 'var(--s24)' }}
      noValidate
    >
      {/* 1. Encabezado — el nombre del profesional lo resuelve el token, el paciente no lo teclea. */}
      <h2
        style={{
          fontFamily: 'var(--font-display)',
          fontWeight: 700,
          fontSize: 22,
          lineHeight: 1.3,
          color: 'var(--ink-900)',
          margin: '0 0 var(--s8)',
        }}
      >
        ¿Cómo fue tu experiencia con {professionalName}?
      </h2>
      <p style={{ color: 'var(--ink-500)', fontSize: 14, lineHeight: 1.5, margin: '0 0 var(--s24)' }}>
        {isEditing
          ? 'Puedes ajustar tu reseña; volverá a revisión antes de publicarse.'
          : 'Tu opinión ayuda a otras personas a elegir. Se revisa antes de publicarse.'}
      </p>

      {/* 2. Rating — selector de estrellas accesible (radiogroup). Requerido. */}
      <StarRating value={rating} onChange={onRating} disabled={submitting} />

      {/* 3. Comentario — opcional, texto plano, límite 1000 con contador. */}
      <div style={{ marginTop: 'var(--s24)' }}>
        <label
          htmlFor="resena-comment"
          style={{
            display: 'block',
            fontSize: 14,
            fontWeight: 600,
            color: 'var(--ink-700)',
            marginBottom: 'var(--s8)',
          }}
        >
          Comentario <span style={{ color: 'var(--ink-500)', fontWeight: 400 }}>(opcional)</span>
        </label>
        <textarea
          id="resena-comment"
          value={comment}
          onChange={(e) => onComment(e.target.value)}
          disabled={submitting}
          rows={5}
          // maxLength recorta en el cliente; el servidor revalida ≤1000 (INVALID_INPUT) de todos modos.
          maxLength={COMMENT_MAX}
          placeholder="¿Qué te gustaría destacar de tu experiencia? (opcional)"
          aria-describedby="resena-comment-help resena-comment-count"
          style={{
            width: '100%',
            boxSizing: 'border-box',
            resize: 'vertical',
            minHeight: 112,
            padding: 'var(--s12)',
            fontFamily: 'var(--font-body)',
            fontSize: 15,
            lineHeight: 1.5,
            color: 'var(--ink-900)',
            background: 'var(--surface)',
            border: `1px solid ${overLimit ? 'var(--danger-600)' : 'var(--border)'}`,
            borderRadius: 'var(--radius-md)',
          }}
        />
        <div
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            gap: 'var(--s12)',
            marginTop: 'var(--s8)',
          }}
        >
          <span id="resena-comment-help" style={{ color: 'var(--ink-500)', fontSize: 13 }}>
            Se publica tras revisión.
          </span>
          <span
            id="resena-comment-count"
            className="num"
            style={{
              fontSize: 13,
              color: overLimit ? 'var(--danger-600)' : 'var(--ink-500)',
              whiteSpace: 'nowrap',
            }}
          >
            {comment.length}/{COMMENT_MAX}
          </span>
        </div>
      </div>

      {/* Error en línea (INVALID_RATING / INVALID_INPUT / red): se conserva lo tecleado. */}
      {submitError && (
        <p
          role="alert"
          style={{
            marginTop: 'var(--s16)',
            padding: 'var(--s12) var(--s16)',
            background: 'var(--danger-100)',
            color: 'var(--danger-600)',
            borderRadius: 'var(--radius-md)',
            fontSize: 14,
            margin: 'var(--s16) 0 0',
          }}
        >
          {messageForSubmitError(submitError)}
        </p>
      )}

      {/* 4. CTA "Enviar reseña" — deshabilitado sin rating; spinner al enviar. */}
      <button
        type="submit"
        className="cta-primary"
        disabled={!canSubmit}
        aria-busy={submitting}
        style={{ width: '100%', marginTop: 'var(--s24)' }}
      >
        {submitting ? (
          <>
            <Spinner />
            <span style={{ marginLeft: 'var(--s8)' }}>Enviando…</span>
          </>
        ) : isEditing ? (
          'Actualizar reseña'
        ) : (
          'Enviar reseña'
        )}
      </button>

      {/* 5. Aviso de moderación (jerarquía §5). */}
      <p
        style={{
          textAlign: 'center',
          color: 'var(--ink-500)',
          fontSize: 13,
          lineHeight: 1.5,
          margin: 'var(--s16) 0 0',
        }}
      >
        Tu reseña se revisa antes de publicarse.
      </p>
    </form>
  );
}

// -------------------------------------------------------------------------------------
// Selector de estrellas 1–5 — accesible como radiogroup (teclado + lectores de pantalla).
// El foco visible lo da tokens.css (:focus-visible con outline morado). El morado NO se usa
// como color de estado: las estrellas activas usan ámbar (semántico de "calificación"), el
// morado queda reservado al CTA (DISENO_UI §1).
// -------------------------------------------------------------------------------------

const STAR_LABELS = ['Muy mala', 'Mala', 'Regular', 'Buena', 'Excelente'] as const;

function StarRating({
  value,
  onChange,
  disabled,
}: {
  value: number;
  onChange: (n: number) => void;
  disabled?: boolean;
}) {
  return (
    <fieldset
      style={{ border: 0, padding: 0, margin: 0 }}
      aria-required="true"
      disabled={disabled}
    >
      <legend
        style={{
          fontSize: 14,
          fontWeight: 600,
          color: 'var(--ink-700)',
          padding: 0,
          marginBottom: 'var(--s8)',
        }}
      >
        Tu calificación
      </legend>
      <div role="radiogroup" aria-label="Calificación de 1 a 5 estrellas" style={{ display: 'flex', gap: 'var(--s8)' }}>
        {[1, 2, 3, 4, 5].map((n) => {
          const active = n <= value;
          const label = `${n} — ${STAR_LABELS[n - 1]}`;
          return (
            <label
              key={n}
              title={label}
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                justifyContent: 'center',
                width: 'var(--min-touch)',
                height: 'var(--min-touch)',
                cursor: disabled ? 'default' : 'pointer',
                color: active ? 'var(--amber-600)' : 'var(--ink-300)',
              }}
            >
              {/* Radio real (accesible), visualmente oculto pero enfocable: el label pinta la estrella. */}
              <input
                type="radio"
                name="resena-rating"
                value={n}
                checked={value === n}
                onChange={() => onChange(n)}
                disabled={disabled}
                aria-label={label}
                style={{
                  position: 'absolute',
                  width: 1,
                  height: 1,
                  padding: 0,
                  margin: -1,
                  overflow: 'hidden',
                  clip: 'rect(0 0 0 0)',
                  whiteSpace: 'nowrap',
                  border: 0,
                }}
              />
              <StarGlyph filled={active} />
            </label>
          );
        })}
      </div>
    </fieldset>
  );
}

// -------------------------------------------------------------------------------------
// Tarjeta de estado reutilizable (misma familia visual que resultado/page.tsx). El `tone`
// mapea a los semánticos de tokens.css; el morado se reserva al CTA (DISENO_UI §1).
// -------------------------------------------------------------------------------------

type Tone = 'success' | 'processing' | 'warning' | 'danger';

function StateCard({
  tone,
  icon,
  title,
  message,
  primary,
}: {
  tone: Tone;
  icon: ReactNode;
  title: string;
  message: string;
  primary?: ReactNode;
}) {
  const ring = toneRing(tone);
  return (
    <section
      className="card"
      role="status"
      aria-live="polite"
      style={{ padding: 'var(--s24)', textAlign: 'center' }}
    >
      <span
        aria-hidden="true"
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          width: 64,
          height: 64,
          borderRadius: 'var(--radius-round)',
          background: ring.bg,
          color: ring.fg,
          marginBottom: 'var(--s16)',
        }}
      >
        {icon}
      </span>
      <h2
        style={{
          fontFamily: 'var(--font-display)',
          fontWeight: 700,
          fontSize: 22,
          color: 'var(--ink-900)',
          margin: '0 0 var(--s8)',
        }}
      >
        {title}
      </h2>
      <p style={{ color: 'var(--ink-500)', fontSize: 15, lineHeight: 1.5, margin: 0 }}>{message}</p>
      {primary && (
        <div style={{ display: 'flex', justifyContent: 'center', marginTop: 'var(--s24)' }}>
          {primary}
        </div>
      )}
    </section>
  );
}

function toneRing(tone: Tone): { bg: string; fg: string } {
  switch (tone) {
    case 'success':
      return { bg: 'var(--success-100)', fg: 'var(--success-600)' };
    case 'warning':
      return { bg: 'var(--amber-100)', fg: 'var(--amber-600)' };
    case 'danger':
      return { bg: 'var(--danger-100)', fg: 'var(--danger-600)' };
    case 'processing':
    default:
      return { bg: 'var(--purple-100)', fg: 'var(--purple-700)' };
  }
}

// -------------------------------------------------------------------------------------
// Mensajes de error de submit (texto UI en es-MX; identificadores en inglés). Genéricos y
// sin filtrar detalle interno. Los códigos terminales de token/elegibilidad se manejan como
// estados de pantalla, no aquí.
// -------------------------------------------------------------------------------------

function messageForSubmitError(code: ReviewErrorCode): string {
  switch (code) {
    case 'INVALID_RATING':
      return 'Elige una calificación de 1 a 5 estrellas.';
    case 'INVALID_INPUT':
      return 'Revisa tu comentario (máximo 1000 caracteres) e inténtalo de nuevo.';
    default:
      // INVALID_TOKEN/TOKEN_EXPIRED/NOT_ELIGIBLE no llegan aquí (son estados de pantalla).
      return 'No pudimos enviar tu reseña. Inténtalo de nuevo.';
  }
}

// -------------------------------------------------------------------------------------
// Íconos inline (SVG, currentColor). Sin dependencias externas ni imágenes remotas.
// -------------------------------------------------------------------------------------

function StarGlyph({ filled }: { filled: boolean }) {
  return (
    <svg width="34" height="34" viewBox="0 0 24 24" fill={filled ? 'currentColor' : 'none'} aria-hidden="true">
      <path
        d="M12 3.5l2.6 5.27 5.82.85-4.21 4.1.99 5.79L12 16.77l-5.2 2.74.99-5.79-4.21-4.1 5.82-.85L12 3.5z"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function Spinner() {
  return (
    <>
      <style>{`@keyframes apspin { to { transform: rotate(360deg); } }`}</style>
      <svg
        width="20"
        height="20"
        viewBox="0 0 24 24"
        fill="none"
        aria-hidden="true"
        style={{ animation: 'apspin 0.9s linear infinite', verticalAlign: 'middle' }}
      >
        <circle cx="12" cy="12" r="9" stroke="currentColor" strokeOpacity="0.25" strokeWidth="2.5" />
        <path d="M21 12a9 9 0 0 0-9-9" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" />
      </svg>
    </>
  );
}

function GlyphCheck() {
  return (
    <svg width="30" height="30" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d="M20 6 9 17l-5-5" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function GlyphInfo() {
  return (
    <svg width="28" height="28" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="2" />
      <path d="M12 11v5" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" />
      <circle cx="12" cy="7.5" r="1.2" fill="currentColor" />
    </svg>
  );
}

function GlyphClock() {
  return (
    <svg width="28" height="28" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="2" />
      <path d="M12 7.5V12l3 2" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function GlyphAlert() {
  return (
    <svg width="28" height="28" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d="M12 4 2.5 20h19L12 4Z" stroke="currentColor" strokeWidth="2" strokeLinejoin="round" />
      <path d="M12 10v4" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" />
      <circle cx="12" cy="17" r="1.2" fill="currentColor" />
    </svg>
  );
}
