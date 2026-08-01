# 039-diff-cache-integrity — merge-queue notes

Notes the merge-queue owner needs. Written by the implementing agent; **no doc was edited** —
Principle I (documentation currency) is deferred to the merge queue by the parallel-agent protocol
(plan.md Complexity Tracking).

---

## T057 — Documentation check (`README.md`, `docs/dev.md`) — ⚠️ ACTION REQUIRED

**Verdict: `README.md` DOES describe behavior this feature changes.** The planning-stage expectation
("neither doc does, so no update is owed") is **wrong**, so this is reported as a merge-queue item
rather than silently deferred.

`docs/dev.md` — **clean.** No mention of cache-write conditions, word-emphasis internals, or
model-bound serialization. Its only `diff`/`redis` hits are unrelated infrastructure prose
(`collab-postgres`/`collab-redis` service names). **Nothing owed.**

`README.md` — **three passages describe changed behavior.** None of them becomes *false* because of
039; two become *more* true and one carries a now-obsolete word. Judgement: no correction is
strictly required for accuracy, but the owner should decide whether to tighten the wording.

### (a) `README.md` line 474 — "Word-level two-tier highlighting" bullet

> …Oversized or **misaligned** regions degrade gracefully to the line-level marks. **The chat diff
> cards use the same word segmentation** (an additive `inlineSegments` payload field rendered as
> emphasized spans).

- *"The chat diff cards use the same word segmentation"* — this was the **ratified 022 SC-003 claim
  that had silently regressed**: both surfaces called the same helper, but at different granularity
  (version history segmented the whole replace region; chat segmented row **pairs** positionally via
  `Math.min(delCount, addCount)`). 039 restores it. **The sentence goes from misleading to
  accurate — a convergence, not a contradiction.**
- *"misaligned regions"* — now **stale terminology**. Post-039 the chat surface has no positional
  row alignment to be "misaligned"; the region is segmented as a unit and the only degradations are
  the size cap and the time budget. Suggested (optional) replacement: *"Oversized or slow regions
  degrade gracefully to the line-level marks, for the whole region on both surfaces."*
- Not stated either way in README, and newly true: the chat fallback is now **whole-region** rather
  than per-row-pair, which is one of the four approved visible changes (a very large region that
  used to keep emphasis on its small rows now shows row tint only).

### (b) `README.md` line 474 — `inlineSegments` as a payload field

README describes `inlineSegments` as *"an additive `inlineSegments` payload field rendered as
emphasized spans"*. That remains exactly true: 039 keeps it in storage and in the browser-bound
payload and removes it only from **model-bound** projections. README never claimed the model sees
it, so **nothing is contradicted**. If the owner wants the token-hygiene behavior documented, the
natural spot is this same bullet or the "Inline diffs" bullet at line 581.

### (c) `README.md` line 481 — the diff cache

> **Strict** — a frozen, byte-identical copy of the pre-existing exact-dialect parser, used by the
> version-diff engine … ; the Redis diff cache (`CACHE_VERSION`) stays valid.

This is a claim about the *strict parser* not forcing a cache invalidation. 039 **does** bump
`CACHE_VERSION` (`v9` → `v10`) — but for its own reasons (tail-gap-poisoned entries and the parity
rewrite), not because the strict parser changed. **The sentence stays true**; the parser is
untouched. No edit owed, though a reader could mis-read it as "the cache is never bumped".

README also has **no** statement anywhere about *when* the diff cache is written, so the FR-005
three-condition gate (incomplete read / failed computation / timeout degradation) is **new,
undocumented behavior**. That is a documentation *gap*, not an inaccuracy — the owner may want a
sentence for it.

### Recommendation

Low-risk, non-blocking for correctness. Suggested minimal edit, for the merge queue to apply:
replace "misaligned" with "slow" in line 474 and note the whole-region fallback. Everything else in
README is already consistent with the post-039 code.

---

## T058 — Design-doc check (`design/`) — clean, no amendment owed

`design/document-model-format-pipeline.md:29` (Sam's 2026-07-19 amendment for feature 022) states:

> The same shared word-segmentation helper drives the chat tool-output diff (see In-App AI
> Assistant).

039 **converges toward** this claim rather than contradicting it — restoring the shared per-region
segmentation the amendment describes. The same amendment also says the refinement "degrades to plain
line-level marks when the region doesn't align", which remains true (the region-level guardrails).
The amendment records "the diff cache version bumps v7→v8"; that is a historical note about 022 and
is not invalidated by 039's independent v9→v10 bump.

**No Squire-doc amendment is owed.** `design/` was not hand-edited (correct — it is a generated
export; amendments go through the Squire doc + `node design/sync.mjs`).

---

## Approved visible behavior changes (SC-008)

Four, all intended, all covered by tests:

1. **Surplus-row emphasis (chat).** Rows beyond `min(delCount, addCount)` in a replace region now
   receive word emphasis instead of none.
2. **Less false emphasis on shifted rewrites (chat).** A row inserted at the top of an otherwise
   unchanged block no longer lights up every following row.
3. **Slightly more frequent row-tint fallback on very large regions (chat).** The size cap now
   applies to the joined region, so a huge region no longer keeps emphasis on its small rows.
4. **Stable history author badge color.** A colorless author renders `#888888` instead of a
   date-salted presence color.

Two existing tests in `server/mcp/__tests__/diff-postprocess.test.js` encoded the OLD positional
pairing and were updated to the new region behavior (they are changes 1 and 3, not regressions):
- `unequal -/+ counts pair up to min(del,add); surplus rows are segment-free`
- `an oversized -/+ pair degrades to tint-only (no segments, no throw) — perf guardrail`

---

## T056 — Quickstart §3 validation scenarios (V1–V8)

All eight are covered by automated tests; none required manual execution.

| Scenario | Criterion | Covering tests | Outcome |
|---|---|---|---|
| V1 | SC-001 incomplete read never cached | `diff-service.test.js` CW-T1; `postgres-gap-read.test.js` RC-1…RC-8 | ✅ pass |
| V2 | SC-002 transient failure recovers | `diff-service.test.js` CW-T2 | ✅ pass |
| V3 | SC-004 size vs. timeout determinism | `diff-service.test.js` CW-T3/CW-T4/U1/CW-4; `word-diff.test.js` WD-1…WD-4 | ✅ pass |
| V4 | SC-003 two-surface parity | `diff-two-surface-parity.test.js` PAR-1a…f/PAR-2; `word-diff.test.js` LS-T1…LS-T5 | ✅ pass |
| V5 | SC-005 no UI-only data to the model | `strip-ui-only.test.js` MS-1…MS-3; `chat-tools.test.js` MS-4; `chat-strip-ui-only.test.js` MS-5…MS-7 | ✅ pass |
| V6 | SC-006 single replay | `diff-service.test.js` CW-T9/CW-T10/SR-2/SR-4 | ✅ pass |
| V7 | SC-007 honest formatting-only banner | `diff-service.test.js` CW-T11/CW-T12 + extractText cases | ✅ pass |
| V8 | SC-008 badge color + full suites | `HierarchicalVersionList.test.jsx` (039 describe); full backend + client suites | ✅ pass |

**Test results.** Backend `223 suites / 3883 tests`, all passing, `--runInBand` against the
per-agent `collab_test_db_039`. Client `65 files / 807 tests`, all passing. `npm run build` green.

Baseline for comparison (same tree, pre-039 source): `219 suites / 3810 tests` passing with zero
pre-existing failures, so every delta is attributable to this feature.

### Manual smoke still owed to the maintainer (quickstart §4, not automatable here)

- Version history on a real document, mid-history pair, word emphasis in light **and** dark themes.
- An in-app agent `modify`, confirming the chat diff still shows word emphasis and that surplus
  rows in a multi-line rewrite are now emphasized.
- Confirm no `diffv9:` key is read after deploy (namespace cut-over).

### Note for whoever runs the suites next

`npx jest` does **not exit** on this repo after the run completes — an open Redis handle keeps the
process alive, so a piped invocation (`… | tail`) appears to hang forever and returns nothing. Use
`--forceExit`. This is pre-existing, unrelated to 039, and cost this agent ~20 minutes before it was
diagnosed; worth a line in `docs/dev.md` if the merge-queue owner agrees.

---

## Scope compliance

- **No migration** added.
- 038-owned files untouched: `server/index.js`, `server/origin.js`, `server/document-service.js`,
  and the WRITE path of `server/postgres-persistence.js`.
- `server/postgres-persistence.js` changes are confined to `getUpdateRowsUpTo`,
  `_fetchRowsWithGapRetry`, `_findFirstGap` and their JSDoc.
- `CACHE_VERSION` bumped exactly once (`v9` → `v10`).
- `CLAUDE.md`, `README.md`, `docs/dev.md`, `.specify/feature.json` untouched.
