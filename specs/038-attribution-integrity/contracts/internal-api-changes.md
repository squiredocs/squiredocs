# Contract: internal API changes

Exact JS surface changes. All changes are additive/backward-compatible for existing
callers except where marked.

## `server/ws-edit-gate.js` (NEW module)

See [sync-protocol-gate.md](sync-protocol-gate.md). One classification implementation,
imported by `server/index.js`, `server/__tests__/permissions.test.js` (replacing its
mirrored copy — a REQUIRED change, FR-007), the new gate unit test, and the FR-008
integration test.

## `server/postgres-persistence.js`

**038 owns the WRITE path only.** Do not modify `getUpdateRowsUpTo`,
`_fetchRowsWithGapRetry`, `_findFirstGap` (feature 039 owns them).

```js
// BEFORE
async storeUpdate(docGuid, update, userId = null, agentName = null, onBehalfOf = null,
                  externalClient = null, { meaningful = null } = {})
// AFTER — additive option; every existing caller unchanged
async storeUpdate(docGuid, update, userId = null, agentName = null, onBehalfOf = null,
                  externalClient = null, { meaningful = null, viaSync = null } = {})
```

- `viaSync` threads `_runStoreSlot` → `_storeUpdateCritical` → INSERT column list
  (`via_sync`). No new statements; per-doc FIFO queue, advisory-lock critical section,
  conflict retry, ownTxn/externalClient paths, and post-commit `updated_at` stamp are
  byte-for-byte preserved (FR-012).
- `_queryUpdatesWithUsers`: SELECT gains `u.via_sync`.
- `_mapUpdateRow`: result gains `viaSync: row.via_sync ?? null`.
  (Surfaces to `getRecentUpdatesWithUsers`, `getUpdatesWithUsers`, `getUpdatesInRange`.)

## `server/origin.js`

```js
// parseOrigin(origin) — return shape gains an OPTIONAL additive field:
//   { userId, agentName }                                    // normal (unchanged)
//   null                                                     // sentinels (unchanged)
//   { userId: null, agentName: null,
//     malformedOrigin: 'non-uuid-string' | 'unrecognized-object' }  // NEW degraded parses
```

- String branch: strict UUID regex
  (`/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i`). Valid ⇒
  attributed (unchanged). Invalid ⇒ degraded parse + `console.error` with the rejected
  value. **Never throws; never causes the caller to skip persistence** (FR-017).
- Object branch: an object with neither a `userId` nor an `agentName` **property**
  (`in`-checks, so explicit `{ userId: null }` and ws connections are NOT "unrecognized")
  ⇒ degraded parse + `console.warn`.
- Sentinel skip-list unchanged and evaluated first.
- `malformedOrigin` is additive; no existing consumer reads it. The bindState listener
  (the only persistence-path consumer) additionally fires `notifyException`
  (source `origin-parsing`) for `'non-uuid-string'` — the alert-worthy signal — then
  persists the row unattributed.

## `server/index.js` (bindState update listener + WS handler)

- Listener computes `viaSync` from the origin object's step2 flag AFTER the sentinel
  early-return; passes `{ meaningful, viaSync }` to `storeUpdate` and `viaSync` to
  `collabGuardrail.evaluateUpdate`.
- WS interceptor: `classifyFrame` from `ws-edit-gate`; viewer `update` frame ⇒
  `WS_EDIT_BLOCKED` (unchanged); viewer `step2` frame ⇒ `WS_STEP2_BLOCKED` + drop; editor
  `step2` ⇒ flag set/`finally`-cleared around `originalEmit`.
- DELETED: `parseAwarenessClientIds`, `connectionClientId` capture, close-handler
  awareness eviction. PRESERVED: the Redis pub/sub cleanup in the same close handler,
  ping/pong, role re-check, `WS_CLOSE` logging.

## `server/document-service.js`

```js
// updateDocument(docGuid, updateFn, { userId, agentName })
//   → Promise<{ update: Uint8Array|null, hadRedisHandler: boolean }>   // shape unchanged
```

Behavioral contract (changed internals, FR-019..021):
- Capture matches on transaction-origin **object identity**; foreign-origin updates are
  ignored without consuming the listener.
- Listener registered before `transact`, removed in `finally` — no armed-listener window
  survives the call, including on `updateFn` throw (the error still propagates).
- Change path: resolves after one `setImmediate` turn ("persistence initiated"
  preserved); `hadRedisHandler` sampled at emit time (037 semantics unchanged).
- No-change path: resolves immediately with `{ update: null, hadRedisHandler: false }` —
  the former 50 ms timeout is gone.

## `server/collab-guardrail.js`

```js
// BEFORE
async evaluateUpdate({ docGuid, update, userId, agentName })
// AFTER — additive field
async evaluateUpdate({ docGuid, update, userId, agentName, viaSync = null })
```

Truthy `viaSync` ⇒ `syncSourced=true` on the N1 warn line and `syncSourced: true` in the
`notifyException` extra. Matching, suppression, and paging decisions unchanged (D3).

## `server/undo/legacy.js`

`deriveLegacyRange(rows, identity, opts)` — signature unchanged; input rows may now carry
`viaSync`. `isIdentityRow` returns `false` for `row.viaSync === true` (run-breaking, D2).
`null`/`undefined` `viaSync` ⇒ behavior identical to today.
