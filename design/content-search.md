<!-- source: https://squiredocs.com/d/187b0da3-1004-4273-82f8-062f6a903f14
     synced-by: design/sync.mjs — DO NOT HAND-EDIT; amend the Squire doc and re-sync -->

# Squire Content Search

## What this is

How the document-list search box and the MCP `list_documents` search find documents by _content_: two retrieval engines — Postgres full-text and pgvector semantic — fused with Reciprocal Rank Fusion. Core: `server/search.js` (query side) and `server/search-indexer.js` (index side).

## The two engines

- **Full-text: **`websearch_to_tsquery` against `document_search_index.search_vector` (title weighted A, body B; GIN index), ranked by `ts_rank_cd`, with `ts_headline` snippets sanitized to allow only `<mark>`.
- **Semantic: **cosine distance over `document_embeddings` (gemini-embedding-001, 1536 dims, HNSW index). Documents are chunked at 6000 chars with 500 overlap; one row per chunk; default distance threshold 0.5. Falls back to full-text automatically when embeddings or the Google API key are absent.
- **Fusion: **each engine ranks independently; scores combine as `1/(60+rank)` summed across engines (a FULL OUTER JOIN on doc id). Modes: hybrid (default), fulltext, semantic.

## Index maintenance

Every Yjs update marks the doc dirty; the indexer debounces 30 seconds, then extracts plain text from the persisted doc, upserts the FTS row, and regenerates embeddings (best-effort — full-text survives an embedding failure; chunks are replaced transactionally). On boot, `reindexStale()` repairs docs whose index predates their last update, concurrency-capped at 5.

**Amendment (Sam, 2026-07-18) — incremental gating (feature 017): **indexing becomes change-gated. The indexer stores a hash of the extracted document text on the FTS row and SKIPS embedding regeneration when the hash is unchanged — a persisted Yjs update that does not change extracted text (title sync, cursor-only sessions, formatting-only churn) costs zero embedding calls. The indexer also writes the embedding model id per chunk row (the column has existed since the original migration but was never written), and reindexStale() repairs rows whose model differs from the configured EMBEDDING_MODEL as well as stale ones — so an embedding-model upgrade becomes an automatic, targeted re-embed instead of a manual backfill. Adapted from the Liz Data Layer Search design (content_hash + embedding_model_version watermarks) after the 2026-07-18 gap analysis.

## Chunking, context, and evaluation (amendment, Sam, 2026-07-18 — feature 018)

Chunking becomes structure-aware: documents split along heading boundaries into roughly 600-token chunks carrying a heading_path (the h1→…→hN trail), replacing the structure-blind 6000-char/500-overlap windows. Multi-chunk documents additionally get a short LLM-written contextual preamble per chunk (1–3 situating sentences, embedded and keyword-indexed with the chunk); single-chunk documents get NONE — they self-situate, and skipping them eliminates most contextualizer cost (the Liz refinement the earlier rag-search-v2 branch missed). The content hash that gates re-embedding (017) covers only extracted document text, never generated preambles. The doc-level RRF response shape is preserved — chunk hits roll up to documents, so the API and MCP contracts do not move.

The search evaluation harness becomes first-class on main (rescued and re-ported from the rag-search-v2 branch, which stays a reference only): Recall@k / MRR / nDCG / recall@token-budget metrics, a variant-sweep runner, and a CURATED long-tail eval set (paraphrased/conceptual, multi-doc, and no-answer queries) replacing the saturated LLM-drafted set. **Decision (Sam, 2026-07-18): **the chunking/preamble work is built now with the eval measuring it before/after — measurement informs tuning rather than gating the build (overriding the gap analysis’ build-only-if-eval-says-so recommendation). The LLM reranker stays off by default: the existing eval showed it lowered MRR at ~5.7s/query on this corpus; it remains a flag pending curated-eval evidence.

**Addition (Sam, 2026-07-18) — titles join the embedded text: **today the document title is keyword-indexed at weight A but never embedded (chunks are body-text only), so conceptual title matches leak through the semantic leg. From 018 onward, every chunk’s embedded text begins with its heading_path headed by the DOCUMENT TITLE — titles become semantically searchable corpus-wide. Corollary: the 017 re-embed hash expands to cover the title once it is part of embedded text (a title change must bust the gate); until 018 lands, 017’s title-excluded hash remains correct because the title is not embedded.

## Authorization

Search never widens access: every query CTE joins `document_shares` on the requesting user, so both engines are pre-filtered to accessible documents before ranking.

## Entry points

`GET /api/docs?search=…&searchMode=content` from the document list (title-only search otherwise), and the MCP `list_documents` tool’s `search`/`searchMode` parameters.

**Amendment (Sam, 2026-07-18) — recency pre-filter + entry-point corrections (feature 017): **content search accepts an updatedAfter filter (surfaced on GET /api/docs and the MCP list_documents tool) applied as an indexed-column WHERE inside the engine CTEs BEFORE ranking — filter-then-search, so agents can ask "recent docs about X" without post-hoc truncation. Corrections to this doc from the 2026-07-18 gap analysis: the client sends searchMode=content for every non-empty query (the "title-only otherwise" path is effectively API/MCP-only), and the content branch carries a per-user rate limit — both true since the 010 hardening.