# Implementation Plan: Structure-Aware Search Chunking, Selective Contextual Preambles, and a First-Class Evaluation Harness

**Branch**: `018-search-chunking-and-eval` | **Date**: 2026-07-18 | **Spec**: [spec.md](spec.md)

**Input**: Feature specification from `/specs/018-search-chunking-and-eval/spec.md`

**Design ground truth**: `design/content-search.md`, section "Chunking, context, and evaluation (amendment, Sam, 2026-07-18 — feature 018)" **including the Addition paragraph "titles join the embedded text" (Sam, 2026-07-18)**, which postdates the spec and is folded into this plan as a requirement (design wins — Constitution VI). Recorded in the ledger as DR-1.

## Summary

Replace the fixed 6000-char/500-overlap window chunker with a structure-aware chunker (heading-boundary splits, ~600-token target, per-chunk `heading_path`), add selective LLM-generated contextual preambles (multi-chunk documents only), make every chunk's embedded text begin with its heading trail **headed by the document title** (design Addition DR-1), and re-port the search evaluation harness (metrics, variant sweep, curated long-tail eval set with a saturation guard) from the reference-only `rag-search-v2` branch onto main. The doc-level RRF response shape, authorization pre-filter, and snippet provenance are frozen invariants. Feature 017 (hash gating, per-chunk model id, updatedAfter) lands first and is consumed, with one design-ratified amendment: the re-embed hash input expands to cover the title.

**Technical approach** (details in [research.md](research.md)): extend `document_embeddings` in place (no new table — RBD-2 decision D1) with `heading_path`, `preamble_text`, `embedded_text`, `token_estimate`, and a per-chunk `search_vector` (GIN-indexed) in migration slot `1798000000000`. The indexer chunks via a re-ported `server/search/chunker.js` consuming main's existing `toStructured()` serialization, generates preambles via a re-ported `server/search/contextualizer.js` through the provider registry (gemini-2.5-flash, the `getCompactionModel()` idiom), composes `embedded_text = title>heading_path header + preamble + chunk text`, and swaps each document's whole chunk set transactionally. The keyword leg gains a chunk-level tsvector union (preamble terms retrievable) while the doc-level FTS row keeps producing snippets and baseline ranking. Legacy fixed-window rows keep serving until a background best-effort re-chunk (extended `reindexStale()`) migrates them. The eval harness lives at `server/search/eval/` behind one npm script, shares the search config surface with the app, and sweeps old-chunking/new-chunking/preambles-on-off (+ optional flagged reranker, default off).

## Technical Context

**Language/Version**: Node.js 22+ (CommonJS, matching `server/`)

**Primary Dependencies**: Express, Yjs, `ai` SDK + `@ai-sdk/google` (embeddings + structured generation, already in use), pg / node-pg-migrate, sanitize-html. No new dependencies.

**Storage**: PostgreSQL + pgvector (existing `document_search_index`, `document_embeddings` tables; HNSW + GIN indexes). Migration slot **1798000000000** (feature 017 holds 1797…; floor is 1795000000000).

**Testing**: Jest (`server/__tests__/`), serial only (shared DB — Constitution II). Eval harness is NOT CI-blocking (RBD-6); its metric functions get ordinary unit tests.

**Target Platform**: Linux server (Minikube app-dev pod for development; k3s hardened cluster in prod)

**Project Type**: Web application (backend-only feature; zero client changes)

**Performance Goals**: Idle indexing cost zero on unchanged content (017 gate, SC-007); preamble generation amortized — document sent once per batch, ≤⌈chunks/25⌉ LLM calls per document (RBD-4); search latency unchanged (no new query stages by default; reranker stays off).

**Constraints**: Chunking deterministic (FR-006) — no LLM in the chunk-boundary path; preambles best-effort, never blocking (FR-016); API/MCP response shapes byte-frozen (FR-019); authorization share-join pre-filter on every retrieval path (FR-021); search never goes dark during rollout (SC-012).

**Scale/Scope**: Beta corpus (hundreds of docs, <5K chunks); eval set ≥40 queries (RBD-5). ~10 source files touched/created on the server, 1 migration, ~8 test files (new + extended).

**Feature 017 integration**: 017's plan/data-model did not exist when this plan was authored (parallel agents; its plan.md is still the unfilled template). Alignment is against 017's spec: hash stored on the `document_search_index` row (017 FR-002), model id written per chunk row (017 FR-009), model-mismatch repair in `reindexStale()` (017 FR-010). Exact symbol/column names are adopted from 017's merged implementation at implement time — flagged in tasks as integration points, not re-invented here. The one deliberate 018 amendment to 017 behavior: hash input becomes title + body text (DR-1); 017's title-excluded hash is correct until 018 lands, per the design Addition's own corollary.

## Constitution Check

*GATE: evaluated against Constitution v1.1.1 before Phase 0; re-checked after Phase 1 design.*

| Principle | Status | Notes |
|---|---|---|
| I. Documentation Reflects Reality | PASS (task-gated) | README search section + `docs/dev.md` gain the chunking/preamble/eval-harness reality in the same effort (Polish tasks). `design/content-search.md` already states the target design; no design amendment needed beyond what exists. |
| II. Test-Backed Changes | PASS | Tests-first tasks for chunker, composition, hash, contextualizer, transactional swap, retrieval freeze, rollout, metrics, saturation guard. Backend Jest serial. No serialization/format change → round-trip suite untouched (the chunker only *reads* `toStructured`). |
| III. Trunk-Based Solo Workflow | PASS | Feature branch via the pipeline; no new ceremony. Eval harness is an operator tool, not a gate (RBD-6, FR-029). |
| IV. Collaboration-Safe Document Operations | PASS | Read-only consumption of Yjs docs through the existing serialization layer; zero document mutation; no format-registry change. |
| V. Secure by Default | PASS | Preambles are LLM output derived from untrusted document content: stored as inert text, schema-constrained at generation (`generateObject` string array), never executed, never rendered as document content (FR-018/RBD-3), and only retrievable through the share-join pre-filter (FR-021). No new endpoints, no new ingestion surface. Snippet sanitization allowlist unchanged. |
| VI. Design Docs Are Ground Truth | PASS | Plan converges code to the ratified 018 amendment; the post-spec "titles join the embedded text" Addition is folded in as design-ratified (ledger DR-1), not re-litigated. RBD-1…8 govern everything the amendment left open. |

**Technology & Architecture Constraints**: provider behavior stays in the registry (`server/api/chat-models.js` `getProvider` — used for the preamble model, D6); schema change via node-pg-migrate (D1); no new markdown/serialization dependency (chunker consumes the in-house `toStructured`). PASS.

**Post-Phase-1 re-check**: no violations introduced; Complexity Tracking empty.

## Project Structure

### Documentation (this feature)

```text
specs/018-search-chunking-and-eval/
├── plan.md              # This file
├── research.md          # Phase 0 — decisions D1–D13
├── data-model.md        # Phase 1 — chunk record, eval-set schema, config surface
├── quickstart.md        # Phase 1 — validation guide
├── contracts/
│   ├── chunk-record.md           # Durable chunk data contract (FR-008) + migration shape
│   ├── search-response-freeze.md # Frozen API/MCP retrieval contract (FR-019..022)
│   ├── eval-harness.md           # CLI contract, eval-set JSON schema, saturation guard
│   └── search-config.md          # Shared app/eval configuration surface (FR-026)
└── tasks.md             # Phase 2 (/speckit-tasks)
```

### Source Code (repository root)

```text
migrations/
└── 1798000000000_chunk-structure-columns.js   # NEW — extend document_embeddings (D1)

server/
├── search-indexer.js          # MODIFIED — structure-aware pipeline, embedded-text
│                              #   composition, title-in-hash, preamble gating,
│                              #   transactional swap, legacy re-chunk in reindexStale()
├── search.js                  # MODIFIED — chunk-keyword union in FTS leg (D4);
│                              #   semantic leg reads embedded-text vectors (no shape change)
└── search/
    ├── config.js              # NEW — shared search-config surface (re-port, adapted)
    ├── chunker.js             # NEW — structure-aware chunker (re-port, adapted)
    ├── contextualizer.js      # NEW — batched preamble generation (re-port, adapted)
    ├── reranker.js            # NEW — optional flagged variant, default OFF (re-port)
    └── eval/
        ├── metrics.js         # NEW — pure metric functions (re-port)
        ├── run-eval.js        # NEW — one-command sweep runner (re-port, adapted)
        ├── check-eval-set.js  # NEW — composition + saturation-guard checker
        └── eval-set.json      # NEW — curated long-tail set (versioned)

server/__tests__/
├── search-config.test.js          # NEW — config surface resolution, rerank default off
├── search-chunker.test.js         # NEW — determinism, boundaries, packing, oversize,
│                                  #   tiny sections, overlap, no-headings, pathological
├── search-embedded-text.test.js   # NEW — title+heading_path composition, hash scope
├── search-contextualizer.test.js  # NEW — batching, iff-multi-chunk, best-effort
├── search-indexer.test.js         # MODIFIED — pipeline integration, transactional swap,
│                                  #   RBD-7 transitions, rollout continuity
├── search.test.js                 # MODIFIED — contract freeze, preamble-term retrieval,
│                                  #   snippet provenance, auth probe
└── search-eval-metrics.test.js    # NEW — metric unit tests + saturation-guard rule

package.json                       # MODIFIED — "search:eval", "search:eval:check" scripts
README.md, docs/dev.md             # MODIFIED — Principle I updates
```

**Structure Decision**: single-project backend layout, mirroring the reference branch's `server/search/` module directory (which does not exist on main yet) so re-ported components land in their intended long-term home. No client changes.

## Architecture Decisions (summary — full rationale in research.md)

- **D1 (RBD-2) Storage layout**: extend `document_embeddings` in place with nullable columns; NO new table. Legacy rows are distinguished by `embedded_text IS NULL`. One table keeps the semantic CTE, transactional per-doc swap, HNSW index, and 017's model-repair machinery unchanged, and makes rollout continuity (FR-011/SC-012) a non-event.
- **D2 Embedded text is stored, not recomputed**: `embedded_text` column holds exactly what was embedded + FTS-indexed (header line + optional preamble + chunk text) — inspectable, testable, and the tsvector derives from it in SQL.
- **D3 (DR-1, design-ratified) Title heads the embedded text**: header line = `[title, ...heading_path].join(' > ')`, present on every chunk (even single-chunk/empty-trail docs). Corollary: the 017 hash input expands to `title + '\n' + bodyText` so a title change busts the re-embed gate; preambles remain excluded (FR-015 intact).
- **D4 (RBD-8) Keyword topology**: per-chunk `search_vector` over `embedded_text`, GIN-indexed; the FTS leg becomes doc-level-index ∪ chunk-level matches (score = greatest rank), snippets still exclusively from `document_search_index.content_text` via `ts_headline` (FR-018/FR-020). Doc-level index row retained as-is.
- **D5 (RBD-1) Chunker semantics**: re-port of the v2 chunker (heading flush at ≥50% fill, sentence-boundary splitting of oversize sections, hard split last resort, ~12% sentence overlap, chars/4 token estimate), knobs lifted into the config surface so the eval can sweep them. Deterministic by construction.
- **D6 (RBD-4) Preamble generation**: `getProvider('google')('gemini-2.5-flash')` via the chat-models registry (the `getCompactionModel()` idiom); document sent once per batch of ≤25 chunks, doc capped at 120K chars; schema-constrained string-array output; failures → absent preambles.
- **D7 (RBD-2) Rollout**: `reindexStale()` gains a legacy-scheme predicate (doc owns rows with `embedded_text IS NULL`); re-chunk rides the existing boot repair (concurrency 5, best-effort). Because the hash input changes (D3), the hash gate cannot false-skip legacy docs.
- **D8 (RBD-6) Harness**: `server/search/eval/`, `npm run search:eval`, requires live key + populated corpus, never in CI; metrics are pure functions with unit tests.
- **D9 (RBD-5) Eval set**: versioned JSON committed at `server/search/eval/eval-set.json`; `check-eval-set.js` audits composition minimums offline and evaluates the saturation guard from sweep output.
- **D10 (FR-030) Reranker**: re-ported behind `SEARCH_RERANK` flag, **default off** (the branch's default-on is deliberately flipped); exposed to the sweep as an explicitly flagged variant.
- **D11 Serialization entry**: main already exports fragment-level `toStructured()` (wrapping `toStructuredNode`) with compatible node shapes (`type`, numeric `level`, `content` string/array, `children`) — verified against `server/mcp/yjs/serialization.js:778/:922`. Adaptation risk is low; a fixture test pins the consumed shape.
- **D12 Baseline variant**: the legacy fixed-window `chunkText()` is retained (exported, no longer used by the live pipeline) solely so the eval can re-index the "old chunking" baseline variant honestly.
- **D13 Determinism scope**: FR-006 binds the chunker (texts, heading paths, ordinals). Preamble text is model-generated and inherently non-deterministic — it lives outside the chunk-identity contract and outside the hash (FR-015), so determinism tests compare chunk sets with preambles disabled and separately assert preamble *placement* rules.

## Complexity Tracking

> No Constitution Check violations — table intentionally empty.

| Violation | Why Needed | Simpler Alternative Rejected Because |
|-----------|------------|-------------------------------------|
| — | — | — |
