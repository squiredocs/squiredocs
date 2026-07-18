# Tasks: Search Index Efficiency

**Input**: Design documents from `/specs/017-search-index-efficiency/`

**Prerequisites**: plan.md, spec.md (FR-001..022, SC-001..007), research.md (R1..R10),
data-model.md, contracts/ (rest-api-docs.md, mcp-list-documents.md, indexer-internal.md),
quickstart.md, clarifications-needed.md (CN-1..CN-7)

**Tests**: REQUIRED (Constitution Principle II) and tests-first: within each story, write
the tests, watch them fail, then implement. Backend Jest is **serial only** (shared test
DB) — never run suites concurrently.

**Hard constraints (pipeline)**: stay on the current branch; never commit; do not touch
`specs/016-*` or `specs/018-*`; migration slot is exactly `1797000000000` and contains
ONLY the `content_hash` column; the hash contract stays chunker-agnostic (extracted
document text only) and flows exclusively through `buildEmbedHashInput` (CN-7).

## Format: `[ID] [P?] [Story] Description`

- **[P]**: parallelizable (different files, no dependency on an incomplete task)
- **[Story]**: US1 (hash gating, P1), US2 (updatedAfter, P2), US3 (model repair, P3)

---

## Phase 1: Setup

**Purpose**: capture the pre-feature baseline that SC-005 is measured against.

- [X] T001 Run the affected existing suites serially and record them green before any
      change: `npx jest server/__tests__/search.test.js server/__tests__/search-indexer.test.js
      server/__tests__/search-indexer-privacy.test.js server/__tests__/api-docs.test.js
      server/__tests__/documents.test.js --runInBand` (repo root). These files must still
      pass **unmodified** (except documented extensions) at the end — that is the SC-005
      zero-change regression gate.

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: the schema field and the hash seam that US1 and US3 both build on.

**⚠️ CRITICAL**: T002 blocks US1 and US3 (not US2). T003 blocks US1 and US3.

- [X] T002 Create migration `/local-dev/migrations/1797000000000_add-content-hash-to-search-index.js`:
      `up` = `ALTER TABLE document_search_index ADD COLUMN content_hash TEXT` (nullable, no
      default, no backfill, no index); `down` = drop column. **Nothing else in this
      migration** (slot pre-assigned; 016 owns 1796…; new migrations must be
      > 1795000000000). Apply with `npm run migrate` and confirm the test DB picks it up
      via the normal Jest global setup (see data-model.md).
- [X] T003 In `/local-dev/server/search-indexer.js` add the two seam functions and export
      them: `buildEmbedHashInput(extractedText)` (017: returns the extracted body text
      unchanged — title never enters; see CN-1/CN-7) and `computeContentHash(input)`
      (Node `crypto` SHA-256, hex). Add them to `module.exports`. No call-site changes yet.
      Contract: `contracts/indexer-internal.md` §Hash contract.

**Checkpoint**: column exists; seam exported; all baseline suites still green.

---

## Phase 3: User Story 1 — Unchanged content costs zero embedding work (Priority: P1) 🎯 MVP

**Goal**: content-hash gating of embedding regeneration + the CN-6 empty-doc ghost-chunk
cleanup, with the hash advancing only on successful embed (or empty-cleanup) — zero
provider calls for title/formatting/no-op churn.

**Independent Test**: quickstart.md §US1 — persist no-text-change updates and observe zero
`embedMany` calls while the FTS row still refreshes; real edit → exactly one regeneration;
emptied doc → chunks deleted then settled.

### Tests for User Story 1 (write first, must fail)

- [X] T004 [US1] Create `/local-dev/server/__tests__/search-indexer-gating.test.js`:
      DB-backed harness following `search.test.js` conventions (`createPool`,
      `createPersistence` from `./helpers/db`); seed docs through the persistence provider
      so `indexDocument` can extract real text; `jest.mock('ai')` so `embedMany` is a
      controllable spy (call counter, resolved fake 1536-dim vectors, rejection switch);
      set `process.env.GOOGLE_GENERATIVE_AI_API_KEY` in the suite (and unset it for the
      disabled-embeddings case). Cover the full gate table from
      `contracts/indexer-internal.md` §Gate semantics:
      1. first index of a doc → embeds; `content_hash` = 64-char hex;
      2. re-index with unchanged body (title changed) → **zero** `embedMany` calls, chunk
         rows untouched, FTS row refreshed (new title matches via fulltext search),
         `indexed_at` advanced, hash unchanged (FR-003, SC-001);
      3. body text changed → exactly one regeneration, hash advances to the new text's
         hash (FR-004);
      4. `embedMany` rejects → chunk rows untouched, hash NOT advanced, fulltext still
         returns the doc; next `indexDocument` call retries and succeeds (FR-005, SC-006);
      5. body emptied → existing chunk rows **deleted**, hash advances; a further no-change
         pass makes zero provider calls and no deletes (FR-007, CN-6);
      6. no API key + changed content → zero calls, hash NOT advanced (FR-006, CN-4);
      7. **seam assertion (CN-7)**: stored `content_hash` strictly equals
         `computeContentHash(buildEmbedHashInput(extractedText))`, and
         `buildEmbedHashInput` output (hence the stored hash) is identical across different
         titles for the same body — proving the gate consumes ONLY the seam function's
         output;
      8. pre-feature row (`content_hash IS NULL`) → regenerates on next pass (FR-004).
- [X] T005 [P] [US1] In the same new file (separate `describe`), unit-test the seam:
      `computeContentHash` determinism + hex/64 shape; `buildEmbedHashInput` identity on
      body text in 017. Run the file; confirm the gate cases FAIL (gate not yet built).

### Implementation for User Story 1

- [X] T006 [US1] In `/local-dev/server/search-indexer.js` rework `indexDocument` per
      research.md R4 / data-model.md state diagram: compute
      `newHash = computeContentHash(buildEmbedHashInput(contentText))`; add
      `RETURNING content_hash` to the (otherwise unchanged, still unconditional) FTS
      upsert to obtain `storedHash` (upsert must NOT write `content_hash`); compute
      `chunks = chunkText(contentText)`; empty path (`chunks.length === 0`): if
      `storedHash !== newHash`, one transaction `DELETE FROM document_embeddings WHERE
      doc_id=$1` + `UPDATE document_search_index SET content_hash=$2 WHERE doc_id=$1`
      (runs regardless of API-key presence), else no-op; unchanged path
      (`storedHash === newHash`): skip embedding entirely (US3 later adds the
      model-override probe here); otherwise call
      `generateAndStoreEmbeddings(docGuid, contentText, newHash)` keeping the existing
      best-effort `.catch` + log-privacy behavior (no titles/content in logs).
- [X] T007 [US1] In `/local-dev/server/search-indexer.js` change
      `generateAndStoreEmbeddings(docGuid, contentText, contentHash = computeContentHash(buildEmbedHashInput(contentText)))`:
      inside the existing transaction, after the chunk INSERTs, add
      `UPDATE document_search_index SET content_hash = $2 WHERE doc_id = $1`; keep the
      no-API-key early return **before** any DB write (hash must not advance, CN-4); the
      zero-chunks early return becomes unreachable from `indexDocument` (empty path handled
      in T006) but keep it harmless for the direct caller
      `server/scripts/backfill-search-index.js` (which skips empty docs itself — its 2-arg
      call now correctly advances the hash via the default parameter).
- [X] T008 [US1] Run `npx jest server/__tests__/search-indexer-gating.test.js
      server/__tests__/search-indexer.test.js server/__tests__/search-indexer-privacy.test.js
      server/__tests__/search.test.js --runInBand`: T004 cases green; pre-existing tests
      green unmodified (FR-008/FR-022 — gating is bookkeeping only, no result/shape change).

**Checkpoint**: US1 independently shippable — gate + ghost cleanup proven with zero
provider calls on churn.

---

## Phase 4: User Story 2 — "Recent docs about X" (`updatedAfter`) (Priority: P2)

**Goal**: strictly-after recency pre-filter inside every engine CTE before ranking/fusion,
surfaced with explicit validation on `GET /api/docs` and MCP `list_documents`.

**Independent Test**: quickstart.md §US2 — seeded timestamps; all three modes exclude the
old doc with correct totals; both entry points 400/tool-error on misuse; no-param requests
byte-identical. (No dependency on Phase 2/3 — can run in parallel with US1 after Phase 1.)

### Tests for User Story 2 (write first, must fail)

- [X] T009 [P] [US2] Extend `/local-dev/server/__tests__/search.test.js` (additions only —
      existing tests must remain byte-identical): in a NEW nested `describe` with its own
      documents (do not mutate the shared beforeAll fixtures), seed distinct
      `documents.updated_at` values (direct `UPDATE documents SET updated_at=…`); add
      engine-level cases per `contracts/rest-api-docs.md`:
      exclusion + filtered `pagination.total` in `fulltext` mode; boundary — cutoff equal
      to a doc's exact `updated_at` excludes it (strictly-after, CN-2); future cutoff →
      empty rows, total 0; composition — `updatedAfter` + `filter: 'owned'` +
      `sortBy: 'updatedAt'`/`sortOrder` + pagination all compose (FR-017); subset property
      — filtered results ⊆ unfiltered results ⊆ accessible docs, for both users (FR-020,
      SC-004); invalid `updatedAfter` (e.g. `'banana'`) passed to `searchDocuments` throws;
      absent `updatedAfter` → results deep-equal a pre-feature call (SC-005). For
      semantic/hybrid modes: mock `ai`'s `embed`/`embedMany` (as in T004) and seed
      `document_embeddings` rows directly with fake vectors so the vector leg and both
      hybrid legs demonstrably filter before ranking (out-of-window doc absent even when
      it is the nearest vector, and totals reflect the filtered set) (FR-016, SC-003).
- [X] T010 [P] [US2] Create `/local-dev/server/__tests__/list-documents-updated-after.test.js`:
      require `server/mcp/tools/list-documents.js` directly (init with test persistence,
      call `handler(args, { userId, baseUrl })`); per `contracts/mcp-list-documents.md`:
      `updatedAfter`+`search` filters and totals; `updatedAfter` without `search` → thrown
      error naming `updatedSince` as the list-path alternative (CN-3); unparseable →
      thrown error; `updatedAfter`+`updatedSince` always errors (with and without
      `search`); `updatedSince`-only list path behavior unchanged; no-new-params search
      and list responses unchanged in shape/content (FR-022); `inputSchema.properties.updatedAfter`
      exists and `description` documents the `updatedAfter` vs `updatedSince` distinction;
      tool registry still exposes exactly 16 tools (`require('../mcp/tools')` keys length).
- [X] T011 [P] [US2] Extend `/local-dev/server/__tests__/api-docs.test.js`: update the
      suite's inline `/api/docs` handler copy to mirror `server/index.js` (content branch +
      shared `parseUpdatedAfter` validator call — keep the "same as in server/index.js"
      comment honest), then add supertest cases: `updatedAfter` without
      `searchMode=content` → 400 with the normative message; unparseable → 400; valid
      value + content search → 200 filtered with filtered totals; future cutoff → 200
      empty/total 0; requests without new params → responses unchanged (SC-005/SC-007).
      Also mirror the rate limiter in the handler copy as a stub
      (`rateLimit.enforceUser`-shaped spy) and assert it is invoked for
      `updatedAfter`-filtered content searches — the recency filter opens no unmetered
      path (FR-021).
      After T009–T011 are authored, run the three files serially and confirm the new
      cases FAIL before starting T012.

### Implementation for User Story 2

- [X] T012 [US2] In `/local-dev/server/search.js`: export
      `parseUpdatedAfter(value, { hasContentSearch })` → `Date`, throwing `Error` with
      `code='INVALID_UPDATED_AFTER'` and the normative messages from
      `contracts/rest-api-docs.md`; accept `options.updatedAfter` (Date or ISO string,
      re-validated defensively) in `searchDocuments`; thread it into the engines per
      research.md R7: a recency join fragment
      `JOIN documents rd ON rd.id = <alias>.doc_id AND rd.updated_at > $N` added inside
      the `fts` CTE (`fulltextSearch` + hybrid's fts leg) and inside `buildVectorCTE`
      (`top_chunks` — semantic + hybrid's vector leg), with the extra param inserted
      **before** limit/offset in every params array (`runSearchQuery` requires them last).
      When `updatedAfter` is absent, every generated SQL string and params array must be
      byte-identical to today's (FR-022).
- [X] T013 [US2] In `/local-dev/server/index.js` `/api/docs` handler (~line 575): at the
      top of the handler — before `rateLimit.enforceUser('search', …)` — if
      `req.query.updatedAfter` is present, call `search.parseUpdatedAfter(value,
      { hasContentSearch: !!(searchQuery && searchMode === 'content') })`; on throw return
      `res.status(400).json({ error: err.message })`; on success pass the parsed Date as
      `updatedAfter` in the `searchDocuments` options. No other handler changes.
- [X] T014 [US2] In `/local-dev/server/mcp/tools/list-documents.js`: add the
      `updatedAfter` property to `inputSchema` and the PARAMETERS/EXAMPLES prose exactly
      per `contracts/mcp-list-documents.md` (explicit contrast with `updatedSince`); in
      `handler`, on the search path validate via `search.parseUpdatedAfter` (throw = tool
      error) and pass through; before the list path, if `args.updatedAfter` is present
      without `search`, throw the misplaced-parameter error (CN-3). `updatedSince` logic
      untouched.
- [X] T015 [US2] Run `npx jest server/__tests__/search.test.js
      server/__tests__/list-documents-updated-after.test.js server/__tests__/api-docs.test.js
      server/__tests__/documents.test.js --runInBand` — new cases green, pre-existing
      cases green unmodified (SC-003/004/005/007).

**Checkpoint**: US2 independently shippable on both entry points.

---

## Phase 5: User Story 3 — Embedding-model upgrade heals itself (Priority: P3)

**Goal**: per-chunk model watermark written on every insert; boot repair selects
model-stale docs; model staleness overrides the hash gate; per-document atomic, mixed rows
queryable, idempotent second boot.

**Independent Test**: quickstart.md §US3 — flip `embedding_model` on one doc's rows,
reboot-equivalent (`reindexStale()`), exactly that doc re-embeds; second run does nothing.

**Depends on**: Phase 2 + US1 (the gate the override must beat lives in T006).

### Tests for User Story 3 (write first, must fail)

- [X] T016 [US3] Extend `/local-dev/server/__tests__/search-indexer-gating.test.js` with a
      model-watermark `describe` (reuse the T004 harness/mocks):
      1. fresh index writes `embedding_model = 'gemini-embedding-001'` explicitly on every
         chunk row (assert via SELECT, not column default — e.g. also assert an
         INSERT-listed column by flipping a row then re-indexing) (FR-009, US3-AS1);
      2. flip one doc's rows to `'old-model-test'` with unchanged content → next
         `indexDocument` pass re-embeds despite equal hash (override, CN-5/FR-011), rows
         end on the configured model, hash value unchanged;
      3. `reindexStale()` selects exactly: missing-row docs, `indexed_at < updated_at`
         docs, and model-stale docs — a fully-matched fresh doc triggers **zero**
         `embedMany` calls (FR-010/011, SC-002);
      4. NULL `embedding_model` rows count as stale (`IS DISTINCT FROM`);
      5. doc both edit-stale and model-stale → processed once, one embed cycle (spec edge
         case);
      6. during a simulated mid-repair state (doc A old model, doc B new), fulltext +
         (mocked) semantic search still return both docs (FR-012);
      7. second `reindexStale()` after repair → zero embedding calls for model reasons
         (SC-002). Run; confirm FAIL.

### Implementation for User Story 3

- [X] T017 [US3] In `/local-dev/server/search-indexer.js`: (a) chunk INSERT lists
      `embedding_model` explicitly with `EMBEDDING_MODEL` (5th column/param); (b) in
      `indexDocument`'s unchanged-hash branch (T006), add the override probe —
      `SELECT EXISTS(SELECT 1 FROM document_embeddings de WHERE de.doc_id=$1 AND
      de.embedding_model IS DISTINCT FROM $2)` with `[docGuid, EMBEDDING_MODEL]` — run
      **only when hashes match**; mismatch → fall through to regeneration; (c) extend the
      `reindexStale()` selection query with
      `OR EXISTS (SELECT 1 FROM document_embeddings de WHERE de.doc_id = d.id AND
      de.embedding_model IS DISTINCT FROM $1)` parameterized with `EMBEDDING_MODEL`,
      keeping ordering, batching, and the concurrency cap (5) unchanged (FR-010, CN-4:
      no failed-embed hunt added).
- [X] T018 [US3] Run `npx jest server/__tests__/search-indexer-gating.test.js
      server/__tests__/search-indexer.test.js server/__tests__/search-indexer-privacy.test.js
      server/__tests__/search.test.js --runInBand` — all green; existing suites unmodified.

**Checkpoint**: all three stories independently functional.

---

## Phase 6: Polish & Cross-Cutting Concerns

- [X] T019 [P] Documentation sweep (Constitution Principle I; same change set): update
      `/local-dev/ReadMe.md` where it describes content search / the indexer /
      `list_documents` parameters (add `updatedAfter`, hash gating, model self-repair as
      appropriate to its current level of detail); check the docs site content under
      `/local-dev/docs/` (excluding `docs/dev.md`, which is unaffected) and
      `server/mcp/tools/tool-documentation/` for any page enumerating `list_documents`
      parameters and update it. Do NOT edit `design/*` (Squire-synced), `CLAUDE.md`, or
      `docs/dev.md`.
- [X] T020 Full serial backend regression: `npm test` (backend Jest, one runner). Confirm:
      no pre-existing test file modified except the documented extensions
      (`search.test.js`, `api-docs.test.js`); `agents-md-claims.test.js` and other
      MCP-description-dependent suites still green (tool description changed — if one
      asserts description text, reconcile per its own conventions).
- [X] T021 Walk `quickstart.md` expected-outcomes checklist (automated part; manual
      provider scenarios are flagged for Sam per pipeline convention — deploys/manual
      checks stay with the maintainer).

---

## Dependencies & Execution Order

```text
Phase 1 (T001 baseline)
  └─► Phase 2 (T002 migration → T003 seam)        [blocks US1, US3 — NOT US2]
        ├─► Phase 3 US1 (T004,T005 tests → T006,T007 impl → T008 verify)
        │       └─► Phase 5 US3 (T016 tests → T017 impl → T018 verify)
        └───────────────────────────────────────────────┐
Phase 1 ─► Phase 4 US2 (T009,T010,T011 tests → T012 → T013,T014 impl → T015 verify)
                                                        │
                                    Phase 6 (T019 ∥ T020 → T021)
```

- **US2 is fully independent** of the migration and of US1/US3 (touches different files:
  `search.js`, `index.js`, `list-documents.js`) — it can proceed in parallel with
  Phase 2/3/5 work.
- **US3 depends on US1** (the override probe lands inside T006's unchanged-hash branch)
  and on T002/T003.
- Within every story: tests first (fail) → implementation → serial verify. **Test
  execution is always serial** even when authoring in parallel.

### Parallel Opportunities

- T004 ∥ T009 ∥ T010 ∥ T011 (four different test files) once their phase prerequisites met.
- T013 ∥ T014 after T012 (different files).
- T019 ∥ T020 in Polish.

## Implementation Strategy

MVP = Phase 1 → Phase 2 → US1 (the cost-efficiency win). Then US2 (only user-visible
capability), then US3, then Polish. Solo-agent order: T001→T002→T003→US1→US2→US3→Polish;
a two-agent split would give US2 to the second agent immediately after T001.

**Task count**: 21 tasks (Setup 1, Foundational 2, US1 5, US2 7, US3 3, Polish 3).
