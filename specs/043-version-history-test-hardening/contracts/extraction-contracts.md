# Contract: Production extractions X1-X4 (move-only)

Every extraction below is **move-only**: the moved code is byte-for-byte the same logic, the call
site is updated, no behavior changes, and all pre-existing tests pass (FR-007(4), SC-008). Line
references are pre-041/042 locators; T001 re-verifies them against merged `main`.

A shared acceptance rule applies to all four:

> **AC-X**: after the extraction, `npm run test:server` and `npm run test:client` are green with
> **no test file modified except** the mirror suite that is the extraction's reason for existing.
> If a pre-existing test must change, the extraction is out of budget — stop and report.

---

## X1 — `server/collab-bind-state.js`

**Moves**: `server/index.js:276-480` — the `setPersistence({ bindState })` body, with the
`ydoc.on('update', …)` listener (`:287-440`) as its own exported unit.

**Exports**

```js
/**
 * Build the y-websocket `bindState` used in production.
 * @param {object} deps
 * @param {object} deps.persistenceProvider  - PostgresPersistence instance
 * @param {Set<Promise>} deps.pendingWrites  - graceful-shutdown flush set
 * @param {(err, ctx) => void} deps.notifyException
 * @param {{markDirty: (guid: string) => void}} deps.searchIndexer
 * @param {{evaluateUpdate: Function}} deps.collabGuardrail
 * @param {(event: string, fields: object) => void} deps.logPerf
 * @returns {(docName: string, ydoc: Y.Doc) => Promise<void>}
 */
function createBindState(deps) {}

/**
 * The update listener alone — the unit that classifies, parses the origin,
 * reads the sync marker, and persists the attributed row.
 * @returns {(update: Uint8Array, origin: any) => void}
 */
function createUpdateListener(deps, docGuid, ydoc) {}

module.exports = { createBindState, createUpdateListener, extractDocGuid };
```

**Invariants the move MUST preserve** (each is load-bearing and commented in the original):

1. The listener is attached **before** any `await` — y-websocket does not await `bindState`.
2. The classification baseline (`classificationDisabled` → `extractXml` → `ydoc._lastClassifiedXml`)
   is refreshed **before** the sentinel early-return, on every origin (023 T023/U1).
3. `parseOrigin(origin)` returning falsy is an early return (sentinel origins are never re-stored).
4. The malformed-origin `notifyException` fires only for `parsed.malformedOrigin === 'non-uuid-string'`
   — **note the 041 FR-017 interaction**: 041 adds a null/primitive malformed class. Preserve
   whatever post-041 `main` does; do not re-derive it.
5. `viaSyncFromOrigin(origin)` is read **after** the sentinel return (038 FR-010/FR-012).
6. `pendingWrites.add(writePromise)` / `.finally(delete)` ordering is unchanged (010 FR-006).
7. The FR-018 publish-before-commit comment block travels with the code — it is the record of a
   deferred decision, and US3's characterization header points at it.
8. The terminal `.catch` still logs `CRITICAL: Failed to persist update for … after retries` and
   calls `notifyException(err, { source: 'persistence' })`.

**Call site**: `server/index.js` becomes
`setPersistence({ bindState: createBindState({...}), writeState: async () => {}, provider: persistenceProvider })`.

**Consumers**: `server/__tests__/update-classifier.test.js` (FR-006a) and
`__tests__/integration/helpers/collab-harness.js` (US1/US2/US3).

---

## X2 — `identityFromPrincipal` in `server/agent-identity.js`

**Moves**: `server/index.js:2054-2055`.

```js
/**
 * The connection's attribution identity, derived from the AUTHENTICATED
 * PRINCIPAL — never from awareness. This derivation is the fix for the
 * historical misattribution bug (an agent connecting first captured the
 * human's attribution); see the eulogy comment in server/index.js.
 * @param {object|null|undefined} user - the principal from permissions.extractUser
 * @returns {{userId: string|undefined, agentName: string|null}}
 */
function identityFromPrincipal(user) {
  return {
    userId: user?.userId,
    agentName: user?.isAgent ? user.agentName : null,
  };
}
```

`server/agent-identity.js` is the correct home: it is the zero-dependency identity leaf created by
feature 040 and already exports `CHAT_AGENT_NAME` and `isSameIdentity`. Adding a third identity
helper introduces no import cycle.

**Call site**: `server/index.js`'s `wss.on('connection')` becomes
`const { userId: wsUserId, agentName } = identityFromPrincipal(req.user); ws.userId = wsUserId; ws.agentName = agentName;`
(or equivalent) — `installGate` and everything else in that handler stay put.

---

## X3 — `shouldPublishToRedis` in `server/origin.js`

**Moves**: the predicate at `server/index.js:2242`
(`if (origin === ORIGIN_REDIS || origin === ORIGIN_DB_LOAD) return;`), inside the per-connection
`redisUpdateHandler` closure (`:2235-2249`). Only the predicate moves; the closure stays.

```js
/**
 * Cross-instance publish routing: publish everything EXCEPT updates that came
 * FROM Redis (feedback loop) and DB-load (already everywhere).
 * NOTE: a sync-push origin IS publishable even though parseOrigin() treats it
 * as a persistence sentinel — the two questions are different (039 F3).
 * @param {any} origin
 * @returns {boolean}
 */
function shouldPublishToRedis(origin) {
  return origin !== ORIGIN_REDIS && origin !== ORIGIN_DB_LOAD;
}
```

**Call site**: `redisUpdateHandler` becomes `if (!shouldPublishToRedis(origin)) return;`.

**Consumer**: `server/__tests__/origin.test.js` deletes its local copy (lines 22-25) and imports
this one; its 9 existing call sites (182, 183, 186, 192, 221, 236, 241, 256, 261) keep their
current expectations, which is the proof the move was faithful.

---

## X4 — `server/api/undo-status.js`

**Moves**: `server/index.js:1630-1646` — `app.get('/api/docs/:docId/undo-status', requireAuth, …)`.

```js
/**
 * @param {object} deps
 * @param {{getRole: Function}} deps.documents
 * @param {{getUndoStatus: Function}} deps.undoService
 * @param {import('express').RequestHandler} deps.requireAuth
 * @returns {import('express').Router}
 */
function createUndoStatusRouter(deps) {}
module.exports = { createUndoStatusRouter };
```

**Behavior preserved exactly**: viewer or no role ⇒ `{ canUndo: false, canRedo: false }`; otherwise
`undoService.getUndoStatus({ docGuid, userId, agentName: CHAT_AGENT_NAME })`; any thrown error ⇒
`console.error('Error checking undo status:', error)` **and** `{ canUndo: false, canRedo: false }`
(the `console.error` line is present in production and absent from today's mirror — the mirror's
one real drift, and evidence for FR-006).

**Precedent**: identical to `createExportRouter` / `createImportRouter` / `createTokenClaimRouter`,
mounted at `server/index.js:1470-1479`.

**Consumer**: `server/__tests__/undo-status-api.test.js` deletes its mirrored handler (lines 40-61)
and mounts the real router behind its existing fake-auth middleware (auth stubbing is legitimate;
handler stubbing is not).

---

## X-GUARD — `server/__tests__/collab-extraction-guard.test.js`

A structural drift guard in the style of `ws-edit-gate.test.js:448-487` (feature 038 C1). A passing
E2E does not prove production uses the extracted module; these greps do.

Required assertions over `server/index.js` source:

| # | Assertion | Guards |
|---|---|---|
| G1 | matches `require\(['"]\./collab-bind-state['"]\)` | X1 is used |
| G2 | contains **no** `ydoc.on\(['"]update['"]` | no second copy of the listener |
| G3 | contains **no** `parseOrigin\(` … `viaSyncFromOrigin\(` classify sequence outside the module | ditto |
| G4 | matches `identityFromPrincipal\(` and contains no bare `ws\.agentName\s*=\s*req\.user` derivation | X2 is used |
| G5 | matches `shouldPublishToRedis\(` and contains no `origin === ORIGIN_REDIS` literal | X3 is used |
| G6 | matches `createUndoStatusRouter\(` and contains no `'/api/docs/:docId/undo-status'` route literal | X4 is used |
| G7 | **still** matches `/installGate\s*\(/` exactly once and the `request.tokenMayWrite = …` literal | the extraction ceiling held (D9); duplicates the 038 guard on purpose, as a tripwire on this feature's own budget |

G2/G3/G5/G6 are written as *negative* greps so a future re-inlining fails loudly.
