# Contract — `server/import-presence.js` (new module)

Internal server contract. **No HTTP contract changes anywhere in this feature** — request shapes,
response bodies, status codes, receipts, scopes and rate limits on `PUT /api/docs/:docId/import` are
byte-identical to today (spec Out of Scope).

The module owns everything presence-related for the import routes so `server/api/docs-import.js` stays
the thin wrapper its header commits to.

---

## `open(opts) → ImportPresence`

```js
const presence = importPresence.open({
  docId,        // string (uuid) — target document
  user,         // req.user (must satisfy user.isAgent === true)
  mode,         // 'append' | 'replace' | 'sync'
  baseUrl,      // request base URL for the synthetic token
});
```

**Preconditions** (caller-enforced, in this order): `requireAuth` passed → editor-role gate passed →
`mode` is one of the three update modes → `user.isAgent === true`. If the last is false the caller
does not call `open` at all (FR-003).

**Behavior**

1. Mints a synthetic agent token pair for the mode's identity (data-model §2).
2. Calls `agentPresence.getOrCreateSession(docId, token, 60, { requiredRole: 'editor' })`.
3. Returns immediately with a handle whose `.promise` **never rejects**: internal failures are caught,
   logged at `warn` with the doc id and error message, and resolve to `null` (FR-008).

**Returns** `ImportPresence` (data-model §1). Synchronous — `open` itself never awaits.

**Guarantees**

- Never throws. Never returns a rejected promise. Never has an unhandled rejection.
- Performs **no** document mutation, directly or transitively (FR-013).
- Adds no field to, and reads no field from, the HTTP request other than the authenticated principal
  (FR-016 — there is no per-request label override affordance to build).

---

## `awaitAttach(presence, capMs = 2000) → Promise<void>`

Awaits the attach for **at most** `capMs`, then resolves regardless.

- Implemented as `Promise.race([presence.promise, timerThatResolves(capMs)])` — the timer **resolves**,
  never rejects, so a slow attach can only delay, never fail (FR-009).
- The background attach continues after the cap and announces normally when it lands (US3 scenario 2).
- `capMs` is a module constant (`PRESENCE_ATTACH_CAP_MS = 2000`), **not** configuration (ledger RBD-3).
- This is the **only** place the import ever awaits presence work.

Called once, immediately after `open`, before receipt-option validation / body checks / parsing / the
image pass (FR-006).

---

## `settle(presence, { fragment, mode, imported, observed }) → void`

Fire-and-forget post-apply step. **Returns synchronously; the caller never awaits it.**

1. Computes the changed range (data-model §3) **synchronously** from the already-applied live
   `fragment`, so the coordinates reflect the apply even if the session lands later.
2. Converts it via `cursorOps.createBlockRangeSelection` → `{anchor, head}` or `null`.
3. Chains on `presence.promise`:
   - refreshes the session TTL by re-calling `getOrCreateSession` with the same synthetic token (the
     reuse path re-arms the ~60 s timeout — FR-007);
   - if a selection exists, calls `agentPresence.setTemporarySelection(session.sessionId, anchor, head)`
     (~10 s, existing default — FR-011);
   - every step wrapped so an error is logged and swallowed (FR-008, US3 scenario 3).
4. If `presence.promise` resolved `null`, does nothing.

`observed` is the sync-mode changed-range accumulator (below); ignored for append/replace.

---

## `observeSyncRange(docId) → { indices, stop() }`

Sync-mode changed-range collector.

```js
const observed = importPresence.observeSyncRange(docId);
try {
  await handleSyncPush(...);
} finally {
  observed.stop();
}
```

- Registers `fragment.observeDeep((events, transaction) => …)` on the live shared doc's `'default'`
  fragment.
- **Filters on `transaction.origin === ORIGIN_SYNC_PUSH`** — the sentinel no other writer uses — so
  concurrent human edits during the import window cannot pollute the range (spec edge case "Concurrent
  human edits").
- Records top-level indices: `event.path[0]` for deep events; for the fragment's own event
  (`path.length === 0`) walks the delta (`retain` / `insert` / `delete`) to accumulate the touched
  index span.
- `stop()` is idempotent and **must** run in a `finally` — a leaked `observeDeep` on a long-lived
  shared doc is a real leak (research R8.3).
- Read-only: the callback records numbers and nothing else (FR-013).

---

## Route integration points (`server/api/docs-import.js`)

| Where | Call |
|---|---|
| after the editor gate + mode resolution, `user.isAgent` only | `presence = open({...})`; `await awaitAttach(presence)` |
| `mode=sync`, wrapping `handleSyncPush` | `observed = observeSyncRange(docId)` … `finally observed.stop()` |
| after a successful apply, before responding | `settle(presence, {...})` — **not** awaited |
| create route (`POST /api/docs/import`) | *(nothing — FR-004)* |

Error paths (400/403/409/410/413/500) are unchanged and never call `settle`; an already-open session is
left to expire on its own TTL (ledger RBD-2).

---

## Observable behavior a test can assert

| # | Assertion | Requirement |
|---|---|---|
| C1 | Agent-authenticated import ⇒ exactly one `getOrCreateSession` call with the mode's identity, before parsing begins | FR-001, FR-006 |
| C2 | Browser-session import ⇒ zero `getOrCreateSession` calls | FR-003 |
| C3 | `POST /api/docs/import` ⇒ zero `getOrCreateSession` calls | FR-004 |
| C4 | `getOrCreateSession` rejecting ⇒ import response identical to baseline; one warn logged | FR-008, SC-004 |
| C5 | `getOrCreateSession` hanging ⇒ response latency within baseline + ~2 s | FR-009, SC-004 |
| C6 | Successful append ⇒ `setTemporarySelection` with a range covering exactly the appended blocks | FR-011 |
| C7 | Successful replace ⇒ range covers the whole post-apply document | FR-011 |
| C8 | Sync push touching blocks 3 and 7 ⇒ range `first=3, last=7` | FR-011 |
| C9 | No-op sync push ⇒ session opened, **no** `setTemporarySelection` | FR-012 |
| C10 | Document state after an import with presence enabled ≡ with presence disabled (byte-compare `encodeStateAsUpdate`) | FR-013, SC-005 |
| C11 | Two imports with the same token against the same doc ⇒ one session (reuse path), one awareness entry | FR-002 |
| C12 | Sync presence label is `"Repo Sync (<user>)"` and equals the stored `agent_name` on the update row | FR-015, SC-006 |
| C13 | Failed import after attach ⇒ no teardown call; session expires on TTL | ledger RBD-2 |
