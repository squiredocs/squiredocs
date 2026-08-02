# Quickstart & Validation — 044-presence-awareness-guard

How to run and prove this feature. Commands run **inside the Minikube `app-dev` pod** from
the repo root (`docs/dev.md`).

---

## Prerequisites

- No migrations. No schema change. No env vars.
- The new integration suite needs **no database** — awareness state never persists, so the
  mini-server stands up without `setPersistence`. The shared-DB serial-run constraint
  (Constitution II) still applies to the rest of the backend suite; the implementer runs
  against a per-worktree database.
- Nothing to seed. Nothing to deploy for the tests to pass.

---

## Run the suites

```bash
# Unit — the guard module itself
npx jest server/__tests__/ws-awareness-guard.test.js --runInBand

# Unit — the interceptor + the structural drift guards (extended 038 suite)
npx jest server/__tests__/ws-edit-gate.test.js --runInBand

# Protocol-level end-to-end — real frames, real installGate, real setupWSConnection
npx jest __tests__/integration/awareness-spoof-block.test.js --runInBand

# Regression: presence paths this feature must not disturb
npx jest server/__tests__/awareness-removal-propagation.test.js \
         server/__tests__/import-presence.test.js \
         server/__tests__/live-fanout.test.js \
         __tests__/integration/step2-viewer-block.test.js --runInBand
```

Expected: all green. The 038 suites must pass **unmodified in behavior** — the only edits to
`ws-edit-gate.test.js` are *additions* (awareness cases, extended C1 guards).

---

## Scenario 1 — the reviewer's exploit now fails closed (US1 / SC-001)

Covered by `__tests__/integration/awareness-spoof-block.test.js`. Reproduces the exploit
recorded in `specs/038-attribution-integrity/promotion-notes.md`:

1. Connection **A** (user `alice`, viewer) connects and announces awareness for its own
   clientID `Ca` with `{ user: { name: 'Alice' } }`.
2. Connection **C** (user `carol`) connects as an observer, so fan-out is measurable.
3. Connection **B** (user `bob`, *view-only*) hand-crafts an awareness frame carrying `Ca`
   with a higher clock and `{ user: { name: 'MALLORY' } }`.

**Expected**
- `doc.awareness.getStates().get(Ca)` still holds Alice's state, unchanged.
- Connection **C** receives **no** frame containing `Ca` as a result of B's send.
- One `WS_AWARENESS_BLOCKED` event with `foreignIds: [Ca]`.
- Connection **B** stays `OPEN` and receives no error frame.

**Variants asserted in the same suite**
- **Eviction attempt**: B sends `Ca` with a `null` state → Alice's presence is *not*
  removed (this is the nastier half of the finding).
- **Mixed frame**: B sends one frame asserting both `Cb` (its own) and `Ca` → whole frame
  dropped; `Ca` unchanged **and** `Cb` not updated from that frame (Q2, no partial apply).
- **Non-minimal varint**: the same spoof with `Ca` encoded as a padded varint
  (`0x8N 0x00…`) is dropped identically — the byte-index bypass of 038, re-tried here.
- **Truncated-tail smuggle** (research R2): a frame whose first entry is a well-formed
  spoof of `Ca` followed by garbage is dropped, even though the applier would have applied
  the prefix before throwing.

---

## Scenario 2 — honest presence is untouched (US2 / SC-002)

Same integration suite; each FR-006 case gets its own assertion.

| Case | Send | Expect |
|---|---|---|
| (a) own announce / update | A announces `Ca`, then moves its cursor | Applied and broadcast to C both times |
| (b) own removal | A sends `Ca` with `null` state | `Ca` removed from `getStates()`; C sees the removal |
| (c) reconnect, stable id | A' (same user `alice`, new socket) asserts `Ca` while A's socket is still registered | **Allowed** — no `WS_AWARENESS_BLOCKED`; same-user tie-break (Q3) |
| (c′) different user, same id | B (`bob`) asserts `Ca` under the identical conditions | **Dropped** — proves (c) is a same-*user* carve-out, not a same-*id* one |
| (d) agent / import presence | A connection with an agent principal announces its own fresh clientID | Applied; no special case in the guard |
| (e) Redis relay | `applyAwarenessUpdate(doc.awareness, update, ORIGIN_REDIS)` carrying a clientID owned by no local connection | Applied — the relay never traverses the gate (FR-008) |
| unclaimed id | Any connection announces an id nobody owns | Applied — first-writer-wins claim |
| zero-entry frame | A frame with `entryCount = 0` | Passed through |
| undecodable frame | Garbage after the awareness message type | Passed through; the applier rejects it as it does today |

**Zero `WS_AWARENESS_BLOCKED` events across the whole of Scenario 2** is the assertion that
operationalises SC-002.

---

## Scenario 3 — spoofing is observable, logs are bounded (US3 / SC-003)

Unit-level, with an injected clock (no `sleep`, no flake):

1. Drive 500 dropped frames through one connection inside a single 60 s window.
2. Assert exactly **one** `onBlocked` emission, carrying `dropped: 500`.
3. Advance the fake clock past the window, drop once more, assert a **second** emission
   carrying the accumulated `sinceLastLog`.
4. Assert a *second connection* spoofing in the same window produces its **own** first
   emission — suppression is per connection, so no attacker can silence another's alarm.

---

## Scenario 4 — the wiring is real, not a copy (structural)

In `server/__tests__/ws-edit-gate.test.js`, extending 038's `C1` block:

- `server/index.js` requires `./ws-edit-gate` and calls `installGate(` **exactly once**.
- `server/index.js` passes `getConns` to it.
- `server/index.js` defines no awareness parser of its own — in particular
  `parseAwarenessClientIds` does not reappear there (038 US5's deletion stands; see the
  contract §6).
- `server/index.js` still contains no `ws.emit =`.

This is the layer that catches "the test exercised a copy of the code, not the code" — the
failure mode 038 exists to kill.

---

## Manual check (owed to Sam, post-deploy)

Not automatable here, and not a gate for merge:

1. Open the same document in two browsers as two different users. Confirm both avatars
   appear, cursors move, and closing one tab evicts that avatar promptly (5 s ping).
2. Trigger an agent edit and confirm the "Squire Docs Assistant" avatar appears and sweeps.
3. Kill the network on one tab and restore it; confirm the avatar returns within ~15 s and
   the server log shows **no** `WS_AWARENESS_BLOCKED` for that reconnect.
4. `grep WS_AWARENESS_BLOCKED` in prod logs after a day of normal traffic: the expected
   count is **zero**. Any hit is either a real attempt or a false positive worth chasing.
