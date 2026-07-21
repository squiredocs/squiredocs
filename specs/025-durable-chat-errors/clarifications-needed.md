# Clarifications & Recorded Decisions — 025-durable-chat-errors

No user interaction was available during specification. Per Constitution Principle VI
and Sam's pre-authorization (2026-07-21), each open product decision below was
resolved with the best default and recorded as RATIFIED-BY-DEFAULT — except D5, which
was ratified directly by Sam's feedback. Overturn any of these by amending the spec
before planning/implementation.

The core mechanism itself (persist classified failures in the transcript; render from
durable state only; no replayable buffer after failure; honest recovery) is NOT a
decision recorded here — it is design ground truth, amended into
`design/in-app-ai-assistant.md` ("Error surfacing") at commit `68f22df` and encoded
by the spec per Principle VI.

---

## D1 — Failure record content: `{ code, provider, at }` only, no error text (RATIFIED-BY-DEFAULT, Sam pre-authorized 2026-07-21)

**Question**: Should the persisted failure record carry the human-readable error
string alongside the taxonomy code (so old clients/future surfaces could show it
verbatim)?

**Why it matters**: Whatever is persisted lives in the transcript forever and is
returned on every chat load; persisted provider strings could leak raw provider
internals into durable storage and would drift from the maintained code→message map.

**Chosen default**: Persist exactly `{ code, provider, at }` (taxonomy code, provider
id when known, ISO timestamp of classification). Display copy is always re-derived
client-side from `client/src/utils/chatErrorMessages.js` (FR-003).

**Rationale**: Feature 012's core invariant is that the code is the sole
discriminator and raw provider text never reaches the client; persisting text would
create a second, stale copy channel and a potential leak. `at` is kept because it is
cheap, aids debugging/support, and lets future logic reason about staleness; nothing
in this feature renders it.

## D2 — Stamp durability: spec states the invariant, plan picks the mechanism (RATIFIED-BY-DEFAULT, Sam pre-authorized 2026-07-21)

**Question**: How should the stamp survive the write-ordering race with the turn's
final full-replace save (the stream-side `onFinish` → `saveChat` that persists a
partial reply and would clobber a separately-written stamp)?

**Why it matters**: If the stamp is written and then the final full-replace save
lands without it, the failure record is silently lost — recreating the original bug
at the persistence layer.

**Chosen default**: The spec mandates only the invariant (FR-004: after a failed
turn, the stored transcript contains the failure record, under any ordering) and
names both known-acceptable designs — folding the stamp into the same final save, or
ordering the stamp strictly after final persistence. The concrete mechanism is a
plan-time decision.

**Rationale**: This is exactly the design doc's altitude ("written at the single
server-side classification point, atomically with the turn's final save"); choosing
the mechanism now would encode implementation detail into the spec and pre-empt the
plan's analysis of the `toUIMessageStream onFinish` timing.

## D3 — Failures before the user message persists are live-event-only (RATIFIED-BY-DEFAULT, Sam pre-authorized 2026-07-21)

**Question**: What happens to failures that occur before the turn's user message is
saved — the per-user rate limiter, the per-user concurrent-stream cap, malformed
requests, and any failure on the not-yet-created draft chat (no server row)?

**Why it matters**: These failures have no transcript turn to stamp; pretending
otherwise would require persisting a user message the server deliberately rejected.

**Chosen default**: No stamp (FR-006). They surface through the live structured error
channel into the same durable client state and render identically in-session; they do
not survive a reload.

**Rationale**: A rejected-before-entry turn is not part of the conversation — the
composer draft is restored and the user still holds their message. Reload-loss is
correct here: there is nothing in the transcript to explain. Note the audited
reality: most classified early returns (usage limit, BYOK misconfig, unsupported
image) occur AFTER the user-message save at `server/api/chat.js:699` and therefore DO
get stamped; only the pre-save rejections listed above are live-event-only.

## D4 — Composer draft-restore behavior is preserved as-is (RATIFIED-BY-DEFAULT, Sam pre-authorized 2026-07-21)

**Question**: With pre-content failures now stamped into a persisted user message,
should the client still restore the composer draft on such failures (its "nothing was
persisted" assumption is false for post-save early returns — resending restored text
appends a second user message to the transcript)?

**Why it matters**: Changing draft-restore semantics changes what users see in the
composer after every failure class; the duplicate-user-turn wrinkle on resend
predates this feature.

**Chosen default**: Behavior unchanged (FR-010): pre-content failures restore the
draft; mid-stream failures (partial reply present) do not. The pre-existing
duplicate-on-resend wrinkle is explicitly out of scope.

**Rationale**: Sam's mandate is "keep behavior identical for the taxonomy
copy/actions"; draft restoration is adjacent user-visible behavior and silently
changing it would widen the diff and the test surface. The wrinkle is real but
independent — it deserves its own ticket, not a ride-along fix inside an
error-surfacing feature.

## D5 — Interruption notice becomes durable, superseding 012's D5 (RATIFIED by Sam's direct feedback, 2026-07-21 — NOT by default)

**Question**: Feature 012's D5 decided the mid-stream "response interrupted" notice
was session-only ephemeral state. This feature derives it from the persisted failure
record, making it permanent. Is overturning a previously-ratified decision
authorized?

**Why it matters**: 012's D5 was a ratified product decision; superseding it needs
explicit authority, not a default.

**Decision**: Superseded. The notice is now derived from the persisted failure record
and appears on every later load (US5, FR-009/FR-010, SC-006).

**Rationale**: Sam's bug report falsified the premise of the session-only notice — a
notice that dies with the session hides real truncation, which is exactly the class
of silent failure that prompted this feature. The design doc amendment (`68f22df`)
records the supersession in ground truth ("Supersedes the earlier session-only
notice: a notice that dies with the session hides real truncation"). Recorded here as
ratified by Sam's direct feedback of 2026-07-21, not by default.

## D6 — Unknown persisted codes render the generic internal copy (RATIFIED-BY-DEFAULT, Sam pre-authorized 2026-07-21)

**Question**: How should the client render a persisted failure record whose code it
does not recognize (e.g. a transcript stamped by a newer server version, or a future
taxonomy addition)?

**Why it matters**: Persisted records outlive client versions; an unhandled unknown
code could crash the banner derivation or leak raw data.

**Chosen default**: Fall back to the `internal` copy (the existing `parseChatError`
unknown-code behavior), never raw text, never no-banner.

**Rationale**: Matches 012's established fallback semantics exactly; a failed turn
with an unknown reason is still a failed turn, and "Something went wrong… Try again"
is the honest floor. No-banner would recreate the silent-failure bug for future
codes.

## D7 — "Reconnecting…" stays a separate transient flag, subordinate to the banner (RATIFIED-BY-DEFAULT, Sam pre-authorized 2026-07-21)

**Question**: The consolidation target is "one durable state"; is the reconnecting
indicator part of that state or a second piece of state — and which wins when both
are active?

**Why it matters**: The current UI gives the reconnecting indicator precedence over
the error banner (`AiChatBody.jsx` branch order), which is one of the ways a failure
gets visually masked.

**Chosen default**: The reconnecting indicator remains a separate, transient,
per-chat flag (it describes an in-progress client action, not a turn outcome) — the
explicitly permitted second piece of state ("one durable state + reconnecting flag",
SC-005). It may only ever be shown for non-fatal recovery attempts, and it MUST NOT
suppress a durable failure banner once the attempt concludes without a reply landing
(FR-009/FR-012).

**Rationale**: Folding a progress indicator into an outcome record would conflate two
different kinds of truth and force artificial state transitions. Precedence while an
attempt is genuinely in flight is acceptable (the client is actively doing the thing
the banner would tell the user about); what was broken — and is now forbidden — is
the attempt ending in false success and the banner never returning.

## D8 — Realistic-SDK regression tests; double-vs-real-Chat left to plan (RATIFIED-BY-DEFAULT, Sam pre-authorized 2026-07-21)

**Question**: The existing `AiChatContext` tests fully mock the AI SDK — which is how
this bug shipped (the mock never modeled resume clearing error state). Must the new
tests use the real SDK `Chat` class, or is a higher-fidelity mock acceptable?

**Why it matters**: A mock that again fails to model the SDK's real transitions would
certify the fix against the wrong machine and let a regression through unnoticed.

**Chosen default**: The spec mandates outcomes and the fidelity bar (FR-017): the
banner-persistence scenarios must run against the SDK's actual observed transitions —
resume flips error→submitted with error cleared, clean replay ends at 'ready' — via
either a test double that faithfully models those flips or the real `Chat` class
driven by a scripted transport. The choice between the two is deferred to plan.

**Rationale**: The requirement that matters is behavioral fidelity, not a specific
harness. The real-`Chat` option is the stronger guarantee (immune to the mock
re-drifting) but has setup costs the plan is better placed to weigh; either satisfies
the spec if the mandated transition scenarios are covered.
