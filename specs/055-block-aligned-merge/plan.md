# Implementation Plan: Block-Aligned Merge Pre-Pass for Sync Push

**Branch**: `main` (orchestrated; no feature branch — pipeline worktree merge) | **Date**: 2026-08-11 | **Spec**: specs/055-block-aligned-merge/spec.md

**Input**: Feature specification from `specs/055-block-aligned-merge/spec.md`

**Design ground truth**: `design/markdown-import-two-way-sync.md` §2.4/§2.4.1 +
"Amendment (2026-08-11)", bullet "Block-aligned merge (055)".

**Sequencing**: implemented AFTER feature 054 (`specs/054-sync-feedback-hardening`)
merges — both touch `server/markdown-sync.js`, and 055 populates the
`blocksChanged` report 054 defines. All tasks assume 054's receipt/report shape
is on main.

## Summary

Replace the sync push engine's whole-document character diff (and the >64KB
line-anchored coarse fallback) with a **block-alignment pre-pass**: a
block-level LCS over canonical block strings anchors exactly-equal blocks;
blocks inside the gaps are paired deterministically by bounded Dice similarity
(threshold 0.5); character diffing runs only **inside matched pairs**; and
unmatched or below-threshold blocks become **atomic whole-block insert /
delete / replace** operations, emitted as forced structural hunks that bypass
re-classification. Cross-block character splicing becomes impossible by
construction (FR-002), one planning path serves every document size (FR-008),
and all downstream contracts — hunk classification vocabulary
(text | reconcile | structural), the plan object shape 054's `blocksChanged`
report reads, overlap advisory, round-trip no-op, convergence — are preserved
unchanged. Technical approach fixed in `research.md` R1–R8.

## Technical Context

**Language/Version**: Node.js 22 (CommonJS server modules)

**Primary Dependencies**: `yjs`, `diff` (`diffChars`, `diffArrays` — both
already imported by the module; `diffLines` is retired with the coarse path).
**No new dependencies.**

**Storage**: N/A — no schema change, **no migrations** (hard override: if a
migration turns out to be needed, STOP and report). Planner is pure in-memory
compute inside `applySyncPush`.

**Testing**: Jest, `server/__tests__/` (per-worker DB isolation per
Constitution II; the planner suites are pure and DB-free). Existing suites:
`markdown-sync.replay|convergence|order-independence|overlap|rejection.test.js`,
`import-roundtrip.test.js`, `format-roundtrip.test.js` — extended, never
duplicated or weakened.

**Target Platform**: Linux server (app pod), horizontally scalable (VII: no
process-local state — the planner is a pure function of its inputs)

**Project Type**: single web-service repo; change is confined to
`server/markdown-sync.js` + tests (plus a one-paragraph README accuracy edit)

**Performance Goals**: SC-005 — planning a single-block edit in a >64KB doc
must not compare the full document character-by-character; end-to-end push
latency must not regress on the existing sync corpus (existing
performance-guard describe in the replay suite is the harness).

**Constraints**: All comparison work bounded per pair: `PAIR_INPUT_MAX`
(16KB/side, was `COARSE_CLUSTER_MAX`), `MAX_EDIT_LENGTH` (10000),
`MAX_GAP_DP_CELLS` (new, ~10_000) — every bound degrades exactly one pair/gap
to coarser granularity, never to a whole-document fallback (RBD-055-6).

**Scale/Scope**: documents up to MAX_IMPORT_BYTES (5MB); hundreds of top-level
blocks typical, thousands possible.

## Constitution Check

*GATE: evaluated pre-Phase-0 and re-checked post-design — PASS (no Complexity
Tracking entries needed).*

- **I. Documentation Reflects Reality — PASS with required task**: README.md
  line ~517 currently says "the file is character-diffed against the fork's
  canonical markdown". The implement phase MUST update that paragraph to the
  block-aligned mechanics in the same change. No other README/docs text
  mentions the retired coarse path or the 64KB threshold (checked 2026-08-11).
- **II. Test-Backed Changes — PASS**: FR-012 test matrix is the core of
  tasks.md; format round-trip suite untouched in contract (no serializer
  change); planner suites are DB-free and parallel-safe.
- **III. Trunk-Based Solo Workflow — PASS**: pipeline worktree + merge queue
  per /the-pipeline; this plan adds no ceremony.
- **IV. Collaboration-Safe Document Operations — PASS**: the feature's entire
  purpose is to protect CRDT identity (edits land only in edited blocks;
  untouched blocks byte-identical and identity-preserved). Atomic whole-block
  replacement is delete-and-recreate at block granularity — this is the
  design-sanctioned bounded exception (§2.4.1 outcome table, RBD-055-4/-5),
  chosen only when in-place expression is impossible (unmatched/below-
  threshold/cap-tripped), and 055 makes it *more* precisely scoped than the
  status quo (single blocks instead of whatever a lucky char diff fused). The
  classifier's prefer-text/reconcile-first contract survives verbatim inside
  matched pairs. Not a violation; no tracking entry.
- **V. Secure by Default — PASS**: no new ingestion surface; every replayed
  fragment still flows through `mdToNodes` (post-policy, data:-image stripped,
  F1 defense-in-depth unchanged). Forced-op `newText` is sliced from the
  already-canonicalized (staged-image-policy) pushed markdown.
- **VI. Design Docs Are Ground Truth — PASS**: design amendment bullet
  "Block-aligned merge (055)" is the mandate; the three flagged gaps live in
  `clarifications-needed.md` (054 report vocabulary, limit-(b) frequency
  shift, coarse-path retirement). If implementation falsifies RBD-055-5's
  one-path mechanism, the Squire design doc must be amended (never
  hand-edited) before a fallback is kept.
- **VII. Horizontally Scalable App Pods — PASS**: pure compute; no
  process-local correctness state.
- **Technology constraints — PASS**: no third-party markdown/serialization
  dependency added; registry-driven pipeline untouched.

## Project Structure

### Documentation (this feature)

```text
specs/055-block-aligned-merge/
├── plan.md              # This file
├── research.md          # Phase 0 — decisions R1–R8
├── data-model.md        # Phase 1 — planner entities & state
├── quickstart.md        # Phase 1 — validation guide
├── contracts/
│   └── planner-invariants.md   # Phase 1 — internal planner contract + preserved surfaces
├── checklists/requirements.md  # (pre-existing)
├── clarifications-needed.md    # (pre-existing ledger, RBD-055-1..7)
└── tasks.md             # Phase 2 (/speckit-tasks — NOT created by plan)
```

### Source Code (repository root)

```text
server/
├── markdown-sync.js                 # THE change: alignment pre-pass, gap pairing,
│                                    #   forced hunks, coarse-path retirement,
│                                    #   canonicalizePushed* return `blocks`
├── mcp/yjs/serialization.js         # NOT modified (out of scope). Consumed:
│                                    #   toMarkdownWithSourceMap (blocks extents)
└── __tests__/
    ├── markdown-sync.alignment.test.js     # NEW — pure planner suite (FR-012)
    ├── markdown-sync.replay.test.js        # extend: decoy regression, size parity,
    │                                       #   perf guard on the unified path
    ├── markdown-sync.convergence.test.js   # call-site update only (R8 audit: green)
    ├── markdown-sync.order-independence.test.js  # call-site update only
    ├── markdown-sync.overlap.test.js       # extend: forced-op overlap flags
    └── markdown-sync.rejection.test.js     # unchanged (validation path untouched)

README.md                            # sync paragraph accuracy edit (Principle I)
```

**Structure Decision**: single-module change by design — the pre-pass is a new
top half of `computeHunks` plus a forced-hunk lane through `planPush`;
`applyHunks`, `structuralOps`, overlap detection, and 054's report builder are
consumers whose input shape is deliberately kept fixed (research R5).

## Architecture (Phase 1 design summary)

Pipeline inside `applySyncPush` (unchanged orchestration, new planner core):

```text
buildBaseline ──► canonicalMd + sourceMap.blocks (baseline extents, node identity)
canonicalizePushedStaged ──► pushedMd + pushedBlocks (extents only; R1)
        │
        ▼
computeHunks(canonicalMd, pushedMd, baseBlocks, pushedBlocks)      [R2–R6]
  1. exact-anchor pass: diffArrays over canonical block strings (block LCS)
  2. per gap: bounded Dice similarity (R3) + order-preserving max-sim DP
     pairing, positional fallback over MAX_GAP_DP_CELLS (R4)
  3. matched pair → in-pair diffChars (cap → degrade pair to forced replace),
     offsets rebased to baseline coords, COALESCE_DISTANCE coalescing
  4. residual runs → forced structural hunks (replace/delete/insert) per the
     gap-emission + anchor-folding rules (R6)
        │
        ▼
planPush(hunks, sourceMap, baselineMd)
  - forced hunks → plan.structural directly (FR-005 by construction)
  - in-pair hunks → classifyRange → text | reconcile | structural (unchanged
    contracts: prefer-text, reconcileBlockPlan heading-level decline,
    isEdgeBlockInsertion)
        │
        ▼
applyHunks / structuralOps        (UNCHANGED)
overlap detection (pushTouchedBlocks / docSideChanges)   (UNCHANGED)
054 blocksChanged report builder  (UNCHANGED — reads the same plan shape)
```

Invariant argument for FR-002 (no cross-block splices), by construction:
in-pair hunks are computed from exactly one baseline block string and one
pushed block string, so `[oldStart, oldEnd)` cannot leave the baseline block's
extent and `newText` cannot contain another pushed block's content; forced
hunks cover whole block extents only. There is no other hunk source.

Preserved-surface argument (FR-009/FR-010): the `pushedMd === canonicalMd`
no-op short-circuit runs before the planner (round-trip invariant holds before
alignment is even reached); a canonically-equal push that did reach alignment
would produce all-exact anchors and zero hunks. The plan object shape, receipt
`operations` counts, overlap flag shape, synthetic clientID derivation,
idempotency short-circuit, and store-then-apply flow are untouched.

## Phase 0 → research.md

All eight open questions resolved (R1 pushed-side extents, R2 block LCS,
R3 bounded Dice, R4 gap-pairing DP + cap, R5 forced-hunk representation,
R6 gap emission/anchor folding, R7 coarse-path retirement, R8 test strategy +
convergence-generator audit). No NEEDS CLARIFICATION remain.

## Phase 1 → data-model.md, contracts/planner-invariants.md, quickstart.md

- `data-model.md`: Block, BlockAlignment, Gap, MatchedPair, ResidualRun,
  ForcedHunk, Plan — field-level shapes and state transitions.
- `contracts/planner-invariants.md`: the internal planner contract (hunk
  vocabulary, plan shape consumed by 054's report + overlap detector), the
  named constants, and the preserved external surfaces. No REST/API contract
  changes (receipt shape is 054's; explicitly out of scope here).
- `quickstart.md`: runnable validation scenarios (suites + decoy regression +
  parity + round-trip property).

## Post-design Constitution re-check

Unchanged from the pre-Phase-0 evaluation: PASS on all seven principles; no
Complexity Tracking entries. The one Principle-I obligation (README sync
paragraph) is carried as an explicit implement-phase task.

## Complexity Tracking

> No constitution violations to justify — table intentionally empty.
