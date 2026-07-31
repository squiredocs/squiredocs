# Phase 0 Research — 037-import-presence

**Date**: 2026-07-31 | **Spec**: [spec.md](./spec.md) | **Ledger**: [clarifications-needed.md](./clarifications-needed.md)

All findings below were verified against the code on `main` at planning time (file:line references
are load-bearing — re-verify before editing). Design ground truth: `design/markdown-import-two-way-sync.md`
(Amendment 2026-07-30) and `design/agent-surface-mcp.md` (Amendment 2026-07-30 + reads-never-write
2026-07-21).

---

## R1 — Verified surface map (what we build on)

| Surface | Location | Verified fact that matters |
|---|---|---|
| Import routes | `server/api/docs-import.js` | `PUT /api/docs/:docId/import` at :338; editor gate `documents.hasRole(...,'editor')` at :344; mode resolved at :352; `mode=sync` delegates to `handleSyncPush` (:88); `POST /api/docs/import` (create, :248) is a separate route — untouched (FR-004). |
| Auth | `server/permissions.js:46-58` | `sk_sqd_` principals yield `req.user = { userId, agentId: 'api-token:<id>', agentName: <token name>, scopes, isAgent: true, apiTokenId }`. **No `rawToken`.** Browser sessions yield a non-agent user (no `isAgent`). |
| Append/replace apply | `server/markdown-import.js:291` `importMarkdown` | Prepares nodes (parse + image pass — the slow part), then **ONE** `documentService.updateDocument` transaction (:322). Returns `{ blocks:{imported}, images, frontmatter }`. |
| Transaction plumbing | `server/document-service.js:50` `updateDocument` | Registers `ydoc.once('update', handler)` **before** `ydoc.transact(fn, createOrigin(userId, agentName))`; the update event fires synchronously at transaction end. Returns `undefined` today. |
| Sync apply | `server/markdown-sync.js` `applySyncPush` (:1061) | store-then-apply: `persistence.storeUpdate(...)` then `Y.applyUpdate(sharedDoc, pushUpdate, ORIGIN_SYNC_PUSH)` (~:1148). Default `agentName = SYNC_AGENT_NAME` (`'Repo Sync'`, :108). No-op and idempotent re-push short-circuit before any store. |
| Presence machinery | `server/mcp/agent-presence.js` | `getOrCreateSession(docGuid, agentToken, durationSeconds=60, { requiredRole })`; requires `agentToken.rawToken` (:439) to dial a `WebsocketProvider` back at `ws://WS_HOST:WS_PORT/s` (:448); session key `${userId}-${agentId}-${docGuid}` (:747); label `${agentName} (${userName})` + `isAgent:true` (:195-205); `_verifyDocumentAccess` DB query + optional `requiredRole` check (:749-756); reuse path extends the TTL via `_setSessionTimeout` (:413/:426-435). |
| Selection | `agent-presence.setTemporarySelection(sessionId, anchor, head)` (:974) | 10 s default (`DEFAULT_SELECTION_DURATION_MS`), then collapses to `head`. Exactly the "existing temporary-selection mechanism" the design names. |
| Position math | `server/mcp/yjs/cursor-operations.js` | `createBlockRangeSelection(fragment, minBlock, maxBlock)` (:884) → `{anchor, head}` or `null`. Verified **reads-never-write**: the text-less path anchors via `Y.createRelativePositionFromTypeIndex(element, 0)` (:594-600, feature 027) and there is **no** `insert(`/`new Y.XmlText` anywhere in the module. |
| Synthetic token | `server/mcp/auth/agent-token-factory.js` `createAgentTokenPair` | Returns `{ jwt, token }` where `token` carries `rawToken` (the JWT). Used by `server/api/chat.js buildChatAgentToken` (:104-112). |
| WS auth | `server/index.js:1917-1941` | Accepts `?token=` via `permissions.extractUser` — which tries user JWT → **agent JWT** → `sk_sqd_`. Requires **view** access only; **no scope check** on upgrade. So a synthetic agent JWT is a valid dial credential (chat proves it in prod). |
| Redis fan-out | `server/index.js:2129-2236` | `doc._redisUpdateHandler` is attached **lazily, inside the WS connection handler**, only when `!doc._redisSyncInitialized && redisPubSub.isEnabled()`. Publish skip-list is exactly `ORIGIN_REDIS` and `ORIGIN_DB_LOAD` (:2220). Detached when the last connection closes (:2264). |
| Live-apply precedent | `server/live-apply.js` `applyLiveUpdate` | apply-if-loaded + publish-only-if-no-attached-handler (the "H1 double-send guard", :43). Used by `server/undo/undo-service.js:221,295` and `server/version-history.js:671`. |
| Fire-and-forget precedent | `server/mcp/tools/create-document.js:229-231` | `agentPresence.getOrCreateSession(...).catch(warn)` — never awaited, never fatal. |
| Mint-time naming | `server/mcp/tools/import-markdown-file.js:176-177`, `server/mcp/tools/create-access-token.js:183` | Both build `` `Minted by ${agentToken.agentName || agentToken.agentId || 'agent'} via …` `` and cap at 255. **`create_access_token` has no `name` input parameter today** (inputSchema :47-68 = scopes/ttlSeconds/inline). |
| MCP client identity | `server/mcp/auth/oauth-flow.js:692` | A registered OAuth client's `client_name` becomes the agent's `name`, which is what surfaces as `agentToken.agentName` (e.g. `"Claude Code"`). That is the "connecting client's identity" FR-017 refers to — no new plumbing needed. |

---

## R2 — Decision: credential for the presence WS dial (spec FR-005, plan's choice)

**Decision**: **Mint a synthetic agent token pair per import request** (`createAgentTokenPair`, the chat
pattern) for all three modes. Do **not** recover the raw bearer from `req.headers.authorization`.

**Rationale**

1. **Sync cannot use the bearer at all.** FR-015 requires the sync push's presence label to be the
   *sync agent name* (`'Repo Sync'`), which is what `applySyncPush` stores as the version-history
   author — not the token's own name. `getOrCreateSession` derives its label solely from
   `agentToken.agentName` (`_buildAgentInfo`, :195). A raw bearer carries the token's name, so a
   bearer-based dial would announce the wrong identity for sync and violate FR-015/US4. One mechanism
   that is correct for all three modes beats a mode-dependent split.
2. **Least privilege / no new secret handling.** `permissions.extractUser` deliberately does not
   return `rawToken`; recovering it would make the import route the only place that hands a
   long-lived user `sk_sqd_` secret to an outbound client. The synthetic JWT is short-lived, minted
   for this request, and scoped at or below the caller (Constitution Principle V).
3. **Dedup is preserved exactly** (FR-002). The session key is `${userId}-${agentId}-${docGuid}`;
   minting with `agentId = req.user.agentId` (`api-token:<id>`) produces a key **identical** to the
   one an MCP tool call authenticated with the same token builds, so an import and a concurrent MCP
   session collapse to one presence entry. `presence-claim` dedup keys off the same components.
4. **Availability.** A bearer can expire mid-flight (minted tokens default to a 1 h TTL); the
   synthetic JWT is fresh for the request.

**Identity per mode** (FR-015):

| Mode | `agentId` | `agentName` | Resulting label |
|---|---|---|---|
| append / replace | `req.user.agentId` (`api-token:<id>`) | `req.user.agentName` (token name) | `"Claude Code (Liz Chen)"` |
| sync | `'repo-sync'` | `SYNC_AGENT_NAME` (`'Repo Sync'`) | `"Repo Sync (Liz Chen)"` |

Scopes: pass through `req.user.scopes` — never broader than the caller. The WS upgrade enforces view
access only, so scope choice does not gate the dial; passing them through is defense in depth.

**Alternatives considered**

- *Recover the bearer from `Authorization`* — rejected: wrong label for sync (see 1), widens raw-secret
  handling, and dies with token expiry.
- *Bearer for append/replace + synthetic for sync* — rejected: two credential paths, two failure
  modes, no benefit; the synthetic path already reproduces the exact append/replace identity.

---

## R3 — Decision: cross-replica content fan-out (FR-018/FR-019)

**The hole, restated precisely.** `doc._redisUpdateHandler` is attached only by the WS connection
handler (`server/index.js:2131-2236`). An import reaches the shared doc through
`documentService.getSharedDoc` → `getYDoc`, which loads/binds the doc but attaches **no** Redis
handler. On a replica holding no live connection for that document, an import therefore persists and
broadcasts to local (zero) clients, and **never publishes** — viewers on other replicas see nothing
until reload.

> Note: presence itself partially masks this (the presence dial opens a real WS connection, which
> attaches the handler) — but the dial targets `WS_HOST`, which in a multi-replica deployment is the
> load-balanced service and may land on **any** replica, and presence is best-effort and absent for
> human-session imports. The fan-out fix must therefore stand on its own; it is **not** a presence
> side effect. This is exactly why the design folds the fix into this feature rather than relying on it.

**Decision — two shapes, one for each apply style:**

**(a) `mode=sync` — reuse `applyLiveUpdate` unchanged.** `applySyncPush` already has the exact shape
`applyLiveUpdate` was extracted for (store-then-apply of an *encoded update*). Replace the inline
`Y.applyUpdate(sharedDoc, pushUpdate, ORIGIN_SYNC_PUSH)` with
`applyLiveUpdate({ getSharedDoc, redisPubSub }, docGuid, pushUpdate, ORIGIN_SYNC_PUSH, 'sync')`.
`redisPubSub` is injected via `opts` with `require('./redis-pubsub')` as the default (the
`undo-service.js:39` `defaultRedisPubSub` pattern) so tests can pass a double.
*No double-apply*: `applyLiveUpdate` applies once, to the same shared doc the old line applied to.
*No double-publish*: `ORIGIN_SYNC_PUSH` is deliberately **off** the publisher skip-list, so when a
handler is attached that handler publishes and `applyLiveUpdate`'s H1 guard (`!sharedDoc._redisUpdateHandler`)
suppresses the explicit publish. *No feedback loop*: receivers apply with `ORIGIN_REDIS`, which **is**
on the skip-list and which `parseOrigin` maps to `null` (no second persisted row).
*Single replica*: `redisPubSub.isEnabled()` is false → byte-identical behavior to today (FR-019).

**(b) `mode=append|replace` — capture-the-update-and-publish-if-unhandled.** These transact directly
on the shared doc, so the update is *already applied* — calling `applyLiveUpdate` would re-apply an
update the doc already has (a Yjs no-op, but semantically wrong and it re-derives the guard too late).
Instead:

1. `documentService.updateDocument` gains an **additive return value**. Its existing
   `ydoc.once('update', handler)` already sits exactly where the bytes are; capture them:
   `{ update, hadRedisHandler }`, where `hadRedisHandler = !!ydoc._redisUpdateHandler` is read
   **inside the update listener, at emit time**. Returns `{ update: null, hadRedisHandler: false }`
   when no update fired (the existing 50 ms no-change timeout path).
2. `importMarkdown` threads that through on its report as `report.live` (an internal module contract,
   not the HTTP receipt).
3. The route calls a new `publishIfUnhandled({ redisPubSub }, docGuid, update, hadRedisHandler, label)`
   exported from `server/live-apply.js` — publish-only, no apply; logs and swallows every failure
   (ledger RBD-6: fan-out failure never fails a persisted import).

**Why `hadRedisHandler` is read at emit time, not after the await.** The presence dial (or any
browser) can attach `_redisUpdateHandler` in the window between the transaction and a post-hoc check.
A post-hoc check would then see a handler that never observed our update and skip publishing — the
update is silently lost cross-replica. Reading the flag inside the synchronous update emission is
correct by construction: the Redis handler is registered as a peer `'update'` listener
(`server/index.js:2234-2235`), so "was it attached when the event fired" is exactly "did it publish".

**Alternatives considered**

- *Route-level `ydoc.on('update')` listener around `importMarkdown`* — no shared-module change, but it
  cannot distinguish our transaction from a concurrent human edit (the origin is a plain
  `{userId, agentName}` object, and a concurrent browser edit by the same user carries the same
  userId). It would work (republishing a foreign update is idempotent) but is imprecise; rejected in
  favor of capturing at the exact site that already owns the transaction.
- *Attach `_redisUpdateHandler` eagerly in `getSharedDoc`* — a much larger blast radius (every doc
  loaded for export, search indexing, version history would subscribe to Redis and never unsubscribe;
  the teardown is owned by the WS close path). Rejected.
- *New origin sentinel for imports* — unnecessary: the import's origin must stay parseable
  (`createOrigin(userId, agentName)`) because it is what attributes the persisted row. Publishing the
  same bytes changes nothing about origin handling.

---

## R4 — Decision: changed-range computation per mode (FR-011, FR-013)

Every position is produced by `cursorOps.createBlockRangeSelection(fragment, first, last)` — verified
pure (R1) — and computed from the **live shared doc after apply**. Yjs `RelativePosition` JSON is
CRDT-item-based and therefore doc-instance independent, so positions computed on the shared doc
resolve correctly in the presence session's own Y.Doc and in every browser (this is the same JSON
shape the MCP tools already emit).

| Mode | `first` | `last` | Source |
|---|---|---|---|
| append | `len - report.blocks.imported` | `len - 1` | post-apply `fragment.length`; append always lands at the tail, so post-apply arithmetic is robust to concurrent inserts earlier in the doc |
| replace | `0` | `len - 1` | replace clears and re-inserts the whole fragment — the imported content *is* the document |
| sync | min touched top-level index | max touched top-level index | `observeDeep` on the fragment, filtered to `transaction.origin === ORIGIN_SYNC_PUSH` |

**Why sync is observed rather than computed.** A sync push edits an arbitrary subset of blocks; the
first-to-last changed block is only knowable from the diff. `applySyncPush` has the information
(`hunks`/`plan`/`sourceMap`) but exposing it would either change the receipt (forbidden — spec Out of
Scope: "any change to … receipts") or require an out-of-band callback through the engine.
`fragment.observeDeep((events, transaction) => …)` gives the *actually applied* change, needs zero
markdown-sync changes, and the `ORIGIN_SYNC_PUSH` sentinel is an unambiguous filter (no other writer
uses it), so concurrent human edits cannot pollute the range. Top-level index derivation: for a deep
event, `event.path[0]` is the touched top-level index; for the fragment's own event (`path === []`),
walk the delta (`retain`/`insert`/`delete`) to get the touched index span. The observer is registered
before `handleSyncPush` and unregistered in a `finally`.

**Why append/replace are computed rather than observed.** Their transaction origin is a plain
`{userId, agentName}` object created inside `document-service`, not identity-comparable and not
distinguishable from a concurrent browser edit by the same user. The arithmetic above is exact and free.

**Degenerate ranges** (see ledger RBD-7): a sync push whose net effect is pure deletion leaves a
zero-width post-apply span. `createBlockRangeSelection` returns `null` for an invalid range; the route
then shows no selection rather than fabricating one. `null` selection ⇒ no `setTemporarySelection`
call (FR-012 for the no-op case falls out of the same branch: no-op receipts report
`noop: true`, and the observer recorded nothing).

**Reads-never-write proof obligation** (FR-013, SC-005): the only functions this feature calls against
document structure are `fragment.length`, `fragment.toArray()`, `createBlockRangeSelection`, and
`observeDeep` — all read-only. A test asserts byte-identical final document state with presence
enabled vs. disabled.

---

## R5 — Decision: the ~2 s cap and `getOrCreateSession`'s own access verification (FR-009)

`getOrCreateSession` does real work before it resolves: `_verifyDocumentAccess` (one DB query) →
optional `requiredRole` check → `_createSessionCore` (WS dial, up to a 10 s connect timeout, plus
`_waitForDocumentContent` which can wait up to 10 s for a large doc to sync). It can therefore far
exceed 2 s on a cold document.

**Decision — the cap is a *pre-apply* bound only, never a deadline on the session itself:**

1. Right after the editor gate, the route starts the attach and keeps the promise:
   `presence = importPresence.open({...})`. `open()` never throws (internal try/catch → resolves
   `null` on failure) and its promise has a `.catch` attached at creation, so there is no unhandled
   rejection even if nothing ever awaits it.
2. The route then awaits `Promise.race([promise, timer(2000)])` where the timer **resolves** (not
   rejects). On timeout the import proceeds immediately; the session attempt continues in the
   background and, when it lands, announces normally (FR-009, US3 scenario 2).
3. **After apply nothing is awaited at all.** The changed-range positions are computed synchronously
   post-apply and captured in a closure; the route then does
   `promise.then(session => { refresh(session); setTemporarySelection(session.sessionId, anchor, head); })`
   fire-and-forget. A late session still shows a correct selection — `RelativePosition`s are stable
   under subsequent edits. Total added latency on the response path is bounded by the 2 s pre-apply
   race and nothing else (SC-004).
4. **`requiredRole: 'editor'` is still passed.** It duplicates the route's `documents.hasRole` gate,
   but the presence layer's own invariant belongs to the shared mechanism and weakening it for one
   caller would be the wrong trade. Both checks live inside the 2 s budget; the route's gate remains
   authoritative for the import itself (spec Assumptions). Cost: one extra indexed query.
5. **"Refreshed at apply time"** (FR-007) is a second `getOrCreateSession` call with the same
   synthetic token. That hits the reuse path (`_createSessionCore` :421-435), which calls
   `_setSessionTimeout(session, 60)` — so the session lingers ~60 s *after* the response even when the
   image pass ran for a minute, with zero new presence capability (ledger RBD-3: no new tunables).
   Fire-and-forget, errors swallowed.

**Where presence opens.** Immediately after the editor-role gate and mode validation, before receipt-option
validation, the empty-body check, `waitForDocLoaded`, sync baseline validation, parsing and the image
pass. This is the literal design text ("right after the auth and editor-role gates, before parsing and
the image pass") and is required by the spec's own edge case, which contemplates presence already being
open when the import fails with a "validation error, size cap, baseline rejection". Presence is skipped
entirely for unknown modes (they 400 before anything) and for `req.user.isAgent !== true` (FR-003).

---

## R6 — Decision: mint-time naming (FR-017, FR-017a)

**Finding**: `create_access_token` has **no `name` parameter** today (inputSchema
`create-access-token.js:47-68`). FR-017 and US5 scenario 2 both presume "a caller-supplied name is
still honored" and FR-017a requires the contract to "tell agents to name the token after themselves" —
neither is actionable without the affordance. **The parameter must be added** (ledger RBD-10).

**Decision**:

- New shared helper `deriveMintedTokenName(agentToken)` in `server/mcp/auth/token-naming.js`:
  `agentToken.agentName` (trimmed, non-empty) → else `'AI Agent'`; capped at 255. For a delegation
  principal `agentName` is the OAuth-registered `client_name` (e.g. `"Claude Code"`) — that *is* the
  connecting client's identity FR-017 names, with no new plumbing. For an `sk_sqd_` principal minting
  a child token, it is the parent token's own (already agent-descriptive) name, so the convention
  converges rather than re-deriving. The `api-token:<id>` **agentId is never used as a fallback** — it
  is an opaque identifier, not a name.
- `import_markdown_file` (:176-177): default name ← `deriveMintedTokenName(agentToken)`. The recipe
  tool takes no content and no name; no caller-supplied override is added there.
- `create_access_token`: add optional `name` (string, trimmed, 1–255 chars) to `inputSchema`; honored
  verbatim when supplied, `deriveMintedTokenName` otherwise. Both delivery modes (claim + `inline`)
  use the same resolved name.
- Contract text (FR-017a): both tool `description`s state that the token name is the agent's public
  identity — shown as the live presence label while it imports and as the author in version history —
  and instruct the agent to name the token after itself (e.g. `"Claude Code"`), never after the
  operation.
- No retroactive renames (FR-017 / US5 scenario 3): only default strings and the new parameter change;
  `api_tokens` rows are never rewritten. **No migration.**

---

## R7 — Test strategy (Constitution Principle II)

Backend Jest, **serial only** (shared DB). Existing suites to extend rather than duplicate:

| Concern | Suite |
|---|---|
| Route behavior, presence gating, best-effort | `server/__tests__/api-docs-import.test.js` (unit-level route) and `__tests__/integration/docs-import-api.test.js` |
| Sync route + fan-out | `__tests__/integration/sync-push.route.test.js`, `server/__tests__/markdown-sync.*.test.js` |
| Presence session semantics / dedup | `server/mcp/__tests__/agent-presence.test.js`, `presence-claim.test.js`, `presence-multi-instance.test.js` |
| Cross-instance delivery | `__tests__/integration/redis-sync.test.js` |
| Mint naming | `server/mcp/__tests__/tools/create-access-token.test.js`, `tools/import-markdown-file.test.js`, `__tests__/integration/import-recipe-e2e.test.js` |

New suites: `server/__tests__/import-presence.test.js` (the orchestration module: gating, 2 s cap,
error swallowing, per-mode identity, changed-range math) and `server/__tests__/live-fanout.test.js`
(`publishIfUnhandled` + `updateDocument`'s capture, with a `redisPubSub` double).

Presence tests use the existing agent-presence test harness (real awareness against an in-process WS
server — see `presence-real-awareness.test.js`) rather than a bespoke mock, so FR-001's "no parallel
relay" is enforced by construction.

**No migration is required by this feature.** No schema change is introduced anywhere (naming affects
only values written into the existing `api_tokens.name` column).

---

## R8 — Risks / watch-items for the implementer

1. **Do not await presence anywhere on the response path** except the single 2 s pre-apply race.
   Every other presence call is `.then(...).catch(...)` with no `await`.
2. **`updateDocument`'s return value is additive** — `createSeededDocument` and every existing caller
   ignores it. Do not change its timing semantics (the 50 ms no-change timeout must stay).
3. **The sync observer must be removed in a `finally`** — a leaked `observeDeep` on a long-lived shared
   doc is a real leak.
4. **`waitForDocLoaded` still runs before `importMarkdown`** for append/replace; presence opening
   earlier must not disturb that ordering.
5. **`_verifyDocumentAccess` joins `document_shares`** — a document whose owner has no share row would
   fail presence (not the import). Existing MCP tools rely on the same query, so this is pre-existing
   behavior, but it is the most likely cause of a "presence silently absent" report.
