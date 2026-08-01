# 038-attribution-integrity — promotion notes & review dispositions

Post-merge adversarial review, 2026-08-01. Merge commit `ede30096`; review
covered `bf69ad17..ede30096` plus the docs follow-up `a396ebc0`.

## HIGH — viewer write bypass via non-canonical varint headers — FIXED (`902acf9c`)

**Finding.** `classifyFrame` matched fixed byte positions (`data[0]`, `data[1]`),
but the sync header fields are lib0 **varints**, and lib0's `readVarUint`
accepts non-minimal encodings — `0x80 0x00` decodes to `0`, `0x82 0x00` decodes
to `2`. The header `80 00 82 00` was therefore an ordinary sync/update to
y-protocols and "not an edit" to the gate. A user with **view** access could
open a socket to `/s/{docId}` with their own cookie, send those four bytes plus
an update payload, and write to a document they cannot edit — persisted as a
normal `yjs_updates` row attributed to themselves. Reproduced end-to-end by the
reviewer against the real `installGate` + real `setupWSConnection`.

Not a regression: the pre-038 `isEditMessage` had the identical byte-index
shape, so the *update* rule was bypassable the same way and had been for as long
as the gate existed. But it falsified 038's central claim and left FR-001 /
SC-002 unmet, so it was fixed same-day rather than deferred.

**Fix.** `classifyFrame` decodes with the same `lib0/decoding` primitive
y-websocket uses. The invariant, stated at the call site: *classify the frame
the same way the applier parses it* — the gate's view cannot drift from the
applier's view. Undecodable headers remain "not an edit" and fall through, as
before (y-websocket's own decode rejects the same bytes).

**Test.** The pre-existing suites could not have caught this: they assert what we
*believe* the protocol does, and `installGate`'s tests use a fake ws that never
runs a real decoder. Added `classification matches the REAL applier`, which runs
candidate frames (canonical, non-minimal 2- and 3-byte varints, awareness,
unknown sub-types, truncated, empty) through the genuine `readSyncMessage` path
and asserts: **if a frame mutates the document, the gate must classify it as an
edit.** Verified to fail against the pre-fix implementation. A new message type
or another encoding trick now fails there without anyone having to anticipate it.

**Lesson worth carrying.** This is the third instance in this feature's history of
the same root cause: a *second model of the protocol* drifting from the real one.
First the hand-written test mirror that copied the step2 bug; then the gate's
byte-index model versus the varint decoder. The structural answer both times was
to delete the second model rather than correct it.

## MEDIUM — any viewer can spoof or evict another participant's presence — DEFERRED, tracked

**Finding.** Awareness frames are deliberately ungated (correct — presence is the
read path), but `applyAwarenessUpdate` accepts an update for **any** clientID
whose clock is higher; the server's self-protection covers only its own
clientID, not remote clients. A viewer can send an awareness frame carrying a
victim's clientID and either overwrite their displayed name/colour or evict
their presence entirely, fanned out to every connection and cross-instance.
Reproduced by the reviewer.

**Disposition: not fixed here.** Pre-existing and independent of both 038 and
039 — no code in this diff introduced or worsened it. It is genuinely adjacent
to US5 (which reworked *who may evict presence*), and the reviewer is right that
it belongs in the same conversation: US5 hardened the wrong-id eviction bug while
the any-id-from-any-role path stayed open.

**Blast radius is cosmetic, not integrity:** presence is ephemeral and decorative
(037 invariant: presence never writes to the doc), so the damage is a wrong or
missing avatar until the victim's next awareness tick — no document content, no
attribution, and no persisted row is affected.

**Owed:** a follow-on feature that validates the clientIDs in an awareness frame
against the ones that connection controls (the same per-connection set
`awarenessChangeHandler` already maintains for cleanup). Recommend scoping it
alongside any future presence work rather than as an emergency fix.

## Verified sound by review (no action)

- The canonical step2 block itself; viewer downward sync unaffected; server doc
  stays consistent.
- `canEdit()` genuinely re-read per frame (the 60 s role re-check takes effect
  for step2 exactly as for updates, fail-closed).
- `STEP2_ORIGIN_FLAG` cannot leak across connections, survive a throw, or be
  observed by an unrelated update; `false` never reaches the column.
- `via_sync` leaves attribution untouched — the only consumers are `legacy.js`
  (run-breaking, not a silent skip) and `collab-guardrail.js` (annotation only).
- `document-service.js` capture: exact caller bytes via origin object identity;
  "persistence initiated" contract and 037's emit-time `hadRedisHandler`
  sampling both preserved.
- US5 deletion correct — y-websocket's `closeConn` already removes the
  per-connection controlled-id set, which is strictly better than the deleted
  `clientIds[0]` capture. Redis teardown unaffected.
- Migration ordering, nullability, reversibility, and rolling-deploy safety.

## Owed to Sam (cannot be automated here)

- Two-participant disconnect walk (US5): confirm one user's disconnect no longer
  evicts another's presence.
- Viewer read experience in a real browser after the gate change.
- Editor offline-edit reconnect showing `via_sync = t` on catch-up rows only.

## Known negatives recorded rather than papered over

- `logPerf` is console-only; there is no telemetry counter for `WS_EDIT_BLOCKED`
  or `WS_STEP2_BLOCKED`. The implementer checked and reported the absence
  instead of inventing a mechanism. If either event should be alertable, the
  counter has to be built first.
- `WS_STEP2_BLOCKED` fires on every ordinary viewer connect (viewer clients
  answer step1 with step2). It is a traffic-frequency signal, not an incident
  signal — documented in `docs/permissions.md`.
