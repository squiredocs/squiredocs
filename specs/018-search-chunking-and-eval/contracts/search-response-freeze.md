# Contract: Retrieval Response Freeze (FR-019…FR-022, RBD-3/RBD-8)

018 changes WHAT is indexed, never the retrieval contract. This file pins what must
not move, and the one internal composition that changes.

## Frozen — byte-for-byte (SC-004)

- **Entry points**: `GET /api/docs?search=…&searchMode=content` and MCP
  `list_documents` (`search`/`searchMode`/`distanceThreshold` params). No new
  parameters from 018 (017 adds `updatedAfter`); MCP stays 16 tools.
- **Response shape** (`server/search.js` `formatResults`): one entry per document,
  fields `doc_id, title, updated_at, role, owner_name, owner_email, snippet,
  score, share_count` + `pagination { total, limit, offset, hasMore }` — no
  field additions, removals, or type changes.
- **Modes & fallback (FR-022)**: hybrid (default) / fulltext / semantic;
  automatic fulltext fallback when embeddings or the API key are absent
  (`checkEmbeddingsExist()` + key check) — unchanged.
- **Ordering semantics**: doc-level RRF fusion `1/(60+rank)` summed across legs;
  sortBy/sortOrder/filter/pagination behavior unchanged.

## Authorization invariant (FR-021, SC-011)

Every candidate-selecting sub-query — doc-level FTS, **new chunk-keyword
sub-select**, and vector CTE — carries
`JOIN document_shares ds ON ds.doc_id = … AND ds.user_id = $1` (+ role condition)
BEFORE ranking. A user searching terms present only in an unshared document's
chunks or preambles gets zero rows for that document. Post-017, the same
sub-queries also carry the `updatedAfter` condition when supplied.

## Snippet provenance (FR-018/FR-020, RBD-3)

- Keyword-path snippets: `ts_headline('english', si.content_text, …)` over the
  **doc-level** `document_search_index.content_text` only, sanitized to the
  `<mark>`-only allowlist. A document matched only via preamble vocabulary gets
  the headline's leading document-text excerpt — never preamble text.
- Semantic-path excerpts: `LEFT(chunk_text, 300)` — `chunk_text` is raw
  document-authored text by the chunk-record contract; `embedded_text` /
  `preamble_text` MUST NOT be selected into any snippet expression.

## The one internal change (D4) — behind the frozen shape

The keyword leg becomes: doc-level `document_search_index` match ∪ chunk-level
`document_embeddings.search_vector` match, collapsed to one row per doc,
`score = GREATEST(doc_rank, best_chunk_rank)`, before feeding the existing RRF /
result pipeline. Observable consequences (and the only ones): documents become
keyword-retrievable via preamble/title-header vocabulary (SC-005); everything in
the sections above stays identical, enforced by the existing search test suite
passing unchanged plus new freeze assertions.
