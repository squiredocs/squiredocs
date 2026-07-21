# Feature Specification: Durable Chat Error Surfacing

**Feature Branch**: `025-durable-chat-errors`

**Created**: 2026-07-21

**Status**: Draft

**Input**: User description: "025-durable-chat-errors: durable chat error surfacing — persist classified turn failures in the transcript, render banners from durable state only"

## Background

**The bug (reported by Sam, verified by investigation).** When the system runs out of
shared credits, the chat error banner flashes and is then cleared — the user is left
staring at their own message with no agent response and no explanation. Four verified
root causes compound into this:

1. **The banner is gated on transient SDK state.** The classified banner renders only
   while the AI SDK reports `status === 'error' && error`
   (`client/src/components/AiChatBody.jsx:63`), even though a durable per-chat
   `errorInfoByChat` map already exists in `client/src/contexts/AiChatContext.jsx`.
   Anything that flips the SDK status hides the banner.
2. **The SDK clears error state on any resume.** In AI SDK v6 (`ai@6.0.141`),
   `makeRequest` sets `{status: 'submitted', error: undefined}` whenever a resume
   returns a stream, and a clean replay ends at `'ready'`. The app's
   `recoverChat`/`waitForEstablish` (`AiChatContext.jsx:47-61, 324-350`) counts
   status `'submitted'` as "established" (a false success), and its fallback comment
   assumes status stays `'error'` after a failed resume — an assumption the SDK
   falsifies.
3. **A failed turn leaves a clean-looking replay buffer.** The server deliberately
   omits error parts from the replay buffer (`server/api/chat.js:371-405`), and after
   a mid-stream failure `cleanupEntry(30_000)` leaves a 30-second window in which a
   reconnecting client replays a buffer with no trace of the failure.
4. **Deepest: failures are never persisted.** The user turn is saved before streaming
   (`server/api/chat.js:699`), so after a failure the database shows "user message, no
   reply" — indistinguishable from a turn still in flight. `errorInfoByChat`,
   `interruptedByChat`, and `usageLimitReached` are all ephemeral React state, so
   every reload or re-sync silently drops the error.

**Design ground truth.** The "Error surfacing" section of
`design/in-app-ai-assistant.md` was amended (commit `68f22df`) to establish the
principles this feature implements. Per Constitution Principle VI, this spec encodes
those principles; it does not re-litigate them:

- A failed turn is part of the transcript (the classified failure is persisted with
  the chat, stamped as metadata on the turn's trailing user message at the single
  server-side classification point, atomically with the turn's final save).
- Banners render from durable state only; transport/SDK stream status is never a
  render gate.
- A failed turn leaves no replayable buffer.
- Recovery counts as success only when an assistant reply actually lands.
- The mid-stream interruption notice is derived from the persisted failure record
  (superseding feature 012's session-only D5 notice, which Sam's bug report
  falsified — see the clarifications ledger, decision D5).

**Simplification mandate (Sam).** The client currently maintains four parallel error
states (SDK `status`/`error`, `errorInfoByChat`, `interruptedByChat`,
`usageLimitReached`). These consolidate into one durable per-chat turn-error state;
the usage-limit and interruption banners become derivations of it. The error
taxonomy, copy, and per-code actions (`client/src/utils/chatErrorMessages.js`) are
unchanged ground truth.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - A failed turn stays visibly failed (Priority: P1)

A user sends a chat message and the turn fails with a classified error (for example,
the shared credit pool is exhausted, or the provider is overloaded). The correct
banner for that error appears — and stays. No reconnect attempt, stream-state
transition, buffer replay, or background recovery cycle can make it vanish while the
failure remains unaddressed. The user always knows their turn failed and what to do
about it.

**Why this priority**: This is the reported bug. A silently swallowed failure is the
single worst outcome the error-surfacing design exists to prevent — the user believes
the assistant is ignoring them.

**Independent Test**: Force a classified failure (e.g. exhaust shared credits), send
a message, and observe the banner on both chat surfaces for 30+ seconds without
touching anything. Deliverable value: honest failure surfacing in the live session.

**Acceptance Scenarios**:

1. **Given** the shared credit pool is exhausted, **When** a non-BYOK user sends a
   message, **Then** the usage-limit banner appears and is still visible 30+ seconds
   later with no user action, in both the side panel and the full-page chat.
2. **Given** a turn that failed mid-stream with a classified provider error, **When**
   the client's automatic reconnect/resume machinery runs (including a resume that
   opens a connection and then yields nothing), **Then** the classified banner
   remains visible throughout — stream-state transitions never hide it.
3. **Given** a failed turn, **When** the user switches to another chat and back,
   **Then** the failed chat still shows its banner and the other chat shows none
   (error state is per-chat).

---

### User Story 2 - Failures survive reloads and re-syncs (Priority: P1)

A user whose turn failed reloads the page (or the transcript is re-fetched for any
reason — tab restore, cross-tab sync, background re-load). The failure banner
re-appears, derived from the saved conversation itself, because the failure is part
of the transcript.

**Why this priority**: Persistence is the root-cause fix. Without it every other
mitigation is cosmetic — any reload path re-manufactures the silent no-reply state.

**Independent Test**: Fail a turn, reload the page, observe the banner re-derived
from the loaded transcript with the same copy and action as before the reload.

**Acceptance Scenarios**:

1. **Given** a chat whose last turn failed with a classified error, **When** the user
   reloads the page and the chat loads from the server, **Then** the same classified
   banner (same copy, same action affordance) is shown, derived from the transcript.
2. **Given** a chat whose last turn failed, **When** the same chat is opened in a
   second tab or device, **Then** that surface also shows the failure banner.
3. **Given** a chat whose last turn failed and the client reconnects within what used
   to be the replay-buffer window, **When** the client asks the server for a
   resumable stream, **Then** it finds none (the entry was torn down on failure) and
   derives the turn's outcome — the failure — from the transcript instead.

---

### User Story 3 - Recovery is honest (Priority: P2)

When a turn fails with an error where reconnecting could genuinely help (an
`internal`/network-class failure), the client may attempt recovery — but recovery
only counts as success when an assistant reply actually lands: either a persisted
reply appears in the re-fetched transcript, or reply content is visibly streaming. A
resume that merely opens a connection, or replays a buffer that produces no reply, is
not recovery; the banner stays.

**Why this priority**: The false-success recovery path is the specific mechanism that
cleared the banner in the reported bug. Fixing surfacing without fixing recovery
semantics would leave the same hole open via the "Reconnecting…" path.

**Independent Test**: Simulate a failed turn followed by a resume that establishes a
connection but delivers no assistant content; verify the banner remains and the
"Reconnecting…" indicator ends without claiming success.

**Acceptance Scenarios**:

1. **Given** a turn that failed with an `internal` error, **When** recovery re-fetches
   the transcript and finds a complete assistant reply (the server had finished
   despite the client-side error), **Then** the reply is shown and no failure banner
   appears.
2. **Given** a failed turn, **When** a recovery attempt opens a stream connection but
   no assistant content ever arrives (no persisted reply, no streaming content),
   **Then** the failure banner is visible when the attempt concludes — regardless of
   what state the stream machinery ended in.
3. **Given** a fatal classified code (billing, key, rate-limit, usage-limit), **When**
   the failure is surfaced, **Then** no reconnect-recovery is attempted at all — the
   banner renders immediately with the action that actually fixes the problem.

---

### User Story 4 - The banner lifecycle is derived, not managed (Priority: P2)

The failure record needs no separate clean-up bookkeeping: the next send supersedes
it (the banner clears immediately; if the condition still holds, the new turn fails
and re-surfaces it), and an assistant reply landing for the chat neutralizes it. The
usage-limit banner behaves the same way — topping up, enabling BYOK, or a month
rollover never requires a reload.

**Why this priority**: Derived clearing is what keeps one durable state sufficient —
latched states that need explicit clearing are how the current four-way divergence
happened.

**Independent Test**: Fail a turn, then send a new message; verify the banner clears
on send and the new turn proceeds on its own merits.

**Acceptance Scenarios**:

1. **Given** a visible failure banner, **When** the user sends the next message,
   **Then** the banner clears immediately, and re-appears only if the new turn itself
   fails.
2. **Given** a visible failure banner on a chat, **When** an assistant reply lands
   for that chat (persisted, or visibly streaming content), **Then** the banner is
   neutralized without any explicit clearing write to the stored record.
3. **Given** a failed turn with a retryable code (`internal`,
   `provider_overloaded`), **When** the user clicks the banner's Retry, **Then** the
   last message is re-sent and the banner clears with the send (scenario 1 applies).

---

### User Story 5 - Truncated replies are visibly truncated, forever (Priority: P3)

When a classified failure interrupts a reply mid-stream, the partial reply renders
with a "response interrupted" notice carrying the reason — in the live session and on
every later load, because the notice is derived from the persisted failure record.

**Why this priority**: Supersedes 012's session-only notice (falsified by the bug
report — a notice that dies with the session hides real truncation). Lower priority
only because it rides entirely on the persistence machinery of stories 1-2.

**Independent Test**: Interrupt a streaming reply with a classified provider failure,
reload, and verify the partial reply still carries the interruption notice.

**Acceptance Scenarios**:

1. **Given** a reply interrupted mid-stream by a classified failure, **When** the
   user views the chat in the live session, **Then** the partial reply shows the
   interruption notice with the classified reason, plus the failure banner.
2. **Given** the same chat, **When** it is reloaded (any surface, any session),
   **Then** the interruption notice and banner re-appear, derived from the
   transcript.
3. **Given** an interrupted turn, **When** the user sends the next message, **Then**
   the interruption notice and banner clear (superseded), while the partial reply
   itself remains in the transcript.

---

### Edge Cases

- **Failure before the user message is persisted** (per-user rate limiter, per-user
  stream cap, malformed request): there is no transcript turn to stamp. The failure
  surfaces via the live error event into the same durable client state; it cannot
  survive a reload (nothing exists server-side), which is correct — the turn never
  entered the conversation, and the composer draft is restored (ledger D3/D4).
- **Failure on the not-yet-created draft chat** (no server row): same as above —
  live-event-only, keyed to the draft instance.
- **Server crashes without stamping** (process death mid-turn): the transcript shows
  a trailing user message with no failure record. No banner is fabricated; existing
  resume-or-nothing behavior applies. Honest limitation, recorded in Assumptions.
- **Stamp racing the turn's final save**: the turn's final message persistence uses
  full-replace semantics; whatever ordering occurs, the stored transcript after a
  failed turn MUST contain the failure record (FR-004 states the invariant; the
  mechanism is a plan-time choice, ledger D2).
- **Unknown/future code in a persisted record** (e.g. a transcript stamped by a newer
  server): render the generic `internal` copy, never raw text (ledger D6).
- **Legacy transcripts** written before this feature carry no failure metadata and
  MUST render exactly as they do today.
- **A later assistant reply after a stamped turn** (e.g. recovered via another tab):
  banner logic keys on the trailing failed turn only — a transcript whose trailing
  turn has a completed reply shows no banner regardless of older stamps.
- **Concurrent tabs**: a tab that loads or re-syncs the transcript derives the same
  banner state; no cross-tab error broadcast is needed or added.
- **`app_usage_limit` recovery paths** (top-up, BYOK enable, month rollover): next
  send clears the derived banner and the turn proceeds; no reload required.

## Requirements *(mandatory)*

### Functional Requirements

**Server — persisting the failure**

- **FR-001**: The system MUST persist every classified turn failure as a failure
  record — exactly `{ code, provider, at }` (taxonomy code, provider id when known,
  classification timestamp) — stored as metadata on the failed turn's trailing user
  message inside the chat's existing message data. No schema migration: the messages
  store is already schemaless JSONB with full-replace saves.
- **FR-002**: The failure record MUST be written at the single server-side
  classification point, covering both failure paths: pre-content failures (the
  classified early returns and the outer catch in `server/api/chat.js`) and
  mid-stream failures (the stream-error classification seam). A failure classified
  anywhere else MUST NOT produce a stamp.
- **FR-003**: The failure record MUST NOT contain raw provider error text or any
  free-form message — codes only; display copy is always re-derived client-side from
  the code→message map (ledger D1).
- **FR-004**: Stamp durability invariant: after a failed turn, the stored transcript
  MUST contain the failure record — regardless of the ordering between the stamp
  write and the turn's final full-replace message save (the save that persists a
  partial reply). Folding the stamp into that same save, or ordering the stamp after
  final persistence, are both acceptable designs; the spec mandates the invariant,
  not the mechanism (ledger D2).
- **FR-005**: On a classified failure the server MUST tear down the resumable-stream
  entry immediately. A reconnecting client MUST find no active stream (the "nothing
  live" response), never a replay of the failure-stripped buffer. The existing
  post-success replay window is unchanged.
- **FR-006**: Failures that occur before the turn's user message is persisted MUST
  NOT be stamped (there is no turn to stamp) and MUST continue to surface via the
  live structured error channel only (ledger D3).

**Client — one durable state, derived rendering**

- **FR-007**: The client MUST hold exactly one durable classified-error state per
  chat (the turn error), fed by two sources: (a) live structured error events for
  that chat, and (b) the failure record found on the loaded transcript's trailing
  turn. Loading or re-syncing a transcript whose trailing turn carries a failure
  record MUST populate this state.
- **FR-008**: Every error banner MUST render from the durable turn-error state only.
  Transport/SDK stream status MUST never gate rendering: no status transition
  (submitted, streaming, ready, error, or any future value), resume attempt, buffer
  replay, or recovery cycle may hide an unaddressed failure.
- **FR-009**: The four parallel client error states (SDK status/error as render gate,
  `errorInfoByChat`, `interruptedByChat`, `usageLimitReached`) MUST be consolidated:
  one durable per-chat turn-error state plus the transient "Reconnecting…" flag. The
  usage-limit banner MUST become a derivation of the turn error (code
  `app_usage_limit` on the active chat), and the interruption notice MUST become a
  derivation of the turn error plus the presence of partial assistant content after
  the stamped user message. The reconnecting flag MUST NOT be able to suppress a
  durable failure banner (ledger D7).
- **FR-010**: Banner derivation MUST key on the trailing turn only: a failure record
  produces a banner only while its user message begins the transcript's last turn.
  If partial assistant content follows the stamped message, the presentation is
  "interrupted partial reply" (notice + banner); if nothing follows, it is a plain
  failed turn (banner, and — live-session only — the restored composer draft,
  behavior unchanged, ledger D4). Older stamps deeper in the transcript are inert
  history.
- **FR-011**: The durable turn-error state MUST clear only when (a) the user sends
  the next message on that chat (superseded — it re-trips if the new turn fails), or
  (b) an assistant reply lands for that chat: a completed reply present in a
  (re)loaded transcript, or visibly streaming reply content. No stream-status
  transition may clear it. No explicit clearing write to the stored record is made —
  supersession and neutralization are read-side derivations.
- **FR-012**: Recovery (attempted only for non-fatal codes, unchanged) MUST count as
  success only when an assistant reply actually lands per FR-011(b). A resume that
  merely opens a connection, or reaches a "submitted"-style state without content, is
  not success. A failed recovery MUST leave the failure banner visible regardless of
  the SDK's final state.

**Unchanged behavior (guardrails)**

- **FR-013**: The error taxonomy, banner copy, per-code actions, and retry
  affordances (`RETRYABLE_CODES`) are unchanged ground truth
  (`client/src/utils/chatErrorMessages.js`). Both surfaces MUST keep rendering
  identical copy for identical codes from the shared map.
- **FR-014**: The app-auth 401 silent-refresh-and-resend path stays outside the
  taxonomy and MUST be unchanged.
- **FR-015**: Token-limit handling (compaction-and-retry) stays out of the taxonomy,
  is never stamped, and MUST be unchanged. BYOK flows (key resolution, misconfig
  rejection, metering skip) MUST be unchanged, beyond their failures now being
  stamped like any other classified failure.
- **FR-016**: Transcripts written before this feature (no failure metadata) MUST
  render exactly as they do today; the failure record is purely additive.

**Regression testing**

- **FR-017**: The banner-persistence scenarios MUST be tested against realistic SDK
  state transitions — this bug shipped precisely because the existing context tests
  fully mock the SDK and never model its status flips. At minimum, tests MUST cover:
  a resume clearing SDK error state (error → submitted with error unset) while the
  banner stays; a clean replay ending at "ready" while the banner stays; a failed
  recovery leaving the banner; and reload-derivation of the banner from a transcript
  bearing a failure record. The test double MUST model these status transitions
  faithfully, or the tests MUST drive the real client chat class with a scripted
  transport (choice deferred to plan, ledger D8).

### Key Entities

- **Turn failure record**: `{ code, provider, at }` — the classified outcome of a
  failed turn, attached as metadata to the turn's trailing user message inside the
  chat's stored messages. Written once at the server's classification point; never
  explicitly cleared; superseded/neutralized by transcript position (trailing-turn
  logic).
- **Durable turn-error state (client)**: the single per-chat classified-error state
  (code, provider, derived copy), fed by live error events and by loaded-transcript
  failure records; the sole source for every error banner, the usage-limit banner,
  and the interruption notice.
- **Resumable stream entry**: the server-side per-chat replay buffer. Lifecycle
  changed: torn down immediately on classified failure (previously lingered ~30s),
  unchanged on success.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: A shared-credit (or any classified provider) failure shows its
  classified banner immediately, and the banner is still visible 30+ seconds later
  with no user action — on both the side panel and the full-page chat.
- **SC-002**: After a page reload of a chat whose last turn failed, the banner
  re-appears with identical copy and action, derived from the loaded transcript.
- **SC-003**: No resume, replay, or reconnect sequence can transition a failed turn
  into a silent no-reply state: in every tested transition sequence, either an
  assistant reply is visible or the failure banner is.
- **SC-004**: The next send clears the banner immediately; a later assistant reply
  neutralizes the stored record with no explicit clearing write.
- **SC-005**: The client's parallel error states are reduced from four to one durable
  per-chat state plus a transient reconnecting flag, with zero change in rendered
  copy or actions per taxonomy code.
- **SC-006**: A mid-stream-interrupted partial reply carries its interruption notice
  on every later load of the chat, not just in the session where it happened.

## Assumptions

- The chat messages store remains schemaless JSONB with full-replace saves; no
  migration is needed or permitted for this feature.
- The failure record is additive metadata: all existing consumers of the message
  array (model-history assembly, rendering, compaction) tolerate unknown metadata on
  user messages. (Compaction summarization and history hygiene must simply carry or
  drop it without error; the record is only meaningful on the trailing turn.)
- A server process crash between user-message save and stamping leaves an unstamped
  trailing user message; this feature does not add crash-consistent stamping. The
  user sees the pre-existing behavior (no banner, resume-or-nothing).
- Failure records are not broadcast cross-tab; other tabs pick them up on their next
  transcript load/re-sync, which existing polling and load paths already perform.
- The AI SDK remains at v6 semantics (resume clears error state); the design is
  deliberately robust to any future status semantics because status is no longer a
  render gate.
