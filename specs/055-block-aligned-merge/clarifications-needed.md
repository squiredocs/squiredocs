# Clarifications Ledger: 055-block-aligned-merge

Per Constitution VI, unanswered product decisions get the best default,
recorded here — work never blocks on the maintainer, and nothing is decided
silently. All entries below: **RATIFIED-BY-DEFAULT (Sam pre-authorized,
2026-08-11)** unless later overturned.

---

## RBD-055-1 — Similarity metric and threshold

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
