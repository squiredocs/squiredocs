# Data Model — 049 Constant-Time Server-Side Write Path

**No persistent schema.** Nothing about `yjs_updates` or any other table changes;
there is no migration. Everything below is in-process state or a value that
exists for the duration of one call.

---

## Borrowed client identity

A 32-bit unsigned integer drawn with `crypto.randomInt(0, 2 ** 32)`.

| Field | Meaning |
| --- | --- |
| `clientId` | the value installed on `doc.clientID` for the duration of one transaction |
| — | drawn **per process**, so two pods cannot deterministically collide (FR-006) |

**Invariants**

1. Never installed without a collision check against the document's own client
   store: `!doc.store.clients.has(clientId) && clientId !== doc.clientID` (FR-002).
2. Installed for exactly one synchronous transaction and restored in a `finally`
   that runs on every path — success, no-change, and throw (FR-001, SC-003).
3. Signs content operations only. **Never announced in awareness** (FR-010).
4. Maps to exactly one `(userId, agentName)` identity, forever, in this process
   (FR-006, SC-002). Many ids may map to one identity; one id mapping to two
   identities is the 048 defect and stays ended.
5. Never shared across processes (Out of Scope; Principle VII cache-only rule).

## Identity

The literal `(userId, agentName)` tuple the write is attributed with — the same
tuple that builds the origin object and stamps the durable row.

| Field | Type | Notes |
| --- | --- | --- |
| `userId` | `string \| null` | not normalized; `null` stays `null` (RBD-049-3) |
| `agentName` | `string \| null` | not normalized; `""` is distinct from `null` |

**Key encoding**: `JSON.stringify([userId, agentName])`. Chosen because it keeps
`null` distinct from the strings `"null"` and `""` without a separator that a
user-controlled value could forge.

**Invariant**: the fully-unattributed `(null, null)` identity is a real identity
with its own cache entry. Its rows carry no user and no agent, so the resolver
has nothing to be confidently wrong about (RBD-049-3).

## Identity cache entry

`(identity, document) → { clientId, clock }`, process-local.

| Field | Meaning |
| --- | --- |
| `clientId` | the borrowed id this identity uses on this document |
| `clock` | the value `Y.getState(doc.store, clientId)` returned when **this process** last finished a borrow with it |

**Storage**: `WeakMap<Y.Doc, { open: boolean, entries: Map<identityKey, Entry> }>`.

- Keyed by the **live document object**, so entries cannot outlive the document's
  presence in the process (FR-006) with no release hook to forget — the shape
  that leaked twice here before (041 `peekSharedDoc`, pre-deploy H2).
- `entries` is bounded (default 64 identities per document) with oldest-first
  eviction. Eviction is harmless: the next write mints a fresh id, which is
  exactly 048's behavior (RBD-049-4).

**State transitions**

```text
absent ──mint (collision-checked)──▶ { clientId, clock: 0 }
{ clientId, clock: c }
    ──reuse: Y.getState(store, clientId) === c──▶ borrow, then clock := new state
    ──reuse: Y.getState(store, clientId) !== c──▶ DISCARD, mint fresh (FR-007)
    ──identity-map eviction / document leaves the process──▶ absent
```

**Invariants**

1. The clock always comes from the **document's own store**, never from a
   remembered counter, so no `(clientId, clock)` pair is ever minted twice
   (FR-006, SC-009).
2. A mismatch between the recorded clock and the store's clock means another
   writer advanced this id: discard and re-mint (FR-007). This is the analogue of
   yjs's own self-heal, which a cached borrowed id does not get because at rest
   it is not the document's client id.
3. Losing the whole cache is harmless: correctness never depends on it
   (Principle VII).

## Compute phase

Caller work that may fail. `(ydoc: Y.Doc) => MutatePhase | null | undefined`.

- Runs **after** the bind-readiness gate and the staleness re-acquire, **before**
  the borrow is installed and before the transaction opens.
- MAY read the document (this is what preserves the import's re-resolution
  semantics) and MAY throw.
- MUST NOT mutate the document. Violation is detected by two constant-time
  tripwires (state vector comparison + an `update`-event listener armed across
  the phase) and fails the call loudly, naming the document and the identity
  (FR-004, PD-049-3).
- Returning nullish means "nothing to do": no borrow, no transaction, the zero
  return value, and the post-write `BindFailedError` check still runs.

## Mutate phase

Caller work that changes the document. `(ydoc: Y.Doc) => void`.

- Runs inside **one** transaction on the shared document, under the borrowed
  identity, with the caller's origin object.
- MAY read the document and mutate it through targeted Yjs operations against the
  existing tree (Principle IV).
- MUST NOT: throw; be async or await; perform I/O; read `doc.clientID` (it holds
  the borrowed id, not the document's own); construct anything that captures the
  document's client id (notably an `Awareness`); create subdocuments (yjs stamps
  a new subdocument with the document's *current* id — the borrowed one —
  permanently); or re-enter `updateDocument` (refused loudly, RBD-049-5).
- Runs **back to back** with the compute phase, no awaits between them, so it
  sees exactly the state compute resolved against.

## Client-id reader classification

The unit of the FR-008 audit artifact (`clientid-reader-audit.md`).

| Field | Meaning |
| --- | --- |
| `path` | file and line |
| `version` | the exact installed package version the reading was done against |
| `class` | `construction-time` (safe) \| `struct-creation-time` (the property borrowing relies on) \| `live` (**stop-the-line**) |
| `note` | why it is safe, or the mitigation, or the narrowing decision |

**Invariant**: zero readers may remain unclassified (SC-007). A `live`
classification halts implementation until the narrowing decision is recorded.
