# Contract: `__tests__/integration/helpers/collab-harness.js`

The shared real-WebSocket harness for US1, US2, US3 and US4. It exists so three new suites do not
each grow their own copy of the wiring — the exact drift this feature removes.

**Design rule**: the harness owns **transport plumbing only**. Every *decision* — who you are,
whether you may edit, how a frame is classified, what gets persisted with what identity — is made
by the production module. If a scenario cannot be expressed without faking a decision, the harness
is wrong; report rather than fake.

---

## Exported surface

```js
/**
 * Boot a mini collaboration server wired with the production modules.
 * @param {object} [opts]
 * @param {object} [opts.persistence] - override the persistence provider (US3 failure injection)
 * @returns {Promise<Harness>}
 */
async function startCollabServer(opts) {}

/**
 * @typedef {object} Harness
 * @property {number} port
 * @property {import('pg').Pool} pool
 * @property {object} persistence
 * @property {Array<{event: string, userId: string, docId: string}>} blockedEvents
 * @property {(docGuid: string, token: string) => Promise<Client>} connect
 * @property {(docGuid: string) => Promise<Row[]>} rowsFor
 * @property {(docGuid: string) => string} serverXml
 * @property {() => Promise<void>} close    // awaits in-flight writes, closes wss+server
 */

/**
 * @typedef {object} Client
 * @property {import('ws')} ws
 * @property {Y.Doc} clientDoc     // fed by whatever the server sends (read path)
 * @property {Buffer[]} received
 * @property {(update: Uint8Array) => void} sendUpdate
 * @property {(doc: Y.Doc) => void} sendStep2      // the catch-up frame (US2)
 * @property {(doc: Y.Doc) => void} sendStep1
 * @property {() => Promise<void>} close
 */

// Identities — real rows, real tokens, no fabrication.
async function createHumanIdentity(pool, email) {}   // -> { userId, token }
async function createAgentIdentity(pool, email, agentName, scopes) {} // -> { userId, agentName, token (sk_sqd_), tokenId }

// Deterministic waiting — never sleep on an observable condition.
async function waitFor(fn, { timeout = 4000, label = 'condition' }) {}

// Cleanup — FR-010.
async function cleanupDoc(pool, docGuid) {}

module.exports = { startCollabServer, createHumanIdentity, createAgentIdentity, waitFor, cleanupDoc };
```

---

## Wiring requirements (each is an acceptance criterion)

| # | Requirement | Why |
|---|---|---|
| **H1** | `setPersistence({ bindState: createBindState({...}) })` uses **X1**. The harness contains **no** hand-written `ydoc.on('update')` listener. | FR-006(a); the 038 harness's remaining mirror |
| **H2** | The upgrade handler calls the production `permissions.extractUser({ queryToken })` and `permissions.can.view(userId, docId)`. **No `?role=` / `?userId=` query-param auth.** | FR-001 "production upgrade path"; the 038 harness's other fake |
| **H3** | `request.tokenMayWrite` is computed with the same predicate production uses, and ANDed into `currentCanEdit` alongside `documents.ROLES[role] >= documents.ROLES['editor']`. | keeps the scope axis real (Constitution V) |
| **H4** | Connection identity comes from **X2** `identityFromPrincipal(req.user)`. The harness never assigns `ws.agentName` from a literal. | US1's whole subject |
| **H5** | The real `installGate` from `server/ws-edit-gate.js` is installed, with `onBlocked` pushing into `blockedEvents`. | FR-001 "connection-setup path"; enables the viewer/step2 cases |
| **H6** | `setupWSConnection(ws, req, { gc: true })` is the last step, as in production. | y-websocket must own the socket |
| **H7** | Frame crafting uses the constants **exported by `server/ws-edit-gate.js`** (`MESSAGE_SYNC`, `SYNC_STEP1/2`, `SYNC_UPDATE`) — never locally redeclared numbers. | `attribution-bug.test.js:24-28` redeclares them today; that is a fourth mirror |
| **H8** | `close()` awaits all in-flight `storeUpdate` promises before closing the server, then the caller runs `cleanupDoc` per guid in `afterAll`. | FR-010 + the spec's crash-mid-test edge case |
| **H9** | No `setTimeout` sleep is used to await an observable condition; `waitFor` polls. Sleeps are permitted **only** to await an *absence* and must carry a comment saying so. | US8(c) / FR-011 |
| **H10** | One server per suite (`beforeAll`), reused across tests. | keeps `npm run test:server` wall time flat |

---

## Identity contract

**Human**: a real `users` row via `createTestUser`, plus a real session access token. The principal
that comes back from `extractUser` has **no `scopes` array**, so `tokenMayWrite` is `true` — this is
the browser-session shape and must not be "helpfully" given scopes.

**Agent**: a real `users` row plus a real `sk_sqd_` `api_tokens` row minted through the production
mint path with `['documents:read','documents:write']`. `extractUser` returns
`{ userId, agentId: 'api-token:<id>', agentName, scopes, isAgent: true, apiTokenId }` — the true
MCP-agent shape. `agentName` is the token's name, which is what lands in `yjs_updates.agent_name`.

**Both** need a `document_shares` row granting at least `editor` on the test document, or
`permissions.can.view` refuses the upgrade — this is a real ACL check, not a stub.

**Teardown**: `cleanupTestUser` handles users/shares/documents; the harness additionally deletes the
`api_tokens` row and the caller deletes `yjs_updates` by `doc_guid`.

---

## Per-suite usage contract

| Suite | Extra requirement |
|---|---|
| `attribution-e2e.test.js` (US1) | Runs the scenario **twice**: agent-connects-first (the historical bug ordering) and human-connects-first. Asserts identity on **every** row in both, not a sample. |
| `sync-catchup-e2e.test.js` (US2) | Must get the server-side doc genuinely behind the client before sending step2 (e.g. edit a local `Y.Doc` the server never saw, then connect and `sendStep2`). Then asserts `via_sync=true` + identity on the resulting rows, runs the **real** timeline grouping over them, and the **real** undo derivation. |
| `persistence-failure-e2e.test.js` (US3) | Passes an `opts.persistence` wrapper that rejects **one specific update** (matched by payload bytes) on every attempt, restored in `finally`. Asserts the observed outcome; header carries the FR-014 note pointing at 038 FR-018 and D1. |
| `restore-concurrency.test.js` (US4) | Keeps a live connection open so 041's live-doc restore path (FR-011) is the one under test. Invariant assertions only (D2). Asserts the **absence** of an `agent_edits` row for a human web-UI restore (D8). |

---

## Anti-requirements (things the harness must NOT do)

- Must not import or boot `server/index.js` (it starts Redis, cron, MCP, the search indexer and a
  listening server at require time).
- Must not stub `permissions`, `documents`, `ws-edit-gate`, or the classify/persist path. Stubbing
  `requireAuth`-style *middleware* in a supertest suite is fine; stubbing a decision is not.
- Must not use Playwright or any browser driver (D7/FR-013).
- Must not assert anything about awareness/presence — that is 044's coverage, and duplicating it is
  explicitly out of scope.
- Must not use `test.concurrent` or require a parallel runner (FR-012).
