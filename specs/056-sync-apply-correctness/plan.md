# Implementation Plan: Sync Apply Correctness and Honest Receipts

**Branch**: `main` (orchestrated; no feature branch — pipeline worktree merge) | **Date**: 2026-08-12 | **Spec**: specs/056-sync-apply-correctness/spec.md

**Input**: Feature specification from `specs/056-sync-apply-correctness/spec.md`

**Design ground truth**: `design/markdown-import-two-way-sync.md` §2.4/§2.4.1 +
"Amendment (2026-08-11) — apply correctness and honest receipts (feature 056)",
read with the 054/055 amendments of the same date. Clarifications ledger:
`clarifications-needed.md` (RBD-056-1..7 + 5 flagged design gaps).

**Sequencing**: builds on the merged state of 054 + 055 (both on main). The
055 alignment layer and the 054 receipt fields are frozen upstream contracts
(FR-011/FR-016). A sibling feature (`specs/057-live-doc-consistency`) is
planned in parallel over disjoint files (`server/read-document.js`,
`collab-bind-state.js`, `redis-pubsub/index.js`, `agent-presence.js`); 056
touches none of them — any overlap discovered during implement is a HIGH
finding to raise, not merge through.

## Summary

Fix the three reproduced apply-layer defects and make sync receipts derive
from what apply actually did. (A) Mark inheritance becomes a **plan-side
decision**: the classifier records the resolved mapped run's attributes on
every text-lane hunk and `applyHunks` formats inserted text with exactly
those attrs — the `at - 1` neighbor probe (`markdown-sync.js:1251`) is
removed; resolution order (inside → left → following → structural) is
untouched, preserving the load-bearing left-preference branch. (B) A block's
hunks **travel together**: `planPush` gains a fold step so any block claimed
by a non-forced structural hunk sends ALL its hunks into one structural
rebuild — the existing `structuralOps` composition then rebuilds from every
edit by construction, and the apply-side skip guards become counted
defense-in-depth. (C) Unbalanced square brackets classify as **mark syntax**
(both inserted and deleted text), so lone-`[` edits ride the whole-block
reparse lanes and raw `](` can never leak. Receipts gain **honesty**:
`applyHunks` returns an apply result (performed counts + per-op outcomes +
`skipped`), `operations`/`blocksChanged` derive from it, and every `mode=sync`
receipt — applied, both noops, dry run — carries `converged`: byte equality
of the fork's post-apply canonical serialization with the pushed canonical
markdown (fork-side per RBD-056-1). The ~40-scenario repro corpus is encoded
as a committed DB-free regression suite plus route-level noop/dry-run receipt
tests, with first-push convergence (FR-013) and one-push repair convergence
(FR-014) asserted per scenario. Technical decisions fixed in `research.md`
R1–R9; invariants pinned in `contracts/apply-invariants.md`; the receipt
delta in `contracts/sync-receipt-v3.md`.

## Technical Context

**Language/Version**: Node.js 22 (CommonJS server modules)

**Primary Dependencies**: `yjs`, `diff` — both already imported by
`server/markdown-sync.js`. **No new dependencies.**

**Storage**: N/A — no schema change, **no migrations** (hard override: if a
migration turns out to be needed, STOP and report). All changes are pure
in-memory compute inside `applySyncPush` plus receipt payload fields.

**Testing**: Jest, `server/__tests__/` (per-worker DB isolation per
Constitution II). The new corpus suite is DB-free and parallel-safe; route
receipt tests extend `__tests__/integration/sync-push.route.test.js`.
Existing gates (SC-006): `markdown-sync.replay|convergence|alignment|
order-independence|overlap|rejection.test.js`, `format-roundtrip.test.js`,
`markdown-fixtures/fuzz`, `sync-push.route` + `cross-doc-images.route` —
extended, never weakened. Known repo hazard: `markdown-sync.js` contains NUL
bytes; grep it with `-a` or read directly.

**Target Platform**: Linux app pod, horizontally scalable (Constitution VII:
all changes are pure functions of request-scoped state).

**Project Type**: single web-service repo. Change surface:
`server/markdown-sync.js` (classifier/planner/apply/receipt), the two test
surfaces above, and the receipt teaching text in
`server/mcp/tools/tool-documentation/export-api.js`. Nothing else.

**Performance Goals**: one additional fork serialization per sync push (the
`converged` comparison, cheap `toMarkdown` variant) — same complexity class
as the existing per-push canonicalization; no regression on the replay
suite's existing performance guard.

**Constraints**: additive-only receipt changes (FR-011); 055 planner
invariants frozen (FR-016); round-trip no-op preserved (FR-017); no
in-engine retry/fallback/rollback on `converged: false` (RBD-056-4); no
user interaction; work orchestrated on the current branch.

**Scale/Scope**: documents up to MAX_IMPORT_BYTES (5MB); corpus of ~40
replay scenarios across 4 families; 3 engine fixes + 1 receipt subsystem
rework in one module.

## Constitution Check

*GATE: evaluated pre-Phase-0 and re-checked post-design — PASS (no
Complexity Tracking entries needed).*

- **I. Documentation Reflects Reality — PASS with required task**: README.md
  contains no sync-receipt operation-field prose (grep verified 2026-08-12);
  the receipt teaching surface that DOES document the shape is
  `server/mcp/tools/tool-documentation/export-api.js` (~:212-291) and MUST be
  updated in the same change (`converged`, `operations.skipped`, the
  `noop:true, converged:false` repair signal). Broader docs-site pages were
  054's scope and are explicitly out of scope (spec).
- **II. Test-Backed Changes — PASS**: FR-013/014/015 make the test corpus a
  requirement of the feature itself; the new suite is DB-free and
  parallel-safe; no serializer change, so `format-roundtrip` is a pure gate;
  route tests use the standard isolated-DB harness.
- **III. Trunk-Based Solo Workflow — PASS**: pipeline worktree + merge queue
  per /the-pipeline; no new ceremony.
- **IV. Collaboration-Safe Document Operations — PASS, with the one
  sanctioned exception**: the feature's substance is honoring in-place
  transformation (plan-recorded marks make the text lane MORE precise;
  fold-together and bracket classification route some edits to whole-block
  structural replacement — the design-sanctioned bounded exception
  (§2.4.1, 055 RBD-055-4/-5), triggered only where partial in-place
  application is what corrupts documents today). Untouched blocks keep CRDT
  identity byte-for-byte; the corpus suite is the enforcement. Element
  targeting stays structural (block-node identity, never positional
  indexing). Provenance unchanged (same single stored update, same
  attribution row).
- **V. Secure by Default — PASS**: no new ingestion surface; every rebuild
  string still flows through `mdToNodes` post-image-policy; bracket
  classification only tightens which lane parses untrusted text (whole-block
  reparse instead of raw char splice).
- **VI. Design Docs Are Ground Truth — PASS**: the 2026-08-11 056 amendment
  is the mandate; all seven open decisions are RATIFIED-BY-DEFAULT in the
  ledger with five design gaps flagged (incl. the `converged` noop-basis
  nuance and the opening-syntax precedence the amendment is silent on). If
  implementation falsifies the fold-together or plan-side-marks mechanism,
  the Squire design doc must be amended (never hand-edited) as part of the
  work.
- **VII. Horizontally Scalable App Pods — PASS**: pure request-scoped
  compute; no process-local correctness state; `converged` is computed from
  the per-request fork.
- **Technology constraints — PASS**: registry-driven pipeline untouched; no
  third-party markdown/serialization dependency; no ad-hoc DDL (no DDL at
  all).

## Project Structure

### Documentation (this feature)

```text
specs/056-sync-apply-correctness/
├── spec.md                      # (pre-existing, 416824a8)
├── clarifications-needed.md     # (pre-existing) RBD-056-1..7 + design gaps
├── checklists/requirements.md   # (pre-existing)
├── repro/repro1..4.js           # (pre-existing) committed regression seeds
├── plan.md                      # This file
├── research.md                  # Phase 0 — decisions R1–R9
├── data-model.md                # Phase 1 — hunk/plan/apply-result/receipt entities
├── quickstart.md                # Phase 1 — validation guide
├── contracts/
│   ├── sync-receipt-v3.md       # Phase 1 — external receipt delta (additive)
│   └── apply-invariants.md      # Phase 1 — internal engine invariants I1–I7
└── tasks.md                     # Phase 2 (/speckit-tasks)
```

### Source Code (repository root)

```text
server/
├── markdown-sync.js                          # THE change surface:
│   #   classifyRange (:193-233)  — record resolved-run attrs on segments (R1)
│   #   newTextHasInlineMarkSyntax (:961-963) + allPlain gate (:1014-1017)
│   #                             — bracket rules, deleted-text check (R3)
│   #   planPush (:987-1041)      — fold-together step, lane exclusivity (R2)
│   #   applyHunks (:1218-1334)   — honor recorded attrs (drop :1251 probe),
│   #                               apply-result return, counted skips (R1/R4)
│   #   buildChangeReport (:1442) — optional outcomes filter (R4)
│   #   applySyncPush (:1706-1906)— converged on all branches, apply-derived
│   #                               operations/blocksChanged, noop honesty (R5/R6)
└── mcp/tools/tool-documentation/export-api.js  # receipt teaching text (R9)

server/__tests__/
├── markdown-sync.apply-correctness.test.js   # NEW — committed corpus (R7)
└── markdown-sync.{replay,convergence,alignment,order-independence,
    overlap,rejection}.test.js                # gates; targeted extensions only

__tests__/integration/
└── sync-push.route.test.js                   # extend: converged/noop/dry-run receipts
```

**Structure Decision**: single-module change confined to
`server/markdown-sync.js` plus its two existing test surfaces and one
teaching-text file — matching how 054/055 landed in the same engine.
`server/mcp/yjs/serialization.js` (source map) is read, not modified.

## Design Overview (how the pieces meet the invariants)

1. **Plan-side marks (I1)**: `classifyRange` samples the resolved run's
   attrs at plan time (runs are maximal same-marks spans, so one character
   is authoritative); resolution order untouched. `applyHunks` step 2 uses
   the recorded attrs and loses its `toDelta()` probe. Replacements record
   the first replaced character's run attrs — deterministic where today's
   post-delete probe reads whatever follows.
2. **Fold-together (I2)**: a post-classification pass in `planPush` moves
   every hunk of any structurally claimed block into the structural lane;
   the existing group coalescing + rebuild composition then covers all
   hunks. Forced hunks and edge-block insertions are non-triggers. Apply's
   replaced-block skips become counted dead-man switches.
3. **Bracket syntax (I3)**: `[`/`]` in inserted OR deleted text disqualifies
   the plain lane; whole-block reparse (reconcile → structural) handles both
   literal brackets and real link syntax correctly by construction.
4. **Apply result (I4)**: `applyHunks` reports performed counts + per-op
   outcomes + `skipped`; receipts derive `operations` and a filtered
   `blocksChanged` from it. Report inputs are baseline-side and immutable,
   so building/filtering after the transaction is safe.
5. **`converged` (I5)**: one fork-side byte comparison feeding all four
   receipt branches, incl. the already-applied noop over a diverged doc
   (the field's S1 lie) and dry-run parity.
6. **Corpus (I6)**: repro1–4 encoded as scenario tables in a DB-free suite
   asserting first-push convergence, one-push repair convergence, receipt
   honesty, and leak-freedom; route tests pin the noop/dry-run receipt
   cases end-to-end.

## Risks & mitigations

- **Reconcile-lane widening (R3)** shifts some bracket-bearing edits from
  char splice to whole-block reconcile. Reconcile is marks-preserving and
  in-place, but overlap semantics label it `text` (unchanged 054 rule) and
  counts move from per-hunk to per-block granularity — the corpus + existing
  overlap suite verify no contract drift; R8 names the only two legitimate
  expectation-update classes.
- **Replacement-marks semantics change (R1)** is a deliberate determinism
  fix; the convergence property suite (offline-client equivalence) is the
  arbiter if any live-typing-parity question arises.
- **Report-after-apply refactor (R4)** relies on report inputs being
  baseline-side; `apply-invariants.md` I4 pins it and the 054 route tests
  re-verify excerpt correctness.
- **055 interaction**: fold-together must never touch forced hunks —
  guarded, asserted in the alignment gate suite, and any violation surfaces
  as a counted skip + `converged: false`, never a double-apply.

## Complexity Tracking

> No Constitution Check violations — table intentionally empty.
