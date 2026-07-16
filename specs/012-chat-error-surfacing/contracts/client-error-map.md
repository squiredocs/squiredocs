# Contract: Client Code→Message Map & Recovery Behavior (012)

`client/src/utils/chatErrorMessages.js` is the single source of user-facing error copy and
error-behavior classification, imported by `AiChatBody` (shared by side panel + full page) so
both surfaces are identical by construction (SC-002). The client NEVER substring-matches error
bodies to decide behavior (FR-013/SC-007) — the structured `code` is the sole discriminator.

## Exports

### `MESSAGES` — code → `{ text, action }`

Reference copy (D1; final microcopy may be polished as long as each keeps its action and leaks
no raw provider text). Tone: honest but confident (marketing-copy standard).

| code | text (reference) | action |
|---|---|---|
| `app_usage_limit` | You've reached your AI usage limit for this month. | `usage` (View Usage link) |
| `byok_insufficient_credits` | Your {ProviderLabel} account is out of credit. Top up in your {ProviderLabel} console to continue. | (provider console) |
| `byok_invalid_key` | Your {ProviderLabel} API key was rejected. Check it in Settings. | `settings` |
| `byok_misconfigured` | Your AI model or key isn't set up correctly. Fix it in Settings. | `settings` |
| `provider_overloaded` | The AI provider is busy right now. Try again in a moment. | `retry` |
| `rate_limited` | You're sending messages too fast. Wait a few seconds and try again. | `wait` (surface Retry-After when known; plain text, no live countdown — D4) |
| `internal` | Something went wrong generating a response. Try again. | `retry` |

`{ProviderLabel}` comes from the payload `provider` via a client label map
(`{ anthropic: 'Anthropic', google: 'Gemini', openai: 'OpenAI', zai: 'z.ai', openrouter: 'OpenRouter' }`) —
NOT from any client-side inference of what mode was active (FR-008/FR-014). Unknown provider ⇒
"your provider".

### `FATAL_CODES` — Set

`{ app_usage_limit, byok_insufficient_credits, byok_invalid_key, byok_misconfigured, rate_limited, provider_overloaded }`
(everything except `internal`). Fatal ⇒ render banner immediately, bypass reconnect-recovery
(FR-015).

### `RETRYABLE_CODES` — Set

`{ internal, provider_overloaded }` — only these render a Retry button (D4). Others show their
fixing action; the composer stays enabled for every code (D4/FR-018).

### `parseChatError(errorOrPayload) → { code, provider, text }`

- Reads the structured payload from an HTTP JSON body or the SSE `error` event.
- Unknown code, or a payload with no code ⇒ falls back to `internal` rendering, showing the
  payload's `error`/`errorText` string when present (FR-013).
- Never inspects free text to pick a code.

## Recovery behavior contract (AiChatContext)

1. **Fatality gate** — `handleChatError` reads `code`; if `code ∈ FATAL_CODES` it renders the
   banner and does NOT call `recoverChat`. Only `internal` / client-network enter the existing
   reconnect-recovery path (FR-015). No `msg.includes(...)` anywhere.
2. **App-auth (401)** — keyed on **response status 401**, not body text (FR-005/D7): silent
   `refreshAccessToken` + resend, unchanged. Never renders a taxonomy banner.
3. **Derived usage-limit** — the send path clears the usage-limit state before each attempt;
   an `app_usage_limit` rejection re-sets it (FR-017). No permanent latch.
4. **Interruption notice** — when recovery finds a persisted partial reply but the trigger was
   a fatal code, keep a session-scoped "response interrupted: <reason>" notice beside the
   partial reply instead of clearing the error (FR-016/D5).
5. **Draft restoration** — on any fatal-code rejection, restore the composed text + attachments
   to the composer; composer stays usable (FR-018).
6. **Per-instance isolation** — an error on one chat instance must not bleed into another
   (existing per-id instance model preserved).
