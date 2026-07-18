# Feature Specification: Log-Derived Agent-Edit Undo/Redo

**Feature Branch**: `016-log-derived-undo`

**Created**: 2026-07-18

**Status**: Draft

**Input**: User description: "Agent-edit undo/redo becomes log-derived and stateless: a surgical inverse computed from the edit's persisted clock range in the `yjs_updates` log, applied to the live doc as a normal forward update. The presence session's in-memory `Y.UndoManager` is retired; both undo surfaces (the chat Undo/Redo button and the MCP undo/redo tools) converge on the one log-derived core."

**Design ground truth**: `design/collaboration-core.md`, "Version history" — **Amendment (Sam, 2026-07-18) — agent-edit undo is derived from the update log, not from a live session** (RATIFIED). Cross-referenced by `design/agent-surface-mcp.md`, "Agents are collaborators, not a backdoor" — **Amendment (Sam, 2026-07-18) — undo/redo become log-derived and stateless**. The inverse is restore's sibling and must obey the same invariants ("Persistence: the update log and the clock"; "Restore is non-destructive").

## Overview

Undoing an agent's edit today means finding the in-memory `Y.UndoManager` inside the agent's live presence session and popping its stack (`server/mcp/tools/undo-redo-handler.js`, reached both by the MCP `undo`/`redo` tools and by the chat Undo/Redo button via `POST /api/docs/:docId/undo|redo`, `server/index.js:1348`). That stack lives only as long as the session (minutes), only in the memory of the one instance that held it, and dies on every restart. The consequences are all user-visible: cross-instance routing lands the undo on a pod with no session, which silently answers `{undone:false}` while also creating a fresh orphan presence session (the pre-015 pathology; feature 015 fixed the duplicated avatar but explicitly left undo-stack pod-locality out of scope); the chat Undo button polls `/api/docs/:docId/undo-status` and simply disappears when the session expires a few minutes after the edit; and any deploy or restart erases every user's ability to revert what an agent just did.

Meanwhile the durable truth was in the database all along: every update an agent makes is a row in the `yjs_updates` log, keyed `(doc_guid, clock)` and attributed to the user and agent that made it (`server/postgres-persistence.js`). Version history, diffs, and restore already reconstruct any historical state from clock ranges. This feature makes undo/redo read the same source of truth: given the clock range identifying an agent edit, the server derives the edit's exact surgical inverse from the logged updates — what the edit inserted comes out, what it deleted goes back — and applies that inverse to the live document as a normal forward update, exactly as restore does. History is never rewritten; the inverse is just the next attributed edit in the log. Redo inverts the inverse from the inverse's own recorded clock range, so the chain works indefinitely.

Because the log is durable and shared, undo now works from any instance, survives session expiry and server restarts, creates no presence session, and behaves identically on both surfaces: the in-memory session `Y.UndoManager` is retired, and the chat button and the MCP tools converge on one log-derived core. There is one undo mechanism, not two.

## User Scenarios & Testing *(mandatory)*

The "users" of this feature are the human who invoked the in-app chat assistant (the chat Undo/Redo button), external MCP agents driving the `undo`/`redo` tools on their user's behalf, human collaborators watching the document while an undo lands, and the operator (Sam) running the multi-replica production cluster.

### User Story 1 - Undo that always works: any instance, any time, any restart (Priority: P1)

As a user who asked the chat assistant to edit my document, I can undo that edit from the chat — and the undo works regardless of which server instance handles my request, how much time has passed since the edit, and whether the server has restarted or the assistant's presence session has expired in between.

**Why this priority**: This is the defect the design amendment exists to fix. Today undo silently fails (`{undone:false}`) whenever the serving instance does not hold the session, and the capability itself evaporates minutes after the edit. An undo button that works only sometimes is worse than none — it teaches users they cannot trust reverting agent edits, which undermines the "agents are collaborators" story.

**Independent Test**: Run two server instances against the same database with non-sticky request distribution. Have the assistant modify a document via a request served by instance A; issue the undo via a request served by instance B (which never held any session for the document). Separately: modify, restart the server process entirely, then undo. Both undos succeed and revert the edit.

**Acceptance Scenarios**:

1. **Given** an agent edit made through instance A, **When** the user's undo request is served by instance B which never held the agent's session, **Then** the edit is reverted exactly as if the same instance had handled both, with no silent failure.
2. **Given** an agent edit, **When** every server instance restarts and all in-memory state is lost, **Then** a subsequent undo of that edit succeeds.
3. **Given** an agent edit whose presence session has long expired, **When** the user undoes it (minutes, hours, or days later), **Then** the undo succeeds — undo availability has no session-derived time limit.
4. **Given** an undo or redo request, **When** it executes, **Then** no agent presence session is created or extended: no agent avatar or cursor appears to collaborators, and no orphan session outlives the request.
5. **Given** the undo has succeeded, **When** the chat reloads, **Then** the edit's diff shows the persisted "Reverted" marker exactly as today (the reverted flag on the chat tool part is retained).

---

### User Story 2 - A surgical inverse, not a time-machine: later edits survive (Priority: P1)

As a user (or any collaborator), when an agent edit is undone, only that edit's contribution is removed: everything anyone wrote after it — human or agent — is preserved untouched, content the edit deleted comes back, and content that later edits already deleted or replaced is not resurrected. When there is nothing left of the edit to undo, I get an honest "nothing left to undo" instead of a no-op dressed as success.

**Why this priority**: This is what distinguishes undo from restore (which reverts to a point in time, discarding later work). The semantics are Sam-ratified in the amendment: they match popping an undo stack item — later edits preserved, superseded content skipped, honest emptiness. Getting these wrong silently destroys collaborators' work, violating the collaboration-safety principle (Constitution IV).

**Independent Test**: Script a sequence — agent edit, then human edits before/after/inside the agent's inserted content, then undo — and byte-compare the resulting document serialization against the expected "everything except the agent edit's surviving contribution". Repeat with the agent's insertion fully deleted by a later edit and assert the honest empty result.

**Acceptance Scenarios**:

1. **Given** an agent edit followed by human edits elsewhere in the document, **When** the agent edit is undone, **Then** the human edits are preserved byte-for-byte and only the agent edit's content changes are reverted.
2. **Given** an agent edit that deleted a paragraph, **When** the edit is undone, **Then** the deleted paragraph is restored — unless a later edit independently deleted the same content, in which case that content stays deleted (superseded content is skipped, not resurrected).
3. **Given** an agent insertion that a later edit partially rewrote, **When** the agent edit is undone, **Then** only the surviving (unsuperseded) parts of the insertion are removed; the later rewrite is untouched.
4. **Given** an agent edit whose every effect has since been superseded (all insertions deleted, all deletions re-deleted or rewritten), **When** undo is attempted, **Then** the system reports honestly that there is nothing left to undo — no document update is written, the response says so explicitly, and the edit is not marked reverted.
5. **Given** a formatting-only agent edit (e.g. bolding a phrase — `changed: true` with no text diff), **When** it is undone, **Then** the formatting reverts, subject to the same supersession rules (formatting later overridden on the same text is not resurrected).
6. **Given** collaborators with the document open in their browsers, **When** an undo lands, **Then** they see the reversion live, as a normal incoming edit — no disconnect, no reload, no history rewrite (the same invariant restore already honors).

---

### User Story 3 - Redo, and the chain that never breaks (Priority: P2)

As a user who undid an agent edit, I can redo it — and undo the redo, and so on indefinitely. The redo works from any instance and survives restarts, exactly like undo, because it is derived the same way: the inverse's own recorded clock range is inverted in turn.

**Why this priority**: Undo without a trustworthy redo makes users afraid to try it. The amendment ratifies the mechanism — redo derives from the inverse's recorded clock range ("invert the inverse"), so the chain works indefinitely — and the chat UI already models the toggle (Undo edit ↔ Redo edit on the reverted part).

**Independent Test**: Modify, undo, redo, and byte-compare the document to its pre-undo state. Then cycle undo/redo ten times, asserting exact content at each pole, with at least one cycle crossing a server restart and one crossing instances.

**Acceptance Scenarios**:

1. **Given** an undone agent edit, **When** the user redoes it, **Then** the document content returns byte-for-byte to its pre-undo state (assuming no intervening edits).
2. **Given** an undo→redo→undo→redo… cycle of any length, **When** each step executes, **Then** each step derives from the previous inverse's recorded clock range and lands correctly — the chain never degrades or loses track.
3. **Given** an undone edit and then a restart or an instance switch, **When** the user redoes, **Then** the redo succeeds (the inverse's clock range is durably recorded, not held in memory).
4. **Given** an undone edit followed by new edits from collaborators, **When** the user redoes, **Then** the redo obeys the same surgical semantics as undo: later edits preserved, superseded content skipped, honest "nothing left to redo" when fully superseded.
5. **Given** a redo has succeeded, **When** the chat reloads, **Then** the tool part's "Reverted" marker is cleared (persisted, as today).

---

### User Story 4 - One mechanism, both surfaces: MCP tool parity (Priority: P2)

As an external agent connected over MCP, I can undo and redo my own edits with the `undo`/`redo` tools and get the same log-derived behavior as the chat button: works from any instance, survives session expiry, honest results, and my undo history is scoped to my own agent identity's edits.

**Why this priority**: Both surfaces share one handler today and the amendment mandates they converge on the one log-derived core — "one undo mechanism, not two". Divergence between surfaces would be a new bug class. The MCP tool surface stays at sixteen tools; only behavior and descriptions change.

**Independent Test**: Drive `modify` then `undo` then `redo` over MCP against a multi-instance deployment, verifying identical document outcomes to the equivalent chat-button sequence, and verifying an agent cannot undo edits attributed to a different agent identity or to a human.

**Acceptance Scenarios**:

1. **Given** an MCP agent that edited a document, **When** it calls `undo`, **Then** its most recent still-undoable edit is reverted with the same surgical semantics as User Story 2, regardless of instance routing or elapsed time.
2. **Given** an MCP agent calling `undo` repeatedly, **When** each call succeeds, **Then** successive calls step back through that agent identity's own prior edits in reverse order (the stack-walking behavior the tools have always documented), and `redo` reapplies them most-recently-undone first.
3. **Given** a document edited by a human and by two different agent identities, **When** one agent calls `undo`, **Then** only edits attributed to that same agent identity (this user + this agent) are candidates — the tool can never revert a human's or another identity's edit.
4. **Given** an agent with nothing (left) to undo or redo, **When** it calls the tool, **Then** it receives `success: true` with `undone: false` (or `redone: false`) and an explicit message — never an error, never a silent wrong answer.
5. **Given** the chat button and the MCP tools driven through the same sequence of operations, **When** outcomes are compared, **Then** the resulting document states are identical (behavioral parity through the shared core).
6. **Given** viewer-role access (or no access) to the document, **When** undo or redo is attempted on either surface, **Then** it is refused — editor role remains required, exactly as today.

---

### User Story 5 - The Undo button stops lying about its own lifetime (Priority: P3)

As a chat user, the Undo/Redo button on the assistant's latest edit reflects whether that edit can actually be undone (or redone) according to the durable log — it no longer vanishes just because an invisible in-memory session expired, and checking its state never conjures a presence session.

**Why this priority**: The visibility poll (`GET /api/docs/:docId/undo-status`) is the retirement's user-facing dividend: today it peeks the live session's `Y.UndoManager` and reports `{canUndo:false, canRedo:false}` the moment the session dies, so the button silently disappears minutes after the edit. Log-derived status removes the session lifetime from the button's semantics. P3 because it rides entirely on the P1/P2 core.

**Independent Test**: Make an agent edit, wait past the old session lifetime (or restart the server), and verify the undo-status endpoint still reports the edit undoable and the button still renders and works. Verify the status check creates no presence session.

**Acceptance Scenarios**:

1. **Given** an agent edit made more than a session-lifetime ago (or before a restart), **When** the chat UI polls undo-status, **Then** the response reports the edit undoable and the button remains visible and functional.
2. **Given** the assistant's latest edit has been undone, **When** the UI polls, **Then** the response reports redo available (and undo per whatever remains undoable), keeping the persisted Reverted state and the button in agreement.
3. **Given** a viewer-role user, **When** they poll undo-status, **Then** the response is `{canUndo:false, canRedo:false}` as today (no button for viewers).
4. **Given** any number of undo-status polls, **When** they execute, **Then** zero presence sessions are created or extended and no agent avatar appears.
5. **Given** the assistant has never edited the document (or its edits predate what the log can identify — see legacy handling), **When** the UI polls, **Then** the response honestly reports nothing undoable and the button does not render.

---

### Edge Cases

- **Undo immediately after modify**: the edit's updates are persisted asynchronously after the tool result returns. The recorded clock range MUST refer only to durably persisted rows (see FR-004); an undo can therefore never see half an edit. If the range for the latest edit is not yet recorded when an undo arrives, the system reports nothing to undo honestly rather than deriving a partial inverse.
- **Concurrent duplicate undo** (double-click, or two requests landing on two instances): at most one inverse takes effect; the loser observes the edit already undone and reports it honestly (`undone: false` or equivalent), never applying the inverse twice.
- **Undo racing a live edit**: a collaborator typing while the undo lands loses nothing — the inverse is a normal forward update merged by the same conflict-free machinery as any concurrent edit (the invariant restore already honors), and supersession is evaluated against the state the inverse merges into.
- **Multi-update edits**: one `modify` call can produce several log rows (the script's transactions plus post-script sanitization passes such as image rehosting/stripping and link-mark cleanup, which mutate the fragment as part of the same call). The clock range covers all of them; undo reverts the whole modify as one unit, matching what the user saw as "the edit".
- **Interleaved foreign rows inside the range**: updates from other authors can be assigned clocks between the edit's own rows. Only rows attributed to the acting identity within the range constitute the edit; foreign rows in the gap are never inverted.
- **No-change modify** (`changed: false`): produces no undoable edit; it never becomes an undo candidate (the chat button already only renders for `changed: true`).
- **Legacy chat messages (pre-016)**: existing modify tool parts persist only the pre-edit clock (see FR-002/FR-021). Where the edit's rows can be identified unambiguously from that clock plus attribution, undo works; where they cannot, the surfaces report honest unavailability — never a guessed inverse.
- **Pre-016 undos**: an edit undone by the old session mechanism has a persisted `reverted` flag but no recorded inverse range; redo of such an edit is honestly unavailable (RBD-2).
- **Undo of a very old edit**: the log has no compaction — an undoable edit stays undoable indefinitely, with supersession semantics doing the honest work as the document evolves around it.
- **Document deleted**: undo/redo of edits to a deleted document fails with the same not-found/no-access behavior as any other document operation.
- **Untrusted-content replay**: the inverse only re-materializes content that already passed a write boundary's sanitizers when it was first stored (modify's link/image guardrails, the import pipeline); replay introduces no new unvalidated input. This preserves the existing, deliberate decision that undo/redo do not re-run link sanitization (documented in the current handler).

## Requirements *(mandatory)*

### Functional Requirements

**The clock-range contract: what identifies "the edit"**

- **FR-001**: Every content-changing `modify` call MUST produce a durable edit identifier — a clock range in the document's update log — that selects exactly the log rows that call wrote: all of them (including multi-update edits and post-script sanitization mutations) and only them (rows attributed to other authors, or to other calls by the same identity, are excluded). Within the range, rows are qualified by the acting identity's attribution (user + agent) (Sam-ratified: "the edit's clock range", 2026-07-18).
- **FR-002**: The edit identifier MUST be returned in every `modify` result and persisted on the chat modify tool part, alongside the data persisted there today. The existing `clock` field of the modify result (the pre-edit baseline observed at call start, `server/mcp/tools/modify.js`) retains its current meaning — the staleness/conflict machinery depends on it — and MUST NOT be silently repurposed (RBD-1).
- **FR-003**: The undo target for each surface is defined in terms of this identifier: the chat button targets the assistant's latest content-changing edit (its tool part carries the range); the MCP `undo` tool targets the calling agent identity's most recent still-undoable edit in that document.
- **FR-004**: A recorded edit identifier MUST refer only to rows already durably persisted — the range is recorded at (or after) the point its rows are all readable from the log, never speculatively — so no undo can ever derive an inverse from a partially persisted edit.

**The log-derived inverse core**

- **FR-005**: Undo MUST be computed exclusively from the durable update log: the system reads the update rows selected by the edit's clock range, extracts what the edit inserted (the content carried in those updates) and what it deleted (their recorded deletions), and derives the exact surgical inverse (Sam-ratified mechanism, 2026-07-18). No in-memory session state of any kind may be an input.
- **FR-006**: The inverse MUST be applied to the live document as a normal forward update, inside the same write path as any other edit: it is appended to the log with a new clock, broadcast live to connected collaborators, and never rewrites, deletes, or mutates any existing log row (Sam-ratified; the same non-destructive invariant as restore).
- **FR-007**: Undo MUST work with no client connected, from any server instance, at any time after the edit, and across server restarts — its only dependencies are the database log and the recorded edit identifier.
- **FR-008**: Applying an inverse MUST NOT create, extend, or require an agent presence session, and MUST NOT announce any agent presence (no avatar, no cursor) (Sam-ratified: the session UndoManager is retired; undo no longer produces the orphan-session pathology).

**Undo semantics (popStackItem-equivalent)**

- **FR-009**: Edits made after the target edit — by anyone, human or agent — MUST be preserved exactly; the inverse touches only the target edit's own contribution (Sam-ratified, 2026-07-18).
- **FR-010**: Content already deleted or superseded by later edits MUST be skipped, not resurrected: insertions the target edit made that were since deleted stay deleted; content the target edit deleted that was since re-deleted or replaced stays as the later edits left it (Sam-ratified, 2026-07-18).
- **FR-011**: When the target edit is fully superseded — its inverse would change nothing — the operation MUST report honestly that there is nothing left to undo: no update is appended to the log, the response carries `undone: false` (or surface equivalent) with an explanatory message, and no reverted state is recorded (Sam-ratified: "an honest 'nothing left to undo'", 2026-07-18).
- **FR-012**: Formatting-only edits (content-changing but with no text diff) MUST be undoable under the same rules, including supersession of formatting later overridden on the same content.
- **FR-013**: Supersession MUST be evaluated against the live document state the inverse is merging into at application time, so a concurrent edit racing the undo is honored rather than clobbered.

**Redo and the chain**

- **FR-014**: Every applied inverse MUST have its own clock range durably recorded and associated with the edit it inverts — readable from any instance, surviving restarts (Sam-ratified: "the inverse's own recorded clock range", 2026-07-18). For the chat surface this association is persisted with the chat message (alongside the existing `reverted` flag); the system MUST additionally keep whatever durable record is needed for a bare `redo(docGuid)` MCP call to find it (RBD-3).
- **FR-015**: Redo MUST be derived by the identical mechanism applied to the inverse's recorded clock range ("invert the inverse"), producing a new forward update with the same surgical semantics (FR-009–FR-013, with "nothing left to redo" as the honest empty result).
- **FR-016**: The undo→redo→undo→… chain MUST work indefinitely: each application records its own range (FR-014), and the next step in the chain derives from the most recent one. Chain state MUST survive restarts and instance switches at every link.
- **FR-017**: Repeated `undo` calls on the MCP surface MUST step back through the calling agent identity's own prior edits in reverse chronological order, skipping edits already undone; `redo` reapplies undone edits most-recently-undone first (parity with the documented stack behavior of the current tools; RBD-4). The chat button's exposure remains latest-edit-only, as today.

**Surfaces: chat endpoints and the Undo/Redo button**

- **FR-018**: `POST /api/docs/:docId/undo` and `/redo` MUST keep their contract with the client — editor role required (403 otherwise), response carrying the operation result, best-effort persistence of the `reverted` flag on the identified tool part (set on successful undo, cleared on successful redo) — while routing through the log-derived core instead of the session `Y.UndoManager`.
- **FR-019**: `GET /api/docs/:docId/undo-status` MUST derive `{canUndo, canRedo}` from the durable log and recorded identifiers — "is the assistant's latest edit undoable / redoable" — with no dependency on, peek at, or creation of any presence session. Viewer-role and error responses remain `{canUndo:false, canRedo:false}` as today. This removes the button's session-lifetime disappearance: visibility is governed by the log, the latest-edit rule, and role — not by time since the edit (RBD-6 records the availability-computation depth).
- **FR-020**: The chat staleness machinery's existing behavior — warning the assistant that a document it edited was since reverted — MUST continue to work with the log-derived undo (the reverted-doc detection keys off the same persisted chat state it does today).
- **FR-021**: Legacy chat messages predating this feature (modify parts persisting only the pre-edit `clock`) MUST degrade honestly: where the edit's rows are unambiguously identifiable from the persisted clock plus attribution, undo works; where they are not, undo-status reports unavailability and the surfaces return the honest empty result — never a guessed or partial inverse (RBD-2).

**Surfaces: MCP tools**

- **FR-022**: The `undo` and `redo` tools keep their names, input schema (`docGuid`), required scope (`documents:write`), and editor-role requirement; the MCP tool surface stays at sixteen tools. Their result shape keeps `success` and `undone`/`redone` with honest messages; the session-derived cursor restoration is retired from behavior and descriptions, and the result gains the information agents need to stay current after an undo (RBD-5).
- **FR-023**: Tool descriptions MUST be updated to describe the log-derived behavior truthfully (per-identity undo scoped to your own edits, works across sessions and restarts, surgical later-edits-preserved semantics, honest empty results) — drift between description and behavior is a bug per the design docs' contract.

**Access control and attribution**

- **FR-024**: Only log rows attributed to the caller's own acting identity (the requesting user plus the acting agent identity) are undoable or redoable through these surfaces. The chat surface acts as the requesting user's chat-assistant identity (unchanged); an MCP agent acts as its token's identity. Human edits and other identities' edits are never candidates — the equivalent of the old per-session tracked-origin scoping, now enforced against the log's attribution.
- **FR-025**: Editor role on the document MUST be verified on every undo/redo/status request, without creating a presence session to do so (today the role check rides on session creation; it must survive the session's retirement).
- **FR-026**: The inverse (and redo) update MUST carry the standard origin attribution of the agent identity performing the operation (Sam-ratified, 2026-07-18): it appears in the per-update log attribution, in version history's authors, and in diffs exactly as any other edit by that identity would — provenance is a product invariant (Constitution IV).
- **FR-027**: In version history, the inverse appears as a normal new edit (grouped by the standard inactivity rules); no version, snapshot, or diff of any prior state changes as a result of an undo or redo.

**Concurrency and consistency**

- **FR-028**: Concurrent undo attempts against the same edit (double-submit, multi-instance races) MUST resolve to at most one effective inverse; losers report the honest already-undone result. The same holds for redo.
- **FR-029**: Undo and redo MUST be safe against the log's assigned-at-write clock behavior: new inverse rows take fresh clocks like any edit, and the mechanism MUST tolerate foreign rows interleaved within any range it reads (attribution-qualified selection per FR-001).

### Key Entities

- **Agent edit (undo unit)**: the complete effect of one content-changing `modify` call, identified by its clock range in the update log plus the acting identity's attribution. The unit of undo and redo; carries its persisted identifier on the chat tool part and in the modify result.
- **Update log entry** (existing): a row of `yjs_updates` — document, monotonic clock, update payload, user/agent attribution. The sole durable input to inverse derivation; append-only, never mutated by this feature.
- **Inverse record**: the durable association between an applied inverse (its own clock range) and the edit it inverts — the raw material of redo and of chain continuation. Persisted with the chat message for the chat surface and durably server-side for bare MCP redo; survives restarts, readable from any instance.
- **Acting agent identity**: the (user, agent) pair a request operates as — the chat assistant identity for the chat surface, the token's identity for MCP. Scopes which edits are undoable and attributes the inverses.
- **Chat modify tool part** (existing): the persisted chat-message record of one modify call — diff, output (including the pre-edit `clock` today), `reverted` flag. Gains the edit identifier (and inverse association) so undo state survives reloads.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: **Cross-instance undo**: with two instances and non-sticky routing, an edit made via instance A is successfully undone via instance B — an instance that never held any session for the document — with zero occurrences of the silent `{undone:false}` cross-pod failure. Verified for both the chat endpoint and the MCP tool.
- **SC-002**: **Restart survival**: modify → full server restart (all in-memory state lost) → undo succeeds; likewise redo after a restart that follows an undo.
- **SC-003**: **Later edits preserved byte-for-byte**: in scripted interleavings (human edits before/after/inside the agent edit's content), the post-undo document serialization is byte-identical to the expected content with only the agent edit's surviving contribution removed. 100% of interleaving cases in the suite pass exact comparison.
- **SC-004**: **Honest failure when fully superseded**: undoing a fully superseded edit returns the explicit nothing-left-to-undo result, appends zero updates to the log, and sets no reverted state — in 100% of superseded-edit cases.
- **SC-005**: **Redo round-trips**: undo→redo returns the document byte-for-byte to its pre-undo state; a ten-cycle undo/redo chain (including at least one restart and one instance switch mid-chain) stays exact at every pole.
- **SC-006**: **No sessions from undo**: across any sequence of undo, redo, and undo-status calls, zero agent presence sessions are created or extended and zero agent avatars appear to collaborators (measured against the presence session registry before/after).
- **SC-007**: **Status outlives sessions**: undo-status reports the latest agent edit undoable after the old session lifetime has elapsed and after a restart, for as long as it genuinely remains undoable — the Undo button no longer disappears on session expiry. Status checks are cheap enough for the existing 30-second per-client poll (no user-visible latency regression in chat).
- **SC-008**: **Surface parity**: identical operation sequences driven through the chat endpoints and through the MCP tools produce identical document states in 100% of parity cases (one shared core, not two mechanisms).
- **SC-009**: **History is never rewritten**: after arbitrary undo/redo sequences, every pre-existing log row is byte-identical, the log strictly grew, version history shows each inverse as a new attributed edit by the acting identity, and all prior versions/diffs render unchanged.
- **SC-010**: **Live collaboration unharmed**: collaborators connected during an undo see it arrive as a live edit with no disconnects; an edit typed concurrently with the undo survives byte-for-byte. Full backend suite passes; no regression in modify latency (the identifier recording adds no user-perceptible cost).
- **SC-011**: **Honest legacy degradation**: for pre-016 chat history, every case either undoes correctly or reports honest unavailability — zero cases of a wrong or partial inverse.

## Out of Scope

- **Human-edit undo**: the browser editor's client-side Yjs undo (Ctrl+Z over the user's own edits) is a separate, unaffected mechanism. This feature covers agent-attributed edits surfaced through the chat button and MCP tools only.
- **Sticky routing**: no ingress/routing affinity changes; the mechanism must be correct under fully non-sticky routing.
- **Feature 015's presence-claim machinery**: the Redis presence claim, handoff, and cross-delete guard (merged as 87e7e0c) are untouched; 016 builds on the post-015 codebase and merely stops undo from creating the sessions 015 coordinates. The only 015-adjacent change is removing what its spec explicitly deferred: undo-stack pod-locality and the undo-created orphan session.
- **Restore behavior**: restore-to-version keeps its existing semantics; this feature only adopts its invariants (non-destructive forward update, live broadcast).
- **Undoing arbitrary historical edits from the UI**: the chat button remains scoped to the assistant's latest edit; a "revert any past edit from version history" surface is separate work (the core's range-based design does not preclude it).
- **Log compaction / retention**: the append-only, replay-everything persistence model is unchanged.

## Assumptions

- The feature is specified against the post-015 codebase (main at 87e7e0c): the presence duplication fix is in place, and `server/mcp/tools/undo-redo-handler.js` is the single shared handler both surfaces reach.
- The `yjs_updates` log is complete and permanent (no compaction), and its per-row user/agent attribution is reliable — it is already the basis of version history, diffs, and the modify conflict guard.
- The modify result's `clock` field is today the pre-edit baseline captured before script execution, and edit persistence is asynchronous — hence FR-001/FR-004's requirement for an explicit, durably-recorded range rather than inference from the response-time clock (verified in `server/mcp/tools/modify.js`).
- The chat message store is a durable, reload-surviving home for per-edit metadata (it already persists the modify output and the `reverted` flag).
- Decisions the design amendment did not settle (identifier shape and field naming, legacy derivation policy, the redo record's home, MCP multi-step depth, tool result shape after cursor retirement, status computation depth) are taken as best defaults and recorded as RATIFIED-BY-DEFAULT in `clarifications-needed.md` per Constitution Principle VI.
