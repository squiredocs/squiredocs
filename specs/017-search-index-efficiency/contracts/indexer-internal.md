# Contract — Indexer internals: hash gate + model watermark

Internal (module-level) contract for `server/search-indexer.js`. Not user-facing, but
binding for feature 018 and for tests.

## Hash contract (FR-001..008, CN-1, CN-7 — 018 depends on this)

1. **Single seam**: the bytes that get hashed are produced by exactly one exported function:

   ```js
   buildEmbedHashInput(extractedText) // 017: identity on extracted body text
   computeContentHash(input)          // sha256 hex over the seam's output
   ```

   The gate consumes ONLY `computeContentHash(buildEmbedHashInput(extractedText))`. No call
   site hashes anything else. Feature 018 widens the seam to
   `buildEmbedHashInput(title, extractedText)` when titles join the embedded text (design
   Addition, commit 7433c65) — a signature-only change; gate logic, `content_hash` column,
   and advance-on-success semantics MUST NOT move.
2. **Input scope (017)**: extracted document body text only. Title excluded (CN-1).
   Generated/derived text (e.g. 018's contextual preambles) permanently excluded — the hash
   is **chunker-agnostic**: it fingerprints what was extracted, regardless of how it is
   later chunked or augmented for embedding.
3. **Advance rule**: `content_hash` advances ONLY (a) atomically with a successful chunk
   swap for exactly that text, or (b) atomically with the empty-content chunk cleanup.
   Never on FTS upsert, never on embed failure, never when embeddings are disabled (CN-4).

## Gate semantics (observable via mocked provider + DB state)

| Situation at indexing pass | Provider calls | Chunk rows | content_hash |
|---|---|---|---|
| storedHash == newHash, models match | **0** | untouched | unchanged |
| storedHash == newHash, some row's model ≠ configured | full re-embed (override, CN-5) | replaced (all, with configured model) | unchanged value rewritten (same hash) |
| storedHash ≠ newHash (or NULL) | full re-embed | replaced | → newHash |
| chunks == 0, storedHash ≠ newHash | **0** | **deleted** (ghost cleanup, CN-6) | → newHash |
| chunks == 0, storedHash == newHash | **0** | untouched (already none) | unchanged |
| embed throws (any batch) | attempted | **untouched** (rollback) | **unchanged** → retried at next indexing event |
| no provider key, content changed | 0 | untouched | **unchanged** (CN-4) |

In every case the FTS row (content_text, search_vector incl. title weight A, indexed_at)
is refreshed unconditionally first — keyword search never degrades (FR-003, SC-006).

## Model watermark (FR-009..012)

- Every chunk INSERT lists `embedding_model = EMBEDDING_MODEL` explicitly.
- `reindexStale()` selection = missing index row OR `indexed_at < updated_at` OR
  `EXISTS (… embedding_model IS DISTINCT FROM $EMBEDDING_MODEL)`. No dedicated
  failed-embed hunt (CN-4). Existing concurrency cap (5) and per-document pipeline
  unchanged; a doc both edit- and model-stale is processed once.
- Second boot after a completed repair selects zero docs for model reasons (SC-002).

## Exports delta

`module.exports` gains `buildEmbedHashInput` and `computeContentHash`. Existing exports
(`init, markDirty, indexDocument, reindexStale, flushDirty, chunkText,
generateAndStoreEmbeddings, EMBEDDING_MODEL, EMBEDDING_DIMENSIONS`) keep their signatures,
except `generateAndStoreEmbeddings(docGuid, contentText, contentHash?)` gains an optional
third parameter defaulting to `computeContentHash(buildEmbedHashInput(contentText))` — so
the existing two-arg caller `server/scripts/backfill-search-index.js` stays correct by
construction (it advances the hash for exactly the text it just embedded).
