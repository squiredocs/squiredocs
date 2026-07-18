/**
 * Chat error taxonomy — the single server-side classification point (feature 012).
 *
 * Every chat-turn failure is classified here exactly once (FR-001), adjacent to
 * the provider call, into one of seven typed codes. This module owns:
 *   - the taxonomy codes,
 *   - the HTTP status map (D2),
 *   - the fatality set,
 *   - the structured payload builder ({ error, code, provider? }, FR-009),
 *   - the classify(err, ctx) orchestrator that combines the per-provider signal
 *     (from the provider registry — FR-003, no provider literals live here) with
 *     request context (BYOK vs shared key, rate/usage limits) to pick the final
 *     code, status, and notification ownership (US5).
 *
 * Token-limit and app-auth failures are OUTSIDE the taxonomy (FR-004/FR-005) —
 * the caller must not route them through classify().
 */

const { classifyProviderError } = require('./ai-providers');

// ── Taxonomy ──────────────────────────────────────────────────────────────────

const CODES = {
  APP_USAGE_LIMIT: 'app_usage_limit',
  BYOK_INSUFFICIENT_CREDITS: 'byok_insufficient_credits',
  BYOK_INVALID_KEY: 'byok_invalid_key',
  BYOK_MISCONFIGURED: 'byok_misconfigured',
  RATE_LIMITED: 'rate_limited',
  PROVIDER_OVERLOADED: 'provider_overloaded',
  MODEL_NO_IMAGE_SUPPORT: 'model_no_image_support',
  INTERNAL: 'internal',
};

// D2 status map. A classified non-`internal` failure is never a 500 (FR-006);
// `byok_invalid_key` is deliberately 400, never 401/403 (those drive the app's
// own session-refresh path — D2/D7).
const STATUS_BY_CODE = {
  [CODES.APP_USAGE_LIMIT]: 402,
  [CODES.BYOK_INSUFFICIENT_CREDITS]: 402,
  [CODES.BYOK_INVALID_KEY]: 400,
  [CODES.BYOK_MISCONFIGURED]: 400,
  [CODES.RATE_LIMITED]: 429,
  [CODES.PROVIDER_OVERLOADED]: 429,
  [CODES.MODEL_NO_IMAGE_SUPPORT]: 400,
  [CODES.INTERNAL]: 500,
};

// Fatal = everything except `internal`. Fatal codes render immediately and skip
// reconnect-recovery on the client (FR-015); the client mirrors this set.
const FATAL_CODES = new Set(
  Object.values(CODES).filter((c) => c !== CODES.INTERNAL)
);

// Honest, human-readable default `error` strings — free of raw provider internals
// (FR-009). These are the degraded-client fallback (D6); the client renders its
// own polished copy from the code. Kept intentionally provider-agnostic; the
// provider name travels in the `provider` field.
const DEFAULT_MESSAGES = {
  [CODES.APP_USAGE_LIMIT]: 'AI usage limit reached for this month.',
  [CODES.BYOK_INSUFFICIENT_CREDITS]: 'Your provider account is out of credit. Top up in your provider console to continue.',
  [CODES.BYOK_INVALID_KEY]: 'Your API key was rejected. Check it in Settings.',
  [CODES.BYOK_MISCONFIGURED]: 'Your AI model or key is not set up correctly. Fix it in Settings.',
  [CODES.RATE_LIMITED]: 'You are sending messages too fast. Wait a few seconds and try again.',
  [CODES.PROVIDER_OVERLOADED]: 'The AI provider is busy right now. Try again in a moment.',
  [CODES.MODEL_NO_IMAGE_SUPPORT]: "The selected model can't read images. Switch to a vision-capable model in Settings, or remove the image.",
  [CODES.INTERNAL]: 'Something went wrong generating a response. Try again.',
};

// ── Payload builder ─────────────────────────────────────────────────────────────

/**
 * Build the on-the-wire structured payload. `provider` is omitted when absent so
 * the shape stays `{ error, code }` for provider-agnostic codes.
 * @param {{ code: string, provider?: string, error?: string }} arg
 * @returns {{ error: string, code: string, provider?: string }}
 */
function buildErrorPayload({ code, provider, error } = {}) {
  const finalCode = code && STATUS_BY_CODE[code] ? code : CODES.INTERNAL;
  const payload = {
    error: error || DEFAULT_MESSAGES[finalCode] || DEFAULT_MESSAGES[CODES.INTERNAL],
    code: finalCode,
  };
  if (provider) payload.provider = provider;
  return payload;
}

// ── Retry-After extraction ──────────────────────────────────────────────────────

/** Read a provider-supplied Retry-After (seconds) off an upstream error, if any. */
function providerRetryAfter(err) {
  const headers = err?.responseHeaders || err?.headers;
  if (!headers) return null;
  const raw = typeof headers.get === 'function' ? headers.get('retry-after') : headers['retry-after'];
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.ceil(n) : null;
}

// ── Orchestrator ────────────────────────────────────────────────────────────────

/**
 * Classify a chat-turn failure into the taxonomy.
 *
 * @param {*} err   The upstream/provider error object (may be null for the
 *                  app-level pre-flight conditions signalled via ctx).
 * @param {object} ctx
 * @param {boolean} [ctx.isByok]            The turn used (or would have used) the user's own key.
 * @param {string}  [ctx.providerId]        Provider id for this request — the source of `provider`.
 * @param {boolean} [ctx.isUsageLimit]      Pre-flight in-app quota exhausted.
 * @param {boolean} [ctx.isRateLimited]     App per-user request/concurrency limit tripped.
 * @param {boolean} [ctx.isByokMisconfigured] BYOK on but key/model unresolvable.
 * @param {boolean} [ctx.isImageUnsupported]  The turn attached an image but the resolved model is text-only.
 * @returns {{ code, status, error, provider?, notifyOperator, notifyAdminCredit, trueCause?, retryAfterSec? }}
 */
function classify(err, ctx = {}) {
  const {
    isByok = false,
    providerId = null,
    isUsageLimit = false,
    isRateLimited = false,
    isByokMisconfigured = false,
    isImageUnsupported = false,
  } = ctx;

  // 1. App-level, pre-provider conditions — no provider signal needed.
  if (isUsageLimit) {
    return finalize(CODES.APP_USAGE_LIMIT, { notifyAdminCredit: true });
  }
  if (isImageUnsupported) {
    // Caught before the provider call (a text-only model + an image attachment):
    // an honest, fatal user error — not a server fault, so no operator page.
    return finalize(CODES.MODEL_NO_IMAGE_SUPPORT, { provider: providerId });
  }
  if (isByokMisconfigured) {
    return finalize(CODES.BYOK_MISCONFIGURED, { provider: providerId });
  }
  if (isRateLimited) {
    return finalize(CODES.RATE_LIMITED, { retryAfterSec: providerRetryAfter(err) });
  }

  // 2. Provider-attributable failures. Per-provider detection lives in the
  //    registry; this orchestrator only combines the signal with key ownership.
  const signal = providerId ? classifyProviderError(providerId, err) : null;
  switch (signal) {
    case 'insufficient_credits':
      if (isByok) {
        return finalize(CODES.BYOK_INSUFFICIENT_CREDITS, { provider: providerId });
      }
      // Shared server key out of funds is an OPERATOR incident (D3): the user
      // sees provider_overloaded (never told to top up an account they lack),
      // while the operator is paged with the true cause.
      return finalize(CODES.PROVIDER_OVERLOADED, {
        provider: providerId,
        notifyOperator: true,
        trueCause: 'shared server key: provider account out of funds',
        retryAfterSec: providerRetryAfter(err),
      });
    case 'invalid_key':
      if (isByok) {
        return finalize(CODES.BYOK_INVALID_KEY, { provider: providerId });
      }
      // The shared server key itself being rejected is a server misconfiguration,
      // not a user fault → internal (pages the operator).
      return finalize(CODES.INTERNAL, { notifyOperator: true });
    case 'overloaded':
      return finalize(CODES.PROVIDER_OVERLOADED, {
        provider: providerId,
        retryAfterSec: providerRetryAfter(err),
      });
    default:
      // Unclassifiable → internal; a genuine server fault pages the operator.
      return finalize(CODES.INTERNAL, { notifyOperator: true });
  }
}

function finalize(code, extra = {}) {
  const result = {
    code,
    status: STATUS_BY_CODE[code],
    error: DEFAULT_MESSAGES[code],
    provider: extra.provider || undefined,
    notifyOperator: !!extra.notifyOperator,
    notifyAdminCredit: !!extra.notifyAdminCredit,
  };
  if (extra.trueCause) result.trueCause = extra.trueCause;
  if (extra.retryAfterSec) result.retryAfterSec = extra.retryAfterSec;
  return result;
}

module.exports = {
  CODES,
  STATUS_BY_CODE,
  FATAL_CODES,
  DEFAULT_MESSAGES,
  buildErrorPayload,
  classify,
  providerRetryAfter,
};
