# Tasks: Sync Apply Correctness and Honest Receipts

**Input**: Design documents from `/specs/056-sync-apply-correctness/`

**Prerequisites**: plan.md, spec.md, research.md (R1–R9), data-model.md,
contracts/sync-receipt-v3.md, contracts/apply-invariants.md (I1–I7),
quickstart.md, repro/repro1..4.js (committed seeds)

**Tests**: REQUIRED — FR-015 makes the committed regression corpus a
functional requirement of this feature, and the pipeline's house style is
tests-first (each story's scenario tables are written and shown failing
before the engine change lands).

**Organization**: Grouped by user story. NOTE: nearly every implementation
task edits the single module `server/markdown-sync.js`, so implementation
tasks are inherently serial across stories — the story phases are ordered
US1 → US2 → US3 → US4 and [P] appears only where files genuinely differ.
`server/markdown-sync.js` contains NUL bytes: `grep -a` or direct reads only.

**Overrides in force**: work on the current branch (no feature branch, no
commits from this phase); NO migrations (if one appears necessary, STOP);
054 receipt fields and 055 alignment invariants are frozen (additive only);
do not touch `server/read-document.js`, `server/collab-bind-state.js`,
`server/redis-pubsub/index.js`, `server/agent-presence.js` (sibling feature
057 implements against them in parallel — any need to touch them is a HIGH
finding to report, not code).

## Format: `[ID] [P?] [Story] Description`

---

## Phase 1: Setup (baseline evidence)

**Purpose**: Prove the committed seeds still reproduce every defect on
current main, so the fix has a red baseline.

- [ ] T001 Run the four repro seeds against current main (`node specs/056-sync-apply-correctness/repro/repro1.js` … `repro4.js`) and record the failing-scenario counts per family (repro1 fail count, repro2 push1 FAILs, repro3 STUCK/REPRODUCED lines, repro4 non-converging + leak lines) in the test-plan header comment of the suite created in T002. If any family no longer reproduces, STOP and report before changing the engine.

---

## Phase 2: Foundational (shared test harness)

**Purpose**: The one artifact every story's tests build on.

**⚠️ CRITICAL**: complete before any user story phase.

- [ ] T002 Create `server/__tests__/markdown-sync.apply-correctness.test.js` with the shared DB-free harness and NO scenarios yet: `pushOnce(frag, pushedMd, flavor)` mirroring the repro scripts (source map → canonicalize → computeHunks → planPush → buildChangeReport → transact applyHunks → resultMd), doc builders (`linkedParagraph`, `boldParagraph`, `multiBlockLinked`, parameterized `linkPara`), a `repairPush` helper (fresh re-export baseline → one push → assert convergence), and the repro4 raw-syntax leak matcher (`/\\\[|\\\]|\]\(/` over result with well-formed links stripped). Follow the harness idioms of `server/__tests__/markdown-sync.replay.test.js` (research R7).

**Checkpoint**: harness merges green (zero scenarios), gates untouched.

---

## Phase 3: User Story 1 — Edits next to formatting apply exactly as written (Priority: P1) 🎯 MVP

**Goal**: Plan-side mark inheritance (Bug A): a comma after `[runbook](url)`
is plain text on the first push; typing at the end of a styled span still
continues the span; the known net-zero shape converges.

**Independent Test**: repro1 (L1–L7, B1–B5) + repro3 (P1–P4) scenario tables
converge on the first push; `node repro1.js`/`repro3.js` print zero
failures/STUCK.

### Tests for User Story 1 (write first, show failing)

- [ ] T003 [US1] Encode the repro1 scenario table (L1–L7 link shapes, B1–B5 bold shapes) and the repro3 boundary-insertion table (P1 comma after link, P2 word after link no-space, P3 comma after bold, P4 word before link text start) as data-driven cases in `server/__tests__/markdown-sync.apply-correctness.test.js`, asserting first-push convergence (`resultMd === pushedCanon`, FR-013/SC-001). Run the suite and confirm the pre-fix failures match T001's recorded counts.
- [ ] T004 [US1] Add classifier unit cases to the same file: for each resolution branch (inside-run, left-rule at a styled span's end — FR-003 pinned unchanged, following-rule at closing-syntax boundary — FR-002, structural at opening syntax / block-leading link / inter-block), assert `classifyRange` records the resolved run's `attrs` on the insertion segment per contracts/apply-invariants.md I1, including the spec edge cases: adjacent mapped runs with no syntax between (left wins), insertion before opening `[`/`**` (left run or structural — never the following mark), marked-block start (structural).

### Implementation for User Story 1

- [ ] T005 [US1] In `server/markdown-sync.js` `classifyRange` (:193-233): record `attrs` on every resolved segment at plan time per research R1 — insertion branches sample the resolved run's own span via `marksAtChar(textNode.toDelta(), …)` (inside → char at resolved offset; left → run's last char; following → run's first char); proper-range branch records the first replaced character's run attrs on `segments[0]`. Resolution ORDER unchanged (RBD-056-5).
- [ ] T006 [US1] In `server/markdown-sync.js` `applyHunks` step 2 (:1236-1258): format inserted text with the hunk's recorded `attrs` only — delete the `toDelta()` probe and the `at - 1` anchor line (:1250-1252); keep the per-node shift bookkeeping and delete-then-insert order intact (FR-001).
- [ ] T007 [US1] Run the US1 tables plus the gate suites `markdown-sync.replay.test.js` and `markdown-sync.convergence.test.js`; `node specs/.../repro/repro1.js` and `repro3.js` (P-loop section) must print zero failures. Any gate drift must fall in research R8 class (b) (plan-side replacement marks) — review each against spec FR-001..003 before updating an expectation; anything else is a regression to fix, not an expectation to edit.

**Checkpoint**: US1 corpus green; the durable field failure (comma joins
link) is dead; left-preference typing behavior verified unchanged.

---

## Phase 4: User Story 2 — No edit in a pushed file is silently dropped (Priority: P1)

**Goal**: Fold-together (Bug B) + unbalanced-bracket classification (Bug C):
a block's hunks travel together into any structural rebuild; lone `[`/`]`
never rides the plain-text lane; no raw `](` leaks.

**Independent Test**: repro2 (U/D/M/A/C/W/MB shapes) + repro4 fuzz (F1–F10)
converge on the first push with zero raw-syntax leaks; `node repro2.js`
exits 0; `node repro4.js` prints zero non-converging cases.

### Tests for User Story 2 (write first, show failing)

- [ ] T008 [US2] Encode the repro2 scenario table (U1–U4 URL+mixed edits, D1–D2 unwrap, M1 move, A1 add link, C1–C3 boundary-hugging coalescing traps, W1 rewrite-around-link, MB1–MB3 multi-block) and the repro4 fuzz table (F1–F10) in `server/__tests__/markdown-sync.apply-correctness.test.js`, asserting first-push convergence AND the leak matcher on every result (FR-013/SC-001/SC-004). Confirm pre-fix failures match T001's counts.
- [ ] T009 [US2] Add planner unit cases to the same file for contracts/apply-invariants.md I2/I3: (a) lane exclusivity — a block with a structural URL hunk + a text word-swap hunk lands ALL hunks in one structural group and appears in no other lane; (b) multi-block structural claim folds every claimed block's text groups; (c) forced (055) hunks never trigger or join a fold; (d) edge-block insertion (`blocks: []`) never triggers a fold; (e) lone-`[` insertion classifies non-plain (FR-005); (f) bracketed-note insertion `[sic]` routes to a reparse lane and round-trips as literal text; (g) a deletion whose replaced slice contains `\[`/`\]`/`[`/`]` classifies non-plain.

### Implementation for User Story 2

- [ ] T010 [US2] In `server/markdown-sync.js`: extend `newTextHasInlineMarkSyntax` (:961-963) to match `[` and `]`, and extend the `allPlain` gate in `planPush` (:1014-1017) with the deleted-text check (replaced baseline slice `baselineMd.slice(h.oldStart, h.oldEnd)` containing `[`, `]`, `\[`, or `\]` disqualifies the plain lane) per research R3. Parentheses deliberately excluded.
- [ ] T011 [US2] In `server/markdown-sync.js` `planPush` (:987-1041): add the fold-together step per research R2 — build the `structuralClaims` block set from non-forced structural hunks' `blocks` lists; any per-block group whose block is claimed re-emits ALL its hunks as structural hunks (`blocks: [block]`) BEFORE the reconcile attempt; forced hunks and edge-block insertions are non-triggers; folded hunks count toward `structuralHunks` (RBD-056-7). Add a defensive guard: a block claimed by a forced hunk must own no char-diff hunks (055 construction) — violation routes the group to the fold, never a double-apply.
- [ ] T012 [US2] Run the US2 tables plus gates `markdown-sync.alignment.test.js`, `markdown-sync.order-independence.test.js`, `markdown-sync.overlap.test.js`; `node specs/.../repro/repro2.js` exits 0 and `repro4.js` prints zero non-converging cases. Any gate drift must fall in research R8 class (a) (bracket-bearing hunks now on reparse lanes) — review each; anything else is a regression.

**Checkpoint**: both P1 stories green — every corpus family converges on the
first push; no partial rebuilds, no raw syntax leaks.

---

## Phase 5: User Story 3 — Receipts report what happened, not what was planned (Priority: P2)

**Goal**: `applyHunks` returns an apply result (performed counts + outcomes +
`skipped`); `operations`/`blocksChanged` derive from it; every `mode=sync`
receipt (applied, both noops, dry run) carries fork-side `converged`.

**Independent Test**: contracts/sync-receipt-v3.md truth table holds at the
route level: applied → `converged: true, skipped: 0`; canonical-equal noop →
`converged: true`; already-applied noop over a diverged doc → `noop: true,
converged: false`; dry run → same `converged` as the real push, no trace.

### Tests for User Story 3 (write first, show failing)

- [ ] T013 [US3] Add apply-result unit cases to `server/__tests__/markdown-sync.apply-correctness.test.js` per contracts/apply-invariants.md I4 and data-model.md: (a) healthy pushes return performed counts equal to work done with `skipped: 0` and all outcomes `applied: true` — including a reconcile-lane scenario asserting its hunks count in `textHunks` via the reconcile entry's new `hunkCount` (054 meaning preserved, FR-011); (b) a doctored plan with an unresolvable block node (detach ONLY that one structural group's block, leaving other lanes intact) yields `skipped` > 0, outcome `applied: false`, and a `blocksChanged` report (via the outcomes filter) that omits the skipped block; (c) an insertion whose markdown parses to zero nodes counts skipped; (d) a replacement rebuild parsing to zero nodes is a DELETION (`applied: true`, not skipped); (e) a folded block (US2 shape) reports exactly once in `blocksChanged` as `op: 'structural'` with its hunks in `structuralHunks` not `textHunks` (RBD-056-7).
- [ ] T014 [P] [US3] Extend `__tests__/integration/sync-push.route.test.js` with the receipt matrix from contracts/sync-receipt-v3.md: (a) applied push carries `converged: true` and `operations.skipped: 0` alongside every unchanged 054 field (FR-011 compatibility snapshot: docId/mode/noop/clock/markdown/overlaps/operations aggregates/blocksChanged/staleness quartet); (b) canonical-equal noop → `noop: true, converged: true, blocksChanged: []`; (c) the FR-010 pair, tested honestly for a post-fix engine (analysis finding U1 — the false branch is a backstop that a correct fork replay cannot reach naturally): route-level, a byte-identical re-push (idempotency short-circuit) over a doc diverged ONLY by a concurrent edit asserts the RBD-056-1 designed pair `noop: true, converged: true, docChangedSinceBaseline: true`, and over a matching doc asserts `converged: true`; the `noop: true, converged: false` branch is asserted at the replay/unit seam — drive the noop receipt assembly with a fork comparison that mismatches (repro3's `emulateSyncPush` shape with a doctored fork result, or direct unit coverage of the `noopReceipt` converged threading) — proving `noop: true` alone can no longer certify success; (d) `dryRun=true` returns the same `converged` a real push then produces, still omits `markdown`, and leaves no trace (reuse 054's trace-freedom assertions) (FR-012); (e) `mode=append`/`replace` receipts carry NO `converged` field (out of scope guard).

### Implementation for User Story 3

- [ ] T015 [US3] In `server/markdown-sync.js`: give `reconcileBlockPlan`'s return a `hunkCount` field (the group's hunk count — data-model.md count provenance, FR-011) and rework `applyHunks` (:1218-1334) to return the apply result per data-model.md — flat `{ textHunks, structuralHunks, skipped, outcomes }` where counts reflect operations actually performed (text hunks whose ops ran; structural groups' hunks when the rebuild landed; insertions when nodes inserted) and every skip path registers an outcome + increments `skipped`: replaced-block guards :1232/:1238 (dead post-fold, kept as counted defense), unresolvable block node :1272, empty insertion parse :1322; a replacement whose rebuild parses empty is a deletion, applied. Delete the `{ ...plan.counts }` echo (:1333).
- [ ] T016 [US3] In `server/markdown-sync.js`: give `buildChangeReport` (:1442) an optional `outcomes` argument that drops entries whose op did not apply (correlate text/reconcile entries by blockNode, structural entries by group range, insertions by afterBlock), and move the report build in `applySyncPush` to AFTER the apply transaction (safe per research R4 — report inputs are baseline-side and immutable), passing the outcomes. The 3-arg call (DB-free harness, repro seeds) keeps returning the unfiltered plan view.
- [ ] T017 [US3] In `server/markdown-sync.js` `applySyncPush` (:1706-1906): compute `converged` fork-side per research R5 — serialize the fork fragment post-apply with `toMarkdown(fragment, { flavor })` and byte-compare to `pushedMd` — and thread it through all four branches: canonical-equal noop (`true`, no computation), already-applied noop (computed comparison — the S1 `false` case), dry-run receipt, and applied receipt; `noopReceipt` gains the `converged` parameter and keeps zero op counts (FR-009/010, research R6); receipt `operations` becomes the three count keys of the apply result; `blocksChanged` is the outcomes-filtered report.
- [ ] T018 [P] [US3] Update the receipt teaching text in `server/mcp/tools/tool-documentation/export-api.js` (~:212-291): add `converged` to every documented sync receipt shape, `skipped` to `operations`, and one sentence on the repair signal (`noop: true, converged: false` → re-pull and repair; the re-export `markdown` remains the next baseline) per contracts/sync-receipt-v3.md (research R9).
- [ ] T019 [US3] Run T013/T014 plus gates `sync-push.route.test.js` (all of it), `sync-push.cross-doc-images.route.test.js`, `markdown-sync.rejection.test.js`, and the DB-free suites — the R8 note applies: only the two named drift classes are reviewable expectation updates.

**Checkpoint**: receipts derive from apply results; the truth table of
contracts/sync-receipt-v3.md is enforced end-to-end.

---

## Phase 6: User Story 4 — A repair push always works (Priority: P2)

**Goal**: The core promise (FR-014): from ANY engine-reachable state —
including pre-056 corruption — one push against a freshly re-exported
baseline converges; the stuck repair loop is impossible.

**Independent Test**: full-corpus repair sweep passes (SC-002); round-trip
no-op still holds with `converged: true` (FR-017).

### Tests for User Story 4

- [ ] T020 [US4] Add the repair-convergence sweep to `server/__tests__/markdown-sync.apply-correctness.test.js`: for EVERY corpus scenario (US1 + US2 tables), take the post-push document, re-export it as a fresh baseline, push the desired markdown once, and assert convergence in that single push (SC-002/FR-014); additionally build pre-056-corruption fixtures directly (a doc with the comma INSIDE the link mark; a doc holding repro2-U2's partial apply — URL changed, word swap missing) and assert one fresh-baseline repair push converges each.
- [ ] T021 [US4] Add the no-progress honesty property to the same file: drive a push that applies nothing effective (byte-identical re-push at the replay layer via pinned synthetic clientID per repro3's `emulateSyncPush` shape, plus a doctored zero-outcome plan) and assert the receipt-level view is `converged: false` with zero-effect counts — the "reports ops, applies nothing, forever" loop is structurally impossible (FR-014); assert round-trip `import(export(doc))` remains a canonical-equal noop now carrying `converged: true` (FR-017), for both squire and portable flavors.

**Checkpoint**: all four stories green; SC-001..SC-004 hold over the whole
committed corpus.

---

## Phase 7: Polish & Cross-Cutting Verification

- [ ] T022 Full verification sweep per quickstart.md: the new corpus suite + every gate (`markdown-sync.replay|convergence|alignment|order-independence|overlap|rejection`, `format-roundtrip`, `markdown-fixtures`, `markdown-fuzz`, `sync-push.route`, `sync-push.cross-doc-images.route`) + `node specs/056-sync-apply-correctness/repro/repro{1..4}.js` all green with zero failures/STUCK/leaks; confirm the replay suite's existing performance guard shows no regression from the added fork serialization; sweep the whole suite's receipts for `operations.skipped === 0` on healthy paths (SC-003).
- [ ] T023 Boundary + accuracy audit: `git diff --name-only` (worktree) must touch ONLY `server/markdown-sync.js`, `server/__tests__/markdown-sync.apply-correctness.test.js`, `__tests__/integration/sync-push.route.test.js`, `server/mcp/tools/tool-documentation/export-api.js`, and `specs/056-sync-apply-correctness/**` — any file from 057's surface (`server/read-document.js`, `server/collab-bind-state.js`, `server/redis-pubsub/index.js`, `server/agent-presence.js`) is a HIGH finding to report immediately; re-grep README.md for sync-receipt prose (expected: none — Constitution I); if implementation falsified any research R1–R5 mechanism, record it in `specs/056-sync-apply-correctness/clarifications-needed.md` and flag the Squire design doc for amendment (Constitution VI — never hand-edit `design/`).

---

## Dependencies & Execution Order

### Phase Dependencies

- **Phase 1 → Phase 2 → Phase 3 (US1) → Phase 4 (US2) → Phase 5 (US3) → Phase 6 (US4) → Phase 7.**
  Strictly serial at the phase level: every implementation task edits
  `server/markdown-sync.js`, US2's fold interacts with US1's attrs-carrying
  hunks, US3's receipts report US1/US2 behavior, and US4 quantifies over the
  US1+US2 corpus with US3's honesty fields.

### Story Independence notes

- US1 is independently testable after Phase 2 (its tables + two gates).
- US2 is testable without US3/US4 (convergence + leak assertions predate the
  receipt rework).
- US3's replay-layer tests (T013) depend only on Phase 2; its route tests
  (T014) exercise US1/US2 shapes but hold on their own receipts.
- US4 is deliberately a property sweep over everything before it — it is the
  user-facing promise, not an independent code change (spec: "largely a
  consequence of fixing Bugs A–C, specified as its own property").

### Parallel Opportunities

Limited by the single-module surface. Genuinely parallel pairs:

- T014 (route tests, `__tests__/integration/sync-push.route.test.js`) with
  T013 (replay tests, `server/__tests__/...`).
- T018 (teaching text, `export-api.js`) with any US3 test task.

Everything touching `server/markdown-sync.js` (T005, T006, T010, T011,
T015–T017) is serial. Everything touching the corpus suite file
(T002–T004, T008–T009, T013, T020–T021) is serial with respect to that file.

---

## Implementation Strategy

**MVP = Phase 1–3 (US1)**: kills the durable field failure (comma joins
link, unfixable by repair) with the smallest engine change; corpus families
repro1+repro3-P prove it.

**Incremental delivery**: US2 completes the P1 pair (no silent drops, no
leaks) — at that checkpoint the engine is correct but receipts still
plan-derived. US3 makes the receipts honest (and is what makes any FUTURE
apply defect visible — the backstop). US4 seals the promise with the
repair-sweep property. Phase 7 is the exit gate the merge queue re-runs.

Per-task cadence: run the touched suites before moving on; the corpus suite
is expected red from T003/T008 until their story's implementation lands —
that redness is the TDD evidence, keep it scoped per story so the tree is
never red across story boundaries at a checkpoint.
