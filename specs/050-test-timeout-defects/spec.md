# Feature Specification: Test Timeout Defects (Test Suite Speed, Train A)

**Feature Branch**: `050-test-timeout-defects` *(parallel-safe authoring: spec written on `main`; no branch created)*

**Created**: 2026-08-04

**Status**: Draft

**Input**: User description: "Fix the two measured test-suite timeout defects from design/test-suite-architecture.md Part 1 (sections 1.1 and 1.2): backend snapshot-only test persistence in the document-editing-workflow MCP integration suite, and client real-sleep reconnect windows in the AiChatContext banner-persistence suite. Test wiring only; never product code."

**Design ground truth**: `design/test-suite-architecture.md` (ratified 2026-08-04, Sam; D1-D4 taken at defaults), Part 1 §1.1 and §1.2, Current State measurements, and the Verification section. Measured analysis: `tmp/test-suite-speed-analysis-2026-08-04.md`. Every factual claim relied on below was re-verified against the code on 2026-08-04; see "Design-Claim Verification" at the end.

## Context

The full local test run costs about 285 seconds, and the two largest costs are not work — they are timeouts paid in full:

1. **Backend (103s of 264s)**: `server/mcp/__tests__/integration/document-editing-workflow.test.js` predates feature 016. Since 016, every `modify` that changes a document polls the update log until identity-attributed rows durably cover the edit (`awaitDurableRange`, bounded by `EDIT_RANGE_WAIT_MS = 5000`, polling every 150ms — `server/mcp/yjs/edit-range.js:146-147`). This suite still registers snapshot-only test persistence: a `bindState` that only loads, and a `writeState` that stores one unattributed snapshot on connection close. Attributed rows never appear while the tool polls, so **every changed modify times out at the full 5 seconds and returns `editRangePending`**. Per-test times cluster at 4.97-5.31s; two tests run two modifies and take ~10s each. The sandbox call itself costs ~80ms — the suite is almost pure timeout.
2. **Client (14.8s of 18.2s wall)**: `client/src/contexts/__tests__/AiChatContext.banner-persistence.test.jsx` is the wall-clock critical path of the Vitest run. Its recovery tests wait out the real 5-second reconnect-establish window (`RECONNECT_ESTABLISH_MS = 5_000`, `client/src/contexts/AiChatContext.jsx:26`) with real sleeps: 5600ms (failed-recovery test), 5500ms + 3200ms around a 6500ms scheduled late-reply timer (late-reply test).

Post-016 suites show the correct backend pattern: `bindState` installs a per-update listener that stores each streamed update with identity — `persistence.storeUpdate(docGuid, update, userId, agentName)` with identity parsed from the Yjs transaction origin (`modify-echo.test.js:44-66`, `modify-conflict-detection.test.js:37-58`). With that wiring the durability wait resolves in one or two 150ms polls.

This feature is **Train A** of the ratified proposal: fix both defects. Train B (CI split/cache, §1.3) and Train C (parallel isolation, Part 2) are explicitly out of scope, as is §1.4 (perf-guard separation, decision D2 already ratified at its default: leave them in the default run).

**Invariant for the whole feature: this changes test wiring, never product code, and never the semantics of any existing test assertion.**

## User Scenarios & Testing *(mandatory)*

The "users" of this feature are the developer (Sam) and the AI agents that run the suites as their only reviewer (Constitution Principle II). Value is measured in feedback-loop time and in tests that verify real behavior instead of timing out around it.

### User Story 1 - Backend integration suite stops paying the 5s durability timeout (Priority: P1)

A developer or pipeline agent runs the backend Jest suite. The document-editing-workflow integration tests exercise the modify tool end-to-end exactly as before, but each changed modify's durability wait resolves as soon as the streamed updates land (one or two 150ms polls) instead of timing out at 5 seconds and falling back to `editRangePending`.

**Why this priority**: This is 90 of the ~103 wasted backend seconds — the single largest cost in the entire test run. It also makes the suite honest: today every one of its modifies exercises the *timeout fallback* path rather than the normal durability path, which means the suite's "green" quietly certifies the wrong code path.

**Independent Test**: Run `document-editing-workflow.test.js` alone. Deliverable value even if nothing else ships: the file drops from ~103s to roughly 13s or less, no test result contains `editRangePending`, and every test still passes with its existing assertions untouched.

**Acceptance Scenarios**:

1. **Given** the ported persistence wiring, **When** the document-editing-workflow suite runs, **Then** every test passes and no modify in the suite returns `editRangePending`.
2. **Given** the ported persistence wiring, **When** per-test times are measured, **Then** every test that previously clustered at ~5s (or ~10s for the two-modify tests) completes well under 1 second of durability-wait overhead.
3. **Given** the ported wiring, **When** the suite finishes, **Then** teardown has awaited all pending per-update stores before cleanup, and the suite leaves no orphan rows for other suites (existing suite-cleanup convention in `helpers/db.js` preserved — this is the reindexStale CI-flake class).
4. **Given** the port, **When** the diff is reviewed, **Then** no assertion in the file changed meaning: only the `setPersistence` wiring (and any teardown flush it requires) differs.

---

### User Story 2 - Client suite stops sleeping through real reconnect windows (Priority: P2)

A developer or pipeline agent runs the client Vitest suite. The banner-persistence recovery tests still verify exactly what they verify today — what the UI shows when the reconnect-establish window elapses without a reply, and what happens when a reply lands late, after the window — but they no longer spend real wall-clock time waiting for that window to elapse.

**Why this priority**: 14.8s of an 18.2s parallel run is one file; fixing it roughly halves Vitest wall time (target: under 10s wall, file under ~1s). Smaller than US1 in absolute seconds, and independent of it.

**Independent Test**: Run the client suite alone. The banner-persistence file completes in about a second, Vitest wall time lands under 10 seconds, and every assertion in the file is semantically identical (the tests assert what happens when the window elapses, not that 5 real seconds passed).

**Acceptance Scenarios**:

1. **Given** the reworked timing (fake timers per RBD-050-1), **When** the banner-persistence suite runs, **Then** all 10 tests pass with unchanged assertion semantics.
2. **Given** the failed-recovery test (reconnect opens, stream ends clean with no content), **When** the establish window elapses under controlled time, **Then** the banner remains and `reconnecting` concludes false — same observable outcome as today's 5600ms real sleep.
3. **Given** the late-reply test (first content scheduled past the establish window), **When** controlled time passes the window and then reaches the late delivery, **Then** the two-stage outcome is preserved in order: first banner + restored draft at window expiry, then banner retired + draft withdrawn when the late reply lands.
4. **Given** the rework, **When** the diff is reviewed, **Then** `client/src/contexts/AiChatContext.jsx` (and all other product code) is unchanged.

---

### User Story 3 - No other suite carries the pre-016 wiring gap (Priority: P3)

A pipeline agent sweeps the backend test tree for any *other* suite that executes `modify` through the tool registry while registering only snapshot-style `bindState`/`writeState` persistence, and ports any it finds the same way.

**Why this priority**: The design mandates the sweep so the defect class is closed, not just the one measured instance. Spec-time verification (2026-08-04) already indicates the sweep will come back empty — see Design-Claim Verification — but the sweep must be re-executed and its result recorded at implementation time, since suites may change between spec and implement.

**Independent Test**: Enumerate every backend test file that registers `setPersistence` and every file that executes tools through the registry; classify each as per-update-attributed, snapshot-only, or not-applicable (mocked registry / no live modify). The recorded classification is the deliverable even when no additional offender is found.

**Acceptance Scenarios**:

1. **Given** the backend test tree at implementation time, **When** the sweep runs, **Then** every suite that executes a live `modify` through the tool registry is confirmed to use per-update identity-attributed persistence, and the sweep result (method + classification) is recorded in the feature artifacts.
2. **Given** a suite the sweep finds with the gap, **When** it is ported, **Then** it meets the same acceptance bar as User Story 1.

---

### Edge Cases

- **Non-agent origins during bind/seed**: the per-update listener stores only updates whose origin parses to an identity; the initial DB-load application and direct test seeding must not produce attributed rows (the reference pattern's `parseOrigin` guard and `ORIGIN_DB_LOAD` handling). The ported suite's seeded initial content ("Come join me in the playground!") must still load correctly.
- **Two modifies in one test**: the two ~10s tests run two changed modifies each; both waits must resolve fast, and the second modify's baseline must see the first's attributed rows (this is exactly what the reference suites already exercise).
- **Async store races at teardown**: per-update stores are fire-and-forget promises; teardown must flush them (reference pattern: a `pendingOperations` collection awaited before cleanup) or truncation can race in-flight writes and strand orphan rows for later suites (CI reindexStale class).
- **`writeState` on close**: the reference pattern makes `writeState` a no-op because every update was already stored attributed. The port must not keep the old snapshot `writeState` alongside the listener, which would double-store content as unattributed rows.
- **Fake timers vs. real async I/O (client)**: the banner-persistence tests interleave timers with real promise chains, `waitFor`, a scripted `ReadableStream`, and one genuine short settle sleep (30ms at line 189). The rework must advance mocked time and flush microtasks such that ordering-sensitive outcomes (banner appears at window expiry *before* the late reply retires it) remain deterministically ordered — not collapsed into one tick that changes what the test proves.
- **The 6500ms scheduled delivery**: in the late-reply test the delayed stream content is itself a `setTimeout` inside the patched transport; under fake timers that timer must be controlled by the same clock as the establish window, or the "late" reply could arrive un-late.
- **Timeout annotations**: the two client tests carry explicit per-test timeouts (10000ms, 20000ms) sized for the real sleeps; they may be reduced or dropped once obsolete, which is wiring, not assertion semantics.
- **Slower/loaded machines**: "well under 1s" durability overhead is poll-cadence-bound (150ms), not machine-bound; but absolute suite-total targets (~175s backend) are expectations on the reference machine (app-dev pod, 10 cores), not per-machine gates. See RBD-050-4.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: `server/mcp/__tests__/integration/document-editing-workflow.test.js` MUST register test persistence in the per-update identity-attributed pattern of the post-016 suites: `bindState` installs an update listener that stores each update with identity parsed from its transaction origin via `persistence.storeUpdate(docGuid, update, userId, agentName)`, applies the persisted state with a load origin excluded from attribution, and marks bind completion; `writeState` MUST NOT store an unattributed snapshot. (Reference implementations: `server/mcp/__tests__/tools/modify-echo.test.js:44-66`, `server/mcp/__tests__/tools/modify-conflict-detection.test.js:37-58`.)
- **FR-002**: With FR-001 in place, no `modify` call in the suite may return `editRangePending`: every changed modify's durability wait MUST resolve within the normal poll cadence rather than the `EDIT_RANGE_WAIT_MS` timeout.
- **FR-003**: The ported suite MUST flush all pending per-update store operations before teardown cleanup, preserving the suite-cleanup convention (`server/__tests__/helpers/db.js`) so the suite leaves no orphan or half-written rows behind for other suites.
- **FR-004**: The feature MUST sweep the backend test tree for any other suite that executes `modify` through the tool registry with snapshot-only (`bindState` + close-time `writeState`) persistence, port any found per FR-001-FR-003, and record the sweep's method and per-suite classification in the feature artifacts — including the explicit finding if the sweep comes back empty.
- **FR-005**: `client/src/contexts/__tests__/AiChatContext.banner-persistence.test.jsx` MUST NOT spend real wall-clock time waiting out the reconnect-establish window. Mechanism per RBD-050-1: fake timers controlling both the establish window and the tests' own scheduled deliveries/sleeps.
- **FR-006**: Every existing assertion in both reworked test files MUST keep identical semantics: the same observable behavior asserted at the same points in the same order. Wiring, setup, teardown, waits, and per-test timeout annotations may change; what the tests prove may not. Additive strengthening (a new assertion that verifies more, e.g. absence of `editRangePending`) is permitted per RBD-050-2; weakening, removal, or reordering of existing assertions is not.
- **FR-007**: This feature MUST NOT modify product code. All changes live in test files (and, if strictly needed, test helpers). In particular `client/src/contexts/AiChatContext.jsx`, `server/mcp/yjs/edit-range.js`, and everything under `server/mcp/` outside `__tests__/` are untouchable. (See flagged gap G-050-1 for the design's "injectable window" alternative and why it is not the default.)
- **FR-008**: The full backend suite (serial, per Constitution Principle II as currently written) and the full client suite MUST pass after the change, with the LLM-friendly reporters still wired in (constitution quality-gate requirement).
- **FR-009**: No changes to test *policy*: serial backend execution, CI workflow, perf-guard placement (D2 default: they stay in the default run), and the constitution are all out of scope for this train.

### Key Entities

*(No product data entities are involved; the feature manipulates test-harness wiring only. The relevant existing mechanisms, for reference: the per-update attributed row in `yjs_updates` that `awaitDurableRange` polls for, and the reconnect-establish window in the chat context.)*

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: Per-test times in the document-editing-workflow suite drop from ~5s (~10s for the two-modify tests) to well under 1 second each; the file total drops from ~103s to ~13s or less. *(Design Verification §Part 1.1.)*
- **SC-002**: Zero `editRangePending` results anywhere in the document-editing-workflow suite run (and in any other suite the FR-004 sweep ports).
- **SC-003**: Backend suite total drops from ~264s to roughly 175s on the reference machine (app-dev pod, 10 cores). Expectation, not a hard per-machine gate — see RBD-050-4; the hard gates are SC-001/SC-002.
- **SC-004**: Client Vitest wall time lands under 10 seconds; the banner-persistence file drops from 14.8s to about 1 second or less. *(Design Verification §Part 1.2.)*
- **SC-005**: All backend suites, all client suites, and the first-run rehearsal suite are green after the change.
- **SC-006**: A reviewer diffing the two test files can confirm assertion-semantics preservation: every pre-existing `expect` survives with the same meaning, order, and trigger conditions.
- **SC-007**: The FR-004 sweep classification exists in the feature artifacts and covers every backend suite that executes live modifies.

## Assumptions

- The measured numbers (264s backend / 18.2s client / 103s and 14.8s offenders) are from the 2026-08-04 profiling on the app-dev pod and are the baseline this feature is judged against; absolute times on other machines will differ, ratios should not.
- The reference wiring in modify-echo / modify-conflict-detection is correct and battle-tested (those suites are among the fastest-per-modify in the tree and are named by the design as the pattern); porting to it is copy-adaptation, not novel design.
- The design's Train A boundary means §1.3 (CI), §1.4/D2 (perf guards), and all of Part 2 (isolation, constitution amendment D1, D3, D4) are other trains' work; nothing here may pre-implement them.
- Decisions D1-D4 in the design doc are already ratified at their stated defaults (doc header, 2026-08-04) and are not re-opened here.
- Vitest fake-timer support (`vi.useFakeTimers` family) is available in the client toolchain; the banner-persistence file currently uses none. If implementation falsifies this, the fallback path in RBD-050-1 applies (and re-opens gap G-050-1).
- "Test wiring, never product code" (feature invariant) is scoped to this train; it does not forbid future features (e.g. Train C) from touching product configuration.

## Design-Claim Verification *(all claims checked against code, 2026-08-04)*

| Design claim (§) | Verified against | Result |
| --- | --- | --- |
| `EDIT_RANGE_WAIT_MS = 5000`, 150ms poll (§1.1) | `server/mcp/yjs/edit-range.js:146-147` | Confirmed (`EDIT_RANGE_WAIT_MS = 5000`, `EDIT_RANGE_POLL_MS = 150`; first poll is immediate, so a fast store resolves in one or two polls as claimed) |
| document-editing-workflow uses snapshot-only persistence (§1.1) | `document-editing-workflow.test.js:50-63` | Confirmed: `bindState` load-only + `writeState` storing one unattributed `Y.encodeStateAsUpdate` snapshot on close; no per-update listener, no identity args |
| Reference pattern at modify-echo.test.js:52 and modify-conflict-detection.test.js:44 (§1.1) | Both files | Confirmed: `ydoc.on('update')` → `parseOrigin` → `persistence.storeUpdate(docGuid, update, parsed.userId, parsed.agentName)`, `writeState` no-op, pending-operation collection |
| Sweep for other pre-016 suites (§1.1) | All 21 `setPersistence`-registering backend test files + all files referencing `modify` without `setPersistence` | **document-editing-workflow is the only offender.** Every other suite that executes live modifies (modify-echo, modify-conflict-detection, modify-sources, modify-edit-range, modify-from-markdown-rehost, undo-redo-workflow) uses the attributed per-update pattern; the remaining `setPersistence` suites don't execute modify; non-`setPersistence` files referencing `modify` mock the registry (`chat-tools.test.js:14-16`) or only pass the name to `get_tool_documentation` (`telemetry-traces.test.js:98`). FR-004 still requires re-running this at implement time. |
| Client sleeps "5600ms, 6500ms plus 3200ms, 5500ms" (§1.2) | `AiChatContext.banner-persistence.test.jsx:157,180,192,199` | Confirmed in substance, shape slightly different: real sleeps are 5600ms (failed-recovery test) and 5500ms + 3200ms (late-reply test) = 14.3s total, matching the 14.8s file time; the 6500ms is a *scheduled delivery timer* inside the patched transport, not a sleep. Immaterial to the design's argument; noted for accuracy. |
| `RECONNECT_ESTABLISH_MS` is the 5s window (§1.2) | `client/src/contexts/AiChatContext.jsx:26,384` | Confirmed: module-level `const RECONNECT_ESTABLISH_MS = 5_000`, consumed by `waitForReply`. Not currently injectable — relevant to gap G-050-1. |
| "Assertions assert what happens when the window elapses, not that 5 real seconds passed" (§1.2) | The 10 tests in the file | Confirmed: all assertions are on `errorInfo`, `draftText`, `reconnecting` state at defined points; none measure elapsed time |

## Flagged Gaps *(Constitution Principle VI — flagged, not resolved ad hoc)*

- **G-050-1**: Design §1.2 offers two mechanisms ("fake timers, **or** make the establish window injectable") but the ratified Train A verification bar says this train changes test wiring, never product code — and making `RECONNECT_ESTABLISH_MS` injectable requires touching `client/src/contexts/AiChatContext.jsx`. The two halves of the design are in tension for the injectable option. Default taken (RBD-050-1): fake timers, which satisfies both halves. If implementation proves fake timers infeasible here, the injectable fallback needs this gap re-opened, because it would breach FR-007 as specced.
- **G-050-2**: The design's Verification section gives "roughly 175s" backend total as an outcome but does not say whether it is a gate or an estimate, nor on what machine. Default taken (RBD-050-4): SC-001/SC-002/SC-004 are the gates; the 175s figure is a reference-machine expectation recorded for the trend table, not a pass/fail criterion.

Full decision records: `specs/050-test-timeout-defects/clarifications-needed.md`.
