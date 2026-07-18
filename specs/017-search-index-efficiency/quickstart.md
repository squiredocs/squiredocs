# Quickstart — validating 017 Search Index Efficiency

Runnable proof scenarios for the three stories. Contracts: [contracts/](./contracts/);
schema: [data-model.md](./data-model.md).

## Prerequisites

- Dev environment per `docs/dev.md` (commands run in the Minikube app-dev pod; dev server
  restarted so it is not running stale code).
- Migration applied: `npm run migrate` — then verify the slot and column:

  ```bash
  psql "$DATABASE_URL" -c "SELECT name FROM pgmigrations ORDER BY id DESC LIMIT 1;"
  # expect: 1797000000000_add-content-hash-to-search-index
  psql "$DATABASE_URL" -c "\d document_search_index" | grep content_hash
  ```

- For provider-call scenarios, `GOOGLE_GENERATIVE_AI_API_KEY` set (or use the Jest suites,
  which mock the provider and count calls — no key or spend needed).

## Automated validation (authoritative)

Backend Jest — **serial**, from repo root:

```bash
npx jest server/__tests__/search-indexer-gating.test.js \
         server/__tests__/search.test.js \
         server/__tests__/list-documents-updated-after.test.js \
         server/__tests__/api-docs.test.js \
         server/__tests__/search-indexer.test.js \
         server/__tests__/documents.test.js --runInBand
```

Expected: all pass; pre-existing tests pass **unmodified** (SC-005). Then the full backend
suite (`npm test`, serial) before handing off.

## Manual scenarios

### US1 — unchanged content costs zero embedding work (SC-001)

1. Create a doc with a few paragraphs; wait ≥ 30 s (debounce) for indexing; note server log
   `[SearchIndexer] Indexed <guid> …`.
2. `psql`: `SELECT content_hash FROM document_search_index WHERE doc_id='<guid>';` →
   non-null 64-char hex.
3. Change ONLY the title; wait for reindex. Expect: no embedding-provider traffic (no
   embed batch logs), `content_hash` unchanged, `SELECT count(*) FROM document_embeddings
   WHERE doc_id='<guid>'` unchanged — and title findable via
   `GET /api/docs?search=<new title word>&searchMode=content` (fulltext leg).
4. Edit body text; wait. Expect one regeneration; `content_hash` changed.
5. Delete all body text; wait. Expect chunk rows for the doc deleted (ghost cleanup,
   CN-6), `content_hash` advanced; further title-only edits cost nothing.

### US2 — updatedAfter recency pre-filter (SC-003/004/007)

Seed two matching docs, one old, one new (or edit one now), then:

```bash
# excludes the old doc in every mode; totals count only the filtered set
curl -s "$BASE/api/docs?search=<q>&searchMode=content&updatedAfter=<cutoff-ISO>" -H "$AUTH"
curl -s "...&mode=fulltext..." ; curl -s "...&mode=semantic..."
# byte-identical to pre-feature without the param
curl -s "$BASE/api/docs?search=<q>&searchMode=content" -H "$AUTH"
# validation: 400 on both misuse shapes
curl -s "$BASE/api/docs?updatedAfter=2026-07-01T00:00:00Z" -H "$AUTH"          # no content search
curl -s "$BASE/api/docs?search=x&searchMode=content&updatedAfter=banana" -H "$AUTH"  # bad timestamp
# future cutoff: 200, empty docs, total 0
curl -s "$BASE/api/docs?search=<q>&searchMode=content&updatedAfter=2030-01-01T00:00:00Z" -H "$AUTH"
```

MCP (any connected agent): `list_documents({ search, updatedAfter })` filters;
`list_documents({ updatedAfter })` → tool error pointing at `updatedSince`;
`list_documents({ updatedSince })` (list path) behaves exactly as before.

### US3 — model upgrade heals itself (SC-002)

Simulate a model change without redeploying a real new model:

```bash
psql "$DATABASE_URL" -c "UPDATE document_embeddings SET embedding_model='old-model-test'
  WHERE doc_id='<guid>';"
```

Restart the server. Expect boot `reindexStale()` to select exactly that doc (log line),
re-embed it once, and leave `embedding_model='gemini-embedding-001'` on all its rows.
Search keeps answering during the repair. Restart again → zero model-repair work.

## Expected outcomes checklist

- [ ] Migration 1797000000000 applied; only `content_hash` added.
- [ ] SC-001: title/formatting churn → zero embed calls; title searchable.
- [ ] SC-002: only mismatched docs re-embed; second boot idle.
- [ ] SC-003/004: exclusion + totals in all 3 modes; result ⊆ accessible ⊆ unfiltered.
- [ ] SC-005: no-new-params requests byte-identical (existing suites green, unmodified).
- [ ] SC-006: forced embed failure (revoke key / mock) leaves keyword search working and
      hash unchanged; next pass retries.
- [ ] SC-007: both entry points reject bad/misplaced `updatedAfter` with explicit errors.
