# Feature Specification: Block-Aligned Merge Pre-Pass for Sync Push

**Feature Branch**: `055-block-aligned-merge` (spec directory; work is orchestrated on the current branch — no feature branch is created by the spec phase)

**Created**: 2026-08-11

**Status**: Draft

**Input**: User description: "Block-aligned merge pre-pass for the markdown two-way-sync engine (feature 055-block-aligned-merge)"

**Design ground truth**: `design/markdown-import-two-way-sync.md` — §2.4/§2.4.1 (offline-collaborator replay model, v1 limits) and "Amendment (2026-08-11) — sync hardening from agent field feedback", bullet "Block-aligned merge (055)". Source field report: https://squiredocs.com/d/01999aaa-2d15-438d-acc6-d8a2f078091a (context; the amendment is authoritative).

## Problem Statement

The sync push engine today computes a single character-level diff over the whole
concatenated document (baseline canonical markdown vs pushed markdown). A
character LCS has no notion of blocks: when two distant blocks contain similar
text, the diff can fuse fragments of unrelated blocks into one hunk, and a
heading rename can "match" against a different heading elsewhere in the
document, re-anchoring the edit onto the wrong block. The result is a push that
is textually correct as a whole-document transformation but structurally wrong:
edits land in blocks the repo editor never touched, destroying those blocks'
collaboration identity and producing misleading overlap flags.

The ratified fix: align baseline and pushed documents **at block level first**
(a block-level longest-common-subsequence), run character diffing **only inside
matched block pairs**, and turn unmatched or insufficiently similar pairs into
**atomic whole-block insert / delete / replace** operations. Cross-block
character splicing becomes impossible by construction. Same-span rewrites
inside a matched block keep today's live-editing interleave semantics (design
v1 limit (a) survives, now scoped to block granularity).

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Edits land only in the blocks that were edited (Priority: P1)

A coding agent (or human) edits a repo copy of a synced document: it renames
one heading and rewords one paragraph in a different section. It pushes the
file. In Squire, exactly those two blocks change; every other block —
including other headings with similar text — is untouched, byte-identical in
the receipt re-export, and keeps its collaboration identity (concurrent live
edits to untouched blocks always survive).

**Why this priority**: This is the field-reported failure the amendment
ratifies a fix for. Mis-anchored edits silently corrupt content that nobody
edited — the worst possible failure mode for a sync engine whose pitch is
"deterministic merging with no conflict interface".

**Independent Test**: Push a file with a heading rename plus a distant
paragraph edit against a baseline containing a second, similarly worded
heading. Verify via the receipt (and the per-block change report) that only
the two intended blocks changed and the decoy heading is untouched.

**Acceptance Scenarios**:

1. **Given** a baseline with headings "Deployment" and "Deployment Notes" plus
   paragraphs under each, **When** the pushed file renames only "Deployment" to
   "Rollout", **Then** the "Deployment Notes" heading and all paragraphs are
   unchanged and only the renamed heading block carries an edit.
2. **Given** a pushed file that edits block A and block Z of a 40-block
   document, **Then** the change report lists exactly two changed blocks and
   no planned edit spans text belonging to more than one baseline block.
3. **Given** a live collaborator concurrently editing block B (untouched by
   the push), **When** the push applies, **Then** the collaborator's edit
   survives verbatim and block B is not flagged as an overlap.

---

### User Story 2 - Rewritten blocks replace atomically, never splice (Priority: P2)

A repo editor rewrites a paragraph wholesale (below the similarity threshold —
effectively new text in the same position). The push replaces that block as
one atomic operation instead of producing an interleaved character splice of
old and new text. If a live collaborator concurrently edited inside that
block, the replacement wins and the block is flagged as an overlap for
after-the-fact review — exactly the design §2.4.1 outcome table, now applied
predictably instead of depending on diff luck.

**Why this priority**: Below-similarity char splices produce garbled hybrid
text. Atomic replacement is coarser but always coherent, and the overlap flag
plus version history is the designed review path.

**Independent Test**: Push a file where one block's text is fully rewritten;
verify the plan contains a single whole-block structural replace for it (no
character ops), neighbors are untouched, and a concurrent doc-side edit to
that block produces an overlap flag.

**Acceptance Scenarios**:

1. **Given** a baseline paragraph and a pushed file replacing its text
   entirely, **Then** the block is replaced atomically and adjacent blocks
   keep their identity.
2. **Given** a pushed file that deletes one block and adds a new unrelated
   block elsewhere, **Then** the plan is one whole-block delete plus one
   whole-block insert — never a character edit that morphs one into the other.
3. **Given** a matched pair whose similarity is just above the threshold,
   **Then** the pair is character-diffed; **Given** just below, **Then** it is
   an atomic replace (threshold behavior pinned by boundary tests).

---

### User Story 3 - Same behavior at every document size (Priority: P3)

A team syncs both small design docs and very large documents (beyond the
engine's whole-document diffing threshold). The same logical edit — rename a
heading, reword a paragraph, rewrite a block — produces the same plan and the
same receipt semantics regardless of document size, and planning a small edit
to a huge document remains fast because comparison work is confined to the
blocks that actually differ.

**Why this priority**: Today the engine has two diff paths (whole-document
character diff for small inputs, line-anchored coarse diff for large ones)
with different anchoring behavior. Divergent semantics by size is a latent
trust bug; unification is a direct consequence of the block pre-pass.

**Independent Test**: Apply the identical edit to a small doc and to a
size-inflated variant (past the current 64KB whole-doc threshold); assert the
plan classification and per-block change report are equivalent.

**Acceptance Scenarios**:

1. **Given** the same one-word edit in a 1KB doc and a >64KB doc, **Then**
   both plans classify it identically (a character-level text edit in the same
   block).
2. **Given** a >64KB document with one edited block, **Then** planning
   completes without comparing the full document character-by-character and
   within the engine's existing time bounds.
3. **Given** a single pathologically large block (beyond the per-pair
   comparison cap) that was edited, **Then** that pair alone degrades to an
   atomic replace; the rest of the document still gets fine-grained treatment.

---

### Edge Cases

- **Clean round trip**: pushing an unmodified export (canonically equal text)
  must align every block as an exact match, produce zero hunks, zero
  operations, and no version entry — the standing round-trip invariant.
- **Duplicate blocks**: several byte-identical blocks (e.g. repeated `---`
  separators or duplicated boilerplate paragraphs) must align stably by
  sequence position (LCS over the block sequence handles duplicates); editing
  one of three identical paragraphs edits the aligned one, not an arbitrary one.
- **Block split**: one baseline block becomes two pushed blocks — the more
  similar pushed block pairs and character-diffs; the remainder becomes a
  whole-block insert. Identity of the surviving half is preserved.
- **Block merge**: two baseline blocks become one pushed block — the more
  similar baseline block pairs; the other becomes a whole-block delete.
- **Heading level change** (`#` → `##`, text unchanged): high similarity pairs
  the blocks; the change touches structure, so it replays as a one-block
  atomic replace (existing classifier semantics — block identity is lost,
  concurrent intra-block edits drop with the old node, flagged as overlap).
- **Block type change** (paragraph → list item, paragraph → code fence): same
  as heading level change — matched pair, atomic one-block replace.
- **Moved/reordered block**: v1 treats a move as delete-at-old-position +
  insert-at-new-position (no move detection); a concurrent doc-side edit
  inside the moved block is dropped with the deleted node and flagged.
- **Empty pushed document**: every baseline block becomes a whole-block delete.
- **Empty baseline** (first sync of content into an empty doc): every pushed
  block is a whole-block insert.
- **Very short blocks**: two-word blocks rewritten score near-zero similarity
  and replace atomically — acceptable; there is nothing fine-grained to save.
- **Adjacent atomic replaces**: consecutive below-threshold pairs may be
  applied as one contiguous structural replacement (existing adjacent-range
  merging); the invariant is that structural operations cover whole blocks
  only and never absorb a matched (character-diffed) block between them.
- **Character-diff cap tripped inside a pair**: if the bounded character diff
  within a matched pair gives up (edit-length cap), that pair degrades to an
  atomic replace; no whole-document fallback is triggered.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001 (Alignment pre-pass)**: Sync push planning MUST align the baseline
  and pushed documents at block level before any character-level comparison:
  a longest-common-subsequence over the two sequences of canonical block
  strings anchors exactly-equal blocks; blocks inside the gaps between
  anchors are then paired by similarity (FR-003). Every planned edit MUST be
  attributable to exactly one matched block pair or be a whole-block
  insert, delete, or replace.
- **FR-002 (No cross-block splices — the core invariant)**: No
  character-level edit may span text belonging to more than one baseline
  block, and no character-level edit may combine content from two different
  pushed blocks. Structural operations operate on whole blocks only. This
  invariant MUST hold by construction for every input, both document sizes,
  and MUST be asserted by tests (including the field-report regression: a
  heading rename in the presence of a similar decoy heading).
- **FR-003 (Similarity pairing)**: Within each alignment gap, baseline and
  pushed blocks MUST be paired deterministically and order-preservingly
  (pairing never reorders blocks), preferring the highest-similarity pairs.
  The similarity measure and threshold are fixed by RBD-055-1/-2 (see
  Assumptions): Dice similarity over the canonical block markdown, threshold
  0.5, computed with bounded work. Pairs at or above the threshold are
  matched; everything else falls to FR-005. (RBD-055-1 amended 2026-08-11:
  the features are WORDS for prose blocks and characters for blocks of ≤ 3
  words — the threshold and everything else here is unchanged.)
- **FR-004 (Inside a matched pair)**: Character-level diffing runs only
  inside matched pairs, producing hunks confined to that pair's baseline
  block extent. Downstream classification is unchanged in contract: hunks
  still classify as surgical text ops, whole-block inline reconciliation, or
  structural replacement by the existing rules (text edits keep marks and
  block identity; syntax-touching changes such as a heading level change
  replace the block). Same-span rewrites inside a matched block keep
  live-editing interleave semantics — design v1 limit (a) survives at block
  granularity.
- **FR-005 (Atomic structural ops)**: Unmatched pushed blocks become
  whole-block inserts at their aligned position; unmatched baseline blocks
  become whole-block deletes; below-threshold pairs become single-block
  atomic replaces. None of these may be expressed as character splices.
  Concurrent-edit outcomes for these ops follow the design §2.4.1 table
  (replacement/deletion wins, flagged as overlap).
- **FR-006 (Heading renames anchor correctly)**: A heading whose text is
  edited but whose level is unchanged and whose similarity clears the
  threshold MUST replay as an in-place edit of that same heading block,
  preserving its identity — never re-anchored onto a different heading,
  regardless of how similar other headings are.
- **FR-007 (Moves are delete+insert in v1)**: Block moves and reorders are
  not detected; they replay as whole-block delete plus insert (RBD-055-3).
  The overlap detector MUST still flag a doc-side-edited block that the push
  deleted.
- **FR-008 (Size parity and bounded work)**: The block-alignment pre-pass is
  the single top-level planning path for all document sizes (RBD-055-5). The
  same logical edit MUST produce the same plan classification in a small and
  a large document. No whole-document character diff runs at any size;
  per-pair comparison work is bounded by the existing caps, and a
  cap-exceeded pair degrades to an atomic replace of that pair only
  (RBD-055-6).
- **FR-009 (Round-trip invariant preserved)**: `import(export(doc))` remains
  a no-op: a canonically-equal push aligns as all exact matches and yields
  zero hunks, zero operations, and no version entry. The existing round-trip
  and convergence property tests MUST continue to pass unchanged, including
  order-independence under mid-push live edits.
- **FR-010 (Existing contracts unchanged)**: Overlap detection (state-vector
  gate + block LCS against the live doc), edge-of-block whole-block
  insertion semantics, flavor-aware mark preservation on reconcile, and
  within-block hunk coalescing keep their current contracts. The per-block
  change report and receipt fields defined by feature 054 are a dependency,
  not part of this scope: 055 MUST populate that report with the op kinds
  the alignment chose (text / reconcile / structural), making atomic
  replaces visible to the pusher.
- **FR-011 (Threshold testability)**: The similarity threshold is an
  implementation-tunable named constant, not protocol surface. Its behavior
  MUST be pinned by boundary tests: a pair just above the threshold
  character-diffs; a pair just below replaces atomically; the metric is
  deterministic for identical inputs.
- **FR-012 (Test coverage)**: New tests MUST cover: the decoy-heading
  anti-splice regression; distant-blocks independence; split, merge,
  duplicate-block, move, empty-side, and type-change cases; threshold
  boundaries; large-document parity (same edit, both size regimes); and
  cap-degradation inside a single pair. All existing sync suites
  (replay, convergence, order-independence, overlap, rejection) and the
  round-trip property test MUST pass without weakening.

### Key Entities

- **Block**: a top-level document unit (heading, paragraph, list, code fence,
  table, rule) with a canonical markdown string and a stable extent in the
  baseline text; the unit of alignment and of collaboration identity.
- **Block alignment**: the correspondence between the baseline block sequence
  and the pushed block sequence — exact anchors from the block-level LCS plus
  similarity-paired blocks inside gaps.
- **Matched pair**: one baseline block aligned with one pushed block; the only
  context in which character-level diffing is permitted.
- **Similarity score / threshold**: the deterministic measure deciding whether
  a gap pairing is "the same block, edited" (character diff) or "a different
  block" (atomic replace); threshold is tunable, behavior test-pinned.
- **Atomic structural operation**: whole-block insert, delete, or replace
  produced for unmatched or below-threshold blocks; never partial-block.
- **Overlap flag**: existing advisory marker for blocks changed on both sides
  since the baseline; unchanged in shape, fed more accurate inputs.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: In the regression corpus (including the field report's
  rename-with-decoy-heading case), 100% of pushed edits land in the blocks
  the repo editor actually edited; zero edits touch any other block.
- **SC-002**: For every push in the test corpus, no planned character edit
  spans more than one baseline block — verifiable from the plan and the
  per-block change report without inspecting engine internals.
- **SC-003**: Pushing an unmodified export produces zero operations and no
  version entry for 100% of documents in the round-trip property corpus.
- **SC-004**: The same logical edit produces an equivalent plan and change
  report in a small (~1KB) and a large (>64KB) document — parity holds for
  every case in the parity matrix.
- **SC-005**: Planning a single-block edit in a large document does not
  require comparing the full document character-by-character, and end-to-end
  push latency does not regress versus the current engine on the existing
  sync test corpus.
- **SC-006**: A wholesale block rewrite never yields interleaved old/new
  hybrid text in the final document: the result is either the pushed text
  (atomic replace) or a flagged overlap outcome per the design table.
- **SC-007**: All pre-existing sync guarantees hold: convergence with an
  equivalent offline collaborator, order-independence under mid-push live
  edits, and advisory-only (never gating) overlap flags.

## Assumptions

Decisions the design amendment leaves open, each recorded as
RATIFIED-BY-DEFAULT in `clarifications-needed.md` (Sam pre-authorized,
2026-08-11):

- **RBD-055-1 — Similarity metric and threshold**: Dice similarity
  `2·C / (|A|+|B|)` over canonical block markdown, threshold **0.5**.
  (Amended 2026-08-11, ledger amendment A1: the features are word multisets
  for prose blocks, character multisets for blocks of ≤ 3 words. The original
  character-LCS metric scored unrelated English prose 0.41–0.69 and so failed
  to separate a rewrite from an edit.)
- **RBD-055-2 — Gap pairing discipline**: deterministic, order-preserving
  pairing inside each LCS gap, preferring highest-similarity pairs; never
  reorders; leftovers become inserts/deletes.
- **RBD-055-3 — Moves are delete+insert in v1**: no move/rename tracking.
- **RBD-055-4 — Heading-level and block-type changes**: replay as a one-block
  atomic replace via the existing classifier (identity loss accepted and
  flagged, as today).
- **RBD-055-5 — Single path for all sizes**: the pre-pass replaces both the
  whole-document character diff (≤64KB) and the whole-document line-anchored
  coarse fallback (>64KB) as the top-level path; size thresholds survive only
  as per-pair bounds.
- **RBD-055-6 — Bounded similarity work**: pairs where either side exceeds
  the existing per-cluster size cap are treated as below threshold without
  computing a diff; an in-pair character diff that trips the edit-length cap
  degrades that pair to an atomic replace.
- **RBD-055-7 — Splits and merges via gap pairing**: no dedicated
  split/merge detection; the best-similarity pairing plus insert/delete
  leftovers covers them.

Dependencies and boundaries:

- **Depends on feature 054** (parallel sibling, `specs/054-sync-feedback-hardening`)
  for the receipt/report surface: staleness fields, dryRun, and the
  per-block `blocksChanged` report (op kinds text | reconcile | structural).
  055 changes *which* ops are planned; 054 owns *how they are reported*. If
  054's final report shape differs, reconciliation happens at plan/merge
  time, not by re-specifying it here.
- The engine's offline-collaborator replay model, overlap advisory model,
  attribution, and receipt canonicalization are unchanged (design §2.4).
- Baseline canonicalization (parse-and-reserialize of the pushed file) still
  precedes planning, so formatting-only edits still vanish before alignment.
- A block-level LCS building block already exists in the engine (the overlap
  detector's doc-side change identification uses one); the pre-pass is
  expected to reuse that approach, not invent a second alignment notion.

## Out of Scope

- **Feature 054's items**: staleness signal (baselineClock/currentClock/
  clockGap/docChangedSinceBaseline, strict mode), dryRun, the per-block
  change report shape, ordered-list start preservation, and the
  whole-file-sync-vs-modify guidance split. 055 consumes 054's surfaces.
- Block move/reorder detection and identity-preserving moves (possible v2).
- Any conflict-resolution interface or blocking conflict states (design
  explicitly rejects these).
- Changes to the overlap flag shape, receipt fields, REST API surface,
  parser, serializer, or source-map contract.
- Similarity tuning beyond the pinned default (threshold stays a constant;
  no per-push or per-doc configuration).
- Version-history retention policy (design open question 1).
