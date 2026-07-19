# Tasks: Structure-Aware Search Chunking, Selective Contextual Preambles, and a First-Class Evaluation Harness

> **T004 — 017 alignment facts (recorded 2026-07-18, against merged main `0dcaef8`)**
>
> - **Hash column**: `content_hash` on `document_search_index` (migration `1797000000000_add-content-hash-to-search-index.js`). Advanced ONLY inside the chunk-swap transaction (`generateAndStoreEmbeddings`) or the empty-doc cleanup (`cleanupEmptyDocument`); the FTS upsert reads it back via `RETURNING content_hash`.
> - **Seam (CN-7)**: `buildEmbedHashInput(extractedText)` at `server/search-indexer.js:70` — identity on body text in 017; the gate consumes ONLY `computeContentHash(buildEmbedHashInput(...))` (compute call site `indexDocument`, plus the default-param in `generateAndStoreEmbeddings`). 018 changes the seam signature to `buildEmbedHashInput(title, extractedText)` → `title + '\n' + extractedText` (DR-1); gate logic untouched.
> - **`generateAndStoreEmbeddings(docGuid, contentText, contentHash = computeContentHash(buildEmbedHashInput(contentText)))`**: no-key early return BEFORE any DB write (CN-4); `chunkText` → `embedMany` batches of 100; DELETE+INSERT+`UPDATE … SET content_hash` in one transaction. External caller: `server/scripts/backfill-search-index.js:88` (passes `(doc_id, contentText)` only — must be updated for the new signature).
> - **Model repair predicate** in `reindexStale()`: `EXISTS (SELECT 1 FROM document_embeddings de WHERE de.doc_id = d.id AND de.embedding_model IS DISTINCT FROM $1)` OR'd with missing-row/edit-stale; concurrency 5 via slice + `Promise.allSettled`. In-pass model-staleness override probe also lives in `indexDocument` (hash-match branch).
> - **`updatedAfter` SQL shape**: `buildRecencyJoin(docIdExpr, paramIdx)` in `server/search.js:64` emits `JOIN documents rd ON rd.id = <expr> AND rd.updated_at > $N`, applied inside each engine CTE (fts, top_chunks). The new chunk-keyword sub-select must carry the same fragment.
> - **Plan-assumption deltas found**: (1) tasks.md T010 said hash tests live in `search-embedded-text.test.js` "targeting 017's hash function" — correct, but note two EXISTING 017 tests assert the title-EXCLUDED hash (`search-indexer-gating.test.js` case 2 "title-only change → zero provider calls", case 7 "title-independent hash", and the seam unit test "identity on body text") — these are deliberately amended by 018 per DR-1's corollary, not regressions. (2) The hash is stored on `document_search_index` (017 FR-002 as assumed) — no delta. (3) `toStructured(xmlFragment)` exists and is exported at `server/mcp/yjs/serialization.js:778` as plan D11 assumed — no delta.

**Input**: Design documents from `/specs/018-search-chunking-and-eval/`

**Prerequisites**: plan.md, spec.md, research.md (D1–D13), data-model.md, contracts/, quickstart.md

**Tests**: REQUIRED and tests-first — the spec's SCs and the pipeline mandate explicit test coverage (determinism, preamble rules, hash scope, transactional swap, contract freeze, rollout continuity, metrics, saturation guard). Backend Jest runs **serially** (Constitution II) — never launch concurrent backend runs.

**Hard dependency**: Feature **017 must be merged first** (hash gating, per-chunk model id, `reindexStale` model repair, `updatedAfter`). Tasks marked `[017-align]` adopt 017's actual symbol/column names at implement time. 017's artifacts were unwritten when these tasks were authored — re-verify T004 before starting Phase 2.

**Organization**: Phases by user story (US1 chunking P1, US2 preambles P1, US3 harness P2, US4 eval set P2, US5 before/after P3), after Setup + Foundational.

## Format: `[ID] [P?] [Story] Description with exact file path`

---

## Phase 1: Setup

- [X] T001 Create `server/search/` module directory and `server/search/config.js` implementing the shared config surface exactly per `contracts/search-config.md` (`getSearchConfig(overrides)`: chunking/preambles/rerank/chunkTargetTokens/headingFillRatio/overlapRatio/distanceThreshold; env parsing; **SEARCH_RERANK default false**). Reference: `git show rag-search-v2:server/search/config.js` (adapt — drop denseTopN/sparseTopN/rrfK/fusedTopN/rerankKeep; the doc-level RRF is frozen).
- [X] T002 [P] Add npm scripts to `package.json`: `"search:eval": "node server/search/eval/run-eval.js"` and `"search:eval:check": "node server/search/eval/check-eval-set.js"`; add `server/search/eval/eval-results.*.json` to `.gitignore`.
- [X] T003 [P] Unit tests for the config surface in `server/__tests__/search-config.test.js`: env parsing, override precedence, rerank default **off**, defaults match `contracts/search-config.md` table.
- [X] T004 Verify 017 integration points on merged main and record them at the top of this file as a dated note: hash column name + hash-compute call site in `server/search-indexer.js`, model-repair predicate in `reindexStale()`, `updatedAfter` SQL condition shape in `server/search.js`. `[017-align]` — if 017 is not merged, STOP (spec Assumption: 018 is blocked on 017).

**Checkpoint**: config surface exists and is tested; 017 alignment facts recorded.

---

## Phase 2: Foundational (blocking all stories)

- [X] T005 Migration `migrations/1798000000000_chunk-structure-columns.js` per `contracts/chunk-record.md`: add nullable `heading_path TEXT[]`, `preamble_text TEXT`, `embedded_text TEXT`, `token_estimate INTEGER`, `search_vector TSVECTOR` to `document_embeddings`; GIN index `idx_embeddings_search_vector_gin`; symmetric `down`. No backfill, no `noTransaction`. Verify slot ordering (> 1797000000000, > 1795000000000 floor; `script/migrate.js` phantom-008 cleanup already handles checkOrder).
- [X] T006 Migration test in `server/__tests__/search-indexer.test.js` (or existing migration-check pattern): after migrate, legacy-shaped inserts (only doc_id/chunk_index/chunk_text/embedding) still succeed with the new columns NULL — proves legacy rows and the rollout discriminator (`embedded_text IS NULL`) work.

**Checkpoint**: schema in place; legacy rows representable. User stories can begin.

---

## Phase 3: User Story 1 — Structure-aware chunks (P1) 🎯 MVP

**Goal**: heading-boundary ~600-token chunks with title-headed heading paths, deterministic, transactional, rollout-safe. **Independent test**: index a corpus with preambles disabled; inspect stored chunks per quickstart §2; run section-concept searches.

### Tests first (write, watch fail)

- [X] T007 [P] [US1] Chunker unit tests in `server/__tests__/search-chunker.test.js` against `chunkStructured(nodes, opts)` with hand-built structured-node fixtures: (a) heading-boundary splits with correct h1→…→hN `headingPath` (SC-002); (b) oversize single section splits at sentence boundaries, shared trail (FR-003); (c) tiny-section packing — heading flushes only at ≥ headingFillRatio fill (FR-004); (d) short doc → exactly one chunk (FR-005); (e) unheaded doc → size/sentence chunking with `[]` trails (US1-5); (f) pathological unbroken text → bounded hard splits, terminates (edge case); (g) **determinism** — chunk twice, byte-identical texts/paths/ordinals (FR-006/SC-001); (h) overlap: deterministic trailing-sentence overlap ≤ overlapRatio×target, never materially past target (FR-007); (i) knob sweep — different targetTokens/fillRatio/overlapRatio still deterministic (RBD-1).
- [X] T008 [P] [US1] Serialization-shape fixture test in `server/__tests__/search-chunker.test.js` (same file, separate describe): build a real Yjs doc (headings with levels, paragraphs, list, table, code block, image), run `toStructured()` → `chunkStructured()`; pins the consumed node shape (plan D11) so serializer drift breaks loudly.
- [X] T009 [P] [US1] Embedded-text composition tests in `server/__tests__/search-embedded-text.test.js`: header line `[title, ...headingPath].join(' > ')` leads every chunk — including single-chunk and empty-trail docs (DR-1); preamble injected between header and chunk text with the contract separators; composition is pure/deterministic given fixed inputs; `chunk_text` never contains header or preamble.
- [X] T010 [P] [US1] Hash-scope tests in `server/__tests__/search-embedded-text.test.js`: hash input = title + '\n' + bodyText — title-only change changes the hash (DR-1); body change changes it; **preamble content never affects it** (FR-015); identical title+body ⇒ identical hash. `[017-align]` target 017's hash function.
- [X] T011 [US1] Indexer integration tests in `server/__tests__/search-indexer.test.js`: (a) `indexDocument` writes new-scheme rows — heading_path, embedded_text (title-headed), token_estimate, search_vector, embedding_model all populated (FR-008/FR-009); (b) whole-set transactional replacement — inject an INSERT failure mid-swap, assert the complete OLD set still serves (FR-010, RBD-7); (c) re-persist with unchanged title+body ⇒ zero embedding calls (017 gate intact, SC-007); (d) empty doc ⇒ zero chunk rows, FTS row maintained (edge case).
- [X] T012 [US1] Rollout-continuity tests in `server/__tests__/search-indexer.test.js`: seed legacy rows (`embedded_text IS NULL`); (a) semantic search still returns those docs (SC-012); (b) extended `reindexStale()` selects exactly docs owning legacy rows (plus time/model-stale per 017) and re-chunks them; (c) after migration of all docs, a second `reindexStale()` does zero chunking work (FR-011).

### Implementation

- [X] T013 [US1] Create `server/search/chunker.js`: re-port from `git show rag-search-v2:server/search/chunker.js` (`chunkStructured`, `flattenBlocks`, `structuredText`, `splitLongText`, `trailingOverlap`, `estimateTokens`), adapted to: import `toStructured` from `server/mcp/yjs/serialization.js`; take targetTokens/headingFillRatio/overlapRatio from `getSearchConfig` values passed by the caller (no direct env reads); export CHARS_PER_TOKEN. Make T007/T008 pass.
- [X] T014 [US1] Add `buildEmbeddedText({ title, headingPath, preamble, chunkText })` (in `server/search/chunker.js`) implementing the DR-1 composition from `contracts/chunk-record.md`. Make T009 pass.
- [X] T015 [US1] Rewrite the indexing pipeline in `server/search-indexer.js`: extract title + `toStructured` nodes; expand the 017 hash input to title + '\n' + bodyText `[017-align]`; chunk via `chunkStructured`; compose `embedded_text` per chunk; embed `embedded_text` (not bare chunk text); transactional DELETE+INSERT writing all new columns incl. `search_vector = to_tsvector('english', $embedded_text)` and explicit `embedding_model`; keep legacy `chunkText()` exported but unused by the live path (plan D12). Make T010/T011 pass (preamble wiring arrives in US2 — pipeline passes `preambles: off` equivalent until then).
- [X] T016 [US1] Extend `reindexStale()` in `server/search-indexer.js` with the legacy-scheme predicate (`EXISTS (SELECT 1 FROM document_embeddings de WHERE de.doc_id = d.id AND de.embedded_text IS NULL)`) OR'd with 017's staleness conditions `[017-align]`; same concurrency cap and `Promise.allSettled` best-effort shape. Make T012 pass.
- [X] T017 [US1] Regression gate: run the full serial backend suite (`npm run test:server`) — existing `search.test.js` / `search-indexer.test.js` / `search-indexer-privacy.test.js` assertions must pass unchanged apart from deliberate additions (SC-004 baseline).

**Checkpoint**: US1 independently testable per quickstart §2 (preambles off). MVP.

---

## Phase 4: User Story 2 — Selective contextual preambles (P1)

**Goal**: multi-chunk docs get 1–3-sentence preambles embedded AND keyword-indexed; single-chunk docs get none; failures never block; snippets stay document-authored. **Independent test**: quickstart §3.

### Tests first

- [X] T018 [P] [US2] Contextualizer unit tests in `server/__tests__/search-contextualizer.test.js` (mock the `ai` SDK / provider): (a) batching — doc sent once per ≤25-chunk batch, doc text capped at 120K chars (FR-017/RBD-4); (b) best-effort — one batch fails ⇒ its chunks get empty preambles, others keep theirs (FR-016, US2 edge); (c) total failure / missing key ⇒ all-empty, no throw; (d) output aligned to chunk order and count, non-strings coerced to empty; (e) model obtained via the chat-models registry, not inline (Constitution constraint).
- [X] T019 [US2] Indexer preamble-gating tests in `server/__tests__/search-indexer.test.js`: (a) multi-chunk doc ⇒ every row has `preamble_text` (SC-003); (b) single-chunk doc ⇒ `preamble_text IS NULL` AND the contextualizer mock was **never called** (FR-012, zero-call assertion); (c) preamble generation failure ⇒ chunks indexed and searchable without preambles (SC-006); (d) RBD-7 transitions — doc shrinks multi→single: re-index leaves a single row with NULL preamble (no stale preamble); grows single→multi: preambles appear same pass; (e) 017-gate ride-along: unchanged title+body re-persist ⇒ zero contextualizer calls (US2-5, SC-007).
- [X] T020 [US2] Retrieval tests in `server/__tests__/search.test.js`: (a) SC-005 — seed a chunk whose `preamble_text`/`embedded_text` contains a term absent from `chunk_text` and from `document_search_index.content_text`; fulltext mode retrieves the doc (chunk-keyword leg) and semantic mode retrieves it (mock/seeded vectors); (b) FR-018 — the returned snippet for that hit contains NO preamble text (document-text excerpt only); (c) SC-011 auth probe — a second user without a share on that doc gets zero rows for the same preamble-only term in every mode; (d) SC-004 freeze — response field set and pagination shape byte-identical to the pre-018 contract for a fixed seeded corpus.

### Implementation

- [X] T021 [US2] Create `server/search/contextualizer.js`: re-port from `git show rag-search-v2:server/search/contextualizer.js`, adapted: prompt asks for **1–3** situating sentences (FR-013); model via a new named export `getContextualizerModel()` added to `server/api/chat-models.js` (beside `getCompactionModel()`, same `getProvider('google')('gemini-2.5-flash')` idiom — plan D6); keep `generateObject` string-array schema, ≤25-chunk batches, 120K-char doc cap, per-batch fail-soft. Make T018 pass.
- [X] T022 [US2] Wire preambles into `server/search-indexer.js`: when `getSearchConfig().preambles` and chunk count ≥ 2, call `contextualizeChunks` BEFORE the swap transaction; store `preamble_text` per chunk and compose it into `embedded_text` via `buildEmbeddedText`; chunk count < 2 ⇒ no call, NULL preamble. Make T019 pass.
- [X] T023 [US2] Extend the keyword leg in `server/search.js` per `contracts/search-response-freeze.md` D4: fulltext CTE and hybrid FTS leg become doc-level match ∪ chunk-level `de.search_vector @@ websearch_to_tsquery` match (share join + role condition on BOTH sub-selects; `updatedAfter` condition on both once 017's SQL is in `[017-align]`), one row per doc, `GREATEST` rank, snippet still exclusively `ts_headline` over `si.content_text`. Semantic-leg excerpt stays `LEFT(chunk_text, 300)`. Make T020 pass.
- [X] T024 [US2] Full serial backend suite green (`npm run test:server`) — including `search-indexer-privacy.test.js` (no titles/queries in logs — verify new log lines comply).

**Checkpoint**: US1+US2 = complete new indexing pipeline, contracts frozen, quickstart §2–§3 verifiable.

---

## Phase 5: User Story 3 — Eval harness on main (P2)

**Goal**: one npm command → per-variant metric table; harness shares the config surface; re-indexes per variant. **Independent test**: quickstart §4 (needs key + corpus).

### Tests first

- [X] T025 [P] [US3] Metric unit tests in `server/__tests__/search-eval-metrics.test.js` with known-input fixtures: `recallAtK` (incl. null for empty relevant set), `reciprocalRank`, `ndcgAtK` (hand-computed DCG/IDCG case), `recallAtTokenBudget` (budget cutoff mid-list), `noAnswerCorrect`, `aggregate` (no-answer excluded from averages, reported separately — FR-024).

### Implementation

- [X] T026 [US3] Create `server/search/eval/metrics.js`: re-port from `git show rag-search-v2:server/search/eval/metrics.js` (pure functions, no I/O). Make T025 pass.
- [X] T027 [US3] Add eval re-indexing support to `server/search-indexer.js`: `reindexAllForEval(overrides)` — iterate all docs through the normal per-doc pipeline with `getSearchConfig(overrides)` (`chunking: 'fixed'` uses legacy `chunkText()` writing `heading_path='{}'`, no preamble, `embedded_text = chunk_text` — faithful old-pipeline reproduction per plan D12), sequential with the existing concurrency cap; **eval-only entry point, never called by the server** (FR-025).
- [X] T028 [US3] Create `server/search/eval/run-eval.js` per `contracts/eval-harness.md`: re-port from `git show rag-search-v2:server/search/eval/run-eval.js`, adapted to main — load `eval-set.json` (no draft fallback); default run = minimum sweep (fixed → structure/no-preambles → structure+preambles) with per-variant `reindexAllForEval`; `--rerank`, `--variant`, `--limit`, `--budget` flags; queries via `search.searchDocuments(userId, q, { mode: 'hybrid', limit: 20 })`; per-result token costs from stored `token_estimate` (fallback 600); fail fast without API key or when semantic search is unavailable; report deleted expected docs as skipped/degraded; print the FR-024 table AND write `eval-results.<timestamp>.json` (SC-008, FR-023/FR-026).
- [X] T029 [US3] Create `server/search/reranker.js`: re-port from `git show rag-search-v2:server/search/reranker.js` (registry model via `getProvider`, fail-soft), invoked from `server/search.js` ONLY when `getSearchConfig().rerank` is true (default off — FR-030); the sweep's `--rerank` variant exercises it. Add a `search.test.js` assertion that default-config search performs zero reranker calls.

**Checkpoint**: `npm run search:eval` produces the table on a populated corpus.

---

## Phase 6: User Story 4 — Curated eval set + saturation guard (P2)

**Goal**: committed, versioned, typed eval set meeting RBD-5 minimums with a mechanical discrimination check. **Independent test**: `npm run search:eval:check` offline; guard verdict from sweep results.

### Tests first

- [ ] T030 [P] [US4] Checker unit tests in `server/__tests__/search-eval-metrics.test.js` (separate describe): composition audit logic (passes at ≥40/≥12/≥6/≥6; fails when any minimum, multi-doc ≥2-refs rule, or no-answer empty-refs rule is violated) and saturation-guard rule (RBD-5: fails on all-1.0 Recall@5/10/20 across variants; fails when no primary-metric pair differs by ≥0.03; passes otherwise) — pure functions over fixture JSON.

### Implementation

- [ ] T031 [US4] Create `server/search/eval/check-eval-set.js`: no args ⇒ composition audit of `eval-set.json` (exit 1 + reasons on violation); with a results-JSON arg ⇒ saturation-guard verdict, phrased per FR-028 ("set defect — add harder queries", never "variants equal"). Export the pure check functions for T030.
- [ ] T032 [US4] Author `server/search/eval/eval-set.json` against the operator dev corpus: ≥40 queries (≥12 paraphrase/conceptual — no distinctive keyword overlap with target text; ≥6 multi-doc with ≥2 relevant refs; ≥6 no-answer with empty refs; keyword fillers), `version: "1"`, date, corpus tag, per data-model.md schema. LLM drafting may assist; the committed set is operator-curated (spec assumption) — flag Sam's curation sign-off in the promotion notes. Must pass `npm run search:eval:check`.

**Checkpoint**: set committed and audited; SC-009 verifiable once the sweep runs.

---

## Phase 7: User Story 5 — Before/after measurement (P3)

- [ ] T033 [US5] Run the minimum sweep on the operator dev corpus (`npm run search:eval`), then the guard check on the results file; if the guard fails, strengthen `eval-set.json` (bump version) and re-run — guard failure is a set defect, not a variant verdict (FR-028/SC-009).
- [ ] T034 [US5] Write the before/after comparison into `specs/018-search-chunking-and-eval/promotion-notes.md` (pipeline promotion artifact): the harness table for old vs new pipeline, eval-set version, variant configurations, any regressions documented openly (FR-029/SC-010, RBD-6), and the Sam sign-off item for eval-set curation (T032). Measurement informs tuning; it does not gate.

---

## Phase 8: Polish & Cross-Cutting

- [ ] T035 [P] Update `README.md` search section: structure-aware chunking, title-headed embedded text, selective preambles, eval harness commands, reranker flag default (Constitution I).
- [ ] T036 [P] Update `docs/dev.md`: how to run `search:eval` / `search:eval:check` in the dev pod, key/corpus prerequisites, serial-test reminder (Constitution I).
- [ ] T037 Design-doc conformance check: verify `design/content-search.md` (incl. the Addition) matches the built reality; if implementation falsified any documented mechanism, amend via the Squire doc + `node design/sync.mjs` — never hand-edit (Constitution VI).
- [ ] T038 Full verification: `npm run test:server` (serial) and `npm run test:client` green; quickstart §1–§5 spot-run; confirm zero response-shape drift (SC-004) and zero client changes.

---

## Dependencies & Execution Order

```
Phase 1 (T001–T004) ──► Phase 2 (T005–T006) ──► US1 (T007–T017) ──► US2 (T018–T024) ──► US3 (T025–T029) ──► US4 (T030–T032) ──► US5 (T033–T034) ──► Polish (T035–T038)
```

- **US1 → US2**: preamble composition and the chunk-keyword leg build on the US1 pipeline and `buildEmbeddedText`.
- **US2 → US3**: the sweep's `preambles on` variant needs US2; `reindexAllForEval` reuses the US1/US2 pipeline.
- **US3 → US4**: the saturation guard consumes sweep output (the composition audit alone only needs T031/T032).
- **US4 → US5**: before/after runs on the curated set.
- 017 must be merged before Phase 2 (T004 gate).

**Parallel opportunities**: within phases, `[P]` tasks touch different files (e.g. T007/T008/T009/T010 are four independent test files/describes; T002/T003 alongside T001-dependent work; T035/T036). Test *authoring* can parallelize; test *execution* stays serial (one backend run at a time).

## Implementation Strategy

MVP = Phase 1–3 (US1): the new chunker shipping alone already fixes structure-blind windows and title-blind embeddings, with rollout safety. US2 completes the P1 pair. US3–US5 are the measurement half — deliverable in the same branch, but each checkpoint is independently testable and revertible.

**Task count**: 38 total — Setup 4, Foundational 2, US1 11, US2 7, US3 5, US4 3, US5 2, Polish 4.
