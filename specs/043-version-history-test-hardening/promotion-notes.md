# Promotion notes: 043-version-history-test-hardening

**Implemented**: 2026-08-02/03, in a worktree off `main` at `ddcb6ca9`
(041, 042, 044 and 045 all merged and verified present before any work began).

---

## 1. THE BLOCKER: extraction X1 did not land, and neither did US1/US2/US3

**This is the most important item in this file. The feature's headline
deliverable is not in this branch.**

X1 — moving the `bindState` update listener out of `server/index.js` into
`server/collab-bind-state.js` — was implemented, verified, and then **reverted**.

### Why

The listener is the only place `user_id`, `agent_name` and `via_sync` are
written for a live edit, so FR-001 (US1's attribution E2E), FR-003 (US2's
reconnect catch-up E2E), FR-004 (US3's persistence-failure pin) and FR-006(a)
(US5's classify-listener mirror) all ride on it being importable. Ledger D9
budgeted for exactly that.

D9's stated ceiling was feature 038's C1 guard in
`server/__tests__/ws-edit-gate.test.js` (`installGate` exactly once, the
`request.tokenMayWrite` literal). That ceiling held — T004 confirmed it before
any work, and the new G7 guard re-asserts it.

What D9 did **not** survey is that **feature 041 added its own structural pins
to the same file**. `server/__tests__/bindstate-failure.test.js:259-283`
("PIN: server/index.js bindState wiring") greps `server/index.js` for:

```
/if \(ydoc\._bindFailed\) return;/
/refuseBind\(\{\s*docName,\s*docGuid,\s*ydoc,\s*error,\s*docs,\s*notify: notifyException\s*\}\)/
```

Both literals live **inside the block X1 moves**. With X1 applied, the full
backend suite ran **242 suites, 4365 passed, 2 FAILED** — both of them those
pins, and nothing else. The extraction was otherwise faithful.

Making X1 land therefore requires editing a shipped guard belonging to another
feature. `bindstate-failure.test.js` is not on this feature's
permitted-modification list, and the implementer brief is explicit: *"If an
extraction now breaks a pre-existing test, it is out of budget (D9's hard
ceiling): STOP and report rather than editing that test."* So it was stopped
and reported rather than forced through.

### The remedy, for whoever ratifies it

The fix is small and does not weaken anything. 041's pins exist because 041's
behavior tests drove their own harness copy, so a source grep was the only way
to prove production matched. X1 makes that obsolete in the best way — the code
becomes importable and drivable directly. The minimal faithful change is to
repoint the two regexes at `server/collab-bind-state.js` (identical patterns,
different file), ideally noting that the behavior is now driven directly.

Once ratified, X1 plus the US1/US2/US3 suites are roughly a day of work; the
X1 module itself was written and passed everything except those two greps, and
is recoverable from this branch's history.

### What is consequently NOT delivered

| Item | Tasks | Status |
|---|---|---|
| X1 extraction + call site | T016, T017 | reverted, blocked |
| X1 half of the drift guard (G1/G2/G3) | part of T019 | dropped; G4-G7 landed |
| US5(a) classify listener driving real code | T020 | blocked — the mirror in `update-classifier.test.js:116` **still stands** |
| US1 attribution E2E (the MVP) | T024-T031 | blocked; T030 landed independently |
| US2 reconnect catch-up E2E | T032-T036 | blocked |
| US3 persistence-failure pin | T037-T041 | blocked |
| US4 restore concurrency | T042-T046 | not attempted (was sequenced after the blocked harness) |
| The shared WS harness | T024-T026 | not built |

**US2 verdict (explicitly asked for): NOT ANSWERED.** The reconnect E2E was
never built, so this branch provides no evidence either way about whether 045's
via_sync-aware timeline behaves correctly end to end. That question is still
open and should not be recorded as passing.

---

## 2. What DID land

- **X2** `identityFromPrincipal` → `server/agent-identity.js`, wired in
  `server/index.js`. The derivation that fixed the historical misattribution bug
  is now drivable, and is driven — including the inverted-bug case (a human
  principal picks up no agent name, in either connection order).
- **X3** `shouldPublishToRedis` → `server/origin.js`. `origin.test.js`'s local
  copy is gone; its nine existing expectations now run against production.
- **X4** `createUndoStatusRouter` → `server/api/undo-status.js`, mounted in
  `server/index.js`. `undo-status-api.test.js` mounts the real router, and a new
  assertion covers the `console.error` the old mirror had already dropped —
  concrete evidence for FR-006.
- **X-GUARD** `server/__tests__/collab-extraction-guard.test.js` (7 tests):
  positive + negative source greps for X2/X3/X4, plus G7 re-asserting the D9
  ceiling as a tripwire on this feature's own budget.
- **FR-002/SC-001**: both `expect(true).toBe(true)` blocks deleted, along with
  a fourth local copy of the y-websocket protocol constants. Repo-wide grep for
  that tautology now returns nothing.
- **US6** (FR-008/SC-005): both complete diff pipelines driven end to end from a
  shared `Y.Doc` fixture; parity asserted on plain prose; **four** ratify-or-fix
  divergence pins (bold, emphasis, inline code, hard break) with the FR-014
  header naming 039 A1.
- **US7** (FR-009/SC-006): 14 new component tests across the two files.
- **US8** (FR-010/FR-011): the cleanup convention recorded once and applied;
  all eight wall-clock assertions replaced by behavioral ones; four sleeps in
  `collaboration.test.js` replaced by condition polling.

---

## 3. Deferred, with owners

- **Browser E2E (Playwright)** — deferred, owner **Sam** (FR-013 / ledger D7).
  Not attempted. This is a decision, not a gap.
- **The six out-of-area orphaning suites** (ledger D11) — `backfill-meaningful`,
  `documents`, `onboarding`, `postgres-gap-read`, `integration/faucet-wipe`,
  `integration/prod-reset` — still leave `yjs_updates` rows behind. FR-010 scoped
  the retroactive pass to the version/undo suites, and that scope was honored.
  `cleanupDocRows` is exported, so sweeping them is now cheap whenever scheduled.
- **Stretch items S1/S2/S3** (T068-T070, ledger D6) — dropped. They are P4 by
  construction and the budget went to the blocker analysis.
- **US3's "not loaded" restore path** (analyze finding C10) — deferred; US3 did
  not land at all.

---

## 4. For the merge queue

- **`docs/dev.md` owes a testing-convention pointer** (analyze finding C9). The
  implementer worktree is forbidden from editing it, so this is owed to whoever
  merges. Suggested: a line under the backend-testing section pointing at the
  cleanup convention block in `server/__tests__/helpers/db.js` — every suite
  that causes `yjs_updates` rows to exist deletes them by `doc_guid` in
  `finally`/`afterAll`.
- **`main` had not moved** when this branch finished. The 045 post-merge review
  fixes (shared server-doc clientID exclusion, resolver concurrency
  serialization, the REST export author surface, the clearDoc memo hook) were
  still in flight; `git merge main` was a no-op at `ddcb6ca9`. **Re-merge and
  re-run before promoting.** No assertion in this branch touches
  `resupply-resolution.js`, `docs-export.js` or `read-document.js`, so no
  expectation shift is anticipated — but that is a prediction, not a check.
- The spec's Verification Notes say **nine** `toBeLessThan(300)` assertions in
  `postgres-gap-read.test.js`. The true count was **eight** (analyze C3,
  re-confirmed post-merge). All eight are gone.
- `specs/043-.../clarifications-needed.md` has the dated re-verification note
  from the T001-T012 gate, including the divergences found against merged main.
