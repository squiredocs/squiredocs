# Clarifications Ledger: 043-version-history-test-hardening

All decisions below were resolved with best defaults and are recorded as
**RATIFIED-BY-DEFAULT (Sam pre-authorized, 2026-08-02)**. None block work; any can
be reversed by amending the spec before the plan phase.

## D1 — Persistence-failure outcome is pinned, not fixed (US3 / FR-004)

**Question**: If the transient-DB-failure test proves a WS edit is silently dropped
from the durable log after retries are exhausted, do we fix it here?

**Decision**: No. The test pins the observed outcome as a characterization test and
documents it as a known limitation tied to the 038-deferred publish-before-commit
window (038 FR-018, documentation-only closure). A product fix is a separate,
deliberate feature. Rationale: this feature's contract is tests-only; widening it
into durability engineering would couple a test-hardening merge to a high-risk
hot-path change.
**RATIFIED-BY-DEFAULT (Sam pre-authorized, 2026-08-02)**

## D2 — Concurrency tests assert invariants, not interleavings (US4 / FR-005)

**Question**: Should the restore-concurrency tests assert one specific race outcome
(deterministic ordering via injected barriers) or outcome invariants?

**Decision**: Invariants: the concurrent edit survives with its own attribution,
every restore row is attributed to its restorer, and the final state is one the
system could have produced serially (never an unrequested hybrid). Barriers may be
used to *provoke* overlap, but assertions must hold for every legal interleaving so
the tests are CI-stable. Rationale: interleaving-pinned tests are flake factories,
and flake hygiene is itself in scope (US8).
**RATIFIED-BY-DEFAULT (Sam pre-authorized, 2026-08-02)**

## D3 — Orphaned-row convention: cleanup-by-doc_guid, recorded once (US8 / FR-010)

**Question**: For the yjs_updates-without-search_index flake shape (the reindexStale
CI flake), adopt a per-suite heal (insert matching search_index rows / handle the
`si.doc_id IS NULL` branch) or a fixture/cleanup convention?

**Decision**: Cleanup convention: every suite that inserts update-log rows deletes
them by `doc_guid` in `finally`/`afterAll` (already mandated for new tests), applied
retroactively to the existing version/undo suites that currently leave orphans, and
recorded once in the shared test-helper documentation so future suites inherit it.
A per-suite search_index heal is NOT adopted: it papers over orphans instead of
removing them, and the real fix (DB isolation) is tracked separately. Rationale: the
flake exists because orphans persist past suite end; deleting them removes the shape
entirely rather than compensating for it.
**RATIFIED-BY-DEFAULT (Sam pre-authorized, 2026-08-02)**

## D4 — Wall-clock assertions: behavior first, tolerant bounds second (US8 / FR-011)

**Question**: Replace `< 300ms` assertions with injected clocks, retry-count spies,
or larger bounds?

**Decision**: Preference order: (1) assert the proxied behavior directly (e.g., "no
retry occurred" via call-count/spy or injected clock) — this is what the 300ms was
standing in for; (2) where the code path cannot take an injected clock without a
production change beyond this feature's extraction budget, keep a wall-clock bound
but CI-tolerant and commented with what it guards. No bare `< 300` remains.
**RATIFIED-BY-DEFAULT (Sam pre-authorized, 2026-08-02)**

## D5 — 041/042 dependency handling

**Question**: 041 (truth fixes: restore reads the live doc, error states rendered)
and 042 (refactors) are in flight in parallel; their merged shape may differ from
the deep-dive descriptions this spec used.

**Decision**: This feature merges last. Tests flagged `[depends: 041]` (US4 restore
semantics, US7 error-state rendering and labels) are written against 041's **merged**
behavior; where it differs from this spec's prose, 041 wins and the divergence is
noted here. US5 extractions are reconciled against 042's merged state at plan time —
reuse an existing extraction, never duplicate one.
**RATIFIED-BY-DEFAULT (Sam pre-authorized, 2026-08-02)**

## D6 — Stretch items are stretch, not scope creep

**Question**: Are the honorable mentions (duplicate version-name collision,
`mergeNamedVersions` null `clock_start`, undo-claim crash-window) committed scope?

**Decision**: They are P4 stretch: implemented only if the P1-P3 stories land with
budget remaining; omitting them does not fail the feature. They are listed in the
spec so the tasks phase can sequence them last and drop them cleanly.
**RATIFIED-BY-DEFAULT (Sam pre-authorized, 2026-08-02)**

## D7 — Browser E2E deferred

**Question**: Should component coverage (US7) extend into browser-driven E2E now
that Playwright is available in the pod?

**Decision**: No. Browser E2E (Playwright) is explicitly deferred; Sam owns browser
walks. This feature stops at component tests. Recorded so the deferral is a
decision, not a gap.
**RATIFIED-BY-DEFAULT (Sam pre-authorized, 2026-08-02)**

## D8 — Attribution labels follow the 2026-08-02 design amendment

**Question**: Which restore/undo label semantics do US7's assertions encode —
pre-040 (restores undoable) or the amended ground truth?

**Decision**: The amended ground truth in `design/collaboration-core.md`
(2026-08-02 amendment): web-UI restores are NOT undo targets; an agent's restore IS
a recorded edit its own undo tool inverts (040 FR-004 survived the cut). Tests must
not resurrect the pre-cut behavior.
**RATIFIED-BY-DEFAULT (Sam pre-authorized, 2026-08-02)**
