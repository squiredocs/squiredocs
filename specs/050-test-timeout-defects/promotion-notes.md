# 050-test-timeout-defects — promotion notes

Seeded by the implementer for the merge queue and the post-merge adversarial
review. Branch `050-test-timeout-defects`, off `main` @ `f7a9f292` (the commit
that carries this feature's own spec/plan/tasks).

**What shipped**: the two measured test-suite timeouts from
`design/test-suite-architecture.md` Part 1 §1.1 and §1.2 are gone. Backend
`document-editing-workflow.test.js` went from 103.5s to 6.5s by moving to the
post-016 per-update identity-attributed persistence pattern; client
`AiChatContext.banner-persistence.test.jsx` went from 14.7s to 0.36s by putting
its two recovery tests on Vitest fake timers.

**Test wiring only. Zero product files changed. Zero migrations. Zero policy
changes.** Nothing to deploy — the application is byte-identical.

---

## Relaxations owed to promotion

**None.** No assertion was weakened, removed, or reordered, and no gate was
lowered. The only assertion-level change is strictly additive: 20 new
`expect(<result>.editRangePending).toBeUndefined()` guards (FR-006 / RBD-050-2).

---

## Files

| File | Change |
|---|---|
| `server/mcp/__tests__/integration/document-editing-workflow.test.js` | `setPersistence` ported to per-update attributed listener; `ORIGIN_DB_LOAD` on initial apply; `writeState` → no-op; `provider: persistence`; WS identity stamping; user creation moved ahead of `listen`; `pendingOperations` flush in `afterAll`; 20 additive `editRangePending` guards |
| `client/src/contexts/__tests__/AiChatContext.banner-persistence.test.jsx` | `settle(ms)` helper + substitutions; `vi.useRealTimers()` in `afterEach`; `vi.useFakeTimers()` in the two recovery tests; obsolete 10000/20000 per-test timeouts dropped |
| `specs/050-test-timeout-defects/sweep-results.md` | NEW — FR-004 sweep, both backend roots, empty result recorded |

---

## For the reviewer's attention

### 1. The WS identity stamping goes beyond a literal reading of US1 scenario 4 (analyze finding F1, MEDIUM)

T010 stamps `ws.userId` / `ws.agentName` in the connection handler and moves the
test-user `INSERT` above `httpServer.listen`. A literal reading of US1 acceptance
scenario 4 ("only the `setPersistence` wiring, and any teardown flush it
requires, differs") does not obviously cover this.

**It was KEPT deliberately**, per plan A3 / research R2 and the analyze
disposition: both reference suites do it, production does the equivalent in the
auth middleware, and without it any update arriving over the suite's
`agentPresence` sockets parses as an unrecognized origin and persists
unattributed — re-introducing a smaller version of the very defect being fixed.

**If the reviewer objects**, the remedy is to drop T010's stamping (and the
user-creation move with it) — never to reinterpret the spec. Everything else in
the port stands on its own.

### 2. The quickstart's `grep -c editRangePending` gate is vacuous — do not rely on it

`quickstart.md` and T012 propose `grep -c editRangePending /tmp/050-backend.log`
as the SC-002 check, expecting `> 0` before and `0` after. **It reads `0` in both
logs.** The flag is a field on the returned result object and is never printed to
stdout, so the grep never had anything to match, before or after. It is not a
discriminating gate and a reviewer should not read a `0` as evidence.

SC-002 was instead verified two ways, both stronger:

- **The 20 added in-suite assertions.** These are the durable gate and are what
  keeps SC-002 enforced going forward.
- **A discrimination check** proving those assertions are not vacuous: with the
  per-update listener temporarily neutralized (simulating the pre-016 wiring),
  `modify: append text to existing paragraph` failed at
  `expect(result.editRangePending).toBeUndefined()` and took **5084 ms** again.
  Restored immediately; the temporary edit is not in any commit.

Suggested follow-up (not taken here — quickstart.md is a committed input
artifact and out of this train's edit scope): replace that grep line with a
pointer to the in-suite assertions.

### 3. The undo/redo record-backed path risk did NOT materialize

Plan A5 / T014 flagged that `undo should succeed` and `redo should succeed` would
exercise the **record-backed** undo path for the first time after the port —
today they ride the legacy-derivation path only because every modify times out
and `recordEdit` lands in the background.

Both pass: `undo should succeed` 254 ms, `redo should succeed` 248 ms (baseline
4980 ms / 4990 ms). No assertion was relaxed and no wiring was reverted. The
record-backed path is now genuinely covered by these two tests for the first
time — a coverage gain the reviewer may want to note.

### 4. Guards were added to the two deliberately-failing modifies as well

`badResult` in the Mermaid and SVG error tests is a modify that surfaces a
script-level error. Its `editRangePending` is trivially undefined, so those two
guards are vacuous rather than load-bearing. They were included for uniformity
because T013 says "for every `modify` result the suite captures". Harmless and
strictly additive; drop them if the reviewer prefers signal density.

### 5. Two previously-unbound modify results are now bound

The setup modifies in `undo should succeed` and `redo should succeed` were
`await executeScript.handler(...)` with no assignment. T013 required binding them
to attach the guard; they are now `const setupResult = await ...`. The name does
not collide with the `result` each test already uses for the undo/redo call.
