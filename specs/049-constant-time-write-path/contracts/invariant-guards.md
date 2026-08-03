# Contract — the invariant guards after 049 (FR-011, FR-012)

`server/__tests__/per-operation-doc.test.js` is the file. Guards are re-pointed
**in place**: same identifier, same position, assertion changed to the property
049 provides, plus a comment recording what it used to assert and why that
changed (RBD-049-6). **No guard is deleted, and no re-pointing may weaken.**

The acceptance bar for every re-pointed guard: *break the invariant in the source
and the guard must fail.* Verified by doing it (SC-008), not by inspection.

---

## Kept unchanged — and more load-bearing than before

| Guard | Asserts | Why it survives 049 |
| --- | --- | --- |
| **G1** (×3: content insert, meta title set, seeded create) | the emitted update's insert set never contains the shared document's own `clientID`, and has exactly one id | The invariant was always about *which id signs the content ops*, never about where they were computed. The design names G1/G2 as what will catch a silent yjs regression. |
| **G2** (×4, restore) | restore authors under a fresh id, the stored bytes are the broadcast bytes, store happens before broadcast | Restore keeps its own document (FR-009/FR-010). Untouched. |
| **H1–H6b** | bind-readiness gate and the H1 staleness re-acquire | A different problem from identity; neither helped nor hurt (FR-010). Must pass **unchanged**. |
| **G6** | a no-change call returns the zero value, writes no row, leaks no listener | Now reached two ways — a nullish compute return, and a mutate phase that decides not to mutate. Both must produce it. |
| **C1** (×2: anchor placement, chat image start/end) | content placement | Behavior unchanged; the fixtures migrate to the two-phase shape (FR-011). |

## Re-pointed in place

### G3 — was: "two consecutive calls author under two DISTINCT one-shot clientIDs"

**Falsified by FR-006**: two calls by the *same* identity legitimately reuse one
id. **Re-pointed to**: two calls by **different** identities use **different**
ids; two calls by the **same** identity reuse **one** id; and no id is ever
shared by two identities. The last clause is the 048 guarantee and is the part
that must not weaken — assert it directly (map every observed id to the identity
that used it and assert the map is one-to-one), not as a by-product.

### G4 — was: "updateFn receives an EPHEMERAL doc, and its writes are invisible until the merge"

**Falsified by design.** **Re-pointed to**: the mutate phase receives the
**shared** document (`handed === ydoc`); its writes are visible on that document
immediately from inside the transaction; and the emitted update still carries
only the borrowed id, never the document's own. The third clause is what keeps
this guard about attribution rather than about plumbing.

### G4b — was: "the ephemeral doc is destroyed and never announces awareness"

**Re-pointed to**: the borrowed identity is never announced in awareness, and the
document's own `clientID` is restored after the call. Construct a
`y-protocols` `Awareness` on the shared document **before** the call, then assert
after it that `awareness.clientID` is the document's own id and that no awareness
state entry is keyed by the borrowed id. This also directly exercises the
construction-time classification the FR-008 audit records for `Awareness`.

### G5 — was: "a throwing updateFn leaves the shared doc byte-identical and writes no row"

**Re-pointed to the COMPUTE phase**, which is where throwing now lives: a
compute-phase throw leaves the encoded state **and** the state vector
byte-identical, writes no row, fires no update event, leaks no listener, restores
the document's own `clientID`, and propagates the **original** error object.

---

## New pins required (FR-011, FR-012)

| Pin | Asserts | Requirement |
| --- | --- | --- |
| **N1** | the document's own `clientID` is restored after **every** call: success, no-change, compute-phase throw, mutate-phase throw, and `BindFailedError` | FR-001, SC-003 |
| **N2** | a mint-time collision is redrawn — seed the document's store with a known id, force the draw to produce it once, assert a different id is installed and no colliding id ever reaches the document | FR-002 |
| **N3** | a cached id another writer has advanced is discarded — write under the cached id from a *foreign* document/clock, then write again through the cache and assert a **new** id is minted and no `(clientId, clock)` pair is duplicated | FR-007, SC-009 |
| **N4** | N writes by one identity introduce exactly **1** new client entry into the state vector; N writes by N identities introduce N | FR-006, SC-005 |
| **N5** | the clock comes from the document's own store — consecutive borrows by one identity produce strictly increasing clocks with no gap and no replay | FR-006 |
| **N6** | a compute phase that **inserts** is detected and fails loudly, naming the document and identity | FR-004 |
| **N7** | a compute phase that **only deletes** is detected too — the state-vector detector alone does not see this (probed), the update tripwire does | FR-004, PD-049-3 |
| **N8** | a reentrant `updateDocument` from inside a mutate phase is refused loudly, and the document's own id is still restored | RBD-049-5 |
| **N9** | **the named loud guard (FR-012)**: if struct creation stops carrying the installed id, or the document's own id stops being restorable, *this* test fails with a message naming the borrowed-identity mechanism — not an unrelated downstream assertion | FR-012, SC-008 |
| **N10** | eviction is harmless — evict an entry and assert the next write succeeds with a fresh id and correct attribution | FR-006, RBD-049-4 |
| **N11** | performance shape: per-operation time does not scale with document size across ≈80 KB / ≈800 KB / ≈3 MB (ratio ceiling, numbers logged) | FR-013, SC-001 |

N2, N3, N5, N8 and N10 belong in `server/__tests__/borrowed-identity.test.js`
(the module unit guards, no write path around them). N1, N4, N6, N7 and N9 belong
in `per-operation-doc.test.js` alongside the guards they extend. N11 is
`server/__tests__/borrowed-identity-performance.test.js`.

---

## The other eight test files (R7) — migration only, no new assertions

`document-service-capture.test.js`, `bindstate-failure.test.js`,
`live-fanout.test.js`, `resupply-resolution.test.js`,
`mcp/__tests__/tools/restore-document-version.test.js`,
`mcp/__tests__/tools/read-document-version.test.js`,
`mcp/__tests__/integration/undo-redo-workflow.test.js`, plus the fixtures inside
`per-operation-doc.test.js` itself.

Rule: `fn` → `() => fn`, **except** where the function throws — in
`document-service-capture.test.js` the "a throwing updateFn propagates" case
becomes a throwing **compute** phase and must keep asserting the original error
object propagates. Their assertions do not change; if one has to change to pass,
that is a behavior regression and it is reported, not accommodated.
