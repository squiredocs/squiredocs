# Contract: Evaluation Harness (FR-023…FR-029, RBD-5/RBD-6)

Operator tool on main. Never CI-blocking. `rag-search-v2` is reference-only — code is
re-ported, the branch is never merged.

## Commands (package.json)

| Script | Runs | Requires |
|---|---|---|
| `npm run search:eval` | `node server/search/eval/run-eval.js` | `GOOGLE_GENERATIVE_AI_API_KEY`, populated corpus, migrated DB |
| `npm run search:eval:check` | `node server/search/eval/check-eval-set.js [results.json]` | nothing (offline) |

## `run-eval.js` CLI

- Default (no flags): **minimum sweep** (FR-025/SC-008): re-index + evaluate
  `fixed` (old chunking baseline) → `structure, preambles off` → `structure,
  preambles on`, then print the metric table and write
  `server/search/eval/eval-results.<timestamp>.json` (git-ignored).
- `--rerank` — adds the explicitly flagged reranker variant (FR-030: never a default).
- `--variant=<name>` — evaluate a single named variant against the current index
  (no re-index) for fast iteration.
- `--limit=N`, `--budget=<tokens>` (default 8000, feeds recall@token-budget).
- Fail-fast (spec edge case): missing API key, or semantic search unavailable →
  exit non-zero with a clear message; never silently measure fulltext-only.
- Deleted expected docs: reported per query as `skipped/degraded`, not scored as
  misses (spec edge case).
- Per-variant re-indexing goes through the real indexer with `getSearchConfig`
  overrides (FR-026) — the same code path production uses. Queries run through
  `search.searchDocuments` (mode hybrid, limit 20).

## Metric table (FR-024)

Columns: `R@5 | R@10 | R@20 | MRR | nDCG@10 | R@budget` over answerable queries;
`no-answer accuracy` and query counts printed alongside (no-answer excluded from
the averaged metrics). One row per variant. All metric functions live in
`server/search/eval/metrics.js` as pure functions with Jest unit tests
(known-input fixtures for each metric, including null-handling for no-answer).

## Eval set + saturation guard (FR-027/FR-028, SC-009)

- Set schema: see data-model.md (versioned JSON, typed queries, empty
  `relevantDocIds` for no-answer).
- `check-eval-set.js` with no args: audits composition minimums (≥40 / ≥12
  paraphrase / ≥6 multi-doc / ≥6 no-answer; multi-doc entries have ≥2 refs;
  no-answer have 0) — exit 1 on violation.
- `check-eval-set.js eval-results.<ts>.json`: evaluates the saturation guard —
  the set **discriminates** iff (a) NOT all variants score 1.0 on all of
  Recall@5/10/20, AND (b) at least one of Recall@10 / MRR / nDCG@10 differs by
  ≥ 0.03 between some pair of minimum-sweep variants. Guard failure = eval-set
  defect (fix by adding harder queries) — exit 1 with that message, never
  "variants are equal".

## Before/after protocol (FR-029, RBD-6, SC-010)

Run the minimum sweep on the operator dev corpus with one eval-set version; copy
the printed table (with variant configs + set version) into the feature's
promotion notes. Regressions are documented, never hidden; they do not gate.
