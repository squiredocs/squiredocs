# Clarifications Ledger: Chat Error Surfacing Overhaul (012)

Decisions the design doc (`design/in-app-ai-assistant.md`, "Error surfacing") left open,
resolved by best default per constitution Principle VI. Each is **RATIFIED-BY-DEFAULT
(Sam pre-authorized, 2026-07-16)** — flag here, never block, never decide silently.
Overturning any of these later means amending the spec (and design doc if the mechanism
changes), not re-litigating in code.

---

## D1 — Canonical user-facing message copy per code

**Status**: RATIFIED-BY-DEFAULT (Sam pre-authorized, 2026-07-16)

**Question**: The design mandates specific, actionable banners per code but gives no copy. What exact text does each code render?

**Why it matters**: The copy is the user-visible product; two surfaces must render it identically, so it has to be pinned somewhere.

**Decision**: Spec FR-012 fixes reference copy (limit + usage link; top up in the named provider console; check key in Settings; fix model/key in Settings; provider busy, retry shortly; sending too fast, wait; generic + retry). Final microcopy may be polished at implementation without re-ratification as long as each message keeps its code's action ("the action that actually fixes it") and never leaks raw provider text. Tone follows the marketing-copy standard: honest but confident.

---

## D2 — HTTP status code per taxonomy code

**Status**: RATIFIED-BY-DEFAULT (Sam pre-authorized, 2026-07-16)

**Question**: The design requires an "honest status (402/429/4xx, not 500)" but doesn't map codes to statuses.

**Why it matters**: Statuses are observable contract (client transport, logs, any future consumer); ambiguity here would leak into implementation.

**Decision**:

| code | status |
|---|---|
| `app_usage_limit` | 402 |
| `byok_insufficient_credits` | 402 |
| `byok_invalid_key` | 400 |
| `byok_misconfigured` | 400 |
| `rate_limited` | 429 (+ `Retry-After` when known) |
| `provider_overloaded` | 429 (+ `Retry-After` when the provider supplied one) |
| `internal` | 500 |

**Rationale**: 402 is the honest "payment required" for both billing exhaustions (note: `app_usage_limit` moves from today's 429, which currently collides with the rate limiter and forces body-sniffing). `byok_invalid_key` must NOT be 401/403 — the app's own 401 drives the client's silent token-refresh retry, and a provider key problem is a bad request against our API, not an app-auth failure. `provider_overloaded` stays in 4xx per the design's explicit "402/429/4xx, not 500" list; 429 matches the dominant upstream signal and carries Retry-After. `internal` keeps 500 — a genuine server fault is the one place 500 is honest.

---

## D3 — Which code surfaces shared-server-key billing exhaustion to the user

**Status**: RATIFIED-BY-DEFAULT (Sam pre-authorized, 2026-07-16)

**Question**: The design says shared-key exhaustion is "classified for the user like any provider billing error, but it does notify" — yet the taxonomy's only billing codes are `byok_*`, and their remedy ("top up in your provider console") is wrong for a user on the shared key. Which code does that user see?

**Why it matters**: Directly determines what a shared-key user is told during an operator billing incident; the taxonomy is fixed at seven codes, so one of them must carry this case.

**Decision**: Surface it as `provider_overloaded`. The user-side remedy is genuinely "try again later" (the operator has been notified and will fix billing); the user is never told to top up an account they don't have, and never sees a raw error or generic 500. The operator notification carries the true cause (billing exhaustion, not overload). Adding an eighth code was rejected because the design doc fixes the taxonomy; if Sam prefers a dedicated code (e.g. `service_billing`), that's a design-doc amendment first.

---

## D4 — Retry affordances per code

**Status**: RATIFIED-BY-DEFAULT (Sam pre-authorized, 2026-07-16)

**Question**: Which error banners offer a Retry button?

**Why it matters**: A Retry button on an empty-wallet error is the same dishonesty the feature exists to remove.

**Decision**: Retry button only where retrying can plausibly succeed unchanged: `internal` and `provider_overloaded` (and client-network failures). `rate_limited` shows wait guidance (surfacing the Retry-After delay when known — plain text, no live countdown). Billing/key/misconfiguration banners show the fixing action (usage link / Settings) instead of Retry. The composer stays enabled for every code — required anyway by the derived (non-latched) usage-limit behavior, and lets the user resend manually after fixing anything.

---

## D5 — Persistence of the "response interrupted" notice

**Status**: RATIFIED-BY-DEFAULT (Sam pre-authorized, 2026-07-16)

**Question**: When a mid-stream fatal error leaves a persisted partial reply, is the "response interrupted: \<reason\>" notice persisted in the chat transcript (server-side) or session-only UI state?

**Why it matters**: Persisting it would change the stored message shape and affect every future load of that chat; session-only means a reload shows the partial reply without the notice.

**Decision**: Session-scoped client state, not persisted to the chat store. The design's stated purpose is that "a truncated answer must be visibly truncated" at the moment recovery would otherwise silently clear the error — protecting the live session from a silent swallow. Persisting interruption markers into the transcript schema is a larger data-model change the design doesn't ask for; if truncation evidence should survive reloads, that's a design amendment.

---

## D6 — Deploy-skew / degraded-client compatibility

**Status**: RATIFIED-BY-DEFAULT (Sam pre-authorized, 2026-07-16)

**Question**: Do we need compatibility shims for old clients (which substring-match today's bodies) against the new server, or payload versioning?

**Why it matters**: `app_usage_limit` changes status (429→402) and body; an old client mid-deploy would no longer detect the usage limit specially.

**Decision**: No shims, no versioning. Server and client ship in the same commit/deploy (solo trunk workflow); skew is limited to browser tabs holding the old bundle for minutes. The always-present human-readable `error` string means even a stale client degrades to showing honest text in its generic banner. Unknown codes on the new client fall back to `internal` rendering, covering the reverse direction.

---

## D7 — The app's own auth errors stay outside the taxonomy

**Status**: RATIFIED-BY-DEFAULT (Sam pre-authorized, 2026-07-16)

**Question**: The design doesn't say where the app's own 401 (expired access token) fits — it's a chat-request failure but not a provider failure.

**Why it matters**: The client currently detects it by substring-sniffing the message ("401" / "expired token" / "unauthorized") — exactly the pattern this feature bans — and silently refreshes + retries.

**Decision**: App-auth failures remain outside the error taxonomy and keep their silent refresh-and-retry behavior; the client's detection moves from body-text sniffing to the response status (401), consistent with FR-013's "no substring matching" rule. They never render a taxonomy banner.

---

## D8 — Transport mechanism for status-bearing client errors (analyze H1)

**Status**: RATIFIED-BY-DEFAULT (Sam pre-authorized, 2026-07-16)

**Question**: `DefaultChatTransport` surfaces only the response *body* to `handleChatError`; FR-005/D7 key the app-auth path on HTTP status 401. How does the status reach the client error handler?

**Why it matters**: Without a mechanism, implementation is forced back to body-substring sniffing (banned by FR-013) or app-401s render a wrong `internal` banner instead of silently refreshing.

**Decision**: Pass a custom `fetch` to the `DefaultChatTransport` constructor that wraps global fetch and, on `!response.ok`, reads the body text and throws `Object.assign(new Error(bodyText), { status: response.status })`. `handleChatError` then keys the auth branch on `error.status === 401`, and `parseChatError` parses the JSON body for the taxonomy code. Mid-stream SSE errors carry no status; `parseChatError` accepts both shapes. Chosen over patching the SDK or reading transport internals: it is the SDK's own extension point, ~10 lines, and survives SDK upgrades.
