---

description: "Task list for 040-restore-undo-attribution"
---

# Tasks: Restore Undo Attribution

**Input**: Design documents from `/specs/040-restore-undo-attribution/`

**Prerequisites**: plan.md, spec.md, research.md, data-model.md, contracts/agent-identity.md, quickstart.md

**Tests**: **REQUIRED, not optional.** Constitution Principle II ("Test-Backed Changes") makes
tests mandatory for every behavioral change, and the spec asks for specific tests by name
(FR-015 "A test MUST assert that the three surfaces agree…", SC-001/003/005/006/009/010).

**Amended 2026-08-01 (Sam's F1 decision, D13)**: US1/SC-001 are re-scoped to the endpoint
contract, a new **Phase 4b (US6 — offer-honesty guard)** is added, and the document-level undo
affordance is filed as follow-on work in `promotion-notes.md`. Task count 42 → 49.

**Amended 2026-08-02 (orchestrator decision D17, adopting analyze-stage finding N1)**: the
planned guard was client-only and poll-fed, leaving a ≤30s window in which the exact FR-018 lie
is reachable. **FR-019** adds server-side enforcement, implemented by new tasks **T050–T052** in
Phase 4b. Task count 49 → 52. T047 also gains the N3 poll-staleness case.

**Organization**: grouped by user story so each is independently implementable and testable.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: can run in parallel (different files, no dependency on an incomplete task)
- **[Story]**: US1–US6 map to the spec's user stories; setup/foundational/polish carry no label
- Every task names an exact file path

## Path Conventions

Web application at repo root: `server/` (CommonJS backend, Jest), `client/src/` (React ESM,
Vitest), `shared/` (not used by this feature). No `migrations/` changes — **zero** (FR-014).

---

## ⚠️ Standing constraints for every task in this file

- **Stay on `main`.** No branch, no commit, no `create-new-feature.sh`, no writes to
  `.specify/feature.json`.
- **Add NO migration.** `git status migrations/` must stay clean (SC-007, FR-014).
- **Never edit `README.md`, `CLAUDE.md`, or `docs/dev.md`.** The README correction is a
  **merge-queue deliverable** written into `merge-notes.md` (T033).
- **Do not touch** `server/origin.js`, `server/document-service.js`,
  `server/postgres-persistence.js`, the diff subsystem, or the websocket/attribution layer.
- Any new decision gets the best default, appended to `clarifications-needed.md` as
  **RATIFIED-BY-DEFAULT (Sam pre-authorized, 2026-08-01)**.

---

## Phase 1: Setup (Worktree Environment)

**Purpose**: make the worktree runnable. Worktrees inherit neither `node_modules` nor `.env`.

- [ ] T001 Install dependencies in the worktree root and client: `npm ci && (cd client && npm ci)`
- [ ] T002 Copy the environment file if present: `cp /local-dev/.env .` (Redis is shared and fine to reuse as-is)
- [ ] T003 Create the per-agent test database: `createdb collab_test_db_040`, and confirm every backend command in this file is prefixed `DATABASE_URL=postgres://$(whoami)@localhost/collab_test_db_040`
- [ ] T004 Establish the green baseline before changing anything: `DATABASE_URL=postgres://$(whoami)@localhost/collab_test_db_040 npm run test:server` and `npm run test:client`. **Always run backend tests via `npm run test:server`** (or add `--runInBand --forceExit` to a bare `npx jest`) — a live Redis client keeps the process alive, so a bare `npx jest` hangs forever and returns nothing when piped. Backend tests are serial-only within one database. Record any pre-existing failure now so it is never mistaken for a regression.

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: the shared identity module and the loud recording boundary. **⚠️ No user story
can begin until T005–T008 are done** — US1 needs the constant importable without a cycle, and
US4 changes what `restoreVersion` does when handed a null identity.

- [ ] T005 Create the new zero-dependency module `server/agent-identity.js` exporting `CHAT_AGENT_NAME = 'Squire Docs Assistant'` and `isSameIdentity(a, b)` exactly per `specs/040-restore-undo-attribution/contracts/agent-identity.md` (symmetric; `(agentName ?? null)` normalization; strict `===` on `userId`; `''` is a distinct identity, never folded into "absent"; pure — no I/O, no throw). The file **MUST contain zero `require` statements** — that is what makes FR-005's no-circular-dependency requirement structural (research R1, D8). Include a module header stating that invariant.
- [ ] T006 In `server/api/chat.js`, replace the local `const CHAT_AGENT_NAME = 'Squire Docs Assistant'` (`:91`) with an import from `../agent-identity`, and **keep re-exporting `CHAT_AGENT_NAME`** from `module.exports` (`:1423`) so existing readers — notably `server/index.js:1632` (undo-status) — need no change. Constant extraction only: no other behavior in this file changes (Collision Contract).
- [ ] T007 [P] In `server/onboarding.js`, delete the local `const AGENT_NAME = 'Squire Docs Assistant'` (`:18`) and consume `CHAT_AGENT_NAME` from `./agent-identity` at its single use site (`:51`, welcome-doc attribution). FR-005 requires exactly one authoritative server-side definition (research R6, D10). Leave the client display strings in `client/src/components/AiPanel.jsx` and `client/src/pages/SettingsPage.jsx` alone — they are ESM UI copy and participate in no undo identity.
- [ ] T008 In `server/undo/edit-records.js`, add the FR-006 precondition to `recordEdit` (`:50`): before any SQL, reject when `agentName` is `null`, `undefined`, not a `string`, or empty/whitespace-only, throwing an `Error` whose message names the missing identity plus the doc guid and user id (never a raw Postgres NOT-NULL violation). Do **not** change the signature or the success return shape. Do **not** guard `insertLegacyUndone` (`:167`) — it runs inside the `finalizeClaim` transaction, so a throw there would roll back a legitimate legacy undo (research R7, D12).

**Checkpoint**: `server/agent-identity.js` exists with zero requires; `grep -rn "Squire Docs Assistant" server/ | grep -v __tests__` returns only the new module plus the JSDoc example in `server/mcp/auth/agent-token-factory.js`; `recordEdit` rejects an identityless call.

---

## Phase 3: User Story 1 — A web-UI restore becomes undoable through the undo endpoints (Priority: P1) 🎯 MVP

**Goal**: a human web-UI restore is recorded under the requesting user's chat-assistant identity
in **both** stores, making it reachable by the chat-assistant identity's undo/redo **endpoints**
(FR-001, FR-002, FR-003).

**Independent Test**: on a doc with several versions, restore an older version via the restore
endpoint, confirm `GET /api/docs/:docId/undo-status` reports `canUndo: true`, call
`POST /api/docs/:docId/undo`, and verify the content equals the pre-restore state exactly; redo
re-applies the restored content.

**⚠️ SCOPE (D13)**: this story is delivered **at the endpoint contract**. It ships **no** control
a user can click to undo a restore — that is `promotion-notes.md` OWED-1. The on-screen half of
this shipment is **Phase 4b (US6)**, which stops the chat card from offering an action it would
misreport. Do not let a task in this phase drift into building an affordance.

### Implementation for User Story 1

- [ ] T009 [US1] In `server/index.js`, change the restore route's `agentName: null` (`:1525`, inside `POST /api/docs/:docId/restore`) to `agentName: CHAT_AGENT_NAME`, importing the constant from `./agent-identity`. Update the route's inline comment (`:1520-1522`), which currently says "a human UI restore records under the `''` agent sentinel", to state the ratified behavior: recorded under the chat-assistant identity acting for the requesting user, which is what makes the restore undoable. **Touch nothing else in this file.**
- [ ] T010 [US1] In `server/version-history.js` `restoreVersion` (`:539-670`), remove the `agentName ?? ''` fallback at the `recordEdit` call (`:658`) so the single `agentName` argument feeds **both** `persistence.storeUpdate` (`:646`) and `editRecords.recordEdit` (`:655-662`). **Keep the `agentName = null` default parameter** — a null must now reach T008's guard, which is the FR-006 tripwire (research R2). Rewrite the `:650-654` comment block (which documents the `''` sentinel) and the `:536` JSDoc for `deps.agentName` to describe the new contract.
- [ ] T011 [US1] Add a test to `server/__tests__/version-history.test.js` asserting the intentional, user-visible attribution change (FR-003, SC-004): after a restore recorded with `CHAT_AGENT_NAME`, the version-history author entry for that version has `name === 'Squire Docs Assistant (<user name>)'` and `isAgent === true`. Label it explicitly as the ratified tradeoff so a reviewer meets it as a deliberate behavior change, not a bug.

### Tests for User Story 1

- [ ] T012 [US1] **Rewrite, do not delete**, the existing case `server/__tests__/version-history.test.js:1712` ("T031: human restore records exactly one update row and one agent_edits row (identity = `''`)"). Its assertion `expect(edits.rows[0].agent_name).toBe('')` **inverts** under FR-001. New assertions: exactly one new `yjs_updates` row **and** exactly one `agent_edits` row, **both** carrying `agent_name = 'Squire Docs Assistant'`; `edit_clock_start === edit_clock_end === newClock`; `undo_target_clocks === [newClock]`; content reverted correctly. Keep the test name's `T031` provenance and note that 040 inverted it.
- [ ] T013 [US1] Create `server/__tests__/restore-undo-roundtrip.test.js` (real Postgres) covering SC-001/SC-002: seed a doc with V1→V2, capture V2's markdown, restore V1 through `restoreVersion` with `CHAT_AGENT_NAME`, assert `undoService.getUndoStatus({userId, agentName: CHAT_AGENT_NAME})` reports `canUndo: true`, run `performUndo`, and assert the replayed content is **byte-identical** to the captured V2 content (not merely "changed") and that the undo returned success rather than the honest-empty result. Then `performRedo` and assert V1's content is re-applied (US1 scenario 3, D5).
- [ ] T014 [US1] In `server/__tests__/restore-undo-roundtrip.test.js`, add the LIFO case (US1 scenario 4): restore, then a chat-assistant-identity edit, then two undos — the first inverts the chat edit, the second inverts the restore. Assert the inversions land as **new forward rows** (clock count grows; no row is deleted or rewritten).
- [ ] T015 [US1] [P] Extend `server/__tests__/undo-status-api.test.js`: `GET /api/docs/:docId/undo-status` reports `canUndo: true` immediately after a web-UI restore, and still reports it after a simulated process restart (fresh service instance / no in-memory state) — availability is log-derived (SC-002). Also assert a **viewer** still gets `{canUndo:false, canRedo:false}` (spec Edge Cases, unchanged).
- [ ] T016 [US1] [P] Add a drift guard (contract invariant, FR-005/SC-001): a test asserting that the identity `server/index.js`'s restore route records under and the identity its undo-status route queries are the **same string** — i.e. both resolve to `require('../agent-identity').CHAT_AGENT_NAME` — so the record and the query can never drift apart.

**Checkpoint**: US1 fully functional. `DATABASE_URL=… npm run test:server -- restore-undo-roundtrip version-history undo-status-api` green.

---

## Phase 4: User Story 2 — Agent restores keep working exactly as today (Priority: P1)

**Goal**: FR-004 — zero regression on the MCP path, which already works. This phase is the
regression fence around US1's change to shared recording code.

**Independent Test**: via an MCP agent token, restore an older version, verify version history
attributes it to the agent's identity, then call the MCP `undo` tool and verify exact inversion.

### Tests for User Story 2

- [ ] T017 [US2] In `server/__tests__/restore-undo-roundtrip.test.js`, add the agent path (SC-003): restore through `restoreVersion` with an agent token's `agentName`, assert **both** the `yjs_updates` row and the `agent_edits` row carry the agent's own name (not `CHAT_AGENT_NAME`), then invert it through that same identity's undo and assert exact inversion.
- [ ] T018 [US2] [P] In the same file, add the identity-scoping case (US2 scenario 3, 016 FR-024): after an agent-token restore, `getUndoStatus` for the **same user's chat-assistant identity** reports `canUndo: false` — one identity's restore is never offered to another's undo. Add the mirror case: after a web-UI restore, an MCP agent token's undo status is unaffected.
- [ ] T019 [US2] [P] Verify by inspection and record in the task notes that `server/mcp/tools/restore-document-version.js:88-99` is **unchanged** — it still passes `agentName: agentToken.agentName`. If it needed a change, US1 was implemented wrongly.

**Checkpoint**: US1 and US2 both pass; the MCP restore path is provably untouched.

---

## Phase 4b: User Story 6 — The Undo button never lies about what it will undo (Priority: P1)

**Goal**: FR-016/FR-017/FR-018 — `/undo-status` additively reports which record it would act on,
and the chat `modify` card offers its Undo/Redo control only when that record is its own edit.

**⚠️ Ships with US1 or not at all (D13).** US1's mechanism is exactly what makes the chat card's
Undo able to misreport: `/undo` selects the identity's most-recent record (LIFO) and uses
`toolCallId` **only** to stamp the `reverted` flag. Once restores enter that queue, an unguarded
card would invert the **restore** and mark the **modify** "Reverted". The server half (T042) may
land in parallel with Phase 3; **the client half (T043) must not merge ahead of US1**, or it
would hide working controls for no reason.

**Independent Test**: with a completed assistant `modify` on a document, perform a restore, then
confirm the modify card offers no Undo control; make the modify the next target again and confirm
the control returns; confirm the endpoint inverted the true target correctly in both cases.

### Implementation for User Story 6

- [ ] T043 [US6] In `server/undo/undo-service.js` `getUndoStatus` (`:313-337`), additively return each direction's target identity per `contracts/agent-identity.md`: `nextUndo: { editClockStart }` and `nextRedo: { editClockStart }`, taken from the rows `nextUndoTarget`/`nextRedoTarget` **already** fetch (no new query, no schema change). Use the record's **immutable `edit_clock_start`**, never `undo_target_*`/`redo_target_*` — `finalizeClaim` rewrites those on every transition, so a client matching on them would stop matching after an undo↔redo cycle (D14). **Omit** the field (never `null`, never `0`) when the corresponding `can*` is false **and** in the legacy-derivation fallback (`:326-336`), which has no `agent_edits` row. `canUndo`/`canRedo` keep their exact current semantics (FR-016, SC-011). `server/index.js`'s `/undo-status` route passes the response through unchanged — verify it needs no edit; if it reshapes the object, extend it minimally.
- [ ] T044 [US6] In `client/src/components/AiChatMessages.jsx` `UndoEditButton` (`:599-680`), add the offer guard (FR-017): read `status?.nextUndo?.editClockStart` (or `nextRedo` when `reverted`) and compare it to this part's own `part.output?.editRange?.clockStart`. Offer the control only on a match. **Fail open (D15)**: if *either* value is `undefined` — an older/legacy response without the field, or a `modify` whose durability wait timed out (`editRangePending`, no `editRange`) — behave exactly as today. **Hide** on mismatch (return the existing `null`/no-button path); add **no new user-facing wording** (revised D7 / D16). Keep `isLatest` as a cheaper necessary precondition — the new check is an additional gate, not a replacement. Keep the `Reverted` label rendering for an already-undone card: the guard governs the action button, not the historical marker. `fetchStatus` (`:609-616`) must be widened to carry the new fields through instead of dropping them.

- [ ] T050 [US6] **(FR-019 / D17 — server-side enforcement, added 2026-08-02 by the orchestrator after N1.)** In `server/undo/undo-service.js`, have `performUndo` and `performRedo` additively report **which record they acted on**: on the success paths only, include `actedEditClockStart` (the `edit_clock_start` of the `agent_edits` row that was claimed). Omit it entirely on every honest-empty/refusal path and on the **legacy-derivation** undo path, which has no record. Purely additive — no existing field changes meaning, and `handleUndoRedo` passes the result through untouched, so the MCP `undo`/`redo` tools gain one harmless extra output key.
- [ ] T051 [US6] **(FR-019 / D17.)** In `server/index.js`, make `makeUndoRedoHandler` (`:1557`) stamp the `reverted` flag **only** for the record actually inverted: thread `result.actedEditClockStart` into `setChatPartReverted` (`:1594`) and write the flag only when the matched part's own `p.output?.editRange?.clockStart` equals it. **Fail closed** when the part has no `editRange.clockStart` (`editRangePending` — record known, part unidentifiable; this is what closes N2's residual window); **fail open** when `actedEditClockStart` is `undefined` (legacy-derivation path — the identity provably has no other records, so no mislabel is structurally possible). The undo/redo itself is **unchanged** in every case — only the flag write is gated. Add a comment at the site stating that this is the by-construction half of FR-018 and that the client guard (T044) is the UX half, not the enforcement.
- [ ] T052 [US6] **(FR-019 / D17 / SC-013 — test.)** In `server/__tests__/restore-undo-roundtrip.test.js`, prove the lie is impossible **with the client guard bypassed** (a direct POST, as an older client or a stale poll would produce): with a chat containing a completed `modify` part and a **restore** as the identity's next undo target, call the undo handler with that modify's `chatId`/`toolCallId` — assert the restore is correctly inverted **and** the modify part's `reverted` flag is still absent. Then assert the discriminator works in the positive direction: supplying the `toolCallId` of the part that *was* the acted-on record **does** set the flag. Add the **N3 poll-staleness case**: a status fetched **before** the restore (reporting the modify as `nextUndo`), the restore lands, and the click arrives on that stale status — pin that the server still refuses to mislabel even though the client offered the button. Cover the fail-closed `editRangePending` part (no `editRange` → flag not written) and the fail-open legacy path.

### Tests for User Story 6

- [ ] T045 [US6] Extend `server/__tests__/undo-status-api.test.js` for FR-016/SC-011: (a) with an active record, the response carries `nextUndo.editClockStart` equal to that row's `edit_clock_start`; (b) with `canUndo: false`, `nextUndo` is **absent** (assert `'nextUndo' in body === false`, not `=== null`); (c) in the legacy-derivation fallback the field is absent while `canUndo` is still `true`; (d) `canUndo`/`canRedo` values are byte-identical to today for every case; (e) viewer role still gets `{canUndo:false, canRedo:false}` with no target fields.
- [ ] T046 [US6] In `server/__tests__/restore-undo-roundtrip.test.js`, add the cross-cycle stability case proving D14's field choice: record a modify-shaped edit, undo it, redo it, and assert the reported `editClockStart` is **the same value throughout** — whereas `undo_target_start`/`redo_target_start` change. This is the regression fence that stops someone "simplifying" the field later.
- [ ] T047 [US6] Create `client/src/components/__tests__/UndoEditButton.test.jsx` (Vitest) covering SC-010/SC-012, cases (a)–(e) of `contracts/agent-identity.md`: (a) next undo target ≠ this part's `editRange.clockStart` → **no Undo button rendered**, and no click path exists that could POST `/undo` with this part's `toolCallId`; (b) target == this part → button offered exactly as today; (d) an undone card whose record is the next **redo** target → Redo offered (same rule, both directions); (e) `nextUndo` absent, or `editRange` absent → button offered (fail-open, never fail-blank). Assert (a) at the level of "no request is issued", so the test proves the *lie* is impossible, not merely that a DOM node is missing. **Plus the N3 poll-staleness case**: the component holds a status fetched **before** a restore (so it still names this part as `nextUndo` and the button is offered), the restore then lands server-side, and the user clicks on that stale status. Pin the resolved behavior: the client **does** issue the POST (it cannot know better — its data is 30s stale, and D15 mandates fail-open on what it has), and correctness is therefore carried by **FR-019/T051 server-side**, which performs the undo but refuses to stamp "Reverted" on this part. The client-side assertion is that the stale-status path still re-fetches status afterwards (`fetchStatus` in the `finally`) so the UI self-corrects.
- [ ] T048 [US6] Add the endpoint-independence case (SC-010(c), FR-018) to `server/__tests__/restore-undo-roundtrip.test.js`: with a restore as the next target, calling `/undo` still inverts the **restore** correctly, and the `reverted` flag is stamped **only** when a `toolCallId` is supplied for the record that was actually acted on. The guard changes what is *offered*, never what the endpoint *does*.

**Checkpoint**: no surface can offer to undo something it would misreport; `/undo-status` is additively richer and backward compatible.

---

## Phase 5: User Story 4 — An unattributable edit record fails loudly (Priority: P2)

**Goal**: FR-006/FR-007 — the recording boundary rejects an identityless call explicitly, and the
enclosing operation still succeeds (D6 non-fatal parity). Implementation landed in T008; this
phase is its test and documentation surface.

**Independent Test**: call the edit-recording boundary without an agent identity and verify an
explicit named rejection (not a NOT-NULL violation), while the enclosing restore/modify still
completes.

- [ ] T020 [US4] Extend `server/undo/__tests__/edit-records.test.js`: `recordEdit` rejects `agentName` of `null`, `undefined`, `''`, `'   '`, and a non-string — **before any query** (assert the pool/`query` spy was never called) — and the thrown message names the missing identity, the doc guid, and the user id (SC-006). Assert the message is not a Postgres constraint string.
- [ ] T021 [US4] [P] Extend `server/__tests__/version-history.test.js`: a `restoreVersion` whose `agentName` is null still **succeeds** (returns `{success:true}`, the update row is stored) while the recording rejection is logged with the explicit message — D6 parity. The existing case at `:1755` ("a recordEdit failure logs but the restore still succeeds") must keep passing unchanged; this new case pins the *guard's* path specifically.
- [ ] T022 [US4] In `server/undo/edit-records.js` module documentation (the header block, `:1-17`), add the **single sentinel rule** for `agent_name` (FR-007) exactly as stated in `data-model.md`: the column is `NOT NULL`; permitted values are real, non-empty agent display names (an MCP token name or the shared chat-assistant identity); `''` writes are **retired** and rejected by `recordEdit`; legacy `''` rows remain in place, intentionally unreachable, with **no migration and no backfill** (D1). Include the note that `insertLegacyUndone` is deliberately not guarded, and why (D12), so a reader does not extend the guard unsafely.

**Checkpoint**: an identityless recording attempt is loud and named; the enclosing operation still succeeds.

---

## Phase 6: User Story 3 — Version history never shows a silently empty contributor list (Priority: P2)

**Goal**: FR-008/FR-009 — versions built from rows with no user attribution show one collapsed
"Unknown author" entry instead of an empty contributor list, in both the version list and the
sub-version drill-down.

**Independent Test**: produce version-history data containing rows with no user attribution and
verify both the version list and the drill-down render an "Unknown author" entry with a stable
key and stable color, and that the client renders it without errors.

### Implementation for User Story 3

- [ ] T023 [US3] In `server/version-history.js`, add a module-level `UNKNOWN_AUTHOR` constant with the D4 shape — `{ id: null, name: 'Unknown author', email: null, picture: null, color: '#888888', isAgent: false }` — and a fixed author key `'unknown'`. **Do not change `createAuthor`'s `if (!userId) return null` contract** (`:101`): `mergeNamedVersions` also calls it for `createdBy` (`:261`), and changing the helper would silently turn `createdBy: null` into an unknown-author object for a named version with no creator (research R4, D10).
- [ ] T024 [US3] In `groupUpdatesIntoVersions` (`server/version-history.js:203-206`), give the `if (update.userId && …)` guard an `else` branch that adds `UNKNOWN_AUTHOR` under the fixed `'unknown'` key — so repeated unattributed rows **collapse to one entry per version** and coexist with real authors. Because `getUpdatesForVersion` (`:699`) calls this same function for the drill-down, this one change satisfies FR-008's "both paths" requirement; state that in the code comment so it is not later duplicated.
- [ ] T025 [US3] [P] In `server/version-history.js:794` (the single-author version metadata, `author: update ? createAuthor(update) : null`), fall back to `UNKNOWN_AUTHOR` when `update` exists but yields no author, rather than emitting `null` for a row that genuinely exists.

### Tests for User Story 3

- [ ] T026 [US3] Extend `server/__tests__/version-history.test.js` (SC-005): (a) a version built **entirely** from rows with `userId: null` renders exactly one contributor equal to `UNKNOWN_AUTHOR`; (b) a **mixed** version renders the real authors **plus exactly one** unknown entry; (c) many unattributed rows still collapse to one entry; (d) the **sub-version drill-down** (`getUpdatesForVersion`) shows the same treatment; (e) a version whose rows all carry attribution shows **no** phantom unknown author.
- [ ] T027 [US3] [P] Extend `client/src/components/__tests__/HierarchicalVersionList.test.jsx` (FR-009): an author entry with `id: null` renders without crashing — the badge has a background color, the name renders as "Unknown author", and no blank/broken element appears. Cover the `AuthorList` map key path (`` `${author.id}-${i}` ``) with two unknown entries in a list to prove keys stay stable.
- [ ] T028 [US3] [P] Verify `client/src/components/VersionPreview.jsx:82-90` tolerates `author.id === null` (it keys on `author.id || i` and falls back on `author.name`); add a Vitest case if the component has a test file, otherwise record the inspection result in the task notes.

**Checkpoint**: no version with existing rows renders an empty contributor list, on either path.

---

## Phase 7: User Story 5 — History colors don't change overnight (Priority: P3) — VERIFICATION ONLY

**Goal**: FR-010. **No code change.** Feature 039 already shipped the identical requirement as
its FR-018 (research R3, D9).

**Independent Test**: render a history author entry with no server-supplied color and verify the
fallback is the stable neutral on any date.

- [ ] T029 [US5] Verify by inspection that `client/src/components/HierarchicalVersionList.jsx` renders `backgroundColor: author.color || '#888888'` (`:61`) and **does not import `colorUtils`** — confirming the spec's citation of `:56` and the date-salted presence palette is stale post-039. Record the verification; change nothing.
- [ ] T030 [US5] [P] Run `npm run test:client -- HierarchicalVersionList` and confirm the existing case "renders the stable neutral #888888 for a colorless author, on any date" (`HierarchicalVersionList.test.jsx:487`) passes. Confirm `client/src/utils/colorUtils.js` still carries its **date-salted daily presence rotation, untouched** (FR-010's second half — presence colors must not change or be unified with history).

**Checkpoint**: FR-010 satisfied with zero diff; the overlap with 039 is documented.

---

## Phase 8: FR-015 — One identity-comparison predicate (cross-cutting)

**Goal**: exactly one definition of "is this row mine?" across the codebase (FR-015, SC-009).
Independent of every user story; can be worked in parallel with Phases 3–7.

- [ ] T031 Adopt `isSameIdentity` at all six call sites, per `contracts/agent-identity.md`:
  - `server/mcp/yjs/edit-range.js:185` — replace the raw `r.agentName === identity.agentName` filter. **This one is a behavior change (bug fix)**: it currently rejects a match when one side is `null` (DB) and the other `undefined` (in-process identity object). Note that in the code comment.
  - `server/undo/inverse.js:80` — replace the inline normalized comparison (behavior-preserving).
  - `server/undo/legacy.js:56-62` (`isIdentityRow`) — replace **only the two-field comparison**, keeping 038's `if (row.viaSync === true) return false` channel guard **above** it, untouched (behavior-preserving). Note: the spec cites `:46`; 038 moved it to `:56-62`.
  - `server/mcp/tools/modify.js:308` — `!isSameIdentity(u, agentToken)` (behavior-identical, D11).
  - `server/mcp/tools/modify.js:327` — `isSameIdentity(u, agentToken)` for `isSelf` (behavior-identical, D11).
  - `server/api/chat-staleness.js:111` — `isSameIdentity(u, agent)` for `isOwnAgent` (behavior-identical, D11).
  Leave `server/origin.js:182` alone (normalization, not comparison) and leave the parameterized SQL identity predicates in `edit-records.js` alone (Postgres-side equality on a `NOT NULL` column).
- [ ] T032 Create `server/undo/__tests__/identity-predicate.test.js` (SC-009): (a) unit-test `isSameIdentity` for symmetry, `null`↔`undefined` equivalence, `''` treated as a distinct identity, and strict `userId` comparison; (b) prove **the three undo surfaces now agree** on the `null`-vs-`undefined` case — given a DB-shaped row `{userId: U, agentName: null}` and an in-process identity `{userId: U}` with no `agentName` key, the `edit-range` durability filter, the `inverse` identity filter, and the `legacy` run detector all classify the row as the identity's own (before this feature the first disagreed); (c) assert `legacy`'s `viaSync === true` guard still wins over identity match (038 regression fence).

**Checkpoint**: `grep -rn "agentName ===\|agentName !==\|agentName ?? null" server/ client/src/ --include=*.js --include=*.jsx | grep -v __tests__` returns only `server/agent-identity.js` and `server/origin.js:182`.

---

## Phase 9: Documentation closures & merge-queue handoff

- [ ] T033 Create `specs/040-restore-undo-attribution/merge-notes.md` with the **exact replacement text** for the `README.md:467` restore paragraph (FR-013), ready for the merge queue to paste. That paragraph was corrected by the merge queue to describe today's broken behavior and to point at this spec (`"A restore from the web UI is currently recorded without an actor identity, so no undo surface can invert it; unifying the two paths is spec 040…"`), so this feature makes it stale again. The replacement must state: restore stays non-destructive; **both** surfaces now record the restore as a tracked edit under an acting identity; an MCP restore is attributed to the acting agent and invertible by that agent's undo; a **web-UI restore is attributed to the assistant identity acting for that user** (e.g. "Squire Docs Assistant (Sam Goldstein)") and is invertible — and redoable — **through the undo endpoints**; and drop the "spec 040" forward reference. **The replacement MUST NOT claim a user can click something to undo a restore** — they still cannot (D13); if the paragraph mentions the affordance at all, it must say the web-UI restore is undoable via the API and that a document-level control is not yet built. **Second passage, finding F6**: `README.md:583` says *"The most recent `modify` diff has an Undo button that reverts the edit"* — after FR-017 that button appears only when that edit is the identity's next undo target, so supply a replacement for that sentence too (the button hides when a later restore or edit is the true next target, precisely so it can never claim to revert an edit it did not). Also record in `merge-notes.md`: the verified finding that `docs/dev.md` describes no restore/undo behavior (nothing owed), and the two accepted consequences from research R8 (chat staleness no longer reporting the user's own restore as foreign, and the chat assistant's own modify conflict guard treating it as self) so the reviewer meets them as analysed, not as surprises. **Do not edit `README.md` yourself.**
- [ ] T034 [P] In `server/mcp/yjs/edit-range.js`, add the F7 documentation comment at the identity row filter (`:185`, FR-011): undo identity is `(userId, agent display name)` equality, so two `sk_sqd_` tokens of the **same user** sharing a display name are indistinguishable for undo target selection; why it is accepted (`userId` scopes cross-user, so cross-user collision is impossible; exact clock sets keep each inversion surgical; the residual risk is only LIFO selection surprise among one person's own sessions); and why a token-id disambiguator is not warranted (a two-table migration plus threading the id through every origin). State that this comment is documentation-only and that the null-normalization at the same site is the separate FR-015 fix.
- [ ] T035 [P] In `server/undo/edit-records.js` module documentation, add the FK-policy divergence rationale (FR-012, D3): `yjs_updates.user_id` is `ON DELETE SET NULL` while `agent_edits.user_id` is `ON DELETE CASCADE`, and this is **intentional** — history rows survive a user's deletion anonymized (which is exactly what the "Unknown author" entry renders), while a deleted user's undo chain dies with the account because a deleted user can never undo anything. State that the policies themselves must not be unified. Migration files stay untouched.

---

## Phase 10: Polish, Verification & Gate

- [ ] T036 Run the SC-009 reviewer greps and record their exact output in `merge-notes.md`: (a) `grep -rn "agentName ===\|agentName !==\|agentName ?? null" server/ client/src/ --include=*.js --include=*.jsx | grep -v __tests__` — expected hits only `server/agent-identity.js` and `server/origin.js:182`; (b) `grep -rn "Squire Docs Assistant" server/ | grep -v __tests__` — expected only `server/agent-identity.js` plus the JSDoc example in `server/mcp/auth/agent-token-factory.js:16`. Any other hit must be converted or filed explicitly in `merge-notes.md`.
- [ ] T037 Confirm `server/agent-identity.js` still contains **zero `require` statements** and that no import cycle was introduced: `node -e "require('./server/version-history.js'); require('./server/agent-identity.js')"` loads clean, and `server/version-history.js` does **not** require `server/api/chat.js` (FR-005).
- [ ] T038 Confirm **zero migrations**: `git status --porcelain migrations/` is empty and no file under `migrations/` appears in the feature diff (SC-007, FR-014). Also confirm none of the forbidden files (`server/origin.js`, `server/document-service.js`, `server/postgres-persistence.js`, the diff subsystem, the websocket layer) appears in the diff.
- [ ] T039 Full backend suite: `DATABASE_URL=postgres://$(whoami)@localhost/collab_test_db_040 npm run test:server`. Green, compared against the T004 baseline. Never a bare `npx jest` without `--runInBand --forceExit`.
- [ ] T040 [P] Full client suite and build: `npm run test:client` and `npm run build`. Both green.
- [ ] T041 Walk `specs/040-restore-undo-attribution/quickstart.md` end to end and record the result of each section in `merge-notes.md`, including the manual browser and MCP steps that are **owed to Sam** (they cannot be run here): the browser restore→undo→redo walk (US1) and the MCP restore→undo walk (US2).
- [ ] T042 Append any decision taken during implementation to `specs/040-restore-undo-attribution/clarifications-needed.md` as **RATIFIED-BY-DEFAULT (Sam pre-authorized, 2026-08-01)**, with the question, why it came up, and the rationale for the default. Decisions already recorded and **not** to be re-litigated: D8–D16 (notably **D13**, Sam's explicit F1 decision, and the superseded D7).
- [ ] T049 Verify `specs/040-restore-undo-attribution/promotion-notes.md` still describes reality before handoff: OWED-1 (the document-level undo affordance) is accurate about what shipped versus what is owed, and OWED-2's manual walks match what could not be run in the worktree. Add F5's two accepted consequences as **code comments** at their sites — `server/api/chat-staleness.js` (`foreignEditsSince` no longer reports the user's own UI restore as foreign) and `server/mcp/tools/modify.js` (the chat assistant's own modify now treats a preceding UI restore as `isSelf`; MCP agent tokens are unaffected) — so the next reader meets them in the code, not only in the ledger.

---

## Dependencies & Execution Order

### Phase Dependencies

- **Phase 1 (Setup)**: no dependencies.
- **Phase 2 (Foundational)**: depends on Phase 1. **BLOCKS Phases 3–6.** T005 blocks T006, T007, T009, T031. T008 blocks T010, T020, T021.
- **Phase 3 (US1, P1)**: depends on Phase 2. The MVP.
- **Phase 4 (US2, P1)**: depends on Phase 3 — it is the regression fence around US1's change to shared recording code, and shares `restore-undo-roundtrip.test.js` with it.
- **Phase 4b (US6, P1)**: **ships with Phase 3 or not at all** (D13). Its server half (T043) depends only on Phase 2 and may run in parallel with Phase 3. Its client half (T044) depends on T043 and **must not merge ahead of Phase 3** — without US1 there is nothing to guard against, and the guard would only hide working controls.
- **Phase 5 (US4, P2)**: depends on Phase 2 only (T008). Can run in parallel with Phases 3/4.
- **Phase 6 (US3, P2)**: depends on Phase 1 only. Fully independent of the restore-identity work.
- **Phase 7 (US5, P3)**: no dependencies — verification only.
- **Phase 8 (FR-015)**: depends on T005 only. Independent of every user story.
- **Phase 9 (Docs)**: T033 depends on Phases 3/4 landing (it describes the shipped behavior); T034/T035 depend only on the modules existing.
- **Phase 10 (Gate)**: depends on everything.

### User Story Dependencies

- **US1 (P1)**: after Foundational. The MVP; US2 fences it and US6 ships with it.
- **US2 (P1)**: after US1. Regression-only; no production code of its own.
- **US6 (P1)**: server half after Foundational; client half after US1. Not optional — it is the on-screen half of the same shipment (D13).
- **US3 (P2)**: independent — different files entirely (`version-history.js` display path + client).
- **US4 (P2)**: after Foundational (its implementation is T008).
- **US5 (P3)**: independent, verification-only.

### Parallel Opportunities

- T007 ∥ T008 (different files, both after T005/T006 ordering is respected for T007's import).
- Phase 6 (US3) ∥ Phase 3/4 (US1/US2) — disjoint files.
- Phase 8 (FR-015) ∥ Phases 3–7 — only `modify.js`, `chat-staleness.js`, `edit-range.js`,
  `inverse.js`, `legacy.js`; none is touched by a user story phase.
- Within Phase 3: T015 ∥ T016 (different files).
- Within Phase 4: T017 → then T018 ∥ T019.
- Within Phase 6: T025 ∥ (T023 → T024); T027 ∥ T028.
- Phase 7 entirely ∥ everything.
- T043 (US6 server half) ∥ Phase 3 — different file (`undo-service.js`).

⚠️ **Not parallel**: T012, T021, T026 and T011 all edit `server/__tests__/version-history.test.js`
— serialize them. T013, T014, T017, T018, T046, T048 all edit `restore-undo-roundtrip.test.js`
— serialize them. T015 and T045 both edit `undo-status-api.test.js` — serialize them.

**Note on task numbering**: Phase 4b's IDs (T043–T048) sit above Phase 5–10's (T020–T042)
because the phase was inserted by the 2026-08-01 amendment (D13) rather than renumbering the
whole file, which would have broken the 023 test-name citation inside T012. Execution order is
the order tasks appear in this file, not their numeric order.

---

## Parallel Example: after Phase 2

```bash
# Three independent tracks once the foundation is in:
Track A (MVP):   T009 → T010 → T011 → T012 → T013 → T014 → (T015 ∥ T016) → Phase 4
Track B (US3):   T023 → T024 → T025 → T026 → (T027 ∥ T028)
Track C (FR-015):T031 → T032          # plus T029/T030 (US5 verification) any time
Track D (US6):   T043 (∥ Track A) → then T044 → T045 → T046 → T047 → T048
                 # T044+ only AFTER Track A's US1 lands — see D13
```

---

## Implementation Strategy

### MVP First (User Story 1 only)

1. Phase 1 Setup → Phase 2 Foundational (**critical — blocks everything**).
2. Phase 3 (US1). **STOP and VALIDATE**: restore → undo → redo round trip is byte-exact, and
   version history shows the assistant attribution.
3. Immediately follow with Phase 4 (US2) — US1 changed shared recording code, and the agent
   path is the regression surface. Do not consider the MVP done without it.
4. **And Phase 4b (US6), in the same shipment (D13.)** US1 puts restores into the identity-LIFO
   undo queue; without the offer guard, the chat card's "Undo edit" would invert a restore and
   mark the assistant's edit "Reverted". The MVP is not shippable with that on screen.

### Incremental Delivery

1. Setup + Foundational → foundation ready.
2. + US1 + US2 + US6 → the headline defect (F2) is closed at the API, fenced against agent-path
   regression, and honest on screen. **This is the deliverable that matters**; everything after
   is cleanup. Note what it is *not*: a user still cannot click to undo a restore
   (`promotion-notes.md` OWED-1).
3. + US4 → the latent recording defect is closed loudly.
4. + US3 → history stops hiding deleted-account edits.
5. + US5 verification + FR-015 consolidation + documentation closures.
6. Phase 10 gate → hand to the merge queue with `merge-notes.md`.

### Reviewer's attention budget

The single most important thing for a reviewer to look at is **T012** — the test whose assertion
this feature deliberately inverts (`agent_name` `''` → `'Squire Docs Assistant'`). It is the
ratified, user-visible attribution tradeoff (FR-003, SC-004) made explicit. Second is **T044** —
the client offer guard, which must be **fail-open**: get its `undefined` handling wrong and every
pre-existing chat card silently loses a working Undo button (D15). Third is **T031**'s
`edit-range.js` line, the only other behavior change hiding inside an otherwise
behavior-preserving consolidation.

---

## Notes

- `[P]` = different files, no dependency on an incomplete task.
- `[Story]` maps a task to a spec user story for traceability.
- Backend tests: **serial only**, one database (`collab_test_db_040`), always via
  `npm run test:server`.
- Commit after each logical group — but **do not commit in this pipeline stage**; the merge
  queue integrates.
- Stop at any checkpoint to validate a story independently.
