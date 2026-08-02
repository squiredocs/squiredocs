# Implementation Plan: Version History Test Hardening

**Branch**: `main` (parallel-agent mode: work happens on `main` / a pipeline worktree — **no branch is created by the planning agent**)

**Date**: 2026-08-02 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `/specs/043-version-history-test-hardening/spec.md`

**Merge position**: LAST. Queue order is **041 → 042 → 044 → 043**.

## Summary

This feature makes the version-history/attribution test suite honest. The product promise is
"100% accurate attribution, never lose edits"; the deep dive (2026-08-02, section E) found the
machinery sound and the suite dishonest about guarding it — the flagship attribution regression
test is two `expect(true).toBe(true)` blocks, three suites test in-file copies of production code,
the two most loss-prone paths (reconnect catch-up, persistence failure of a live edit) have no
end-to-end coverage, and two user-facing components have no tests at all.

**Technical approach**: eight test slices plus **four move-only production extractions** whose only
purpose is to make decision-bearing code importable. There is no behavior change and no migration.

The organising insight is that **US5's first mirror and US1/US2/US3's subject are the same code**.
`update-classifier.test.js:118-134`'s in-test `runListener` is a copy of the y-websocket `bindState`
update listener at `server/index.js:287-440` — which is also the only place `user_id`, `agent_name`
and `via_sync` are written to `yjs_updates`. Extracting that one listener discharges FR-006(a) and
simultaneously gives FR-001/FR-003/FR-004 a real subject to drive. The other three extractions are
tiny (3, 4 and ~15 lines).

The harness pattern is not invented here: `__tests__/integration/step2-viewer-block.test.js`
(feature 038) already stands up a mini express+`ws` server and installs the **real** edit gate, and
`server/__tests__/ws-edit-gate.test.js:448-487` pairs it with a **structural drift guard** that
greps `server/index.js` to prove production uses the same module. This feature adopts both halves
and upgrades the harness's remaining fakes (hand-written `bindState`, `?role=&userId=` query-param
auth) to the real modules.

**Extraction ceiling (load-bearing)**: the `server.on('upgrade')` handler and the `installGate(...)`
call site **stay in `server/index.js`**. The 038 C1 guard asserts by source-grep that `index.js`
matches `/installGate\s*\(/` exactly once and contains the literal
`request.tokenMayWrite = !Array.isArray(user.scopes) || …`. Moving either breaks a pre-existing
test, violating FR-007(4) and SC-008. The harness therefore composes the real *decision* modules
(`permissions.extractUser`, `permissions.can.view`, `identityFromPrincipal`, `installGate`,
`createUpdateListener`) behind its own transport plumbing, and a new C1-style guard pins that
`index.js` uses those same modules. Recorded as **D9**.

**What this feature explicitly does not do**: no product fix for the publish-before-commit window
(D1 — US3 pins and documents it), no browser E2E (D7), no chat-side `extractPlainText` fix, no
duplication of 044's awareness-guard coverage.

## Technical Context

**Language/Version**: Node.js 22+ (CommonJS server), React 18 (ESM client)

**Primary Dependencies**: `yjs`, `y-websocket`, `y-protocols`, `lib0`, `ws`, `express`, `pg`,
`jsonwebtoken`, `diff`; test-side `jest`, `supertest`, `vitest`, `@testing-library/react`.
**No new dependency.**

**Storage**: PostgreSQL `yjs_updates` / `agent_edits` / `documents` / `document_shares` /
`api_tokens`, read and written only through existing production paths. **Zero migrations.**

**Testing**:
- Backend: Jest via `npm run test:server` — `jest --runInBand --forceExit --silent
  --reporters=./script/jest-llm-reporter.js`. Config lives in `package.json` (there is no
  `jest.config.js`); `globalSetup: server/__tests__/globalSetup.js` creates the DB and runs
  `npm run migrate`. **Serial-only against a shared DB** (Constitution II).
- Client: Vitest via `npm run test:client` — `client/vitest.config.js`, `environment: 'jsdom'`,
  `setupFiles: ['./src/test/setup.js']`.
- In a worktree the implementer MUST use a per-agent database: `createdb collab_test_db_043` and
  `DATABASE_URL=postgres://…/collab_test_db_043` on every test command.
  `server/__tests__/helpers/db.js` `getTestDatabaseUrl()` reads `DATABASE_URL` at call time.

**Target Platform**: Linux server (Minikube `app-dev` pod for local dev)

**Project Type**: Web application — Express/y-websocket backend + React/TipTap client

**Performance Goals**: N/A for behavior. Suite-level: the new integration suites must not push
`npm run test:server` wall time up materially; each WS suite reuses one mini-server across its
tests (the 038 pattern) rather than booting per test.

**Constraints**:
- **Zero production behavior change** (SC-008). Every production diff is a move-only extraction
  traceable to FR-006/FR-007 (plus D9's two additions).
- **Pre-existing tests pass unmodified**, except (a) the three mirror suites whose subject is being
  replaced, and (b) the flake-hygiene edits FR-010/FR-011 mandate.
- **Serial DB** (FR-012): no `test.concurrent`, no second runner. US4's concurrency is concurrency
  of requests inside one suite.
- **No browser E2E** (FR-013/D7).
- Assertions in US4 must hold for **every legal interleaving** (D2).

**Scale/Scope**: ~9 new/rewritten test files, 4 small production extractions, 5 existing suites
edited for hygiene. No new user-facing surface.

## Constitution Check

*GATE: evaluated before Phase 0 and re-evaluated after Phase 1 design. **Result: PASS**, no
Complexity Tracking entries.*

| Principle | Assessment |
|---|---|
| **I. Documentation Reflects Reality** | No behavior changes, so `README.md` / `docs/dev.md` need no update — and parallel-agent overrides forbid this agent touching them anyway. One documentation obligation *is* created: the FR-010 cleanup convention must be recorded once, and its home is `server/__tests__/helpers/db.js` (helper + doc block), not the top-level docs. If the merge-queue reviewer judges `docs/dev.md`'s testing section owes a pointer, that lands in the queue, not here. |
| **II. Test-Backed Changes** | This feature *is* Principle II applied to itself: the suite is the sole reviewer, and this closes the gaps where it was reviewing nothing. The four extractions are behavior-preserving and are covered by the pre-existing suites plus the new real-code tests. Backend serial-only is honored (FR-012). The format/serialization round-trip registry is untouched. |
| **III. Trunk-Based Solo Workflow** | Test-only + move-only; no new ceremony. The one new *convention* (cleanup by `doc_guid`) is justified by a concrete recurring failure — the CI `reindexStale` flake — as Principle III requires. |
| **IV. Collaboration-Safe Document Operations** | No production document mutation is added. US4's restore tests exercise 041's restore path as-is; no test may delete-and-recreate content in a watched doc. The extractions preserve the origin model (`server/origin.js`) exactly — X1 moves the `parseOrigin`/`viaSyncFromOrigin` sequence byte-for-byte, and X3 *strengthens* single-sourcing by giving the Redis skip-list one definition. Provenance stays a product invariant; that is what US1/US2 now guard. |
| **V. Secure by Default** | No new ingestion surface. The US1/US2 harness mints **real** `sk_sqd_` API tokens through the production path with explicit scopes and cleans them up; no test may weaken `permissions` or the edit gate to make a scenario pass. The `tokenMayWrite` scope axis is exercised, not bypassed. |
| **VI. Design Docs Are Ground Truth** | US7's label assertions follow `design/collaboration-core.md:58` (Sam D19, 2026-08-02): a human web-UI restore records **no** edit record and is **not** an undo target. Tests must assert that absence and must not resurrect pre-cut behavior (D8). All eight spec-level decisions plus the two new plan-level ones are RATIFIED-BY-DEFAULT in the ledger; nothing was decided silently. |

**Post-Phase-1 re-check**: still PASS. The design added no new project, no new dependency, no
schema change, and no abstraction beyond the four named extractions.

## Project Structure

### Documentation (this feature)

```text
specs/043-version-history-test-hardening/
├── plan.md                  # This file
├── research.md              # Phase 0 — R1..R11
├── data-model.md            # Phase 1 — test-domain entities and invariants
├── quickstart.md            # Phase 1 — how to run and validate this feature
├── contracts/
│   ├── extraction-contracts.md   # X1..X4 module surfaces (move-only)
│   └── harness-contract.md       # the shared WS harness surface
├── clarifications-needed.md # D1..D8 (spec) + D9..D10 (plan)
├── checklists/
└── tasks.md                 # Phase 2 — /speckit-tasks output
```

### Source Code (repository root)

```text
server/
├── index.js                       # EDIT (move-only): calls X1..X4 instead of inlining them
├── collab-bind-state.js           # NEW (X1) — createBindState / createUpdateListener
├── agent-identity.js              # EDIT (X2) — + identityFromPrincipal(user)
├── origin.js                      # EDIT (X3) — + shouldPublishToRedis(origin)
├── api/
│   └── undo-status.js             # NEW (X4) — createUndoStatusRouter(deps)
├── postgres-persistence.js        # UNCHANGED (US8 needs no production change — `retries` already returned)
└── __tests__/
    ├── helpers/db.js              # EDIT — + cleanupDocRows() and the recorded convention (FR-010)
    ├── attribution-bug.test.js    # REWRITTEN — placeholders deleted (FR-002)
    ├── update-classifier.test.js  # EDIT — runListener mirror deleted, drives X1 (FR-006a)
    ├── origin.test.js             # EDIT — local copy deleted, drives X3 (FR-006b)
    ├── undo-status-api.test.js    # EDIT — mirrored route deleted, drives X4 (FR-006c)
    ├── collab-extraction-guard.test.js  # NEW — C1-style structural drift guard for X1..X4
    ├── diff-two-surface-parity.test.js  # EDIT/EXTENDED — shared Y.Doc fixture, both full pipelines (FR-008)
    └── postgres-gap-read.test.js  # EDIT — 8 wall-clock assertions replaced (FR-011)

server/undo/__tests__/             # EDIT — cleanup-by-doc_guid applied (FR-010)
    ├── undo-service.test.js
    ├── edit-records.test.js
    └── legacy.test.js

__tests__/integration/
├── helpers/collab-harness.js      # NEW — real-module WS harness + frame crafting + waitFor
├── attribution-e2e.test.js        # NEW (US1, FR-001)
├── sync-catchup-e2e.test.js       # NEW (US2, FR-003)
├── persistence-failure-e2e.test.js# NEW (US3, FR-004) — characterization
├── restore-concurrency.test.js    # NEW (US4, FR-005)
└── collaboration.test.js          # EDIT — sleep waits → condition waits where safe (FR-011/US8c)

client/src/components/__tests__/
├── VersionHistoryPanel.test.jsx   # NEW (US7, FR-009)
└── VersionPreview.test.jsx        # NEW (US7, FR-009)
```

**Structure Decision**: the repo's existing split is kept exactly. Backend unit/API suites live in
`server/__tests__/` (and `server/undo/__tests__/`), real-WebSocket end-to-end suites live in
`__tests__/integration/` alongside the 038 precedent, and component suites live in
`client/src/components/__tests__/`. The one new directory is `__tests__/integration/helpers/`,
which exists so three new WS suites share one harness instead of each growing its own copy — the
very drift this feature is removing.

## Implementation phases

### Phase A — Re-verify against merged main (BLOCKING)

`T001` is the first task and gates everything. It re-checks, against post-041/042/044 `main`:
the four extraction targets (has 042 already moved one? — FR-015 consolidates `retryWithBackoff`,
which lives *inside* X1's block); 041's merged restore semantics (FR-011/FR-013) and error-state
render shape (FR-005/FR-006); **042's `VersionHistoryPanel` prop/context shape (FR-012 — the
largest single risk to US7)**; the wall-clock assertion count and line numbers; and that the 038 C1
guard still greps `index.js` for `installGate` and `request.tokenMayWrite`. Divergences resolve in
041/042's favor (D5) and are appended to the ledger.

### Phase B — Extractions (X1-X4) + drift guards

Move-only. Each lands with the full pre-existing affected suite green *before* any new test is
written against it, so a green suite proves the move was behavior-preserving. Each gets a
structural drift guard in `server/__tests__/collab-extraction-guard.test.js` in the 038 C1 style.

### Phase C — Mirror replacement (US5, P3 but sequenced early)

The three mirrors are deleted and their suites re-pointed at X1/X3/X4. Sequenced immediately after
Phase B because the extraction is only proven useful once something real consumes it, and because
`update-classifier.test.js` driving X1 is the cheapest possible smoke test for the biggest
extraction.

### Phase D — The end-to-end suites (US1 → US2 → US3 → US4)

Strict priority order. The shared harness lands first (it is US1's prerequisite), then each suite.
US4 depends on 041's merged restore path and is written last of the four.

### Phase E — Diff parity (US6) and components (US7)

Independent of A-D except for T001. US6 needs no extraction (both pipelines are already importable
— `computeChatDiff` and `DiffService#computeMarkdownDiff`). US7 is the most exposed to 042's prop
collapse.

### Phase F — Flake hygiene (US8)

Applied last so it also covers every suite this feature just created: the cleanup convention is
recorded once in `server/__tests__/helpers/db.js`, applied retroactively to the four offending
version/undo suites, the 8 wall-clock assertions are replaced with `retries`/query-count
assertions, and `collaboration.test.js`'s sleeps become condition waits where the awaited condition
is observable.

### Phase G — Stretch (S1-S3, P4, droppable)

Duplicate version-name collision, a real assertion for `mergeNamedVersions` with null
`clock_start`, and the undo-claim crash-window characterization. Sequenced last and droppable
without failing the feature (D6).

## Risks and mitigations

| Risk | Mitigation |
|---|---|
| 042's `VersionHistoryContext` (FR-012) changes how `VersionHistoryPanel` is rendered, invalidating US7's test setup | T001 checks it first; US7 tests render through whatever provider post-042 `main` requires. Budgeted as the largest re-verification item. |
| The X1 extraction is bigger than a "minimal" extraction should be | It is a pure move of one contiguous listener; the pre-existing suites plus the new drift guard are the safety net, and the alternative (a third mirror) is the failure mode this feature exists to kill. Recorded as D9. |
| Moving code out of `index.js` breaks the 038 C1 structural guard | Hard ceiling: `installGate` and the `tokenMayWrite` line do not move. Explicitly re-checked in T001. |
| US3's failure injection leaks rigged state into later tests | Injection wraps the harness's own persistence instance (never a global), matches one specific update by payload, and is restored in `finally`. |
| US4 concurrency tests flake on CI's different interleaving | D2: invariant-style assertions only. Barriers may provoke overlap; no assertion may name a race winner. |
| New WS suites orphan `yjs_updates` rows and feed the `reindexStale` CI flake | FR-010 applies to new suites by construction: cleanup by `doc_guid` in `afterAll`, via the shared helper. |
| 041 changes undo-vs-`via_sync` semantics under US2 | US2 asserts the post-041 shape: the pending-recording guard **ignores** sync rows (041 FR-014), while inverse derivation still **refuses to invert across** them (041 FR-016). Named explicitly in research R4. |

## Complexity Tracking

> No Constitution Check violations. Table intentionally empty.
