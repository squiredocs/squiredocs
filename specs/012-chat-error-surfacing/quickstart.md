# Quickstart / Validation Guide: Chat Error Surfacing (012)

Runnable validation that the feature works end-to-end. Backend tests are **serial-only**
against the shared DB (constitution II) — never launch concurrent backend runs.

## Prerequisites

- Dev runs in the Minikube `app-dev` pod (see `docs/dev.md`); run commands inside the pod.
- Backend suites: `server/__tests__/`, `server/api/__tests__/` (Vitest/Jest, serial).
- Frontend suites: `client/src/**/__tests__/` (Vitest).

## Automated validation

Backend (run serially):

```bash
# classification + status + notification
npx vitest run server/api/__tests__/chat-errors.test.js
npx vitest run server/api/__tests__/ai-providers.classify.test.js
npx vitest run server/api/__tests__/chat.error-surfacing.test.js
```

Frontend:

```bash
npx vitest run client/src/utils/__tests__/chatErrorMessages.test.js
npx vitest run client/src/contexts/__tests__/AiChatContext.errors.test.js
```

## Per-class manual validation (maps to SC-001 / SC-002)

Induce each failure and confirm a distinct, actionable, identical-across-surfaces message with
no raw provider text:

| Induce | Expect (both panel + `/chat`) | Status |
|---|---|---|
| Non-BYOK user, monthly credits exhausted | `app_usage_limit` banner + View Usage link; message sent pre-flight | HTTP 402 |
| BYOK key on a provider account out of funds (Anthropic "credit balance is too low" / OpenAI insufficient_quota / Google RESOURCE_EXHAUSTED) | `byok_insufficient_credits`, provider name from payload, "top up in <provider> console" | 402 (pre-stream) or SSE event (mid-stream) |
| BYOK key revoked/invalid | `byok_invalid_key`, "check key in Settings" | 400 |
| Provider overloaded (429/529/503) | `provider_overloaded`, "try again shortly" + Retry | 429 (+Retry-After) |
| Trip the per-user chat rate limiter | `rate_limited`, "wait" guidance — distinct from usage-limit | 429 (+Retry-After) |
| BYOK on, corrupt stored model/key | `byok_misconfigured`, "fix in Settings"; **no** request on shared key; **no** unmetered usage | 400 |
| Unclassifiable failure | `internal` generic + Retry; operator notified | 500 |

## Recovery / behavior validation

- **US2 fatal-no-reconnect (SC-005)**: fatal pre-stream error ⇒ banner immediately, never
  "Reconnecting…". Fatal mid-stream error leaving a persisted partial reply ⇒ partial reply +
  "response interrupted: <reason>" notice (session-scoped; gone after reload — D5).
- **US3 derived usage-limit (SC-003)**: trip limit → banner; raise credit / enable BYOK → send
  again *without reload* → succeeds, banner gone; send again with limit still in force → banner
  returns.
- **US4 loud misconfig (SC-006)**: with BYOK misconfigured, verify zero requests reach the
  shared server key and zero operator-billed usage recorded.
- **US5 notification ownership (SC-004)**: BYOK billing/key failures ⇒ zero exception
  notifications; `app_usage_limit` ⇒ admin email still fires (per user/month); shared-key
  exhaustion ⇒ operator notified while user sees `provider_overloaded`.
- **Token-limit unchanged (SC-008)**: a long-context turn still completes via compaction with
  no user-visible error.
- **No body-sniffing (SC-007)**: grep the client chat error path — no `.includes(...)` on error
  text drives behavior; the app-401 refresh is keyed on status.

## References

- Payload + status + notification contract: [contracts/error-payload.md](./contracts/error-payload.md)
- Client map + recovery contract: [contracts/client-error-map.md](./contracts/client-error-map.md)
- Taxonomy + entities: [data-model.md](./data-model.md)
- Decisions: [clarifications-needed.md](./clarifications-needed.md) (D1–D7)
