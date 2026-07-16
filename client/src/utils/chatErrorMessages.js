/**
 * Chat error rendering + behavior — the single client-side source (feature 012).
 *
 * Imported by both chat surfaces (side panel + full page) so they render
 * identical text for identical codes by construction (SC-002). The structured
 * `code` from the server is the SOLE discriminator: this module NEVER
 * substring-matches error bodies to decide behavior (FR-013/SC-007).
 *
 * Exports:
 *   - MESSAGES: code → { text, action } (D1 reference copy)
 *   - PROVIDER_LABELS: provider id → display label (provider name comes only
 *     from the payload, never from client-side mode inference — FR-008/FR-014)
 *   - FATAL_CODES / RETRYABLE_CODES: recovery-gating + retry-affordance sets
 *   - parseChatError(errorOrPayload) → { code, provider, text, status }
 */

// Provider display labels. `{ProviderLabel}` in MESSAGES is filled from the
// payload's `provider` id via this map; an unknown/absent provider ⇒ "your provider".
export const PROVIDER_LABELS = {
  anthropic: 'Anthropic',
  google: 'Gemini',
  openai: 'OpenAI',
  zai: 'z.ai',
  openrouter: 'OpenRouter',
};

// code → { text, action }. `action` drives the affordance the banner renders:
//   retry    → Retry button (only for RETRYABLE_CODES)
//   usage    → "View Usage" link
//   settings → "Open Settings" link
//   console  → point at the provider console (text only, no app link)
//   wait     → wait guidance (surfaces Retry-After when known; plain text)
// Reference copy (D1); microcopy may be polished as long as each keeps its
// action and leaks no raw provider text. Tone: honest but confident.
export const MESSAGES = {
  app_usage_limit: {
    text: "You've reached your AI usage limit for this month.",
    action: 'usage',
  },
  byok_insufficient_credits: {
    text: 'Your {ProviderLabel} account is out of credit. Top up in your {ProviderLabel} console to continue.',
    action: 'console',
  },
  byok_invalid_key: {
    text: 'Your {ProviderLabel} API key was rejected. Check it in Settings.',
    action: 'settings',
  },
  byok_misconfigured: {
    text: "Your AI model or key isn't set up correctly. Fix it in Settings.",
    action: 'settings',
  },
  provider_overloaded: {
    text: 'The AI provider is busy right now. Try again in a moment.',
    action: 'retry',
  },
  rate_limited: {
    text: "You're sending messages too fast. Wait a few seconds and try again.",
    action: 'wait',
  },
  internal: {
    text: 'Something went wrong generating a response. Try again.',
    action: 'retry',
  },
};

// Fatal = everything except `internal`. Fatal ⇒ render immediately, bypass
// reconnect-recovery (FR-015). Mirrors the server's FATAL_CODES.
export const FATAL_CODES = new Set([
  'app_usage_limit',
  'byok_insufficient_credits',
  'byok_invalid_key',
  'byok_misconfigured',
  'rate_limited',
  'provider_overloaded',
]);

// Only these render a Retry button (D4). Others show their fixing action; the
// composer stays enabled for every code (D4/FR-018).
export const RETRYABLE_CODES = new Set(['internal', 'provider_overloaded']);

const KNOWN_CODES = new Set(Object.keys(MESSAGES));

// Parse a JSON string into an object, or null. Never throws.
function tryParseJson(text) {
  if (typeof text !== 'string') return null;
  const trimmed = text.trim();
  if (!trimmed || (trimmed[0] !== '{' && trimmed[0] !== '[')) return null;
  try {
    const parsed = JSON.parse(trimmed);
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

// Resolve the user-facing text for a parsed code. Interpolates the provider
// label; for the `internal` fallback (unknown/absent code), prefers the payload's
// honest server string when present (FR-013/D6).
function resolveText(code, provider, payload, fellBack, structured) {
  if (code === 'internal') {
    const serverText = payload.error || payload.errorText;
    // Only surface the server's own string when it came from a genuine structured
    // body — a JSON payload (or transport body) carrying error/errorText. A raw
    // non-JSON body (e.g. a proxy's HTML error page or a bare "Bad Gateway") is
    // NOT display text; fall back to the generic internal copy (L6).
    if (fellBack && structured && serverText) return serverText;
    return MESSAGES.internal.text;
  }
  const label = PROVIDER_LABELS[provider] || 'your provider';
  return MESSAGES[code].text.replace(/\{ProviderLabel\}/g, label);
}

/**
 * Turn a transport error / SSE error payload / structured body into the render
 * decision. Accepts:
 *   - an Error thrown by the custom transport fetch (message = JSON body text,
 *     optional `.status` — D8),
 *   - an already-parsed payload `{ error, code, provider }`,
 *   - a mid-stream signal `{ code, provider, error }` (from the data-chat-error part),
 *   - a plain JSON string.
 * Unknown code, or a payload with no code, falls back to `internal` rendering,
 * showing the payload's error/errorText when present (FR-013). Never inspects
 * free text to pick a code.
 * @returns {{ code: string, provider: string|null, text: string, status: number|undefined }}
 */
export function parseChatError(errorOrPayload) {
  let payload = null;
  let status;
  // Whether `payload` is genuine structured data (an object with code/error/
  // errorText, or a successfully JSON-parsed body) vs. a raw-text wrapper we
  // synthesized from a non-JSON body. Only the former may be shown as display
  // text on the internal fallback (L6).
  let structured = false;

  if (errorOrPayload && typeof errorOrPayload === 'object') {
    if (typeof errorOrPayload.status === 'number') status = errorOrPayload.status;
    if ('code' in errorOrPayload || 'errorText' in errorOrPayload || 'error' in errorOrPayload) {
      // Already-structured payload or SSE error/data part.
      payload = errorOrPayload;
      structured = true;
    } else if (typeof errorOrPayload.message === 'string') {
      // Transport Error: the message is the response body text. Structured only
      // when it actually parses as JSON — a raw HTML/plain-text proxy body does not.
      const parsed = tryParseJson(errorOrPayload.message);
      if (parsed) { payload = parsed; structured = true; } else payload = { error: errorOrPayload.message };
    }
  } else if (typeof errorOrPayload === 'string') {
    const parsed = tryParseJson(errorOrPayload);
    if (parsed) { payload = parsed; structured = true; } else payload = { error: errorOrPayload };
  }
  payload = payload || {};

  const rawCode = payload.code;
  const fellBack = !KNOWN_CODES.has(rawCode);
  const code = fellBack ? 'internal' : rawCode;
  const provider = payload.provider || null;
  const text = resolveText(code, provider, payload, fellBack, structured);

  return { code, provider, text, status };
}
