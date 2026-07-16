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

## Channel B — Mid-stream (SSE error event)

Failure after content started → the SSE `error` event carries the structured fields:

```
data: { "type": "error", "errorText": "<honest string>", "code": "<taxonomy>", "provider": "<id>?" }
```

Rules:
- `errorText` == the payload's `error` string (degraded clients still show honest text — D6).
- The error event MUST NOT be appended to the reconnection replay buffer (`entry.chunks`) —
  preserved from today's `pipeAsSSE` behavior (FR-010).
- Token-limit error chunks are intercepted *before* classification (compaction/retry, FR-004)
  and never become a taxonomy payload.

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
