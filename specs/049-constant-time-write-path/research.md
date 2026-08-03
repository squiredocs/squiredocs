# Phase 0 Research — 049 Constant-Time Server-Side Write Path

**Date**: 2026-08-03 · **Feature dir**: `specs/049-constant-time-write-path/`

Ground truth: `design/collaboration-core.md` → "Per-identity server docs", the
2026-08-03 049 amendment, the RATIFIED option list, and the two corrections
appended the same day (the cached-identity clock re-check, and the honest note
on library support). Per Constitution Principle VI the design doc wins over this
file, over the code, and over any model prior.

Everything below marked **[probed]** was executed against this repo's installed
`yjs@13.6.30` during plan authoring (script: throwaway, results reproduced in
`quickstart.md` so the next reader can re-run it). Everything marked **[read]**
is source reading. Nothing here discharges FR-008 — see R6.

---

## R1 — The two-phase signature (resolves RBD-049-1's deferred half)

**Decision**: `updateDocument(docGuid, computeMutation, { userId, agentName })`,
where `computeMutation` is the **compute phase**:

```js
/** @type {(ydoc: Y.Doc) => ((ydoc: Y.Doc) => void) | null | undefined} */
```

It receives the ready shared document, MAY read it, MAY throw, MUST NOT mutate
it, and returns the **mutate phase** — or a nullish value meaning "nothing to
do". No plain-function (mutate-only) form is accepted.

**Rationale**:

- RBD-049-1 ratified shape (b), "compute returns mutate". This is that shape
  with the parameter fixed and the nullish return given a meaning.
- Handing the compute phase the *shared* document is what preserves
  `markdown-import`'s "re-resolve against current state" property (FR-005 note,
  US2 AS4): compute and mutate run back to back with no awaits, on the same
  document, so the XPath compute resolves against exactly the state the mutation
  runs on. Under 048 that re-resolution had to happen twice (once outside, once
  on the ephemeral copy); under 049 there is one document and one resolution.
- **Rejecting the mutate-only convenience form is the load-bearing part.** If a
  bare `(doc) => { doc.getMap('meta').set(...) }` were still accepted, the shape
  would be ambiguous with a compute phase that returns nothing — and the
  ambiguity resolves in the *dangerous* direction: the mutation escapes the
  transaction, so it broadcasts and persists with **no origin object**, i.e. an
  unattributed row, which is exactly the defect class the 041–048 train exists to
  end (RBD-049-2's own reasoning). One shape, no overload. Title set becomes
  `() => (doc) => doc.getMap('meta').set('title', t)` — three extra characters
  for an unambiguous contract.
- The nullish return is the no-change path: no borrow is installed, no
  transaction opens, the zero value `{ update: null, hadRedisHandler: false }`
  is returned, and the post-write `BindFailedError` check still runs (FR-010).

**Alternatives considered**:

- `{ compute, mutate }` options object — rejected by RBD-049-1 (leaves "compute
  ran, mutate used stale locals" expressible, and needs a value threaded between
  two separately-passed functions).
- Accepting both shapes with a `twoPhase: true` flag — a second write shape to
  maintain, and the flag is exactly the comment a future caller does not read.
- Wrapping a mutate-phase throw in a new error type — **rejected**, see R2.

## R2 — What happens when the mutate phase throws anyway

**Decision**: log loudly and by name (`[049] mutate phase threw …` with the doc
guid and the identity), then **rethrow the original error unchanged**.

**Rationale**: this is the residual the design records plainly ("a caller that
puts throwing work there anyway gets a partial edit that is broadcast, persisted
and undoable"). Replacing the error would change error identity for callers that
switch on `error.code` (`ImportError('XPATH_NO_MATCH')` → HTTP 400 today), which
FR-010's "same error surfaces" forbids. The log is the loud surface; the
contract is what makes it a deliberate act. No compensation machinery is added —
option (2) was rejected in the design on cost, not doubt, and this feature does
not reopen it.

## R3 — The borrow mechanics, probed against yjs 13.6.30

**[probed]** All of the following were executed, not assumed:

| Property | Result |
| --- | --- |
| `doc.store.clients.has(id)` answers the mint-time collision check | works; a fresh doc's store has no entry for an unused id |
| Install `doc.clientID = borrowed`, `transact(fn, origin)`, restore in `finally` | own id restored exactly |
| `Y.parseUpdateMeta(update).to.keys()` on the emitted bytes | `[borrowed]` only; the document's own id never appears |
| `Y.getState(doc.store, borrowed)` after 1 then 2 writes | `1` then `2` — the clock continues from the document's own store, which is what makes reuse safe (FR-006) |
| A **doc-level `update` listener** reads `doc.clientID` at emit time | sees the **borrowed** id — **the FR-008 window is real and confirmed**, see R6 |
| A bare (untransacted) mutation fires the doc `update` event synchronously | yes — this is what makes the compute-phase tripwire in R4 work |
| A **delete-only** mutation changes `Y.encodeStateVector(doc)` | **no** — see R4 |

**Decision**: the borrow lives in a new module `server/borrowed-identity.js`,
not inline in `document-service.js`. It is the one place that touches
`doc.clientID`, so it is the one place the yjs-upgrade caveat (FR-012) has to be
written down in code, and it is unit-testable without the write path around it.

**Random source**: `crypto.randomInt(0, 2 ** 32)`. Per process by construction
(FR-006), and mints are rare once the cache is in play, so the cost is
irrelevant. `Math.random()` would also be per-process but carries no reason to
prefer it.

## R4 — Compute-phase mutation detection: the ratified detector has a measured hole

RBD-049-2 ratified **state-vector comparison** around the compute phase. That is
correct for insertions and it is genuinely constant-time in document size
(`encodeStateVector` is proportional to the number of clients).

**[probed] It does not detect a delete-only mutation.** Deleting content marks
items deleted and records the deletion in the transaction's delete set; it adds
no struct to `store.clients`, so the state vector is byte-identical before and
after. A compute phase that only deletes would escape the transaction *and*
escape the detector — and a delete escaping with no origin is the same
unattributed-row defect the detector exists to catch.

**Decision**: keep the ratified state-vector comparison **and add** an
`update`-event tripwire armed for the duration of the compute phase. Any update
event fired while compute is running is a violation (compute is synchronous, so
nothing else can be running). Both are O(1) in document size; either firing
fails the call loudly and names the document and the acting identity.

This **strengthens** a RATIFIED-BY-DEFAULT decision rather than reversing it —
the ratified detector stays, wired exactly as ratified. Recorded as PD-049-3 in
`clarifications-needed.md` rather than applied silently, per Principle VI.

**Decision (the other half of RBD-049-2's deferred call)**: detection is **on in
production**, not test-only. Two reasons: it is the thing that makes R1's
one-shape signature safe against a stale caller (a legacy mutate-only function
mutates during compute and is caught rather than silently escaping), and it
costs two constant-time samples on a path that just got ~1000x cheaper.

## R5 — The identity cache: keyed by the live document object

**Decision**: `WeakMap<Y.Doc, { open: boolean, entries: Map<identityKey, Entry> }>`
in `server/borrowed-identity.js`, with `entries` bounded (default 64 identities
per document, oldest-first eviction) and `identityKey = JSON.stringify([userId, agentName])`.

**Rationale**:

- FR-006's hardest requirement is "cache entries for a document MUST NOT outlive
  the document's presence in the process", and RBD-049-4 recorded that this
  exact shape has leaked twice here already (041 `peekSharedDoc`, the pre-deploy
  H2 awareness timer). A `WeakMap` keyed by the document **satisfies it
  structurally**: when y-websocket deletes and destroys the doc, nothing holds
  the entry and it is collectible. There is no release hook to forget to call —
  and a forgotten release hook is precisely how the two prior leaks happened.
- `JSON.stringify([userId, agentName])` keeps `null` distinct from the string
  `"null"` and from `""`, which is what RBD-049-3 requires (literal tuple, nulls
  not collapsed).
- The per-document identity bound is what stops a document written by thousands
  of distinct principals from growing an unbounded map. Eviction is harmless by
  RBD-049-4: an evicted entry mints a fresh id, which is exactly 048's behavior.

**Consequence, flagged not resolved**: the spec's US3 AS3 imagines a *cached* id
surviving an unload/reload ("the same identity writes again through a cached
id"). Under a doc-keyed WeakMap a reload is a new `Y.Doc` object and therefore a
fresh id. The two spec bullets are in tension (FR-006 bullet 3 vs bullet 5); this
plan honors the anti-leak MUST, and the safety property AS3 actually asserts —
the clock always comes from the document's own store, never a remembered
counter, and no `(clientId, clock)` pair is ever minted twice — holds in both
readings and is pinned by a test. Recorded as **PD-049-2** and reported to the
analyze stage; not silently resolved.

## R6 — FR-008: what the plan schedules, and what it refuses to assume

The spec's preliminary sweep (`clarifications-needed.md` §B, DEC-049-7) found no
live reader across `yjs@13.6.30`, `y-protocols@1.0.7`, `y-websocket@1.5.4` and
this repo's `server/`. **The plan treats that as evidence and not as discharge**,
exactly as FR-008 and the design's "verified, not assumed" standard require.

**[probed] and it matters**: a document-level `update` listener reading
`doc.clientID` from inside transaction cleanup sees the **borrowed** id. The
window therefore covers the persistence listener, the y-websocket broadcast, the
Redis fan-out handler and the origin-scoped capture — every one of them runs
before the `finally` restores the id. This is not a theoretical widening; it was
observed.

**Decision**: the verification is scheduled as the **first** work of the
implementation, before any mechanism code, and produces a durable artifact at
`specs/049-constant-time-write-path/clientid-reader-audit.md` containing, per
reader: file, line, exact library version, and the classification
(construction-time / struct-creation-time / live). It must additionally cover
what the spec's sweep did **not**: anything the presence and awareness-guard
machinery attaches at runtime (`server/ws-awareness-guard.js`,
`server/mcp/agent-presence.js`, `server/mcp/presence-claim.js`,
`server/import-presence.js` and whatever else attaches a doc-level listener), enumerated from the running wiring rather than
from a grep. **Any live reader stops the line**: implementation halts, the
finding is reported, and the narrowing decision is recorded before work resumes.

**Search hazard, mandatory**: several files in this repo carry NUL bytes and are
treated as binary by plain `grep`, which then silently reports no matches
(`server/markdown-sync.js`, `server/resupply-resolution.js` known today; see
`docs/dev.md` → Troubleshooting). A "no reader found" conclusion drawn from a
plain `grep` is worthless here — that hazard already produced one withdrawn
finding in this feature's own ledger (E-049-B). Use `grep -a`, or read the file.

## R7 — The full caller inventory, verified against the code (extends FR-005)

FR-005 enumerates the seven **production** call sites, all confirmed present at
the stated lines. The signature change is breaking for **every** direct caller,
and the spec's inventory does not include tests. Verified with `grep -an`:

**Production (7)** — `server/markdown-import.js:321`,
`server/api/chat-tools.js:60`, `server/api/chat-tools.js:108`,
`server/api/docs-import.js:341`, `server/mcp/tools/create-document.js:197`,
`server/mcp/tools/set-document-title.js:79`,
`server/document-service.js:383` (`createSeededDocument`, its own call site).

**Test files calling `updateDocument` directly (8)** —
`server/__tests__/per-operation-doc.test.js` (the FR-011 guard file),
`server/__tests__/document-service-capture.test.js` (the 037/038 capture
contract — the largest caller by count),
`server/__tests__/bindstate-failure.test.js`,
`server/__tests__/live-fanout.test.js`,
`server/__tests__/resupply-resolution.test.js`,
`server/mcp/__tests__/tools/restore-document-version.test.js`,
`server/mcp/__tests__/tools/read-document-version.test.js`,
`server/mcp/__tests__/integration/undo-redo-workflow.test.js`.

Each of these is a mechanical `fn` → `() => fn` migration **except** where the
function throws (those move to the compute phase) — but none may be skipped, or
the suite fails wholesale rather than usefully. Called out as a plan LOUD FLAG.

## R8 — Performance evidence (FR-013 / SC-001)

**Decision**: a hermetic jest test `server/__tests__/borrowed-identity-performance.test.js`
following the `server/__tests__/import-performance.test.js` precedent (feature
002, T033): build the documents in memory, drive `documentService` through its
`init` seam with local `Y.Doc`s — no DB, no WebSocket — assert the **shape**
(per-operation time does not scale with document size) with a contention-tolerant
ratio ceiling, and `console.log` the actual numbers so the run records them.
Sizes ≈80 KB, ≈800 KB, ≈3 MB, matching the design's measured table. The recorded
numbers land in `specs/049-constant-time-write-path/performance.md`.

A ratio assertion, not an absolute millisecond budget: wall-clock budgets flake
under CPU contention (Sam, 2026-07-13, P-4), and the claim under test is
literally "the cost stops tracking document size".

## R9 — Documentation obligations (FR-012 / FR-014 / Principle I)

- **In code**: `server/borrowed-identity.js` carries the yjs-upgrade caveat at
  the point of the `doc.clientID` assignment.
- **In developer docs**: `docs/dev.md` gains an "Upgrading yjs / y-protocols /
  y-websocket" checklist item requiring the FR-008 verification to be re-run and
  the audit artifact re-dated before the bump merges.
- **FR-014 corrections**: `server/document-service.js` module header (L8-29),
  the `getSharedDoc` warning (L66-69), the inline 048 block in `updateDocument`
  (L259-274), and `server/version-history.js` L1046-1052 (which says "like every
  other server-side write, authored under a one-shot clientID" — true for
  restore, false about the others once 049 lands).
- `README.md` was checked (`grep -an`): it does not describe the 048 mechanism,
  so no README change is required by this feature. `design/` is export-only and
  is **not** touched (Principle VI); the design amendment it would need is
  already recorded as owed to Sam in D-049-A.

**Note for the plan agent's own scope**: this plan does not edit `CLAUDE.md`,
`README.md`, `docs/dev.md` or anything under `design/`. The `docs/dev.md`
checklist above is scheduled as implementation work, not performed here.
