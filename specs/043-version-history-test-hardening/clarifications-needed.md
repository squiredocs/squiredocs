# Clarifications Ledger: 043-version-history-test-hardening

---

## Re-verification against merged main (T001-T012), 2026-08-02

Base: `main` at **ddcb6ca9**. Merge SHAs confirmed present before any work:

| Feature | Merge SHA |
|---|---|
| 041-version-history-truth | `e6340ce0` |
| 042-version-history-simplification | `ee52edd3` |
| 044-presence-awareness-guard | `e39d9481` |
| 045-resupply-attribution | `c4083f1d` |

Baseline before any change: **242 suites, 4367 tests, all green.**

### Divergences found, all resolved in 041/042/044/045's favor (D5)

1. **D9's ceiling was surveyed too narrowly — the blocking finding.** T004
   confirmed 038's C1 guard intact (`installGate` once, the `tokenMayWrite`
   literal), and it stayed intact. But **041 added its own structural pins to
   `server/index.js`** in `server/__tests__/bindstate-failure.test.js:259-283`,
   greping for `if (ydoc._bindFailed) return;` and the `refuseBind({...})` call
   — both inside the block X1 moves. X1 was implemented and reverted; see
   `promotion-notes.md` §1. **US1, US2, US3 and US5(a) are consequently not
   delivered.**

2. **X3's negative guard had to be narrowed.** The contract's G5 says index.js
   must contain no `origin === ORIGIN_REDIS` literal. It legitimately does: the
   **awareness** publish handler (`redisAwarenessHandler`) keeps its own
   feedback-loop check, which is a different predicate on a different event and
   is not part of X3. G5b greps for the document skip-list pair
   (`ORIGIN_REDIS || ORIGIN_DB_LOAD`) instead.

3. **The wall-clock count is EIGHT, not nine** (spec Verification Notes say
   nine; analyze C3 said eight). Confirmed eight post-merge, at lines 155, 173,
   201, 210, 291, 324, 555, 605. All eight replaced.

4. **US7's target files already exist.** The spec says `VersionHistoryPanel` and
   `VersionPreview` have "no tests at all" (verified true at spec time). 041 and
   042 added `VersionHistoryPanel.test.jsx`, `VersionPreview.test.jsx` and two
   `.characterization.test.jsx` siblings. SC-006's "each has a component test
   file" was therefore already satisfied on arrival, and the four coverage areas
   were partly covered: **error-state rendering was complete**, diff rendering
   was shallow, and selection→restore wiring and attribution labels were absent
   at the panel level. US7 extended the existing files rather than creating new
   ones, which is the correct post-041/042 reading.

5. **042's prop collapse does not need a provider wrapper (T008).**
   `VersionHistoryPanel` *is* the `VersionHistoryProvider` — it still declares
   every prop and memoizes them into context for its list subtree. So plain
   prop-based `render()` is the correct harness; wrapping it in a provider would
   test the wrong thing.

6. **D8's label assertion had to be reframed.** There is no restore-specific
   label or undo affordance anywhere in the version-history UI — 040's cut
   removed the concept entirely. So "restores labelled as restores with the
   restorer" has no rendered counterpart to assert. US7 asserts the honest
   version instead: the author names the server resolved (human, agent,
   045's synced-content marker) plus an explicit **negative** that no undo
   affordance exists for a web-UI restore.

7. **The API-token table is `mcp_api_tokens`**, not `api_tokens` as the harness
   contract's identity section says. Moot in the end — the harness was not built.

8. **`cleanupDocRows` deletes only `yjs_updates`.** The contract implies also
   clearing search-index rows; `document_search_index` and `document_embeddings`
   are both `ON DELETE CASCADE` from `documents`, so `cleanupTestUser` already
   removes them. That asymmetry is exactly *why* the orphan is an update-log row
   with no index row.

9. **T010 confirmed clean**: `computeChatDiff(mdBefore, mdAfter)` and
   `computeMarkdownDiff(prevDoc, currDoc, report, currPmDoc = undefined)` both
   unchanged by 042 (the default keeps `.length === 3` for 039's pin).

10. **T011 do-not-touch list** (044's awareness coverage, duplicated by nothing
    here): `server/__tests__/ws-awareness-guard.test.js`,
    `server/__tests__/awareness-removal-propagation.test.js`,
    `__tests__/integration/awareness-spoof-block.test.js`, and the awareness
    half of `server/__tests__/ws-edit-gate.test.js`. This feature asserts
    nothing about presence.


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

---

## Added at plan time (2026-08-02)

## D9 — Extraction budget: four units, with a hard ceiling (FR-001 vs FR-007)

**Question**: FR-007 limits production changes to "minimal, behavior-preserving
extractions required by FR-006" — i.e. the three US5 mirrors. But FR-001 requires the
attribution E2E to drive "the production WebSocket upgrade and document-binding path",
and none of that path is importable: the `bindState` update listener, the upgrade
handler and the connection setup are all inline blocks in `server/index.js`. Which
requirement gives?

**Decision**: FR-007's "required by FR-006" is read as **"required by the tests this
feature specifies"**, and the budget is exactly four move-only extractions:

- **X1** `server/collab-bind-state.js` — the `bindState` update listener
  (`server/index.js:276-480`). This is *already* an FR-006(a) obligation: the
  `update-classifier.test.js:118-134` mirror is a copy of this listener. It also
  happens to be the only place `user_id`/`agent_name`/`via_sync` are written, so
  FR-001/FR-003/FR-004 ride on the same extraction rather than needing their own.
- **X2** `identityFromPrincipal(user)` added to the existing zero-dependency leaf
  `server/agent-identity.js` (3 lines, from `server/index.js:2054-2055`) — the exact
  derivation US1 exists to guard.
- **X3** `shouldPublishToRedis(origin)` in `server/origin.js` — FR-006(b).
- **X4** `server/api/undo-status.js` router factory — FR-006(c).

**Hard ceiling (this is the load-bearing half of the decision)**: the
`server.on('upgrade')` handler and the `installGate(...)` call site **do not move**.
`server/__tests__/ws-edit-gate.test.js` (feature 038's C1 structural guard) asserts by
source-grep that `server/index.js` matches `/installGate\s*\(/` **exactly once** and
contains the literal `request.tokenMayWrite = !Array.isArray(user.scopes) || …`.
Moving either would break a pre-existing test — a direct violation of FR-007(4) and
SC-008. The US1/US2 harness instead composes the real *decision* modules
(`permissions.extractUser`, `permissions.can.view`, `identityFromPrincipal`,
`installGate`, `createUpdateListener`) behind its own express/`ws` transport, and a new
C1-style guard (`server/__tests__/collab-extraction-guard.test.js`) pins that
`server/index.js` uses the same modules.

**Rationale**: the alternative readings both fail. Refusing any extraction beyond the
three named mirrors forces US1/US2/US3 to hand-write a fourth mirror of the persistence
listener — precisely the failure mode this feature exists to kill. Extracting the whole
upgrade/connection path breaks a shipped guard and turns a test-hardening merge into a
hot-path refactor. Four units, with the C1 guard as the tripwire on our own budget, is
the smallest thing that makes FR-001 honest.

**Consequence**: FR-007's wording is narrower than what the feature needs. Recorded as a
spec-vs-plan divergence rather than a silent widening; a MEDIUM analyze finding notes it
so the implementer treats this ledger entry, not FR-007's literal text, as the budget.
**RATIFIED-BY-DEFAULT (Sam pre-authorized, 2026-08-02)**

## D10 — One shared WS harness, real modules only

**Question**: US1, US2, US3 and US4 all need a running collaboration server. Copy the
038 harness (`__tests__/integration/step2-viewer-block.test.js`) into each suite, or
build one shared helper?

**Decision**: one shared helper, `__tests__/integration/helpers/collab-harness.js`,
with a strict rule: **it owns transport plumbing only**. Every decision — who you are,
whether you may edit, how a frame is classified, what gets persisted with what identity
— is made by the production module. The 038 harness's two remaining fakes (a
hand-written "production-shaped" `bindState`, and `?role=&userId=` query-param auth) are
replaced with X1 and the real `permissions.extractUser` / `permissions.can.view` /
`identityFromPrincipal` chain. Identities are real rows and real tokens: a browser-shape
session principal for the human, a real `sk_sqd_` `api_tokens` row for the agent.

If a scenario cannot be expressed without faking a decision, that is a signal to stop
and report, not to fake it.

**Rationale**: three copies of a harness is three places for the mirror problem to grow
back, and this feature's whole thesis is that copies drift silently. The 038 file stays
as-is (it is not this feature's scope) but is not multiplied.
**RATIFIED-BY-DEFAULT (Sam pre-authorized, 2026-08-02)**

## D11 — Retroactive cleanup pass is scoped to the version/undo suites

**Question**: FR-010 requires applying the cleanup-by-`doc_guid` convention "to the
existing version/undo suites that currently orphan rows". Verification found the same
orphan shape in six suites *outside* that area (`backfill-meaningful`, `documents`,
`onboarding`, `postgres-gap-read`, `integration/faucet-wipe`, `integration/prod-reset`).
Do they get fixed here?

**Decision**: No. The retroactive pass covers the four version/undo suites FR-010 names
(`undo-status-api`, `undo/undo-service`, `undo/edit-records`, `undo/legacy`) plus the
already-compliant `version-history` suite converted to the shared helper. The six
out-of-area suites are recorded in `promotion-notes.md` as owed follow-on. Rationale:
the convention is what this feature ships; sweeping every suite in the repo is a
different, larger change that would bloat a merge already sequenced last, and the
convention being importable means the sweep is cheap whenever it is scheduled.
**RATIFIED-BY-DEFAULT (Sam pre-authorized, 2026-08-02)**
