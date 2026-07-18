# Feature Specification: Structure-Aware Search Chunking, Selective Contextual Preambles, and a First-Class Evaluation Harness

**Feature Branch**: `018-search-chunking-and-eval`

**Created**: 2026-07-18

**Status**: Draft

**Input**: User description: "018-search-chunking-and-eval — Structure-aware chunking with selective contextual preambles + first-class search eval harness"

**Design ground truth**: `design/content-search.md`, section **"Chunking, context, and evaluation (amendment, Sam, 2026-07-18 — feature 018)"** (RATIFIED). That section IS the design; its pins are cited throughout as Sam-ratified and are not re-decided here. This feature builds on the two feature-017 amendments in the same document (incremental hash gating + per-chunk embedding-model id; recency pre-filter), which are specced in parallel and land FIRST.

## Overview

Content search today splits every document into fixed 6000-character windows with 500-character overlap (`server/search-indexer.js:64-72`, `chunkText`) before embedding. The windows are structure-blind: they cut across headings, sections, and sentences, produce oversized (~1500-token) chunks, and carry no information about where in the document a chunk came from. A chunk from deep inside a long document ("Rollback procedure" under "Deployment" under "Operations Runbook") is embedded as bare text that never mentions any of that context, so conceptual and paraphrased queries miss it. Meanwhile the retrieval-quality tooling that could measure any of this lives only on the abandoned `rag-search-v2` branch — 525 commits behind main, kept strictly as a reference — and the one evaluation ever run used an LLM-drafted eval set that **saturated**: every variant scored Recall@5/10/20 = 1.0, and the LLM reranker *lowered* MRR while costing ~5.7 s/query. An eval that cannot tell variants apart proves nothing.

This feature converges the code to the ratified design amendment, in two coupled parts:

1. **Indexing quality.** Chunking becomes structure-aware: documents split along heading boundaries into roughly 600-token chunks, each carrying its `heading_path` (the h1→…→hN trail in effect where the chunk starts). Multi-chunk documents additionally get a short LLM-written **contextual preamble** per chunk — 1–3 situating sentences that are embedded *and* keyword-indexed together with the chunk, so queries can match on context the bare chunk text never contained. Single-chunk documents get **none**: they self-situate, and skipping them eliminates most contextualizer cost (the Liz refinement the earlier `rag-search-v2` branch missed). The 017 content hash that gates re-embedding covers only extracted document text, never generated preambles. The doc-level RRF response shape is preserved — chunk hits roll up to documents, and the API and MCP contracts do not move.

2. **Measurement.** The search evaluation harness becomes a first-class citizen on main — re-ported (never merged) from the `rag-search-v2` branch: Recall@k / MRR / nDCG / recall@token-budget metrics, a variant-sweep runner, and a **curated long-tail eval set** (paraphrased/conceptual, multi-doc, and no-answer queries) replacing the saturated LLM-drafted set. **Decision (Sam, 2026-07-18, ratified in the amendment)**: the chunking/preamble work is built now, with the eval measuring it before/after — measurement informs tuning rather than gating the build. The LLM reranker stays off by default (the prior eval showed it lowered MRR at ~5.7 s/query on this corpus); it remains a flag pending curated-eval evidence.

Open decisions the amendment did not answer were taken with the best default and recorded as **RATIFIED-BY-DEFAULT (Sam pre-authorized, 2026-07-18)** in [clarifications-needed.md](clarifications-needed.md) (RBD-1…RBD-8), per Constitution Principle VI.

## User Scenarios & Testing *(mandatory)*

The "users" of this feature are: humans typing into the document-list search box, external agents searching via the MCP `list_documents` tool (both consume the same content-search results), the in-app assistant retrieving context, and Sam as the operator who tunes retrieval and needs trustworthy measurements.

### User Story 1 - Finding the buried section: structure-aware chunks (Priority: P1)

As a user (or agent) searching for something discussed in one section deep inside a long document, I get that document back near the top of my results — because the index now stores coherent, section-shaped chunks that know which headings they live under, instead of arbitrary 6000-character windows that slice sections and sentences apart.

**Why this priority**: This is the core retrieval-quality change of the amendment. Chunk boundaries are the highest-leverage indexing decision: a chunk that mixes the tail of one section with the head of the next embeds as a muddle of both topics and matches neither query well. Long, structured documents (runbooks, design docs, meeting-notes compilations) are exactly the documents where search matters most.

**Independent Test**: Can be tested in isolation by indexing a corpus with the new chunker (preambles disabled) and inspecting the stored chunks: boundaries fall on heading boundaries, sizes cluster near the target, each chunk carries the correct heading trail — then running semantic searches for section-specific concepts and verifying the containing documents rank.

**Acceptance Scenarios**:

1. **Given** a long document with a heading hierarchy, **When** it is indexed, **Then** its chunks split along heading boundaries into roughly 600-token pieces, and each chunk carries the h1→…→hN heading trail in effect where the chunk starts.
2. **Given** a single section whose body alone exceeds the chunk target, **When** it is indexed, **Then** the section is split at sentence boundaries into multiple chunks that all carry that section's heading trail.
3. **Given** a run of many tiny sections, **When** they are indexed, **Then** adjacent sections are packed into a shared chunk rather than producing dozens of fragment chunks.
4. **Given** a short document whose entire content fits within the chunk target, **When** it is indexed, **Then** it produces exactly one chunk.
5. **Given** a document with no headings at all, **When** it is indexed, **Then** it still chunks (by size at sentence boundaries) with an empty heading trail — structure-awareness degrades gracefully, never fails.
6. **Given** the same document content indexed twice (or on two instances), **When** the stored chunks are compared, **Then** they are identical — same texts, same heading trails, same ordering (chunking is deterministic).

---

### User Story 2 - Chunks that explain themselves: selective contextual preambles (Priority: P1)

As a user (or agent) whose query uses the document's framing ("the Q3 launch checklist", "the incident postmortem") rather than a chunk's literal words, I still find the right document — because each chunk of a multi-chunk document carries a short generated preamble situating it in its parent document, and that preamble is searchable by both engines. My short single-chunk documents are left alone: they already say what they are.

**Why this priority**: Contextual enrichment is the amendment's second retrieval pin and the reason chunk-level context loss stops hurting recall. The multi-chunk-only rule is an explicit ratified refinement: it concentrates spend exactly where context is actually lost and eliminates most contextualizer cost on a corpus dominated by short documents.

**Independent Test**: Index a mixed corpus and verify: every chunk of every multi-chunk document has a 1–3 sentence preamble (where generation succeeded); no single-chunk document has any preamble; a query matching only preamble vocabulary (not chunk text) retrieves the document through both the keyword and semantic paths.

**Acceptance Scenarios**:

1. **Given** a multi-chunk document, **When** it is indexed with generation available, **Then** every one of its chunks stores a preamble of 1–3 situating sentences.
2. **Given** a single-chunk document, **When** it is indexed, **Then** no preamble is generated or stored for it, and no contextualizer call is made for it.
3. **Given** a chunk whose preamble contains a term that appears nowhere in the chunk's own text, **When** a user searches for that term, **Then** the containing document is retrievable via keyword matching and via semantic matching.
4. **Given** preamble generation fails (API error, missing key, malformed output), **When** the document is indexed, **Then** all its chunks are indexed and searchable without preambles — a missing preamble never blocks indexing or search.
5. **Given** an indexed document whose content has not changed (017 content hash unchanged), **When** it is re-persisted (formatting churn, cursor-only session), **Then** no preambles are regenerated — preamble generation rides the 017 re-embed gate and never triggers on its own.
6. **Given** search results whose relevance came from a preamble, **When** the user sees the result snippet, **Then** the snippet shows document-authored text, never generated preamble text presented as document content.

---

### User Story 3 - One command, one metric table: the eval harness on main (Priority: P2)

As the operator tuning search, I run a single command on main and get a per-variant table of retrieval metrics (Recall@5/10/20, MRR, nDCG@10, recall@token-budget, no-answer accuracy) comparing at minimum the old chunking against the new chunking, and preambles on vs off — so every retrieval change from now on is quantified instead of vibed.

**Why this priority**: The amendment makes the harness a first-class citizen precisely so measurement stops living on a dead branch. It is P2 only because the ratified decision says measurement informs tuning rather than gating the build — the chunking work (P1) ships on its own merits; this story is what proves and tunes it.

**Independent Test**: On a checkout of main with a populated corpus and the curated eval set, run the one npm command and verify it prints the metric table across the required variants without any code from the `rag-search-v2` branch being merged.

**Acceptance Scenarios**:

1. **Given** a checkout of main, **When** the operator runs the documented npm script, **Then** it evaluates every query in the eval set and prints a table with one row per variant and one column per metric (Recall@5, Recall@10, Recall@20, MRR, nDCG@10, recall@token-budget), with no-answer accuracy reported separately.
2. **Given** the variant sweep, **When** it runs, **Then** it covers at minimum: the old fixed-window chunking (baseline), the new structure-aware chunking without preambles, and the new chunking with preambles — and can additionally sweep the reranker as an explicitly flagged variant.
3. **Given** the harness and the running application, **When** a variant is evaluated, **Then** the harness exercises the same search configuration surface the application uses — what is measured is what ships.
4. **Given** the eval requires index-time changes (re-chunking, preambles on/off), **When** a sweep needs them, **Then** the harness can re-index the corpus per variant as part of the run.

---

### User Story 4 - An eval set that can say no: the curated long-tail set (Priority: P2)

As the operator, I evaluate against a curated eval set containing paraphrased/conceptual queries, multi-document queries, and no-answer queries — a set hard enough that variants score differently on it — replacing the saturated LLM-drafted set on which every variant scored a perfect 1.0.

**Why this priority**: The prior eval's saturation is the documented reason this feature mandates curation: a set where every variant aces Recall@k cannot detect improvement or regression. Without this story, Story 3's table is a row of indistinguishable 1.0s.

**Independent Test**: Inspect the committed eval set for the required composition; run the sweep and verify the results discriminate between variants per the documented definition.

**Acceptance Scenarios**:

1. **Given** the curated eval set committed on main, **When** its composition is audited, **Then** it meets the documented minimums for paraphrased/conceptual, multi-document, and no-answer queries, and every query record carries its type and its expected relevant documents (empty for no-answer).
2. **Given** a no-answer query, **When** it is evaluated, **Then** it is scored by the no-answer rule (correct = returning nothing) and excluded from the recall/MRR/nDCG averages rather than polluting them.
3. **Given** the full sweep over the curated set, **When** results are in, **Then** the set discriminates per the documented saturation guard — and if it does not, that is treated as an eval-set defect to fix by adding harder queries, not as evidence that all variants are equal.

---

### User Story 5 - Measured before and after (Priority: P3)

As the operator, I get a published before/after comparison for this feature itself: the metric table for the old pipeline and for the new pipeline on the same curated set, recorded in the feature's promotion notes — informing tuning and honestly documenting what the change bought, without gating the build.

**Why this priority**: The ratified decision explicitly subordinates measurement to the build ("built now … measurement informs tuning rather than gating"). It is still a named deliverable of this feature, not optional.

**Independent Test**: The promotion notes contain both metric tables (or one combined table) from the same eval-set version, with the variant configurations identified.

**Acceptance Scenarios**:

1. **Given** the feature is ready to promote, **When** the promotion notes are written, **Then** they include the before/after metric comparison produced by the harness on the curated set, identifying eval-set version and variant configurations.
2. **Given** the comparison shows a regression on some metric, **When** promotion is considered, **Then** the result informs tuning and is documented — it does not automatically block the feature (ratified decision), but it must not be hidden.

---

### Edge Cases

- **Empty or whitespace-only document**: produces zero chunks; the full-text index row is still maintained; search never errors on it.
- **Document with no headings**: chunks by size at sentence boundaries with an empty heading trail (US1 scenario 5).
- **Pathological unbroken text** (one enormous "sentence"/token run with no sentence punctuation): the chunker still terminates and produces bounded-size chunks via hard splitting; determinism holds.
- **Document shrinks from multi-chunk to single-chunk** (or grows 1→2): the next content-changing reindex applies the rule for the new chunk count — preambles disappear (or appear) then; no special machinery, no stale preamble surviving on a now-single-chunk document (RBD-7).
- **Preamble generation partially fails** (some chunks in a batch get preambles, others error): succeeded preambles are kept, failed ones are simply absent; the document is fully searchable either way (FR-016).
- **Embedding succeeds but preamble generation is unavailable** (e.g. generation model unconfigured): chunks index with embeddings of bare chunk text; keyword search covers chunk text; nothing blocks.
- **Reindex racing a live search**: chunk replacement stays transactional — a query sees the complete old chunk set or the complete new one, never a half-replaced document (FR-010).
- **Legacy chunks from the old fixed-window scheme**: continue to serve search results until the background re-chunk replaces them; search never goes dark during rollout (FR-011, RBD-2).
- **Heading-only edits**: heading text is part of extracted document text, so the 017 hash changes and the document re-chunks — heading trails stay accurate.
- **Eval run without semantic search available** (no API key): the harness fails fast with a clear message rather than silently measuring fulltext-only and mislabeling it.
- **Eval query whose expected document has been deleted from the corpus**: the harness reports it (skipped/degraded) rather than silently scoring an impossible query as a miss.

## Requirements *(mandatory)*

### Functional Requirements

**Chunking (replaces the fixed-window scheme — ratified)**

- **FR-001**: The system MUST split each document's extracted text into chunks along heading boundaries, targeting roughly 600 tokens per chunk, replacing the fixed 6000-character/500-overlap windows entirely. [Sam-ratified]
- **FR-002**: Every chunk MUST carry a `heading_path`: the ordered h1→…→hN heading trail in effect at the chunk's start (empty for content before any heading or in unheaded documents). [Sam-ratified]
- **FR-003**: A single section whose content exceeds the chunk target MUST be split at sentence boundaries into multiple chunks sharing that section's heading trail; hard character splitting is permitted only as a last resort for text with no sentence boundaries.
- **FR-004**: Sections smaller than the target MUST be packed together into shared chunks; a heading boundary forces a new chunk only once the current chunk has reached a documented minimum fill (default: half the target — RBD-1), so tiny sections do not fragment the index.
- **FR-005**: A document whose entire extracted text fits within the chunk target MUST produce exactly one chunk.
- **FR-006**: Chunking MUST be deterministic: identical extracted document content and configuration MUST always yield the identical chunk set (same texts, heading paths, and ordering), on any instance, with no dependence on time, randomness, or external services.
- **FR-007**: Adjacent chunks MAY carry a small deterministic sentence-boundary overlap (bounded at ~12% of the target — RBD-1) so sentences straddling a boundary remain retrievable; overlap MUST never push a chunk materially past the target size.

**Chunk record — durable data contract (storage layout is a plan decision; the contract is not)**

- **FR-008**: Each stored chunk MUST durably carry: its document reference, its ordinal position within the document, its chunk text, its `heading_path`, its contextual preamble when one exists (absent otherwise), its embedding, and the embedding model identifier per feature 017's per-chunk model rule. Whether this extends `document_embeddings` or introduces a new table is decided at plan time (RBD-2); the fields above are the contract either way.
- **FR-009**: The schema change MUST ship as a migration in slot `1798000000000` (satisfying the repository constraint that new migrations exceed `1795000000000`).
- **FR-010**: Replacing a document's chunks MUST remain transactional: search queries see either the complete previous chunk set or the complete new one, never a partial state.
- **FR-011**: Documents indexed under the old fixed-window scheme MUST be re-chunked under the new scheme via a background, best-effort, concurrency-capped process (in the spirit of the existing stale-reindex repair); until a document is re-chunked, its old chunks MUST continue to serve search (RBD-2).

**Contextual preambles (selective — ratified)**

- **FR-012**: Preambles MUST be generated only for documents that chunk into two or more chunks; single-chunk documents MUST receive none and MUST incur zero contextualizer calls. [Sam-ratified — the Liz refinement]
- **FR-013**: A preamble MUST be 1–3 sentences situating its chunk within its parent document, generated from the document's overall content (title + text, size-capped) together with the specific chunk and its heading trail (RBD-4).
- **FR-014**: Each preamble MUST be both embedded with its chunk and keyword-indexed with its chunk, such that a query term appearing only in the preamble can retrieve the containing document through the semantic engine AND through keyword matching. [Sam-ratified; observable contract per RBD-8]
- **FR-015**: The feature-017 content hash MUST cover only extracted document text and MUST NOT incorporate generated preambles; preamble (re)generation MUST occur only as part of a hash-triggered re-embed — never on its own schedule. [Sam-ratified]
- **FR-016**: Preamble generation MUST be best-effort: any failure (per chunk, per batch, or total) leaves the affected chunks indexed and fully searchable without preambles, and MUST NOT block or fail indexing or search.
- **FR-017**: Preamble generation cost MUST be bounded: the parent document's content is sent once per document (batched across its chunks, amortizing document tokens), document input is size-capped, and the number of generation calls per document is bounded (RBD-4).
- **FR-018**: Generated preamble text MUST NOT appear in user-visible search snippets or anywhere it could be mistaken for document-authored content; snippets MUST come from document text (RBD-3).

**Retrieval (contracts frozen — ratified)**

- **FR-019**: Chunk-level relevance MUST roll up to document-level results: the response remains one entry per document with the existing fields, ordering semantics, and pagination; the API and MCP `list_documents` response shapes MUST NOT change in any way. [Sam-ratified]
- **FR-020**: Snippet and highlight behavior MUST be preserved: keyword hits keep highlighted snippets sanitized to the existing allowlist; semantic-only hits keep a plain text excerpt (from document text — FR-018).
- **FR-021**: The authorization invariant MUST be unchanged: every retrieval path pre-filters to the requesting user's accessible documents (share join) BEFORE ranking; chunk-level retrieval MUST NOT introduce any path that ranks or scores content the user cannot access.
- **FR-022**: Existing fallback and mode behavior MUST be unchanged: automatic fulltext fallback when embeddings or the embedding API are unavailable, and the hybrid/fulltext/semantic mode selection, all work as today.

**Evaluation harness (first-class on main — ratified)**

- **FR-023**: The evaluation harness MUST live on main and be runnable with a single documented npm script that produces a per-variant metric table; it MUST be re-ported against main's current code — the `rag-search-v2` branch is reference-only and MUST NOT be merged. [Sam-ratified]
- **FR-024**: The harness MUST compute at minimum: Recall@5, Recall@10, Recall@20, MRR, nDCG@10, and recall@token-budget over answerable queries, plus no-answer accuracy reported separately (no-answer queries excluded from the averaged metrics).
- **FR-025**: The harness MUST support variant sweeps covering at minimum: old fixed-window chunking (baseline) vs new structure-aware chunking, and preambles on vs off — including performing the per-variant re-indexing an index-time comparison requires. The reranker MAY be swept as an explicitly flagged extra variant.
- **FR-026**: The harness and the running application MUST share one search-configuration surface, so an evaluated variant is exactly reproducible as a shipped configuration.
- **FR-027**: The curated eval set MUST be committed on main in a documented format where each query carries: the query text, its type (at minimum distinguishing paraphrased/conceptual, multi-document, and no-answer), and its expected relevant document references (empty for no-answer). Minimum composition per RBD-5.
- **FR-028**: The eval set MUST include a documented **saturation guard**: a stated definition of "the set discriminates" (RBD-5) that the curated set is checked against; a set that fails to discriminate is a defect in the set. This replaces the saturated LLM-drafted set. [Sam-ratified]
- **FR-029**: A before/after measurement of this feature's own changes (old pipeline vs new, same eval-set version) MUST be produced with the harness and published in the feature's promotion notes. Measurement informs tuning and MUST NOT gate the build. [Sam-ratified decision]
- **FR-030**: The LLM reranker MUST remain off by default and controllable only via its flag; this feature MUST NOT change that default. [Sam-ratified]

### Key Entities

- **Chunk**: A contiguous, structure-aligned piece of one document's extracted text. Carries: document reference, ordinal, text, `heading_path` (ordered heading trail), optional preamble, embedding, embedding model id (017). Replaced as a set, transactionally, when its document re-embeds.
- **Heading path**: The ordered list of ancestor heading texts (h1→…→hN) in effect at a chunk's start; empty when no headings precede the chunk. Derived purely from document structure.
- **Contextual preamble**: 1–3 generated sentences situating a chunk in its parent document. Exists only on chunks of multi-chunk documents; indexed (embedded + keyword) with the chunk; never part of the content hash; never shown as document content; absent on failure.
- **Eval query**: One entry in the eval set — query text, type (paraphrased/conceptual | multi-doc | no-answer | other), expected relevant document references (empty for no-answer).
- **Curated eval set**: The versioned, committed collection of eval queries meeting the composition minimums and the saturation guard; the successor to the saturated draft set.
- **Variant**: A named, reproducible search configuration (chunking scheme, preambles on/off, reranker flag, tuning knobs) evaluated by the sweep runner — expressible identically as a shipped configuration (FR-026).
- **Metric report**: The harness's output table — one row per variant, columns Recall@5/10/20, MRR, nDCG@10, recall@token-budget, with no-answer accuracy and query counts alongside.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: **Chunker determinism** — chunking the same document content twice (including on different instances) yields byte-identical chunk sets: same texts, same heading paths, same ordinals, 100% of the time across the test corpus.
- **SC-002**: **Structure alignment** — on a structured test corpus, every chunk's heading path exactly matches the document's heading hierarchy at the chunk's start, and no chunk except last-resort splits (FR-003) crosses a qualifying heading boundary mid-chunk.
- **SC-003**: **Preambles present iff multi-chunk** — after indexing a mixed corpus with generation available: 100% of multi-chunk documents' chunks carry preambles; 0% of single-chunk documents carry any preamble; contextualizer calls for single-chunk documents = 0.
- **SC-004**: **Zero response-shape change** — the full existing API/MCP search contract test suite passes unchanged; a field-level diff of search responses before vs after the feature (same corpus, same queries) shows identical response structure.
- **SC-005**: **Preamble-only terms retrieve** — for a seeded set of chunks whose preambles contain terms absent from chunk text, queries on those terms retrieve the containing documents via both the keyword and semantic paths.
- **SC-006**: **Resilience** — with preamble generation forcibly failing, 100% of documents still index successfully and remain retrievable by keyword and semantic search; zero indexing errors surface to users.
- **SC-007**: **Idle cost is zero** — re-persisting an unchanged document (017 hash unchanged) triggers zero embedding calls and zero preamble-generation calls.
- **SC-008**: **One-command eval** — on main, a single documented command runs the full curated set and prints the complete metric table (all FR-024 metrics, all FR-025 minimum variants) with no manual steps in between.
- **SC-009**: **The set discriminates** — the curated eval set satisfies the composition minimums (RBD-5) and the documented saturation guard: the minimum variant sweep does NOT reproduce the all-1.0 saturation of the prior draft set.
- **SC-010**: **Before/after published** — the feature's promotion notes contain the harness-produced old-vs-new comparison on the same eval-set version, with variant configurations identified.
- **SC-011**: **Authorization holds** — existing search-authorization tests pass unchanged, and a chunk-level probe (user searching terms present only in an unshared document's chunks/preambles) returns zero results for that document.
- **SC-012**: **No dark search during rollout** — while legacy fixed-window chunks are being re-chunked in the background, search on not-yet-migrated documents keeps returning results (old chunks serve until replaced).

## Assumptions

- **Feature 017 lands first** (per the pipeline plan): this spec consumes 017's content-hash gating and per-chunk embedding-model id as existing behavior; it does not re-specify them. If 018 reaches implementation before 017 merges, 018 is blocked on it.
- **A structured document representation exists on main** for the chunker to consume (the serialization layer already exposes structured nodes with headings/levels — `server/mcp/yjs/serialization.js` exports `toStructuredNode`; `server/search-indexer.js` currently uses only `toPlainText`). The v2 chunker's entry points must be adapted to main's current serialization API during re-porting; no new document parser is in scope.
- **"~600 tokens" is a target, not a hard cap**, measured by a consistent approximate tokenizer; exact token accounting against any specific model's tokenizer is not required (RBD-1).
- **The embedding pipeline stays as-is** (same embedding model family, dimensions, and vector store); this feature changes what gets embedded, not how embeddings are produced or stored at the infrastructure level.
- **Preamble generation uses an inexpensive large-context model** reachable through the application's existing AI-provider configuration; no new provider integration is in scope (RBD-4).
- **The eval harness runs against a real populated corpus** (the operator's dev/prod-like corpus) with the operator's credentials; it is an operator tool, not a user-facing feature, and is not part of the CI-blocking test suite (RBD-6).
- **Eval-set curation is a human act**: LLM drafting may assist, but the committed set is operator-curated (that is the lesson of the saturated draft set).

## Out of Scope

- **Turning the LLM reranker on by default** — it stays off, behind its flag (Sam-ratified; prior eval: lowered MRR at ~5.7 s/query). Re-evaluating it on the curated set is enabled by this feature but any default change is a future decision.
- **Merging the `rag-search-v2` branch** — it is 525 commits behind and stays reference-only; components are re-ported against main.
- **New search infrastructure** — no new vector database, search engine, or retrieval service; the existing Postgres FTS + pgvector + RRF architecture stays.
- **Feature 017's deliverables** (content-hash gating, per-chunk model id writing, model-mismatch repair, recency pre-filter) — consumed as prerequisites, not re-built here.
- **Any API/MCP contract change** — response shapes, parameters, and entry points do not move (the amendment pins this as an invariant, not just a non-goal).
- **Query-side changes** — no query rewriting, expansion, or new search modes.
- **UI changes** — the search box, result list, and snippet rendering are untouched.
- **Continuous/scheduled eval runs in CI** — the harness is on-demand; automation cadence is a future decision (RBD-6).
