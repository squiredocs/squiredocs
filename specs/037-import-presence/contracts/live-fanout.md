# Contract — cross-replica content fan-out for imports (FR-018 / FR-019)

Internal server contract. Nothing here is observable in an HTTP response; the observable outcome is
"a viewer on a non-handling replica sees the content change without reloading" (SC-003).

---

## 1. `documentService.updateDocument` — additive return value

**Before**: `Promise<void>`.
**After**: `Promise<{ update: Uint8Array|null, hadRedisHandler: boolean }>`.

```js
const { update, hadRedisHandler } = await documentService.updateDocument(docGuid, fn, { userId, agentName });
```

Rules:

- Both fields are captured **inside the existing `ydoc.once('update', handler)`** that the function
  already registers — no new listener, no new timing.
- `hadRedisHandler = !!ydoc._redisUpdateHandler` is sampled **at emit time**, not after the await.
  This is load-bearing: the presence dial (or any browser) can attach the handler in the window
  between the transaction and a post-hoc check, and a post-hoc check would then skip publishing an
  update the handler never saw — a silent cross-replica loss (research R3).
- When the transaction changes nothing, the existing 50 ms timeout path resolves
  `{ update: null, hadRedisHandler: false }`.
- **Timing semantics are unchanged.** All existing callers (`createSeededDocument`, the create-import
  route's `EMPTY_IMPORT` fallback, chat, MCP tools) ignore the return value.

## 2. `markdownImport.importMarkdown` — additive report field

**After**: the resolved report gains `live: { update, hadRedisHandler }` — the value returned by the
single `updateDocument` call it makes.

This is an internal module contract (`contracts/import-module.md` lineage). It is **not** part of the
HTTP receipt: the route response keeps exactly `{ docId, mode, clock, blocks, images, markdown }`.

## 3. `liveApply.publishIfUnhandled` — new export in `server/live-apply.js`

```js
publishIfUnhandled({ redisPubSub }, docGuid, update, hadRedisHandler, label = 'live-fanout');
```

Publish-only companion to the existing `applyLiveUpdate`. For updates that were produced by a
transaction **on the shared doc itself** and are therefore already applied locally.

| Condition | Action |
|---|---|
| `!update` | no-op |
| `hadRedisHandler === true` | no-op — the attached handler already published (the import's origin is a plain `{userId, agentName}` object, which is **not** on the publisher skip-list) |
| `redisPubSub` missing or `!isEnabled()` | no-op — single-replica behavior unchanged (FR-019) |
| otherwise | `redisPubSub.publishUpdate(docGuid, update)` |

Guarantees: never applies anything (no double-apply, FR-019); never throws — publish failures are
logged and swallowed, because the update is already durable and the import already succeeded (ledger
RBD-6); introduces no new origin sentinel — the receiving replica applies with `ORIGIN_REDIS`, which is
on the publisher skip-list (no feedback loop) and which `parseOrigin` maps to `null` (no duplicate
persisted row).

## 4. `markdownSync.applySyncPush` — adopt `applyLiveUpdate`

**Before** (`server/markdown-sync.js`, after `persistence.storeUpdate`):

```js
const sharedDoc = getSharedDoc(docGuid);
if (sharedDoc) Y.applyUpdate(sharedDoc, pushUpdate, ORIGIN_SYNC_PUSH);
```

**After**:

```js
applyLiveUpdate({ getSharedDoc, redisPubSub }, docGuid, pushUpdate, ORIGIN_SYNC_PUSH, 'sync');
```

- `redisPubSub` arrives through `opts` with `require('./redis-pubsub')` as the default — the
  `server/undo/undo-service.js:39` `defaultRedisPubSub` pattern — so tests inject a double.
- `applyLiveUpdate` already contains the H1 double-send guard, the "never silent" warn when there is no
  delivery path at all, and non-fatal error handling. Its behavior on the handling replica is identical
  to the replaced two lines.
- No double-publish: `ORIGIN_SYNC_PUSH` is deliberately **off** the publisher skip-list
  (`server/index.js:2220`), so when a handler is attached the handler publishes and the H1 guard
  suppresses the explicit publish.
- The `searchIndexer.markDirty` call and the receipt shape after this line are untouched.

## 5. Behavior matrix (what tests must pin)

| # | Topology | Mode | Expected | Requirement |
|---|---|---|---|---|
| F1 | replica has no WS conn for the doc | append | exactly one `publishUpdate(docGuid, update)` | FR-018 |
| F2 | replica has no WS conn for the doc | replace | exactly one `publishUpdate` | FR-018 |
| F3 | replica has no WS conn for the doc | sync | exactly one `publishUpdate` | FR-018 |
| F4 | replica already relays the doc (handler attached) | append/replace | **zero** explicit publishes (handler did it) — no duplicate | FR-019 |
| F5 | replica already relays the doc | sync | exactly one publish total, from the handler | FR-019 |
| F6 | Redis disabled | all | zero publishes, no error, unchanged content | FR-019 |
| F7 | receiving replica | all | applies once; no re-publish; no second `yjs_updates` row | FR-019 |
| F8 | `publishUpdate` throws | all | import still returns its normal success response; one error logged | ledger RBD-6 |
| F9 | viewer on replica A, import on replica B | all three | viewer's document updates with no reload | SC-003 |
