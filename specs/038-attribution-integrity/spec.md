# Feature Specification: Attribution Integrity

**Feature Branch**: `038-attribution-integrity`

**Created**: 2026-08-01

**Status**: Draft

**Input**: User description: "038-attribution-integrity — attribution integrity fixes for the collaboration sync protocol (viewer step2 write bypass, via_sync tagging, origin parsing hardening, capture race, connectionClientId removal)"

**Design basis**: `design/collaboration-core.md`, the two amendments dated 2026-08-01 (commit 13f7561d):
(a) *edit enforcement covers the WHOLE sync protocol, not just update messages* — any protocol frame that can reach the document-apply path is an edit for permission purposes; and
(b) *reconnect re-supply is sync, not authorship* — a row that reached the server through a client's catch-up reply proves the content passed through that client, never that the client wrote it.

This feature converges the code to those amendments and closes the remaining verified findings (F1–F5) of the version-history/diffing attribution audit.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Viewers cannot write through any sync channel (Priority: P1)

A document owner shares a document with someone in **viewer** role, trusting that the viewer can read but never change the document. Today, a viewer's connection can smuggle arbitrary content into the document by framing it as a sync catch-up reply (a SyncStep2 frame) instead of a normal edit frame: the permission gate only recognizes update frames as edits, and the sync library applies a step2 payload to the document exactly like an update. Worse, the resulting history row is stamped with the viewer's identity — a write-permission bypass, not merely a mislabel. After this feature, a viewer-role connection cannot alter the document through *any* sync protocol frame, while still receiving the document and all live changes read-only.

**Why this priority**: This is a security hole — the sharing permission model's core promise ("viewer cannot write") is violated. Everything else in this feature is attribution hygiene; this is access control.

**Independent Test**: Connect to a shared document as a viewer-role principal, hand-craft a SyncStep2 frame containing new content, and send it. Verify the document is unchanged for all participants, no history row is created, and the server records a distinct blocked-frame event. Then verify the same viewer still receives the full document and live edits from editors.

**Acceptance Scenarios**:

1. **Given** a document shared with a user in viewer role, **When** that user's connection sends a SyncStep2 frame containing content the server lacks, **Then** the frame is dropped before it reaches the document: the live document is unchanged, no `yjs_updates` row is created, and no other participant receives any change.
2. **Given** a viewer connection whose step2 frame was dropped, **When** the drop occurs, **Then** the server emits a distinct `WS_STEP2_BLOCKED` observability event (separate from the existing `WS_EDIT_BLOCKED` event for update frames) identifying the connection, user, document, and role, and the connection remains open.
3. **Given** a viewer connection, **When** the server performs its normal connection-setup sync (server sends step1, document state, and subsequent live updates downstream), **Then** the viewer receives the document and all later edits normally — blocking upstream step2 does not degrade the viewer's read experience (the server never awaits the step2 reply).
4. **Given** an **editor**-role connection that made changes while offline, **When** it reconnects and answers the server's step1 with a step2 containing its offline edits, **Then** the step2 is applied normally — the legitimate offline-edit sync path is unaffected.
5. **Given** the existing test that pins `isEditMessage(syncStep2) === false` (the old, buggy contract), **When** this feature lands, **Then** that test is updated to pin the new contract (step2 is edit-classified / blocked for viewers) rather than the bug.

---

### User Story 2 - Reconnect re-supply is recorded as sync, not authorship (Priority: P2)

Every browser client keeps a local offline mirror of each document. On every reconnect the server asks the client what it has (step1), and the client replies with everything the server's state lacks — which, after a gapped read, a fresh server instance, or a lost write, includes content **originally authored by other people**. That reply lands in history as a normal update stamped with the reconnecting user, so version history credits them with text they never typed, undo treats it as their work, and the collaboration guardrail can page on "their" massive edit. After this feature, every history row that originated from a step2 catch-up frame carries a `via_sync` marker, and authorship-sensitive consumers discount those rows. Attribution itself is unchanged — a genuine offline edit is still that user's work and stays attributed to them; the marker records the *channel*, not a verdict on authorship.

**Why this priority**: This is the highest-impact attribution corruption in normal operation — it requires no malice, just a reconnect at the wrong moment — and it poisons downstream features (undo identity runs, guardrail pages, history displays). It depends on nothing in US1 and is independently shippable.

**Independent Test**: With two editors on a document, disconnect editor B, have editor A add content, wipe the server's in-memory doc state so a resync gap exists (or start a fresh instance), reconnect editor B, and verify the row(s) persisting A's re-supplied content are stamped `via_sync = true` under B's identity — and that a normal live edit by B afterwards persists with `via_sync` not set.

**Acceptance Scenarios**:

1. **Given** an editor connection replying to the server's step1 with a step2 catch-up frame, **When** the resulting update is persisted, **Then** the `yjs_updates` row records `via_sync = true` alongside the (unchanged) user attribution.
2. **Given** a live edit made through a normal update frame on the same connection immediately before or after a step2, **When** both are persisted, **Then** only the step2-originated row carries `via_sync = true` — the marker never leaks onto adjacent live edits (the flag's lifetime is exactly the synchronous application of the step2 frame).
3. **Given** history rows persisted before this feature ships, **When** any consumer reads them, **Then** their `via_sync` value is null, meaning "unknown channel", and consumers treat null the same as "not sync" (current behavior preserved; no backfill).
4. **Given** log-derived undo computing an identity run for an agent or user, **When** the candidate rows include a `via_sync = true` row, **Then** that row is excluded from the identity run (treated as not that identity's authored work), so undo never inverts content the identity merely relayed.
5. **Given** the collaboration guardrail evaluating an update whose triggering row was sync-sourced, **When** it reports or pages, **Then** the report is annotated as sync-sourced so a human triaging the page can immediately see the "author" was a relay.
6. **Given** any future consumer reasoning about authorship, **When** it reads the log, **Then** the documented rule applies: a `via_sync` row proves the content reached the server through that client, never that the client wrote it.

---

### User Story 3 - Malformed attribution never causes silent data loss (Priority: P3)

When an update's transaction origin is unrecognized, today's parsing has two unsafe fallbacks: an unrecognized *string* origin is passed through as if it were a user id, poisoning the database insert (the attribution column requires a UUID) — after retries the row is **dropped entirely**, which is worse than misattribution because the content is live in the document but absent from durable history; an unrecognized *object* origin silently persists an unattributed row with no signal that anything was wrong. After this feature, a malformed origin can degrade attribution but can never block persistence, and both degradations are loud.

**Why this priority**: The failure needs a programming error elsewhere to trigger, but its blast radius is durable data loss on the persistence hot path. Cheap to fix, high downside insurance.

**Independent Test**: Apply an update whose origin is a non-UUID string; verify the update persists as an unattributed row and a loud log/alert fires, and the CRITICAL persistence-failure path is not reached. Repeat with an unrecognized object shape; verify persistence with a warning.

**Acceptance Scenarios**:

1. **Given** an update whose transaction origin is a string that is not a valid UUID, **When** it is persisted, **Then** the row is stored **unattributed** (no user id) rather than poisoning the insert, and a loud, alert-worthy log records the rejected origin value — the update is never dropped.
2. **Given** an update whose transaction origin is a string that **is** a valid UUID, **When** it is persisted, **Then** it is attributed to that user id exactly as today.
3. **Given** an update whose transaction origin is an object of unrecognized shape, **When** it is persisted, **Then** it persists (unattributed where fields are missing) and a warning is logged — never a silent unattributed row.
4. **Given** any origin-parsing outcome, **When** persistence runs, **Then** the pre-existing sentinel origins (db-load, redis, sync-push, inverse-apply, restore) continue to be skipped exactly as before.

---

### User Story 4 - Server-driven changes never adopt an unrelated user's update (Priority: P4)

When the server applies a change on behalf of an identity (imports, agent edits), it briefly listens for "the update my transaction produced" so it can re-broadcast it across instances. On the no-change path, that listener stays armed for up to 50ms and can capture a completely unrelated concurrent update from another user — which the import fan-out path would then republish with the wrong provenance. After this feature, capture is scoped to the exact originating transaction, so a captured update is always the transaction's own.

**Why this priority**: Real race, but a narrow window that requires a no-change server operation to overlap a concurrent edit on the same document on the same instance. Corruption is provenance-only (content is not altered).

**Independent Test**: Run a no-change server-driven modification concurrently with a live edit by another user on the same document; verify the operation reports "no change" and captures nothing, and the concurrent edit's broadcast/persistence is untouched.

**Acceptance Scenarios**:

1. **Given** a server-driven change that modifies the document, **When** the transaction completes, **Then** the captured update is exactly the update produced by that transaction's origin (capture matches on origin), and the "persistence initiated" completion contract is preserved.
2. **Given** a server-driven change that results in **no** document change, **When** a concurrent update from any other origin arrives within the former 50ms window, **Then** nothing is captured (the listener is detached synchronously with the transaction) and the caller publishes nothing.
3. **Given** the change-applying function throws mid-transaction, **When** the error propagates, **Then** the update listener is still detached (no orphaned handler remains armed on the document).

---

### User Story 5 - Presence cleanup never evicts the wrong participant (Priority: P5)

The server tries to remember each connection's presence client id by parsing the **first awareness frame the connection sends** — but clients rebroadcast *other people's* awareness states without filtering, so a connection can adopt another participant's id, and on disconnect the server then evicts the **wrong user's presence** (observed hitting the agent's avatar). The mechanism is also redundant: the sync library already tracks exactly which awareness ids each connection controls and removes exactly those on close. After this feature, the homegrown capture is deleted and the library's own per-connection tracking is the single presence-cleanup mechanism, while the unrelated cross-instance (Redis) cleanup in the same close handler is preserved.

**Why this priority**: User-visible presence glitch (ghost/vanishing avatars) with a straightforward deletion fix; no data integrity at stake.

**Independent Test**: Open a document with two participants A and B where B's connection observed A's awareness broadcast first; disconnect B; verify A's avatar remains for other participants and B's is removed, and that cross-instance cleanup still runs when the last local connection closes.

**Acceptance Scenarios**:

1. **Given** a connection that observed another participant's awareness state before sending its own, **When** that connection closes, **Then** only the awareness states that connection actually controlled are removed — never another participant's.
2. **Given** the homegrown client-id capture machinery (frame parsing and per-connection capture), **When** this feature lands, **Then** it is removed entirely (its parsing helper has no other callers), and presence removal on close relies solely on the sync library's per-connection controlled-id tracking.
3. **Given** the last local connection for a document closes, **When** the close handler runs, **Then** the cross-instance (Redis) subscription cleanup in that handler still executes as before.

---

### Edge Cases

- **Viewer sends step2 as its very first frame** (before any awareness or step1 traffic): still dropped; blocking must not depend on connection state beyond role.
- **Viewer role changes mid-connection**: the existing periodic role re-check governs; a viewer promoted to editor has step2 allowed after the re-check flips the connection's edit capability, and a demoted editor has step2 blocked after it flips — same timing semantics as today's update-frame blocking.
- **Malformed/truncated step2 frame from an editor**: behavior unchanged from today's malformed-update handling; the classification gate must not crash on short frames (frames shorter than 2 bytes are not edit-classified, as today).
- **Step2 whose payload the server already has** (empty diff): applying yields no document update; no row is written; the sync flag set for the frame is cleared without effect.
- **Multiple step2 frames on one connection** (client answering more than one step1, e.g. after an in-connection resync): each frame's application window is flagged independently; interleaved live updates are never flagged.
- **Concurrent live update from another connection during a step2 application**: application of a received frame is fully synchronous on the event loop (message dispatch → protocol read → document update listeners), so another connection's update cannot interleave inside the flag window; this synchronicity assumption is documented at the flag site and revisited if the sync library ever defers application.
- **Restore/undo/import sentinel origins**: these server-side paths never travel as step2 frames, so they can never be flagged `via_sync`; sentinel skipping runs before any flag reading.
- **Undo identity run whose range contains only `via_sync` rows**: the run derivation refuses honestly ("nothing to undo" semantics), consistent with existing foreign-row refusal — it must not fall through to inverting relayed content.
- **Non-UUID string origin that looks almost like a UUID** (wrong length/characters): rejected by validation, persisted unattributed, loudly logged — validation is strict, not fuzzy.
- **Pod dies between broadcast and durable commit**: pre-existing, deliberately deferred gap — an update can be live on other instances yet in nobody's durable history. This feature documents the window at the persistence listener rather than reordering the hot path (see FR-018).

## Requirements *(mandatory)*

### Functional Requirements

**Sync-protocol edit enforcement (US1 / audit F1)**

- **FR-001**: The connection-level edit classification MUST treat any sync-protocol frame that can result in content being applied to the shared document — both update frames (`SYNC_UPDATE`) and sync-reply frames (`SYNC_STEP2`) — as an edit for permission purposes. (Design rule: any frame that can reach the document-apply path is an edit; new sync message types MUST be classified before they ship.)
- **FR-002**: For connections whose role does not permit editing (below editor), the server MUST drop `SYNC_STEP2` frames before they reach protocol processing, exactly as update frames are dropped today: no document mutation, no persistence row, no rebroadcast, and the connection remains open.
- **FR-003**: Dropping a viewer step2 frame MUST emit a distinct observability event (`WS_STEP2_BLOCKED`) carrying at least connection id, user id, document id, and role — distinguishable from the existing `WS_EDIT_BLOCKED` event so bypass attempts are separately countable.
- **FR-004**: Viewer connections MUST continue to sync downstream unaffected: they receive the server's step1/step2 exchange, full document state, live updates, and awareness exactly as before. (Protocol-safe because the server never awaits the client's step2 reply.)
- **FR-005**: Editor-role connections MUST retain the step2 path unchanged — offline edits synced on reconnect still apply and persist under that editor's attribution.
- **FR-006**: `SYNC_STEP1` and awareness frames MUST remain permitted for all roles (they cannot mutate the document).
- **FR-007**: The existing unit test that pins `SYNC_STEP2` as a non-edit message MUST be updated to pin the new contract; test coverage MUST include: step2 classified as edit, step2 dropped for viewer with `WS_STEP2_BLOCKED` emitted, step2 permitted for editor, and update-frame blocking unchanged.

**End-to-end verifiability of the security fix**

- **FR-008**: There MUST be an end-to-end (protocol-level) test demonstrating that a viewer-role connection sending a step2 frame containing content unknown to the server produces (a) no change to the live document, (b) no new `yjs_updates` row, and (c) a `WS_STEP2_BLOCKED` event — and that the same frame from an editor-role connection produces a document change and a persisted row.

**`via_sync` channel marker (US2 / audit F2)**

- **FR-009**: The update history store (`yjs_updates`) MUST gain a nullable boolean column `via_sync`. Semantics: `true` = this row's update originated from a `SYNC_STEP2` frame (a sync catch-up reply); `null` = channel unknown (all rows persisted before this feature, and any path that does not positively identify a step2 source); `false` MAY be written by future explicit-live paths but consumers MUST treat `null` and `false` identically ("not known to be sync"). No backfill of historical rows.
- **FR-010**: User attribution on step2-originated rows MUST remain unchanged — `via_sync` is additive channel metadata, never a substitute for or modifier of the stamped identity.
- **FR-011**: The step2 flag MUST be scoped exactly to the synchronous application of the step2 frame: set immediately before the frame is handed to protocol processing, observed by the persistence listener for updates produced during that application, and cleared immediately after (including on exception, so a throw cannot leave the flag stuck). Updates from any other frame or origin on the same connection MUST NOT be flagged. The synchronous-application assumption this scoping relies on MUST be documented at the flag site.
- **FR-012**: The persistence path MUST thread the flag from the document-update listener through the store call into the new column without altering any existing persistence semantics (per-document write ordering, retry behavior, meaningful-classification, shutdown flush).
- **FR-013**: Log-derived undo's identity-run derivation MUST exclude `via_sync = true` rows from an identity's runs (a flagged row is treated as not authored by that identity), preserving the existing refusal semantics when a run cannot be pinned — undo never inverts content the identity merely relayed, and never silently skips over a flagged row to stitch two runs together.
- **FR-014**: The collaboration guardrail MUST annotate its evaluations/reports when the triggering update's row was sync-sourced, so pages and matches are visibly distinguishable from live-authored edits. Annotation MUST NOT change whether a page fires.
- **FR-015**: The `via_sync` contract (set-on-step2, null-means-unknown, "proves transport, not authorship") MUST be documented where log consumers will find it (the persistence module and the design-doc-derived comment at the flag site), so future consumers apply the rule of thumb: a `via_sync` row proves the content reached the server through that client, never that the client wrote it.
- **FR-016**: The schema change MUST ship as this feature's single migration, with a timestamp strictly greater than `1799600000000` (the current head), reserving the in-flight migration slot this feature owns (e.g. `1799700000000_add-via-sync-to-yjs-updates.js`). The migration MUST be reversible (column drop on down).

**Origin-parsing hardening (US3 / audit F3)**

- **FR-017**: Origin parsing MUST validate string origins against a strict UUID format: a valid UUID string is attributed as that user id (unchanged); a non-UUID string MUST yield an **unattributed** parse result plus a loud, alert-worthy log including the rejected value — the update MUST still persist. An object origin of unrecognized shape MUST persist with whatever attribution fields are present (null where absent) plus a warning log. Sentinel-origin skipping is unchanged. Under no origin value may parsing cause the insert to fail or the row to be dropped.

**Publish-before-commit window (documentation-only closure)**

- **FR-018**: The persistence listener MUST carry a comment documenting the publish-before-commit window: the cross-instance broadcast is initiated before the durable commit settles, so an instance dying in between can leave content live on other instances but absent from durable history. The comment MUST state that the fix (reordering publish after commit) is deliberately deferred as hot-path risk. No behavioral change is in scope.

**Server-driven capture race (US4 / audit F4)**

- **FR-019**: The server-driven change capture MUST be origin-scoped: the update listener matches on the transaction's own origin and ignores updates from any other origin, so a concurrent unrelated update can never be captured or republished with wrong provenance.
- **FR-020**: The capture listener MUST be detached synchronously with the end of the transaction (registered before, removed in a try/finally around the transaction) — no timing window (the former 50ms timeout) may remain in which an armed listener can observe foreign updates. The no-change path returns "nothing captured".
- **FR-021**: The "persistence initiated" completion contract MUST be preserved: after a change-producing transaction, the function still yields once so asynchronous persistence has been initiated before it resolves (a single event-loop turn deferral), and the cross-instance-handler-presence sampling MUST still occur at emit time (feature 037 semantics unchanged).

**Presence client-id capture removal (US5 / audit F5)**

- **FR-022**: The per-connection client-id capture (the awareness-frame parsing helper and the first-frame capture in the message interceptor) MUST be deleted, along with the explicit awareness eviction it drove in the close handler. It has been verified to have no other callers.
- **FR-023**: Presence removal on connection close MUST rely solely on the sync library's built-in per-connection controlled-id tracking (which removes exactly the awareness states the closing connection controlled).
- **FR-024**: The cross-instance (Redis) subscription cleanup in the same close handler MUST be preserved unchanged.

### Key Entities

- **Update history row (`yjs_updates`)**: The append-only record of every document change — document, clock position, update payload, attributed user/agent identity, meaningful-classification — now extended with the nullable `via_sync` channel marker. Clock order remains causal order; attribution fields are untouched by this feature.
- **`via_sync` marker**: Channel metadata on a history row. `true` = arrived in a sync catch-up reply (step2); `null` = unknown (all pre-feature rows). Proves transport through the stamped client, never authorship by it. Consumed by log-derived undo (excluded from identity runs) and the collaboration guardrail (annotation).
- **Connection edit capability**: The per-connection derived permission (role ≥ editor, periodically re-checked) that now gates *all* content-bearing sync frames (update **and** step2), not just update frames.
- **Transaction origin**: The per-change identity envelope (user id + agent name, or a server sentinel) that persistence parses into attribution — now validated so a malformed value degrades to unattributed-but-persisted, never to a dropped row.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: A viewer-role participant attempting to inject content through any sync-protocol frame produces zero document changes, zero history rows, and zero visible effects for other participants — verified end-to-end at the protocol level — while 100% of their read/sync experience is preserved.
- **SC-002**: Every blocked injection attempt is individually countable in observability under a dedicated event name, distinguishable from ordinary blocked edits.
- **SC-003**: 100% of history rows originating from reconnect catch-up replies are marked as sync-channel rows, and 0% of live-edit rows are; rows predating the feature read as "unknown" and behave exactly as before.
- **SC-004**: Log-derived undo never inverts content its acting identity merely relayed: an identity run containing relayed rows either excludes them or refuses honestly — no undo operation removes another author's re-supplied content.
- **SC-005**: Guardrail pages triggered by sync-sourced updates are visibly annotated as such, with no change in which events page.
- **SC-006**: No origin value — valid, malformed string, or unrecognized object — can cause an applied update to be absent from durable history: the persistence drop path is unreachable from origin parsing, and every degraded attribution is accompanied by a log signal.
- **SC-007**: A no-change server-driven operation overlapping a concurrent edit captures and republishes nothing; provenance of concurrently persisted edits is unaffected in 100% of runs.
- **SC-008**: Closing any connection removes only that connection's own presence; other participants' avatars (including the agent's) survive 100% of unrelated disconnects.
- **SC-009**: The full existing collaboration/permission/undo test suites pass with the updated contracts, with the previously bug-pinning step2 test now asserting the corrected behavior.

## Assumptions

- **Design ground truth**: The two 2026-08-01 amendments to `design/collaboration-core.md` are the ratified design basis; this spec introduces no product decisions beyond them, only defaults recorded in `clarifications-needed.md`.
- **Synchronous frame application**: Application of a received sync frame is fully synchronous through the message-dispatch → protocol-read → document-update-listener chain, making the per-frame flag race-free. This is true of the current sync library and is documented at the flag site (FR-011) as a guarded assumption.
- **Server-side paths never produce step2 rows**: Imports, agent edits, restore, and undo apply changes via server-side transactions with sentinel or identity origins — never as step2 frames — so `via_sync` cannot false-positive on them.
- **No backfill**: Historical step2-originated rows are indistinguishable after the fact; they remain `via_sync = null` ("unknown") and all consumers treat unknown as not-sync, preserving current behavior for old data.
- **Migration slot ownership**: This feature owns the single in-flight schema migration (timestamp > `1799600000000`). No other schema change ships with it.
- **Scope boundaries (owned elsewhere)**: The diff subsystem is entirely out of scope (feature 039 owns it, including any diff-side consumption of `via_sync`); restore/undo sentinel work and version-author display are out of scope (feature 040); per-change author attribution inside diffs is a separate product decision; reordering the publish-before-commit hot path is deliberately deferred (documented only, FR-018).
- **Existing enforcement timing is acceptable**: Role changes propagate to connection edit capability via the existing periodic re-check; this feature aligns step2 blocking with that mechanism rather than changing its timing.
- **Repeated-violation policy unchanged**: Blocked frames (update or step2) do not escalate to disconnection; the connection stays open, matching current blocked-edit behavior. Escalation/anomaly detection would be follow-on work (see the 034 detector follow-on).
