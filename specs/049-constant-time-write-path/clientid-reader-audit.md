# Client-id reader audit (FR-008 / DEC-049-7)

**Date**: 2026-08-03 · **Feature**: 049-constant-time-write-path
**Verdict**: **GO** — every reader is construction-time, struct-creation-time, or
provably unreachable inside the synchronous borrow window. Recorded at T007.

**Re-date this artifact and re-run the whole sweep before bumping `yjs`,
`y-protocols` or `y-websocket`** (FR-012; the obligation is also recorded in
`docs/dev.md` and at the assignment site in `server/borrowed-identity.js`).

## Versions audited (T002)

| Package | Version | Source |
| --- | --- | --- |
| `yjs` | **13.6.30** | `node_modules/yjs/package.json` |
| `y-protocols` | **1.0.7** | `node_modules/y-protocols/package.json` |
| `y-websocket` | **1.5.4** | `node_modules/y-websocket/package.json` |

## Method, and why a plain `grep` was not used

`server/markdown-sync.js` and `server/resupply-resolution.js` contain NUL bytes.
`file` reports them as `data` and **plain `grep` / `git grep` silently report no
matches in them**. This hazard has produced four wrong conclusions on this
feature, including the spec's own preliminary sweep (see T005a below).

Every sweep in this artifact used **`grep -an` / `grep -arn`** (`-a` = treat
binary as text), and the doc-level listener inventory (T005) was enumerated
**from the wiring**, not from a text search. Empirical claims were then
**probed** against the installed libraries rather than reasoned about; the probe
script and its output are reproduced at the end.

## Classification scheme

| Class | Meaning | Safe under a borrow? |
| --- | --- | --- |
| **construction-time** | read once when an object is built, then cached | Yes — the borrow cannot be observed |
| **struct-creation-time** | read from `transaction.doc` at the moment a struct is created | Yes — **this is the mechanism**; it is why borrowing works |
| **live** | reads the field while a transaction may be open | **Only if provably unreachable**; otherwise stops the line |

---

## 1. `yjs@13.6.30` — `node_modules/yjs/dist/yjs.cjs` (T003)

Every occurrence of `clientID`, from `grep -an "clientID" node_modules/yjs/dist/yjs.cjs`:

| Line | Code | Class | Notes |
| --- | --- | --- | --- |
| 463 | `this.clientID = generateNewClientId()` | construction-time | `Doc` constructor. An assignment, not a read. |
| 3379 | `if (!transaction.local && transaction.afterState.get(doc.clientID) !== …)` | **live — but not reached** | See §1.1. |
| 3381 | `doc.clientID = generateNewClientId()` | (inside 3379's dead branch) | See §1.1. |
| 3402 | `subdoc.clientID = doc.clientID` | **live — unreachable today** | See §1.2. |
| 4168 | comment (`sort by clientID & clock`) | n/a | Not code. |
| 5407 | `const ownClientId = doc.clientID` in `typeListInsertGenericsAfter` | struct-creation-time | `doc = transaction.doc` |
| 5608 | `const ownClientId = doc.clientID` in `typeMapSet` | struct-creation-time | `doc = transaction.doc` |
| 6403 | `const ownClientId = doc.clientID` in `formatText` (negated-attribute pass) | struct-creation-time | `doc = transaction.doc` |
| 6461 | `const ownClientId = doc.clientID` in `insertAttributes` | struct-creation-time | `doc = transaction.doc` |
| 6496 | `const ownClientId = doc.clientID` in `insertText` | struct-creation-time | `doc = transaction.doc` |
| 6525 | `const ownClientId = doc.clientID` in `formatText` | struct-creation-time | `doc = transaction.doc` |
| 9671 | `const ownClientID = doc.clientID` in `redoItem` | struct-creation-time | `doc = transaction.doc`; `Y.UndoManager` redo. Not on our write path — this server's undo is log-derived (`server/undo/inverse.js`). |
| 9887 | comment | n/a | Not code. |

The six struct-creation reads (5407–6525) plus `redoItem` all take the form
`const doc = transaction.doc; const ownClientId = doc.clientID;`. **That is
precisely the property the borrow depends on**: yjs stamps new structs with the
client id it reads off the transaction's document *at the moment of creation*,
so installing the borrowed id before `transact` and restoring it after makes
every struct the transaction creates carry the borrowed id, and nothing else.

### 1.1 The self-heal at 3379 — live-capable, never reached, and the reason FR-007 exists

`cleanupTransactions` runs **synchronously inside `transact`'s `finally`**
(`transact` at 3434 → `cleanupTransactions(transactionCleanups, 0)` at 3465), so
this line executes **inside the borrow window**. It would read the *borrowed* id
and could reassign `doc.clientID`.

It is not reached, for a structural reason: the condition is
`!transaction.local && …`, and JavaScript short-circuits `&&`. Our write is
`doc.transact(…)`, whose `local` defaults to `true` (`transact(doc, f, origin,
local = true)` at 3434), so `!transaction.local` is `false` and **`doc.clientID`
is never even evaluated**. Probe **P1** confirms `transaction.local === true`;
probe **P2** confirms no reassignment occurs across repeated local transacts
under a borrowed id.

**Consequence, recorded because it is load-bearing (analyze F4, T030a(a))**:
under 048 the shared document's transaction came from `Y.applyUpdate`, which yjs
runs as **non-local** — so yjs's own client-id self-heal *could* fire. Under 049
the transaction is **local**, so the self-heal can **never** fire for our writes.
That is the mechanical reason FR-007's manual clock re-check before reusing a
cached id is required rather than optional: a borrowed id gets no protection
from yjs's own duplicate-id repair, and caching stretches the exposure across the
process lifetime.

### 1.2 The subdocument stamp at 3402 — a genuine live read, unreachable today

```js
subdocsAdded.forEach(subdoc => { subdoc.clientID = doc.clientID; … })
```

This runs in the same cleanup block, inside the borrow window, and it reads
`doc.clientID` **live**. A subdocument added by a transaction running under a
borrow would be stamped with the **borrowed id permanently** — the borrow is
restored, the subdocument's id is not.

It is unreachable in this codebase: `subdocsAdded` is populated only when a
`Y.Doc` is integrated into a shared type as `ContentDoc`. A NUL-safe sweep of
`server/` for `new Y.Doc()` finds 17 sites, **all standalone documents** (restore
targets, import staging, sync scratch, the agent-presence session doc, read
helpers, serialization scratch); none is inserted into another document's type.
Nothing in `server/` creates a subdocument.

Because it is unenforceable by shape, it is written into the `updateDocument`
JSDoc as an explicit mutate-phase prohibition with this exact reason (FR-003,
T018a). **If a future caller ever creates a subdocument in a mutate phase, this
audit's GO verdict no longer covers it.**

---

## 2. `y-protocols@1.0.7` (T004)

| File | Line | Code | Class |
| --- | --- | --- | --- |
| `awareness.js` | 49 | `this.clientID = doc.clientID` (`Awareness` constructor) | **construction-time** |
| `awareness.js` | 26 | comment | n/a |
| `sync.js` | — | **no `clientID` reference at all** | n/a |

`awareness.js:49` is the **only** read of `doc.clientID` in the package. Every
other `clientID` reference in that file (61, 70, 95, 102–128, 170–281) reads
`this.clientID` / `awareness.clientID` — the value captured at construction — or
a client id decoded from a frame payload. The design's claim holds exactly as
stated: presence is unaffected by anything that happens to `doc.clientID` later.

Probe **P3** confirms: with an `Awareness` constructed before the borrow,
`awareness.clientID` remains the document's own id during and after a borrowed
transaction, and no awareness state is keyed by the borrowed id. This is the
classification G4b exercises directly (T018).

## 3. `y-websocket@1.5.4` (T004)

| File | Reads `doc.clientID`? | Class |
| --- | --- | --- |
| `bin/utils.js` (**the server-side module**) | **No** | n/a |
| `src/y-websocket.js` (browser provider) | Yes — 160, 201, 357, 443, 460 | not server-side on the shared doc; see below |

`bin/utils.js` is what this server uses (`server/index.js:47`,
`server/collab-bind-state.js:18`). Its only `clientID` occurrences are 113–114,
which iterate awareness client ids from an awareness update payload — not
`doc.clientID`. Its `updateHandler` (the broadcast, line 79) encodes the update
and writes to `doc.conns`; it does **not** read the document's client id.

`src/y-websocket.js` **is** loaded in the server process — `server/mcp/agent-presence.js:9`
requires `WebsocketProvider` — but it is constructed at `agent-presence.js:526`
over **its own `new Y.Doc()`** created at line 523. Its `doc.clientID` reads are
therefore against a separate agent-session document that this feature never
borrows on. The shared `WSSharedDoc` never has a `WebsocketProvider` attached
server-side.

## 4. Doc-level listeners this server attaches at runtime (T005)

Enumerated from the wiring, not from a grep. For each: does it read a document's
client id, and can it re-enter yjs?

| # | Listener | Site | Runs in window? | Reads client id? |
| --- | --- | --- | --- | --- |
| 1 | `bindState` persistence listener | `server/collab-bind-state.js:267` | **Yes** | **No** — NUL-safe `grep -an clientID` on the file returns zero matches |
| 2 | y-websocket broadcast `updateHandler` | `y-websocket/bin/utils.js:79` | **Yes** | **No** (§3) |
| 3 | Redis fan-out `redisUpdateHandler` | `server/index.js:2224` | **Yes** | **No** — reads `origin` via `shouldPublishToRedis`, then publishes bytes |
| 4 | origin-scoped capture in `updateDocument` | `server/document-service.js:257` | **Yes** | **No** — compares `origin` by object identity |
| 5 | import-presence `observeDeep` | `server/import-presence.js:404` | **Yes** (type observers fire in cleanup) | **No** — zero `clientID` matches in the file |
| 6 | Redis awareness handler | `server/index.js:2223` | awareness only | reads awareness ids, not `doc.clientID` |
| 7 | 044 awareness ownership guard | `server/ws-awareness-guard.js:657` | awareness only | reads awareness ids from frame payloads, not `doc.clientID` |
| 8 | undo inverse scratch listener | `server/undo/inverse.js:149` | on a **scratch** doc | n/a — never the shared doc |
| 9 | `edit-range` update listener | `server/mcp/yjs/edit-range.js:46` | agent-session doc | **No** — only a comment mentions clientID |

**Re-entrancy check.** None of listeners 1–5 calls `Y.applyUpdate` on the same
document synchronously. This matters beyond the client-id question: a listener
that did so would enqueue a **non-local** transaction into the same
`transactionCleanups` loop (yjs.cjs:3417 recurses), which would re-arm the
self-heal at 3379 against the *borrowed* id — the one path by which §1.1's
short-circuit could be defeated. Listener 1 persists bytes asynchronously,
listener 3 publishes to Redis, listeners 2 and 4 encode and hand off, listener 5
only reads structure.

## 5. `server/` client-id reads — the full NUL-safe sweep (T005, T005a)

`grep -arn "\.clientID" server/ --include=*.js`, excluding tests and the
pre-built sandbox bundle, returns **exactly two** sites:

| Site | Code | Class |
| --- | --- | --- |
| `server/markdown-sync.js:1111` | `fork.clientID = syntheticClientId(…)` | not the shared doc — the documented sync-push pinned-id exception, on a **fork** doc. Untouched by 049. |
| `server/resupply-resolution.js:340` | `if (doc && Number.isFinite(doc.clientID)) noteServerDocClient(docGuid, doc.clientID)` | **live read of the shared doc — see T005a below** |

### T005a — `learnLiveServerClient`, the reader the spec's sweep missed

The spec asserted "no `.clientID` read on a document anywhere in `server/`
outside `server/mcp/sandbox/isolate-bundle.js`". **That is false.**
`learnLiveServerClient` reads `doc.clientID` off the **live shared document**
via `peekLiveDoc`. It was missed because `resupply-resolution.js` is NUL-bearing
and a plain `grep` skips it silently — the fourth instance of this repo hazard.

**Note the drift**: the reader is at **line 340**, not 339 as spec/tasks state
(`peekLiveDoc` is at 338, the read at 340). Recorded in `clarifications-needed.md` §F.

**Why it is not live inside the borrow window — two barriers, verified:**

1. **The structural barrier (decisive).** The only caller is `computeOutcomes`
   (`resupply-resolution.js:589`), and `computeOutcomes` is invoked **only**
   through `withFoldSlot` at `resolveForRows:658`:
   ```js
   const computed = await withFoldSlot(docGuid, () => computeOutcomes(reader, docGuid, [...]));
   ```
   `withFoldSlot` dispatches as `prev.then(task, task)`. A `.then()` callback
   **always** runs in a microtask, never synchronously — probe **P6**. The
   borrow window is a single synchronous frame (`doc.transact` plus its
   cleanup), which completes and restores `doc.clientID` **before any microtask
   runs**. So `learnLiveServerClient` cannot execute inside the window
   regardless of who calls `resolveForRows`.

   This barrier is worth stating first because it does not depend on the caller
   inventory being complete — a new caller added tomorrow inherits it.

2. **The caller barrier (corroborating).** Every call site of `resolveForRows`
   is `await`ed on a display/read path, none of which is reachable from a doc
   `update` event: `version-history.js` (758, 904, 1161, 1272), `api/chat.js:1021`,
   `api/docs-export.js:132`, `mcp/tools/read-document.js:156`,
   `mcp/tools/modify.js:375`, and `collab-guardrail.js:135` — the last reached
   from `collab-bind-state.js`'s strictly **post-persist** `.then()`, itself
   already past a promise boundary.

   Worth recording precisely: `learnLiveServerClient` is the **first statement**
   of `computeOutcomes`, *before* any `await`. So it does run synchronously
   relative to `computeOutcomes`' invocation — barrier 2 alone would be a thin
   argument. Barrier 1 is what actually settles it.

**Why this reader matters even though it is safe today.** If resupply resolution
ever became reachable synchronously from the update event, it would call
`noteServerDocClient` with the **borrowed** id and poison it as a shared-doc
client id. The resolver would then refuse **legitimately attributed** rows — it
would treat one identity's honest borrowed id as "belongs to a shared doc, cannot
be trusted". That is the exact opposite of what 049 is for, and it would degrade
correct attribution into "Synced content". Any future change that makes
resolution synchronous from a doc listener must revisit this entry.

---

## 6. Reproduction / probe output

Probes were run against the installed libraries from the worktree root. The
script is retained at `specs/049-constant-time-write-path/fr008-probe.cjs` and is
re-runnable with `node specs/049-constant-time-write-path/fr008-probe.cjs`
(re-run it as part of the FR-012 upgrade checklist). Output:

```
P1 update-listener saw borrowed id: true          <- the window covers the update event
P1 transaction.local: true                         <- §1.1 short-circuit holds
P1 own id restored: true
P2 local transact never triggers self-heal reassign: true
P3 awareness.clientID unaffected by borrow: true   <- construction-time confirmed
P3 no awareness state keyed by borrowed id: true
P4 insert set: [4242424]
P4 exactly one id, and it is the borrowed one: true
P4 own id absent from insert set: true
P5 state vector UNCHANGED by delete-only: true     <- PD-049-3, the detector hole
P5 update tripwire DID fire on delete-only: true   <- why the second detector exists
P6 .then() task deferred to microtask: true        <- T005a barrier 1
```

**P1 is the reproduction FR-008 asks for**: a doc-level `update` listener
observes the **borrowed** id, confirming the window is wider than the caller's
function — persistence, broadcast, Redis fan-out and the origin capture all run
inside it. Every listener in §4 was classified against that window, not against
the narrower "inside `computeMutation`" window.

## 7. Gate decision (T007)

**GO.** Zero readers are unclassified (SC-007). No reader can observe the
borrowed id in a way that changes behavior:

- the seven struct-creation reads **are** the mechanism;
- the self-heal (3379) is short-circuited by `transaction.local === true`, at the
  cost of requiring FR-007's manual re-check;
- the subdocument stamp (3402) is live but unreachable — nothing creates
  subdocuments — and is prohibited in the `updateDocument` JSDoc;
- `Awareness` captures at construction;
- `y-protocols/sync.js` and `y-websocket/bin/utils.js` never read it;
- the browser provider is bound only to agent-session documents;
- `resupply-resolution.js:340` is separated from the window by a microtask
  boundary that no caller can bypass.

Implementation of Phase 3 onward is authorized.
