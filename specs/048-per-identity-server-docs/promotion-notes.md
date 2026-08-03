# Promotion notes — 048-per-identity-server-docs

Implementation record for the merge queue. Everything below is a deviation from
`plan.md` / `tasks.md` as written, or a finding the queue needs. All 30 tasks
completed.

---

## Deviations from plan/spec, with rationale

### D1 — U2's premise was wrong: a title set was never undoable (affects T015, FR-009)

`contracts/invariant-guards.md` U2 and tasks T015 call for a test that "an agent
title set performed through the new mechanism remains undoable exactly as
today". Implementing it revealed that a title set is **not** an undo target and
never has been: `computeInverse` (`server/undo/inverse.js:99`) builds its
`Y.UndoManager` over the `default` XmlFragment only, so a write to the `meta`
map produces an empty undo stack and `performInverse` returns the honest empty
(`undone: false`).

Asserting undoability would have asserted a bug into existence. The test was
written to pin the true, unchanged semantics instead, and to assert positively
on what 048 could actually have broken:

- the title-set row still carries the acting `(userId, agentName)` stamp;
- its insert set carries a fresh one-shot clientID, never the shared doc's;
- undo returns the honest empty rather than erroring or inventing a target;
- the title is left untouched.

**This is behavior-preserving and needs no product decision** — "exactly as
today" is satisfied, the spec's assumption about what "today" was is what was
wrong. Flagging it because FR-009's wording implies otherwise and a reader of
the spec alone would expect a different test.

### D2 — U1/U2/P1 live in the MCP undo integration suite, not `__tests__/integration/`

T015 says `__tests__/integration/` and "beside the existing undo integration
suites". Those two are different places: the undo integration scaffolding
(tool registry, agent presence, undo service, a real WS server) lives in
`server/mcp/__tests__/integration/undo-redo-workflow.test.js`. The tests were
placed beside the scaffolding rather than duplicating ~90 lines of setup.

### D3 — T024 extended the sync-push REPLAY suite, not the route suite

T024 permits extending "the unit suite owning `syntheticClientId`". The
determinism half of P2 was **already asserted**
(`server/__tests__/markdown-sync.replay.test.js:122-157`), so per T024's "ONLY
if this exact pin is not already asserted" it was not duplicated. What was
missing is the pin against the PRODUCTION call site — that `applySyncPush`
really pins the clientID *before* any op exists. That was added there.

### D4 — T005's sweep was much wider than the five named suites

The task named five suites plus "any others found by
`grep -rl "updateDocument\|createSeededDocument" server/__tests__ __tests__`".
That grep misses `server/mcp/__tests__/` entirely, and it misses every suite
that reaches `updateDocument` **indirectly** through an MCP tool or route.

The sweep was redone against every fake `bindState` in the repo: **24 files**
were marked `_bindComplete = true` at the end of their fake load, mirroring what
the real `createBindState` does. Three files matched the search but correctly
needed nothing (`collab-extraction-guard.test.js` greps source text;
`awareness-spoof-block.test.js` deliberately omits `setPersistence`;
`collab-harness.js` uses the real `createBindState`). Two named suites
(`document-titles.test.js`, `update-classifier.test.js`) also needed nothing —
they use `persistence.*` directly and never touch the service seam.

### D5 — T020: one existing assertion encoded the old ordering and was corrected

`version-history.test.js` T024 ("a terminal storeUpdate rejection on the live
path…") asserted that a failed store still left the restore applied to the live
doc and already broadcast to its editors. That is the broadcast-then-store shape
RBD-048-2 deliberately flips. The test's load-bearing claims are unchanged and
still asserted (the caller is told; no row; no `agent_edits` record); the two
ordering-dependent assertions were inverted to the new, safer truth: nothing is
shown to anyone for a restore that did not commit. Renamed accordingly.

**No assertion was weakened** — the new shape is strictly stronger (it adds "and
the live document did not diverge from the log").

### D6 — AS3 needed deterministic gating to test the stated semantic

T021's "a concurrent edit landing during the store await" is only reproducible
if the edit is guaranteed to land *after* the seed. Sending it right after
invoking `restoreVersion` races the restore's own initial DB reads, and an edit
that lands before the seed is legitimately *replaced* rather than merged (a
different, also-correct outcome — the suite's D2 discipline forbids naming a
race winner). The test now blocks the restore's own `storeUpdate`, waits until
it is inside that gate, then types. The gate discriminates the restore's write
from the bindState listener's by its options object; gating both deadlocks.

### D7 — Verification ran in the worktree against a feature-owned database

`tasks.md` says to run suites "from `/local-dev`". Per the orchestrator's
worktree isolation and serial-DB rules, everything ran from this worktree
against `collab_test_db_048`, serially. The merge queue re-verifies
authoritatively in the main tree.

---

## Findings the merge queue should know

### F1 — `REDIS_HOST` is required, and its absence looks like a hang

`npm run test:server` sets `REDIS_HOST=${REDIS_HOST:-localhost}`. Invoking
`npx jest` directly without it makes Redis-touching suites (`live-fanout`,
`import-presence`, the integration suites) hang with **no output at all** rather
than fail — easily misread as a regression. Reproduced against the unmodified
base commit before concluding it was environmental. Any direct-jest invocation
needs `REDIS_HOST=localhost`.

### F2 — SC-004 deliberate-regression check: PASSED (T026, not committed)

With `updateDocument` changed on a scratch edit to transact directly on the
shared doc, **9 guards failed**: G1 (all three shapes — content insert, meta
title set, seeded create), G3, G4, G4b, G5, and the two C1 per-path tests.
Scratch reverted; `server/document-service.js` is byte-identical to its
committed state. The guards genuinely fail on regression rather than restating
the implementation.

### F3 — H1 was verified to reproduce the bug, not just the fix

With the readiness gate removed, H1 (title set on a cold doc) fails. The
half-loaded class is a real reproduction of the lost-write the review found.

---

## Analyze-gate MEDIUMs — dispositions

- **C1 (per-path tests for the empty-import anchor and chat `insert_image`)**:
  ADDED. Neither had behavioral coverage. Both are now pinned in
  `per-operation-doc.test.js` for placement correctness (the anchor only seeds a
  genuinely empty doc and returns the zero value otherwise; the image insert
  honours start/end against the *loaded* body) and for one-shot authorship.
- **C2 (ephemeral doc never announces awareness)**: ADDED as G4b. Asserts the
  doc handed to `updateFn` has no `conns`, no `_redisUpdateHandler`, no
  `awareness`, and no surviving update listeners — it is never registered
  anywhere awareness could reach it.
- **C3 (SC-001 may need a fresh-resolver simulation)**: NEEDED and ADDED.
  `_resetForTest()` only clears caches within one module instance, which is not
  the cross-process condition SC-002 describes. The test uses
  `jest.isolateModules` to build two genuinely independent resolver instances
  (one wired with `peekSharedDoc`, one with nothing) and asserts identical
  answers.
- **A1 (T009 must explain why BOTH the gate and the post-merge check exist)**:
  DONE. `server/document-service.js` carries a "WHY THIS EXISTS ALONGSIDE THE
  GATE ABOVE" block naming the two distinct windows, and `bind-failure.js` was
  updated to match.

---

## Merge-queue obligations (restated from plan.md)

1. **README sweep (Principle I handoff)** — this agent is forbidden to edit
   `README.md`, `docs/dev.md`, `CLAUDE.md` or `design/`. Wherever README
   describes server-side write attribution, the shared server doc, or restore's
   broadcast/store ordering, it must be updated to the per-operation-doc +
   store-then-apply account.
2. **Design-doc note** — RBD-048-4 resolves a design SILENCE (bind-completion
   before seeding). If Sam wants the gate stated in the design section, that is
   a Squire-doc amendment + `node design/sync.mjs`, never a hand-edit.
3. **Deploy posture** — one-replica constraint UNCHANGED (FR-012). M3 and M4
   remain open scale-out gates; nothing here enables multi-replica operation.
4. **No migration** — 048 is code-only. The migration slot stays free.
