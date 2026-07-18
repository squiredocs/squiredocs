# Implementation Plan: Search Index Efficiency

**Branch**: `017-search-index-efficiency` | **Date**: 2026-07-18 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `/specs/017-search-index-efficiency/spec.md`, design
ground truth `design/content-search.md` (2026-07-18 amendments "incremental gating" and
"recency pre-filter + entry-point corrections", plus the same-day Addition "titles join the
embedded text" — commit 7433c65), clarifications ledger CN-1..CN-7 (all
RATIFIED-BY-DEFAULT).

## Summary

Three surgical efficiency upgrades to content search, all inside the existing two-engine
(FTS + pgvector, RRF-fused) architecture:

1. **Content-hash gating** (`server/search-indexer.js`): each indexing pass fingerprints the
   extracted body text (SHA-256 over the output of a single seam function
   `buildEmbedHashInput` — 018's title expansion point) and skips embedding regeneration when
   the stored fingerprint matches; the hash advances only inside the chunk-swap transaction
   (or via the empty-doc cleanup path, which also fixes the latent ghost-chunks leak, CN-6).
2. **Model watermark + boot repair** (`server/search-indexer.js`): chunk inserts write
   `embedding_model` explicitly; `reindexStale()` additionally selects documents owning any
   chunk row whose model differs from the configured one; model staleness overrides the hash
   gate; repair is per-document atomic via the unchanged pipeline.
3. **`updatedAfter` recency pre-filter** (`server/search.js` + both entry points): an
   optional strictly-after `documents.updated_at` condition joined into every engine
   candidate CTE before ranking/fusion; explicit validation errors on both entry points when
   the value is unparseable or supplied without a content search (CN-3); MCP tool
   description/schema updated; zero behavior change for callers passing no new params.

One migration: `1797000000000` adds nullable `content_hash TEXT` to
`document_search_index` — nothing else.

## Technical Context

**Language/Version**: Node.js 22+ (CommonJS), Express backend

**Primary Dependencies**: `pg` (node-postgres), `ai` + `@ai-sdk/google` (embeddings —
`embedMany`/`embed`, gemini-embedding-001 @ 1536 dims), node-pg-migrate, Jest + supertest
(backend tests). No new dependencies.

**Storage**: PostgreSQL + pgvector. Tables touched: `document_search_index` (+1 column),
`document_embeddings` (existing `embedding_model VARCHAR(100)` column becomes authoritative
— written, not defaulted), `documents` (read-only: `updated_at`).

**Testing**: Jest, backend suites in `server/__tests__/` — **serial only** (shared test DB;
never run concurrent backend suites). Existing suites to extend: `search.test.js`,
`api-docs.test.js`; new: `search-indexer-gating.test.js`,
`list-documents-updated-after.test.js`.

**Target Platform**: Linux server (Minikube app-dev pod for development; k3s hardened
cluster in prod).

**Project Type**: Web service (Express monolith `server/` + React client `client/` —
this feature is backend-only; the web client passes no new params and observes zero change).

**Performance Goals**: zero embedding-provider calls for unchanged content (SC-001);
steady-state gate overhead ≤ 1 `RETURNING` column + 1 indexed EXISTS per indexing pass;
recency filter adds one PK join per engine CTE, no new scans; no change to search behavior
when `updatedAfter` absent (emitted SQL byte-identical to today's).

**Constraints**: migration slot pinned to 1797000000000 (016 owns 1796…; floor
1795000000000 after the retired 008 row); hash covers extracted document text ONLY
(chunker-agnostic — feature 018 contract, FR-001) and is built exclusively through
`buildEmbedHashInput` (CN-7 seam); MCP surface stays exactly 16 tools; no response-shape
changes; debounce/concurrency constants unchanged; `updatedSince` (list path) untouched;
do not touch `specs/016-*` or `specs/018-*`.

**Scale/Scope**: beta corpus (< 5K chunks; VECTOR_CANDIDATE_LIMIT 1000 never hit); 4 source
files + 1 migration + ~4 test files.

## Constitution Check

*GATE: evaluated against Constitution v1.1.1 before Phase 0; re-evaluated after Phase 1.*

| # | Principle | Verdict | Evidence |
|---|-----------|---------|----------|
| I | Documentation Reflects Reality | PASS (task required) | `ReadMe.md` describes content search and `list_documents`; tasks include a same-change docs sweep (`ReadMe.md`; docs-site MCP tool page if it enumerates parameters). `docs/dev.md` unaffected. |
| II | Test-Backed Changes | PASS | Every behavioral change maps to named Jest suites (Test Traceability below); tests-first ordering in tasks.md; backend serial. No format/serialization change → round-trip suite untouched. |
| III | Trunk-Based Solo Workflow | PASS | No new ceremony. (Pipeline overrides: agent stays on current branch, never commits.) |
| IV | Collaboration-Safe Document Operations | PASS | No document mutation anywhere; indexer reads Yjs docs via existing `toPlainText` extraction only. Format registry untouched. |
| V | Secure by Default | PASS | No new ingestion surface. `updatedAfter` is parsed to a Date then bound as a SQL parameter (never interpolated); the per-user share join stays inside every CTE **before** ranking (FR-020) — the filter is purely subtractive; content-search rate limit unchanged (FR-021); validation rejects rather than silently no-ops (CN-3). |
| VI | Design Docs Are Ground Truth | PASS | Plan implements the two 017 amendment paragraphs; unsettled details are CN-1..CN-7 (RATIFIED-BY-DEFAULT), including the mid-flight title-hash Addition (ledgered as CN-7). One letter-level deviation recorded and justified: the amendment's "indexed-column WHERE" phrase vs. no dedicated index on `documents.updated_at` — mechanism (pre-ranking filter inside candidate selection) is honored exactly; see research.md R7 and the analyze findings. |

**Post-Phase-1 re-check**: PASS — design artifacts introduce no new violations; Complexity
Tracking stays empty.

## Project Structure

### Documentation (this feature)

```text
specs/017-search-index-efficiency/
├── spec.md                  # Input (3 stories, FR-001..022, SC-001..007)
├── clarifications-needed.md # CN-1..CN-6 (input, verbatim) + CN-7 (added by plan phase)
├── checklists/requirements.md
├── plan.md                  # This file
├── research.md              # Phase 0 — decisions R1..R10
├── data-model.md            # Phase 1 — schema + entity deltas
├── quickstart.md            # Phase 1 — validation guide
├── contracts/
│   ├── rest-api-docs.md         # GET /api/docs content branch: updatedAfter
│   ├── mcp-list-documents.md    # list_documents: updatedAfter schema/description
│   └── indexer-internal.md      # hash-gate + model-watermark internal contract (018 seam)
└── tasks.md                 # Phase 2 (/speckit-tasks — not created by /speckit-plan)
```

### Source Code (repository root)

```text
server/
├── search-indexer.js        # [MODIFY] buildEmbedHashInput + computeContentHash (new exports);
│                            #   gate in indexDocument; empty-doc cleanup (CN-6); hash advance +
│                            #   embedding_model write inside generateAndStoreEmbeddings's
│                            #   transaction; model-stale OR-condition in reindexStale
├── search.js                # [MODIFY] parseUpdatedAfter export; updatedAfter option threaded
│                            #   into fulltextSearch / semanticSearch / hybridSearch CTEs
│                            #   (JOIN documents ... AND updated_at > $N; both hybrid legs)
├── index.js                 # [MODIFY] /api/docs handler (~line 575): updatedAfter validation
│                            #   (400s) ahead of the rate limiter; pass-through to searchDocuments
└── mcp/tools/list-documents.js  # [MODIFY] inputSchema + description (updatedAfter vs
                             #   updatedSince); handler validation (tool error) + pass-through

migrations/
└── 1797000000000_add-content-hash-to-search-index.js   # [NEW] content_hash TEXT, nothing else

server/__tests__/
├── search-indexer-gating.test.js         # [NEW] US1+US3: gate, watermark, repair, ghosts, seam
├── search.test.js                        # [EXTEND] US2 engine-level updatedAfter
├── list-documents-updated-after.test.js  # [NEW] US2 MCP entry point
└── api-docs.test.js                      # [EXTEND] US2 REST entry point (400s)
```

**Structure Decision**: Backend-only change inside the existing Express monolith; all edits
land in the four existing source files above plus one migration and tests. No client change
(the web client sends no new params in this feature; the REST param is agent/API-facing).

## Design Detail (Phase 1 digest)

Authoritative detail lives in research.md (R1–R10), data-model.md, and contracts/. Key
architecture decisions:

- **AD-1 — Single hash seam** (R2, CN-7): `buildEmbedHashInput(extractedText)` is the only
  producer of hash input; `computeContentHash` is SHA-256-hex over its output. Feature 018
  extends the seam's signature to include the title; the gate logic, `content_hash` column,
  and advance-on-success semantics never move. Enforced by test (stored hash ===
  `computeContentHash(buildEmbedHashInput(text))`; output title-independent in 017).
- **AD-2 — Hash advances only inside the chunk-swap transaction** (R3/R5, CN-4): the FTS
  upsert is hash-blind (`RETURNING content_hash` reads the previously stored value); the
  embed transaction writes chunks (with explicit `embedding_model`) and the hash atomically;
  provider failure or disabled embeddings → rollback/early-return → hash unchanged → retried
  at the next indexing event. The hash and the embedded text travel together from a single
  extraction, so an in-flight newer edit can never have its fingerprint recorded.
- **AD-3 — Empty/unembeddable content is a first-class terminal state** (R4, CN-6): zero
  chunks → delete stale chunk rows + advance hash in one transaction, gated by hash
  inequality so it runs exactly once. Fixes the latent ghost-chunks leak (early return on
  zero chunks without deleting old rows) that gating would otherwise fossilize; runs
  regardless of provider-key presence.
- **AD-4 — Model staleness overrides the gate via an EXISTS probe run only on hash-match**
  (R4/R6, CN-5): one pipeline serves edit-stale, model-stale, and both-stale documents
  (single pass, never double-embeds); `reindexStale()` grows one OR-EXISTS predicate
  (`embedding_model IS DISTINCT FROM $configured`, NULL-safe); existing rows carry the
  column default equal to the current model → zero repair triggered by deploying 017.
- **AD-5 — Recency filter = per-CTE PK join, params placed before limit/offset** (R7, CN-2):
  strictly-after comparison on `documents.updated_at` inside the `fts` and `top_chunks`
  CTEs (hybrid gets both legs via the shared builders); ranking/fusion and
  `COUNT(*) OVER()` totals therefore see only in-window candidates (FR-016); role filters,
  sorts, pagination, and distanceThreshold compose unchanged (FR-017). Absent the param,
  the emitted SQL is byte-identical to today's (FR-022 by construction).
- **AD-6 — One shared validator, two transports** (R8, CN-3): `parseUpdatedAfter` exported
  from `server/search.js`; REST maps violations to 400 before the rate limiter (cheap
  rejects spend no search quota; valid filtered searches remain metered per FR-021), MCP
  throws a tool error mirroring the existing `updatedSince`+`search` precedent;
  `searchDocuments` re-validates defensively so the engine can never silently no-op.

## Test Traceability (SC → suite)

| SC | Where proven |
|----|--------------|
| SC-001 zero calls on unchanged content; title still searchable | `search-indexer-gating.test.js` (mocked `embedMany` call counts; FTS row refresh assertions) |
| SC-002 targeted model repair; idempotent second boot | `search-indexer-gating.test.js` (`reindexStale` selection + call counts) |
| SC-003 exclusion in all 3 modes; filtered totals | `search.test.js` additions |
| SC-004 result ⊆ accessible ∧ ⊆ unfiltered | `search.test.js` additions (two-user fixtures) |
| SC-005 zero-change regression | existing `search.test.js` / `api-docs.test.js` / `documents.test.js` pass unmodified, plus explicit no-new-params assertions |
| SC-006 failed embed → keyword search survives; retry regenerates latest text | `search-indexer-gating.test.js` (`embedMany` rejection path) |
| SC-007 explicit errors on both entry points | `api-docs.test.js` additions + `list-documents-updated-after.test.js` |

## Complexity Tracking

> No Constitution Check violations — table intentionally empty.

| Violation | Why Needed | Simpler Alternative Rejected Because |
|-----------|------------|-------------------------------------|
| — | — | — |
