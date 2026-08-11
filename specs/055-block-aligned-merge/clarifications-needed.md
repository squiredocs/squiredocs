# Clarifications Ledger: 055-block-aligned-merge

Per Constitution VI, unanswered product decisions get the best default,
recorded here — work never blocks on the maintainer, and nothing is decided
silently. All entries below: **RATIFIED-BY-DEFAULT (Sam pre-authorized,
2026-08-11)** unless later overturned.

---

## RBD-055-1 — Similarity metric and threshold

> **AMENDED 2026-08-11** by the post-merge review (MEDIUM-3): the metric
> below is replaced for multi-word blocks and part of its rationale is
> withdrawn as falsified. See "Amendment A1" at the end of this ledger. The
> threshold (0.5) is unchanged.

**Question**: The design amendment says "below-similarity-threshold pairs
become atomic structural replace" but names no metric and no value. What
decides "same block edited" vs "different block"?

**Why it matters**: This single number is the boundary between fine-grained
merge (marks and concurrent edits survive) and atomic replacement (coherent
but coarse, drops concurrent intra-block edits with a flag). Too low → the
old splice pathology returns inside a pair; too high → routine heavy edits
needlessly lose block identity.

**Default chosen**: Character-level Dice similarity over the canonical block
markdown strings: `sim(a,b) = 2·C / (|a|+|b|)` where C is the number of
common characters per a bounded character LCS. Threshold **0.5** — a block
is "the same block, edited" when at least half its combined characters
survive the edit.

**Rationale**: Dice over canonical text is deterministic, symmetric, cheap
to compute with the diff machinery the engine already uses, and includes
syntax characters, so a renamed heading keeps its `## ` prefix in common
with itself. 0.5 is the natural midpoint: a majority-surviving block merges
finely; a majority-rewritten block replaces atomically (which is what a
human would call a rewrite). Pinned by boundary tests (FR-011), tunable as
a named constant without protocol impact.

---

## RBD-055-2 — Gap pairing discipline

**Question**: Inside an LCS gap (N baseline blocks removed, M pushed blocks
added), how are candidate pairs chosen?

**Why it matters**: Different pairing rules give different answers for
splits, merges, and adjacent-edit clusters; nondeterminism here would make
receipts unreproducible.

**Default chosen**: Deterministic, order-preserving pairing that prefers the
highest-similarity pairs within the gap; pairing never reorders blocks
relative to each other; unpaired leftovers become whole-block inserts or
deletes.

**Rationale**: Order preservation matches the LCS frame (a pre-pass, not a
move detector) and keeps the algorithm explainable: an edit can move
content earlier/later only via delete+insert, never via a crossed pairing.
Preferring similarity (rather than blind positional pairing) makes
splits/merges and delete-one-edit-other cases land on the right block.
Exact algorithm (small DP vs greedy) is a plan-phase choice; the spec pins
determinism, order preservation, and similarity preference.

---

## RBD-055-3 — Block moves/reorders are delete+insert in v1

**Question**: Should the aligner detect a moved block and preserve its
identity across the move?

**Why it matters**: A moved block loses CRDT identity (undo/attribution
continuity) and any concurrent doc-side edit inside it drops with the
deleted node (flagged as overlap).

**Default chosen**: No move detection in v1. A move replays as whole-block
delete + whole-block insert, with the existing overlap flag covering the
concurrent-edit case.

**Rationale**: The design amendment is silent on moves; LCS-with-similarity
inherently reads a move as delete+insert. Move detection is a strictly
additive later improvement (identity-preserving relocation), and its
absence is safe: outcomes match the design §2.4.1 table for
delete/insert. Recorded as explicit out-of-scope so nobody mistakes it for
an accidental gap.

---

## RBD-055-4 — Heading-level and block-type changes replace atomically

**Question**: `# Title` → `## Title` (or paragraph → list): matched pair
with high similarity, but the change touches block structure. In-place
transform or atomic replace?

**Why it matters**: In-place would preserve identity but requires
type-mutation machinery the engine doesn't have; replace loses identity
and drops concurrent intra-block edits (flagged).

**Default chosen**: The matched pair's in-pair diff feeds the existing
classifier unchanged, which already resolves this to a one-block
structural replace (the whole-block inline reconciliation path explicitly
declines type and heading-level changes). 055 changes only the anchoring —
the change hits the right block — not the op chosen.

**Rationale**: Matches current shipped semantics and the design outcome
table; keeping classifier contracts frozen is what makes 055 a pre-pass
rather than an engine rewrite. In-place type mutation can be proposed
separately if flagged overlaps prove noisy.

---

## RBD-055-5 — One path for all document sizes

**Question**: The amendment retires the whole-document character LCS, but
says nothing about the >64KB coarse path (line-anchored diffLines +
per-cluster char diff), which is currently *safer* than the small-doc path.
Does the pre-pass apply there too?

**Why it matters**: Two top-level paths mean size-dependent semantics — the
same edit classifying differently at 63KB vs 65KB — which is exactly the
kind of latent divergence the parity requirement (FR-008) exists to kill.

**Default chosen**: Block alignment becomes the single top-level planning
path at every size. The former whole-doc char diff and whole-doc coarse
line diff are both retired from the top level; size limits survive only as
per-pair bounds (RBD-055-6). Behavior parity across sizes becomes a tested
invariant (SC-004).

**Rationale**: The pre-pass naturally bounds work (only gap blocks are
compared), so the reason the coarse path existed — unbounded O(N·D) on big
inputs — disappears. Keeping a second path would preserve a semantic fork
for zero benefit. Block-level LCS over block strings is near-linear for
the common mostly-equal case.

---

## RBD-055-6 — Bounded similarity and in-pair diff work

> **EXTENDED 2026-08-11** by the post-merge review (HIGH-2): the same
> degrade mechanism now also applies per GAP, on a work budget rather than a
> cell count. See "Amendment A2" at the end of this ledger.

**Question**: What bounds the cost of similarity scoring and in-pair
character diffs, and what happens when a bound trips?

**Why it matters**: Character-LCS cost is unbounded on adversarial or huge
blocks; the engine has hard bounds today (64KB input skip, 16KB cluster
cap, 10000 edit-length cap) that must not silently vanish.

**Default chosen**: Reuse the existing caps at pair granularity: a pair
where either side exceeds the existing per-cluster cap (16KB) is declared
below threshold without computing a diff; an in-pair character diff that
trips the edit-length cap degrades that single pair to an atomic replace.
No bound ever triggers a whole-document fallback.

**Rationale**: Degrading exactly one pair keeps the blast radius of a bound
to the block that caused it — the rest of the document still merges finely.
Values stay implementation-tunable constants, consistent with their
current status ("not protocol surface").

---

## RBD-055-7 — Splits and merges via gap pairing, no dedicated detection

**Question**: One block split into two, or two merged into one — special
handling?

**Why it matters**: Splits/merges are common repo edits (breaking up a long
paragraph, joining bullets into prose).

**Default chosen**: No dedicated detection. Gap pairing pairs the
most-similar fragment with the original (character diff inside the pair
preserves that fragment's identity and any concurrent edits within it);
the remainder becomes a plain whole-block insert (split) or delete
(merge).

**Rationale**: Preserves identity for the surviving majority fragment —
strictly better than today's behavior — without split/merge heuristics
that would need their own thresholds. The design's outcome table already
covers the leftover ops.

---

# Design gaps flagged (Constitution VI)

1. **054 report-shape dependency**: 055 must populate the `blocksChanged`
   op kinds that 054 defines, but 054 is being specced in parallel and its
   final receipt/report shape is not yet frozen. If 054 lands a different
   shape (e.g. different op-kind vocabulary), the two specs reconcile at
   plan/merge time. The design amendment lists `text | reconcile |
   structural`; both specs should hold to that vocabulary.
2. **Frequency shift of v1 limit (b)**: atomic replacement of
   below-threshold pairs makes "structural replacement drops concurrent
   intra-block edits (flagged)" *more common* for wholesale rewrites than
   under lucky char splices. Semantics are unchanged and ratified (§2.4.1
   outcome table), but if field feedback shows noisy overlap flags on
   rewrites, the threshold constant is the tuning knob. Noted so the
   change in frequency is a decision, not a surprise.
3. **Coarse-path retirement not stated in the design**: the amendment
   retires the whole-document character LCS but does not mention the >64KB
   coarse path. RBD-055-5 resolves this by unifying; if implementation
   falsifies the "one path" mechanism (e.g. a bound forces keeping a
   coarse fallback), the design doc must be amended per Constitution VI.

---

# Implementation outcomes (2026-08-11, feature 055)

**Gap 1 — held.** 054 shipped `buildChangeReport` in
`server/markdown-sync.js` with exactly the `text | reconcile | structural`
vocabulary, derived from `plan.textBlocks` / `plan.reconcileBlocks` /
`plan.structural`. 055 changes which entries appear and nothing else: the
builder needed no modification, and a test now pins that a forced
whole-block replace surfaces as `structural`
(`server/__tests__/markdown-sync.overlap.test.js`). No reconciliation was
needed.

**Gap 2 — confirmed, and it reached an existing test.** The frequency shift
is real and visible immediately: a 054 report fixture pushed
`Alpha original` → `Alpha CHANGED`, which shares only `Alpha ` and scores
0.44, so under 055 it is an atomic replace rather than a character edit.
The assertion was kept and the fixture changed to an edit that is one, with
the reason recorded at the call site. Worth knowing when reading field
reports: "the push replaced my whole paragraph" will sometimes mean "you
rewrote more than half of it", which is the ratified rule working.

**Gap 3 — RBD-055-5's one-path mechanism held.** No fallback was kept. The
coarse path is gone: `COARSE_INPUT_THRESHOLD`, `coarseDiff`, and the
`diffLines` import are deleted, and `COARSE_CLUSTER_MAX` is renamed
`PAIR_INPUT_MAX` for its new per-pair meaning. Every surviving bound
(`PAIR_INPUT_MAX`, `MAX_EDIT_LENGTH`, `MAX_GAP_DP_CELLS`) degrades exactly
one pair or one gap to whole-block replacement. Size parity is a tested
invariant, not an aspiration: the same logical edit plans identically at
~1KB and past 64KB for each op kind. No design amendment is owed.

---

# Post-merge review amendments (2026-08-11)

Constitution: a decision whose stated rationale is falsified is corrected in
the ledger, never silently. Two entries are amended below, both from the
adversarial review of the merged feature.

## Amendment A1 — the similarity metric (amends RBD-055-1)

**What was falsified.** RBD-055-1 chose character-level Dice and justified
0.5 as "a majority-surviving block merges finely; a majority-rewritten block
replaces atomically (which is what a human would call a rewrite)". The
second half of that sentence is **false for natural language**. English
prose reuses the same characters no matter what it says, so character Dice
scores unrelated paragraphs far above what "no characters in common"
intuition suggests. Measured on real English paragraphs during the review
and re-measured while fixing it:

| Pair | char Dice | char bigram Dice | word Dice |
|---|---|---|---|
| same paragraph, one word fixed | 0.98 | 0.98 | 0.98 |
| same paragraph, reworded | 0.83–0.86 | 0.83–0.85 | 0.76–0.78 |
| same topic, rewritten from scratch | 0.42–0.44 | 0.54–0.59 | 0.22–0.25 |
| unrelated paragraphs | 0.41–0.46 | 0.48–0.56 | 0.12–0.20 |
| unrelated same-length prose (reviewer's fixtures) | 0.67–0.69 | — | — |
| 16KB of random text vs 16KB of random text | 0.80 | — | — |

Under character Dice the "different block" population sits right on the
threshold and, for the reviewer's fixtures, above it. The consequence is the
exact outcome 055 exists to prevent: a wholesale rewrite scored as "the same
block, edited" and replayed as thousands of interleaved character ops — a
garbled hybrid of the old and new paragraph — instead of one atomic replace.

**Decision.** Similarity is now **Dice over the WORD multiset** of the two
block strings: tokens are runs of letters and digits, lowercased, with each
Han/Hiragana/Katakana/Hangul character its own token (those scripts do not
space their words). Markdown syntax is punctuation and contributes no
tokens, which is deliberate — `## Alpha` and `### Alpha` are one block with
a changed level, and the classifier, not the aligner, decides a level
change.

**Threshold: still 0.5, unchanged.** With word features the two populations
separate by more than half the scale (≤0.25 vs ≥0.76 on the fixtures above),
so 0.5 needs no adjustment and now has room on both sides instead of sitting
inside the noise. The fixtures are pinned as tests
(`markdown-sync.alignment.test.js`, "the metric separates real prose"), so a
future metric change has to face the same evidence.

**Exception — blocks of three words or fewer keep the character metric.**
Word Dice has a resolution of 1/n; with one word it can only answer 0 or 1,
and a one-word heading renamed (`## Title` → `## Titles`) shares no word with
itself and would replace wholesale, losing the block's CRDT identity for a
typo fix. Two existing tests caught this. The review's falsification is
about PROSE — many words — and does not reach blocks with three words in
them, so below that count the original character metric stands.

**What did NOT change.** The threshold value, its inclusivity (`>=`),
determinism and symmetry (FR-011), the "pair means same block edited"
semantics, and the atomic-replace outcome for below-threshold pairs. The
existing short-string boundary fixtures were re-expressed in words
(`'a'×n + 'b'×n` is one word, not n characters); their outcomes — exactly at
the threshold character-diffs, just below it replaces atomically — are
unchanged and still pinned.

## Amendment A2 — per-gap work budget (extends RBD-055-6)

**What was wrong.** RBD-055-6 bounded per-pair work, and `MAX_GAP_DP_CELLS`
bounded a gap's cell COUNT. Neither bounded a gap's cost, because scoring
one cell ran a full Myers character diff: 10000 cells of 16KB blocks is a
different universe from 10000 cells of one-liners. Measured on the merged
code: 90s for a 20-paragraph 2KB-block wholesale rewrite, 90s for a 10×10
gap of 4KB blocks, multi-hour worst case under the cell cap — all
synchronous on the collab server's event loop.

**Decision.** Two changes, both inside the mechanism RBD-055-6 already
blessed:

1. Scoring a candidate no longer runs a character diff at all (A1's metric
   is O(block length) over frequency maps built once per block). The real
   `diffChars` runs only for the pairs the DP selects — at most
   `min(N, M)` per gap instead of `N × M`.
2. A gap whose candidate matrix would exceed `MAX_GAP_SCORING_WORK`
   (8,000,000 feature comparisons, ~270ms measured) degrades to positional
   pairing — the same degrade `MAX_GAP_DP_CELLS` already used, decided from
   the profiles before any of the work is paid.

Measured after: the 20 × 2KB rewrite plans in **8ms** (90s before) and as one
whole-block replace per block rather than 17 junk pairs full of character
ops. Pinned by a perf regression test with a deliberately generous 5s bound.

**Residual, knowingly accepted.** A pair that genuinely scores similar can
still cost a full bounded diff (`MAX_EDIT_LENGTH` × `PAIR_INPUT_MAX`): 20
blocks of 2KB whose words are the same words in shuffled order plan in ~4.4s.
That is RBD-055-6's per-pair bound doing its job, one pair at a time, and it
is 20× better than the same shape before. No global (whole-push) budget was
added on purpose: a budget consumed by earlier blocks would make a block's
plan depend on the size of the document around it, breaking the size-parity
invariant I6 (FR-008/SC-004).
