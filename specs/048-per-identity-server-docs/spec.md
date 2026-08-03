# Feature Specification: Per-Identity Server Docs

**Feature Branch**: `048-per-identity-server-docs`

**Created**: 2026-08-03

**Status**: Draft

**Input**: User description: "Converge code to the ratified design section 'Per-identity server docs' in `design/collaboration-core.md` (committed 6db8b761): the shared server WSSharedDoc stops authoring content operations; the six write paths still authoring on it move to ephemeral per-operation Y.Docs seeded from the shared doc and merged back with the same origin object."

**Design ground truth**: `design/collaboration-core.md`, section "Per-identity server docs" (Amendment Sam, 2026-08-03 — ratified design, not yet implemented). Per Constitution Principle VI, where this spec and that section disagree, the design section wins. This feature exists to satisfy Constitution Principle VII (v1.2.0, Horizontally Scalable App Pods) and the RBD-045-12 overturn recorded in `specs/045-resupply-attribution/clarifications-needed.md`.

## The problem (from the design contract)

Several server-side write paths transact directly on the one live shared document, so the content they create carries that document's single Yjs clientID while each durable row is stamped with whichever identity acted. One clientID accumulates many identities' writes. The 045 resupply resolver copes by poisoning clientIDs it knows belong to a shared doc, but that knowledge is process-local — leaving two residual confident-wrong-author paths (a binding left by a since-dead pod; two live pods giving different confident answers about the same row). Sam overturned the accepted-residual status on 2026-08-03: correctness must not depend on replica count, so the fix must be structural. After this feature, every Yjs clientID in the durable log maps to exactly one (user, agent) identity by construction, and the resolver's answers are the same on every pod.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - A server-side write can never be misattributed to another person (Priority: P1)

Users X and Y both work in a document through server-side operations (imports, title changes, chat image inserts, document seeds, restores). Today those operations all author under the document's one shared server identity; if any such write is lost in a crash and re-supplied by a browser, a reader on another pod can confidently display X as the author of Y's content. After this feature, every server-side operation authors under a fresh, one-shot identity bound to exactly the acting (user, agent) pair, so a confidently wrong author is impossible for new rows on any pod at any replica count.

**Why this priority**: This is the constitutionally required outcome (Principle VII) and Sam's standing attribution-first directive: a confident wrong author is worse than an honest refusal. Everything else in the feature exists to deliver or protect this.

**Independent Test**: Perform each of the six converged operations, decode the stored rows, and verify each row's payload carries a clientID distinct from the shared doc's and from every other operation's; verify the resupply resolver on a process with no in-memory knowledge of the writing process resolves those rows identically to the writing process (never to a wrong person).

**Acceptance Scenarios**:

1. **Given** a loaded document, **When** a server-side operation (import, title set, seed, image insert, restore, empty-import anchor) runs, **Then** the durable row's payload insert set contains a fresh clientID that is not the shared doc's clientID and the row is stamped with the acting (userId, agentName).
2. **Given** two consecutive server-side operations by the same identity, **When** both complete, **Then** their rows carry two distinct clientIDs (never a reused per-identity ID).
3. **Given** a server-side write under a plain user identity whose row is lost after broadcast and later re-supplied through a browser's sync handshake, **When** any pod resolves the resupplied row's authorship, **Then** it renders as the honest "Synced content" entry — never as another user who happened to write through the same document earlier.
4. **Given** the same document read on two different pods, **When** each resolves authorship for a post-cutover row, **Then** both give the same answer.
5. **Given** an operation whose update function throws, **When** the call fails, **Then** the shared document is left completely untouched (no partial mutation), and the error propagates to the caller.

---

### User Story 2 - Restore becomes one store-then-apply path with identical visible semantics (Priority: P2)

A user (or agent) restores a document to a previous version. Today the restore takes one of two paths — a live path that transacts on the shared doc and broadcasts before storing, or a durable-log path that computes on a temp doc. After this feature there is one path: compute the restore delta on an ephemeral doc seeded from the best trusted state, store the delta as the one attributed row, then broadcast it. The user sees the same restore semantics as today (non-destructive, single forward update, correct attribution, agent restores undoable), with the crash window flipped to the safer half.

**Why this priority**: Restore is one of the six paths and the only one whose ordering changes; unifying it deletes the live-path capture machinery and aligns restore with the already-conforming undo and sync-push patterns. It rides on US1's mechanism.

**Independent Test**: Restore a version on a document that is loaded in memory and on one that is not; verify both produce one attributed row whose stored bytes are exactly the broadcast bytes, that the restore lands for connected clients, and that an MCP restore remains undoable.

**Acceptance Scenarios**:

1. **Given** a document loaded in memory with a trusted live doc, **When** a restore runs, **Then** the delta is computed on an ephemeral doc seeded from the live doc's state, stored first, then broadcast under the restore origin — and the stored bytes are the applied bytes.
2. **Given** a document not loaded (or whose live copy is untrusted), **When** a restore runs, **Then** the delta is computed from the persisted log and the behavior matches today's durable-log path.
3. **Given** a concurrent edit landing during the restore's store await, **When** the restore broadcast applies, **Then** the edit merges with the restore rather than being replaced by it (the semantics the durable path and cross-pod restores already have).
4. **Given** a crash between the durable commit and the broadcast, **When** the document is next loaded, **Then** the restore row replays from the log (commit-without-broadcast — the safer half; nothing is lost).
5. **Given** an MCP restore by an agent, **When** the agent invokes undo, **Then** the restore is inverted exactly as today (edit record semantics unchanged; human web-UI restores remain non-undo-targets).

---

### User Story 3 - The invariant is pinned and the resolver keeps a fail-honest backstop (Priority: P3)

A future developer (or agent) adds or modifies a server-side write path. The invariant — the shared server doc's own clientID never authors a content operation — is enforced by automated guards that fail the suite on regression, and by the retained resolver live-peek poisoning as a production tripwire: if a path regresses anyway, its resupplied rows render as the honest "Synced content" on the authoring pod, never as a wrong author.

**Why this priority**: The invariant is only worth its cost if it cannot rot silently. Guards and the tripwire make regression loud in CI and honest in production.

**Independent Test**: Run the guard suite; introduce a deliberate direct transact on the shared doc in a scratch branch and observe the guards fail.

**Acceptance Scenarios**:

1. **Given** the guard suite, **When** `updateDocument` or `restoreVersion` emits an update whose insert set contains the shared doc's clientID, **Then** a test fails.
2. **Given** two consecutive `updateDocument` calls, **When** their updates are inspected, **Then** a test asserts they used distinct clientIDs.
3. **Given** an `updateDocument` call, **When** the caller's update function receives its document argument, **Then** a unit test asserts that document is not the shared doc.
4. **Given** the undo/redo inverse path and the sync-push path (already conforming), **When** the suite runs, **Then** pinning tests assert the inverse's store-then-apply one-shot clientID pattern and the sync push's pinned deterministic clientID (the documented exception) so neither drifts.
5. **Given** the resolver after cutover, **When** its wiring is inspected, **Then** the live-peek poisoning source, the durable chat-assistant-stamp source, and the 2+ identity ambiguity source are all still active (nothing deleted at cutover).

---

### Edge Cases

- **Half-loaded document** (amended at plan time per RBD-048-4 — the original "no new guard" wording restated a design silence that the post-spec adversarial review falsified with a reproduced lost-write): the mechanism MUST NOT seed from a document whose bind has not completed. `updateDocument` awaits a bind-readiness gate before seeding (FR-013); the other existing guards keep their jobs (the agent-presence content wait, live-doc trust for read-to-store paths), and the REST import route's loaded-wait is consolidated onto the same gate.
- **Bind failure between seed and merge**: caught by the retained post-merge `BindFailedError` check — a refused bind still fails the call instead of silently dropping the write.
- **No-change operation**: an update function that changes nothing produces no update event and no row, exactly as today.
- **Crash between merge and persist**: keeps the RBD-045-5 publish-before-commit posture, with one improvement — the lost operation's content, re-supplied by a browser, degrades to the honest "Synced content" entry (its only evidence row died with it) instead of feeding the shared-doc poisoning residuals.
- **Merge-back conflicts**: cannot occur — a fresh clientID cannot collide, and the CRDT merge is commutative.
- **Pre-cutover rows**: keep the old residual shapes, bounded to a fixed and aging population. No migration, no backfill, no rewriting of history.
- **Post-cutover assistant rows re-supplied**: still refused (rendered "Synced content") because no stamp-level discriminator exists between the assistant's session-doc writes and its per-operation-doc writes — an accuracy cost, never a wrong person (see RBD-048-1).
- **Concurrent same-identity operations (same pod or two pods)**: safe by construction — each operation's random clientID means no duplicate (clientID, clock) pairs, the CRDT-corruption hazard that made a stable per-identity clientID unacceptable.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001 (mechanism — the one implementation point)**: `documentService.updateDocument` MUST keep its signature and become the single implementation point for the per-operation mechanism: create a fresh Y.Doc (clientID random by construction — never pinned, never reused), seed it by applying the shared doc's current encoded state, run the caller's update function on the ephemeral doc inside one transaction, capture that transaction's update bytes, destroy the ephemeral doc, and merge the bytes into the shared doc with `Y.applyUpdate(sharedDoc, bytes, origin)` passing the same `{ userId, agentName }` origin object as today. Seed, transact, and merge MUST run synchronously with no awaits between them, so no local edit can interleave; the concurrency surface is unchanged from the direct transact this replaces.

- **FR-002 (random clientID is mandatory)**: each operation MUST use a fresh random clientID. A stable per-identity clientID is forbidden: it would mint duplicate (clientID, clock) pairs under same-identity concurrency (same pod or two pods) and duplicate pairs corrupt the CRDT. Many clientIDs mapping to one identity is fine; one clientID mapping to many identities is the defect this feature ends.

- **FR-003 (the six converging paths)**: the following write paths — the complete set still authoring on the shared doc today, per the design's traced inventory — MUST author through the per-operation mechanism, with no other call-site behavior change:
  1. Markdown import's one-transaction write (REST PUT import, MCP create_document, chat import_markdown; `server/markdown-import.js`).
  2. Document seed — meta title + seed nodes (`createSeededDocument`; MCP create, chat import, REST create, and the onboarding welcome doc, which stamps (user, "Squire Docs Assistant")).
  3. Title set (MCP `set_document_title`); no meta-only cheap path in v1.
  4. Empty-import anchor paragraph (`server/api/chat-tools.js`, `server/api/docs-import.js`, `server/mcp/tools/create-document.js`).
  5. Chat image insert (`insert_image` in `server/api/chat-tools.js`, stamped (user, "Squire Docs Assistant")).
  6. Restore, live path (`server/version-history.js`) — see FR-004.

  Paths that already conform MUST NOT be reworked: undo/redo inverses (fresh scratch doc, store-then-apply), the restore durable-log path (fresh temp doc), sync pushes (fork doc with a pinned deterministic clientID — the documented exception to the random-clientID rule, safe because idempotent retries need byte-identical updates and a collision resolves as an honest ambiguity refusal, never a wrong author), and browser/agent-session edits.

- **FR-004 (restore unification)**: the restore live path MUST stop transacting on the live doc. Restore becomes one path: compute the restore delta on an ephemeral doc seeded from the best trusted state (the trusted live doc when one is loaded here, per `server/live-doc-trust.js`; otherwise the persisted log), store the delta as the one attributed row, then broadcast it with `applyLiveUpdate` under the restore origin sentinel. The live-path capture machinery is deleted. The 041 invariant that the stored bytes are the applied bytes MUST still hold (they are the same bytes). Two consequences are accepted by design (RBD-048-2): the crash window flips from broadcast-without-commit to commit-without-broadcast (the durable row replays on next load — the safer half), and an edit landing during the store await merges with the restore instead of being replaced by it.

- **FR-005 (attribution, persistence, and fan-out unchanged)**: the shared doc's update event MUST fire with the merged bytes and the caller's origin object; the origin-scoped capture in `updateDocument` MUST still capture exactly this call's bytes (origin object identity); the persistence listener MUST still store one row stamped (userId, agentName); `via_sync` MUST stay unset for these writes; broadcast to this pod's connections and cross-pod fan-out (attached Redis handler or the explicit republish) MUST behave exactly as today. The post-merge `BindFailedError` check MUST be kept.

- **FR-006 (failure isolation improvement)**: a throwing update function MUST discard the ephemeral doc and leave the shared doc untouched, where a direct transact could leave a partial mutation applied.

- **FR-007 (invariant pins)**: the invariant — the shared server doc's own clientID never authors a content operation; everything reaching the shared doc is pre-encoded bytes — MUST be pinned three ways: (a) Jest guards asserting that `updateDocument` and `restoreVersion` emit updates whose insert set (via update-meta parsing) never contains the shared doc's clientID, and that consecutive calls use distinct clientIDs; (b) a unit test asserting the update function receives a doc that is not the shared doc; (c) the resolver's live-peek poisoning stays wired as the production backstop (fail-honest tripwire). Pinning tests MUST also be added for the already-conforming undo/redo inverse pattern and the sync-push pinned-clientID exception, so conformance cannot silently drift.

- **FR-008 (resolver transition — nothing deleted at cutover)**: the durable chat-assistant-stamp poisoning source stays (it covers every pre-cutover chat-surface row, including the onboarding welcome seed, which stamps the same identity and was missing from the 047 enumeration); post-cutover assistant rows are also still refused on resupply (accuracy cost, never a wrong person — unchanged 047 posture). The 2+ identity ambiguity source stays. The live-peek source becomes structurally unnecessary for new rows and is kept in v1 as the tripwire; deleting it and its init wiring is recorded cleanup once the invariant guards have soaked (RBD-048-3). Keeping this process-local knowledge is Principle VII compliant because it is defense in depth, not correctness-bearing.

- **FR-009 (undo/redo compatibility)**: undo and redo MUST need no changes — identity predicates match on row stamps plus the sync-channel guard, never on clientIDs, so rows written through per-operation docs remain the acting identity's own edits. Regression coverage MUST be added: an import and a title set made through the new mechanism remain undoable exactly as today.

- **FR-010 (presence unchanged)**: per-operation docs have no provider and no awareness and MUST NOT announce. The announcing wrappers stay where they are (REST imports through import-presence; MCP tools and chat modify through agent-presence sessions). Restore, undo, title sets, document seeds, and the chat image insert stay non-announcing. Import-presence's origin-filtered observation MUST keep working because the merge-back carries the same origin object.

- **FR-011 (correct the falsified record in code)**: per Principle VI, code comments and contract text asserting the overbroad claim that "every server-side write path transacts on the one live WSSharedDoc" (notably the module header of `server/resupply-resolution.js` and the restore residuals comment in `server/version-history.js` describing the live path's broadcast-then-store ordering) MUST be updated to match the corrected design record in the same effort.

- **FR-012 (scope boundary — stated so nobody over-reads this feature)**: this feature is a precondition for running more than one app replica, not the green light. It closes the attribution gates: RBD-045-12 residuals 1 and 2 for new rows, and the resolver FIFO-eviction finding (retired for new rows). It MUST NOT be represented as fixing, and does not touch: M3 (refused-bind + fast reconnect can leave the Redis subscription bound to the dead evicted doc) and M4 (cross-pod reconnect awareness blackout) from the 2026-08-03 pre-deploy review — both remain scale-out gates. Also unchanged: the RBD-045-5 durability window, cross-pod restore serialization (RBD-041-2), and undo supersession consulting only the local live doc. The one-replica deploy constraint stands until this feature and M3 and M4 all land.

- **FR-013 (bind-readiness gate — added at plan time per RBD-048-4)**: `updateDocument` MUST NOT read the shared doc's state for seeding until that doc's bind has completed. A single awaitable gate, owned by `document-service` and built on the binder's bind-complete signal, MUST: resolve immediately for a bound doc; fail the call with the existing bind-failure error for a doc whose bind was refused; and fail with a bounded timeout otherwise. The REST import route's separate loaded-wait MUST be replaced by this gate (one owner for the half-loaded question on write paths; the read-to-store trust predicate stays distinct). The gate sits strictly BEFORE the seed→transact→merge sequence, which remains synchronous (FR-001). A regression test MUST cover the missing test class: `updateDocument` against a doc whose bindState has not completed (the write must never land before, or be lost to, the in-flight persisted load).

### Out of Scope

- Pooled per-identity, per-document docs (recorded follow-on if profiling shows a hot path; generalizes the agent-presence session machinery).
- A meta-only cheap path for title sets (deferred, not designed; revisit only with profiling data).
- A stamp-level discriminator between the assistant's two write shapes (needs a migration; see RBD-048-1).
- Cross-instance propagation of learned shared-doc identities (rejected in RBD-045-12 and again by Principle VII's cache-only rule).
- Swapping the shared doc's clientID around a transact (rejected: mutates live shared state, fragile under observer reentrancy, leaves the invariant unpinned).
- M3 and M4 scale-out fixes; any change to the durability window, drain behavior, or replica count.
- Deleting the live-peek tripwire (v1 keeps it; deletion is recorded cleanup).

### Key Entities

- **Ephemeral per-operation doc**: a fresh Y.Doc created per server-side content operation, seeded from the shared doc's encoded state, transacted on once, destroyed after its update bytes are captured. Its random clientID is the one-shot authorship identity for that operation's row.
- **Shared server doc (WSSharedDoc)**: the live in-memory document; after this feature it only ever receives pre-encoded bytes (browser frames, Redis relays, db loads, merge-backs, live applies) and its own clientID never authors content.
- **Origin object `{ userId, agentName }`**: the attribution carrier; its object identity scopes the capture and its fields stamp the durable row. Unchanged.
- **Durable update row (`yjs_updates`)**: after cutover, every row written by a server-side operation carries a payload whose insert-set clientID binds to exactly one (user, agent) identity by construction.
- **Resupply resolver**: the read-side authorship resolver; its three poisoning/refusal sources are all retained (FR-008), with the live peek demoted from correctness-bearing to tripwire.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: For every row written by a server-side operation after cutover, the payload's authoring identity maps to exactly one (user, agent) pair, and authorship answers for such rows are identical on every process regardless of which process wrote them — verified by resolving the same rows on a process with no shared in-memory state with the writer.
- **SC-002**: A lost-then-resupplied server-side write renders as the honest "Synced content" entry on every pod — a confidently wrong author is impossible for post-cutover rows (0 occurrences constructible in the test matrix that previously produced them).
- **SC-003**: All six converged operations are behavior-identical from the user's perspective: same content outcome, same displayed attribution, same undo behavior (agent import and title set remain undoable), same presence behavior, same error surfaces. Full backend and affected client suites pass.
- **SC-004**: The guard suite fails when any guarded path emits an update authored under the shared doc's clientID or reuses a clientID across consecutive operations (verified by deliberate-regression check during review).
- **SC-005**: An operation whose update function throws leaves the document byte-identical to its pre-operation state (no partial mutation), on every converged path.
- **SC-006**: The resolver FIFO-eviction finding (2026-08-03 pre-deploy review LOW) is retired for post-cutover rows: evicting learned poisoning can no longer re-open a wrong-author path for them, because no new row depends on that knowledge.

## Assumptions

- **Accepted costs (per the ratified design)**: each server-side operation pays O(doc size) to seed the ephemeral doc — title sets go from O(1) to O(doc size); each operation adds one clientID to the document state vector forever (a few bytes per operation in every future sync exchange, the same order as browser tab churn). No performance gate blocks this feature; revisit only with profiling data.
- **No migration, no backfill**: pre-cutover rows keep their residual shapes; the durable stamp-based poisoning covers the chat-identity population retroactively.
- **Single-transaction atomicity of the seed→transact→merge sequence** relies on Yjs firing update events synchronously at transaction end and on the sequence containing no awaits — the same properties the current direct-transact capture already relies on.
- **Struct clientIDs survive `Y.applyUpdate`**, so the stored row's payload carries the ephemeral doc's clientID while its stamp carries the acting identity (stated by the design; the guard tests verify it empirically).
- **Deploy posture**: the one-replica constraint (RBD-045-12 overturn, pre-deploy checklist item 2) remains in force after this feature merges, until M3 and M4 also land.

## Sequencing & Interlocks

- This feature builds on the merged 041–047 train (resolver, live-doc trust, bind-failure handling, publish/capture machinery are all prior work it modifies or retains).
- The design section is committed at `6db8b761`; the constitution amendment and RBD-045-12 overturn at `8296e488`.
- Retires at cutover (for new rows): RBD-045-12 residuals 1 and 2; the resolver FIFO-eviction LOW. Leaves in place: M3, M4, RBD-045-5, RBD-041-2.
- Ledger: `specs/048-per-identity-server-docs/clarifications-needed.md` records the three pre-authorized decisions (RBD-048-1..3).
