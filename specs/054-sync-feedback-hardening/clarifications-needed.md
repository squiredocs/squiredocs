# Clarifications — 054-sync-feedback-hardening

No-interaction spec run: each open question below was decided by best-default and is
recorded as **RATIFIED-BY-DEFAULT (Sam pre-authorized, 2026-08-11)**. Overturn any of
these at plan/review time by amending the spec and noting the reversal here.

---

## RBD-054-1 — Staleness semantics: clock inequality, gap clamped at 0

- **Status**: RATIFIED-BY-DEFAULT (Sam pre-authorized, 2026-08-11)
- **Question**: What exactly makes `docChangedSinceBaseline` true, and what is `clockGap`
  when a baseline is *ahead* of the doc (e.g. after a version restore)?
- **Why it matters**: The design says "when the doc changed since baseline" but does not
  define the ahead-baseline edge; a signed gap could leak confusing negative numbers into
  receipts.
- **Decision**: `docChangedSinceBaseline` = (currentClock ≠ baselineClock);
  `clockGap` = max(0, currentClock − baselineClock). Any inequality means the doc state no
  longer matches the baseline claim, which is the trust question being answered.
  Content-hash comparison is out of scope.
- **Rationale**: Uses the value `validateSyncBaseline` already computes (and today
  discards) — zero new engine work; inequality is strictly safer than `>` for strict mode
  (an ahead-baseline is *also* not a faithful baseline); clamping keeps the advisory field
  monotone and simple.

## RBD-054-2 — strict=true is evaluated identically under dryRun=true

- **Status**: RATIFIED-BY-DEFAULT (Sam pre-authorized, 2026-08-11)
- **Question**: When `strict=true&dryRun=true` and the baseline is stale, should the
  response be the 409 `sync_baseline_stale` or a 200 dry-run plan annotated as stale?
- **Why it matters**: Agents will use dry run to predict what a real push does; divergent
  behavior would make the preview lie.
- **Decision**: Identical evaluation — the dry run returns the same 409 the real push
  would. Agents wanting the full plan for a stale baseline simply omit `strict` on the
  dry run (the staleness fields are always present).
- **Rationale**: "Dry run predicts the real call" is the only contract that never
  surprises; the advisory path already gives a stale-but-full plan when wanted.

## RBD-054-3 — Dry run announces nothing: no presence, no fan-out, no selection

- **Status**: RATIFIED-BY-DEFAULT (Sam pre-authorized, 2026-08-11)
- **Question**: Feature 037 makes imports announce agent presence spanning the whole
  request. Does a dry-run request announce presence to viewers?
- **Why it matters**: Presence exists so viewers see who is changing the doc; a dry run
  changes nothing, but 037's session opens before parsing.
- **Decision**: Dry runs skip the entire observable side-effect set: no presence session,
  no live-apply content fan-out (nothing to fan out), no temporary selection, no version
  entry.
- **Rationale**: 037's ratified purpose is "viewers see the agent arrive before anything
  changes" — in a dry run nothing ever changes, so an avatar would be noise implying an
  edit that never happens. Also keeps dry run cheap enough to use habitually.

## RBD-054-4 — dryRun on non-sync modes is rejected, not ignored

- **Status**: RATIFIED-BY-DEFAULT (Sam pre-authorized, 2026-08-11)
- **Question**: What does `dryRun=true` do on `mode=append`, `mode=replace`, or the create
  route?
- **Why it matters**: Silently ignoring it would apply a change the caller explicitly
  asked to preview — the worst possible failure for a trust feature.
- **Decision**: Rejected as an invalid parameter combination (400-class error naming the
  supported combination), design scope being "PUT ?mode=sync accepts dryRun=true".
- **Rationale**: Fail-closed beats apply-on-preview; extending dry run to other modes is a
  trivial follow-on if ever wanted.

## RBD-054-5 — Operation aggregates retained alongside blocksChanged

- **Status**: RATIFIED-BY-DEFAULT (Sam pre-authorized, 2026-08-11)
- **Question**: The amendment says receipts "replace bare hunk counts with a blocksChanged
  list". Are the existing `operations: { textHunks, structuralHunks }` fields deleted?
- **Why it matters**: Existing consumers (tests, any agent tooling parsing receipts)
  read the aggregates; deleting fields is a breaking receipt change the amendment does not
  clearly demand.
- **Decision**: `blocksChanged` supersedes the counts *as the verification signal*; the
  aggregate fields remain in the receipt (cheaply derivable). Read of "replace": agents no
  longer need to rely on bare counts, not field deletion.
- **Rationale**: Non-breaking, zero cost, and preserves SC-008 (existing consumers
  unbroken). If review prefers literal deletion, it is a one-line removal at plan time.
- **Flag**: This is the one default that reads the amendment's wording loosely — worth a
  human glance at review.

## RBD-054-6 — Excerpt shape: single line, ~120 chars, ellipsis

- **Status**: RATIFIED-BY-DEFAULT (Sam pre-authorized, 2026-08-11)
- **Question**: How large is a `blocksChanged` excerpt, and is the list capped?
- **Why it matters**: A replace-heavy sync can touch hundreds of blocks; unbounded
  excerpts could balloon receipts past what agents comfortably ingest.
- **Decision**: Excerpts are single-line, capped at ~120 characters with an ellipsis
  marker; one entry per changed block, no pagination in v1.
- **Rationale**: 120 chars is enough to recognize a block ("pressure point 11 — …") and
  keeps even a 500-block replace receipt in the tens of KB; pagination is speculative
  machinery the field report did not ask for.

## RBD-054-7 — Staleness/report fields are response-only; receipt frontmatter untouched

- **Status**: RATIFIED-BY-DEFAULT (Sam pre-authorized, 2026-08-11)
- **Question**: Do the new fields also enter the markdown receipt (frontmatter) written
  back over the repo file as the next baseline?
- **Why it matters**: The frontmatter is a load-bearing baseline contract
  (`sync_baseline_missing` machinery, 019 first-sync remedy); changing it risks breaking
  every existing written-back receipt.
- **Decision**: New fields live in the JSON response only; the receipt markdown and its
  frontmatter baseline contract are unchanged.
- **Rationale**: The staleness question is answered fresh on every push from the doc's
  live clock — persisting a stale snapshot of it in the file adds nothing and risks
  baseline-format drift.

## RBD-054-8 — Ordered-list canonicalization and out-of-range start

- **Status**: RATIFIED-BY-DEFAULT (Sam pre-authorized, 2026-08-11)
- **Question**: How do non-sequential source numberings (1., 1., 1. or 3., 7., 9.) and
  `start` < 1 round-trip?
- **Why it matters**: The round-trip invariant is byte-identity; source files with
  eccentric numbering cannot be byte-preserved without storing per-item numbers.
- **Decision**: CommonMark semantics: the first item's number is the list's start; items
  are canonicalized to sequential-from-start on export (existing canonicalization
  behavior, now anchored at start instead of 1). `start` < 1 is treated as 1 (HTML
  `ol[start]` practice). Byte-identity applies to canonical exports, as today.
- **Rationale**: Matches what the tolerant parser already stores (a single `start`
  attribute at `shared/markdown/tolerant/block-parser.js:442`), what CommonMark renderers
  do, and what the design asks for (numbering from 11 survives; per-item eccentricity was
  never representable).

## RBD-054-9 — strict/dryRun parse like existing import boolean params

- **Status**: RATIFIED-BY-DEFAULT (Sam pre-authorized, 2026-08-11)
- **Question**: Exact accepted values for the two new query params.
- **Why it matters**: Inconsistent boolean parsing across params on the same route is a
  classic agent trap ("strict=1 silently ignored").
- **Decision**: Follow the existing boolean query-param convention in
  `server/api/docs-import.js` param parsing (:236–260) so all booleans on the route
  behave identically; values that parse as neither true nor false are rejected, not
  silently falsy.
- **Rationale**: Route-internal consistency beats any abstract convention; rejection over
  silent-ignore for the same fail-closed reason as RBD-054-4.

## RBD-054-10 — "README" surface = repository README sync documentation

- **Status**: RATIFIED-BY-DEFAULT (Sam pre-authorized, 2026-08-11)
- **Question**: The surface list says "README" — the repo `README.md`, the distribution
  mirrors' READMEs, or both?
- **Why it matters**: Constitution Principle I makes `README.md` the core doc that must
  track behavior; the distribution mirrors are generated/published separately.
- **Decision**: The repo `README.md`'s sync/agent-guidance section is the required
  surface (Constitution I also independently requires it once receipts/params change).
  Distribution mirror READMEs are regenerated/republished through the existing
  distribution flow if their generated content changes — not hand-edited.
- **Rationale**: Matches the amendment's list ("agents.md, and the in-app chat prompt" —
  repo-level surfaces) and the standing rule that plugin copies are generated.
