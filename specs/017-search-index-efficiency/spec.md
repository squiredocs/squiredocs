# Feature Specification: Search Index Efficiency

**Feature Branch**: `017-search-index-efficiency`

**Created**: 2026-07-18

**Status**: Draft

**Input**: User description: "Three query/index efficiency upgrades to content search, adapted from the Liz Data Layer Search gap analysis (2026-07-18): (1) content-hash gating of embedding regeneration; (2) the indexer writes the embedding model id per chunk row and boot repair fixes model-mismatched rows (automatic targeted re-embed on model upgrade); (3) an updatedAfter recency pre-filter on content search, applied inside the engine candidate selection before ranking, surfaced on GET /api/docs and the MCP list_documents tool."

**Design ground truth**: `design/content-search.md` — specifically the two amendment paragraphs dated 2026-07-18 for feature 017: "incremental gating" (under *Index maintenance*) and "recency pre-filter + entry-point corrections" (under *Entry points*). The rest of the doc (two engines, RRF fusion, authorization invariant) continues to bind. Unsettled details are resolved in `clarifications-needed.md` (CN-#) per Constitution Principle VI.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Unchanged content costs zero embedding work (Priority: P1)

Sam (operator) and every editing user benefit from indexing that only pays for real changes. Today, any persisted document update — a title sync, a cursor-only collaboration session, formatting-only churn — triggers full embedding regeneration after the debounce window, even though the extracted text is identical. With incremental gating, the indexer fingerprints the extracted document body text and skips embedding regeneration entirely when the fingerprint is unchanged, while still refreshing the keyword (full-text) index row.

**Why this priority**: It is the direct cost/efficiency win the gap analysis identified — embedding calls are the only per-edit external API spend in the indexing pipeline, and the majority of persisted updates do not change extracted text. It also protects against provider rate limits as the beta corpus grows.

**Independent Test**: Can be fully tested by persisting a sequence of updates that do not change extracted body text (title change, formatting churn, open/close sessions) and observing zero embedding-provider calls while the full-text row's content and freshness watermark still update; then making a real text edit and observing exactly one regeneration.

**Acceptance Scenarios**:

1. **Given** an indexed document, **When** a persisted update changes the title but not the body text and the indexer runs, **Then** the full-text row is refreshed (new title searchable) and zero embedding-provider calls are made.
2. **Given** an indexed document, **When** a persisted update changes only formatting (no extracted-text change) and the indexer runs, **Then** zero embedding-provider calls are made and existing chunk rows are untouched.
3. **Given** an indexed document, **When** a persisted update changes the body text and the indexer runs, **Then** embeddings are regenerated for the new text and the stored fingerprint advances to match it.
4. **Given** a document whose embedding regeneration fails (provider error), **When** the indexer next processes that document, **Then** it attempts regeneration again — the failed run did not record the new fingerprint as done, and full-text search kept working throughout.
5. **Given** a document whose body text is deleted entirely, **When** the indexer runs, **Then** its stale chunk rows are removed (no ghost semantic hits) and subsequent no-change updates cost zero embedding calls.

---

### User Story 2 - "Recent docs about X" without post-hoc truncation (Priority: P2)

An agent (via MCP `list_documents`) or the web client (via `GET /api/docs`) asks for content-search results restricted to documents updated after a given instant. The filter is applied to each engine's candidate set *before* ranking and fusion — filter-then-search — so the ranked result list and its pagination totals reflect only recent documents, instead of the caller over-fetching and discarding old hits.

**Why this priority**: It is the only user-facing capability in this feature and the most common agent search refinement ("what changed recently about X"); but the system is fully functional without it, and it depends on nothing in the other stories.

**Independent Test**: Can be fully tested by seeding documents with distinct last-updated timestamps, running content searches with and without `updatedAfter` in all three modes, and verifying exclusion, ranking, totals, and error handling on both entry points.

**Acceptance Scenarios**:

1. **Given** accessible documents matching a query with last-updated timestamps both before and after a cutoff, **When** a content search passes `updatedAfter` = cutoff, **Then** only documents updated strictly after the cutoff appear — in keyword, semantic, and hybrid modes alike — and the pagination total counts only those.
2. **Given** the same corpus, **When** the same search runs without `updatedAfter`, **Then** results are byte-identical to today's behavior (zero change for existing clients).
3. **Given** a content search with `updatedAfter` combined with an ownership filter and a non-default sort, **When** it executes, **Then** the recency filter, role filter, and sort all compose correctly (filter before rank; sort applied to the filtered ranked set).
4. **Given** an invalid `updatedAfter` value (not a parseable timestamp), **When** the request is made, **Then** the API responds with a clear validation error (HTTP 400 on REST, a tool error on MCP), never a silently unfiltered result.
5. **Given** `updatedAfter` supplied without a content-search query, **When** the request is made, **Then** it is rejected with a clear error on both entry points (CN-3) — the parameter never silently no-ops.
6. **Given** a user with access to only some matching documents, **When** they search with `updatedAfter`, **Then** the result set is still a subset of their accessible documents — the recency filter narrows, never widens, access.

---

### User Story 3 - Embedding-model upgrade heals itself (Priority: P3)

Sam changes the configured embedding model. On the next boot, the repair pass finds every chunk row recorded under a different model and re-embeds exactly those documents — an automatic, targeted re-embed instead of a manual full backfill. Search stays up throughout; documents already on the new model are untouched.

**Why this priority**: Model upgrades are rare events, but without this they require a hand-run backfill script and risk silently mixing incompatible embeddings forever. Writing the model id per chunk (the field has existed since the original schema but was never written) is the prerequisite bookkeeping.

**Independent Test**: Can be fully tested by indexing documents under model A, switching configuration to model B, rebooting, and verifying that exactly the model-A documents re-embed (and nothing else), that queries keep answering during the repair, and that a second reboot performs zero repair work.

**Acceptance Scenarios**:

1. **Given** a freshly indexed document, **When** its chunk rows are inspected, **Then** every row records the identifier of the model that produced its vector.
2. **Given** chunk rows recorded under a model different from the configured one, **When** the server boots, **Then** the repair pass re-embeds exactly the documents owning those rows — including documents whose content fingerprint is unchanged (model staleness overrides content gating, CN-5).
3. **Given** a corpus where all chunk rows match the configured model, **When** the server boots, **Then** the repair pass performs zero embedding calls for model reasons.
4. **Given** a repair pass in progress (mixed-model rows present), **When** users search, **Then** search remains available and returns results (mixed rows stay queryable; no downtime, no manual backfill).

---

### Edge Cases

- A document's body text is emptied (or falls below the embeddable minimum): stale chunk rows MUST be removed, and the fingerprint advances so later no-change updates stay free (CN-6). Today's pipeline leaves such rows in place; content gating must not fossilize that leak.
- Embedding regeneration fails partway through a multi-batch document: the existing all-or-nothing chunk swap holds — no partial chunk sets — and the fingerprint does not advance, so the document remains detected as needing re-embedding (FR-005).
- Embeddings are disabled (no provider key): the fingerprint does not advance for content that was never embedded, so enabling embeddings later does not mistake un-embedded content for done (CN-4).
- The text changes again while a regeneration is in flight: the recorded fingerprint MUST be the fingerprint of exactly the text that was embedded, never of a fresher extraction — otherwise the newer edit is lost until the next change.
- A document is edited while model repair is pending for it: a single re-index pass satisfies both (time-stale and model-stale converge on the same per-document pipeline); it must not double-embed.
- `updatedAfter` set in the future: valid request, empty result set, correct zero total.
- `updatedAfter` equal to a document's exact last-updated instant: the document is excluded (strictly-after semantics, CN-2).
- `updatedAfter` on the MCP tool alongside the existing list-path `updatedSince` parameter: they are distinct parameters with distinct timestamp bases and mutually exclusive paths (search vs. list); supplying the one that doesn't apply to the chosen path is an error, never a silent ignore (CN-2, CN-3).
- Recency-filtered searches remain subject to the existing per-user content-search rate limit — the new parameter opens no unmetered path.

## Requirements *(mandatory)*

### Functional Requirements

**Content-hash gating of embedding regeneration**

- **FR-001**: Each indexing pass MUST compute a deterministic fingerprint (content hash) of the extracted document **body text only** — exactly the plain text extracted from the persisted document. The title is excluded (CN-1), and any generated or derived text (e.g., the contextual preambles planned in feature 018) is permanently excluded by contract: the hash covers extracted document text and nothing else, regardless of how the text is later chunked. Feature 018 depends on this rule.
- **FR-002**: The fingerprint MUST be stored on the per-document full-text index row. This stored field is the only schema addition of this feature.
- **FR-003**: When the freshly computed fingerprint equals the stored one, the indexer MUST skip embedding regeneration entirely — zero embedding-provider calls — while still refreshing the full-text row (updated title, content, and freshness watermark) exactly as today.
- **FR-004**: When the fingerprints differ, or no fingerprint is stored (pre-feature rows), embedding regeneration MUST proceed as today: chunk, embed, replace chunk rows atomically.
- **FR-005**: The stored fingerprint MUST advance only when embedding regeneration for that exact text completes successfully, or when the text has nothing to embed (see FR-007). A failed or interrupted regeneration MUST leave the previous fingerprint in place, so the document remains detected as needing re-embedding at its next indexing opportunity — no lost updates. Recovery timing follows CN-4.
- **FR-006**: When embedding generation is disabled (no provider key configured), the fingerprint MUST NOT advance (CN-4).
- **FR-007**: When a document's body text becomes empty or unembeddable, the indexer MUST remove its existing chunk rows and then advance the fingerprint (CN-6) — no ghost semantic results, and no perpetual re-processing of empty documents.
- **FR-008**: Gating is per-document bookkeeping only: it MUST NOT alter search results, ranking, snippets, or response shapes in any way.

**Embedding-model watermark and targeted repair**

- **FR-009**: Every chunk row the indexer writes MUST record the identifier of the embedding model that produced its vector, using the per-chunk model field that has existed since the original schema (currently populated only by column default). No new schema is needed for this.
- **FR-010**: The boot-time repair pass MUST select documents that are stale by time (index older than the document's last update, as today), **or** stale by model (owning at least one chunk row whose recorded model differs from the configured embedding model), or missing from the index — and re-index them through the normal per-document pipeline under the existing concurrency cap.
- **FR-011**: Model repair MUST be targeted: only documents owning mismatched rows re-embed; fully matched documents incur zero embedding calls. Model staleness MUST override content-hash gating — a model-stale document re-embeds even when its content fingerprint is unchanged (CN-5).
- **FR-012**: While mixed-model rows exist (mid-upgrade), search MUST remain available and all rows queryable; a model upgrade completes with no manual backfill, no downtime, and no result outage (CN-5 records the same-dimensionality assumption).

**Recency pre-filter (`updatedAfter`) on content search**

- **FR-013**: Content search MUST accept an optional `updatedAfter` parameter on both entry points: the document-list API's content-search branch (`GET /api/docs` with `searchMode=content`) and the MCP `list_documents` tool's search path.
- **FR-014**: `updatedAfter` MUST be a timestamp (ISO-8601). An unparseable value MUST be rejected with a clear validation error — HTTP 400 on the API, a tool error on MCP — never silently ignored (which would return unfiltered results the caller believes are filtered).
- **FR-015**: The filter MUST admit only documents whose last-updated timestamp — the same value surfaced as `updatedAt` in search results — is **strictly after** the given instant (CN-2 records the timestamp basis and its deliberate distinction from the list path's `updatedSince`).
- **FR-016**: The filter MUST be applied within each engine's candidate selection **before** ranking and fusion — in keyword mode, semantic mode, and **both** legs of hybrid mode — via an indexed-column condition. Filter-then-search: no engine ranks, and fusion never sees, a document outside the window. Pagination totals MUST reflect the filtered set.
- **FR-017**: `updatedAfter` MUST compose with all existing search options — ownership role filters, every sort mode and direction, pagination, and distance threshold — with the recency filter applied before ranking and the sort applied to the filtered ranked set.
- **FR-018**: Supplying `updatedAfter` without an accompanying content-search query MUST be an explicit error on both entry points (CN-3). The MCP list path's existing `updatedSince` parameter is unchanged, and the two parameters MUST be documented as distinct (different paths, different timestamp bases).
- **FR-019**: The MCP `list_documents` tool description and input schema MUST be updated to document `updatedAfter` (including its distinction from `updatedSince`). The MCP surface remains exactly 16 tools; no response shape changes on either entry point.

**Invariants (all stories)**

- **FR-020**: The authorization invariant holds unchanged: every engine's candidate selection remains pre-filtered to the requesting user's accessible documents via the per-user share join **before** ranking. `updatedAfter` is purely subtractive — it can only narrow a result set, never widen access.
- **FR-021**: The existing per-user rate limit on the content-search branch MUST continue to apply to recency-filtered searches.
- **FR-022**: Requests that pass none of the new parameters MUST behave identically to today — zero behavior change for existing querying clients (API and MCP), including result contents, shapes, and defaults.

### Key Entities

- **Document search index row** (one per document): the keyword-search record. Gains one new attribute: the content fingerprint of the extracted body text whose embeddings were last successfully generated. Continues to carry the searchable text/vector and freshness watermark.
- **Embedding chunk row** (many per document): a chunk of extracted text with its vector. Its existing model-identifier attribute becomes authoritative: written on every insert with the producing model's id, and consulted by boot repair to detect model staleness.
- **Content search request**: gains one optional attribute, `updatedAfter` (timestamp lower bound, exclusive), valid only when a content-search query is present; available identically on both entry points.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: Re-persisting a document whose extracted body text is unchanged (title-only, formatting-only, or open/close churn) triggers **zero** embedding-provider calls at index time — down from one full regeneration per debounce window today — while the document's new title is still findable by keyword search.
- **SC-002**: After switching the configured embedding model and rebooting, **exactly** the documents owning mismatched chunk rows re-embed; documents already on the new model incur zero embedding calls, and a subsequent reboot performs zero model-repair work.
- **SC-003**: A content search with `updatedAfter` excludes 100% of accessible matching documents last updated at or before the cutoff, in all three search modes, with pagination totals counting only the filtered set.
- **SC-004**: For every user and every `updatedAfter` value, the result set is a subset of that user's accessible documents and a subset of the same search without the filter — the parameter never surfaces a document the user could not already find.
- **SC-005**: Clients passing none of the new parameters observe identical responses to the pre-feature system on both entry points (existing search/list test suites pass unchanged apart from additions).
- **SC-006**: A document whose embedding regeneration fails remains fully keyword-searchable throughout, and its next successful indexing pass regenerates embeddings for the latest text — no edit's embeddings are ever silently skipped.
- **SC-007**: Invalid or misplaced use of `updatedAfter` (bad timestamp, or no search query) is rejected with an explicit error in 100% of cases on both entry points.

## Scope Boundaries

**In scope**: content-hash gating of embedding regeneration; writing and repairing the per-chunk embedding-model watermark; the `updatedAfter` recency pre-filter on both content-search entry points; the one migration adding the hash field (pre-assigned slot 1797000000000); removal of stale chunk rows when content becomes unembeddable (CN-6); MCP tool description/schema update for `updatedAfter`.

**Out of scope** (explicitly): structure-aware chunking, contextual preambles, and the search evaluation harness (feature 018, lands after this feature); the LLM reranker (stays off per design); any schema change beyond the single hash field plus writing the already-existing model field; making the embedding model configurable beyond what exists today; backfilling fingerprints for existing rows (an absent fingerprint simply means "regenerate on next real indexing event"); changes to the list (non-search) path or its `updatedSince` parameter; changes to response shapes, fusion, thresholds, or the debounce/concurrency constants.

## Dependencies

- Feature 018 (structure-aware chunking + preambles) is specified in parallel and lands **after** this feature. It depends on FR-001's chunker-agnostic hash contract: the fingerprint covers extracted document text only, never generated preambles — this rule is part of the design amendment and MUST NOT be weakened here.
- Migration numbering: this feature's migration uses the pre-assigned slot 1797000000000 (feature 016 holds 1796…; the floor after the retired 008 row is 1795000000000).

## Assumptions

- Embedding-model changes preserve the current vector dimensionality (1536); a dimensionality change is an operational/schema event outside this feature (CN-5).
- The choice of hash algorithm is an implementation detail; any deterministic collision-resistant digest of the extracted text satisfies the contract.
- The document last-updated timestamp used by `updatedAfter` is the one already maintained and surfaced by the system (CN-2); this feature does not change how or when it is bumped.
- The design amendment's entry-point corrections (the web client sends content search for every non-empty query; the content branch is rate-limited) describe current reality since the 010 hardening — they require no code change here, only that this spec not contradict them.
- Per the solo trunk-based workflow, "boot repair" refers to the existing startup repair pass; no new scheduling machinery is introduced.
