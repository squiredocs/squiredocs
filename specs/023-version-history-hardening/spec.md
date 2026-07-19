# Feature Specification: Version History Hardening

**Feature Branch**: `023-version-history-hardening`

**Created**: 2026-07-19

**Status**: Draft

**Input**: User description: "Server-side hardening of the version-history persistence/read architecture, ratified by Sam 2026-07-19 (design/collaboration-core.md, two amendments dated 2026-07-19, commit db85ee7): per-document write serialization so clock order equals causal order; gap tolerance for every log-rebuild reader; replay as the sole source of truth with an O(rows) timeline; restore integrated into log-derived undo plus ratified dead-code deletion."

## Overview

The document clock — the per-document monotonic integer assigned to every persisted update — is the version coordinate the whole system shares: version ranges, diffs, restores, the MCP conflict guard, and design-sync frontmatter all speak clocks. The 2026-07-19 version-history deep dive found the write side gives that coordinate no ordering guarantee, the read side's gap tolerance covers only one of its several readers, the timeline is the most expensive read in the app (it re-replays the whole log with a full-document serialization per update on every request), named-version snapshots can freeze a bad read as truth forever, and a restore is invisible to the undo system.

Sam ratified the fix contract 2026-07-19 as two design amendments in `design/collaboration-core.md` (commit db85ee7): **"clock order is causal order (feature 023)"** and **"replay is the sole source of truth; timeline scales O(rows); restore is undoable (feature 023)"**. This spec converges to those amendments. The 2026-07-19 hotfix bundle (commits bf849ed..4022c93 — previousClock inversion, ORIGIN_RESTORE single-persist sentinel, export clock atomicity, typed errors/validation, doc-scoped SQL, rate limiting) is already landed and is a dependency, not part of this feature.

Four workstreams:

1. **Per-document write serialization** — `storeUpdate` (server/postgres-persistence.js) races MAX+1 under the fire-and-forget persistence listener (server/index.js bindState); a later update can take an earlier clock: contiguous rows, undetectable by gap scans, permanently mislabeling that coordinate for every version, diff, restore, and conflict-guard read.
2. **Gap tolerance for every log-rebuild reader** — 021's gap detect+retry lives only in `getYDoc`; the other five log-rebuild readers integrate past a gap silently, and two of them (diff cache, named-version snapshots) could freeze the gapped result.
3. **Replay as the sole source of truth + O(rows) timeline** — drop `document_versions.snapshot_data` (named versions become pure clock-range labels; version content always replays) and persist the "meaningful update" classification at write time so the timeline stops re-replaying the log per request.
4. **Restore integration + cleanup** — every restore records an undo-invertible edit record and both restore surfaces (REST and MCP) converge on identical attribution and broadcast semantics; ratified dead code and the write-once-never-read `yjs_state_vectors` table are deleted.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - The version coordinate always tells the truth (Priority: P1)

A document under active editing — rapid typing, an agent applying a multi-step modify, several collaborators at once — accumulates updates whose clocks reflect the order the edits actually happened. When a collaborator later opens version history, diffs two points, restores a version, or an agent's conflict guard compares clocks, the coordinate system they all share is causally correct: no update ever sits at a clock earlier than an update it causally follows.

**Why this priority**: Every other version-history behavior (timelines, diffs, restore, undo ranges, conflict guards) consumes clocks as ground truth. A misordered clock is permanent, silent corruption of that ground truth — contiguous rows that no gap scan can detect — and it poisons every downstream read forever. Nothing else in this feature matters if the coordinate itself can lie.

**Independent Test**: Drive concurrent bursts of causally ordered updates at one document (many in-flight persists racing) and verify that for every pair of updates where one was produced after the other on the same editing stream, the later one holds the strictly higher clock; replaying to any clock reproduces exactly a state that actually existed.

**Acceptance Scenarios**:

1. **Given** a document receiving a rapid sequence of updates from one editing stream (fire-and-forget persistence, many writes in flight), **When** all writes settle, **Then** the persisted clocks are in the exact order the updates were produced — under repeated stress runs, zero inversions.
2. **Given** two updates U1 and U2 where U2 causally depends on U1 (produced later on the same stream), **When** both are persisted — even by different server instances — **Then** U2's clock is strictly greater than U1's.
3. **Given** an undo/redo operation whose atomic claim-and-insert transaction (feature 016) holds a claimed clock while it commits, **When** ordinary updates for the same document arrive concurrently, **Then** both complete without deadlock or starvation, and the inverse row's clock respects the same ordering guarantee.
4. **Given** a persistence failure for one update after retries, **When** later updates for the same document are queued behind it, **Then** the failure still pages the exception notifier (existing data-loss alarm) and later updates still persist in order — one poisoned update cannot silently wedge a document's persistence.

---

### User Story 2 - No history reader ever builds on a torn read (Priority: P2)

A collaborator opens a version preview, requests a diff, drills into a timeline, or asks the chat to undo an agent edit while other edits are still being persisted. Every one of those reads either sees a complete, contiguous slice of the update log or briefly waits for one — and if a read must be served incomplete after the bounded retry budget, the result is served transparently and is never frozen into a cache or a stored artifact as truth.

**Why this priority**: 021 proved the torn-read failure mode is real (a headings-only skeleton of a 6KB doc) and fixed it — but only for `getYDoc`. Five other readers rebuild from the log with no gap tolerance, and two of them (the diff cache, and until workstream 3 lands, named-version snapshots) can make a transient tear permanent. The code's own "single choke point" claim is currently false.

**Independent Test**: Inject a clock gap (delay one row's visibility) while exercising each log-rebuild read surface — version content at a clock, diff between two clocks, timeline, undo inverse computation — and verify each one detects the gap, retries within the bounded budget, and never caches or persists a result computed from the gapped row set.

**Acceptance Scenarios**:

1. **Given** an in-flight write making rows {…k, k+2…} momentarily visible, **When** any log-rebuild reader (version content at clock, diff-side state builds, timeline replay, undo inverse log load) fetches the rows, **Then** it detects the non-contiguity and retries within the same bounded, environment-tunable budget getYDoc uses today.
2. **Given** a diff request whose row fetch is still gapped after the retry budget, **When** the diff is served, **Then** the served result is NOT written to the diff cache — the next request recomputes from a healed log.
3. **Given** a gap-free read, **When** any of these surfaces serve it, **Then** behavior and latency match today's (detection cost is a single pass over already-fetched rows; no added waits).
4. **Given** the serialized writer of Story 1 in place, **When** the gap machinery runs, **Then** it remains active as defense in depth (cross-instance races and crash windows can still tear a read) and the two mechanisms compose without pathological interaction (no retry storms against a briefly-held write serialization).

---

### User Story 3 - A named version can never disagree with the log (Priority: P2)

A collaborator names a version, then months later previews or restores it. The content shown is exactly what replaying the update log to that version's end clock produces — always, by construction, because there is no second copy of the content to disagree. If a transient bad read happened the day the version was named, it healed instead of being baked in forever.

**Why this priority**: A frozen snapshot that captured a gapped or misordered read is permanent silent corruption presented with full confidence. Replay self-heals under the gap machinery; a blob cannot. This also removes the only content-bearing duplicate of the log, making "the log is the source of truth" literally true.

**Independent Test**: Name a version, verify its stored form carries no content payload, and verify preview/restore/diff of that version replays the log — including for named versions created before this feature ships.

**Acceptance Scenarios**:

1. **Given** a collaborator naming a version at clock C, **When** the named version is stored, **Then** it is stored as a pure clock-range label (name, range, creator, timestamp) with no content snapshot.
2. **Given** any named version — including ones created before this feature, **When** its content is previewed, diffed, or restored, **Then** the content is produced by replaying the update log to its end clock under the gap-tolerant read path.
3. **Given** the schema migration has run, **When** existing named-version rows are inspected, **Then** their labels (name, clock range, creator, timestamps) are fully preserved and the content column is gone.
4. **Given** a hypothetical pre-existing snapshot that had diverged from replay (a frozen bad read), **When** the version is viewed after migration, **Then** the replayed (correct) content is shown — replay wins by ratified design.

---

### User Story 4 - The timeline stays fast as documents grow (Priority: P2)

A collaborator opens version history — or an agent lists versions over MCP — on a long-lived document with thousands of updates. The timeline appears quickly, because building it reads per-update metadata rows instead of replaying the entire document content once per update on every request.

**Why this priority**: The timeline is currently the most expensive read in the app — O(log × doc size) per request, recomputed every time, with MCP pagination applied only after the full computation. It degrades exactly on the documents users care most about (old, large, heavily edited). Persisting the meaningful/noise classification at write time — where the persistence path already has the before/after context — makes history O(rows) and erases the replay-cost argument for snapshots (Story 3's enabler).

**Independent Test**: Build a document with a large update log, request the timeline, and verify the request performs no per-update document replay and its cost scales with row count; verify classification of new updates at write time matches what the replay-based method would have concluded.

**Acceptance Scenarios**:

1. **Given** a new update being persisted, **When** the write completes, **Then** the update's meaningful-vs-noise classification (does it change visible content?) is durably recorded with it, computed from the before/after context the persistence path already has.
2. **Given** a timeline or version-list request, **When** it is served, **Then** it is computed from stored rows and their persisted classification — no full-log content replay, no per-update serialization — and its cost grows with the number of updates, not with update count × document size.
3. **Given** updates persisted before this feature (no stored classification), **When** the backfill has run, **Then** they carry a classification consistent with the replay-based method; **and** any row whose classification is unknown (backfill pending or interrupted, or written by an old instance during the deploy window) is treated as meaningful — history may temporarily show noise, but never hides a real edit.
4. **Given** an MCP versions listing with pagination, **When** a page is requested on a large document, **Then** the request cost is independent of the document's content size.
5. **Given** the classification exists at write time, **When** future checkpoint/compaction work is considered, **Then** nothing this feature ships forecloses it: the log remains append-only and authoritative, and the import path's reconstruction guard pattern remains intact.

---

### User Story 5 - A restore is a first-class, undoable edit on every surface (Priority: P3)

A collaborator (or an agent) restores a version and immediately regrets it. The chat Undo inverts the restore surgically — edits made after the restore are preserved — exactly as it inverts an agent modify. Whether the restore came from the app's UI or from an agent's MCP tool, it carries the same attribution, lands in the same edit-record system, and appears live to every connected collaborator without a reload.

**Why this priority**: Today a restore is invisible to the undo system and un-undoable except by counter-restore, and the two restore surfaces have drifted (the REST surface omits agent attribution and silently skips broadcasting when the document isn't loaded on the serving instance). P3 because it builds on Stories 1–4's foundations but is user-visible safety.

**Independent Test**: Restore a version via each surface; verify an edit record with the performing identity and the restore's clock range exists, chat Undo inverts it, and collaborators connected on any instance see the restore live.

**Acceptance Scenarios**:

1. **Given** a restore performed via either surface (REST route or MCP tool), **When** it completes, **Then** an edit record (same system agent modifies use) exists carrying the performing identity — the human user for a UI restore, user + agent name for an agent restore — and the restore update's clock range.
2. **Given** a completed restore, **When** the user invokes chat Undo, **Then** the restore is inverted as a normal forward update under feature 016 semantics: later edits are preserved, content already superseded by later edits is skipped rather than resurrected, and a fully superseded restore yields an honest "nothing left to undo".
3. **Given** collaborators connected to any server instance (including one that does not have the document loaded in memory where the restore is served), **When** a restore completes on either surface, **Then** every connected collaborator sees the restored content live, without reloading — the current silent-skip-broadcast path is eliminated.
4. **Given** the two surfaces, **When** their behavior is compared, **Then** attribution recording, edit-record creation, broadcast behavior, and response semantics are identical for equivalent restores (they converge on one shared core).
5. **Given** the ORIGIN_RESTORE single-persist hotfix already landed, **When** a restore completes, **Then** exactly one update row is persisted for it (regression-guarded, not re-implemented).

---

### User Story 6 - The version-history machinery carries no dead weight (Priority: P4)

A developer (or agent) reading the version-history code finds only code that runs. The ratified dead code — metadata enrichment never called, two never-called persistence readers, a never-called cache invalidator, a write-once-never-read database table, and an unused client extension — is gone, and the schema no longer accumulates state-vector rows nobody reads.

**Why this priority**: Ratified by the deep dive; zero user-facing behavior change, but every dead path is a place the other five stories' guarantees would silently not apply (e.g., a dead reader that looks like a live gap-tolerance gap). Removal makes the hardening surface enumerable and the "every reader" claims verifiable.

**Independent Test**: Verify the listed functions/files/table no longer exist, no reference to them remains anywhere, the full test suite passes, and no runtime path writes to the dropped table.

**Acceptance Scenarios**:

1. **Given** the cleanup has landed, **When** the codebase is searched, **Then** `enrichVersionsWithMetadata`/`extractMetadata` (server/version-history.js), `getYDocWithHistory` and `getStateVectorsAtClocks` (server/postgres-persistence.js), `DiffService.invalidateCache` (server/diff-service.js), and `client/src/extensions/YChangeExtension.js` are deleted with no remaining references.
2. **Given** the schema migration has run, **When** the database is inspected, **Then** the `yjs_state_vectors` table is dropped and every code path that wrote to or deleted from it (first-update write in storeUpdate, clearDocument, clearAll, onboarding welcome-doc reset) no longer references it.
3. **Given** the deletions, **When** the full backend and frontend suites run, **Then** they pass — nothing live depended on the removed code.

---

### Edge Cases

- **Concurrent writes during the serialization rollout**: during a rolling deploy, old instances persist with the raw MAX+1 race while new instances serialize. The window's exposure is exactly today's steady-state risk (no regression), and the chosen mechanism must not deadlock or misbehave when an unserialized peer races it. No freeze/maintenance window is required (ledger D-8).
- **Cross-instance causal writes**: a client can produce update U1 against instance A, reconnect, and produce U2 (causally after U1) against instance B while A's persist is still in flight. The ordering invariant (FR-001/FR-002) covers this; a purely instance-local queue alone does not — mechanism choice is plan-phase but must satisfy the cross-instance scenario.
- **The 016 claim transaction**: finalizeClaim inserts the inverse row via storeUpdate on its own transaction's client, holding the claimed clock until commit. The serialization mechanism must compose with a writer that (a) runs inside a caller-owned transaction and (b) can hold its clock claim across other work — no deadlock, no ordering violation, no starvation of ordinary updates.
- **Existing snapshot_data rows at migration time**: labels are preserved, blobs are dropped without backfill (replay reproduces content). A snapshot that had silently diverged from replay heals — displayed content may change, and replay wins by ratified design.
- **Backfilling the meaningful flag**: historical rows are classified by a one-time backfill (one replay pass per document, using the same classification the write path uses). Interrupted/pending backfill and rows written by old instances during the deploy window are handled by the fail-visible default: unknown classification ⇒ meaningful (never hide a real edit). The backfill must be resumable/idempotent.
- **Gap-retry interaction with the serialized writer**: serialization makes same-instance tears rare but cross-instance commit races and crash windows remain; gap machinery stays as defense in depth. A reader retrying while a writer briefly holds the serialization must not amplify into a retry storm (bounded budget already caps this).
- **Restore-undo supersession**: a restore followed by later edits undoes partially (later edits preserved, superseded parts skipped); a fully superseded restore yields "nothing left to undo"; undoing a restore then redoing it follows the existing 016 redo chain (invert the inverse). A counter-restore performed instead of undo is itself a new restore with its own edit record.
- **Restore of a named version vs. clock version after snapshot drop**: both resolve through the same replay path; an out-of-range clock or foreign version id still yields the typed not-found error (hotfix bundle behavior preserved).
- **First update of a new document**: storeUpdate's first-update branch currently writes the state-vectors row; after the table drop, document birth must work identically without it (creation, first read, onboarding reseed).
- **Poisoned update in an ordered queue**: if one update terminally fails persistence, the existing CRITICAL page fires; the mechanism must define whether subsequent queued updates proceed (they must — Yjs updates tolerate a missing peer update at read time; the alternative silently wedges the document forever).
- **Diff of identical clocks / empty ranges under the new classification**: a version whose range contains only noise rows (all classified non-meaningful) must not surface as an empty phantom version in the timeline (matches today's filtered behavior).

## Requirements *(mandatory)*

### Functional Requirements

**Write serialization — clock order is causal order (US1)**

- **FR-001**: Update persistence MUST be serialized per document such that any two causally ordered updates (produced in sequence on the same editing stream) receive strictly increasing clocks — clock order equals causal order by construction. Causally concurrent updates (true CRDT concurrency) may take either order.
- **FR-002**: The ordering guarantee of FR-001 MUST hold in multi-instance deployments, including the reconnect-to-another-instance case where the earlier update's persist is still in flight. The mechanism (per-document ordered queue, advisory lock, or combination — the design amendment offers both) is a plan-phase choice, but the cross-instance scenario is part of the contract it must satisfy.
- **FR-003**: The serialization mechanism MUST compose with the feature-016 claim transaction (storeUpdate invoked on a caller-owned client inside an open transaction): no deadlock, no starvation of ordinary updates, and the inverse row participates in the same ordering guarantee.
- **FR-004**: Serialization MUST NOT convert the existing failure semantics into silent loss or a wedged document: a terminally failing update still pages the exception notifier (existing CRITICAL path), and subsequently produced updates for that document still persist, in order.
- **FR-005**: Fire-and-forget persistence latency for the common (uncontended) case MUST NOT regress meaningfully: a single writer on a document experiences no added round-trips or waits beyond the mechanism's bookkeeping.
- **FR-006**: Graceful-shutdown flushing of in-flight writes (existing pendingWrites tracker) MUST continue to cover queued-but-not-yet-started writes under the new mechanism.

**Gap tolerance for every log-rebuild reader (US2)**

- **FR-007**: Every read path that rebuilds state from a contiguous slice of the update log MUST detect non-contiguous clocks in its fetched rows before serving. The covered readers are, exhaustively: full-document rebuild (already covered by 021), point-in-time rebuild (`getYDocAtClock`), the diff service's row fetch and both per-clock state builds, the timeline/classification replay paths that remain after US4, and the undo inverse's log load. This may be achieved by extending detection to each path or by funneling them through the single hardened choke point — plan decides — but after this feature the code's "single choke point" claim MUST be true of whatever shape ships.
- **FR-008**: On detecting a gap, each covered reader MUST retry within the same bounded, environment-tunable budget established by 021 (shared configuration; no per-path bespoke knobs), and MUST serve gap-free results with today's exact behavior and no added latency.
- **FR-009**: A result computed from a still-gapped row set after the retry budget MUST never be cached, persisted, or otherwise frozen as authoritative. Specifically: the diff service MUST NOT write a gapped computation to its cache; no stored artifact (edit record ranges, classifications, named-version labels) may be derived from a gapped read. Serving-only paths (live document load) retain 021's serve-as-is-with-observable-warning semantics.
- **FR-010**: Gapped serves and gap-retry exhaustion MUST remain observable (structured log lines consistent with 021's existing warning format), per covered reader.

**Replay is the sole source of truth (US3)**

- **FR-011**: Named versions MUST be stored as pure clock-range labels (name, clock range, creator, timestamps). Creating a named version MUST NOT build or store a content snapshot.
- **FR-012**: All version-content reads (preview, restore source, diff sides, MCP reads) MUST produce content exclusively by replaying the update log under the gap-tolerant read path. No code path may serve version content from a stored blob.
- **FR-013**: A schema migration MUST drop the named-version content column (`document_versions.snapshot_data`), preserving all label fields of existing rows. No content backfill is required — replay reproduces the content, and replay wins over any diverged frozen snapshot by ratified design.
- **FR-014**: This feature MUST NOT foreclose future checkpoints/compaction (explicitly deferred by Sam, Q5): the update log remains append-only and authoritative, and the import path's reconstruction forward-guard pattern (`canReconstruct`) is preserved.

**O(rows) timeline — persisted classification (US4)**

- **FR-015**: The meaningful-vs-noise classification of each update (does it change visible document content?) MUST be computed and durably recorded at write time, using the before/after context available on the persistence path. Its result MUST match what the existing replay-based filter would conclude for the same update.
- **FR-016**: Timeline and version-list operations MUST be computed from stored rows and persisted classifications, with no full-log content replay and no per-update document serialization; their cost MUST scale with the number of update rows (O(rows)), independent of document content size.
- **FR-017**: Historical rows MUST be backfilled with classifications by a one-time, idempotent/resumable process using the same classification semantics. At read time, a row with unknown classification MUST be treated as meaningful (fail-visible: noise may temporarily appear; real edits are never hidden).
- **FR-018**: The write-time classification MUST NOT block or fail update persistence: a classification failure degrades to unknown (⇒ meaningful at read time) and is logged, never propagated into the persistence result.
- **FR-019**: Versions whose entire range is classified as noise MUST NOT appear as phantom entries in the timeline (parity with today's filtered output), and total-edit counts MUST count meaningful updates as today.

**Restore integration (US5)**

- **FR-020**: Every restore, on every surface, MUST record an edit record in the same system agent modifies use (agent_edits via the shared edit-record path), carrying the performing identity (user; plus agent name when an agent performs it) and the restore update's durable clock range, so log-derived undo can invert it.
- **FR-021**: Chat Undo (and the MCP undo tool — same handler) MUST be able to invert a restore under feature-016 semantics: surgical inverse as a normal forward update, later edits preserved, superseded content skipped, fully-superseded restore yields the honest "nothing left to undo", and redo derives by inverting the inverse.
- **FR-022**: The REST and MCP restore surfaces MUST converge on one shared core with identical semantics: identical attribution recording (the performing identity, human or agent), identical edit-record creation, identical broadcast behavior, and identical error/response contracts for equivalent inputs.
- **FR-023**: A completed restore MUST become visible to every connected collaborator on every instance without a reload — including when the serving instance does not hold the document in memory. The current silent-skip (persist-only, no broadcast) path MUST be eliminated; if delivery genuinely cannot occur, the outcome is observable, never silent.
- **FR-024**: Restore MUST remain single-persist (exactly one update row per restore — the landed ORIGIN_RESTORE hotfix), protected by a regression test rather than re-implemented.

**Cleanup (US6)**

- **FR-025**: The ratified dead code MUST be deleted with no remaining references: `enrichVersionsWithMetadata` and `extractMetadata` (server/version-history.js), `getYDocWithHistory` and `getStateVectorsAtClocks` (server/postgres-persistence.js), `DiffService.invalidateCache` (server/diff-service.js), and `client/src/extensions/YChangeExtension.js`.
- **FR-026**: A schema migration MUST drop the `yjs_state_vectors` table, and every code path that writes to or deletes from it (storeUpdate's first-update branch, clearDocument, clearAll, the onboarding welcome-doc reset) MUST be updated so document birth and deletion work identically without it.
- **FR-027**: All schema migrations in this feature MUST be numbered after the current highest migration (1798000000000) — automatically satisfying the ratified constraints (> 1795000000000 and after the 1796* undo migrations). Feature 023 is the sole in-flight feature adding migrations; no other concurrent feature may add any.

### Key Entities

- **Update log row (`yjs_updates`)**: one persisted document update, keyed (document, clock), with user/agent attribution and sync provenance. Gains a durable meaningful-vs-noise classification recorded at write time (new column or side table — plan decides shape). The clock becomes causally ordered by construction.
- **Named version (`document_versions`)**: becomes a pure label — name, clock range, creator, timestamps. Loses its content snapshot; its content is always the replayed log state at its end clock.
- **Edit record (`agent_edits`)**: the feature-016 undo ledger. Now also receives one record per restore (either surface), making restores undo-invertible peers of agent modifies.
- **State-vector row (`yjs_state_vectors`)**: write-once-never-read; deleted entirely (table and all writers).
- **Version timeline**: derived view grouping meaningful updates into versions by inactivity gaps, merged with named-version labels; after this feature it is a pure function of stored rows + persisted classifications.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: Under repeated concurrent-write stress runs (rapid causally ordered update bursts, multiple in-flight persists), the persisted clock order matches production order with zero inversions, and replay at every clock reproduces a state that actually existed.
- **SC-002**: With injected mid-commit visibility gaps, every history read surface (version content, diff, timeline, undo inverse) either returns the complete result within the bounded retry budget or observably serves/degrades without freezing the incomplete result — zero cached or stored artifacts derived from a gapped read across the test matrix.
- **SC-003**: Timeline/version-list requests on a document with a 10,000-update log complete with cost scaling linearly in row count and independent of document content size — concretely, at least an order-of-magnitude latency improvement over the pre-023 implementation on the same large-document fixture, with zero full-log replays observed per request.
- **SC-004**: 100% of restores across both surfaces produce an edit record with correct identity and clock range; chat Undo successfully inverts a fresh restore in end-to-end tests, and the supersession matrix (partial, full, redo-after-undo) behaves per feature-016 semantics.
- **SC-005**: Content served for any named version equals the replayed log state at its end clock in 100% of property-test comparisons — before and after the migration, including versions created pre-023.
- **SC-006**: Restores become visible to connected collaborators on all instances in under 2 seconds in multi-instance tests, with zero silent no-broadcast outcomes.
- **SC-007**: Repository-wide search finds zero references to the deleted functions, file, and table; the full backend and frontend suites pass after deletion; single-writer persistence latency shows no meaningful regression (within noise of pre-023 baseline).

## Dependencies & Sequencing

- **Depends on (already landed, not re-specced)**: the 2026-07-19 hotfix bundle (bf849ed..4022c93) — previousClock inversion fix, ORIGIN_RESTORE single-persist sentinel, export clock atomicity, typed VersionNotFoundError/validation, doc-scoped SQL for named versions, rate limiting. This feature builds on and regression-guards these, never reverts them.
- **Depends on**: feature 016 (log-derived undo — edit records, claim transactions, inverse semantics) and feature 021 (gap detect/retry machinery and its configuration knobs).
- **Sequencing within the feature**: US1 (write serialization) underpins everything and lands first; US4's write-time classification is a prerequisite for dropping snapshots' performance rationale, so US4 lands before or with US3's migration; US5 and US6 are independent of each other. Migration constraint FR-027 applies to all three schema changes (classification storage, snapshot_data drop, yjs_state_vectors drop).
- **Coordination**: feature 023 is the only in-flight feature permitted to add migrations; feature 024 must not add any.

## Out of Scope

- Checkpoints/compaction of the update log (explicitly deferred by Sam, Q5 — this feature must merely not foreclose them).
- Re-implementing anything in the 2026-07-19 hotfix bundle.
- Client-side version-history UI changes (beyond deleting the unused YChangeExtension); timeline visual presentation is unchanged.
- Changing version-grouping semantics (5-minute inactivity threshold, named-version splitting, author aggregation, on-behalf-of provenance) — the timeline's outputs are preserved, only its cost model changes.
- The y-tiptap viewer-deletion follow-ups tracked under 021 and the getYDoc clock-gap transient-empty-read ticket beyond what FR-007..010 cover.
- New public API surfaces; all changes are behind existing endpoints and tools.

## Assumptions

- The two 2026-07-19 design amendments in `design/collaboration-core.md` (commit db85ee7) are the ratified ground truth; where this spec elaborates beyond them, the elaboration is recorded as RATIFIED-BY-DEFAULT in `clarifications-needed.md` (Sam pre-authorized, 2026-07-19).
- Causal order is defined per editing stream (the order updates were produced/observed by the persisting server); true CRDT-concurrent updates have no causal order between them and either clock order is correct.
- The dead-code list was re-verified against the current tree (2026-07-19): no live callers exist for any listed item outside their own definitions and tests.
- Data volumes are beta-scale: a one-time classification backfill replaying each document once is feasible using the established backfill pattern (statement-timeout opt-out); the backfill is idempotent so it can resume after interruption.
- Rolling deploys are the norm; a mixed-version window during rollout is acceptable because its exposure equals today's steady state (see Edge Cases and ledger D-8).
- Backend tests run serially against the shared test database (constitution II); new migrations heal per the established migration-cruft guard (migrate.js).
