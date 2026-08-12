# 056-sync-apply-correctness — promotion notes

## Post-merge review dispositions (Fable review of 4c275529, 2026-08-11)

Verdict: CLEAN — 0 HIGH, 0 MEDIUM, 3 LOW. The cleared-mark-set mechanism was
verified against the vendored Yjs (redundant nulls produce zero ContentFormat
items; link/textStyle compare via equalFlat), fold-together cannot lose or
double-apply an edit, receipts trace end-to-end from apply results, and all
055/replay/convergence invariants pass post-merge.

- **LOW-1 — dead plan `counts` field: FIXED same-day.** Renamed to
  `plannedCounts` with a comment (one test consumed it, so rename over
  delete); a future caller can no longer mistake plan counts for applied
  counts — the exact confusion 056 exists to kill.
- **LOW-2 — flavor asymmetry at the insert site: FIXED same-day.** Comment
  added explaining why bare CLEAR_ATTRS (not clearAttrsFor(flavor)) is
  correct at the text-lane insert: insert only formats new text, and the
  sampled attrs already carry portable-preserved marks.
- **LOW-3 — empty-run left-branch sampling: ACCEPTED, no change.** Source-map
  runs are non-empty by construction; a guard becomes relevant only if run
  construction ever changes. Recorded here as the tripwire.

## Awaiting Sam ratification

- Deviation 2 (forced-hunk guard = R2 counted-skip, not T011 fold) and the
  as-built mark mechanism (design doc "Mechanism correction", 458ad50a) —
  both implemented as recorded and test-pinned; a nod upgrades them.

## Owed at/after deploy

- Field re-verification: the original reporting agent's link scenarios
  (comma-after-link, word-into-link, repair pushes) against prod — the
  committed corpus covers them, but the field agent's own walk closes the
  loop.
