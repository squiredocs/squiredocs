# Research — 038-attribution-integrity

Phase 0 output. All *product* unknowns were resolved before planning as ratified defaults
(D1–D5 in [clarifications-needed.md](clarifications-needed.md)); this file records the
*implementation* decisions, each grounded in the current code (paths/line references
verified 2026-08-01).

---

## R1 — Extract the edit-classification into `server/ws-edit-gate.js`

**Decision**: Move the y-websocket protocol constants (`MESSAGE_SYNC`,
`MESSAGE_AWARENESS`, `SYNC_STEP1`, `SYNC_STEP2`, `SYNC_UPDATE`) and `isEditMessage` out
of `server/index.js` (currently inline at ~line 1955–1997) into a new tiny CommonJS
module `server/ws-edit-gate.js`, and change `isEditMessage` to classify **both**
`SYNC_UPDATE` and `SYNC_STEP2` as edits (FR-001), returning enough information to
distinguish them (e.g. `classifyFrame(buffer) → { isEdit, kind: 'update'|'step2'|null }`
or a pair of predicates) so the interceptor can emit the correct blocked event
(`WS_EDIT_BLOCKED` vs `WS_STEP2_BLOCKED`, FR-003). Frames shorter than 2 bytes are never
edit-classified (unchanged — spec edge case).

**Rationale**: The existing unit test (`server/__tests__/permissions.test.js:262-293`)
could only pin the buggy behavior because it *mirrors* the unexported function by hand —
the mirror faithfully copied the bug, and nothing forced it to track the real code.
Exporting the real function makes the test load-bearing, and lets the FR-008 integration
test (which builds its own mini-WS-server, like `__tests__/integration/collaboration.test.js`)
wire the *production* gate rather than a reimplementation. Importing from `index.js`
directly is not an option: requiring `index.js` boots the entire server.

**Alternatives considered**:
- *Keep inline, update the mirrored test copy*: preserves the exact drift mechanism that
  pinned the bug for months — rejected.
- *Put it in `server/permissions.js`*: that module is HTTP/document-ACL logic;
  wire-protocol byte classification is a different concern — rejected for cohesion.

## R2 — Step2 flag: per-connection property, set/`finally`-cleared around `originalEmit`

**Decision**: In the `ws.emit` interceptor (`server/index.js` ~line 2048), when a frame
classifies as step2 **and** the connection may edit, set `ws._applyingSyncStep2 = true`,
call `originalEmit(...)` inside `try`, and clear the flag in `finally`. The bindState doc
`update` listener (`server/index.js` ~line 280) computes
`viaSync = (origin && typeof origin === 'object' && origin._applyingSyncStep2 === true) || null`
**after** the existing `parseOrigin` sentinel early-return, and threads it to
`storeUpdate` (R3). A comment at the flag site documents the synchronicity assumption
(FR-011): y-websocket's `messageListener` → `syncProtocol.readSyncMessage` →
`readSyncStep2` → `Y.applyUpdate(doc, payload, conn)` → doc `update` listeners is one
synchronous call chain on the event loop, and y-websocket passes the **connection object
(`ws`) as the transaction origin**, which is why a property on `ws` is exactly
per-frame-application scoped: another connection's interleaved update carries a different
origin object and never sees the flag.

**Rationale**: The origin the persistence listener already receives *is* the `ws` object
(that is how `ws.userId` / `ws.agentName` attribution works today — `server/index.js`
~line 2016). Piggybacking the flag on the same object means zero new plumbing between the
interceptor and the listener, the flag can never leak across connections, and the
`finally` guarantees a throwing `Y.applyUpdate` cannot leave it stuck. Multiple step2
frames on one connection each get their own set/clear window; live updates between them
are unflagged (spec edge cases).

**Alternatives considered**:
- *Module-level "current frame" variable*: correct only under the same synchronicity
  assumption but shared across connections — a strictly worse version — rejected.
- *Wrap/patch y-protocols `readSyncStep2`*: invasive fork of a dependency for something
  the origin object already carries — rejected.
- *Explicit `false` for live edits (D5)*: permitted but not written; only the step2
  window sets the column — keeps one uniform read rule ("only `true` means sync").

## R3 — `via_sync` column + `storeUpdate` threading

**Decision**: Migration `migrations/1799700000000_add-via-sync-to-yjs-updates.js`
(modeled on `1799000000000_add-meaningful-to-yjs-updates.js`): `pgm.addColumns('yjs_updates',
{ via_sync: { type: 'boolean', notNull: false } })`, `down` drops it. No default, no
backfill, no index (readers already fetch these rows by `(doc_guid, clock)`).
`storeUpdate` gains `viaSync` in its trailing options object —
`storeUpdate(docGuid, update, userId, agentName, onBehalfOf, externalClient, { meaningful, viaSync = null })`
— threaded through `_runStoreSlot` → `_storeUpdateCritical` into the INSERT column list.
Only the bindState listener ever passes `viaSync: true`; every other caller is untouched
(default `null`). `_queryUpdatesWithUsers` adds `u.via_sync` to its SELECT and
`_mapUpdateRow` maps `viaSync: row.via_sync ?? null` (surfacing it to undo/timeline
consumers). The `via_sync` contract comment (FR-015) lives on the column mapping in
`postgres-persistence.js` and at the flag site in `index.js`.

**Rationale**: Mirrors exactly how `meaningful` (feature 023 US4) was added — a nullable
write-time classification on the hot rows with null-safe read semantics — so the
persistence semantics FR-012 protects (per-doc FIFO queue, advisory-lock critical
section, retry, shutdown flush) are structurally untouched: one more bind parameter, no
new statements. Timestamp `1799700000000` is > head `1799600000000` and > the
`1795000000000` floor required by `script/migrate.js`'s phantom-008-row cleanup.

**Alternatives considered**:
- *Backfill historical rows to `false`*: fabricates certainty about indistinguishable
  rows — rejected (D1).
- *Separate side table*: a join on the hottest read path for one boolean — rejected.

## R4 — Undo: `via_sync = true` rows are foreign to identity runs (D2)

**Decision**: In `server/undo/legacy.js`, `isIdentityRow(row, identity)` additionally
returns `false` when `row.viaSync === true` — a flagged row breaks a contiguous identity
run exactly like another user's row, so `deriveLegacyRange` refuses honestly when the run
cannot be pinned (anchored case: first row after baseline is flagged → refuse; trailing
case: flagged tail row → run starts after it; all-flagged window → `null` = "nothing to
undo"). Rows reach `deriveLegacyRange` via
`persistence.getRecentUpdatesWithUsers(docGuid, 100)` (`server/undo/undo-service.js:152`,
`:331`), which surfaces `viaSync` after R3. `null`/`undefined` `viaSync` (historical
rows, unselected column) behaves exactly as today (D1/D5: null ≡ not-sync).

**Rationale**: Run-breaking (not transparent skipping) is the conservative,
already-established refusal model of this module ("a guessed inverse is the one forbidden
outcome" — its header, SC-011/Constitution IV). Transparent skipping could stitch an undo
range across a re-supply and invert updates causally interleaved with relayed content —
the exact surprise this feature exists to prevent. Note the 016 recorded-edit path
(`agent_edits` rows with exact clock sets) is unaffected: server-side modify transactions
never travel as step2 frames, so their rows can never be flagged (spec assumption).

**Alternatives considered**: transparent skip — rejected by D2 (worst case of chosen
default is an honest "nothing to undo", never wrongly inverted content).

## R5 — Guardrail annotation (D3)

**Decision**: `collabGuardrail.evaluateUpdate({ docGuid, update, userId, agentName })`
gains a `viaSync` field, passed by the bindState listener from the same captured flag
value it threads to `storeUpdate`. When truthy: the N1 `console.warn` match line gains a
`syncSourced=true` token and the `notifyException` extra gains `syncSourced: true`.
No change to matching, suppression, or whether a page fires (FR-014 / D3 / SC-005).

**Rationale**: The listener already invokes the guardrail post-persist with the same
per-update values (`server/index.js:364-370`); adding the flag it just captured is the
minimal honest annotation. Suppressing pages on `via_sync` would blind the guardrail to
exactly the "client-side mechanism masquerading as a user" incidents (021) it was built
for — a policy change reserved for Sam (D3).

## R6 — Origin-scoped, synchronously-detached capture in `updateDocument`

**Decision**: Rework `server/document-service.js` `updateDocument`:

```js
const origin = createOrigin(userId, agentName);
let captured = { update: null, hadRedisHandler: false };
let updateFired = false;
const updateHandler = (update, updOrigin) => {
  if (updOrigin !== origin) return;            // FR-019: capture matches on origin identity
  updateFired = true;
  captured = { update, hadRedisHandler: !!ydoc._redisUpdateHandler }; // 037: sampled at emit time
};
ydoc.on('update', updateHandler);
try {
  ydoc.transact(() => { updateFn(ydoc); }, origin);
} finally {
  ydoc.off('update', updateHandler);           // FR-020: detached synchronously, even on throw
}
if (updateFired) {
  await new Promise((resolve) => setImmediate(resolve)); // FR-021: persistence initiated
}
return captured;
```

The 50 ms timeout, the `updatePromise`/`timeoutPromise` race, and `ydoc.once` are
deleted. Origin matching is **object identity** (`===`) on the fresh `createOrigin`
object — the same identity-not-shape discipline feature 037 established for sync-push
origins (`server/origin.js` `SYNC_PUSH_MARKER` rationale).

**Rationale**: Yjs fires doc `update` events synchronously at transaction end and passes
the transaction origin as the second listener argument, so after `transact` returns the
event has either fired (change) or never will (no change) — the 50 ms armed-listener
window (which could capture a concurrent unrelated update on the no-change path, F4) is
pure hazard. `on` + explicit `off` replaces `once` because a foreign-origin update must
be *ignored without consuming* the listener. `hadRedisHandler` stays sampled inside the
handler at emit time (load-bearing 037 comment, `document-service.js:71-78`); the
`setImmediate` deferral preserves the "persistence initiated" contract only on the
change path — the no-change path returns immediately with the zero value (FR-020).
Suites `live-fanout.test.js` / `import-presence.test.js` must stay green.

**Alternatives considered**: keep the race but filter by origin in the timeout path —
still leaves an armed listener window; rejected.

## R7 — `parseOrigin` hardening (strict UUID; degrade loud, never drop)

**Decision**: In `server/origin.js`:

- Sentinel skip-list first, byte-for-byte unchanged (db-load, redis, sync-push
  string+brand, inverse-apply, restore) — runs before any other classification.
- String branch: validate against strict UUID regex
  `/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i`. Valid → attributed
  `{ userId: origin, agentName: null }` (unchanged). Invalid → return
  `{ userId: null, agentName: null, malformedOrigin: 'non-uuid-string' }` and
  `console.error` a distinctive line including the rejected value.
- Object branch: if the object has neither a `userId` nor an `agentName` property
  (`'userId' in origin || 'agentName' in origin` both false — an unrecognized shape,
  distinct from an explicit `{ userId: null }`), return the null attribution with
  `malformedOrigin: 'unrecognized-object'` and a `console.warn`. Objects with the
  properties (ws connections, `createOrigin` results) are unchanged.
- The bindState listener, on seeing `parsed.malformedOrigin === 'non-uuid-string'`, calls
  `notifyException` (source `origin-parsing`, including the rejected value) — the
  alert-worthy signal FR-017 requires — and proceeds to persist unattributed. The
  `malformedOrigin` field is additive; no existing consumer reads it.

**Rationale**: Today a non-UUID string flows into the `user_id` uuid column, the INSERT
fails, retries exhaust, and the row is **dropped** (the CRITICAL data-loss path at
`server/index.js:387-391`) while the update is live in the doc — durable-history loss.
Validation converts that to unattributed-but-persisted + page. `notifyException` is
invoked from `index.js` (which already imports it) rather than from `origin.js`, keeping
`origin.js` dependency-free (it is required by low-level modules; pulling the
exception-notifier/email stack into it risks cycles). Strict full-format regex, not
fuzzy (spec edge case: almost-UUIDs are rejected).

**Alternatives considered**: validating in `_storeUpdateCritical` instead — too late to
distinguish "malformed origin" from other insert failures, and F3 is an *origin-parsing*
defect; rejected.

## R8 — `WS_STEP2_BLOCKED` event

**Decision**: Emitted via the existing `logPerf` channel (`server/index.js:101`), same
shape and site as `WS_EDIT_BLOCKED` (`server/index.js:2070-2073`):
`logPerf('WS_STEP2_BLOCKED', { connId, userId, docId, role: userRole })`, plus the
console line. Distinct event name ⇒ separately countable (SC-002). Connection stays open;
no client notification; no escalation (D4).

## R9 — `connectionClientId` machinery removal

**Decision**: Delete from `server/index.js`: `parseAwarenessClientIds` (~1963–1984), the
first-awareness-frame capture in the interceptor (~2042–2066), and the
`if (connectionClientId) … removeAwarenessStates` block in the doc-scoped close handler
(~2241–2245). **Preserve verbatim** the Redis pub/sub cleanup in that same close handler
(the `setImmediate` block, ~2247–2272 — FR-024). Presence eviction on close is then
solely y-websocket's `closeConn` → `awarenessProtocol.removeAwarenessStates(doc.awareness,
doc.conns.get(ws), null)` — the library's per-connection **controlled-ids** set, which
tracks exactly the awareness ids each connection announced (FR-023). If the lib0
`decoding` import in `index.js` has no remaining users after the deletion, remove it too.

**Verification done at plan time**: `parseAwarenessClientIds` has no callers outside
`index.js`; `server/__tests__/attribution-bug.test.js` mentions `connectionClientId` only
in comments (and itself recommends this removal); `awareness-removal-propagation.test.js`
covers the Redis-side removal fan-out (015) and must stay green.

## R10 — Publish-before-commit window: comment only (FR-018)

**Decision**: A comment on the bindState persistence listener (`server/index.js`, at the
`storeUpdate` call site) documenting: the doc `update` event triggers the Redis publish
(`redisUpdateHandler`) synchronously and WS broadcast immediately, while `storeUpdate`
commits asynchronously — an instance dying in between can leave content live on other
instances but absent from durable history; the reorder (publish after commit) is
deliberately deferred as hot-path risk. No behavioral change.

## R11 — FR-008 protocol-level integration test

**Decision**: New `__tests__/integration/step2-viewer-block.test.js`, following the
mini-server pattern of `__tests__/integration/collaboration.test.js` (own Express+WSS,
`setupWSConnection`, `setPersistence` with a bindState listener mirroring production's
parseOrigin→viaSync→storeUpdate flow) but installing the **real**
`server/ws-edit-gate.js` interceptor with a stubbed role (viewer vs editor) and a
`logPerf` capture hook. Frames are hand-crafted with `lib0/encoding` exactly as
`server/__tests__/attribution-bug.test.js` already does (it has `sendSyncUpdate`
helpers and the protocol constants): build a private `Y.Doc` with content the server
lacks, `Y.encodeStateAsUpdate`, wrap as `[MESSAGE_SYNC, SYNC_STEP2, varUint8Array]`, send
raw over `ws`. Assertions: viewer → doc XML unchanged, zero `yjs_updates` rows for the
doc, one `WS_STEP2_BLOCKED` capture, socket still open (send/receive still works);
editor → doc contains the content, exactly one new row, `via_sync = true` on it.
Uses the per-agent test DB via `server/__tests__/helpers/db.js`.

**Rationale**: Reuses two proven harness patterns already in-repo; exercises the real
gate + real persistence, which is what SC-001/SC-009 demand.
