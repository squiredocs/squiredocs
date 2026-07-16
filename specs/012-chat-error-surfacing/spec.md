# Feature Specification: Chat Error Surfacing Overhaul

**Feature Branch**: `012-chat-error-surfacing` (identifier only — solo trunk workflow, work happens on `main`)

**Created**: 2026-07-16

**Status**: Draft

**Input**: User description: "Chat error surfacing overhaul — classify every chat failure once, server-side, into a typed taxonomy; deliver it as a structured `{ error, code, provider? }` payload on both transport channels (HTTP JSON pre-stream, SSE error event mid-stream) with honest status codes; render user messages from a single code→message map shared by the side panel and full-page chat; fatal codes skip reconnect-recovery; usage-limit state is derived, not latched; BYOK misconfiguration fails loudly instead of silently billing the operator; notification hygiene (BYOK billing problems never page the operator, shared-key exhaustion does)."

**Design ground truth**: `design/in-app-ai-assistant.md`, section "Error surfacing" (constitution Principle VI — the design doc wins over code and priors). Decisions the design doc left open are recorded as RATIFIED-BY-DEFAULT in `specs/012-chat-error-surfacing/clarifications-needed.md`.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Every chat failure shows a specific, honest, actionable message (Priority: P1)

A user whose chat turn fails — for any reason, before or during streaming — sees a message that says what actually went wrong and what fixes it. They never see a generic "Something went wrong", a raw provider error body, or a fake success. The same failure produces the identical message in the side panel and the full-page chat.

**Why this priority**: This is the core of the feature. Today most provider failures collapse into a 500 "Internal server error" and a generic banner; a BYOK user with an empty provider wallet is told the app is broken. Everything else in this feature builds on the classified code reaching the client.

**Independent Test**: Induce each failure class (exhausted in-app credits, BYOK provider account out of funds, revoked BYOK key, provider overload, per-user rate limit, unclassifiable error) and verify each renders its own distinct, actionable message — identical in both chat surfaces — with no raw provider text visible anywhere.

**Acceptance Scenarios**:

1. **Given** a non-BYOK user whose monthly in-app credits are exhausted, **When** they send a chat message, **Then** the request is rejected pre-flight with the `app_usage_limit` code and an honest payment-required-class status (not an internal-error status), and the chat shows the usage-limit banner with a link to view usage.
2. **Given** a BYOK user whose own provider account is out of funds (e.g. Anthropic "credit balance is too low", OpenAI insufficient_quota, Google RESOURCE_EXHAUSTED), **When** they send a message, **Then** they see a `byok_insufficient_credits` message telling them to top up in their provider's console, with the provider name taken from the structured payload — not inferred client-side.
3. **Given** a BYOK user whose stored key has been revoked or is invalid (provider rejects with an auth error), **When** they send a message, **Then** they see a `byok_invalid_key` message directing them to check their key in Settings.
4. **Given** the model provider is overloaded or unavailable (on any key), **When** a chat turn fails for that reason, **Then** the user sees a `provider_overloaded` message advising them to try again shortly.
5. **Given** a user who trips the app's per-user request rate limiter, **When** their chat request is rejected, **Then** they see a `rate_limited` message advising them to wait — clearly distinct from the usage-limit message (today both are 429s distinguished only by body text).
6. **Given** a failure that matches no known class, **When** the turn fails, **Then** the user sees the generic `internal` message with a retry affordance, and the operator is notified.
7. **Given** the same failure occurs in the side panel and in the full-page chat, **Then** both render the identical message text from the same code→message map (today the full-page chat renders no specific error message at all).
8. **Given** a failure that occurs mid-stream (after content has started flowing), **When** the stream errors, **Then** the same structured payload arrives over the stream's error channel and renders the same message as the pre-stream case.

---

### User Story 2 - Fatal errors end the turn honestly; interruptions stay visible (Priority: P2)

When a chat turn dies of a billing, key, or rate-limit problem, the user is told immediately — the client does not spin on "Reconnecting…" for an empty wallet. And when a mid-stream fatal error leaves behind a partially persisted reply, the transcript keeps a visible "response interrupted" notice with the reason, so a truncated answer is never presented as complete.

**Why this priority**: The recovery path currently masks fatal errors two ways: fatal codes enter reconnect-recovery (fake "Reconnecting…"), and when recovery finds a persisted partial reply it clears the error unconditionally, silently passing off a truncated answer as finished.

**Independent Test**: Induce a fatal failure (a) pre-stream and (b) mid-stream after partial content has persisted. Verify (a) goes straight to the specific banner with no reconnect attempt, and (b) shows the partial reply plus an interruption notice naming the reason.

**Acceptance Scenarios**:

1. **Given** a chat turn fails with a fatal code (billing, key, misconfiguration, or rate-limit class), **When** the client handles the error, **Then** it renders the code's banner immediately and never enters the reconnect-recovery path.
2. **Given** only `internal` or client-network failures, **When** the client handles the error, **Then** the existing reconnect-recovery path may run as today.
3. **Given** a mid-stream fatal error where recovery finds a persisted partial assistant reply, **When** recovery completes, **Then** the partial reply is shown together with a "response interrupted: \<reason\>" notice instead of the error being cleared unconditionally.
4. **Given** a mid-stream error on a live stream, **Then** the error is still never written into the reconnection replay buffer (a reconnecting client must not have the error replayed at it).

---

### User Story 3 - Usage-limit state recovers without a page reload (Priority: P2)

A user who hit the monthly in-app usage limit and then fixed it — credits topped up by the admin, BYOK enabled, or the month rolled over — can simply send another message and chat works. The limit banner is re-derived on each send attempt, re-appearing immediately if the limit is still in force.

**Why this priority**: Today the limit flag latches forever once set; even a legitimate fix strands the user behind a stale banner until they reload. It undermines the honesty of every other message.

**Independent Test**: Trip the usage limit, verify the banner; raise the user's credit (or enable BYOK), send again without reloading; verify the message goes through and the banner is gone. Send again with the limit still in force; verify the banner returns.

**Acceptance Scenarios**:

1. **Given** the usage-limit banner is showing, **When** the user attempts another send, **Then** the banner state is cleared for the attempt and the message is sent to the server.
2. **Given** the limit is still in force server-side, **When** that send is rejected with `app_usage_limit`, **Then** the banner re-appears immediately.
3. **Given** the limit has been lifted (top-up, BYOK enabled, or month rollover), **When** the user sends, **Then** the turn succeeds with no reload required.

---

### User Story 4 - BYOK misconfiguration fails loudly, never bills the operator (Priority: P2)

A user who has BYOK enabled but whose key or selected model cannot be resolved gets an explicit `byok_misconfigured` rejection telling them to fix their settings. The request never silently falls back to the shared server key.

**Why this priority**: The silent fallback is both a UX lie (the user believes their key is in use) and an unmetered operator cost: the request runs on the server key while still flagged as BYOK, so it bypasses credit metering entirely.

**Independent Test**: Enable BYOK, then corrupt the stored state (unknown model key, or key that fails to resolve). Send a message; verify a `byok_misconfigured` rejection, verify no request went out on the shared server key, and verify no unmetered usage was recorded.

**Acceptance Scenarios**:

1. **Given** BYOK is enabled but the selected model key is unknown or the stored key cannot be resolved, **When** the user sends a chat message, **Then** the request is rejected with `byok_misconfigured` and a message directing them to Settings.
2. **Given** that rejection, **Then** no chat request is made with the shared server key and no operator-billed usage occurs.
3. **Given** BYOK resolves correctly, **Then** behavior is unchanged.

---

### User Story 5 - Operator notifications match fault ownership (Priority: P3)

The operator is paged for server faults, not for users' billing problems. BYOK billing/key errors never trigger the exception notifier; the per-user-per-month admin email for `app_usage_limit` is kept; exhaustion of the shared server key is treated as an operator incident — the operator is notified while the user still sees a classified, non-alarming message.

**Why this priority**: Alert hygiene — valuable, but it protects the operator's attention rather than the user experience, and depends on classification (US1) existing.

**Independent Test**: Induce a BYOK billing failure and verify no exception notification is sent; trip the in-app quota and verify the admin email still goes out (once per user per month); simulate shared-server-key exhaustion and verify the operator is notified while the user sees a classified message.

**Acceptance Scenarios**:

1. **Given** a chat failure classified as `byok_insufficient_credits` or `byok_invalid_key`, **Then** no operator exception notification is sent.
2. **Given** a pre-flight `app_usage_limit` rejection, **Then** the existing admin credit-limit email behavior (per user, per month) is preserved.
3. **Given** the shared server key's provider account is exhausted, **Then** the operator is notified with the true cause, and the user sees a classified message (see clarifications ledger D3), not a raw error or generic 500.
4. **Given** an `internal` classification, **Then** the exception notifier fires as today.

---

### Edge Cases

- **Token-limit errors must stay invisible**: they are explicitly outside the taxonomy — the existing compaction-and-retry flow keeps handling them with no user-visible error. Classification must not intercept them.
- **The app's own auth failures stay out of the taxonomy**: the client's silent token-refresh-and-retry on the app's 401 responses is unchanged, and must be keyed on the response status, not body-text sniffing (ledger D7).
- **Deploy skew / degraded clients**: the payload keeps a human-readable `error` string alongside `code`, so a client that doesn't know a code can still show honest text (ledger D6).
- **Reconnection replay**: mid-stream error events continue to be excluded from the replay buffer; a reconnecting client must never have a stale error replayed at it.
- **Draft chat with no server row**: a fatal error on the unsaved draft chat (which cannot be recovered from the server) must still render the classified banner and restore the user's draft text.
- **Same condition, different providers**: the same underlying condition reported differently per provider (e.g. out-of-funds as a 400 vs 429 vs RESOURCE_EXHAUSTED) must classify to the same code; per-provider detection knowledge lives in the provider registry (constitution: provider knowledge lives in one place).
- **Concurrent failure + success**: an error banner belonging to one chat must not bleed into another chat instance's transcript (the context manages multiple chat instances).
- **Retry affordances differ by code**: retry is offered only where retrying can help (`internal`, `provider_overloaded`); billing/key/misconfiguration banners point at the fixing action instead; the composer stays usable for all codes (ledger D4).

## Requirements *(mandatory)*

### Functional Requirements

**Classification (server-side, single point)**

- **FR-001**: The system MUST classify every chat-turn failure exactly once, server-side, adjacent to the provider call, into one of the typed codes: `app_usage_limit`, `byok_insufficient_credits`, `byok_invalid_key`, `provider_overloaded`, `rate_limited`, `byok_misconfigured`, `internal`. No other component may re-classify or re-interpret the failure.
- **FR-002**: Classification MUST cover at minimum: in-app monthly credit exhaustion (pre-flight) → `app_usage_limit`; the user's own provider account out of funds (Anthropic "credit balance is too low", OpenAI insufficient_quota, Google RESOURCE_EXHAUSTED) → `byok_insufficient_credits`; provider auth rejection (401/403) on a user key → `byok_invalid_key`; provider overload/unavailability (429/529/503-class) on any key → `provider_overloaded`; the app's per-user request limiter → `rate_limited`; BYOK enabled but key/model unresolvable → `byok_misconfigured`; everything else → `internal`.
- **FR-003**: Per-provider error-detection knowledge (which provider responses mean which code) MUST live in the AI provider registry alongside the rest of each provider's knowledge, not inline in the chat endpoint.
- **FR-004**: Token-limit errors MUST remain outside the taxonomy: the existing compaction-and-retry flow handles them with no user-visible error surfaced.
- **FR-005**: The app's own authentication failures (expired/invalid app session) MUST remain outside the taxonomy; the client's existing token-refresh-and-retry behavior is preserved and keyed on response status, not response-body text.

**Transport (one shape, two channels)**

- **FR-006**: Failures occurring before any content has streamed MUST be returned as HTTP JSON `{ error, code, provider? }` with an honest status per the mapping ratified in the clarifications ledger (D2): `app_usage_limit` and `byok_insufficient_credits` → 402; `byok_invalid_key` and `byok_misconfigured` → 400; `rate_limited` and `provider_overloaded` → 429 (with Retry-After when known); `internal` → 500. Classified non-internal failures MUST NOT be returned as 500.
- **FR-007**: Failures occurring mid-stream MUST be delivered on the SSE error event carrying the same structured `{ error, code, provider? }` payload — never raw provider error text.
- **FR-008**: The `provider` field MUST be populated whenever the failure is attributable to a specific provider, and is the client's only source for naming the provider in messages.
- **FR-009**: The human-readable `error` string MUST always accompany `code`, honest and free of raw provider internals, so degraded or older clients can still show truthful text.
- **FR-010**: Mid-stream error events MUST continue to be excluded from the stream reconnection replay buffer.

**Client rendering (one source)**

- **FR-011**: The client MUST render error messages from a single code→message map, shared by the side panel and the full-page chat; the two surfaces MUST produce identical text for identical codes.
- **FR-012**: The map MUST give each code a specific, actionable message: `app_usage_limit` → limit reached + link to view usage; `byok_insufficient_credits` → top up in the (named) provider's console; `byok_invalid_key` → check the key in Settings; `byok_misconfigured` → fix model/key in Settings; `provider_overloaded` → provider busy, try again shortly; `rate_limited` → sending too fast, wait; `internal` → generic failure + retry. (Reference copy; final microcopy per ledger D1.)
- **FR-013**: The client MUST NOT determine error kind by substring-matching error bodies anywhere in chat error handling; the structured `code` is the sole discriminator. Unknown codes and payloads without a code fall back to the `internal` rendering (showing the payload's `error` text when present).
- **FR-014**: The full-page chat MUST display the classified error message (it currently renders no specific error text), and the mode-snapshot heuristic that infers provider/BYOK state at error time MUST be removed in favor of the payload's `provider` field.

**Recovery behavior**

- **FR-015**: Fatal codes — `app_usage_limit`, `byok_insufficient_credits`, `byok_invalid_key`, `byok_misconfigured`, `rate_limited`, `provider_overloaded` — MUST bypass the reconnect-recovery path entirely and render their banner immediately. Only `internal` and client-side network failures may enter reconnect-recovery.
- **FR-016**: When recovery of a mid-stream fatal error finds a persisted partial assistant reply, the client MUST keep a visible "response interrupted: \<reason\>" notice (reason derived from the code's message) alongside the partial reply instead of clearing the error unconditionally. (Session-scoped notice per ledger D5.)
- **FR-017**: Usage-limit state MUST be derived, not latched: the next send attempt clears it (re-tripping immediately via a fresh `app_usage_limit` rejection if still in force). Top-up, enabling BYOK, or month rollover MUST NOT require a page reload to resume chatting.
- **FR-018**: On any fatal-code rejection, the user's composed message (text and attachments) MUST be restored to the composer so nothing typed is lost, and the composer MUST remain usable.

**BYOK misconfiguration**

- **FR-019**: When BYOK is enabled but the key or model cannot be resolved, the request MUST be rejected with `byok_misconfigured` before any provider call; it MUST NOT fall back to the shared server key. (Non-BYOK shared-default resolution fallbacks are unchanged.)

**Operator notifications**

- **FR-020**: Failures classified as `byok_insufficient_credits` or `byok_invalid_key` MUST NOT trigger the operator exception notifier.
- **FR-021**: The existing per-user-per-month admin email on `app_usage_limit` MUST be preserved.
- **FR-022**: Exhaustion of the shared server key's provider account MUST notify the operator with the true cause while the user receives a classified message (surfaced as `provider_overloaded` per ledger D3).
- **FR-023**: `internal` classifications MUST continue to trigger the operator exception notifier as today.

### Key Entities

- **Error code**: one of the seven taxonomy members; assigned exactly once, server-side; determines message, HTTP status, fatality (recovery eligibility), and notification behavior.
- **Structured error payload**: `{ error, code, provider? }` — the single shape traveling on both channels (HTTP JSON pre-stream, SSE error event mid-stream). `error` is honest human-readable text; `provider` names the provider when attributable.
- **Code→message map**: the client's single source of user-facing error copy, consumed identically by the side panel and the full-page chat; also drives which codes offer retry vs. a fixing action.
- **Fatality class**: fatal (all codes except `internal`) vs. recoverable (`internal`, network) — controls whether reconnect-recovery may run.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: Inducing each of the seven failure classes produces its own distinct, actionable message in the chat UI; zero raw provider error text and zero generic "Internal server error" responses for classified non-internal failures.
- **SC-002**: The side panel and the full-page chat display identical message text for 100% of error codes.
- **SC-003**: A user whose usage limit is lifted (top-up, BYOK enablement, or month rollover) resumes chatting with zero page reloads.
- **SC-004**: Zero operator exception notifications from BYOK billing or BYOK key failures; 100% of shared-key exhaustion and internal failures still notify.
- **SC-005**: 100% of mid-stream fatal errors that leave a partial reply show a visible interruption notice in the live session; no truncated reply is presented as complete.
- **SC-006**: With BYOK misconfigured, zero chat requests reach the shared server key and zero unmetered operator-billed usage is recorded.
- **SC-007**: No client code path decides error handling by matching error body text (verifiable by inspection/tests of chat error handling).
- **SC-008**: Token-limit compaction behavior is unchanged: long-context turns still complete without any user-visible error.

## Assumptions

- All open product decisions were resolved by best default and recorded as RATIFIED-BY-DEFAULT (Sam pre-authorized, 2026-07-16) in `specs/012-chat-error-surfacing/clarifications-needed.md`: D1 message copy, D2 HTTP status mapping, D3 shared-key exhaustion surfacing, D4 retry affordances, D5 interruption-notice persistence, D6 deploy-skew compatibility, D7 app-auth errors out of taxonomy.
- Server and client ship together in one deploy (solo trunk-based workflow), so no payload versioning or negotiation is needed; the honest `error` string covers transient skew (D6).
- The existing streaming/resumable-stream architecture (background buffering, replay, persistence of partial replies) is retained; this feature changes what travels on the error channel and how the client reacts, not the streaming machinery itself.
- Existing consumers of the chat endpoint are the app's own two chat surfaces; no external API contract documents the current error bodies, so changing status codes and bodies is safe.
- The per-user rate limiter's uniform 429 body for non-chat endpoints is out of scope; only chat-turn failures adopt the structured payload.
- Message copy is English-only, consistent with the rest of the product UI.
- Per Principle II, every behavioral change above lands with tests (backend suites for classification/status/notification behavior; frontend suites for the shared map, latch removal, and recovery gating).
