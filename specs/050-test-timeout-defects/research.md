# Phase 0 Research — 050-test-timeout-defects

**Date**: 2026-08-04 · **Feature**: Test Timeout Defects (Test Suite Speed, Train A)

All findings below were verified against the code in the main tree on 2026-08-04.
No NEEDS CLARIFICATION markers survive into plan.md.

---

## R1 — Backend: what actually makes the durability wait resolve

**Question**: what exactly must the ported `bindState` produce so `awaitDurableRange`
stops timing out?

**Findings** (`server/mcp/yjs/edit-range.js:167-247`, `server/mcp/tools/modify.js:601-650`):

- `modify` computes `editIdentity = { userId: agentToken.userId, agentName: agentToken.agentName }`
  and a `baseline` clock, then polls `persistence.getUpdatesInRange(docGuid, baseline+1, MAX)`.
- Rows are filtered by `isSameIdentity(row, identity)` — the row's `user_id` **and**
  `agent_name` must match the acting token (null-normalized). Unattributed rows
  (`user_id IS NULL`) never satisfy the filter, which is precisely why today's
  snapshot `writeState` row (written only on connection close, with no identity
  args) can never end the wait.
- The write path is `documentService.updateDocument`, which transacts on the shared
  server-side `Y.Doc` with `origin = createOrigin(userId, agentName)`
  (`server/document-service.js:323,453`). So the identity is present **on the Yjs
  transaction origin** at update time — a `ydoc.on('update', (update, origin) => …)`
  listener installed in `bindState` is the only hook that can turn it into an
  attributed row while the tool is still polling.
- First poll is immediate and `EDIT_RANGE_POLL_MS = 150`, so a store that completes
  promptly ends the wait in one or two polls (spec SC-001).

**Decision**: port `bindState` to the per-update attributed listener exactly as
`modify-echo.test.js:44-66` / `modify-conflict-detection.test.js:37-58` do, and make
`writeState` a no-op.

**Alternatives considered**:
- *Keep `writeState` and additionally store attributed rows*: rejected — the snapshot
  row would double-store the whole document as an unattributed row on every close
  (spec Edge Case "`writeState` on close"), inflating `yjs_updates` and re-introducing
  the exact orphan class `helpers/db.js` cleanup exists to manage.
- *Shrink `EDIT_RANGE_WAIT_MS` for tests*: rejected — product code (FR-007), and it
  would make the suite certify the timeout path faster rather than exercise the real
  durability path.

---

## R2 — Backend: the two details the reference pattern carries that a naive copy drops

**Findings**:

1. **`ORIGIN_DB_LOAD` on the initial apply.** The reference applies the persisted
   state with `Y.applyUpdate(ydoc, …, ORIGIN_DB_LOAD)`. `parseOrigin` returns `null`
   for that sentinel (`server/origin.js:134-179`), so the listener skips it. The
   current file applies with **no origin** (`document-editing-workflow.test.js:54`) —
   under the new listener that would parse as `null-or-primitive`, log a CRITICAL-class
   error, and store the whole loaded document back as an unattributed row on every
   bind. This is mandatory, not cosmetic.
2. **`ws.userId` / `ws.agentName` stamping on the connection.** Both reference suites
   set them before `setupWSConnection` (`modify-conflict-detection.test.js:80-84`, and
   its comment explains why: production does this in the auth middleware). The current
   file does not. With the listener installed, any update arriving over a WS whose
   socket carries neither property parses as `unrecognized-object` → an unattributed
   row plus a warning. The suite's `agentPresence` sessions open exactly such sockets.

**Decision**: mirror the reference on both points. Stamping requires `testUserId` to
exist before the first connection; today the user row is created *after* `httpServer.listen`
(`document-editing-workflow.test.js:100-107`). The connection handler closes over the
`testUserId` variable and connections only happen inside tests, so the existing order is
already safe, but the port SHOULD move user creation ahead of the server start to match
the reference and remove the ordering hazard entirely.

**Alternatives considered**: leave the WS unstamped and accept unattributed rows +
warnings. Rejected — it keeps a known-wrong wiring in a suite this feature exists to
correct, and the warnings pollute the LLM-friendly reporter output (constitution
quality gate).

---

## R3 — Backend: teardown flush

**Findings**: the reference suites collect every `storeUpdate` promise in a
module-level `pendingOperations` array and `await Promise.all(pendingOperations)`
in `afterAll` **before** the `DELETE FROM …` cleanup (`modify-echo.test.js:23,51-54,105-111`).
The current file has no such collection; it only sleeps 100ms twice.

There is a second, subtler teardown hazard the port *removes*: today every timed-out
modify leaves a background `awaitDurableRange` poller running with a 60s bound and a
500ms cadence (`modify.js:635-640`). Those pollers currently outlive the suite. Once
the inline wait resolves, the background branch is never taken.

**Decision**: add the `pendingOperations` array + `await Promise.all(...)` in `afterAll`
ahead of cleanup, keeping the existing sleeps and existing delete order untouched
(FR-003, SC-006).

---

## R4 — Client: is the fake-timer approach viable for this file?

**Findings**: it is already in production use *in this very context's sibling suite*.
`client/src/contexts/__tests__/AiChatContext.test.jsx:563-568` does exactly the shape
this feature needs:

```js
vi.useFakeTimers();
await act(async () => {
  inst.onError(new Error('anthropic error'));
  await vi.advanceTimersByTimeAsync(6000); // past RECONNECT_ESTABLISH_MS
});
vi.useRealTimers();
```

Toolchain confirmed: `vitest@1.6.1` with `@sinonjs/fake-timers@10.3.0`;
`vi.advanceTimersByTimeAsync` and `vi.isFakeTimers()` both exist
(`client/node_modules/vitest/dist/index.d.ts:362`). Vitest's default `toFake` set
includes `setTimeout`/`clearTimeout`/`setInterval`/`Date`, which covers everything the
code under test uses: `waitForReply` is a `Date.now()` deadline plus a
`setTimeout(tick, RECONNECT_POLL_MS)` poll (`AiChatContext.jsx:62-77`), and
`withTimeout` is a `setTimeout` race (`AiChatContext.jsx:33-39`). Both land on the same
fake clock as the test's own `setTimeout`-scheduled stream delivery, which is what spec
Edge Case "the 6500ms scheduled delivery" requires.

**Decision**: RBD-050-1's fake-timer mechanism is confirmed feasible; the fallback
(injectable window, re-opening G-050-1) is NOT needed and MUST NOT be taken.

**Alternatives considered**: `vi.useFakeTimers({ shouldAdvanceTime: true })` — rejected,
it advances in real time and saves nothing.

---

## R5 — Client: the ordering hazards, and where fake timers must be installed

Three concrete hazards, each with its handling:

1. **RTL `waitFor` under fake timers.** `@testing-library/react` v14 detects *Jest*
   fake timers (`jest` global / `setTimeout._isMockFunction`); under Vitest with
   `globals: true` there is no `jest` global, so `waitFor` would keep using the
   (now faked) timers and hang. **Handling**: install fake timers *after* the
   `await waitFor(() => expect(mockApi.get).toHaveBeenCalled())` that opens each test,
   and use no `waitFor` afterwards — which is exactly what the sibling suite's
   precedent does, and exactly how both target tests are already shaped
   (`banner-persistence.test.jsx:148,165`).
2. **The tests' own short settle sleeps.** `sendWith` (line 64) and the late-reply test
   (lines 189, 192, 199) use `await new Promise((r) => setTimeout(r, N))`. Under fake
   timers those never resolve unless the clock is advanced. **Handling**: a single
   file-local helper that stays real when timers are real, so the eight untouched tests
   keep byte-identical behavior:
   ```js
   const settle = async (ms) =>
     (vi.isFakeTimers() ? vi.advanceTimersByTimeAsync(ms) : new Promise((r) => setTimeout(r, ms)));
   ```
   Every `await new Promise((r) => setTimeout(r, N))` in the file becomes `await settle(N)`.
   This is pure wiring — no assertion moves (FR-006).
3. **Two-stage ordering in the late-reply test.** The banner must appear at window
   expiry *before* the late reply retires it. Under one fake clock this is preserved by
   advancing in the same two steps the test already uses: 5500ms (crosses the 5000ms
   establish window, still short of the 6500ms delivery) then 3200ms (crosses 6500ms).
   `advanceTimersByTimeAsync` fires timers in scheduled order and flushes microtasks
   between them, so the `ReadableStream` enqueues are processed by the SDK reader before
   the next assertion — the outcomes are not collapsed into one tick.

**Decision**: fake timers scoped to the two recovery tests only (installed post-`waitFor`,
restored in `afterEach` via `vi.useRealTimers()`), plus the `settle` helper file-wide.
The other eight tests keep real timers and are otherwise untouched.

**Alternatives considered**: global `vi.useFakeTimers()` in `beforeEach`. Rejected —
it puts the opening `waitFor` of all ten tests behind hazard (1) for no benefit; the
other eight tests are already sub-100ms.

---

## R6 — The FR-004 sweep: reproducible enumeration

**Finding**: the backend test tree has **two** roots, per constitution Principle II —
`server/**/__tests__/` and the repo-root `__tests__/integration/`. The spec's spec-time
sweep evidence ("21 `setPersistence` suites") enumerated `server/` only; the full
backend tree has 30 files referencing `setPersistence` (21 under `server/`, 9 under
`__tests__/`). The *conclusion* is unchanged — re-verified 2026-08-04: none of the 9
root files executes a live `modify` through the tool registry, and 8 of 9 already
install per-update listeners — but the sweep command must cover both roots or the
defect class is not provably closed.

**Decision**: the sweep is defined as these commands, run from the repo root at
implement time, with the output pasted into `sweep-results.md`:

```bash
# (a) every backend test file registering persistence
grep -rl "setPersistence" --include=*.test.js server __tests__ | sort
# (b) of those, any that stores without a per-update listener (snapshot-only)
for f in $(grep -rl "setPersistence" --include=*.test.js server __tests__); do
  grep -q "storeUpdate" "$f" && ! grep -q "on('update'" "$f" && echo "SNAPSHOT-ONLY: $f"
done
# (c) files that reach the registry without registering persistence
grep -rln "getTool('modify')\|getTool(\"modify\")" --include=*.test.js server __tests__ \
  | xargs grep -Ln "setPersistence"
```

Each hit is classified **per-update-attributed** / **snapshot-only** /
**not-applicable (mocked registry or name-string only)**. An empty (b) is itself the
recorded deliverable (RBD-050-3, SC-007).

---

## R7 — Execution environment (worktree)

**Findings**: `server/__tests__/helpers/db.js:18` honors `DATABASE_URL` when set and
otherwise targets the shared `collab_test_db`. Per the pipeline's worktree conventions
(`.claude/skills/the-pipeline/SKILL.md:64`), an implementer in a worktree MUST NOT point
at the shared DB — concurrent backend runs against it corrupt fixed-key rows (this is a
recorded, repeated failure mode).

**Decision**: the implementer creates `collab_test_db_050`, runs `npm run migrate` and
every backend command with `DATABASE_URL=…/collab_test_db_050`, and keeps `--runInBand`
(already wired into `test:server`) intact — within one database, backend tests remain
serial-only. Parallel execution is Train C (052), explicitly out of scope here (FR-009).

---

## Summary of decisions

| ID | Decision |
| --- | --- |
| R1 | Per-update `storeUpdate(docGuid, update, userId, agentName)` listener in `bindState`; `writeState` becomes a no-op |
| R2 | Carry `ORIGIN_DB_LOAD` on the initial apply and stamp `ws.userId`/`ws.agentName`; move user creation ahead of server start |
| R3 | `pendingOperations` array flushed with `await Promise.all(...)` before `afterAll` cleanup |
| R4 | Fake timers confirmed feasible (in-repo precedent, same context); RBD-050-1 fallback not needed |
| R5 | Fake timers scoped to the two recovery tests, installed after the opening `waitFor`; file-wide `settle(ms)` helper |
| R6 | Sweep enumerated over BOTH backend roots (`server` and `__tests__`), results recorded even when empty |
| R7 | Per-worktree `collab_test_db_050` via `DATABASE_URL`; `--runInBand` preserved |
