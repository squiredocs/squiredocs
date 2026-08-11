# Tasks: Block-Aligned Merge Pre-Pass for Sync Push

**Input**: Design documents from `/specs/055-block-aligned-merge/`

**Prerequisites**: plan.md, spec.md, research.md (R1–R8), data-model.md,
contracts/planner-invariants.md, quickstart.md

**Tests**: REQUIRED — FR-012 mandates the test matrix; tests are the feature's
acceptance mechanism (Constitution II: the suite is the only reviewer).
Test-first within each story: write the pinning tests, watch them fail, then
implement.

**Organization**: Foundational pure helpers first (all stories share the
aligner), then stories in priority order. Nearly all implementation lands in
one file (`server/markdown-sync.js`) — [P] applies mostly to distinct test
files.

**HARD SEQUENCING GATE**: 055 is implemented AFTER feature 054
(`specs/054-sync-feedback-hardening`) merges to main — both edit
`server/markdown-sync.js`, and 055's report assertions read 054's
`blocksChanged` surface. T001 verifies this precondition; if it fails, STOP
and report (do not build against a guessed report shape).

**File hazard**: `server/markdown-sync.js` contains NUL bytes — plain `grep`
reports "binary file" / no matches. Use `grep -a` or read the file directly.
Preserve the existing NUL bytes; do not "clean" them (the file is load-bearing
as-is and the hazard is documented in project memory).

## Format: `[ID] [P?] [Story?] Description with file path`

---

## Phase 1: Setup (preconditions & baseline)

- [X] T001 Verify the 054 sequencing gate on main: `git log --oneline -5` shows 054 merged, and `grep -a "blocksChanged" /local-dev/server/markdown-sync.js` (or the module 054 factored the report into) finds the report builder with op kinds `text | reconcile | structural` reading `plan.textBlocks` / `plan.reconcileBlocks` / `plan.structural`. Record the builder's exact location in a code comment reference for T014. If absent or vocabulary differs, STOP and report (ledger gap #1 reconciliation is orchestrator scope).
- [X] T002 Baseline green run before touching anything (repo convention: run from repo root with `REDIS_HOST=${REDIS_HOST:-localhost}` set and `--forceExit`, matching `npm run test:server`): `REDIS_HOST=${REDIS_HOST:-localhost} npx jest --forceExit server/__tests__/markdown-sync.replay.test.js server/__tests__/markdown-sync.convergence.test.js server/__tests__/markdown-sync.order-independence.test.js server/__tests__/markdown-sync.overlap.test.js server/__tests__/markdown-sync.rejection.test.js server/__tests__/import-roundtrip.test.js` — all green, note timings (perf comparison for T031). Confirm 054's sync suites (dryRun/report/staleness) are in the run set and green too.

---

## Phase 2: Foundational (pure planner building blocks — BLOCKS all stories)

**⚠️ CRITICAL**: The aligner primitives are shared by every story. All are
pure functions in `server/markdown-sync.js` with unit tests in the NEW file
`server/__tests__/markdown-sync.alignment.test.js` (DB-free).

- [X] T003 [P] Create `server/__tests__/markdown-sync.alignment.test.js` with the FR-002 invariant helper `assertNoCrossBlockSplice(plan, baseBlocks, pushedBlocks?)`: (a) every hunk in `plan.textBlocks`/`plan.reconcileBlocks` has `[oldStart, oldEnd)` inside exactly one baseline block extent; (b) every `plan.structural` entry with blocks covers whole block extents (`oldStart`/`oldEnd` extent-aligned, per contracts I1/I2). Also add small doc-builder fixtures (headings/paragraphs/lists/code fences) reusing the builder style of markdown-sync.convergence.test.js. This file hosts the tests of T004–T009.
- [X] T004 In `server/markdown-sync.js`: extend `canonicalizePushed` and `canonicalizePushedStaged` to serialize the scratch fragment via `toMarkdownWithSourceMap` and surface the pushed block extents (research R1). Pin the return shapes: `canonicalizePushedStaged` → `{ markdown, images, blocks }`; add `canonicalizePushedWithBlocks(body, opts)` → `{ markdown, blocks }` while `canonicalizePushed` keeps returning a string (existing callers/tests untouched). Blocks carry `{ mdStart, mdEnd, blockIndex }` only (strip `blockNode` — the scratch doc dies). IMPORTANT: both empty-content early returns in `canonicalizePushedStaged` (detached/post-image-pass `nodes.length === 0`, markdown-sync.js:344-348) must return `blocks: []` — the empty-pushed-document edge case reaches the aligner through them. Unit test: extents tile the canonical string; byte-equality `canonicalizePushed(body) === canonicalizePushedWithBlocks(body).markdown`; a code fence containing a blank line stays ONE block.
- [X] T005 In `server/markdown-sync.js`: implement `blockSimilarity(a, b)` — the bounded Dice ladder of research R3 (exact-equal→1; either side > `PAIR_INPUT_MAX` → 0; length upper bound `2·min/(sum) < SIMILARITY_THRESHOLD` → 0 without diffing; `diffChars` cap trip → 0; else `2C/(|a|+|b|)`). Add constants `SIMILARITY_THRESHOLD = 0.5` and (placeholder until the T025 rename lands) reuse of `COARSE_CLUSTER_MAX`/`MAX_EDIT_LENGTH`. Unit tests: determinism (same inputs twice), symmetry, exact Dice values on hand-computed pairs, each ladder step (oversized side, length-bound skip, cap trip), and the FR-011 metric-determinism pin.
- [X] T006 In `server/markdown-sync.js`: implement `alignBlocks(baseMds, pushedMds)` → `{ anchors, pairs, residualRuns }` (data-model BlockAlignment): `diffArrays` exact-anchor pass, gap discovery, per-gap order-preserving max-similarity DP with deterministic traceback tie-break (diagonal > advance-base > advance-pushed), positional fallback when `N·M > MAX_GAP_DP_CELLS` (new constant, 10_000), residual-run extraction between pairing landmarks (research R2/R4). Pairs record `sim`; below-threshold candidates are NEVER paired.
- [X] T007 [P] Unit tests for T006 in `server/__tests__/markdown-sync.alignment.test.js`: identical sequences → all anchors, no pairs/runs; duplicate identical blocks align by position (spec duplicate-blocks edge case, contract I10); pairing never reorders (crossing-similarity trap input: constructed gap where greedy would cross, DP must not); deterministic across repeated calls; empty baseline / empty pushed → single all-insert / all-delete run; `MAX_GAP_DP_CELLS` exceeded → positional pairing still deterministic and order-preserving.
- [X] T008 In `server/markdown-sync.js`: implement the gap emitter (research R6) producing ForcedHunks from `residualRuns` + degraded pairs: D>0 runs → one forced replace hunk covering the D contiguous baseline blocks (`newText` = pushed strings joined `\n\n`, `''` when I=0); D=0,I>0 runs → ONE insertion hunk per run anchored at the nearest preceding surviving block's `mdEnd` (or 0 at doc start); anchor-folding: if the preceding block is covered by a forced replace, append the insertion text to that replace's `newText` instead of emitting a separate hunk. Forced hunks carry `{ forced: true, blocks }` per data-model.
- [X] T009 [P] Unit tests for T008: single-hunk-per-anchor invariant (two pushed blocks inserted at one point → one hunk, correct order); anchor folding when preceding block is replaced (contract §2 rule); pure delete; empty-side cases; forced hunks satisfy `assertNoCrossBlockSplice` extent alignment.

**Checkpoint**: pure aligner fully unit-tested; `computeHunks` still untouched
and every existing suite still green.

---

## Phase 3: User Story 1 — Edits land only in the blocks that were edited (P1) 🎯 MVP

**Goal**: The pre-pass drives planning: exact anchors + matched pairs, char
diffing only inside pairs — mis-anchoring (decoy heading, cross-block fusion)
impossible by construction.

**Independent Test**: quickstart scenario 1 (decoy heading) + spec US1
acceptance 1–3; all pre-existing sync suites green with unchanged assertions.

### Tests for User Story 1 (write first, must fail before T013)

- [ ] T010 [P] [US1] In `server/__tests__/markdown-sync.alignment.test.js`: decoy-heading regression (FR-006/SC-001, contract I8) at planner level — baseline `# Deployment` / paragraph / `# Deployment Notes` / paragraph; push renames only `# Deployment` → `# Rollout`; assert the plan touches exactly the renamed heading's block, `Deployment Notes` block appears in NO plan list, and `assertNoCrossBlockSplice` passes. Plus distant-blocks independence (spec US1 AS2): 40-block doc, edit block A and block Z → plan lists exactly two blocks.
- [ ] T011 [P] [US1] In `server/__tests__/markdown-sync.replay.test.js` (new describe `block alignment (055, US1)`): the same decoy-heading push driven end-to-end through `applySyncPush` against a persisted doc — assert receipt `blocksChanged` (054 surface) lists only the renamed block with op kind `text` or `reconcile`, the decoy block is byte-identical in the receipt markdown, and a concurrent live edit to an untouched block survives verbatim with NO overlap flag (spec US1 AS3).

### Implementation for User Story 1

- [ ] T012 [US1] In `server/markdown-sync.js`: rewrite `computeHunks` to the new signature `computeHunks(baselineMd, pushedMd, baseBlocks, pushedBlocks)` (contract §1): build `baseMds`/`pushedMds` slices → `alignBlocks` → per matched pair run `diffChars(baseStr, pushedStr, { maxEditLength: MAX_EDIT_LENGTH })`, rebase offsets by the pair's baseline `mdStart`, cap-trip → mark pair degraded (forced replace via T008 path — defensive; see T019 note); PERF (analyze finding M1): reuse the `diffChars` parts already computed by `blockSimilarity` for the matched pair instead of diffing the same two strings twice (cache parts on the pair record from T006) — SC-005 forbids latency regression and every matched pair otherwise pays double O(N·D); keep the existing `COALESCE_DISTANCE` within-block coalescing over the in-pair hunks; append the gap emitter's forced hunks; return one baseline-ordered hunk array. The old top-level whole-doc `diffChars` call is gone from `computeHunks` (the `coarseDiff` function itself is deleted in T027, not here — leave it unreferenced-but-present only if removing it would break 054-era imports; otherwise delete now and note it).
- [ ] T013 [US1] In `server/markdown-sync.js`: route forced hunks in `planPush` — `if (h.forced) { structural.push({ ...h }); continue; }` before `classifyRange` (FR-005 by construction, research R5); update `applySyncPush` to pass `sourceMap.blocks` and the pushed `blocks` (from T004's `canonicalizePushedStaged`) into `computeHunks`. In-pair hunks continue through unchanged classification (FR-004/FR-010: prefer-text, `reconcileBlockPlan` heading-level decline, `isEdgeBlockInsertion` all untouched).
- [ ] T014 [US1] Verify 054's `blocksChanged` builder (located in T001) needs no change: it reads the plan lists only. Extend its existing test (in the file 054 put it) with one alignment-era case if coverage is missing: a push whose plan contains a forced structural entry must surface op kind `structural`. Do NOT alter the report shape (contract §2).
- [ ] T015 [US1] Migrate existing suite call sites to the new signatures, assertions UNCHANGED (FR-009/FR-012): `makePushUpdate` in `server/__tests__/markdown-sync.convergence.test.js` (use `canonicalizePushedWithBlocks`), plus every direct `computeHunks`/`planPush` call in `server/__tests__/markdown-sync.replay.test.js`, `server/__tests__/markdown-sync.order-independence.test.js`, `server/__tests__/markdown-sync.overlap.test.js`. Run all five sync suites + `import-roundtrip` — green. If ANY existing assertion fails, treat as a defect in 055 (or a genuine semantics shift needing a ledger entry) — never weaken the assertion (research R8).

**Checkpoint**: US1 fully functional — decoy regression green, all legacy
suites green unchanged. MVP.

---

## Phase 4: User Story 2 — Rewritten blocks replace atomically, never splice (P2)

**Goal**: Below-threshold / unmatched / cap-tripped blocks become whole-block
atomic ops with design-table concurrent-edit outcomes; threshold behavior
test-pinned.

**Independent Test**: quickstart scenarios 2 & 5-adjacent; spec US2 acceptance
1–3 and the split/merge/move/type-change edge cases.

### Tests for User Story 2 (write first)

- [ ] T016 [P] [US2] Threshold boundary tests (FR-011, contract I5) in `server/__tests__/markdown-sync.alignment.test.js`: construct pairs with Dice just ≥ 0.5 (char-diffed pair) and just < 0.5 (single forced replace, zero char ops); assert exact boundary at `sim === 0.5` (inclusive match, per FR-003 "at or above").
- [ ] T017 [P] [US2] Structural atomicity tests in `server/__tests__/markdown-sync.alignment.test.js`: wholesale paragraph rewrite → ONE forced replace, neighbors untouched (US2 AS1); delete-one-block + insert-unrelated-block-elsewhere → whole-block delete + whole-block insert, never a morphing char edit (US2 AS2, RBD-055-3 move semantics); block split (surviving fragment pairs + insert leftover) and merge (pair + delete leftover) per RBD-055-7; heading-level change and paragraph→list type change → matched pair whose classification lands structural via the EXISTING classifier (RBD-055-4 — assert the decline happens in `reconcileBlockPlan`, not in the aligner); adjacent below-threshold replaces merge in `structuralOps` without absorbing a matched block between them (spec adjacent-replaces edge case).
- [ ] T018 [P] [US2] Overlap/outcome tests in `server/__tests__/markdown-sync.overlap.test.js` (new describe): concurrent live edit inside an atomically-replaced block → replacement wins, flag `{ docSide: 'edited', pushSide: 'structural' }`; concurrent edit inside a push-deleted block → flag with `pushSide: 'deleted'` (FR-007); flags remain advisory (never gate — reuse the suite's existing never-gates harness).
- [ ] T019 [P] [US2] Cap-trip degradation (RBD-055-6, contract I7) in `server/__tests__/markdown-sync.alignment.test.js`: pin the OBSERVABLE behavior, not the internal route — a block pair whose bounded character diff gives up (`MAX_EDIT_LENGTH` cap; construct with two large highly-shuffled same-length blocks under 16KB/side) results in an atomic forced replace of that pair ONLY, while sibling edited blocks still char-diff; no whole-document fallback observable. NOTE (analyze finding M2): with the R3 similarity ladder, a cap-tripping pair scores sim 0 and is never matched — so degradation happens via the unmatched route, and the data-model `degraded: true` matched-pair state is expected to be unreachable defensive code when T012 reuses the similarity diff. Assert the outcome; keep the defensive branch.

### Implementation for User Story 2

- [ ] T020 [US2] Close the gaps T016–T019 expose in `server/markdown-sync.js`. Expected deltas (all inside the T006/T008/T012 code): inclusive-threshold comparison (`sim >= SIMILARITY_THRESHOLD`), degraded-pair rerouting into the gap emitter with anchor-folding still enforced, and the empty-pushed-document path (every baseline block → forced delete; receipt still non-noop). No changes to `structuralOps`/`applyHunks` — if a scenario seems to need one, STOP and re-read research R5/R6 (the emitter, not the applier, must adapt).
- [ ] T021 [US2] End-to-end atomic-rewrite receipt test in `server/__tests__/markdown-sync.replay.test.js`: push a wholesale one-block rewrite through `applySyncPush`; assert SC-006 — final document contains the pushed text exactly (no interleaved hybrid), `blocksChanged` shows that block as `structural`, and version history gained exactly one entry.

**Checkpoint**: US1 + US2 independently green; the design §2.4.1 outcome table
holds predictably.

---

## Phase 5: User Story 3 — Same behavior at every document size (P3)

**Goal**: One planning path for all sizes (RBD-055-5); size thresholds survive
only as per-pair bounds; parity is a tested invariant.

**Independent Test**: quickstart scenario 3 + performance guard (SC-004/SC-005).

### Tests for User Story 3 (write first)

- [ ] T022 [P] [US3] Size-parity tests (FR-008/SC-004, contract I6) in `server/__tests__/markdown-sync.alignment.test.js`: the same one-word edit in a ~1KB doc and in the same doc padded past 64KB (extra distinct paragraph blocks) → identical op-kind classification for the edited block and identical hunk shape (rebased); repeat for a heading rename and a wholesale rewrite (each op kind).
- [ ] T023 [P] [US3] Oversized-single-block degradation (spec US3 AS3) in `server/__tests__/markdown-sync.alignment.test.js`: one edited block > `PAIR_INPUT_MAX` (16KB) among normal blocks → that pair alone forced-replaces (similarity ladder step 2); the other edited blocks still char-diff.
- [ ] T024 [US3] Update the performance-guard describe in `server/__tests__/markdown-sync.replay.test.js` (titled "performance guard (T027, SC-007, research R11)" — that T027 is feature 004's historical task label, unrelated to this file's T027) for the unified path: single-block edit in a >64KB doc plans within the existing wall-time bound; add an assertion that `computeHunks` on a >64KB mostly-equal input returns only block-scoped hunks (no whole-document diff artifacts). Keep the existing time thresholds — SC-005 forbids regression.

### Implementation for User Story 3

- [ ] T025 [US3] In `server/markdown-sync.js`: retire the coarse path (research R7) — delete `COARSE_INPUT_THRESHOLD`, `coarseDiff`, and the `diffLines` import (if not already removed in T012); rename `COARSE_CLUSTER_MAX` → `PAIR_INPUT_MAX` (same value; update the T005 similarity ladder reference and any 054-era references — check with `grep -a COARSE_CLUSTER_MAX server/ -r`). Verify with `grep -a "diffLines\|coarseDiff\|COARSE_INPUT" server/markdown-sync.js` → no matches.
- [ ] T026 [US3] Fix anything T022–T024 exposes; then full sync-suite run (T002's command) green.

**Checkpoint**: all three stories independently green; one path, bounded work.

---

## Phase 6: Polish & Cross-Cutting

- [ ] T027 [P] Update the module header comment of `server/markdown-sync.js` (the T001/T007 sections) to describe the alignment pre-pass, and update `README.md` (~line 517, "the file is character-diffed against the fork's canonical markdown...") to the block-aligned mechanics — Constitution I, same change as the code. Do NOT edit design/, CLAUDE.md, or docs/dev.md.
- [ ] T028 [P] Ledger closure in `specs/055-block-aligned-merge/clarifications-needed.md`: append an implementation-outcome note under gap #3 confirming RBD-055-5's one-path mechanism held (or STOP if it did not — design amendment needed first), and under gap #1 that 054's shipped vocabulary matched `text | reconcile | structural` (from T001/T014 evidence).
- [ ] T029 Round-trip + convergence final gate (contract I3/I4): `npx jest server/__tests__/import-roundtrip.test.js server/__tests__/format-roundtrip.test.js server/__tests__/markdown-sync.convergence.test.js server/__tests__/markdown-sync.order-independence.test.js` — green with unchanged assertions; explicitly re-run the no-op/idempotency describes in `server/__tests__/markdown-sync.replay.test.js` (canonically-equal push → `noop: true`, zero ops, no version row — SC-003).
- [ ] T030 Full backend suite (`npm run test:server`, the authoritative invocation) + quickstart.md scenario checklist walked and green; record wall-time vs T002 baseline (SC-005: no push-latency regression on the sync corpus).
- [ ] T031 Self-review against contracts/planner-invariants.md §3 (I1–I10): each invariant names its enforcing test; add any missing pin. Confirm `git diff` touches only `server/markdown-sync.js`, the test files, `README.md`, and this spec directory — no serializer, route, or migration changes (spec Out of Scope; migrations = STOP-and-report).

---

## Dependencies & Execution Order

### Phase Dependencies

- **Phase 1 (Setup)**: none — but T001's 054 gate can HALT the feature.
- **Phase 2 (Foundational)**: after Phase 1. T003 first (test scaffold), then
  T004/T005 [P with each other], T006 after T005, T007 after T006, T008 after
  T006, T009 after T008.
- **Phase 3 (US1)**: after Phase 2. T010/T011 [P] before T012→T013→T014→T015.
- **Phase 4 (US2)**: after US1 (extends the integrated pipeline).
  T016–T019 [P] before T020→T021.
- **Phase 5 (US3)**: after US2 (retirement must not mask atomicity gaps).
  T022/T023 [P] before T024→T025→T026.
- **Phase 6 (Polish)**: after all stories. T027/T028 [P]; T029→T030→T031 serial.

### Story Dependencies

US1 is the MVP and carries the integration; US2 and US3 harden the same
pipeline and are sequential by design (single-file feature), each leaving the
suite green at its checkpoint.

## Parallel Example: Phase 2

```bash
# After T003 lands the scaffold:
Task: "T004 canonicalizePushed* block extents in server/markdown-sync.js + tests"
Task: "T005 blockSimilarity bounded Dice ladder in server/markdown-sync.js + tests"
# (same source file — [P] here means independent test-first work items whose
#  code edits are small and non-overlapping; land them in T004→T005 order)
```

## Implementation Strategy

MVP = Phases 1–3 (US1): the aligner integrated, decoy regression dead, legacy
suites green. STOP and validate at the US1 checkpoint before US2. Each later
phase is an independently verifiable increment ending in a full-suite gate.
Commits are the ORCHESTRATOR's job — implementer leaves the tree building and
green, never commits, never branches.

## Notes

- Tests before implementation within every story; a failing new test is the
  spec's voice — an unexpectedly failing OLD test is a 055 defect until proven
  otherwise (research R8).
- Known pre-existing engine characteristic, NOT to be "fixed" here: an
  insertion anchored on a block that `planPush` classification (not the
  aligner) later routes to structural resolves by node identity at apply time
  (research R6 note). Out of scope; do not expand.
- MEDIUM analyze findings, if any, are folded into these task notes by the
  analyze stage rather than auto-fixed.
