# 055-block-aligned-merge — promotion notes

## Post-merge review dispositions (Fable review of ff28f4a1, 2026-08-11)

Verdict: 2 HIGH, 1 MEDIUM — all FIXED same-day (f4284e49, d4b0d927,
4222de20). Core alignment machinery reviewed clean (FR-002 by construction,
forced-op extents exact, round-trip strict no-op, 054 report consumers
untouched).

- **HIGH-1 — anchor-fold gap: FIXED.** An insertion anchored on a
  *classifier*-replaced block (heading level change, type change, declined
  reconcile) fell to document end at apply time — pre-existing apply-machinery
  behavior the 055 contract wrongly claimed closed. `applyHunks` now records
  each replacement group's landing site and resolves missed anchors
  positionally (group tail → nearest preceding surviving block → doc start).
  Reviewer's repro + 4 variants pinned; repro fails on the parent commit.
- **HIGH-2 — planner cost blow-up: FIXED.** Gap pairing ran a full Myers
  char diff per N×M candidate cell (measured 43.9–99s synchronous event-loop
  CPU on realistic wholesale rewrites; multi-hour worst case under the cell
  cap). Candidate scoring is now diff-free word-multiset Dice; `diffChars`
  runs only for DP-selected pairs; `MAX_GAP_SCORING_WORK` (8M feature
  comparisons) degrades an over-budget gap to positional pairing up front.
  20×2KB wholesale rewrite: 90s → 8ms. Perf regression test pinned (<5s
  bound, ~16ms typical).
- **MEDIUM-3 — metric falsified for prose: FIXED, ledger amended.**
  Character-level Dice scored unrelated same-length prose 0.67–0.69, so the
  ratified atomic-replace regime rarely engaged on natural language.
  Word-multiset Dice separates the populations (reworded ~0.77 / rewritten
  ~0.23 / unrelated ~0.16 vs threshold 0.5, pinned as tests); blocks of ≤3
  words keep the character metric (word Dice has no resolution there — a
  one-word heading rename must not lose CRDT identity). RBD-055-1's rationale
  is recorded as falsified in ledger amendment A1; RBD-055-6 extended per-gap
  in A2.

## Awaiting Sam ratification

- **A1 (amends RBD-055-1)** — similarity metric changed char-Dice →
  word-multiset Dice (threshold stays 0.5), with the ≤3-word character
  fallback. Strict default chosen from measured prose populations.
- **A2 (amends RBD-055-6)** — per-gap scoring budget with positional-pairing
  degrade; deliberately NO whole-push budget (would break size parity I6).

## Accepted residuals

- A genuinely similar-scoring pair still pays one full bounded diff
  (same-words-shuffled 20×2KB shape: ~4.4s — RBD-055-6's per-pair bound
  working as designed, 20× better than pre-fix).
- The cap-trip degrade test costs ~7s (inherent to constructing a real
  MAX_EDIT_LENGTH trip; replaced an equally slow test, net neutral).

## Owed at/after deploy

- Manual walk of quickstart §"Manual end-to-end" (live-doc sync with
  concurrent edit, verify block-atomic replace + overlap flag in the UI).
