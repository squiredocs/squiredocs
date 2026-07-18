# Data Model — 018-search-chunking-and-eval

Storage decisions per research.md D1–D4. One migration: `1798000000000_chunk-structure-columns.js`.

## Chunk (extended `document_embeddings` row)

One row per chunk of a document's extracted text. Replaced as a whole set, per
document, in one transaction (FR-010). Legacy fixed-window rows coexist until
background re-chunk (FR-011); discriminator below.

| Column | Type | New? | Meaning / rules |
|---|---|---|---|
| `id` | SERIAL PK | existing | — |
| `doc_id` | UUID FK → documents ON DELETE CASCADE | existing | document reference (FR-008) |
| `chunk_index` | INTEGER, `UNIQUE(doc_id, chunk_index)` | existing | ordinal within document (FR-008) |
| `chunk_text` | TEXT NOT NULL | existing | raw document-authored chunk text — the ONLY source for semantic-hit excerpts (FR-018) |
| `heading_path` | TEXT[] NULL | **new** | ordered h1→…→hN trail at chunk start; `'{}'` for unheaded content; NULL ⇒ legacy row |
| `preamble_text` | TEXT NULL | **new** | 1–3 generated situating sentences; NULL when absent (single-chunk doc, generation failure, legacy row). Never shown as document content (RBD-3) |
| `embedded_text` | TEXT NULL | **new** | exactly the text embedded + chunk-keyword-indexed: `header + '\n' + (preamble ? preamble + '\n\n' : '') + chunk_text` where `header = [title, ...heading_path].join(' > ')` (DR-1). **NULL ⇒ legacy fixed-window row** (rollout discriminator, D7) |
| `token_estimate` | INTEGER NULL | **new** | `ceil(len(embedded_text)/4)` — used by recall@token-budget costing |
| `search_vector` | TSVECTOR NULL | **new** | `to_tsvector('english', embedded_text)`; feeds the chunk-keyword leg (D4). NULL on legacy rows (they never match the chunk leg) |
| `embedding` | VECTOR(1536) | existing | vector of `embedded_text` (new rows) / of `chunk_text` (legacy rows) |
| `embedding_model` | VARCHAR(100) | existing | written explicitly per 017 FR-009 |
| `created_at`/`indexed_at` | per existing schema | existing | — |

**New index**: `CREATE INDEX idx_embeddings_search_vector_gin ON document_embeddings USING GIN (search_vector);` (transactional — no HNSW involved).

**Validation rules**
- New-scheme rows: `heading_path`, `embedded_text`, `token_estimate`, `search_vector` all non-NULL; `embedded_text` begins with the title-headed header line.
- `preamble_text` non-NULL ⇒ the document's chunk set for that pass had ≥2 chunks (FR-012, enforced by the write path, asserted by SC-003 tests).
- Whole-set replacement: DELETE all rows for `doc_id` + INSERT new set inside one transaction (existing pattern, kept).

**State transitions**
- *Legacy → new*: background re-chunk (extended `reindexStale()`) re-runs the per-doc pipeline; the transactional swap replaces legacy rows.
- *Multi ↔ single chunk* (RBD-7): rule evaluated per indexing pass on the produced set; preambles appear/disappear with the swap; no stale preamble can survive.
- *Empty document*: zero chunk rows (delete-only swap); FTS row maintained; hash advances per 017 FR-007.

## Document search index row (`document_search_index`) — unchanged schema, one semantic change

- Columns unchanged by 018 (017 adds the content-hash column in slot 1797…).
- **Hash input changes (DR-1)**: from `bodyText` to `title + '\n' + bodyText`.
  Storage, gating, and advance-only-on-success semantics stay 017's.
- `content_text` remains the only snippet source (`ts_headline`) — FR-018/FR-020.

## Eval query / Curated eval set (`server/search/eval/eval-set.json`)

```json
{
  "version": "1",
  "date": "2026-07-18",
  "corpus": "operator-dev",
  "queries": [
    { "id": "q001", "query": "…", "type": "paraphrase", "relevantDocIds": ["<uuid>"] },
    { "id": "q002", "query": "…", "type": "multi-doc",  "relevantDocIds": ["<uuid>", "<uuid>"] },
    { "id": "q003", "query": "…", "type": "no-answer",  "relevantDocIds": [] }
  ]
}
```

- `type` ∈ `paraphrase | multi-doc | no-answer | keyword` (FR-027; `keyword` = sanity-floor filler).
- Composition minimums (RBD-5): ≥40 total; ≥12 paraphrase; ≥6 multi-doc (each with ≥2 relevantDocIds); ≥6 no-answer (empty relevantDocIds).
- No-answer queries excluded from averaged recall/MRR/nDCG; scored by the no-answer rule (FR-024, US4-2).
- Versioned: any content change bumps `version`; before/after tables cite it (SC-010).

## Variant (eval + shipped configuration — FR-026)

Named, reproducible configuration resolved by `getSearchConfig(overrides)`:

| Knob | Env | Default | Swept by minimum sweep? |
|---|---|---|---|
| `chunking` | — (eval override only) | `structure` | yes (`fixed` = baseline) |
| `preambles` | `SEARCH_PREAMBLES` | `on` | yes |
| `rerank` | `SEARCH_RERANK` | **`off`** (FR-030) | optional, explicitly flagged |
| `chunkTargetTokens` | `SEARCH_CHUNK_TOKENS` | 600 | optional |
| `headingFillRatio` | — | 0.5 | optional |
| `overlapRatio` | — | 0.12 | optional |
| `distanceThreshold` | existing option | 0.5 | no |

Minimum sweep (FR-025): `fixed` → `structure+preambles:off` → `structure+preambles:on`.

## Metric report (harness output)

One row per variant: `Recall@5, Recall@10, Recall@20, MRR, nDCG@10, recall@token-budget`
over answerable queries; `no-answer accuracy` + query counts alongside; emitted as a
printed table AND a JSON file (`eval-results.<timestamp>.json`, git-ignored) consumed by
`check-eval-set.js` for the saturation guard and by promotion notes for SC-010.
