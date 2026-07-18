# Quickstart — 018-search-chunking-and-eval

Validation guide. Prereqs: Minikube app-dev pod (`docs/dev.md`), migrated DB
(017's migration 1797… then this feature's 1798…), `GOOGLE_GENERATIVE_AI_API_KEY`
set for embedding/preamble scenarios. Backend tests are serial-only.

## 1. Automated suites (CI-safe, no API key needed)

```bash
npm run test:server            # full serial backend suite
# Focused (still serial — never in parallel with another backend run):
npx jest server/__tests__/search-chunker.test.js server/__tests__/search-embedded-text.test.js \
         server/__tests__/search-contextualizer.test.js server/__tests__/search-eval-metrics.test.js \
         server/__tests__/search-indexer.test.js server/__tests__/search.test.js \
         --runInBand --forceExit
```

Expected: chunker determinism/boundary/packing/oversize/tiny/overlap rules pass;
embedded-text composition starts with `title > h1 > …`; hash covers title but not
preambles; preambles present-iff-multi-chunk with zero calls for single-chunk
docs; transactional swap; retrieval contract freeze + auth probe; legacy-rollout
continuity; metric unit tests; eval-set composition audit.

## 2. Chunk inspection on a real corpus (US1)

```bash
node -e "…index one long structured doc…"   # or edit a doc in the app and wait out the 30s debounce
psql -c "SELECT chunk_index, heading_path, token_estimate, LEFT(embedded_text, 80)
         FROM document_embeddings WHERE doc_id = '<uuid>' ORDER BY chunk_index;"
```

Expected: boundaries on headings, sizes near 600 tokens, correct trails, every
`embedded_text` starting with the document title header line.

## 3. Preamble behavior (US2)

- Multi-chunk doc: every row has `preamble_text` (1–3 sentences); single-chunk
  doc: `preamble_text IS NULL` and server logs show zero contextualizer calls.
- Preamble-only term: search it via `GET /api/docs?search=<term>&searchMode=fulltext`
  and `…=semantic` — the document returns on both; the snippet shows document
  text only.
- Kill the key (`GOOGLE_GENERATIVE_AI_API_KEY=`), reindex: chunks index without
  preambles, search keeps working.

## 4. Eval harness (US3/US4 — operator, live key + populated corpus)

```bash
npm run search:eval:check                       # composition audit (offline)
npm run search:eval                             # minimum sweep: fixed → structure → structure+preambles
npm run search:eval:check eval-results.<ts>.json  # saturation guard verdict
npm run search:eval -- --rerank                 # optional flagged reranker variant
```

Expected: one table, one row per variant, all FR-024 metric columns; guard
reports the set discriminates (SC-009). Contracts: see
[contracts/eval-harness.md](contracts/eval-harness.md).

## 5. Rollout continuity (SC-012)

On a corpus with pre-018 rows: restart the server; while
`SELECT count(*) FROM document_embeddings WHERE embedded_text IS NULL` is
nonzero, run content searches — results keep returning; the count reaches zero
as the background re-chunk completes; a second restart does zero re-chunk work.

## 6. Before/after (US5)

Run the minimum sweep once; paste the table (with eval-set version + variant
configs) into the feature's promotion notes (SC-010).
