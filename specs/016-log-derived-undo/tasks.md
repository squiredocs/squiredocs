# Tasks: Log-Derived Agent-Edit Undo/Redo

**Input**: Design documents from `/specs/016-log-derived-undo/`

**Prerequisites**: plan.md, spec.md, research.md (CRDT strategy R1–R11), data-model.md,
contracts/ (http-undo-api.md, mcp-undo-redo-tools.md), quickstart.md,
clarifications-needed.md (RBD-1..10 — decided; do not re-litigate).

**Tests**: REQUIRED — the spec mandates test-backed scenarios (SC-001..SC-011) and
Constitution II makes tests the only reviewer. Tests are written FIRST within each
phase and must fail before their implementation task. Backend Jest runs **serially**
(shared DB; never concurrent runs). Client Vitest.

**Hard constraints for every task**: never mutate existing `yjs_updates` rows; no
presence session may be created/extended/consulted by undo, redo, or undo-status; no
new external dependencies; struct-identity targeting only (Constitution IV); new
migration timestamps MUST exceed 1795000000000.

## Format: `[ID] [P?] [Story] Description`

---

## Phase 1: Setup (Shared Infrastructure)

**Purpose**: schema + write-path primitives every story needs.

- [X] T001 Create migration `migrations/1796000000000_create-agent-edits.js`: table
      `agent_edits` exactly per data-model.md §1 (columns, `CHECK` on `state`,
      `UNIQUE (doc_guid, user_id, agent_name, edit_clock_start)`, the two indexes;
      `user_id` typed to match `yjs_updates.user_id`), with `exports.down`. Run
      `npm run migrate` against the dev DB to verify it applies.
- [X] T002 [P] Add `ORIGIN_INVERSE_APPLY` sentinel to `server/origin.js`
      (parseOrigin → null; exported; NOT added to the Redis publish skip-list in
      `server/index.js` — verify the skip-list at `server/index.js:1936-1943` still
      names only `ORIGIN_REDIS`/`ORIGIN_DB_LOAD`) and extend
      `server/__tests__/origin.test.js` to cover it (research R3).
- [X] T003 [P] Extend `PostgresPersistence.storeUpdate` in
      `server/postgres-persistence.js` with an optional external-client parameter so
      the insert (including its max+1 / ON CONFLICT retry loop) can run inside a
      caller-owned transaction; behavior without the parameter must be byte-identical
      (research R6). Covered by T007 tests.

**Checkpoint**: migration applies; sentinel semantics proven; transactional insert
available.

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: the log-derived core — edit-identifier capture, the `agent_edits`
records, and the inverse computation. BLOCKS all user stories.

- [X] T004 [P] Write failing tests `server/mcp/__tests__/yjs/edit-range.test.js`:
      payload capture during a scripted edit; durability coverage check confirms only
      when identity rows cover all captured struct ranges AND delete-sets
      (`parseUpdateMeta` + `decodeUpdate` — research R2); deletion-only edit covered;
      unrelated same-identity rows (different clientID / pre-baseline struct clocks)
      excluded; bounded-wait timeout path returns null.
- [X] T005 [P] Write failing tests `server/undo/__tests__/edit-records.test.js`
      (test DB): insert-on-record; latest-active lookup; LIFO stepping query
      (skip undone); redo pick by `last_undone_at DESC`; at-most-once claim — two
      concurrent undo claims on one row, exactly one `rowCount=1`
      (`WHERE state='active'`); redo claim symmetric; legacy first-undo
      `INSERT ... ON CONFLICT DO NOTHING` arbitration; claim + inverse-row insert +
      target update commit/rollback atomically in one transaction (uses T003).
- [X] T006 Implement `server/mcp/yjs/edit-range.js`: `captureEditUpdates(sessionDoc)`
      (subscribe/unsubscribe, collect payloads) and
      `awaitDurableRange(persistence, docGuid, identity, baselineClock, payloads,
      { timeoutMs })` → `{ clockStart, clockEnd } | null`, per research R2 and RBD-8.
      Makes T004 pass.
- [X] T007 Implement `server/undo/edit-records.js`: `recordEdit`, `claimUndo`,
      `claimRedo`, `finalizeClaim` (single-transaction claim + storeUpdate-with-client
      + target-range write per research R6), `latestEdit`, `nextUndoTarget`,
      `nextRedoTarget`, `insertLegacyUndone`. Makes T005 pass.
- [X] T008 [P] Write failing unit tests `server/undo/__tests__/inverse.test.js` (pure
      Y.Doc fixtures + fabricated row arrays, no DB): basic insert-edit inverse;
      basic delete-edit inverse restores content; multi-row edit (several updates)
      inverts as one unit; interleaved foreign rows inside the range are never
      inverted (FR-001/FR-029); returns null (honest empty) when the edit is fully
      superseded; inverse update is the minimal transaction payload (captured from
      the scratch doc's `update` event, not a full-DeleteSet state diff).
- [X] T009 Implement `server/undo/inverse.js` per research R1: gc-off scratch rebuild
      in clock order; replica `Y.UndoManager` scoped to the `'default'` fragment with
      `trackedOrigins` sentinel + `captureTimeout: Number.MAX_SAFE_INTEGER`; tracked
      apply of identity rows in `[s,e]`, untracked history/foreign rows; optional
      live-doc state merge before popping (FR-013/RBD-9); `undo()` + captured update
      event → `computeInverse(rows, range, identity, liveDoc?) →
      { inverseUpdate } | null`. Public yjs API only. Makes T008 pass.
- [X] T010 Implement modify integration in `server/mcp/tools/modify.js`: capture
      payloads across script + all sanitization passes; when `changed`, await durable
      range (T006), add `editRange` to the result, insert the `agent_edits` row
      (T007); on timeout return `editRangePending: true` and complete recording in
      the background (RBD-8); `changed:false` records nothing; existing `clock` field
      untouched (RBD-1).
- [X] T011 Write tests `server/mcp/__tests__/tools/modify-edit-range.test.js`
      (test DB + real tool handler): result carries `editRange` selecting exactly the
      call's rows (multi-update edit incl. a sanitization-pass mutation → range spans
      all rows); `agent_edits` row inserted with `state='active'`; `changed:false` →
      no identifier, no row; identifier only appears after rows are durably readable
      (FR-004); baseline `clock` field unchanged; assert the result object — which
      the chat layer persists verbatim as the tool part's output — carries
      `editRange`, satisfying the part-level record half of FR-002. (Tests may be
      written alongside T010 but must fail against pre-T010 modify.)

**Checkpoint**: core primitives proven — user stories can begin.

---

## Phase 3: User Story 1 — Undo that always works: any instance, any time, any restart (P1) 🎯 MVP

**Goal**: chat + MCP undo derive from the log via `undo-service`, work with no
session, from any instance, after restarts; sessions are never created.

**Independent Test**: two persistence-sharing "instances" (independently loaded doc
state, one DB): edit via A, undo via B succeeds; edit → simulated restart (fresh
provider/doc, zero sessions) → undo succeeds; zero presence sessions created.

### Tests for User Story 1

- [X] T012 [US1] Rewrite `server/mcp/__tests__/integration/undo-redo-workflow.test.js`
      (failing first) around the log-derived flow: modify → undo with NO live session
      (sessions explicitly expired/absent) reverts the edit; undo via a second doc
      instance sharing only the DB (cross-instance, SC-001); undo after simulated
      restart (SC-002); undo hours "later" (no session-derived time limit); assert
      `agentPresence._sessionsByKey`/active-session registry unchanged by
      undo (SC-006, FR-008); undo before the identifier is recorded → honest
      `undone:false` (RBD-7(b)); inverse row is attributed to the acting identity
      (FR-026) and pre-existing rows byte-identical after undo (SC-009).

### Implementation for User Story 1

- [X] T013 [US1] Implement `server/undo/undo-service.js` `performUndo({ docGuid,
      userId, agentName })`: resolve target via `nextUndoTarget` (T007); load rows;
      compute inverse (T009) with the shared doc merged when loaded
      (`documentService.getSharedDoc`); honest-empty short-circuit; claim+store+record
      in one transaction (T007/T003); apply to live doc with `ORIGIN_INVERSE_APPLY`
      (store-then-apply per research R3); return
      `{ success, undone, message, clock }` (RBD-5).
- [X] T014 [US1] Rewrite `server/mcp/tools/undo-redo-handler.js` as the thin shared
      handler: editor-role check via `documents.getRole` (no session — FR-025),
      dispatch to `performUndo`/`performRedo`, no cursor logic; preserve the existing
      no-resanitize-on-replay comment/decision (spec Untrusted-content edge). Update
      `server/mcp/tools/undo.js` handler wiring.
- [X] T015 [US1] Update the REST endpoints in `server/index.js`
      (`makeUndoRedoHandler`, ~line 1287-1349): keep `executeTool` dispatch, 403 for
      viewer, best-effort `reverted` flag on `chatId`+`toolCallId`, pass through the
      new `{ clock, message }` fields; rewrite the stale session-era comments.
      Contract: `contracts/http-undo-api.md`.

**Checkpoint**: US1 independently functional — MVP: durable, instance-agnostic,
session-free undo.

---

## Phase 4: User Story 2 — A surgical inverse, not a time-machine (P1)

**Goal**: popStackItem-parity semantics proven byte-for-byte; races safe.

**Independent Test**: scripted interleavings byte-compare post-undo serialization
against expected content; fully-superseded edit yields honest empty with zero log
growth; concurrent undo double-submit applies at most once.

### Tests for User Story 2 (semantics matrix — extend `server/undo/__tests__/inverse.test.js` and the integration suite)

- [X] T016 [P] [US2] Extend `server/undo/__tests__/inverse.test.js` with the parity
      matrix (byte-compare `toMarkdown`/serialized XML at every pole, SC-003):
      human edits before/after/inside the agent's insertion preserved exactly;
      agent-deleted paragraph restored; same content independently re-deleted later
      stays deleted (supersession skip); insertion partially rewritten later → only
      surviving parts removed; created-and-deleted-within-edit churn not resurrected;
      formatting-only edit (bold) reverts, formatting later overridden on the same
      text is not resurrected (FR-012); fully-superseded → null + no update appended
      (SC-004). Where feasible, assert equivalence against a real live-session
      `Y.UndoManager.undo()` result on the same scenario (the parity oracle).
- [X] T017 [P] [US2] Add concurrency tests to
      `server/mcp/__tests__/integration/undo-redo-workflow.test.js`: two concurrent
      `performUndo` calls for the same edit → exactly one inverse row appended, loser
      gets honest `undone:false` (FR-028, SC-004 zero-double-apply); a collaborator
      edit applied to the live doc between computation setup and apply survives
      byte-for-byte and merges (FR-013/RBD-9, SC-010).

### Implementation for User Story 2

- [X] T018 [US2] Fix `server/undo/inverse.js` / `server/undo/undo-service.js` until
      the T016/T017 matrix passes exactly; document any discovered yjs subtlety as
      comments citing research.md R1 line items.

**Checkpoint**: semantics Sam ratified are pinned by tests.

---

## Phase 5: User Story 3 — Redo, and the chain that never breaks (P2)

**Goal**: redo = invert the inverse from its durable record; chain unlimited.

**Independent Test**: modify→undo→redo byte-identical to pre-undo; ten-cycle
undo/redo chain with a simulated restart and an instance switch mid-chain stays exact
at every pole.

### Tests for User Story 3

- [X] T019 [US3] Add redo tests to
      `server/mcp/__tests__/integration/undo-redo-workflow.test.js` (failing first):
      undo→redo byte round-trip (SC-005); ten-cycle chain, ≥1 cycle across a fresh
      persistence/doc instance (restart) and ≥1 across a second instance (SC-005);
      redo with intervening collaborator edits obeys surgical semantics + honest
      "nothing left to redo" (FR-015); chain targets update correctly (`undo_target`
      = latest redo range, `redo_target` = latest undo range — FR-016); redo of a
      pre-016 undo (reverted flag, no record) honestly `redone:false` (RBD-2);
      successful redo clears the chat part's `reverted` flag via the endpoint (US3
      scenario 5); version history lists each inverse/redo as a NEW edit attributed
      to the acting identity with prior versions untouched (FR-026/FR-027 —
      `versionHistory.groupUpdatesIntoVersions` over the post-chain log).

### Implementation for User Story 3

- [X] T020 [US3] Implement `performRedo` in `server/undo/undo-service.js` (same core,
      input = `nextRedoTarget` range; claim `WHERE state='undone'`; update
      `undo_target` to the redo's range) and wire `server/mcp/tools/redo.js` through
      the rewritten handler. Contract: both contracts files.

**Checkpoint**: chain durable across restarts/instances.

---

## Phase 6: User Story 4 — One mechanism, both surfaces: MCP parity (P2)

**Goal**: MCP tools keep their contract (16 tools, schemas, scopes), gain log-derived
multi-step LIFO behavior, honest results, identity scoping; session UndoManager
retired.

**Independent Test**: modify/undo/redo over the MCP handler path matches the chat
endpoint path state-for-state; an agent cannot undo another identity's edits; 16
tools still registered.

### Tests for User Story 4

- [X] T021 [P] [US4] Add MCP-surface tests to
      `server/mcp/__tests__/integration/undo-redo-workflow.test.js`: repeated `undo`
      steps back through the calling identity's edits LIFO, skipping already-undone;
      `redo` reapplies most-recently-undone first (FR-017/RBD-4); doc edited by a
      human + two agent identities → each agent can only revert its own rows
      (FR-024); nothing-left → `success:true, undone:false` with message, never an
      error; viewer-role token refused on undo/redo (FR-025); result shape has
      `clock`, no `cursor` key (RBD-5); chat-endpoint vs MCP-tool sequence parity —
      identical final document states (SC-008).
- [X] T022 [P] [US4] Update `server/mcp/__tests__/tools/tool-modules.test.js` (and
      any description-asserting tests): tool count still 16; `undo`/`redo`
      descriptions no longer promise cursor restoration and do describe log-derived,
      per-identity, restart-surviving behavior (FR-022/FR-023).

### Implementation for User Story 4

- [X] T023 [US4] Rewrite `undo`/`redo` tool descriptions and RETURNS blocks in
      `server/mcp/tools/undo.js` and `server/mcp/tools/redo.js` per
      `contracts/mcp-undo-redo-tools.md` (schemas, names, scopes untouched).
- [X] T024 [US4] Retire the session `Y.UndoManager` in
      `server/mcp/agent-presence.js`: remove creation (~line 580),
      destruction/cleanup (~line 448), and `getUndoRedoAvailability` (~line 999,
      export list ~1021); update `server/mcp/__tests__/agent-presence.test.js` (and
      presence-handoff/multi-instance tests if they touch undoManager). Confirm
      feature 015's claim machinery is untouched and undo no longer triggers
      `getOrCreateSession` anywhere (grep).

**Checkpoint**: one mechanism, both surfaces; sessions out of the undo path entirely.

---

## Phase 7: User Story 5 — The Undo button stops lying about its own lifetime (P3)

**Goal**: undo-status is log-derived and cheap; legacy history degrades honestly; the
chat button reflects durable reality and surfaces honest empties.

**Independent Test**: edit → simulated restart → undo-status still reports undoable
and the button works; status polls create zero sessions; pre-016 fixtures either
undo correctly or report honest unavailability.

### Tests for User Story 5

- [X] T025 [P] [US5] Write failing tests `server/undo/__tests__/legacy.test.js`
      (research R7/RBD-2/RBD-10): baseline-anchored contiguous identity run derived;
      first-row-foreign after baseline → refuse; >10 s gap segmentation splits
      back-to-back calls; trailing-run derivation for anchorless lookup; ambiguous →
      honest refusal, never a partial range (SC-011); successful legacy undo inserts
      the `agent_edits` row enabling native redo.
- [X] T026 [P] [US5] Write failing endpoint tests
      `server/__tests__/undo-status-api.test.js`: `canUndo` true with zero live
      sessions and after simulated restart (SC-007); `canRedo` true after undo;
      viewer → `{false,false}`; error → `{false,false}`; never-edited doc →
      `{false,false}` honestly; status calls leave the presence-session registry
      untouched (SC-006); legacy fallback path exercised (pre-016 fixture with only
      a baseline clock); FR-020 regression — after a log-derived undo sets the
      persisted `reverted` flag, `chat-staleness.js` `getRevertedDocs` still flags
      the doc for the assistant (the reverted-doc warning keys off unchanged chat
      state).
- [X] T027 [P] [US5] Extend `client/src/components/__tests__/AiChatMessages.test.jsx`
      (Vitest): button renders from polled log-derived status (no session
      assumptions); honest `undone:false` response shows the server message and does
      NOT flip the Reverted state; redo path clears it; status re-fetch after action
      retained.

### Implementation for User Story 5

- [X] T028 [US5] Implement `server/undo/legacy.js` (derivation per research R7,
      RBD-10) and wire it as the fallback in `undo-service.js` target resolution +
      `getUndoStatus`. Makes T025 pass.
- [X] T029 [US5] Implement `getUndoStatus` in `server/undo/undo-service.js` (two
      indexed lookups + legacy fallback — RBD-6) and rewrite
      `GET /api/docs/:docId/undo-status` in `server/index.js` (~line 1351-1369) to
      use it, removing the `agentPresence.getUndoRedoAvailability` call and the
      session-era comments. Makes T026 pass.
- [X] T030 [US5] Update `UndoEditButton` in
      `client/src/components/AiChatMessages.jsx`: surface the honest
      nothing-left message from `undone/redone:false` responses (reuse the existing
      error span styling for an info state), rewrite the session-lifetime comments
      (~lines 54-56, 555-570, 588-589, 978) to the log-derived truth. Makes T027
      pass. No visibility-logic change beyond what the new status semantics provide.

**Checkpoint**: all five stories independently functional.

---

## Phase 8: Polish & Cross-Cutting Concerns

- [X] T031 [P] Update `README.md` (agent undo/redo description — remove any
      session-lifetime/UndoManager claims; describe log-derived undo) and sweep
      `docs/dev.md` for stale references; same-effort doc accuracy per
      Constitution I. Do NOT touch `design/` exports.
- [X] T032 [P] Doc-deletion sweep: ensure the document-deletion path
      (`server/documents.js` / deletion service) also removes `agent_edits` rows for
      the doc (data-model.md §1 note); add a small test to the deletion suite.
- [X] T033 Grep-audit: no remaining references to `session.undoManager`,
      `getUndoRedoAvailability`, or cursor restoration in undo paths; no
      `getOrCreateSession` reachable from undo/redo/status; `ORIGIN_INVERSE_APPLY`
      absent from the Redis skip-list. Fix stragglers.
- [ ] T034 Run the full gates serially: `npm run migrate` (fresh test DB),
      `npm run test:server`, `npm run test:client`; then walk `quickstart.md`
      scenarios 2–5 manually in the dev pod. Confirm SC-001..SC-011 each map to a
      passing test or a completed quickstart check; fix anything red.
      *Status (2026-07-18, implementer): automated gates all green — fresh
      `collab_test_db_016` migrate (incl. down/up round-trip of
      1796000000000_create-agent-edits), full backend Jest suite, full client
      Vitest suite, `npm run build`. SC-001..SC-011 each map to a passing test
      (see undo-redo-workflow / inverse matrix / undo-status / legacy suites).
      LEFT UNCHECKED because quickstart scenarios 2–3's in-browser smoke could
      not be walked from this worktree: the dev pod serves the MAIN checkout,
      not this branch. Scenario 4's API surface and scenario 5's history
      invariants are fully covered by the automated suites. The browser smoke
      belongs with the merge-queue verification / Sam's usual visual check.*

---

## Dependencies & Execution Order

- **Phase 1 → Phase 2 → all user stories**: T001 blocks T005/T007; T003 blocks T007;
  T006/T007/T009/T010 block every story phase.
- **US1 (Phase 3)** blocks US2's T017 concurrency tests and US3's redo endpoint tests
  (needs `performUndo` + endpoints). **US3** depends on US1's service (redo inverts
  undo records). **US4** depends on US1+US3 (both tools live). **US5** depends on US1
  (status reads the records; legacy feeds the same resolver) but T025/T027 can be
  written in parallel once Phase 2 lands.
- Within phases: test tasks precede their implementation tasks and must fail first.
- [P] tasks touch disjoint files and may run in parallel.

### Parallel opportunities

```text
Phase 1: T002 ∥ T003 (after T001 starts; all three are independent files)
Phase 2: T004 ∥ T005 ∥ T008 (tests, disjoint files) → T006 ∥ T007 → T009 → T010 → T011
US2:     T016 ∥ T017
US4:     T021 ∥ T022
US5:     T025 ∥ T026 ∥ T027
Polish:  T031 ∥ T032
```

## Implementation Strategy

MVP = Phases 1–3 (US1): durable, instance-agnostic, session-free undo through both
surfaces' shared handler — the defect the amendment exists to fix. Then US2 pins the
ratified semantics before widening (US3 redo, US4 MCP parity/retirement, US5
status/client/legacy), Polish closes docs + cleanup. Each story phase ends
independently testable; stop-and-validate at every checkpoint.

**Task count**: 34 total — Setup 3, Foundational 8, US1 4, US2 3, US3 2, US4 4,
US5 6, Polish 4.
