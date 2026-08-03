# Promotion notes: 043-version-history-test-hardening

**Implemented**: 2026-08-02/03, in a worktree off `main` at `ddcb6ca9`
(041, 042, 044 and 045 all merged and verified present before any work began).

**Completed**: 2026-08-03, branch `043b-collab-bind-state` off the partial merge
`af0a78e7`. The blocker described in §1 was ratified and cleared; X1, the shared
harness and US1-US4 all landed. §1 is kept as the historical record, with its
resolution at the top. New material: §1a (how the blocker was cleared), §1b (the
US2 verdict) and §1c (a NEW DEFECT this work discovered).

---

## 1a. THE BLOCKER IS CLEARED

X1 landed. The two feature-041 source pins that blocked it were **repointed, not
relaxed**, under explicit orchestrator authorization.

`server/__tests__/bindstate-failure.test.js`, describe block
`PIN: bindState wiring`:

| Assertion | Before | After | Why it is equivalent |
|---|---|---|---|
| `refuseBind({...})` | greps `server/index.js` | greps `server/collab-bind-state.js` | regex byte-identical; X1 moved the subject verbatim into that file |
| `if (ydoc._bindFailed) return;` | greps `server/index.js` | greps `server/collab-bind-state.js` | regex byte-identical; same reason |
| NEW DOC / `BIND_STATE_NEW_DOC` absence | `not.toMatch` on `index.js` | `not.toMatch` on `index.js + collab-bind-state.js` | its subject (the bindState catch) moved too; reading BOTH files is strictly **stronger** than before — a re-inlined branch now fails wherever it reappears |
| M1 `isCurrentDoc` identity check | `index.js` | **unchanged** | X1 does not move it; it lives in the close-time Redis cleanup at `server/index.js:2396` |

The extraction itself is move-only. `docs` is passed to `refuseBind` by
shorthand exactly as before, specifically so the pinned regex stays byte-exact.
No other pre-existing test needed to change.

**Drift protection did not weaken — it followed the code to its new home**, and
gained the G1-G3 structural guards in
`server/__tests__/collab-extraction-guard.test.js` on top: index.js must require
`./collab-bind-state`, must contain no `ydoc.on('update'` of its own, and must
contain no re-inlined `parseOrigin` / `viaSyncFromOrigin` /
`classificationDisabled` / `classifyByXml` / `storeUpdate` sequence.

While writing G1 a **pre-existing bug in the guard's own comment stripper** was
found and fixed: an unanchored `/\*[\s\S]*?\*\//` matched a `/*` inside index.js's
CSP string (`https://*.googleusercontent.com`) and swallowed ~4KB of real code
including the whole `setPersistence` call. That silently disarmed the positive
greps. The pattern is now anchored to line starts and a meta-test asserts the
stripper's output still contains real code.

---

## 1b. THE US2 VERDICT: **PASS** — 045 is verified end to end

`__tests__/integration/sync-catchup-e2e.test.js`, 4 tests, all green. A genuine
`SYNC_STEP2` catch-up frame, sent over a real socket by a real editor-token
client whose replica holds an edit the server never durably saw:

1. **persists `via_sync = true`** under the *relayer's* identity, while the
   author's own direct row stays unflagged;
2. **the real `getVersionTimeline` never credits the relayer** — asserted as
   `relayerCredits === []` — and *does* credit the true author;
3. **the real undo derivation refuses across it**: `_isIdentityRow` returns
   false for a `via_sync` row even against its own stamped identity, and
   `deriveLegacyRange` refuses for the relayer. 041 FR-014 also holds:
   `hasPendingRecording` no longer wedges on a `via_sync` row;
4. **negative control**: the identical frame from a *viewer* is blocked by the
   real gate (`WS_STEP2_BLOCKED`), applies nothing and persists nothing.

**The verdict is non-vacuous**, pinned three ways, because the author also has a
direct row in the same document and a weaker suite could have passed on that
alone:

- `resolveForRows` asked directly about the `via_sync` clock returns
  `unresolved: false` with `origins === [author.userId]`;
- `authorForSingleSlot` for that row names the author, with `isSynced` unset;
- **the control that proves 045 is what does the work**: running the *same*
  production `groupUpdatesIntoVersions` over the *same* rows with resolution
  switched off — the documented pre-045 baseline — **does** credit the relayer.

No 045 defect was found. The campaign's open question is closed.

---

## 1c. NEW DEFECT (LOW, ops-signal degradation) — double-paging on terminal write failure

**Found by US3. Not fixed here; out of this feature's budget. Route to
convergence.**

**Where**: `server/collab-bind-state.js:186-189` — byte-for-byte what
`server/index.js` already ran before X1, so this is pre-existing, not
introduced.

```js
const writePromise = persistenceProvider.storeUpdate(...);   // 186
pendingWrites.add(writePromise);                              // 187
writePromise.finally(() => pendingWrites.delete(writePromise)); // 188  <-- derived branch
writePromise                                                  // 189
  .then(async () => { ... })
  .catch((err) => { /* CRITICAL log + notifyException */ });   // handled
```

**Mechanism**: `.finally()` returns a **new** promise that rejects with the same
reason. Line 189's `.then().catch()` handles `writePromise` itself, but nothing
ever handles the promise line 188 returns. So a terminal persistence failure
emits a process-level `unhandledRejection` **in addition to** the listener's own
`notifyException({ source: 'persistence' })`. Reproduced minimally on the pod's
Node v22.23.2.

**Severity: LOW.** **Verified, not assumed**: production installs a
**non-exiting** handler — `setupProcessHandlers` at
`server/exception-notifier.js:150-154` logs and notifies on
`unhandledRejection`; only `uncaughtException` (line 142-148) calls
`process.exit`. So this does **not** kill the pod and is **not** a durability
event. The harm is alerting precision: every terminal write failure pages
**twice**, once as `persistence` and once as `unhandledRejection`, diluting the
signal exactly when a real data-loss incident is in progress.

**Recommended fix** (one line, no behavior change):

```js
writePromise.finally(() => pendingWrites.delete(writePromise)).catch(() => {});
```

The rejection is already fully handled on line 189; this only silences the
duplicate branch.

**Test impact today**: `__tests__/integration/helpers/collab-harness.js`'s
failure injection returns a `SelfHandledRejection` (a `Promise` subclass whose
`.finally()` marks its derived branch handled) purely so the US3 suite
characterizes the loss path instead of dying on this side effect. **When the
defect is fixed, that subclass becomes unnecessary and should be deleted** — its
docblock says so.

---

## 1d. Dropped deliberately: the step2-viewer-block mirror (analyze finding C6)

`__tests__/integration/step2-viewer-block.test.js:111-133` still carries its own
hand-written `bindState`. X1 makes repointing it *possible*; it was **not** done,
on purpose:

- it is a **pre-existing suite belonging to feature 038**, and this branch's
  verification bar is "no pre-existing test modified beyond the two authorized
  pin repointings". Repointing it is a separate, ratifiable change;
- its mirror is a **transport fixture for a security test about frame gating**,
  not a copy of an attribution decision. Its assertions are about
  `WS_STEP2_BLOCKED`, not about who a row is credited to, so the drift risk that
  justified X1 does not apply to it;
- **the coverage gap it represented is now closed elsewhere.** The US2 negative
  control (`sync-catchup-e2e.test.js`) drives the identical viewer-step2 block
  through the REAL `createBindState`, so the behavior 038 cares about is now
  asserted against production wiring regardless.

Recommended, not urgent: fold it into `collab-harness.js` in a future pass, and
delete its local `extractDocGuid` and frame constants at the same time.

---

## 1. THE BLOCKER (historical record — cleared, see §1a)

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
