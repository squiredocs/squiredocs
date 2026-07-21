/**
 * Pure derivations for the durable per-chat turn-error state (feature 025).
 *
 * A failed chat turn is persisted as a `{ code, provider, at }` record stamped
 * onto the failed turn's TRAILING USER MESSAGE (the last `role === 'user'` entry)
 * inside the chat's messages JSONB — see data-model.md §1. `deriveTurnError` and
 * `hasPartialReply` are the CLIENT's read-side derivations: imported by
 * AiChatContext for banner rendering and unit-tested here in isolation.
 *
 * These are client-only ESM helpers; the server does NOT import them. The server
 * is CJS and cannot require this module, so it re-implements the equivalent stamp
 * write INLINE in `server/api/chat.js` (the `stampTurnFailure` RMW and the
 * `onFinish` stamp-aware save). `stampFailure` below is therefore a client-side
 * test/simulation helper only — it has no production consumer; it exists so the
 * unit tests can build a stamped transcript and round-trip it through the same
 * read-side derivations the client actually uses.
 *
 * The single discriminator everywhere is the `failure` stamp on the LAST
 * `role === 'user'` message — never message position. That one rule yields
 * trailing-turn keying, interrupted-partial banners, and older-stamp-inert by
 * construction (data-model.md §2, research.md R4). Do NOT neutralize on "the last
 * message is an assistant with content" — an interrupted partial reply is exactly
 * that shape yet must keep its banner + notice (US5).
 */

// Index of the last `role === 'user'` message, or -1 if there is none.
function lastUserIndex(messages) {
  if (!Array.isArray(messages)) return -1;
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    if (messages[i]?.role === 'user') return i;
  }
  return -1;
}

// True when a message carries visible content (any non-empty text part, or any
// non-text part such as a tool call / reasoning / file). Empty-part placeholder
// messages (an interrupted stream that produced nothing) do not count.
function messageHasContent(msg) {
  const parts = msg?.parts;
  if (!Array.isArray(parts) || parts.length === 0) return false;
  return parts.some((p) => (p?.type === 'text' ? !!(p.text && p.text.trim().length) : !!p?.type));
}

/**
 * The transcript source of truth for the failure banner, keyed on the trailing
 * turn. Returns `{ code, provider }` from the `failure` stamp on the last
 * `role === 'user'` message, or `null` (no stamp / no user message / legacy
 * transcript). An unknown/future code is returned as-is and floored to `internal`
 * copy by `parseChatError` at render time (D6).
 * @param {Array} messages - UIMessage array
 * @returns {{ code: string, provider: string|null } | null}
 */
export function deriveTurnError(messages) {
  const u = lastUserIndex(messages);
  if (u < 0) return null;
  const failure = messages[u]?.metadata?.failure;
  if (!failure || !failure.code) return null;
  return { code: failure.code, provider: failure.provider || null };
}

/**
 * True when an assistant message with visible content follows the last
 * `role === 'user'` message — i.e. the failed turn left a partial reply. Only
 * meaningful when `deriveTurnError` (or the live turn-error state) is non-null;
 * it drives the "response interrupted" notice (US5). A failed turn with nothing
 * after the user message is a plain failed turn, not an interruption.
 * @param {Array} messages - UIMessage array
 * @returns {boolean}
 */
export function hasPartialReply(messages) {
  const u = lastUserIndex(messages);
  if (u < 0) return false;
  for (let i = u + 1; i < messages.length; i += 1) {
    if (messages[i]?.role === 'assistant' && messageHasContent(messages[i])) return true;
  }
  return false;
}

/**
 * CLIENT-SIDE TEST/SIMULATION HELPER (no production consumer — see the module
 * docstring). Mirrors the server's inline stamp write so the unit tests can build
 * a stamped transcript to feed the read-side derivations above.
 *
 * Apply a failure record to the LAST `role === 'user'` message's metadata
 * (additive — preserves sibling metadata such as `refs`/`kind`). Returns a NEW
 * array with a shallow-cloned target message; the rest are shared by reference.
 * No-op (returns the input array) when there is no user message to stamp — a
 * failure before any user turn is persisted is never stamped (FR-006).
 *
 * Note: for a mid-stream failure the array's LAST element is the assistant
 * partial — the stamp still belongs on the last *user* message, NOT
 * `messages[length - 1]` (research.md R1 / M1).
 * @param {Array} messages - UIMessage array
 * @param {{ code: string, provider?: string, at?: string }} record
 * @returns {Array}
 */
export function stampFailure(messages, record) {
  const u = lastUserIndex(messages);
  if (u < 0) return messages;
  const target = messages[u];
  const failure = { code: record.code };
  if (record.provider) failure.provider = record.provider;
  if (record.at) failure.at = record.at;
  const stamped = { ...target, metadata: { ...(target.metadata || {}), failure } };
  const next = messages.slice();
  next[u] = stamped;
  return next;
}
