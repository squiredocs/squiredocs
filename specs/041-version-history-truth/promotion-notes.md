# 041-version-history-truth — promotion notes & review dispositions

Post-merge adversarial review (Fable), 2026-08-02. Feature merge `e6340ce0`,
docs follow-up `544573c0`. Fixes below landed directly on `main` the same day.

The review's own record holds the full **VERIFIED-CLEAN** list — the areas it
read and cleared. This file records only what it raised and what was done about
it, so the two documents are read together, not in place of each other.

## M1 — a stale WebSocket close unsubscribed the doc that replaced it — FIXED (`4221846d`)

**Finding.** `refuseBind` closes a refused document's connections and CLEARS
`doc.conns`, while `redis-pubsub`'s unsubscribe is keyed by NAME and each close
handler captures ONE doc instance for the connection's life. So a delayed close
from an already-dead connection saw `conns.size === 0` on the OLD doc, long
after a reconnect had bound a fresh doc under the same name and subscribed it —
and killed the live doc's channels. Nothing re-subscribed (the fresh doc already
carries `_redisSyncInitialized`), so it went silently deaf to every other
instance's updates.

**Fix.** `server/index.js` — the close-time cleanup is identity-checked: it runs
only when the registry still points at (or has forgotten) the handler's own doc.
Regression coverage in `server/__tests__/bindstate-failure.test.js`, mirroring
the real handler and pinned against `index.js` by source so the rule cannot
drift out from under a green suite.

**The reviewer rated this HIGH for multi-replica deployments** and MEDIUM only
because a single replica has no peer to go deaf to. It is fixed regardless; the
severity split does not change the fix.

## M2 — the "Reverted" stamp compared clock ranges across documents — FIXED (`e7dcccb4`)

**Finding.** Clocks are small per-document integers, so edit ranges collide
freely across documents (every fresh document's first chat edit is around
`{2,2}`). A direct `POST /api/docs/A/undo` naming a card from document B found a
coinciding range and stamped B's card "Reverted" though B's edit was never
touched — the exact class of attribution lie FR-015 exists to close.

**Fix.** `server/api/chat-revert-stamp.js` takes the route's own `:docId` and
requires `part.input.docGuid` to match it, checked BEFORE the range compare
(a range only means anything within one document). A card with no recorded
document is a mismatch by rule, the same posture as a card with no recorded
range: skip and log, never fail the undo. Tests extended in
`server/__tests__/undo-stamp.test.js` for the cross-document coincident range,
the matching document, and the missing document.

## M3 — `fetchHistory` had no response-ordering guard — FIXED (`0bf6238c`)

**Finding.** `fetchHistory` runs from three places at once — mount, the 10 s
background poll, and every CRUD action's refresh. A slow poll answering after a
fresher refresh overwrote the newer list with a pre-rename/pre-restore one: a
stale world for up to a full poll interval, a second drill-down cache wipe, and
a selection reconciled against history that no longer existed.

**Fix.** `client/src/hooks/useVersionHistory.js` — a `historyRequestSeqRef`
mirroring the diff path's existing `diffRequestSeqRef`; only the response whose
seq is still current applies, for successes and failures alike. The `isLoading`
reset is deliberately NOT seq-guarded: only a foreground fetch raises the flag,
so the fetch that raised it must always be able to lower it, or a background
tick could strand the panel in "Loading". Hook tests cover the out-of-order
response and the stale failure.

## L1 — drill-down failures landed on the timeline's error channel — FIXED (`4254d56d`)

**Finding.** `loadUpdatesForVersion` and `loadContentAtClock` called `setError`,
so a drill-down 500 rendered the panel-level "Couldn't load version history." +
Retry over a perfectly healthy list, while the expanded row that actually failed
sat on "Loading updates..." forever. Both halves of that are false.

**Fix.** Kept minimal and honest rather than made clever: a per-version
`versionUpdatesError` map on the hook, an inline row-level error in
`HierarchicalVersionList` ("Couldn't load updates — tap to retry") that clears
the `failedLoadsRef` auto-refetch suppression before re-requesting, and the
clock-content failure taken off the panel channel entirely (its `null` return is
the caller's signal). Tests pin that the panel error never renders when only a
drill-down failed, and that the row error renders and its retry works.

## L2 — missing T024 assertion for a terminal live-path store failure — FIXED (`f53284a9`)

**Finding.** T024 covered restore's refusal path and its stored-transition
guarantee, but never the case where the live document has already moved and the
write then dies terminally.

**Fix.** `server/__tests__/version-history.test.js` — the restore applies and
reaches the live doc's clients, `storeUpdate` then rejects, and the test asserts
the rejection reaches the caller, the live doc KEEPS the restored content, no
update row was written, and no `agent_edits` row exists for an agent restore
whose store failed. The REST half (500 + `notifyException`) is a source pin
against `index.js`, which boots a live server on require.

## U1 — adjudicated: acceptable posture, no code change

The reviewer's residual U1 (a live-path restore whose store fails leaves a moved
document and a log that says otherwise) was adjudicated **acceptable posture**:
restore cannot paper the divergence over, and what it must not do is hide it —
the rejection propagates to the route's 500 + `notifyException` page and to the
MCP tool's surfaced error, so the user is told the restore failed rather than
shown a success over an unrecorded change. The T024 assertion above pins that
behavior so the posture is enforced rather than assumed.

## Reviewer residual — the undo-stamp route mirror had no source pin — DONE (`e7dcccb4`)

`server/__tests__/undo-stamp.test.js`'s route block is a hand-copy of
`makeUndoRedoHandler`'s stamp block. It now carries a source-regex pin against
`server/index.js`, matching the pattern `bindstate-failure.test.js` established,
so a change to the real route that the mirror does not follow fails CI.

## Constraints honored

No migrations. No changes to `README.md`, `CLAUDE.md`, or `docs/dev.md`. Nothing
cut by 040's D19 (restore-undo, per-chat undo scoping, offer guards) was revived
— M2 is a read-and-compare at the stamp site only.
