# Promotion Notes — 018-search-chunking-and-eval

Implementer: Claude (worktree agent), 2026-07-19. Branch `018-search-chunking-and-eval` off main `0dcaef8` (the 017 merge).

## Before/after measurement (FR-029 / SC-010, US5)

Produced by the harness itself (`npm run search:eval`), eval-set **version 3**,
hybrid mode, limit 20, token budget 8000. Full serial sweep with **real
`gemini-embedding-001` embeddings and real gemini-2.5-flash preambles** (the
dev API key), per-variant re-indexing through the production indexer
(`reindexAllForEval`). Results files: `eval-results.1784427243631.json`
(minimum sweep) and `eval-results.1784427603652.json` (flagged reranker
variant), both git-ignored; the tables below are verbatim copies.

**Measurement-integrity note**: the FIRST sweep of v3 was invalid — the
seeded corpus had no `document_search_index` rows because `reindexAllForEval`
originally maintained only chunk rows, so hybrid was measured with a dead
doc-level fulltext leg. The bug was found during quickstart §2 chunk
inspection, fixed (the eval re-index now upserts the FTS row exactly as
`indexDocument` does, with a regression test), and everything below was
re-measured with the full hybrid pipeline live. The invalid tables are not
reproduced here.

**Variant configurations** (exact `getSearchConfig` overrides — FR-026):

| Variant | chunking | preambles | rerank |
|---|---|---|---|
| fixed (baseline) | `fixed` (pre-018 6000-char/500-overlap windows, bare embedded text — plan D12) | off | off |
| structure | `structure` (~600-token heading-boundary chunks, title-headed embedded text) | off | off |
| structure+preambles | `structure` | on | off |
| structure+preambles+rerank | `structure` | on | **on (explicitly flagged)** |

**Minimum sweep** (62 queries: 25 paraphrase / 13 multi-doc / 7 no-answer / 17 keyword; 55 answerable):

```
variant             |      R@5 |     R@10 |     R@20 |      MRR |  nDCG@10 | R@budget |  noAns
----------------------------------------------------------------------------------------------
fixed (baseline)    |    0.976 |    0.982 |    0.982 |    0.921 |    0.932 |    0.982 |  0.000
structure           |    0.982 |    0.982 |    0.982 |    0.933 |    0.943 |    0.982 |  0.143
structure+preambles |    0.982 |    0.982 |    0.982 |    0.952 |    0.956 |    0.982 |  0.143
```

**Flagged reranker variant** (same set, same index as structure+preambles, rerank on):

```
structure+preambles+rerank |    0.945 |    0.982 |    0.982 |    0.848 |    0.879 |    0.982 |  0.143
```

**Reading** (informs tuning, does not gate — Sam's ratified decision):

- The new pipeline improves every ranking-sensitive metric monotonically:
  MRR 0.921 → 0.933 (structure) → 0.952 (+preambles); nDCG@10 0.932 → 0.943 →
  0.956. Recall@5 recovers the one query the fixed baseline drops out of the
  top 5. The lift is smaller than the (invalid) fulltext-less measurement
  suggested — the doc-level keyword leg already carries much of the ranking —
  but it is consistent and in the same direction on every metric.
- No-answer accuracy: the new pipeline correctly returns nothing for 1/7
  no-answer queries where the baseline returned noise for all 7. Both are low —
  the hybrid semantic leg's 0.5 distance threshold admits weak matches; a
  threshold sweep is a natural follow-up experiment the harness can now run.
- **The reranker hurt, again**: MRR 0.952 → 0.848, Recall@5 0.982 → 0.945, at
  ~1.4 s/query on this corpus (~85 s for 62 queries vs ~3 s without). This
  independently reproduces the pre-018 finding that motivated FR-030. The flag
  stays **off**; no default change proposed.
- **Regressions**: none observed for the shipped configuration
  (structure+preambles) on any metric. Documented openly per FR-029: the only
  regression found anywhere was in the deliberately-off reranker variant.

## Saturation guard (SC-009 / FR-028) — exercised for real

The guard did its job during authoring, twice:

- **v1** (44 queries, 24-doc corpus): sweep saturated — every variant 1.0 on
  Recall@5/10/20 (`eval-results.1784420503280.json`), the exact failure mode of
  the abandoned LLM-drafted set. `check-eval-set.js` failed it with the
  "set defect — add harder queries" verdict.
- **v2** (54 queries, corpus grown to 42 docs with confusable distractors +
  two long buried-section docs): primary-metric spread appeared
  (MRR 0.897→0.940) but Recall@k still saturated → guard still failed
  (`eval-results.1784420719509.json`).
- **v3** (62 queries; added 3-ref multi-doc queries and adversarial paraphrases
  whose lexical surface points at a distractor): guard **PASSES** — not-all-1.0
  AND max primary spread 0.031 ≥ 0.03 on the corrected full-pipeline sweep
  (`eval-results.1784427243631.json`). Note the v1/v2 iteration runs predate
  the harness FTS-row fix; their saturation verdicts stand a fortiori (a live
  doc-level keyword leg makes saturation more likely, not less), but their
  metric values should not be quoted. The 0.031 spread only just clears the
  guard — a natural place for Sam's re-curation to add margin.

## OWED — operator (Sam) items

1. **Eval-set curation sign-off (U1 — REQUIRED before treating the set as canon).**
   `server/search/eval/eval-set.json` v3 is an implementer-authored DRAFT. It was
   authored against a **deterministic seeded sandbox corpus**
   (`server/search/eval/seed-eval-corpus.js`, 42 fixed-UUID documents), NOT the
   operator-dev corpus — the worktree sandbox has no access to your populated
   corpus. The spec's assumption ("eval-set curation is a human act") stands:
   re-curate against operator-dev (replace `relevantDocIds` with real doc ids,
   set `userId`, bump `version`, update `corpus`), then re-run
   `npm run search:eval` + the guard for the canonical operator-dev numbers.
   Until then the committed set runs end-to-end only after
   `node server/search/eval/seed-eval-corpus.js` against a scratch DB (the
   harness skips queries whose referenced docs don't exist, and says so).
2. **Legacy re-chunk rollout**: on first deploy, `reindexStale()` re-chunks
   every pre-018 document (legacy predicate `embedded_text IS NULL`, plus the
   018 hash-input change means every stored hash mismatches once). Expect one
   full-corpus re-embed on the first boot after deploy — best-effort,
   concurrency 5, search serves old chunks throughout (SC-012).
3. **Threshold follow-up (optional)**: no-answer accuracy is poor in all
   variants (0–0.143); sweeping `distanceThreshold` below 0.5 with the harness
   is the obvious next tuning experiment.

## Deliberate 017 test amendments (DR-1 corollary)

`search-indexer-gating.test.js` cases 2 and 7 and the seam unit test asserted
017's title-EXCLUDED hash; DR-1 (design Addition) inverts that — a title-only
change now busts the gate and re-embeds (the title is part of embedded text).
Amended with comments citing the Addition; every other 017 assertion passes
unchanged. Both hidden hash-input producers found in 017's post-merge review F3
(the `generateAndStoreEmbeddings` default param and
`server/scripts/backfill-search-index.js`) were made title-aware, with a
hash-parity test (`search-indexer.test.js` T011e) proving backfill and live
indexing produce identical hashes.

## Design conformance (T037)

`design/content-search.md` (018 amendment + titles Addition) matches the built
reality: heading-boundary ~600-token chunks with heading_path; title-headed
embedded text with the widened title+body hash; preambles 1–3 sentences,
multi-chunk docs only, embedded + keyword-indexed, never in the hash, never in
snippets; doc-level RRF response shape frozen (contract tests); harness
first-class on main; reranker off by default. The older sentence in "The two
engines" describing 6000-char windows is superseded in-document by the 018
amendment section per the doc's amendment convention — no falsified mechanism,
no Squire-doc amendment required.

## Final verification (T038)

- Backend: full serial Jest suite on a dedicated worktree DB
  (`collab_test_db_018`): **188 suites / 3196 tests, all green** (195 s).
  One earlier run showed a 10 s timeout in
  `server/mcp/__tests__/integration/document-editing-workflow.test.js`
  ("modify: delete entire block") under machine load ~3.4; the identical test
  also timed out at unmodified base `0dcaef8` in a throwaway worktree, proving
  it environmental, and it passes in the final run.
- Client: `npm run test:client` — **50 suites / 642 tests green**; `npm run
  build` green (client untouched by this feature — zero client changes,
  SC-004).
- Quickstart: §1 via the suites; §2 chunk inspection done against the real
  seeded corpus (heading trails, token estimates, title-headed embedded_text,
  preambles present — and it caught the harness FTS-row bug); §3 covered by
  T019/T020 tests plus the corpus inspection; §4 run for real (tables above);
  §5 covered by the T012 rollout tests (legacy rows serving + reindexStale
  migration + idempotent second pass).
