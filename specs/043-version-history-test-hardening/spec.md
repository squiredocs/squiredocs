# Feature Specification: Version History Test Hardening

**Feature Branch**: `043-version-history-test-hardening`

**Created**: 2026-08-02

**Status**: Draft

**Input**: User description: "043-version-history-test-hardening — test hardening for version history / attribution guarantees (E1-E8 from tmp/version-history-deep-dive-2026-08-02.md)"

**Source findings**: `tmp/version-history-deep-dive-2026-08-02.md`, section E (test-coverage audit). All coverage claims were re-verified against the actual test files on 2026-08-02 before this spec was written; every claim held (see Verification Notes).

**Sequencing**: This feature merges **last**, after 041 (truth fixes), 042 (refactors), 044 (presence guard), and 045 (resupply attribution), so its tests target the settled code. The 045 interlock is load-bearing: US2/FR-003's reconnect E2E asserts the via_sync-aware timeline that 045 delivers — merging this feature before 045 would run that suite RED against a known-corrupted display path (added 2026-08-02 per RBD-045-7). Tests whose subject depends on earlier features are flagged inline with `[depends: 041]` / `[interacts: 042]`.

## Purpose

The product promise for collaboration is "100% accurate attribution, never lose edits." The deep dive found the core machinery sound but the test suite dishonest about how much of that promise it actually guards: the flagship attribution regression test asserts nothing (`expect(true).toBe(true)`), several suites test in-file re-implementations of production code rather than the code itself, the two most loss-prone paths (reconnect catch-up, persistence failure of a live edit) have no end-to-end coverage, and two user-facing components have no tests at all. This feature closes those gaps with tests only — production code changes are limited to minimal, behavior-preserving extractions needed to make real code testable.

## User Scenarios & Testing *(mandatory)*

The "user" of this feature is the maintainer (and every future agent session) relying on the suite as the sole reviewer (Constitution Principle II). Each story is a slice of the product promise that today has no honest guard.

### User Story 1 - End-to-end attribution regression coverage (Priority: P1)

The historical misattribution bug — a human's edits credited to an AI agent because the agent connected first — has zero regression coverage. A real end-to-end test connects two authenticated WebSocket clients (one human token, one agent token) through the production upgrade/connection-setup/document-binding path, both edit the same document, and the test asserts the recorded author identity (`user_id`, `agent_name`) on **every** persisted update row. This replaces the placeholder file `server/__tests__/attribution-bug.test.js`, whose substantive blocks are literally `expect(true).toBe(true)`.

**Why this priority**: This is the flagship scenario of the product promise, the one bug class the company has actually shipped, and the single dishonest test that claims to cover it. Every other story hardens edges; this one guards the center.

**Independent Test**: Run the new suite alone against the test database; it fails if any persisted update row carries the wrong or missing identity, and it fails if the connection path stops attributing (e.g., someone reintroduces awareness-based agent detection).

**Acceptance Scenarios**:

1. **Given** a real server exposing the production WebSocket upgrade path, **When** an agent-token client connects first and a human-token client connects second and both make edits, **Then** every update row from the human carries the human's `user_id` with no `agent_name`, and every update row from the agent carries the agent identity — the original bug ordering (agent first) is explicitly exercised.
2. **Given** the same setup, **When** the connection order is reversed (human first, agent second), **Then** attribution is equally correct — order never influences identity.
3. **Given** the new test exists and passes, **When** the placeholder blocks in `attribution-bug.test.js` are removed, **Then** no `expect(true).toBe(true)` assertions remain anywhere in the attribution coverage.

---

### User Story 2 - Reconnect catch-up honesty (Priority: P2)

When a client reconnects and re-supplies missed content via the sync protocol's catch-up frame, those rows must be recorded as sync-relayed (`via_sync=true`), the version timeline must not credit the relaying client as an author of content it merely carried, and undo derivation must refuse to invert across such rows. Today this is covered only by unit tests that fabricate the rows; no test drives a real catch-up frame through the wire protocol.

**Why this priority**: Reconnect re-supply is the highest-volume path by which one user's client transmits another user's content. If the `via_sync` marking regresses, attribution silently lies at scale — and only an end-to-end test can catch a regression in the frame-handling layer that the fabricated-row unit tests bypass.

**Independent Test**: Run the new suite alone; it fails if a real catch-up frame produces rows without the sync marker, if the timeline credits the relayer, or if undo derivation crosses the sync boundary.

**Acceptance Scenarios**:

1. **Given** client A has edits the server has not seen (server restarted or doc evicted mid-session), **When** A reconnects and the sync handshake's catch-up step delivers the missed content, **Then** the resulting rows are persisted with `via_sync=true` under A's identity.
2. **Given** such sync-relayed rows exist, **When** the version timeline is computed, **Then** the relayed content does not add the relayer as an author of a version they did not originally write.
3. **Given** an undo request whose derivation would need to invert across a `via_sync=true` row, **When** undo availability/derivation runs, **Then** it refuses (matching the existing designed behavior), asserted through the real end-to-end row shape rather than a hand-built one.

---

### User Story 3 - Pin the fate of a persistence-failed live edit (Priority: P2)

A live WebSocket edit whose database write fails through all retries is the purest "never lose edits" scenario, and it is untested. A test induces transient persistence failure (retries exhausted) for a real WS edit and pins what actually happens to that edit: whether it survives anywhere durable or is silently dropped.

**Why this priority**: This is the direct edit-loss path. The publish-before-commit window was consciously deferred in 038 (FR-018, documentation-only closure); a test must now make the deferred behavior *visible* so it can never silently widen.

**Independent Test**: Run the suite alone; it deterministically induces persistence failure and asserts the pinned outcome.

**Acceptance Scenarios**:

1. **Given** a connected client and a persistence layer rigged to fail a specific update through all retry attempts, **When** the client makes that edit, **Then** the test asserts the observed outcome exactly (row absent / row present / error surfaced) — no vague "should probably" language.
2. **Given** the observed outcome is silent loss from the durable log (the edit stays live in connected editors but is absent from history and later restores), **Then** the test documents this as a **known limitation** in its header, explicitly tied to the 038-deferred publish-before-commit window — this feature does **not** spec a product fix. [RATIFIED-BY-DEFAULT — see clarifications ledger, D1]
3. **Given** a later feature closes the window, **When** the behavior changes, **Then** this characterization test fails loudly, forcing the limitation note to be retired deliberately.

---

### User Story 4 - Restore under concurrency (Priority: P2)

All existing restore tests run on quiescent documents. Two new end-to-end tests cover: (a) a restore racing a concurrent live edit, and (b) two concurrent restores of the same document. **These tests target feature 041's behavior, in which restore reads from the live document** (not a separate database read) — this feature merges after 041. [depends: 041]

**Why this priority**: Restore is the "get my content back" promise; concurrency is exactly when users reach for it (someone just clobbered the doc, others are still typing). The deep dive (B3) showed the current stored restore row can differ from what the label claims under concurrency; 041 changes the mechanism, and these tests pin the post-041 invariants.

**Independent Test**: Run the suite alone; it fails if concurrent activity during restore loses content, corrupts attribution of the restore row, or leaves the document in a state neither restore produced.

**Acceptance Scenarios**:

1. **Given** a document with version history and a connected client actively editing, **When** a restore to an earlier version runs concurrently with a live edit, **Then** the live edit is not lost (it survives in the document and in the durable log with its own attribution) and the restore row is attributed to the restorer, matching 041's defined semantics for what the restore row contains.
2. **Given** two restore requests to different target versions issued concurrently, **When** both complete, **Then** the document converges to a state produced by one of the two restores (a serializable outcome — never an interleaved hybrid neither user requested), both restore rows are individually attributed, and version history remains readable end-to-end.
3. **Given** either scenario, **Then** the test asserts invariants rather than one lucky interleaving (i.e., it must not depend on a specific race winner). [RATIFIED-BY-DEFAULT — D2]

---

### User Story 5 - Mirror-tests replaced by real-code tests (Priority: P3)

Three suites currently test in-file re-implementations that can silently drift from production: the document-binding classify listener mirrored in `update-classifier.test.js` (line 116), the Redis publish skip-list copied in `origin.test.js` (lines 23-25), and the undo-status route handler replicated in `undo-status-api.test.js`. Each is replaced by a test that drives the **real** production code; where the real code is not currently importable, a minimal, behavior-preserving extraction (function moved to an importable unit, call site updated, byte-for-byte logic) is in scope. [interacts: 042 — if the refactor feature already extracted the same unit, reuse it; do not re-extract]

**Why this priority**: A mirror-test passes forever regardless of what production does — it is worse than no test because it reports coverage that does not exist. All three named mirrors were verified present on 2026-08-02.

**Independent Test**: For each of the three, deliberately breaking the production code (locally) makes the corresponding test fail; breaking only the old mirror location no longer has a test asserting it.

**Acceptance Scenarios**:

1. **Given** the classify-listener test, **When** it runs, **Then** it invokes the production listener (or its extracted equivalent actually called by the binding path), not an in-test `runListener` re-implementation.
2. **Given** the Redis publish-routing test, **When** it runs, **Then** the skip-list predicate under test is the one production consults — a change to production routing that the test copy would have masked now fails the test.
3. **Given** the undo-status endpoint test, **When** it runs, **Then** the HTTP behavior asserted (role gating, error → `{false,false}`, derivation call) is produced by the production handler, not a hand-copied one.
4. **Given** any extraction performed for testability, **Then** all pre-existing tests still pass and no runtime behavior changes (extraction is move-only).

---

### User Story 6 - Diff parity from one real fixture, divergence pinned (Priority: P3)

The existing two-surface diff parity suite hand-builds text rows and feeds them into each surface's post-processing half, bypassing each side's upstream diff computation entirely. A new end-to-end parity test starts from a **shared document fixture** (one real collaborative document state pair) and drives **both complete production pipelines** — chat diff and version-history diff — asserting parity on the plain-prose corpus where parity is the ratified contract. Additionally, characterization tests pin the **current, knowingly divergent** chat-vs-history output for markdown-syntax regions (bold/emphasis syntax, escapes, hard breaks), so the accepted divergence (039 A1) can never drift silently.

**Why this priority**: Parity is a ratified success criterion (022 SC-003, re-scoped in 039); today's harness would not catch a regression introduced in either pipeline's upstream half. The divergence is accepted — but accepted behavior that is unpinned is behavior that changes without anyone deciding.

**Independent Test**: Run the suite alone; it fails if the two full pipelines disagree on plain prose, or if the divergent markdown-syntax outputs change from their pinned shapes.

**Acceptance Scenarios**:

1. **Given** a shared before/after document fixture containing plain prose changes, **When** both full production pipelines compute their diff, **Then** the changed-word ranges agree (the existing range-extraction comparison currency may be reused).
2. **Given** fixture regions containing bold syntax, escaped characters, and hard breaks, **When** both pipelines run, **Then** each surface's current output is asserted exactly (characterization), with a header stating the divergence is accepted per 039 A1 and any change requires ratify-or-fix.

---

### User Story 7 - Component coverage for the version-history UI (Priority: P3)

`VersionHistoryPanel` and `VersionPreview` have no tests at all (verified: no test file exists for either; sibling `VersionConfirmDialog` has one). New component tests cover, at minimum: diff-document rendering, the selection → preview → restore wiring, restore-attribution labels, and error-state rendering. [depends: 041 — 041 introduces the rendered error states; label semantics follow the 2026-08-02 design amendment: web-UI restores are NOT undo targets]

**Why this priority**: These components are where the attribution promise becomes visible to users; the deep dive found real display-layer bugs (B4: failed loads render as "no history yet") in exactly this untested area. Tests here also protect 041's fixes from regressing.

**Independent Test**: Run the frontend component suites alone; each of the four coverage areas has at least one failing-mode assertion.

**Acceptance Scenarios**:

1. **Given** a version with diff content, **When** the preview renders, **Then** the diff document (including changed-word emphasis) appears in the rendered output.
2. **Given** the panel with a version list, **When** a version is selected and restore is confirmed, **Then** the preview shows that version and the restore action fires with that version's identity (wiring, not styling).
3. **Given** versions authored by a human, an agent, and a restore action, **When** rendered, **Then** attribution labels match the post-040/041 semantics (restores labeled as restores with the restorer; web-UI restores never presented as undo targets).
4. **Given** a history load or diff load failure, **When** the components render, **Then** the error state renders as an error (per 041) — never as the "no history yet" empty state or the neutral placeholder.

---

### User Story 8 - Flake hygiene in the version/undo suites (Priority: P3)

Three known flake shapes get resolved: (a) version/undo DB suites insert update-log rows with no matching search-index rows — the same shape as the known CI reindexStale flake — and this feature records and applies a per-suite convention for it; (b) `postgres-gap-read.test.js` contains nine wall-clock `< 300ms` assertions that fail on slow CI runners — replaced with injected clocks or behavioral assertions (e.g., retry-count spies) where feasible, tolerant bounds otherwise; (c) `__tests__/integration/collaboration.test.js` uses sleep-based propagation waits (`tick(50)`) — noted, with deterministic waits substituted where the change is low-risk.

**Why this priority**: A flaky guard is an ignored guard; the whole point of this feature is a suite whose failures are believed.

**Independent Test**: The affected suites pass repeated consecutive serial runs; no wall-clock `< 300ms` assertion remains in `postgres-gap-read.test.js`.

**Acceptance Scenarios**:

1. **Given** any suite in this feature (new or modified) that inserts update-log rows, **Then** it follows the recorded convention: all inserted rows are cleaned up **by `doc_guid` in `finally`/`afterAll`**, including rows created indirectly, so the global reindexStale scan can never find this suite's orphans. The convention is recorded once (in the suites' shared helper documentation) and applied to the existing version/undo suites that currently violate it. [RATIFIED-BY-DEFAULT — D3]
2. **Given** `postgres-gap-read.test.js`, **When** the hygiene pass lands, **Then** each former `< 300ms` assertion either asserts the behavior it was proxying (no retry occurred) via injected clock or call-count, or uses a CI-tolerant bound with a comment stating what it guards.
3. **Given** the collaboration integration test, **Then** its sleep-based waits are documented at minimum, and replaced with event/condition waits where doing so does not destabilize the suite.

---

### Stretch scope (honorable mentions, in scope only if budget allows)

- **S1**: Duplicate version-name collision — a test pinning behavior when two versions receive the same name.
- **S2**: A real assertion for `mergeNamedVersions` with null `clock_start` (currently unasserted).
- **S3**: Crash-window consistency for undo claims — claim finalized durably, process dies before the live apply; a test pinning what the next undo-status/derivation sees.

### Explicitly deferred (out of scope)

- **Browser E2E (Playwright)**: no browser-driven end-to-end tests in this feature; Sam owns browser walks. Recorded as deferred, not forgotten.
- **Any product fix** for the publish-before-commit window (038 FR-018 deferral stands; US3 only pins and documents it).
- **Chat-side extractPlainText misclassification fix** (deep dive F: scoped as a separate chat-side feature by 039).

### Edge Cases

- A new WS test's client disconnects or the server under test crashes mid-test: cleanup by `doc_guid` must still run (hence `finally`/`afterAll`, not inline cleanup).
- Concurrency tests (US4) hitting a different interleaving on CI than locally: assertions must hold for **every** legal interleaving (invariant-style), never a single race outcome.
- The induced persistence failure in US3 leaking rigged state into later tests: failure injection must be scoped to the specific update and torn down deterministically.
- US5 extraction targets already moved by 042: plan phase must reconcile against 042's merged state before extracting (reuse, never duplicate).
- 041's final restore semantics differing in detail from the deep dive's description: US4/US7 tests are written against 041's **merged** behavior, and any mismatch with this spec's description is resolved in 041's favor with a note in the ledger.
- Serial-only DB: none of the new suites may assume exclusive DB state beyond their own `doc_guid`s; no new suite may require a parallel runner.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: The suite MUST contain an end-to-end attribution test in which two clients authenticated as distinct identities (one human, one agent) connect through the production WebSocket upgrade and document-binding path and edit the same document, and which asserts the recorded author identity on every persisted update row, in both connection orders (US1).
- **FR-002**: The placeholder assertions in `server/__tests__/attribution-bug.test.js` MUST be removed; no test in the attribution area may pass vacuously (no assertion-free or tautological tests).
- **FR-003**: The suite MUST contain an end-to-end test in which a real sync-protocol catch-up frame produces persisted rows marked `via_sync=true`, and MUST assert that the version timeline does not credit the relaying client for relayed content and that undo derivation refuses across such rows (US2).
- **FR-004**: The suite MUST contain a test that induces exhausted persistence retries for a live WebSocket edit and pins the exact observed outcome; if the outcome is silent loss from the durable log, the test MUST document it as a known limitation tied to the 038-deferred publish-before-commit window, and this feature MUST NOT change the production behavior (US3).
- **FR-005**: The suite MUST contain restore-concurrency tests — restore vs. one concurrent live edit, and two concurrent restores — written against feature 041's restore semantics, asserting: no loss of the concurrent edit, correct attribution of every resulting row, and a serializable final document state (US4).
- **FR-006**: The tests for the document-binding classify listener, the cross-instance publish skip-list, and the undo-status endpoint MUST exercise the production code path; in-test re-implementations of those three units MUST be removed (US5).
- **FR-007**: Production code changes MUST be limited to minimal, behavior-preserving extractions required by FR-006; each extraction is move-only, keeps all existing tests green, and MUST first check whether feature 042 already provides the extracted unit (US5).
- **FR-008**: The suite MUST contain an end-to-end diff parity test driving both complete production diff pipelines from a shared document fixture, asserting changed-range parity on plain-prose regions, plus characterization tests pinning the current divergent outputs for bold/escape/hard-break regions with an explicit accepted-divergence note (US6).
- **FR-009**: Component tests MUST exist for `VersionHistoryPanel` and `VersionPreview` covering at minimum: diff-document rendering, selection→preview→restore wiring, restore-attribution labels per post-040/041 semantics, and error-state rendering per 041 (US7).
- **FR-010**: Every new or modified integration test that inserts update-log rows MUST clean up by `doc_guid` in `finally`/`afterAll`; the convention for the update-log/search-index orphan shape MUST be recorded once and applied to the existing version/undo suites that currently orphan rows (US8).
- **FR-011**: `postgres-gap-read.test.js` MUST contain no bare wall-clock `< 300ms` assertions after this feature: each is replaced by an injected clock, a behavioral assertion, or a CI-tolerant bound with a stated rationale (US8).
- **FR-012**: All backend suites in this feature MUST run under the repository's serial-only backend DB convention; no new suite may require or assume concurrent DB runs.
- **FR-013**: Browser-driven E2E coverage MUST be recorded as deferred (owner: Sam) and MUST NOT be attempted in this feature.
- **FR-014**: Every characterization test (FR-004 outcome, FR-008 divergence pins) MUST carry a header comment naming the accepted behavior and the decision it traces to (038 FR-018; 039 A1), so a future change fails loudly and points at the decision to revisit.

### Key Entities

- **Attributed update row**: one persisted document change; carries author identity (`user_id`, optional `agent_name`), a sync-relay marker (`via_sync`), and a meaningfulness classification. The unit whose honesty every backend test here guards.
- **Sync catch-up frame**: the protocol step by which a reconnecting client re-supplies content the server missed; its rows must be identity-preserving but relay-marked.
- **Shared diff fixture**: one before/after pair of real document states from which both diff surfaces compute; the common input that makes parity assertions meaningful.
- **Suite cleanup convention**: the recorded rule (delete by `doc_guid` in `finally`/`afterAll`) that keeps suites from poisoning the shared serial database or the global reindex scan.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: The historical misattribution scenario (agent connects before human) is covered by a test that fails when identity recording breaks; zero tautological assertions remain in the attribution coverage (today: 2 `expect(true).toBe(true)` blocks).
- **SC-002**: 100% of persisted update rows produced in the new end-to-end suites are asserted for author identity — none are merely counted.
- **SC-003**: The three named mirror re-implementations (classify listener, publish skip-list, undo-status handler) are gone; for each, a deliberate local break of the production unit fails at least one test.
- **SC-004**: The fate of a persistence-failed live edit is pinned by exactly one authoritative test whose header states whether the edit survives, and which decision accepted that outcome.
- **SC-005**: Both diff pipelines are exercised end-to-end from a shared fixture; the count of pinned divergence cases for markdown-syntax regions is ≥ 3 (bold, escapes, hard breaks).
- **SC-006**: `VersionHistoryPanel` and `VersionPreview` each have a component test file; all four required coverage areas have at least one assertion each, including one failure-path rendering assertion.
- **SC-007**: The full backend suite passes 3 consecutive serial runs on the shared test database with zero failures attributable to the addressed hygiene shapes; `grep` for `< 300` wall-clock assertions in `postgres-gap-read.test.js` returns none.
- **SC-008**: No production behavior changes: outside the deliberate mirror-test replacements, all pre-existing tests pass unmodified, and every production diff is a move-only extraction traceable to FR-006/FR-007.

## Assumptions

- **Merge order holds**: 041 and 042 merge before this feature. If 041's merged restore/error-state semantics differ from the deep-dive description used here, 041's merged behavior wins and the affected acceptance scenarios (US4, US7) are read against it.
- **042 overlap**: 042's refactors may already extract some units named in US5 (e.g., listener or handler extraction); the plan phase reconciles and reuses rather than re-extracting.
- **Undo-refusal across sync rows** (US2) is existing designed behavior (feature 016 / ws-edit-gate); the new coverage changes its *evidence* (real frames vs. fabricated rows), not its definition.
- **Design ground truth**: restore-attribution label semantics follow `design/collaboration-core.md` including the 2026-08-02 amendment — web-UI restores are NOT undo targets. Tests must not assert the pre-amendment behavior.
- **Serial DB is a hard constraint**: the backend test database is shared and serial-only; concurrency in US4 is concurrency *inside one suite's own requests*, never concurrent test runs.
- **No new test infrastructure products**: existing helpers (`server/__tests__/helpers/db.js`, the y-websocket utilities already used by `__tests__/integration/collaboration.test.js`) are the starting point; new helpers are added only where the real upgrade path requires them (JWT-authenticated upgrade harness for US1/US2).
- All open product decisions in this feature were resolved by best-default and recorded as **RATIFIED-BY-DEFAULT (Sam pre-authorized, 2026-08-02)** in `clarifications-needed.md`; none block work.

## Verification Notes (claims re-checked 2026-08-02)

Every deep-dive section-E claim this spec relies on was verified against the working tree before writing:

- `server/__tests__/attribution-bug.test.js`: two `expect(true).toBe(true)` blocks (lines 114, 137) plus token-decode-only tests — asserts nothing about the server. **Confirmed.**
- `update-classifier.test.js:116`: in-test `runListener` mirror of the binding listener. **Confirmed.**
- `origin.test.js:23-25`: local `shouldPublishToRedis` copy of the production skip-list ("Mirrors the redisUpdateHandler skip-list … exactly"). **Confirmed.**
- `undo-status-api.test.js:40-61`: "Mirror of the server/index.js endpoint handler" — replicated route. **Confirmed.**
- `via_sync` coverage: only fabricated-row unit tests (`identity-predicate`, `legacy`, `ws-edit-gate`, `collab-guardrail`); no end-to-end catch-up frame test. **Confirmed.**
- `postgres-gap-read.test.js`: nine `toBeLessThan(300)` wall-clock assertions (lines 155-605). **Confirmed.**
- `__tests__/integration/collaboration.test.js`: uses `setupWSConnection` directly (no production upgrade/auth), calls `storeUpdate(docGuid, update)` with no identity arguments, and uses `tick(50)` sleep waits — identity is discarded end to end. **Confirmed.**
- No component test exists for `VersionHistoryPanel` or `VersionPreview` (sibling `VersionConfirmDialog.test.jsx` exists). **Confirmed.**
- `diff-two-surface-parity.test.js`: hand-built rows fed to `postProcessDiffLines`/`applyWordMarks`, bypassing each surface's upstream diff computation; no shared Y.Doc fixture. **Confirmed.**
- Version/undo DB suites insert `yjs_updates` rows with no matching `search_index` rows (no `search_index` writes anywhere in those suites). **Confirmed.**

No section-E claim was falsified.
