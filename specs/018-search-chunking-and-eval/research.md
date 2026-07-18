# Phase 0 Research — 018-search-chunking-and-eval

All open Technical Context questions resolved. Sources: current code on `main`
(`server/search-indexer.js`, `server/search.js`, `server/mcp/yjs/serialization.js`,
`server/api/chat-models.js`, migration `1775501984000`), the reference-only
`rag-search-v2` branch (`git show rag-search-v2:server/search/…` — never merged),
the design amendment + Addition in `design/content-search.md`, the RBD ledger,
and feature 017's spec (its plan does not exist yet — parallel agent).

---

## D1 — Chunk storage layout (RBD-2): extend `document_embeddings` in place

- **Decision**: Migration `1798000000000` adds nullable columns to the existing
  `document_embeddings` table: `heading_path TEXT[]`, `preamble_text TEXT`,
  `embedded_text TEXT`, `token_estimate INTEGER`, `search_vector TSVECTOR`
  (+ GIN index on `search_vector`). No new table. A row with
  `embedded_text IS NULL` is a legacy fixed-window row.
- **Rationale**: FR-008's contract fields all fit as columns; the existing
  `UNIQUE(doc_id, chunk_index)`, HNSW index, FK cascade, and per-document
  DELETE+INSERT transaction are reused verbatim, so FR-010 (transactional swap)
  and SC-012 (legacy rows keep serving) hold with zero query-topology change —
  the semantic CTE keeps reading one table whether a doc is migrated or not.
  017's model-repair machinery (which scans `document_embeddings.embedding_model`)
  continues to work untouched.
- **Alternatives considered**:
  - *New `document_chunks` table* (the branch's approach): the branch needed
    parallel v1/v2 tables to A/B two live pipelines; on main there is exactly one
    pipeline, so a second table would force either dual-table UNION CTEs during
    rollout or a dark-search cutover, plus an eventual data migration and table
    drop. Rejected as pure added complexity for this repo's converge-don't-flag
    model.
  - *Scheme-marker column* (`chunk_scheme`): redundant — `embedded_text IS NULL`
    is a complete, index-friendly legacy discriminator; documented in the
    contract instead of stored twice.

## D2 — Store the composed `embedded_text`

- **Decision**: The exact text that gets embedded and chunk-keyword-indexed is
  composed once in the indexer and persisted in `embedded_text`; the per-chunk
  tsvector is computed from it in SQL at insert
  (`to_tsvector('english', embedded_text)`).
- **Rationale**: SC-005 verification, eval debugging, and the RBD-8 observable
  contract all need to see what was actually indexed; recomputing on read would
  scatter the composition rule across query paths and break if preambles or
  titles changed out from under stored vectors. `chunk_text` keeps the raw
  document-authored text so semantic-hit excerpts (`LEFT(chunk_text, 300)`)
  remain provenance-safe (FR-018) without any query change.
- **Alternatives considered**: composing at query time (rejected: vectors are
  already baked from the composed text — the stored copy must be the authority);
  overloading `chunk_text` with the composed text (rejected: would leak preamble
  text into semantic-hit excerpts, violating FR-018/RBD-3).

## D3 — Titles join the embedded text + hash expansion (DR-1, design-ratified)

- **Decision**: Every chunk's `embedded_text` begins with a header line
  `[documentTitle, ...headingPath].join(' > ')` — the title always leads, even
  when `heading_path` is empty and even for single-chunk documents. Composition:
  `header + '\n' + (preamble ? preamble + '\n\n' : '') + chunkText`. The 017
  content-hash input expands from body text to `title + '\n' + bodyText` so a
  title-only change busts the re-embed gate from 018 onward. Preambles stay out
  of the hash (FR-015).
- **Rationale**: This is the design Addition (Sam, 2026-07-18) in
  `design/content-search.md` — it postdates the spec, and design wins
  (Constitution VI). Titles are currently keyword-weight-A but never embedded,
  so conceptual title matches leak through the semantic leg; putting the title
  at the head of every embedded chunk closes that. The hash corollary is stated
  in the Addition itself; without it a title change would leave stale embedded
  text behind the gate forever. Ledgered as DR-1 in `clarifications-needed.md`.
- **Interaction with 017**: 017's FR-001/CN-1 deliberately exclude the title and
  the Addition confirms that is correct *until 018 lands*. 018 therefore
  modifies the hash-input composition wherever 017 implements it (expected in
  `server/search-indexer.js`), keeping 017's storage, gating, and
  failure-does-not-advance semantics untouched. A deploy of 018 changes every
  stored hash's expected value — which is exactly right, because every document
  must re-chunk under the new scheme anyway (see D7).

## D4 — Keyword-index topology (RBD-8): chunk tsvector ∪ doc-level index

- **Decision**: The keyword leg (fulltext mode, and the FTS leg of hybrid)
  becomes the union of (a) the existing doc-level `document_search_index` match
  and (b) a per-chunk match over `document_embeddings.search_vector`, collapsed
  to one row per doc with score `GREATEST(doc_rank, best_chunk_rank)`. Both
  sub-selects carry the `document_shares` join (and, post-017, the
  `updatedAfter` condition). Snippets come only from
  `ts_headline('english', si.content_text, …)` exactly as today; a doc reached
  only via a preamble term gets the headline function's leading-text excerpt of
  document content — never preamble text.
- **Rationale**: Satisfies all four RBD-8 constraints with the smallest surface:
  preamble-only terms retrieve via keyword (FR-014/SC-005), snippets stay
  document-authored (FR-018/FR-020), auth pre-filter on every path (FR-021),
  doc-level RRF shape unchanged (FR-019). Retaining the doc-level index keeps
  title weight-A ranking and snippet quality identical for all existing queries.
- **Alternatives considered**: dropping the doc-level index and going chunk-only
  FTS (rejected: loses title weighting and high-quality `ts_headline` snippets,
  changes ranking for every existing query — needless contract risk); indexing
  preamble text into the doc-level row (rejected: `content_text` is also the
  snippet source, so preamble text could surface as document content — direct
  FR-018 violation).

## D5 — Chunker semantics (RBD-1): re-port the v2 chunker, knobs in config

- **Decision**: Re-port `rag-search-v2:server/search/chunker.js` semantics as
  `server/search/chunker.js`: flatten `toStructured()` output into blocks tagged
  with the heading stack; a heading forces a flush only when the current chunk
  is ≥ `headingFillRatio` (default 0.5) full; blocks exceeding the char target
  pre-split at sentence boundaries (regex `(?<=[.!?])\s+`), hard character
  split only for sentence-less runs; adjacent chunks get trailing-sentence
  overlap bounded at `overlapRatio` (default 0.12) of the target; tokens
  estimated as `ceil(chars / 4)`; target `chunkTargetTokens` default 600. All
  three knobs live in the config surface (D8/FR-026) so the eval can sweep them.
- **Rationale**: RBD-1 pins exactly these semantics as the ratified default —
  they are the already-reasoned implementation of the amendment's "~600-token
  heading-boundary chunks with small overlap". Pure string/array computation,
  no time/randomness/IO → FR-006 determinism by construction.
- **Alternatives considered**: exact model tokenizers (rejected per RBD-1 —
  vendor coupling for no measurable gain); zero overlap (rejected — FR-007
  permits and the branch's boundary-straddle rationale stands; the eval can
  sweep it to 0 later).

## D6 — Preamble generation (RBD-4): registry model, batched-once shape

- **Decision**: Re-port `contextualizer.js` as `server/search/contextualizer.js`:
  model obtained via `getProvider('google')('gemini-2.5-flash')` from
  `server/api/chat-models.js` (the same registry path `getCompactionModel()`
  uses — cheap, 1M context); `generateObject` with a strict
  `{contexts: string[]}` JSON schema; document (title + extracted text, capped
  at 120K chars) sent once per batch of ≤25 chunks; per-batch try/catch → failed
  batches yield empty preambles; prompt adapted to ask for 1–3 sentences
  (FR-013; the branch said 1–2). The **indexer** enforces the multi-chunk-only
  gate (FR-012): the contextualizer is simply never called for a 1-chunk set,
  and defensively returns `[]`/empty strings for empty input or a missing key.
- **Rationale**: RBD-4 pins the batched-once shape and the registry constraint
  (Constitution: provider behavior lives in one place). Gating in the indexer
  keeps "zero contextualizer calls for single-chunk docs" (SC-003) a trivially
  testable property of one call site.
- **Alternatives considered**: a new `getContextualizerModel()` helper in
  chat-models.js — adopted as the concrete implementation form (a named export
  beside `getCompactionModel()`), keeping the model id out of search code;
  per-chunk prompts (rejected per RBD-4 — multiplies document tokens by chunk
  count).

## D7 — Legacy rollout (RBD-2): ride `reindexStale()`

- **Decision**: `reindexStale()`'s selection query gains one predicate: docs
  owning at least one `document_embeddings` row with `embedded_text IS NULL`
  (legacy scheme). Selected docs flow through the normal per-document pipeline
  (concurrency 5, `Promise.allSettled` best-effort). The migration itself does
  no re-embedding. Until a doc is re-chunked its old rows keep serving both
  legs (their `search_vector` is NULL → they simply don't participate in the
  new chunk-keyword sub-select).
- **Rationale**: RBD-2 pins exactly this shape ("same shape as the existing
  reindexStale() boot repair"); embedding + preamble calls have no place in a
  migration (precedent: the original search migration backfilled tsvector
  only). D3's hash-input change means legacy docs can never be false-skipped by
  the 017 gate (their stored hash, if any, was computed body-only). After full
  migration the predicate matches nothing → zero repeat work.
- **Alternatives considered**: a one-shot backfill script (rejected: RBD-2
  pins the boot-repair shape; a script is a second code path to maintain);
  synchronous migration re-embed (rejected: external API calls in a migration,
  and search would go dark — SC-012).

## D8 — Config surface (FR-026): `server/search/config.js`

- **Decision**: Re-port `config.js` adapted to main: one `getSearchConfig(overrides)`
  resolving env + defaults for `{ preambles (SEARCH_PREAMBLES, default on),
  rerank (SEARCH_RERANK, default off), chunkTargetTokens (SEARCH_CHUNK_TOKENS,
  600), headingFillRatio (0.5), overlapRatio (0.12), chunking
  ('structure' | 'fixed', default 'structure' — 'fixed' exists for the eval
  baseline only), distanceThreshold (0.5) }`. The indexer and `search.js` read
  it; the eval harness passes `overrides` — one surface, so what is measured is
  what ships.
- **Rationale**: FR-026 verbatim. The branch file already implements the
  pattern; dropped knobs that main's pipeline doesn't have (denseTopN etc. —
  main's doc-level RRF is frozen by FR-019, so those knobs would be dead
  config), added the chunking-scheme and preamble knobs 018 actually sweeps.
- **Alternatives considered**: env-only (rejected: per-variant re-index inside
  one eval process needs programmatic overrides); a JSON config file (rejected:
  nothing else in the repo works that way).

## D9 — Eval set format + saturation guard (RBD-5): committed JSON + offline checker

- **Decision**: `server/search/eval/eval-set.json`:
  `{ version, date, corpus: "operator-dev", queries: [{ id, query, type:
  "paraphrase" | "multi-doc" | "no-answer" | "keyword", relevantDocIds: [] }] }`.
  Composition minimums (≥40 total, ≥12 paraphrase/conceptual, ≥6 multi-doc,
  ≥6 no-answer) audited offline by `check-eval-set.js` (no API needed; exits
  non-zero on violation). The saturation guard (RBD-5: not-all-1.0 on
  Recall@5/10/20 AND some primary-metric pair-delta ≥ 0.03 across the minimum
  sweep) is evaluated by the same checker over `run-eval`'s emitted JSON
  results, and printed in the sweep summary. LLM drafting may assist authoring,
  but the committed set is operator-curated (spec assumption); the before/after
  promotion notes record the set version.
- **Rationale**: RBD-5 pins format, minimums, and the discrimination
  definition; splitting the composition audit (offline, cheap, could even be a
  unit test) from the guard (needs sweep results) keeps CI free of API
  dependencies (RBD-6) while making SC-009 mechanically checkable.
- **Alternatives considered**: reusing the branch's `gen-eval-set.js` draft
  generator as a committed tool (rejected as a deliverable: the saturated
  LLM-drafted set is the documented failure this feature replaces; drafting
  assistance doesn't need committed tooling).

## D10 — Reranker (FR-030): re-port behind a flag, default OFF

- **Decision**: Re-port `reranker.js` as `server/search/reranker.js` (registry
  model, fails soft to first-stage order), wired only where the flag enables
  it, `SEARCH_RERANK` default **off** — flipping the branch's default-on. The
  sweep may include it as an explicitly flagged extra variant (`--rerank`).
- **Rationale**: FR-030 forbids changing the off-default; FR-025 wants it
  sweepable, which requires the code to exist on main. The prior eval's finding
  (lowered MRR, ~5.7 s/query) is the reason for the default.
- **Alternatives considered**: not porting it at all (rejected: "remains a flag
  pending curated-eval evidence" — the design keeps re-evaluation enabled, and
  the sweep variant needs an implementation).

## D11 — Serialization entry point: main's `toStructured()` suffices

- **Decision**: The chunker consumes `toStructured(xmlFragment)` from
  `server/mcp/yjs/serialization.js` (line 778 — it exists on main and wraps
  `toStructuredNode` per node). Node shape consumed: `{ type, level?, content?
  (string | array of string|{text}), children? }` — verified compatible with
  the branch chunker's `flattenBlocks`/`structuredText` expectations (heading
  `level` is parsed to a number at `serialization.js:939`). A fixture test pins
  the consumed shape so serializer evolution can't silently break chunking.
- **Rationale**: The spec's assumption flagged `toStructured` vs
  `toStructuredNode` as an adaptation risk; inspection shows main exports
  *both*, with the fragment-level `toStructured` being exactly what the branch
  chunker imports — the re-port needs no new parser and only defensive shape
  handling (e.g., table cells' simplified string content, void nodes).
- **Alternatives considered**: chunking markdown output (rejected: would need a
  heading re-parser; structured nodes already carry levels); a bespoke
  extraction walk (rejected: duplicates the registry-driven serializer,
  Constitution IV's single-registry rule).

## D12 — "Old chunking" baseline variant

- **Decision**: Keep the legacy `chunkText()` fixed-window function exported
  from `search-indexer.js` (or moved beside the new chunker), used by the live
  pipeline **never**, and by the eval harness only when re-indexing the
  `chunking: 'fixed'` baseline variant (FR-025). Baseline rows are written
  through the same new-schema writer (with `heading_path = '{}'`, no preamble,
  `embedded_text = chunk text` without the title header — faithfully
  reproducing the old pipeline's embedded content).
- **Rationale**: An honest before/after (FR-029/SC-010) requires actually
  reproducing the old index-time behavior, including its bare body-text
  embeddings; synthesizing it from the new chunker would measure the wrong
  thing.
- **Alternatives considered**: replaying from a pre-018 git checkout (rejected:
  unmanageable in one command; FR-025 requires the harness to do per-variant
  re-indexing itself).

## D13 — Determinism scope (FR-006 vs preambles)

- **Decision**: Determinism is a chunk-identity contract: texts, heading paths,
  ordinals — asserted by double-chunking fixtures and comparing byte-identical
  output. Preamble text (LLM output) is outside chunk identity, outside the
  hash (FR-015), and outside determinism claims; tests assert preamble
  *placement* invariants (present-iff-multi-chunk, replaced-with-set) instead
  of content equality. `embedded_text` is deterministic given a fixed preamble
  input (pure composition — unit-tested with injected preambles).
- **Rationale**: SC-001 requires byte-identical chunk sets; an LLM in that loop
  would be unfixable. The spec's own entity model ("Chunk … optional preamble")
  separates the two, and RBD-7's whole-set replacement makes placement, not
  content, the invariant.

---

## Best-practice / integration notes (no open questions remain)

- **Gemini batch limit**: `embedMany` batches stay ≤100 texts (existing code);
  chunk counts per doc rarely exceed ~20 at 600-token targets.
- **`ts_headline` on non-matching text** returns the leading `MinWords` of the
  document — acceptable and provenance-safe for preamble-only keyword hits
  (documented in the search-response-freeze contract).
- **GIN index creation** is transactional (unlike HNSW) — migration 1798 needs
  no `noTransaction` escape; the existing HNSW index is reused (the `embedding`
  column is untouched).
- **Jest serial discipline** (Constitution II / memory): all new tests run in
  the single serial backend suite; no test launches concurrent DB access.
- **`updatedAfter` (017)**: the new chunk-keyword sub-select must include the
  same `d.updated_at` condition 017 adds to sibling CTEs — an implement-time
  integration point called out in tasks, since 017's SQL does not exist yet.
