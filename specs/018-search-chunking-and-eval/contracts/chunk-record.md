# Contract: Chunk Record (FR-008/FR-009/FR-010/FR-011)

Durable data contract for stored chunks. Realized as extended `document_embeddings`
columns (plan D1); the FIELDS are the contract, the layout is the implementation.

## Durable fields (every new-scheme chunk row)

| Contract field | Column | Notes |
|---|---|---|
| document reference | `doc_id` | FK, cascade delete |
| ordinal | `chunk_index` | 0-based, unique per doc |
| chunk text | `chunk_text` | document-authored text only |
| heading_path | `heading_path` | `TEXT[]`, `{}` when unheaded; **excludes** the title (title is prepended at composition time, DR-1) |
| preamble (optional) | `preamble_text` | NULL = absent; present only on chunks written as part of a ≥2-chunk set |
| embedding | `embedding` | vector of `embedded_text` |
| embedding model id | `embedding_model` | written explicitly (017 FR-009) |

Supporting (implementation, still stable): `embedded_text` (the composed indexed text;
NULL marks a legacy row), `token_estimate`, `search_vector`.

## Embedded-text composition (DR-1 — design-ratified)

```
header       = [documentTitle, ...heading_path].join(' > ')   // title ALWAYS leads
embedded_text = header + '\n'
              + (preamble_text ? preamble_text + '\n\n' : '')
              + chunk_text
```

- Applies to every chunk, including single-chunk documents and empty heading paths.
- `search_vector = to_tsvector('english', embedded_text)`.
- The 017 re-embed hash input is `title + '\n' + bodyText` — covers the title
  (a title change busts the gate), never covers `preamble_text` (FR-015).

## Migration `1798000000000_chunk-structure-columns.js`

- `ALTER TABLE document_embeddings ADD COLUMN` × (`heading_path TEXT[]`,
  `preamble_text TEXT`, `embedded_text TEXT`, `token_estimate INTEGER`,
  `search_vector TSVECTOR`) — all nullable, no backfill, no re-embedding.
- `CREATE INDEX idx_embeddings_search_vector_gin … USING GIN (search_vector)`.
- `down`: drop the index and the five columns.
- Slot constraint: > 1795000000000 (repo floor) and > 1797000000000 (017). ✔

## Replacement + rollout invariants

- **Transactional whole-set swap (FR-010, RBD-7)**: one transaction per document:
  `DELETE FROM document_embeddings WHERE doc_id = $1` then INSERT the complete new
  set (chunks + preambles together). No partial states are ever visible.
- **Legacy continuity (FR-011, SC-012)**: rows with `embedded_text IS NULL` are
  pre-018 fixed-window chunks; they keep serving the semantic leg (their
  `embedding` is over `chunk_text`) and never match the chunk-keyword leg
  (`search_vector IS NULL`). The boot repair selects documents owning any such
  row and re-chunks them best-effort at the existing concurrency cap.
- **Preamble lifecycle (FR-012/RBD-7)**: `preamble_text` is written iff the
  pass's chunk set has ≥2 chunks and generation succeeded for that chunk;
  single-chunk passes write NULL and make zero contextualizer calls.
