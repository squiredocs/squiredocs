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

- **Status**: RATIFIED-BY-DEFAULT (Sam pre-authorized, 2026-08-11); **AMENDED at plan time
  2026-08-11** — see the amendment note at the end of this entry.
- **Question**: How large is a `blocksChanged` excerpt, and is the list capped?
- **Why it matters**: A replace-heavy sync can touch hundreds of blocks; unbounded
  excerpts could balloon receipts past what agents comfortably ingest.
- **Decision**: Excerpts are single-line, capped at ~120 characters with an ellipsis
  marker; one entry per changed block, no pagination in v1.
- **Rationale**: 120 chars is enough to recognize a block ("pressure point 11 — …") and
  keeps even a 500-block replace receipt in the tens of KB; pagination is speculative
  machinery the field report did not ask for.
- **Amendment (plan phase, 2026-08-11)**: the spec assumed a new excerpt helper. One already
  exists — `blockExcerpt` (`server/markdown-sync.js:838`), which produces the `excerpt` on
  every overlap flag and caps at **80** chars with no ellipsis. Rather than ship two
  differently-shaped excerpts inside one receipt, `blocksChanged` **reuses `blockExcerpt`**
  and the helper's cap is **raised to 120 with an ellipsis marker**, per this entry's shape.
  Consequence: existing `overlaps[].excerpt` values widen from 80 to 120 chars and gain the
  ellipsis. Non-breaking — no test pins the length (the only assertion is a loose
  `toContain('Bravo')` at `server/__tests__/markdown-sync.overlap.test.js:58`) and the field
  is documented as advisory prose. Rationale: one excerpt shape per receipt; a caller that
  renders both lists side by side should not see two truncation rules.

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

---

# Added at plan time (2026-08-11)

The three entries below were opened by the plan phase, not the spec phase: each is a
consequence of the ratified items that the amendments do not address, found by reading the
code. Same no-interaction rule — best default, recorded, overturnable at review.

## RBD-054-11 — Dry run runs the staged image pass (disclosed side effect)

- **Status**: RATIFIED-BY-DEFAULT (Sam pre-authorized, 2026-08-11), **plan phase**
- **Question**: FR-006 says a dry run applies "nothing". But the canonicalization step that
  produces the string the plan is diffed against — `canonicalizePushedStaged`
  (`server/markdown-sync.js:1096`) — runs `stageImagePass`
  (`server/markdown-import.js:150`), which **rehosts external images to S3** and **copies
  cross-document images onto the target doc**. Both happen before any dry-run cut point.
  Does the dry run skip image staging?
- **Why it matters**: It is the one place "nothing applied" is not literally true. Left
  undocumented, an agent using dry run habitually would be quietly uploading bytes.
- **Decision**: The dry run runs the **same** staged image pass as a real push, and the
  contract **discloses it** (`contracts/sync-receipt-v2.md`, "Disclosed exception"). The four
  things FR-006 and SC-003 actually enumerate and measure — document mutation, stored update,
  version entry, clock advance — plus fan-out, presence, and selection all remain guaranteed
  absent.
- **Rationale**: The staged pass is what determines the canonical pushed string; the
  non-staged sibling (`canonicalizePushed`, :310) produces a *different* string for any
  document with images (unvetted `data:` srcs present, external srcs un-degraded). A dry run
  built on it would predict the wrong plan — exactly what RBD-054-2 rules out. The effects are
  storage-side, idempotent in practice, and invisible in the document, its history, and its
  viewers. It also means dry run cannot be used to bypass image vetting (Constitution V).
- **Flag**: This is the one place the dry run is not literally free. If review prefers strict
  purity over predictive fidelity, the alternative is a documented "image effects are not
  previewed" caveat plus the non-staged path — a smaller change than it sounds, but it makes
  the preview lie for image-bearing documents.

## RBD-054-12 — Diff cache version bumped v10 → v11

- **Status**: RATIFIED-BY-DEFAULT (Sam pre-authorized, 2026-08-11), **plan phase**
- **Question**: FR-013 changes the **strict** parser. The strict parser is not on the sync
  path at all — it is the **diff engine's** parser (`server/diff-service.js:316-323`,
  `server/diff/apply-word-marks.js:35`). Diffs are cached in Redis under
  `CACHE_VERSION` (`diff-service.js:35`, currently `'v10'`). Must the cache be invalidated?
- **Why it matters**: Without a bump, every diff cached before the change keeps rendering
  ordered lists flattened to `1.` while the document itself now reads `11.` — a stale cache
  contradicting the doc, for the life of the key.
- **Decision**: Bump `CACHE_VERSION` to `'v11'` in the same change. Two pins move with it:
  `server/__tests__/diff-service.test.js:992-993` and
  `server/__tests__/markdown-strict-characterization.test.js:77`.
- **Rationale**: The established convention in this repo — the same bump was taken for feature
  022's two-tier word diff (v7→v8) and for the tail-gap/parity cut (v9→v10). Cost is one
  constant and two assertions; the alternative is a quietly wrong diff, the class of defect
  features 038-049 spent a campaign removing.

## RBD-054-13 — FR-015's surface list resolves to twelve files, three of them generated

- **Status**: RATIFIED-BY-DEFAULT (Sam pre-authorized, 2026-08-11), **plan phase**
- **Question**: FR-015 item 6 names `distribution/kiro-power/steering/` as a write site, and
  the spec notes only that *plugin copies* are generated from `distribution/shared/*`. Where
  are the Kiro and Cursor surfaces actually authored?
- **Why it matters**: `distribution/kiro-power/steering/*.md`, `kiro-power/POWER.md`, and
  `cursor-plugin/rules/squire-spec-loop.mdc` are **generated from inline text in
  `distribution/publish.mjs`** — *not* from `distribution/shared/`. Editing the checked-in
  copies would be silently reverted by the next `node distribution/publish.mjs`, and the edit
  would appear to have landed until someone regenerated.
- **Decision**: The write-site table in `contracts/guidance-split.md` is authoritative:
  `publish.mjs:420-422` (Kiro steering), `:332` (POWER.md), `:499` (Cursor rule) are edited at
  their inline sources; `distribution/shared/skill.md` and `onboard.md` remain the sources for
  the Claude plugin skill, the onboard command, and the Cursor SKILL.md. Regeneration runs and
  its output is committed. Surface 9 (`server/api/chat.js`) is additionally recorded as an
  **addition** — that prompt contains no channel-rule text today.
- **Rationale**: FR-015's intent is "every surface that teaches the rule actually says the
  split". Naming generated artifacts as write sites would satisfy the letter and fail the
  intent at the next regenerate.

---

# Implementation notes (2026-08-11)

Recorded per T077. All 77 tasks landed. Backend 264 suites / 4,832 tests green (baseline was
4,770), client 78 suites / 978 green, `npm run build` green.

## RBD-054-11 outcome — the flagged default, as built

**The disclosed exception held, and it is the one item still wanting a human glance.**

`applySyncPush`'s dry-run early return sits between overlap detection and `persistence.storeUpdate`,
which is the first durable write. Everything FR-006 enumerates is therefore guaranteed absent by
control flow rather than by suppression flags: no stored update, no version entry, no clock
advance, no `applyLiveUpdate` fan-out, no `searchIndexer.markDirty`. Presence is skipped on both
ends — the session is never opened upstream in the route, and neither `observeSyncRange` nor
`settle` runs.

`canonicalizePushedStaged` still runs before that cut, exactly as RBD-054-11 decided, so a dry run
over a document containing an external or cross-document image **may rehost bytes to S3 or copy an
image row**. It is reported in the receipt's `images` field identically to a real push. The
document, its clock, its history, and its viewers are untouched.

**What a reviewer should decide**: whether "dry run may write image bytes to S3" is acceptable as
a default, or should become an opt-out. The alternative (`canonicalizePushed`, the non-staged
sibling) makes the preview structurally unable to predict the real push for any document
containing images, which is why it was rejected. No test asserts the rehost happens under dry run;
the route suite covers the no-trace guarantees for the four enumerated effects.

## Deviations from the task list

1. **`server/__tests__/markdown-sync.order-independence.test.js` needed an update that no task
   named.** Its guard asserted "the ONLY 409 anywhere (engine or route) is the docGuid identity
   mismatch, never an edit conflict". `sync_baseline_stale` is a second 409 by ratified design, so
   that test would have failed on US1 regardless of how it was written. Rather than weaken it, the
   engine half is kept verbatim (the engine still has exactly one 409) and a sibling test pins what
   the original was really protecting: `sync_baseline_stale` is raised behind a `strict &&` guard
   and nowhere else, so the default protocol still never refuses a push over an edit conflict.

2. **T034 was followed over research R2 where they disagree.** R2 said the noop short-circuits
   should retain their `markdown` re-export under `dryRun` ("it is a read"). T034, the contract
   (`sync-receipt-v2.md`), and data-model §3 all say `markdown` is omitted on a dry run with no
   noop exception, and T044 asserts it. The contract won: the re-export is skipped entirely, not
   merely stripped. A noop dry run is the case most likely to be mistaken for a fresh baseline,
   since it reports the document as already matching.

3. **`export-api.js` and `client/public/agents.md` gained contract documentation, not only the
   guidance split.** T062/T068 asked for the split; both files also document the `mode=sync`
   contract this feature changed. They are what an agent reads to learn how to sync, so leaving
   them describing the pre-054 receipt would have been worse than leaving them untouched
   (Constitution Principle I).

4. **`modify.description` was rewritten rather than appended to, as planned, and came in under
   budget.** Measured after the edit: `SERVER_INSTRUCTIONS` 1,404 / 1,536 (132 B free),
   `modify.description` 1,959 / 2,048 (89 B free — better than the 49 B an appended MICRO variant
   would have left), `import_markdown_file.description` unchanged at 1,216 / 2,048.

5. **The tolerant parser gained the `< 1` clamp T050 anticipated.** It preserved `start` already
   but passed `0.` through as `start: 0`, which would have disagreed with the strict parser's new
   clamped behavior. `Math.max(1, first.start)` closes it; both modes now share one domain.

6. **A shared `orderedListStart` helper was introduced rather than two parallel expressions.**
   T045/T046 require the two serializer copies to stay byte-identical. One helper called from both
   is a stronger guarantee of that than two expressions a later editor could change singly.

7. **`buildChangeReport` skips blocks inside a structural replacement.** Not specified, but
   `applyHunks` does exactly this (its `replacedNodes` set), and without the same rule one block
   would appear twice under two different ops, only one of which describes what happened.

## Still owed (not implementable in a worktree)

- **T076** — the manual quickstart walk §2–§5 against a live doc in the dev pod, including the
  browser check that a dry run shows no avatar and no selection (RBD-054-3) and that version
  history renders `11.` after the cache bump (RBD-054-12). The automated equivalents are green
  (presence doubles assert zero sessions and zero selections on a dry run; the round-trip corpus
  and both parser modes cover the numbering), but the browser-visible halves need eyes.
- **RBD-054-5** — retaining `operations` alongside `blocksChanged` reads the design amendment's
  "replace" loosely, and was already flagged for a human glance at spec time. Built as retained.
