# Contract — `server/document-service.js` after 049

The module stays the single implementation point for every server-side content
operation. `init`, `getSharedDoc`, `peekSharedDoc`, `waitForDocReady` and
`acquireReadyDoc` are **unchanged in behavior** (the two doc comments that assert
the 048 mechanism are corrected — FR-014).

---

## `updateDocument(docGuid, computeMutation, { userId, agentName })`

```js
/**
 * @param {string} docGuid
 * @param {(ydoc: Y.Doc) => ((ydoc: Y.Doc) => void) | null | undefined} computeMutation
 *   COMPUTE PHASE. Receives the ready shared document. MAY read it. MAY throw.
 *   MUST NOT mutate it. Returns the MUTATE PHASE, or nullish for "nothing to do".
 * @param {{ userId?: string|null, agentName?: string|null }} [options]
 * @returns {Promise<{ update: Uint8Array|null, hadRedisHandler: boolean }>}
 */
```

**There is no mutate-only convenience form.** A bare `(doc) => { …mutate… }` is
not accepted: it is indistinguishable from a compute phase that returns nothing,
and the ambiguity resolves in the dangerous direction (the mutation escapes the
transaction and lands with **no origin object**, i.e. an unattributed row). A
title set is written `() => (doc) => doc.getMap('meta').set('title', t)`.

### Sequence

1. `const ydoc = await acquireReadyDoc(docGuid)` — **unchanged** (bind-readiness
   gate + the 048 review's H1 staleness re-acquire). Everything after this point
   is synchronous until the `setImmediate` in step 10.
2. `const origin = createOrigin(userId, agentName)` — **unchanged**; object
   identity is what scopes the capture.
3. **Reentrancy refusal**: if a borrow is already open on `ydoc`, throw loudly
   (RBD-049-5). Checked here, before compute, so a nested call cannot mutate.
4. **Arm the compute-phase detectors** (FR-004): sample
   `Y.encodeStateVector(ydoc)` and attach an `update` tripwire.
5. `const mutate = computeMutation(ydoc)` — may throw; the detectors are
   disarmed in a `finally`. If the tripwire fired or the state vector changed,
   throw a named `ComputePhaseMutationError` identifying the document and the
   identity. A compute-phase throw propagates **unchanged** to the caller.
6. If `mutate` is nullish → skip to step 11 with the zero value. No borrow, no
   transaction, no listener armed.
7. Attach the **origin-scoped capture** listener — **unchanged**, including
   sampling `hadRedisHandler` at emit time and `on` + explicit `off` (never
   `once`).
8. `const borrowed = borrowedIdentity.acquire(ydoc, userId, agentName)` — see
   [borrowed-identity.md](./borrowed-identity.md).
9. Install and transact:
   ```js
   const own = ydoc.clientID;
   ydoc.clientID = borrowed;
   try {
     ydoc.transact(() => mutate(ydoc), origin);
   } finally {
     ydoc.clientID = own;            // every path: success, no-change, throw
     borrowedIdentity.endBorrow(ydoc, borrowed);   // records the new clock
   }
   ```
   A mutate-phase throw is logged loudly by name and then **rethrown unchanged**
   (error identity is part of the caller contract — `ImportError.code` drives
   HTTP status). The partial edit that escapes is the design's recorded residual.
10. `if (updateFired) await new Promise((r) => setImmediate(r))` — **unchanged**
    ("persistence initiated" contract, FR-021 of 037).
11. `if (ydoc._bindFailed) throw new BindFailedError(docGuid)` — **unchanged**,
    on every path including the no-change path.
12. `return captured` — **unchanged** shape and zero value.

### What is deleted (FR-009)

- the ephemeral `Y.Doc`;
- `Y.applyUpdate(eph, Y.encodeStateAsUpdate(ydoc))` — the seed;
- `Y.applyUpdate(ydoc, bytes, origin)` — the merge-back;
- the ephemeral doc's capture listener **and** the ordering subtlety that it may
  be attached only after the seed.

### What must not change (FR-010)

`waitForDocReady` and `acquireReadyDoc`; the origin object and origin-scoped
capture (identity, not shape) with the emit-time `hadRedisHandler` sample; the
post-write `BindFailedError` check; `via_sync` staying unset; the sync-push
pinned client id in `server/markdown-sync.js` (`applySyncPush` at L1063, the pin
at L1111 — **verified present**, per the withdrawn E-049-B); the undo/redo
inverse scratch-document pattern and its identity predicates; restore's own
document and its store-then-apply ordering; presence (nothing announces the
borrowed identity, the announcing wrappers stay where they are, import-presence's
origin-filtered observation keeps working because the transaction carries the
same origin object); broadcast, persistence and cross-pod fan-out semantics.

---

## `createSeededDocument({ userId, title, nodes, agentName })`

Its own call site (FR-005). Same behavior, two-phase shape:

```js
await updateDocument(docGuid, () => (ydoc) => {
  ydoc.getMap('meta').set('title', title);
  if (nodes.length > 0) ydoc.get('default', Y.XmlFragment).insert(0, nodes);
}, { userId, agentName });
```

One transaction, one undo boundary, one attributed row — unchanged.

---

## Call-site migration map (FR-005)

| Site | Shape after migration |
| --- | --- |
| `server/markdown-import.js:321` | **Not mechanical.** The pre-transaction XPath resolution and the in-transaction re-resolution collapse into **one** compute-phase resolution that returns the mutate closure with the resolved index. `ImportError('XPATH_NO_MATCH')` is thrown from compute. `append`/`replace` return their closures directly. Behavior-preserving: compute and mutate run back to back with no awaits on the same document, so "resolves against current state" is fully preserved (E-049-A, US2 AS4). |
| `server/api/chat-tools.js:60` (image insert) | mechanical `() => (ydoc) => …`; `stored`/`alt` already computed before the call |
| `server/api/chat-tools.js:108` (anchor) | mechanical; the `frag.length === 0` guard stays **inside** the mutate phase (it is a read, and it must observe the state the mutation runs on) |
| `server/api/docs-import.js:341` (anchor) | mechanical, same guard placement |
| `server/mcp/tools/create-document.js:197` (anchor) | mechanical, same guard placement |
| `server/mcp/tools/set-document-title.js:79` | mechanical; the permission checks already run before the call and stay there |
| `server/document-service.js:383` (`createSeededDocument`) | as above |

**Note on the anchor guard**: `if (frag.length === 0)` could be read as compute
work. It stays in the mutate phase deliberately — it does not throw, it is a
read, and hoisting it would separate the check from the insert it guards for no
benefit. A guard that decides "no mutation" mid-mutate is fine: the transaction
simply emits nothing and the zero value is returned (G6/C1 pin this).
