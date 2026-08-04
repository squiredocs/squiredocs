# Implementation Plan: Test Timeout Defects (Test Suite Speed, Train A)

**Branch**: `050-test-timeout-defects` *(plan authored on `main` under the pipeline's parallel-safe overrides; the implementer branches in its own worktree)* | **Date**: 2026-08-04 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `/specs/050-test-timeout-defects/spec.md`

**Design ground truth**: `design/test-suite-architecture.md` Part 1 §1.1 and §1.2 (ratified 2026-08-04; export current as of the two 2026-08-04 corrections).

## Summary

Two measured test-suite timeouts are paid in full on every run and neither is work.
Backend: `document-editing-workflow.test.js` predates feature 016 and registers
snapshot-only test persistence, so every changed `modify` waits the whole
`EDIT_RANGE_WAIT_MS = 5000` and returns `editRangePending` (103s of 264s, and the
suite's green certifies the timeout-fallback path rather than the durability path).
Client: `AiChatContext.banner-persistence.test.jsx` sleeps out the real 5-second
reconnect-establish window three times (14.8s of an 18.2s parallel wall).

The fix is entirely test wiring. Backend: port `bindState` to the post-016
per-update identity-attributed `storeUpdate` pattern already used by
`modify-echo.test.js:44-66` and `modify-conflict-detection.test.js:37-58`, make
`writeState` a no-op, and flush pending stores before teardown cleanup. Client:
put the two recovery tests on Vitest fake timers (RBD-050-1), driving both the
establish window and the tests' own scheduled deliveries from one clock. Then
re-run the FR-004 sweep over both backend test roots and record the classification
even when it comes back empty.

**No product code changes. No change to what any existing assertion proves.**

## Technical Context

**Language/Version**: Node.js 22+ (CommonJS backend), React 18 + JSX (client)

**Primary Dependencies**: Jest (backend, `--runInBand`, LLM reporter), Vitest 1.6.1 +
`@sinonjs/fake-timers` 10.3.0 + `@testing-library/react` 14 (client), `yjs`,
`y-websocket` (`setPersistence` / `setupWSConnection` / `getYDoc`), `pg`

**Storage**: PostgreSQL test database (`collab_test_db`, or a per-worktree copy — see
Execution Environment). The `yjs_updates` table is what the durability wait polls.

**Testing**: the two suites under change ARE the deliverable. Verification runs the
full backend Jest suite, the full client Vitest suite, and the first-run rehearsal
suite, with the custom LLM-friendly reporters wired in.

**Target Platform**: Minikube `app-dev` pod (reference machine: 10 cores)

**Project Type**: Web application (Express/Yjs backend + React client), existing tree

**Performance Goals** (gates per RBD-050-4): document-editing-workflow per-test
durability overhead well under 1s and file total ≤ ~13s (from ~103s); zero
`editRangePending`; Vitest wall < 10s with banner-persistence ≈ 1s (from 14.8s).
Recorded expectation, NOT a gate: backend total ≈175s (from ~264s).

**Constraints**: test wiring only — `client/src/contexts/AiChatContext.jsx`,
`server/mcp/yjs/edit-range.js`, and everything under `server/mcp/` outside `__tests__/`
are untouchable (FR-007). Existing assertions keep identical meaning, order and trigger
conditions; only additive strengthening is allowed (FR-006 / RBD-050-2). Backend tests
stay serial within a database (`--runInBand` must not be defeated).

**Scale/Scope**: 2 test files edited (~1200 lines and ~260 lines), 1 new feature
artifact (`sweep-results.md`). Zero product files. Zero migrations.

## Constitution Check

*GATE: evaluated against `.specify/memory/constitution.md` v1.2.0 before Phase 0, re-checked after Phase 1.*

| Principle | Applies? | Assessment | Verdict |
| --- | --- | --- | --- |
| I. Documentation Reflects Reality | Yes | No behavior, API, feature, or dev-workflow change: the app is byte-identical after this feature, and `docs/dev.md`'s test commands are unaffected (same scripts, same serial backend rule). No README/docs edit is owed. Design ground truth is already current — `design/test-suite-architecture.md` was amended 2026-08-04 with the two corrections the spec's verification table flagged. Parallel-safe overrides forbid this agent editing CLAUDE.md/README.md/docs/dev.md in any case. | **PASS** |
| II. Test-Backed Changes | Yes (central) | The change *is* to tests. FR-008 requires the full backend and client suites green; FR-006 forbids weakening any assertion, and RBD-050-2 permits only additive strengthening (asserting the absence of `editRangePending`). Backend serial execution is preserved — `--runInBand` stays wired, and the worktree gets its own database rather than sharing `collab_test_db`. No format/serialization change, so the round-trip suite is untouched. LLM-friendly reporters stay wired (FR-008). | **PASS** |
| III. Trunk-Based Solo Workflow | Yes | Runs through the standard pipeline (already the chosen ceremony for this design's trains); no new process. This plan adds no gate beyond the existing spec-kit stages. | **PASS** |
| IV. Collaboration-Safe Document Operations | Indirectly | No product code touches documents. Notably the port makes the suite *more* faithful to this principle: attributed rows are what keeps edits attributable to the human or agent that made them, and today the suite exercises a path where that attribution never lands. Nothing here delete-and-recreates or targets positionally. | **PASS** |
| V. Secure by Default | No | No new ingestion surface, no sandbox/sanitizer/ACL/token change. The suite continues to exercise the existing sandbox path unchanged (~80ms/call). | **PASS (N/A)** |
| VI. Design Docs Are Ground Truth | Yes | Scope is exactly design §1.1 + §1.2 (Train A). §1.3, §1.4/D2 and all of Part 2 are other trains and MUST NOT be pre-implemented (FR-009). The one design tension (§1.2's "or make the establish window injectable" vs. Train A's no-product-code bar) is flagged as G-050-1, not resolved ad hoc, and defaulted to fake timers as RBD-050-1 — which Phase 0 R4 has now *confirmed feasible*, so the fallback that would breach FR-007 is not taken. G-050-2 (is 175s a gate?) is likewise defaulted in the ledger, and the design doc's Expected Outcomes table already carries the matching clarification. | **PASS** |
| VII. Horizontally Scalable App Pods | No | No app-tier runtime behavior, no process-local state, no replica-count assumption. Test-process-local state only. | **PASS (N/A)** |

**Result: PASS — no violations, Complexity Tracking empty.** Re-checked after Phase 1
design below: unchanged (the design added no new dependency, no product file, and no
policy change).

## Project Structure

### Documentation (this feature)

```text
specs/050-test-timeout-defects/
├── spec.md                      # Complete (input)
├── clarifications-needed.md     # RBD-050-1..4, gaps G-050-1/2 (input)
├── checklists/requirements.md   # Complete (input)
├── plan.md                      # This file
├── research.md                  # Phase 0 output (R1-R7)
├── quickstart.md                # Phase 1 output — how to verify
├── sweep-results.md             # Produced at IMPLEMENT time (FR-004 / SC-007 deliverable)
└── tasks.md                     # Phase 2 output (/speckit-tasks)
```

`data-model.md` and `contracts/` are deliberately **not produced**: the spec's Key
Entities section records that no product data entities are involved, and the feature
exposes no interface to users or other systems. Producing empty artifacts would be
ceremony (Principle III).

### Source Code (repository root)

```text
server/
├── mcp/
│   ├── __tests__/
│   │   ├── integration/
│   │   │   └── document-editing-workflow.test.js   # CHANGED (beforeAll wiring + afterAll flush)
│   │   └── tools/
│   │       ├── modify-echo.test.js                 # reference pattern (read-only)
│   │       └── modify-conflict-detection.test.js   # reference pattern (read-only)
│   ├── yjs/edit-range.js                           # UNTOUCHABLE (product)
│   └── tools/modify.js                             # UNTOUCHABLE (product)
├── origin.js                                       # UNTOUCHABLE (product; ORIGIN_DB_LOAD/parseOrigin imported by tests)
└── __tests__/helpers/db.js                         # read-only (createPool/createPersistence, DATABASE_URL honored)

__tests__/integration/                              # second backend root — sweep scope only

client/src/contexts/
├── AiChatContext.jsx                               # UNTOUCHABLE (product)
└── __tests__/
    ├── AiChatContext.banner-persistence.test.jsx   # CHANGED (fake timers in 2 tests + settle helper)
    └── AiChatContext.test.jsx                      # fake-timer precedent (read-only)
```

**Structure Decision**: existing web-application layout; this feature edits exactly two
test files in place and adds one feature artifact. No new directories, no new
dependencies, no migrations.

## Implementation Approach

### Workstream A — Backend port (US1, FR-001..FR-003, SC-001/SC-002)

Target: `server/mcp/__tests__/integration/document-editing-workflow.test.js`.

**A1. Imports and module-level state.** Add
`const { ORIGIN_DB_LOAD, parseOrigin } = require('../../../origin');` and a
`pendingOperations` array (module scope, as in both reference suites).

**A2. Replace the `setPersistence({...})` block** (currently lines 50-63) with the
reference shape:

- `bindState(docName, ydoc)`: install `ydoc.on('update', (update, origin) => …)` FIRST,
  which parses the origin with `parseOrigin`, returns early when it is `null` (the
  sentinel case), and otherwise pushes
  `persistence.storeUpdate(docGuid, update, parsed.userId, parsed.agentName)` — with a
  `.catch()` that logs — onto `pendingOperations`. Then load the persisted state and
  apply it with **`ORIGIN_DB_LOAD` as the third argument** (research R2: without it the
  bind's own load is re-stored unattributed and logs a CRITICAL-class origin error).
  Keep the existing `ydoc._bindComplete = true` mark (the 048 bind-readiness gate) and
  keep the load inside a `try/catch` for new documents.
- `writeState: async () => {}` — the snapshot store is **deleted**, not kept alongside
  (spec Edge Case "`writeState` on close"; keeping both double-stores content as
  unattributed rows).
- Add `provider: persistence` to match the reference registration object.

**A3. Stamp WS identity.** In the `wss.on('connection', …)` handler set
`ws.userId = testUserId;` and `ws.agentName = 'Test Agent';` before
`setupWSConnection(ws, req, { gc: false })`, mirroring
`modify-conflict-detection.test.js:80-84` (production does this in the auth
middleware). Move the test-user `INSERT` **above** the `httpServer.listen` block so the
identity provably exists before any connection can be accepted (research R2).
`'Test Agent'` must equal `mockAgentToken.agentName` — the durability wait filters rows
by `(userId, agentName)`.

**A4. Teardown flush.** In `afterAll`, insert
`await Promise.all(pendingOperations); pendingOperations.length = 0;` **after** the
server-close waits and **before** the first `DELETE FROM …` (FR-003). Do not remove or
reorder the existing sleeps or deletes; the suite-cleanup convention stays exactly as
it is (this is the reindexStale orphan class — see spec Acceptance Scenario US1-3).

**A5. Additive assertion (RBD-050-2, guards SC-002 forever).** For every `modify` result
the suite already captures, add `expect(modifyResult.editRangePending).toBeUndefined();`
alongside the existing expectations. Additive only — no existing `expect` is moved,
weakened, or removed. Where a modify result is currently not bound to a variable, bind
it rather than restructuring the surrounding assertions.

**A6. Timeout annotations.** The per-test `10000`/`30000` timeouts sized for the old 5s
waits may be reduced or left as-is; they are wiring, not semantics (spec Edge Case
"Timeout annotations"). Prefer leaving them alone unless a value is actively misleading —
a smaller diff is easier to review against FR-006.

**Known risk to watch (do not "fix" by weakening a test):** the `undo should succeed`
and `redo should succeed` tests (lines ~1096-1168) run against the shared seeded doc.
Today, because every modify returns `editRangePending`, `recordEdit` happens in the
background and undo resolves through the legacy-derivation path. After the port the
`agent_edits` row exists inline, so undo/redo exercise the **record-backed** path — the
correct one, and the whole point of the fix. Both assertions are `success === true` and
should hold. If either fails, that is a real finding about the record-backed path, to be
reported (and, if it is a product defect, flagged) — never papered over by relaxing the
assertion or reverting the wiring.

### Workstream B — Client fake timers (US2, FR-005/FR-006, SC-004)

Target: `client/src/contexts/__tests__/AiChatContext.banner-persistence.test.jsx`.

**B1. `settle(ms)` helper.** Add one file-local helper and route every
`await new Promise((r) => setTimeout(r, N))` through it:

```js
const settle = async (ms) =>
  (vi.isFakeTimers() ? vi.advanceTimersByTimeAsync(ms) : new Promise((r) => setTimeout(r, ms)));
```

Real-timer tests keep byte-identical behavior; fake-timer tests advance the one clock.
(`vi.isFakeTimers` confirmed present in vitest 1.6.1 — research R4.)

**B2. Restore timers globally.** Add `vi.useRealTimers();` to the existing `afterEach`
(beside `cleanup()` / `vi.restoreAllMocks()`) so a failing test can never leak a fake
clock into the next one.

**B3. Failed-recovery test (line 146).** After the opening
`await waitFor(() => expect(mockApi.get).toHaveBeenCalled())` — and only after it
(research R5 hazard 1: RTL v14 does not detect Vitest fake timers, so a `waitFor` under
a fake clock hangs) — call `vi.useFakeTimers()`. Then run the existing steps unchanged
and replace the `5600` real sleep with `await settle(5600)` inside the same `act`.
Assertions and their order are untouched. The explicit `10000` per-test timeout can drop.

**B4. Late-reply test (line 163).** Same install point (after the opening `waitFor`,
before the transport patch so the 6500ms delivery timer is scheduled on the fake clock —
spec Edge Case "the 6500ms scheduled delivery"). Then:
- `await settle(30)` after `sendMessage('my draft')`,
- `await settle(5500)` → assert the first-stage outcome exactly as today (banner +
  restored draft + `reconnecting === false`),
- `await settle(3200)` → assert the second-stage outcome exactly as today (banner
  retired, draft withdrawn).

The two-stage ordering is preserved because 5500 crosses the 5000ms establish window but
not the 6500ms delivery, and 3200 then crosses it; `advanceTimersByTimeAsync` fires
timers in scheduled order and flushes microtasks between them, so the scripted
`ReadableStream` enqueues are consumed before each assertion rather than collapsing into
one tick (spec Edge Case "Fake timers vs. real async I/O"). The explicit `20000`
per-test timeout can drop.

**B5. Leave the other eight tests alone** apart from the mechanical `settle(...)`
substitution. They are already sub-100ms; putting them on fake timers would expose their
opening `waitFor` to hazard (1) for no gain.

**Fallback boundary.** If — contrary to research R4 — fake timers prove infeasible here,
the implementer MUST STOP and report rather than reach for the injectable window:
that path breaches FR-007 and re-opens G-050-1 (RBD-050-1).

### Workstream C — Sweep (US3, FR-004, SC-007)

Re-execute the enumeration at implement time (suites may have changed since the spec)
using the exact commands in research R6, over **both** backend roots (`server` and the
repo-root `__tests__` — the spec's spec-time evidence enumerated `server/` only; the
conclusion was re-verified unchanged on 2026-08-04, but the command must cover both or
the class is not provably closed). Classify every hit as per-update-attributed /
snapshot-only / not-applicable, and write `specs/050-test-timeout-defects/sweep-results.md`
with the commands, their raw output, the per-file classification, and the explicit
finding — including "no additional offenders" if that is the result. Any offender found
is ported to the same bar as Workstream A.

### Execution Environment (implementer, worktree)

- `npm ci && (cd client && npm ci)` — worktrees do not inherit `node_modules`.
- **Never point at the shared `collab_test_db`.** Create `collab_test_db_050` and run
  migrations and every backend command with
  `DATABASE_URL=postgresql://<user>@localhost:5432/collab_test_db_050`
  (`server/__tests__/helpers/db.js` honors it). Concurrent runs against the shared DB
  corrupt fixed-key rows — a repeated, recorded failure mode.
- **Do not defeat `--runInBand`.** It is already wired into `npm run test:server`; within
  one database the backend suite is serial-only. Parallel workers are Train C (052) and
  out of scope (FR-009).
- **Single-file backend runs** keep `--runInBand --forceExit` and a deliberately set
  `REDIS_HOST` (`collab-redis` in the pod, `localhost` otherwise) so they hit the same
  Redis as the full run; `npm run test:server -- <path>` does not work (`docs/dev.md`).
- Keep the LLM reporters (`--reporters=./script/jest-llm-reporter.js`,
  `--reporter=../script/vitest-llm-reporter.mjs`) on every run that is quoted as
  evidence (constitution quality gate).
- Measurement commands and expected outcomes: see [quickstart.md](./quickstart.md).

## Phase 1 Design Notes

- **data-model.md**: not applicable — no product data entities (spec Key Entities).
- **contracts/**: not applicable — no external interface is exposed or changed.
- **quickstart.md**: produced; it is the runnable verification guide for SC-001..SC-007.

**Post-design Constitution re-check: PASS** (unchanged from the pre-Phase-0 evaluation;
the design introduced no dependency, no product file, and no policy change).

## Complexity Tracking

*No Constitution Check violations. Table intentionally empty.*
