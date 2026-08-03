# Performance evidence and semantic side effects (049)

**Date**: 2026-08-03 · **Requirements**: FR-013, SC-001, SC-008 · **Tasks**: T024, T025, T030a, T039, T044

---

## 1. Measured — `updateDocument` cost vs document size (FR-013, SC-001)

One `meta` title set, median of 25 operations after a 3-operation warm-up, run
hermetically through `documentService.init` with local `Y.Doc`s
(`server/__tests__/borrowed-identity-performance.test.js`, pin **N11**).

| Document (encoded) | 049 borrowed identity | 048 ephemeral copy (design's table) | Speedup |
| --- | --- | --- | --- |
| 87,519 bytes (~85 KB) | **0.0524 ms** | 15.6 ms @ 79 KB | ~300x |
| 822,920 bytes (~800 KB) | **0.0453 ms** | 56.4 ms @ 794 KB | ~1,200x |
| 3,152,145 bytes (~3 MB) | **0.0435 ms** | 211.8 ms @ 3.2 MB | ~4,900x |

The multiplier is not the point and is not worth quoting — it varies with the
machine. **The shape is the point.** The document grew ~36x across those rows
and the per-operation cost did not rise at all; it drifted slightly *down*,
which is measurement noise around a flat line. Under 048 the same three rows
rose 13.6x, because the cost *was* the document: serialize it, deserialize it
into a throwaway `Y.Doc`, operate, merge back.

A title set is O(1) again, which is what retires the design's recorded cost
("Each server-side operation pays O(doc size) to seed the ephemeral doc") and
moots the deferred meta-only cheap path.

**How the guard asserts this**: a ratio ceiling (largest/smallest median < 8)
plus an absolute sanity ceiling (< 10 ms on the 3 MB document), not a
wall-clock budget. Wall-clock budgets flake under CPU contention; this follows
the contention-tolerant posture `server/__tests__/import-performance.test.js`
already set. The 048 numbers would fail both ceilings decisively.

## 2. ⚠️ What is NOT constant time — stated rather than rounded up (T044, analyze F6)

**049 makes `updateDocument` itself constant time. The end-to-end server-side
write is not.**

The persistence listener still runs `classifyByXml`
(`server/update-classifier.js`) on every applied update. That is documented in
its own header as **O(document size) per applied update**, and it is skipped
only *above* a 500 KB ceiling — so for documents **under** 500 KB, every
server-side write still does work proportional to document size, after
`updateDocument` returns.

049 does not change that, does not make it worse, and does not claim to remove
it. It is called out here because "sub-millisecond server-side write" would be
an overclaim: the borrow is constant time, the write as a whole is not. The
numbers in §1 measure `updateDocument`, which is the thing this feature
changed.

Note the shape of the residual is inverted from the one 049 removed: the old
cost hurt *large* documents most, `classifyByXml` hurts documents *under* the
ceiling. Nothing here is a regression; it is simply the next thing in the way
if constant-time end-to-end ever becomes a goal.

## 3. Semantic side effects of transacting on the shared document (T030a)

### (a) The transaction is now LOCAL, and that is why FR-007 exists

048 merged bytes with `Y.applyUpdate`, which yjs runs as a **non-local**
transaction. 049 uses `doc.transact`, which is **local** (`transact(doc, f,
origin, local = true)`, `yjs.cjs:3434`).

- **Nothing in `server/` branches on `transaction.local`.** Verified with
  `grep -arn` (NUL-safe); the only matches are the explanatory comments 049
  itself added in `server/borrowed-identity.js`. No behavior depends on it.
- **But it disables yjs's own duplicate-client-id self-heal for our writes.**
  `yjs.cjs:3379` is guarded by `!transaction.local &&  …`, so for a local
  transaction the condition short-circuits and `doc.clientID` is not even read.
  Under 048's non-local merge that self-heal *could* fire; under 049 it can
  never fire.

  This is the mechanical reason FR-007's manual clock re-check before reusing a
  cached id is a **requirement, not a precaution**: a borrowed id gets no
  protection from yjs's own repair, and caching stretches the exposure across
  the whole process lifetime. Pinned by **N3** (verified non-vacuous — see §4).

### (b) import-presence's origin-filtered observation is unchanged

`server/import-presence.js:404` observes the default fragment with
`observeDeep` and filters by origin. Its events now come from a **local
mutation** rather than from an **applied update**. Expected to be equivalent,
but FR-010 pins presence behavior as unchanged, so it was demonstrated rather
than assumed: `server/__tests__/import-presence.test.js` passes **unchanged**
(12 tests) against the migrated write path. The transaction carries the same
origin object it always did, which is what the filter matches on.

## 4. Deliberate-regression check (SC-008)

**Run, not assumed.** Both breakages were applied to
`server/document-service.js`, the suite was run, the failures were read, and
the breakages were reverted (verified: zero `DELIBERATELY BROKEN` markers
remain, suite back to 29/29).

### Break 1 — skip the install (`borrowedIdentity.install(ydoc, borrowed)` removed)

Structs are then signed with the document's own clientID — the exact
misattribution 048/049 exist to end.

**10 of 29 guards failed**, including every one that should: G1 (×3), G3, N4,
G4, G4b, C1 (×2), and **N9**.

N9 failed **by name**:

```
*** BORROWED-IDENTITY MECHANISM REGRESSION (feature 049, FR-012) ***
FAILED CHECK: the mutate phase did not observe the borrowed id

server/borrowed-identity.js installs a borrowed clientID on the shared
document for the duration of one synchronous transaction, relying on yjs
reading doc.clientID at STRUCT-CREATION TIME from the transaction's
document. That is not a documented guarantee. This failing means the
mechanism no longer behaves as verified — most likely a yjs, y-protocols
or y-websocket upgrade.

DO: re-run the FR-008 verification and re-date
    specs/049-constant-time-write-path/clientid-reader-audit.md
    (node specs/049-constant-time-write-path/fr008-probe.cjs)
DO NOT: "fix" this by relaxing the assertion. Every server-side write's
    attribution depends on it.
```

### Break 2 — skip the restore (`borrowedIdentity.restore(ydoc, ownClientId)` removed)

The document is left permanently wearing a borrowed identity.

**11 of 29 guards failed**, including **N1** ("the document's own clientID is
restored after EVERY call") and **N9**, which named the second check:

```
FAILED CHECK: the document's own clientID was not restored
```

### Two other invariants were checked the same way, outside SC-008's letter

- **The mint-time collision check** (B1/FR-002): removing
  `!ydoc.store.clients.has(id) && id !== ydoc.clientID` from `mint()` failed
  **4 of the N2 guards**. Not vacuous.
- **The FR-007 reuse re-check** (B2/SC-009): forcing the clock comparison to
  never discard failed **N3** — specifically its assertion that no
  `(clientId, clock)` pair is duplicated, which is the actual CRDT corruption
  the check prevents. Not vacuous.

**Conclusion**: the named guards genuinely detect the failures they exist to
detect. This was verified by breaking the mechanism four separate ways and
reading the failures, not by inspection.
