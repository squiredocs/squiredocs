# Phase 1 Data Model: Chat Error Surfacing Overhaul (012)

No persistent (database) entities are added or changed — see research R8. These are the
**in-memory / on-the-wire** entities the feature introduces.

## Entity: Taxonomy code

The single discriminator. Exactly seven members; assigned once, server-side.

| code | trigger | fatal? | retryable? | HTTP status (D2) | pages operator? |
|---|---|---|---|---|---|
| `app_usage_limit` | in-app monthly credits exhausted (pre-flight quota) | yes | no | 402 | admin email only (per user/month) |
| `byok_insufficient_credits` | user's own provider account out of funds | yes | no | 402 | no |
| `byok_invalid_key` | provider 401/403 on a user key | yes | no | 400 | no |
| `byok_misconfigured` | BYOK on, key/model unresolvable | yes | no | 400 | no |
| `rate_limited` | app per-user request limiter | yes | no (wait) | 429 + Retry-After | no |
| `provider_overloaded` | 429/529/503 on any key; **also** shared-key exhaustion (D3) | yes | yes | 429 + Retry-After when known | shared-key exhaustion: yes; plain overload: no |
| `internal` | everything else / unclassifiable | no | yes | 500 | yes (exception notifier) |

**Fatality** = every code except `internal` (and client-network failures, which have no code).
Fatality controls recovery eligibility (fatal ⇒ no reconnect-recovery). Retryable controls
whether the client renders a Retry button (D4) vs. a fixing-action affordance.

**Validation rules**:
- A classified non-`internal` failure MUST NOT be returned as HTTP 500 (FR-006).
- `byok_invalid_key` MUST NOT use 401/403 (would collide with the app's own auth-refresh
  path — D2/D7); it is a 400.
- Token-limit errors are NOT taxonomy members — they never reach `classify()` (FR-004).
- App-auth (expired app session) failures are NOT taxonomy members — handled by status-keyed
  refresh-retry (FR-005/D7).

## Entity: Structured error payload

The one shape on both channels.

```jsonc
{
  "error":    "string",   // honest, human-readable, free of raw provider internals (FR-009). Always present.
  "code":     "string",   // one taxonomy member. Present on all classified failures.
  "provider": "string?"   // provider id (e.g. "anthropic") when the failure is provider-attributable (FR-008). Client's ONLY source for naming the provider.
}
```

- **Pre-stream channel**: HTTP response body, with the status from the table above; `Retry-After`
  header set for `rate_limited` and for `provider_overloaded` when the provider supplied one.
- **Mid-stream channel**: the SSE `error` event — `{ type: "error", errorText, code, provider? }`
  where `errorText` carries the same honest string as `error`. Excluded from the reconnection
  replay buffer (FR-010).
- `provider` is populated for `byok_insufficient_credits`, `byok_invalid_key`,
  `provider_overloaded`, `byok_misconfigured` (when the provider is known). Absent for
  `app_usage_limit`, `rate_limited`, and provider-agnostic `internal`.

## Entity: Code→message map (client)

Single source of user-facing copy. One entry per code:

```jsonc
{
  "<code>": {
    "text":   "string",              // D1 reference copy; may interpolate provider label
    "action": "retry" | "usage" | "settings" | "wait" | null
  }
}
```

`action` drives the affordance: `retry` (button) only for `internal`/`provider_overloaded`;
`usage` (View Usage link) for `app_usage_limit`; `settings` (Settings link) for
`byok_invalid_key`/`byok_misconfigured`; `wait` (Retry-After guidance, plain text) for
`rate_limited`; billing (`byok_insufficient_credits`) points at the provider console. See
[contracts/client-error-map.md](./contracts/error-payload.md).

## Entity: Interruption notice (session-scoped UI state)

Not persisted (D5). When mid-stream recovery finds a persisted partial assistant reply whose
triggering error was a fatal code, the client holds `{ chatId, reason }` in session memory so
the transcript shows "response interrupted: <reason>" next to the partial reply. Reason text
derives from the code's message. Cleared on next successful turn / navigation; gone after a
reload (by design — D5).

## State transition: usage-limit banner (derived, not latched)

```
[no banner] --send-->  (clear banner for the attempt)  --app_usage_limit rejection--> [banner]
[banner]    --send-->  (clear banner for the attempt)  --success------------------->  [no banner]
[banner]    --send-->  (clear banner for the attempt)  --app_usage_limit rejection--> [banner]
```

The banner is a function of the last send's outcome, never a sticky boolean (FR-017). Top-up /
BYOK-enable / month-rollover need no reload because the next send re-derives it.
