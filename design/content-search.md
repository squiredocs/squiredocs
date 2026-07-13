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

## Authorization

Search never widens access: every query CTE joins `document_shares` on the requesting user, so both engines are pre-filtered to accessible documents before ranking.

## Entry points

`GET /api/docs?search=…&searchMode=content` from the document list (title-only search otherwise), and the MCP `list_documents` tool’s `search`/`searchMode` parameters.