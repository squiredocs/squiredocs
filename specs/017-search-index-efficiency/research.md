# Research — 017 Search Index Efficiency

**Date**: 2026-07-18 | **Spec**: `specs/017-search-index-efficiency/spec.md`

All CN-1..CN-6 decisions in `clarifications-needed.md` are RATIFIED-BY-DEFAULT and are
treated as settled inputs here — this document records only the *implementation-level*
decisions beneath them, derived from reading the live code (`server/search-indexer.js`,
`server/search.js`, `server/index.js` `/api/docs` handler, `server/mcp/tools/list-documents.js`,
`migrations/1775501984000_create-document-search-index.js`).

## R1. Hash algorithm and storage format

- **Decision**: SHA-256 (Node built-in `crypto.createHash('sha256')`), hex-encoded, stored in
  a nullable `content_hash TEXT` column on `document_search_index`.
- **Rationale**: Deterministic, collision-resistant, zero dependencies, 64-char constant
  size. Spec explicitly leaves the algorithm as an implementation detail. `NULL` means
  "no successful embed recorded under this feature" → FR-004 regenerate path, which is also
  the automatic no-backfill behavior for pre-feature rows.
- **Alternatives considered**: `md5()` in Postgres (computes hash server-side, but ties the
  contract to SQL and to the FTS upsert, which must NOT advance the hash — rejected);
  xxhash/murmur (extra dependency for no benefit at this scale).

## R2. Hash-input seam (018 forward-compatibility — Sam's design Addition, commit 7433c65)

- **Decision**: The bytes that get hashed are produced by exactly one exported function,
  `buildEmbedHashInput(extractedText)` in `server/search-indexer.js`. In 017 it is the
  identity on extracted body text (title excluded per CN-1). The gate computes
  `computeContentHash(buildEmbedHashInput(extractedText))` and never hashes any other value.
- **Rationale**: The design doc's 2026-07-18 Addition says 018 will fold the document title
  into embedded chunk text, at which point the re-embed hash must cover the title. Pinning a
  single seam makes 018's expansion a one-line signature change
  (`buildEmbedHashInput(title, extractedText)`) with no change to the gate logic, the
  `content_hash` column, or the advance-on-success semantics. A test asserts the stored hash
  equals `computeContentHash(buildEmbedHashInput(text))` and that its output is
  title-independent in 017.
- **Alternatives considered**: hashing inline at the call site (018 would have to edit gate
  internals — rejected); a config flag for hash composition (YAGNI; 018 is a code change
  anyway).
- **Ledgered**: CN-7 in `clarifications-needed.md`.

## R3. Where the gate reads the stored hash

- **Decision**: The unconditional FTS upsert (Step 1 of `indexDocument`) gains
  `RETURNING content_hash`. The upsert's `ON CONFLICT ... DO UPDATE` never touches
  `content_hash`, so the returned value is the previously stored hash — one round trip, no
  extra SELECT, no race with the upsert itself.
- **Rationale**: The hash lives on the FTS row (FR-002) but advances only with the embed
  transaction (CN-4); keeping the upsert hash-blind makes that invariant structural.
- **Alternatives considered**: separate `SELECT content_hash` before the upsert (extra query,
  same semantics); storing the hash on a new table (violates FR-002's single-field scope).

## R4. Gate placement and skip conditions in `indexDocument`

- **Decision**: `indexDocument` owns the gate, sequenced as:
  1. extract text, `newHash = computeContentHash(buildEmbedHashInput(contentText))`;
  2. FTS upsert (always, unchanged content) → `storedHash`;
  3. `chunks = chunkText(contentText)`; **empty/unembeddable** (`chunks.length === 0`):
     if `storedHash !== newHash`, run one transaction `DELETE document_embeddings rows;
     UPDATE content_hash = newHash` (CN-6 ghost cleanup + settle); if equal, do nothing
     (already settled — no repeated deletes). This path runs regardless of provider-key
     presence (there is nothing to embed, so "disabled embeddings" is irrelevant — FR-005's
     "nothing to embed" arm).
  4. **Unchanged content** (`storedHash === newHash`): run one cheap indexed
     `EXISTS(... embedding_model IS DISTINCT FROM $configured)` check; if no mismatch, skip
     embedding entirely (FR-003, zero provider calls). If mismatched rows exist, fall through
     — model staleness overrides the gate (CN-5/FR-011).
  5. Otherwise call `generateAndStoreEmbeddings(docGuid, contentText, newHash)`.
- **Rationale**: The model-override check runs only when the hash matches (the only case
  where the gate would wrongly suppress model repair), so the steady-state cost of the
  feature is one `RETURNING` column plus at most one indexed EXISTS per pass. Putting the
  empty-path before the provider-key check is required by CN-4 + CN-6 jointly.
- **Alternatives considered**: a `forceEmbed` flag threaded from `reindexStale`
  (two code paths; breaks the "edited while model repair pending converges in one pass"
  edge case — the EXISTS check inside the single pipeline handles both staleness kinds in
  one pass by construction); checking mismatch on every pass unconditionally (wasted query
  when the hash already differs).

## R5. Atomic hash advance with the chunk swap

- **Decision**: `generateAndStoreEmbeddings(docGuid, contentText, contentHash)` performs, in
  its existing single transaction: `DELETE` old chunk rows → `INSERT` new rows (now with
  explicit `embedding_model` = configured model) → `UPDATE document_search_index SET
  content_hash = $contentHash WHERE doc_id = $docGuid` → `COMMIT`. The provider-key early
  return and any embed/DB failure leave the transaction unrun/rolled back, so the hash never
  advances without the chunks it describes (FR-005, CN-4). The hash written is the hash of
  exactly the text that was chunked and embedded — both travel together as arguments from
  the single extraction in `indexDocument`, so an in-flight newer edit can never have its
  fingerprint recorded (spec edge case 4).
- **Rationale**: The transaction already exists (all-or-nothing chunk swap); adding one
  UPDATE to it is the minimal correct implementation of "advances atomically with the swap".
- **Alternatives considered**: advancing the hash in `indexDocument` after the embed call
  returns (window where the process dies between commit and hash write → spurious re-embed;
  acceptable but strictly worse); two-phase status column (schema beyond scope).

## R6. Model watermark write + repair selection

- **Decision**: Chunk INSERT lists `embedding_model` explicitly with the configured model id
  (`EMBEDDING_MODEL`, currently the hardcoded `'gemini-embedding-001'` shared const — making
  it configurable is out of scope). `reindexStale()`'s selection query becomes:
  missing-row OR `si.indexed_at < d.updated_at` OR
  `EXISTS (SELECT 1 FROM document_embeddings de WHERE de.doc_id = d.id AND
  de.embedding_model IS DISTINCT FROM $1)` with `$1 = EMBEDDING_MODEL`. Selected docs flow
  through the unchanged per-document pipeline under the existing `EMBEDDING_CONCURRENCY = 5`
  batching.
- **Rationale**: `IS DISTINCT FROM` treats a NULL model as mismatched (safe: re-embed).
  Existing rows carry the column default `'gemini-embedding-001'` == current configured
  model, so deploying 017 triggers **zero** model repair (SC-002's "already on the new model"
  is the whole current corpus). Per-document atomicity is inherited from the chunk-swap
  transaction — mixed-model states exist only *between* documents, which stay queryable
  (FR-012; same dimensionality assumed per CN-5).
- **Alternatives considered**: per-row repair (rejected by CN-5); a dedicated
  `reindexModelStale()` second pass (duplicates the pipeline; loses single-pass convergence
  for docs both edit- and model-stale); dropping the column default (schema change beyond
  the single hash field — out of scope, and the default is harmless once inserts are
  explicit).

## R7. `updatedAfter` SQL mechanism

- **Decision**: When `updatedAfter` is present, each engine candidate CTE gains an inner
  `JOIN documents rd ON rd.id = <t>.doc_id AND rd.updated_at > $N` (strictly-after, CN-2):
  the `fts` CTE (on `si.doc_id`) and the `top_chunks` vector CTE (on `de.doc_id`) — hybrid
  mode composes both legs automatically since it reuses those CTE builders. `$N` is appended
  to the params array before limit/offset (which `runSearchQuery` requires last). Ranking
  (`ts_rank_cd` / distance order / RRF) runs only over the filtered candidates, and
  `COUNT(*) OVER()` totals therefore count only the filtered set (FR-016). Sorts, role
  filters, pagination, and distanceThreshold compose unchanged because they operate on/after
  the already-filtered CTE output (FR-017). Absent `updatedAfter`, the emitted SQL is
  byte-identical to today's (FR-022 zero-change guarantee by construction).
- **On "indexed-column"**: `documents.updated_at` has no dedicated index today, and this
  feature's migration is pinned to the hash column only. The filter is applied per candidate
  row reached via the `documents` primary key inside candidate selection — no new sequential
  scan is introduced (the engines' own GIN/HNSW + share-join access paths are unchanged).
  At beta corpus size this is the design's intent ("filter-then-search" before ranking);
  if profiling ever warrants `CREATE INDEX ON documents(updated_at)`, that is a follow-up
  one-liner outside 017's pinned migration. Recorded as a known deviation-in-letter (not in
  mechanism) from the amendment's "indexed-column WHERE" phrasing — see analyze findings.
- **Alternatives considered**: filtering on `document_search_index.indexed_at` (indexed, but
  wrong semantics — CN-2 pins `documents.updated_at`, the value surfaced as `updatedAt`);
  post-CTE WHERE in the outer detail query (filter-after-rank — violates FR-016: RRF ranks
  and totals would include out-of-window docs); denormalizing `updated_at` onto the index
  tables (schema beyond scope).

## R8. Parameter surface + validation (CN-3)

- **Decision**: One shared validator exported from `server/search.js`:
  `parseUpdatedAfter(value, { hasContentSearch })` → `Date`, throwing an `Error` with
  `error.code = 'INVALID_UPDATED_AFTER'` and a caller-pointing message when the value is
  unparseable (FR-014) or supplied without a content search (FR-018/CN-3). Entry points:
  - `GET /api/docs` (`server/index.js`): validate at the top of the handler, **before** the
    rate limiter — `updatedAfter` present without (`search` + `searchMode=content`) → 400;
    unparseable → 400. Cheap string checks spend no search quota; valid recency-filtered
    searches still pass through `rateLimit.enforceUser('search', …)` unchanged (FR-021).
  - MCP `list_documents`: handler throws the validator's error (an MCP tool error), exactly
    mirroring the existing `updatedSince`-with-`search` precedent; schema + description gain
    `updatedAfter` with an explicit contrast against list-only `updatedSince` (FR-019).
    Tool count stays 16 (registry untouched).
  - `searchDocuments` also accepts `options.updatedAfter` (Date or ISO string) and
    re-validates defensively, so the engine can never be reached with a silent no-op filter.
- **Rationale**: The two entry points need different error transports (HTTP 400 vs thrown
  tool error) but must share one semantics; a single validator keeps the error text and
  strictness identical. Error text: bad timestamp →
  `updatedAfter must be a valid ISO-8601 timestamp`; misplaced →
  `updatedAfter requires a content search; use searchMode=content with a search query`
  (REST) / `… provide "search", or use updatedSince for the list path` (MCP).
- **Alternatives considered**: silently ignoring (forbidden by CN-3); validating only inside
  `searchDocuments` and mapping thrown errors to 400 in the REST catch-all (today's catch
  returns 500 for everything; distinguishing would need an error-type check anyway — the
  up-front check is simpler and keeps 400s out of the rate limiter).

## R9. Test strategy and placement

- **Decision** (backend Jest, serial, shared DB — Principle II):
  - **New** `server/__tests__/search-indexer-gating.test.js`: DB-backed suite for
    hash-gate semantics, model watermark/repair selection, empty-doc ghost cleanup, and the
    hash-seam assertion. Mocks the `ai` package's `embedMany` (`jest.mock('ai')`) to count
    provider calls and to simulate failure; uses the real pool/tables like `search.test.js`.
    A new file (rather than growing `search-indexer.test.js`) because that suite is pure
    unit (chunkText) with no DB harness; no duplication — chunking tests stay where they are.
  - **Extend** `server/__tests__/search.test.js`: `updatedAfter` engine-level coverage
    (all three modes incl. before-ranking totals, strictly-after boundary, future cutoff,
    composition with filter/sort/pagination, permission-subset, invalid-value throw) plus
    zero-change regression (existing tests unchanged = SC-005 at engine level).
  - **New** `server/__tests__/list-documents-updated-after.test.js`: MCP handler-level tests
    (tool error on bad/misplaced `updatedAfter`, pass-through on search path, `updatedSince`
    untouched, description/schema assertions). No existing file requires
    `tools/list-documents` directly, so this is net-new coverage, not duplication.
  - **Extend** `server/__tests__/api-docs.test.js`: REST-shaped 400 coverage. Note: this
    suite mounts an inline copy of the handler ("same as in server/index.js" — existing repo
    pattern); the copy is updated to include the content branch + shared-validator call so
    supertest exercises real status codes through the real validator. The drift risk of the
    copy is pre-existing and flagged in analyze.
- **Rationale**: extends the existing suites where a harness exists, adds files only where
  no harness exists; every SC maps to at least one named test (see plan.md traceability).

## R10. Migration

- **Decision**: `migrations/1797000000000_add-content-hash-to-search-index.js`:
  `ALTER TABLE document_search_index ADD COLUMN content_hash TEXT` (nullable, no default,
  no backfill, no index — the PK row lookup is the only access path). `down`: drop column.
  Timestamp 1797000000000 is the pre-assigned slot (016 holds 1796…; floor after the retired
  008 row is 1795000000000 per `migrate.js` auto-clean) — **nothing else rides in this
  migration**.
- **Rationale**: absent hash ≡ "regenerate on next real indexing event" (spec scope:
  no backfill). node-pg-migrate per constitution constraints.
