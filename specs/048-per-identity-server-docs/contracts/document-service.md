# Contract — `server/document-service.js` (the one implementation point)

Internal service contract; consumers are the six converged write paths
(research R1 inventory) and every test that drives the seam. Signatures are
UNCHANGED; behavior changes are listed exhaustively.

## `updateDocument(docGuid, updateFn, { userId, agentName })` — new internal shape

Sequence (FR-001 + FR-013):

1. `ydoc = getSharedDoc(docGuid)` — creating lookup, fires bindState (unchanged).
2. **`await waitForDocReady(ydoc, docGuid)`** — NEW. Warm docs pass on a flag
   check; a refused bind throws `BindFailedError`; a never-completing bind
   throws the timeout error. No doc state is read before this resolves.
3. `origin = createOrigin(userId, agentName)` (unchanged).
4. Attach the origin-scoped capture listener to the SHARED doc (unchanged
   listener: origin object identity, `hadRedisHandler` sampled at emit time).
5. **Synchronous, no awaits from here through step 9** (FR-001):
6. `eph = new Y.Doc()`; `Y.applyUpdate(eph, Y.encodeStateAsUpdate(ydoc))` —
   the seed. (Capture listener on `eph` attached only AFTER this, or the seed
   would be captured.)
7. `eph.transact(() => updateFn(eph), origin)` inside try/finally — the
   caller's function receives the EPHEMERAL doc, never the shared doc
   (FR-007b). Its single update event (fired synchronously at transaction
   end) is captured as `bytes`; the listener is detached in `finally`.
8. `eph.destroy()` — always, including on a throwing `updateFn` (FR-006: a
   throw discards the ephemeral doc, the shared doc is untouched, the error
   propagates).
9. If `bytes` exist: `Y.applyUpdate(ydoc, bytes, origin)` — the merge-back.
   Fires the shared doc's `update` event with this call's origin, driving
   (unchanged): persistence listener → one row stamped (userId, agentName);
   y-websocket broadcast; attached Redis handler; the origin-scoped capture.
10. Detach the shared-doc capture listener (finally, as today).
11. If the shared-doc event fired: one `setImmediate` hop
    ("persistence initiated", 037 contract — unchanged).
12. Post-merge `if (ydoc._bindFailed) throw new BindFailedError(docGuid)` —
    RETAINED (FR-005; covers a bind refused between gate and merge).
13. Return `{ update, hadRedisHandler }` — the shared doc's own emission, as
    today; zero value `{ update: null, hadRedisHandler: false }` on no-change.

Guarantees:
- Every emitted update's insert set carries `eph.clientID` — fresh and random
  per call, never the shared doc's, never reused (FR-002; guard-pinned).
- No-change `updateFn` → no eph event → no merge → no shared event → no row →
  zero return (unchanged observable behavior).
- Attribution/persistence/fan-out byte-behavior per FR-005: `via_sync` unset;
  origin object identity scoping; import-presence origin-filtered observation
  keeps working (same origin object on the merge).

## `waitForDocReady(ydoc, docGuid, timeoutMs = 5000)` — NEW export

- Resolves immediately when `ydoc._bindComplete === true`.
- Throws `BindFailedError(docGuid)` as soon as `ydoc._bindFailed` is observed.
- Polls (10 ms) until the deadline; then throws
  `Error("Timed out waiting for document <docGuid> to load")` — the message
  shape `waitForDocLoaded` used, so existing route mapping (500) is unchanged.
- MUST NOT create docs, MUST NOT read persistence, MUST NOT mutate the doc.
- Consumers: `updateDocument` (internal, always), `server/api/docs-import.js`
  (replaces its local `waitForDocLoaded`; the persistence-reading state-vector
  poll is deleted). The route-level call stays — the PUT route calls it
  unconditionally (append and replace) because the append-mode presence
  baseline reads doc state BEFORE `updateDocument` runs; with the gate also
  inside `updateDocument` the second wait is a no-op flag check.

## `createSeededDocument({ userId, title, nodes, agentName })` — surface unchanged

Still: create row → one `updateDocument` (meta title + seed nodes). Inherits
the gate and the ephemeral mechanism with zero changes to itself or its four
callers (onboarding welcome doc, MCP create, chat import, REST create).

## `getSharedDoc` / `peekSharedDoc` / `init` — unchanged

`init`'s seam is unchanged; tests that hand a plain `Y.Doc` through it MUST
mark it `_bindComplete = true` (the honest "this fake is fully loaded").

## Error surface (exhaustive)

| Condition | Result |
|---|---|
| Bind refused (before or during call) | `BindFailedError` (existing class, existing caller handling) |
| Bind never completes | timeout `Error` (existing message shape → existing 500 mapping) |
| `updateFn` throws | error propagates; shared doc byte-identical; no row (FR-006/SC-005) |
| No change | resolves with zero value (unchanged) |
