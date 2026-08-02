# Feature Specification: Diff Cache Integrity & Two-Surface Parity

**Feature Branch**: `039-diff-cache-integrity`

**Created**: 2026-08-01

**Status**: Merged (2026-08-02)

**Input**: User description: "039-diff-cache-integrity — diff cache integrity and two-surface parity hardening" (verified audit findings F7–F14)

## Overview

Version-history diffs are computed once and frozen in a shared cache for an hour. A verified audit found four ways a wrong or degraded diff can be frozen under a correct key (a racing tail write, a transient computation failure, a load-dependent word-diff timeout, and stale-shape entries), plus a word-emphasis algorithm divergence that makes the chat diff surface and the version-history diff surface disagree about the same edit, UI-only diff data being resent to the model every turn, a double full-log replay, a text-extraction bug that corrupts the "Formatting changes only" banner, and an unstable history badge color fallback. This feature makes the cache-write rules exact (a diff is cached only when it is provably complete, successful, and deterministic), unifies word emphasis across the two surfaces, and fixes the smaller correctness and efficiency findings.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - A diff never freezes the wrong document state (Priority: P1)

A user (or agent) is actively editing a document. Immediately after an edit lands, they open version history to compare the newest version against an older one. The comparison must reflect the newest version they asked for — and if the system momentarily cannot see the newest edit (its durable write is still in flight), it must never freeze that incomplete answer in the cache, where every viewer would receive the wrong "current" state for the next hour.

**Why this priority**: This is the audit's highest-severity finding (F7). Clients learn version identifiers from the live collaboration channel before the durable write lands, so the race is plausible in normal use, and the blast radius is an hour of confidently wrong diffs served to everyone under the correct key.

**Independent Test**: Simulate a version-history diff request for version N while the row for N has not yet been committed. Verify the read is retried within the existing bounded retry budget; if N appears, the diff is correct and cacheable; if N still has not appeared, the response is served but no cache entry is written, and the next request (after N commits) computes and caches the correct diff.

**Acceptance Scenarios**:

1. **Given** a document whose newest update (version N) has not yet durably committed, **When** a diff up to version N is requested, **Then** the read is retried within the existing bounded gap-retry budget until version N is visible or the budget is exhausted.
2. **Given** the retry budget is exhausted and version N is still not visible, **When** the diff is served, **Then** no cache entry is written for that request, and a subsequent request after N commits returns a diff that includes N and is cached.
3. **Given** a diff request whose newest requested version is already visible, **When** the diff is computed, **Then** behavior (including caching) is unchanged from today.
4. **Given** the maintenance backfill job that reads entire update logs with an "everything" upper bound, **When** it runs against documents of any size, **Then** it never burns retry budget on tail-completeness checks (completeness expectation is strictly opt-in per caller).

---

### User Story 2 - Transient diff failures recover on the next request (Priority: P1)

A user opens a version comparison at an unlucky moment and the diff computation fails transiently. They see the existing "Diff highlighting unavailable" notice — but on refresh (or the next viewer's request), the diff is recomputed and succeeds. The failure is never frozen for an hour.

**Why this priority**: Audit finding F8. Today a single transient failure is cached for an hour, converting a momentary glitch into a prolonged, self-inflicted outage of diff highlighting for that version pair with no retry path.

**Independent Test**: Force the diff computation to throw once, request the diff (observe the fallback plain document and the failure flag), then request again with the failure removed and verify a correct highlighted diff is returned and cached.

**Acceptance Scenarios**:

1. **Given** a diff computation that fails transiently, **When** the diff is requested, **Then** the fallback (plain current document + failure flag) is served but no cache entry is written.
2. **Given** the same version pair requested again after the transient condition clears, **When** the diff is computed successfully, **Then** the full highlighted diff is returned and cached normally.

---

### User Story 3 - Word-level emphasis is deterministic per version pair (Priority: P2)

A user compares the same two versions of a document twice (or two users compare them). They see the same presentation both times: either word-level two-tier emphasis, or the line-level fallback — never one or the other depending on how busy the server happened to be when the diff was first computed.

**Why this priority**: Audit finding F9. The word-diff step degrades to line-level for two different reasons — a deterministic size cap, and a load-dependent timeout. Caching the timeout outcome freezes server-load luck as the permanent answer for that version pair.

**Independent Test**: Distinguishable degradation reasons can be asserted directly: a size-capped region yields a cacheable line-level result every time; a timeout-degraded computation yields a served-but-not-cached result, and a later request under normal load returns (and caches) the word-level result.

**Acceptance Scenarios**:

1. **Given** a replace region whose sides exceed the deterministic size cap, **When** the diff is computed, **Then** the region degrades to line-level presentation and the result IS cached (the outcome is identical on every recompute).
2. **Given** a word-diff computation that exceeds its time budget under load, **When** the diff is served, **Then** the served result uses the line-level fallback for the affected region(s) and NO cache entry is written.
3. **Given** the same version pair recomputed when the time budget is not exceeded, **When** the diff completes, **Then** the word-level result is returned and cached.
4. **Given** any of the above, **Then** the word-diff time budget itself is unchanged (it is an event-loop protection, not a tuning knob).

---

### User Story 4 - Chat and version history agree about which words changed (Priority: P2)

A user asks the in-app agent to compare two versions (chat surface) and also opens the same comparison in version history. Both surfaces emphasize the same words as changed. In particular, when a multi-line passage is rewritten with a line inserted at the top (shifting subsequent lines), neither surface falsely emphasizes unchanged text, and genuinely new trailing lines receive word emphasis rather than none.

**Why this priority**: Audit finding F10. Today the chat surface pairs removed/added rows positionally line-by-line while version history segments each replace region as a whole, so the two surfaces disagree about the same edit — violating the ratified two-surface parity criterion (022 SC-003) and the invariant documented on the shared segmentation helper.

**Independent Test**: Feed the same before/after document pair through both surfaces and assert the changed-character ranges match row-for-row (see SC-003 below for the exact criterion).

**Acceptance Scenarios**:

1. **Given** a replace region where a new sentence is inserted at the top of an otherwise-unchanged multi-line block, **When** each surface renders the comparison, **Then** the unchanged lines carry no strong word emphasis on either surface, and only the inserted sentence is emphasized — identically on both.
2. **Given** a replace region with more added rows than removed rows (or vice versa), **When** the chat surface renders it, **Then** the surplus rows receive word-emphasis data (today they receive none).
3. **Given** any replace region, **When** the chat surface emits per-row emphasis data, **Then** each row's emphasis segments rejoin byte-identically to that row's rendered text, and the client-facing data contract (per-row keyed segment arrays) is unchanged.
4. **Given** a replace region large enough to exceed the segmentation guardrails when taken as a whole, **When** the chat surface renders it, **Then** the whole region degrades to row-tint-only — the same fallback version history already uses for that region. (Accepted tradeoff, explicitly approved: guardrails now apply per-region rather than per-line, so very large replace regions fall back slightly more often in chat.)

---

### User Story 5 - The model stops paying for UI-only diff data (Priority: P2)

An agent (over MCP or in-app chat) requests a version comparison. The response the model consumes contains the diff rows, hunk positions, and formatting annotations — but not the per-word emphasis arrays, which exist only so the browser can highlight words and which the model can trivially derive from the -/+ rows anyway. Conversations with diffs in their history stop resending that data on every subsequent turn.

**Why this priority**: Audit finding F11. Roughly 1–3k wasted tokens per diff, resent on every turn of the conversation, across three independent leak paths — with zero model benefit.

**Independent Test**: Request a comparison via each of the three model-bound paths (MCP tool result, live in-app chat tool result, replayed chat history) and assert the word-emphasis field is absent from what the model receives, while hunk positions and formatting annotations are retained, and the browser-bound stored output still carries the segments.

**Acceptance Scenarios**:

1. **Given** a comparison invoked over MCP, **When** the tool result is serialized for the model, **Then** the word-emphasis field is stripped; hunk positions and formatting annotations are kept.
2. **Given** a comparison invoked in live in-app chat, **When** the tool result is sent to the model for the current turn, **Then** the same stripping applies — while the persisted output kept for the browser retains the segments.
3. **Given** a stored conversation containing past comparison results, **When** history is replayed to the model on later turns, **Then** the word-emphasis fields are stripped from replayed tool outputs.
4. **Given** the history replay path, **Then** stripping MUST NOT be implemented by handing per-tool output transforms to the history conversion step — doing so would re-inline image bytes that the image tools deliberately keep out of stored history. History stripping is a dedicated pass over stored parts (alongside the existing reasoning-strip pass).

---

### User Story 6 - Diff computation stops replaying the log twice (Priority: P3)

A user opens a comparison between two mid-history versions of a long document. The system reconstructs the two states by replaying the shared prefix once and only the in-between changes on top — not by replaying the full prefix twice. Results are byte-identical to today (convergence guarantee of the underlying document model); it is purely less work per request.

**Why this priority**: Audit finding F12. Pure efficiency; no behavior change.

**Independent Test**: Assert the diff output for representative version pairs is deep-equal before/after the change, and that each log row is applied at most once per reconstruction pass (e.g., via an application counter in tests).

**Acceptance Scenarios**:

1. **Given** any (previous, current) version pair, **When** the two document states are reconstructed, **Then** rows up to the previous version are applied once, the current state is seeded from the previous state, and only rows in (previous, current] are applied on top — with output identical to the double-replay result.
2. **Given** a comparison against the empty state (previous < 0), **When** states are reconstructed, **Then** the seeding step is skipped and behavior is unchanged.

---

### User Story 7 - The "Formatting changes only" banner tells the truth (Priority: P3)

A document contains literal prose about markup — e.g. the sentence "use \<div\> tags for layout". A user edits that prose and opens the comparison. The banner logic correctly detects that text changed; it never claims "Formatting changes only" over a diff that visibly shows text edits.

**Why this priority**: Audit finding F13. Metadata-only blast radius (the banner and identical-text short-circuit), but it visibly contradicts the diff it sits above.

**Independent Test**: Build two versions differing only inside literal angle-bracket prose and assert the extracted plain text differs (and the banner logic reports a text change).

**Acceptance Scenarios**:

1. **Given** a document containing literal angle-bracket text in its prose, **When** plain text is extracted for comparison metadata, **Then** the literal text is preserved verbatim (extraction walks the document structure instead of regex-stripping tag-like substrings).
2. **Given** two versions whose only difference is inside such literal text, **When** the comparison is computed, **Then** the result is a text change, not "Formatting changes only".
3. **Given** the diff computation entry points, **Then** the dead identical-text parameter that is declared but never read is removed (no behavior change).

---

### User Story 8 - History author badges keep a stable fallback color (Priority: P3)

A user views version history for a document where an author entry has no assigned color (a near-dead path). The badge falls back to a stable neutral color — the same one the server uses for missing identities — instead of a presence-palette color that deliberately rotates every day.

**Why this priority**: Audit finding F14. Lowest severity; a history record should not change color day to day.

**Independent Test**: Render the history author list with an author lacking a color and assert the badge uses the fixed neutral fallback, on two different (mocked) dates.

**Acceptance Scenarios**:

1. **Given** a history author entry without a color, **When** the badge renders on any date, **Then** it uses the stable neutral fallback (`#888888`), matching the server's no-identity fallback.
2. **Given** live presence indicators, **Then** their daily-rotating color scheme is untouched (deliberate product behavior; unifying the two systems is out of scope).

---

### Edge Cases

- **Empty read with a completeness expectation**: a diff request whose row fetch returns zero rows while the requested version is ≥ 0 is treated as an incomplete read (retry, then serve-without-caching) — not as an empty document.
- **Completeness is opt-in**: any reader that does not supply an expected newest version behaves byte-for-byte as today. The maintenance backfill job passes an "everything" sentinel upper bound and must never trip completeness retries.
- **Both degradations at once**: a diff that is simultaneously incomplete (torn/short read) and failure- or timeout-degraded is, of course, not cached — the no-cache conditions are OR-ed, never traded off.
- **Cache namespace cut-over**: existing cached entries may be tail-gap-poisoned and will not match the new output shapes; one namespace version bump (v9 → v10) discards them all. Old entries expire naturally; no purge job.
- **Region re-splitting must be lossless**: per-region word segmentation joins rows with newlines, segments once, and re-splits the segment stream at newline boundaries back into per-row arrays; because segmentation preserves its input verbatim, re-splitting is exact and every row's segments rejoin to that row's text.
- **History strip must be additive-only**: the replay strip removes fields from stored tool outputs; it must never trigger transforms that would ADD content the storage layer deliberately omits (image bytes).
- **Chat-only hard-break stripping**: the deliberate chat-only hard-break marker strip is adjacent to the changed code and must be left exactly as is.

## Requirements *(mandatory)*

### Functional Requirements

**Read completeness (F7)**

- **FR-001**: The version-log read path MUST accept an optional, caller-supplied expectation of the newest version that must be present (an expected tail clock). When supplied, a fetched row set is judged incomplete if it is empty or its newest row is older than the expectation — exactly as if it contained an internal gap — and MUST be retried within the existing single shared, bounded gap-retry budget (no new knobs, no per-path budgets).
- **FR-002**: The completeness expectation MUST be strictly opt-in. Callers that do not supply it MUST observe unchanged behavior. The meaningful-classification backfill (which reads with a maximum-value sentinel bound) MUST NOT incur completeness retries.
- **FR-003**: The version-comparison computation MUST supply its requested current version as the completeness expectation on its row fetch.
- **FR-004**: A comparison computed from a row set that is still incomplete after the retry budget (internal gap OR short tail) MUST be served to the requester but MUST NOT be written to the cache. (Extends ratified 023 FR-009 / D-2 — "a diff computed from a torn read must never be cached" — to cover tail-short reads, which are torn reads the gap detector cannot see.)

**Cache-write rules (F7, F8, F9)**

- **FR-005**: A comparison result MUST be written to the cache only when ALL of the following hold; if ANY fails, the result is served but not cached:
  - (a) the row set was complete: no internal gap and, when an expectation was supplied, no short tail (FR-004);
  - (b) the diff computation succeeded: the result does not carry the diff-failed flag (F8 — today a failed diff is cached for an hour and the "Diff highlighting unavailable" notice is frozen with no retry path);
  - (c) no word-level segmentation in the result degraded due to the time budget (F9). Degradation due to the deterministic size cap is cacheable — it produces the same output on every recompute.
  No other condition may suppress or force a cache write. Cache read/write transport errors remain non-fatal and logged, as today.
- **FR-006**: The word-segmentation helper MUST distinguish its two degradation reasons — deterministic size cap vs. load-dependent time budget — and surface the reason to callers (an out-of-band degradation signal threaded from the segmentation step through the version-history word-marking step to the comparison computation). The time budget value itself MUST NOT change.
- **FR-007**: The cache namespace version MUST be bumped exactly once (v9 → v10) to discard entries that may be tail-gap-poisoned or shaped by the pre-parity algorithms. No other cache key or TTL changes.

**Two-surface parity (F10)**

- **FR-008**: Both diff surfaces (chat/agent comparison output and version-history comparison) MUST derive word-level emphasis for a replace region from one shared per-region segmentation: each side's rows joined by newlines, segmented once as a whole, and the resulting segment streams re-split losslessly at newline boundaries into per-row segment arrays. The chat surface's positional row pairing (row k of removed vs. row k of added, surplus rows unemphasized) MUST be removed in favor of this shared computation.
- **FR-009**: In the chat surface, ALL rows of a replace region — including surplus rows beyond the shorter side's count — MUST receive emphasis segments when the region is within guardrails. Each row's segments MUST rejoin byte-identically to that row's rendered text. The client-facing data contract (segments keyed by stringified row index) MUST NOT change.
- **FR-010**: The segmentation guardrails (size cap, time budget) apply to the joined region, on both surfaces identically; a region that exceeds them degrades the WHOLE region to the existing row-tint / line-level fallback on the respective surface. (Approved visible change: less false emphasis on shifted rewrites; surplus rows gain emphasis; very large replace regions fall back to row-tint slightly more often in chat.)
- **FR-011**: The chat-only hard-break marker strip MUST remain untouched (ratified 028 behavior).

**Model-context hygiene (F11)**

- **FR-012**: UI-only word-emphasis data (the per-row segment arrays) MUST be excluded from every model-bound serialization of a comparison result, at all three seams: (a) the MCP tool-result serialization; (b) the live in-app chat tool result sent to the model for the current turn; (c) replayed tool outputs when stored conversation history is converted for the model on later turns. Hunk-position data and formatting annotations MUST be retained in all three.
- **FR-013**: Stored conversation history and the browser-bound tool output MUST continue to carry the emphasis segments (the browser renders from them). Stripping happens only on model-bound copies, never in storage.
- **FR-014**: History-replay stripping MUST be implemented as a dedicated pass over stored message parts (beside the existing reasoning-strip pass). It MUST NOT be implemented by passing tool definitions into the history-conversion step, because that would invoke the image tools' model-output transforms on history and re-inline image bytes those tools deliberately keep out of stored history.

**Efficiency & metadata correctness (F12, F13)**

- **FR-015**: Reconstructing the two document states for a comparison MUST apply each log row at most once: build the previous state, seed the current state from the previous state's encoded form (skipped when the previous version is the empty state, i.e. < 0), then apply only rows in (previous, current]. Garbage collection remains disabled on both reconstructions. Output MUST be identical to the double-replay result (CRDT convergence).
- **FR-016**: Plain-text extraction used for comparison metadata MUST preserve literal angle-bracket prose: it walks the document structure (recursing into element children and concatenating text-node inserts) instead of regex-stripping tag-like substrings from a serialized form. The identical-text and formatting-only signals MUST be computed from this faithful extraction.
- **FR-017**: The dead identical-text parameter on the markdown-diff computation (declared, never read) MUST be removed, with no behavior change.

**Stable history colors (F14)**

- **FR-018**: The version-history author badge's missing-color fallback MUST be a stable neutral (`#888888`, matching the server's no-identity fallback), not the date-salted presence palette. Presence colors and their deliberate daily rotation MUST NOT change.

### Key Entities

- **Comparison (diff) cache entry**: a frozen comparison result keyed by (namespace version, document, previous version, current version), TTL one hour. This feature makes its write conditions exact (FR-005) and bumps its namespace (FR-007).
- **Update-log row set**: the ordered version rows a comparison is computed from. Gains a notion of *tail completeness* relative to a caller-supplied expected newest version, alongside the existing internal-gap contiguity.
- **Replace region**: a removed block immediately followed by an added block in a line diff — the unit of word-level refinement, now segmented per-region on both surfaces.
- **Word-emphasis segments**: per-row arrays marking changed character ranges; a UI-only rendering aid, now stripped from all model-bound copies and losslessly re-split per row.
- **Degradation reason**: why word-level emphasis fell back to line-level — `size` (deterministic, cacheable) vs `timeout` (load-dependent, never cacheable).

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: Zero cached comparisons computed from incomplete reads: for any request whose row set was gapped or tail-short after the retry budget, no cache entry exists for that key afterward; a follow-up request after the log heals returns a comparison that includes the requested newest version. (Test-assertable via a delayed-commit harness.)
- **SC-002**: A transiently failed comparison recovers by the very next request: after one forced failure, the second request returns full highlighting. Time-to-recovery drops from up to 1 hour (cache TTL) to one request cycle.
- **SC-003 (two-surface parity)**: For any before/after document pair within guardrails, the changed-character ranges emitted by the chat surface and the version-history surface are equal — formally: for every replace region, per side, the ordered list of (row-relative start, end) ranges marked "changed" is identical across surfaces, and rows the chat surface leaves without segments are exactly the rows version history renders without word marks (i.e., none, when within guardrails; the whole region, when guardrails trip). This is directly assertable by a test driving both pipelines with the same inputs.
- **SC-004 (determinism)**: Repeating the same comparison request yields the same presentation tier every time: any cached entry re-served is byte-identical, and no load-dependent (timeout-degraded) result is ever re-served from cache.
- **SC-005**: Model-bound copies of comparison results contain no word-emphasis data on any of the three paths, saving roughly 1–3k tokens per diff per turn; browser rendering of both surfaces is pixel-unchanged for the untouched cases.
- **SC-006**: For a comparison between two mid-history versions, each log row is applied at most once during state reconstruction (down from up to twice), with byte-identical output.
- **SC-007**: Documents containing literal angle-bracket prose never show "Formatting changes only" over a text change; extraction preserves such prose verbatim.
- **SC-008**: The full existing diff/version-history test suites pass; the only intended visible changes are the four approved ones (surplus-row emphasis, reduced false emphasis on shifted rewrites, slightly-more-frequent row-tint fallback on very large chat replace regions, stable badge fallback color).

## Assumptions

- **Approved behavior change**: Sam explicitly approved the F10 visible change (shifted rewrites lose false emphasis; surplus rows gain emphasis; per-region guardrails make very large chat replace regions fall back to row-tint slightly more often — the same fallback version history already has).
- Cache TTL (1 hour) and the shared gap-retry budget (retries + delays, env-tunable) are unchanged; this feature only changes *when* a write is allowed and *what counts as incomplete*.
- The word-diff time budget (250ms) is an event-loop guard and stays at its current value.
- Serving an uncacheable (incomplete/failed/timeout-degraded) comparison keeps today's user-facing presentation (existing notices, line-level fallback); no new UI states are introduced.
- Ratified priors respected: 022 SC-003 (two-surface parity) and FR-012 (fail-open), 023 FR-009/D-2 (torn reads never cached), 028 (chat-only hard-break strip stays chat-only).
- **No schema changes**: this feature requires and permits NO database migration (feature 038 owns the only in-flight migration slot). Everything here is read-path, cache-namespace, serialization, and client-fallback work.

## Out of Scope (verified non-goals)

- Unifying the two diff pipelines (line-diff + rich-document rendering vs. structured-patch + string rows) — contracts and consumers differ entirely.
- Merging the two plain-text extractors, or deduplicating the formatting-only detection and fail-open patterns across surfaces.
- The chat-only hard-break strip (deliberate; stays chat-only per 028).
- Unifying presence and history color systems (daily presence rotation is deliberate; unification is a separate product decision).
- Changing the MCP result pretty-print indentation.
- Per-change author attribution inside diffs.
- Anything in the websocket/attribution layer (feature 038) or restore/undo (feature 040).
- Any database migration.

## Coordination with Feature 038 (attribution integrity)

Feature 038 is being specified and implemented concurrently. Both features touch `server/postgres-persistence.js`, **but in disjoint functions**:

- **038 owns the WRITE path**: `storeUpdate` and anything on the update-persistence side. 039 implementers MUST NOT modify it.
- **039 owns the READ path**: `getUpdateRowsUpTo`, `_fetchRowsWithGapRetry`, and `_findFirstGap`. 038 implementers MUST NOT modify these.
- 039 MUST NOT touch `server/index.js`, `server/origin.js`, or `server/document-service.js` (038 territory), and MUST NOT add any node-pg-migrate migration (038 holds the migration slot; 039 needs none).
