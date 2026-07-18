# Data Model — 017 Search Index Efficiency

**Date**: 2026-07-18 | **Plan**: [plan.md](./plan.md) | **Research**: [research.md](./research.md)

## Schema delta

One migration: `migrations/1797000000000_add-content-hash-to-search-index.js`
(pre-assigned slot; 016 owns 1796…; floor after the retired 008 row is 1795000000000).

```sql
-- up
ALTER TABLE document_search_index ADD COLUMN content_hash TEXT;
-- down
ALTER TABLE document_search_index DROP COLUMN content_hash;
```

Nullable, no default, no backfill, no index (rows are only ever reached via the `doc_id`
primary key). **Nothing else rides in this migration.**

## Entities

### `document_search_index` (one row per document) — MODIFIED

| Column | Type | Notes |
|--------|------|-------|
| doc_id | UUID PK → documents(id) ON DELETE CASCADE | unchanged |
| content_text | TEXT | unchanged — refreshed unconditionally every indexing pass |
| search_vector | TSVECTOR (title weight A, body B) | unchanged — refreshed unconditionally |
| indexed_at | TIMESTAMPTZ | unchanged — freshness watermark, refreshed unconditionally |
| **content_hash** | **TEXT, nullable** | **NEW.** SHA-256 hex (64 chars) of `buildEmbedHashInput(extractedBodyText)` — extracted document text only, never title (CN-1) and never generated/derived text (FR-001, 018 contract; seam per CN-7). |

**`content_hash` state semantics**:

- `NULL` — pre-feature row, or never successfully embedded under 017. Always treated as
  "fingerprints differ" → regenerate on the next real indexing event (FR-004; the
  no-backfill rule).
- Non-null — the fingerprint of exactly the extracted text whose embeddings last completed
  successfully, **or** (empty/unembeddable content) the fingerprint of the text whose chunk
  cleanup completed (CN-6).

**Write discipline (invariants)**:

1. The FTS upsert NEVER writes `content_hash` (it reads it back via `RETURNING`).
2. `content_hash` is written in exactly two places, both transactional with the chunk-row
   change they describe:
   - the embed swap: `DELETE chunks → INSERT chunks (with embedding_model) → UPDATE
     content_hash → COMMIT` (FR-005);
   - the empty-content cleanup: `DELETE chunks → UPDATE content_hash → COMMIT` (FR-007).
3. A failed/rolled-back transaction leaves the prior value → the document remains detected
   as needing re-embedding (no lost updates; CN-4).

### `document_embeddings` (many rows per document) — behavior change, no DDL

| Column | Type | Notes |
|--------|------|-------|
| id | SERIAL PK | unchanged |
| doc_id | UUID → documents(id) ON DELETE CASCADE | unchanged (`idx_embeddings_doc_id`) |
| chunk_index | INTEGER, UNIQUE(doc_id, chunk_index) | unchanged |
| chunk_text | TEXT | unchanged |
| embedding | VECTOR(1536), HNSW cosine index | unchanged (CN-5: dimensionality fixed) |
| embedding_model | VARCHAR(100) DEFAULT 'gemini-embedding-001' | **becomes authoritative**: every INSERT now lists it explicitly with the configured model id (`EMBEDDING_MODEL`); previously populated only by column default (FR-009). Column default retained (dropping it would exceed the single-field schema scope). |

**Model-staleness predicate** (boot repair, FR-010/011): a document is model-stale iff
`EXISTS (SELECT 1 FROM document_embeddings de WHERE de.doc_id = d.id AND
de.embedding_model IS DISTINCT FROM $configuredModel)`. `IS DISTINCT FROM` makes NULL
models count as stale (safe direction: re-embed). All current rows hold the default
`'gemini-embedding-001'` = the configured model → deploying 017 triggers zero repair.

**Atomicity**: chunk rows for one document are only ever replaced as a set inside one
transaction; a document is never half-upgraded across models (CN-5). Mixed models exist
only *between* documents mid-repair and all rows stay queryable (FR-012).

### `documents` — read-only touch

`documents.updated_at` (bumped by `postgres-persistence.js` on persisted updates; already
surfaced as `updatedAt` in search results) becomes the filter basis for `updatedAfter`
(CN-2). No write-side change; no index added in this feature (research.md R7).

### Content search request — MODIFIED (no storage)

| Field | Type | Constraint |
|-------|------|-----------|
| updatedAfter | ISO-8601 timestamp string → Date | Optional. Valid ONLY with a content search (REST: `search` + `searchMode=content`; MCP: `search` present). Strictly-after, exclusive comparison against `documents.updated_at`. Unparseable → HTTP 400 / MCP tool error. Present without content search → HTTP 400 / MCP tool error (CN-3). Distinct from list-only `updatedSince` (different path, different timestamp basis); both documented side by side (FR-018/019). |

## State transitions (per document)

```text
                       persisted update → debounce 30s → indexDocument
                                              │
                    extract text; newHash = H(buildEmbedHashInput(text))
                                              │
                FTS upsert (always; title/content/indexed_at refresh) → storedHash
                                              │
        ┌─────────────────────────────────────┼──────────────────────────────────┐
 chunks == 0 (empty/unembeddable)    storedHash == newHash                 hash differs
        │                                     │                            or NULL
 storedHash == newHash?              model-mismatch EXISTS?                       │
   yes → done (settled)                no → SKIP (zero embed calls)               │
   no  → TX: delete chunks;            yes → fall through (override) ────────────►│
          content_hash = newHash                                                  │
          (ghosts removed, settled)                            embed batches (provider)
                                                                        │
                                                     fail → warn; hash unchanged → retry later
                                                     ok  → TX: delete chunks; insert chunks
                                                           (embedding_model = configured);
                                                           content_hash = newHash; COMMIT
```

Boot (`reindexStale()`): select docs missing from index OR `indexed_at < updated_at` OR
model-stale (predicate above) → same pipeline, concurrency 5 → a doc both edit- and
model-stale converges in one pass.
