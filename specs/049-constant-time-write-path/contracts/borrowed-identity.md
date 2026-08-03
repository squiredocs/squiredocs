# Contract — `server/borrowed-identity.js` (new)

The **only** place in this codebase that assigns `doc.clientID`. That is the
point: `doc.clientID` is a public field whose reassignment yjs does not document
as supported (design, "Honest note on library support"), so the caveat and the
upgrade obligation live at exactly one site in code, next to the assignment.

Everything here is process-local, bounded, and non-correctness-bearing: losing
all of it costs one extra client id in a state vector and nothing else
(Principle VII, RBD-049-4).

---

## Surface

```js
/** Acquire the borrowed client id this identity uses on this document. */
acquire(ydoc, userId, agentName) → number

/** Record the clock the borrow ended at, and clear the open flag. */
endBorrow(ydoc, clientId) → void

/** True when a borrow is currently open on this document (reentrancy guard). */
isBorrowOpen(ydoc) → boolean

/** Test seam: drop this document's entries. Never needed in production — the
 *  WeakMap releases them with the document. */
_resetForTests(ydoc?) → void
```

`document-service.js` is the only caller. The install/restore of `doc.clientID`
happens in `updateDocument` (so the `finally` and the transaction sit in one
readable block), and `acquire`/`endBorrow`/`isBorrowOpen` own everything about
*which* id and *whether it is still safe*.

> If a future refactor moves the assignment, it moves **into** this module —
> never into a second one.

---

## `acquire(ydoc, userId, agentName)`

```text
key   := JSON.stringify([userId, agentName])           # RBD-049-3, nulls literal
rec   := weakMap.get(ydoc) ?? { open: false, entries: new Map() }

if rec.open → throw BorrowReentrancyError(docGuid-ish identifier)  # RBD-049-5

entry := rec.entries.get(key)
if entry:
    now := Y.getState(ydoc.store, entry.clientId)
    if now !== entry.clock  → DISCARD entry            # FR-007: another writer advanced it
    if entry.clientId === ydoc.clientID → DISCARD      # yjs re-minted onto our id
    else → reuse entry.clientId

if no entry:
    for attempt in 1..MAX_MINT_ATTEMPTS (10):
        id := crypto.randomInt(0, 2 ** 32)             # per process, FR-006
        if !ydoc.store.clients.has(id) && id !== ydoc.clientID:
            entry := { clientId: id, clock: Y.getState(ydoc.store, id) }   # 0
            break
    else → throw BorrowMintError                       # FR-002: fail, never install a collision

rec.entries.delete(key); rec.entries.set(key, entry)   # LRU touch
while rec.entries.size > MAX_IDENTITIES_PER_DOC (64):
    rec.entries.delete(first key)                      # harmless eviction, RBD-049-4
rec.open := true
return entry.clientId
```

**Why the reuse check is a clock comparison, not `store.clients.has()`**: a
cached id **is** in the document's client store — that is what reuse means. The
question FR-002/FR-007 actually ask at reuse time is "has anyone else advanced
it since we last did?", and that is exactly the clock comparison. `has()` is the
right check only at mint time.

## `endBorrow(ydoc, clientId)`

```text
rec.open := false
entry := rec.entries by clientId
entry.clock := Y.getState(ydoc.store, clientId)        # the document's own store, always
```

Called from the same `finally` that restores `doc.clientID`, so it runs on every
path — success, no-change (clock simply does not advance), and throw.

## Invariants this module owns

| # | Invariant | Requirement |
| --- | --- | --- |
| B1 | An id is never installed without a mint-time collision check | FR-002 |
| B2 | A cached id is never reused after another writer advanced it | FR-007, SC-009 |
| B3 | The clock always comes from the document's own store, never a remembered counter | FR-006 |
| B4 | Ids are drawn from `crypto.randomInt` per process | FR-006 |
| B5 | One id maps to exactly one `(userId, agentName)` identity, forever, in this process | FR-006, SC-002 |
| B6 | Entries cannot outlive the document's presence in the process | FR-006, RBD-049-4 |
| B7 | The per-document identity map is bounded and eviction is harmless | FR-006, RBD-049-4 |
| B8 | A reentrant borrow is refused loudly, never nested | RBD-049-5 |

## Errors

| Error | When | Surface |
| --- | --- | --- |
| `BorrowReentrancyError` | a borrow is attempted while one is open on the same document | thrown; names the mechanism and the document |
| `BorrowMintError` | `MAX_MINT_ATTEMPTS` consecutive collisions | thrown; the call fails rather than installing a colliding id |
| `ComputePhaseMutationError` | (raised by `document-service`) the compute phase mutated the document | thrown; names the document and the acting identity |

## The upgrade caveat, in code (FR-012)

The comment at the assignment site must say, in substance:

> `doc.clientID` is a public field, but yjs does not document reassigning it as
> supported. This works because yjs reads it at **struct-creation time, from the
> transaction's document** — not because of a promise. Before bumping `yjs`,
> `y-protocols` or `y-websocket`, re-run the client-id reader verification
> (`specs/049-constant-time-write-path/clientid-reader-audit.md`) and re-date the
> artifact. The insert-set guards in `server/__tests__/per-operation-doc.test.js`
> (G1, G2) are what catch a silent regression — they are load-bearing, not
> documentation.

The same obligation is recorded in `docs/dev.md` so an upgrader who never opens
this file still finds it.
