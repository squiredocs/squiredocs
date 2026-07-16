# Contract: Chat Error Payload & Transport (012)

The externally observable contract fixed by the design doc ("Error surfacing"). Consumers are
the app's own two chat surfaces only (no external API doc pins the current bodies — safe to
change; Assumptions in spec.md).

## Shape (both channels)

```jsonc
{ "error": "string", "code": "<taxonomy>", "provider": "<providerId>?" }
```

- `error` — always present; honest; no raw provider internals (FR-009).
- `code` — one of: `app_usage_limit` | `byok_insufficient_credits` | `byok_invalid_key` |
  `provider_overloaded` | `rate_limited` | `byok_misconfigured` | `internal`.
- `provider` — provider id when attributable (FR-008); the client's only provider-naming source.

## Channel A — Pre-stream (HTTP JSON)

Failure before any content has streamed → HTTP response with the D2 status:

| code | status | headers |
|---|---|---|
| `app_usage_limit` | 402 | — |
| `byok_insufficient_credits` | 402 | — |
| `byok_invalid_key` | 400 | — |
| `byok_misconfigured` | 400 | — |
| `rate_limited` | 429 | `Retry-After` (seconds) when known |
| `provider_overloaded` | 429 | `Retry-After` when provider supplied one |
| `internal` | 500 | — |

Rules:
- A classified non-`internal` failure MUST NOT be a 500 (FR-006).
- `byok_invalid_key` MUST NOT be 401/403 (reserves those for the app's own session-refresh path).
- The existing early returns become classified responses: quota-exhausted (today `429 {"error":"AI usage limit reached"}`) → **402 `app_usage_limit`**; model-unresolvable-because-BYOK → **400 `byok_misconfigured`**; genuine "no model configured at all" → **500 `internal`**.

## Channel B — Mid-stream (SSE stream)

Failure after content started → the structured payload rides the SSE stream **adjacent to**
the AI SDK `error` event, as a transient data part immediately preceding it:

```
data: { "type": "data-chat-error", "data": { "code": "<taxonomy>", "provider": "<id>?" }, "transient": true }

data: { "type": "error", "errorText": "<honest string>" }
```

**Why a separate data part (D9, implementation-discovered).** AI SDK v6's UI-message-stream
error part is a `z.strictObject({ type, errorText })`, and `DefaultChatTransport` **throws** on
any chunk that fails schema validation. Emitting `code`/`provider` as *siblings* on the `error`
event (the literal shape first drafted here) would fail validation and break the whole stream.
The SDK's own extension point for structured side-band data is a `data-*` part (`data: unknown`),
delivered to the client `Chat`'s `onData` callback **before** `onError` fires, and — when
`transient: true` — never persisted into the message. So the client reads `{ code, provider }`
from the `data-chat-error` part and the honest `errorText` from the `error` event. This is a
wire-encoding refinement only; the design-doc intent ("mid-stream failures ride the SSE error
event with the same structured payload", client renders from the code, `errorText` stays honest)
is fully met. Recorded RATIFIED-BY-DEFAULT as D9 in the clarifications ledger.

Rules:
- `errorText` == the payload's `error` string (degraded clients that ignore the data part still
  show honest text — D6).
- **Neither** the `data-chat-error` part **nor** the `error` event is appended to the
  reconnection replay buffer (`entry.chunks`) — a resumeStream() replay must not re-trigger the
  client's onError (FR-010). Both are written directly to the live response.
- Token-limit error chunks are intercepted *before* classification (compaction/retry, FR-004)
  and never become a taxonomy payload or a `data-chat-error` part.

## Notification ownership (server-side, per US5)

| code | operator exception notifier | admin credit email |
|---|---|---|
| `app_usage_limit` | no | yes — preserved, per user/month (FR-021) |
| `byok_insufficient_credits` | no (FR-020) | no |
| `byok_invalid_key` | no (FR-020) | no |
| `provider_overloaded` (plain) | no | no |
| `provider_overloaded` (shared-key exhaustion) | **yes**, true cause (FR-022) | no |
| `internal` | yes (FR-023) | no |

## Classifier placement (constitution)

- Per-provider detection (which upstream shape → which signal) lives in `ai-providers.js`
  (`classifyError(err)` per PROVIDERS entry) — FR-003. No provider string literal in `chat.js`.
- The orchestrator (`server/api/chat-errors.js`) combines the registry signal with request
  context (`isByok` / shared-key) to pick the final code, status, and notification action —
  the single classification point (FR-001).
