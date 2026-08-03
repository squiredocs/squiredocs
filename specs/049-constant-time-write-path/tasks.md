---

description: "Task list for 049 — constant-time server-side write path"
---

# Tasks: Constant-Time Server-Side Write Path

**Input**: Design documents from `/specs/049-constant-time-write-path/`

**Prerequisites**: [plan.md](./plan.md), [spec.md](./spec.md), [research.md](./research.md), [data-model.md](./data-model.md), [contracts/](./contracts/)

**Tests**: test tasks are included and are **not optional here**. The spec makes
them requirements (FR-011 re-points named guards, FR-012 demands a loud guard,
FR-013 demands recorded measurement, SC-008 demands a deliberate-regression
check), and Constitution Principle II makes the suite the only reviewer.

**Organization**: grouped by user story. US1 and US2 are both P1 and **ship
together** — the spec is explicit that the two-phase signature "must land with
the mechanism, not after it" — but they are separated below because they deliver
different properties and fail in different ways.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: can run in parallel (different files, no dependency on incomplete work)
- **[Story]**: US1 / US2 / US3 / US4 from spec.md
- Every task names its file path.

## Path conventions

Backend-only change under `server/`. No client change, no `shared/` change, **no
database migration**. Commands run inside the Minikube `app-dev` pod; backend
tests share one DB and run **serially** (`--runInBand`).

## Standing rules for every task in this list

- **Never conclude "X is not in file Y" from a plain `grep`.** Several files here
  carry NUL bytes and are silently treated as binary (`server/markdown-sync.js`,
  `server/resupply-resolution.js` known). Use `grep -a` or read the file. This
  hazard already produced one withdrawn finding in this feature's ledger.
- Do not touch anything under `design/` (export-only, Principle VI).
- Do not touch: the bind-readiness gate, `acquireReadyDoc`'s H1 staleness
  re-acquire, the origin/`via_sync` contract, `applySyncPush`'s pinned client id
  in `server/markdown-sync.js`, restore's store-then-apply ordering.

---

## Phase 1: Setup

**Purpose**: establish the ground facts the rest of the work is checked against.

- [X] T001 Re-verify the caller inventory with `grep -an "updateDocument(" server/ __tests__/` and confirm the 7 production sites in [research.md](./research.md) §R7 are still at the stated lines; record any drift as a new note in `specs/049-constant-time-write-path/clarifications-needed.md` §F
- [X] T002 [P] Record the exact installed versions of `yjs`, `y-protocols`, `y-websocket` (read each `node_modules/<pkg>/package.json`) into `specs/049-constant-time-write-path/clientid-reader-audit.md` as its header block

---

## Phase 2: Foundational (BLOCKING) — the FR-008 verification

**Purpose**: FR-008 / DEC-049-7. Borrowing is safe only if nothing reads a
document's client id while a transaction is open. The spec's preliminary sweep is
**evidence, not discharge** — this phase re-performs it and records it.

**⚠️ STOP THE LINE**: if any reader is classified `live`, implementation halts.
Report the finding and the narrowing decision (pass the real id explicitly, or
narrow the borrow) into `clarifications-needed.md` §F before any mechanism code
is written. Do not proceed on the assumption that it is fine.

**⚠️ The window is wider than the caller's function**: yjs emits the document
`update` event from inside transaction cleanup, so persistence, the WebSocket
broadcast, the Redis fan-out handler and the origin-scoped capture all run while
the borrowed id is still installed (reproduced — see [research.md](./research.md) §R3).

- [X] T003 Enumerate every `doc.clientID` read inside `node_modules/yjs/dist/yjs.cjs` with `grep -an`, classify each as construction-time / struct-creation-time / live, and record file + line + version in `specs/049-constant-time-write-path/clientid-reader-audit.md`
- [X] T004 [P] Enumerate and classify every client-id read in `node_modules/y-protocols/` (`awareness.js`, `sync.js`) and `node_modules/y-websocket/bin/utils.js` into the same artifact, noting explicitly that `src/y-websocket.js` is the browser provider and not server code
- [X] T005 Enumerate every **doc-level listener this server attaches at runtime** — from the wiring, not from a grep: the `bindState` persistence listener (`server/collab-bind-state.js:266`), the y-websocket broadcast, the Redis fan-out handler (`server/index.js:2216`), the origin-scoped capture in `server/document-service.js`, plus everything `server/ws-awareness-guard.js`, `server/mcp/agent-presence.js`, `server/mcp/presence-claim.js` and `server/import-presence.js` attach — and record for each whether it reads a document's client id, in `specs/049-constant-time-write-path/clientid-reader-audit.md`
- [X] T005a **Classify `server/resupply-resolution.js:339` (`learnLiveServerClient`), which the spec's sweep missed**: it does read `doc.clientID` off the live shared document (found with `grep -a`; the file is NUL-bearing, which is why the plain-`grep` sweep reported none). Trace its call chain — `computeOutcomes` → `resolveForRows`, reached from version-history/export/guardrail display paths and from `collab-bind-state.js`'s **post-persist** `.then()` — and record in the audit whether any of them can execute inside the synchronous borrow window. If one can, it is a **live reader and stops the line**: it would poison a *borrowed* id as a shared-doc client id and make the resolver refuse legitimately attributed rows
- [X] T006 Complete `specs/049-constant-time-write-path/clientid-reader-audit.md`: one row per reader with path, line, package version and classification; zero readers unclassified (SC-007); include the reproduction showing that a doc-level `update` listener observes the borrowed id during transaction cleanup
- [X] T007 **GATE**: evaluate the audit. If every reader is construction-time or struct-creation-time, record the go decision in the artifact and proceed. If any is `live`, **halt and report** — do not start Phase 3

**Checkpoint**: the mechanism may now be built.

---

## Phase 3: User Story 1 — a server-side write costs the same on a 3 MB document as on an empty one (Priority: P1) 🎯 MVP

**Goal**: `updateDocument` authors on the shared document under a borrowed client
identity; the ephemeral copy, its seed and its merge-back are deleted; cost stops
tracking document size; the 048 attribution property is untouched.

**Independent test**: run a title set and a content insert against ≈80 KB, ≈800 KB
and ≈3 MB documents; per-operation time does not scale with size, and the emitted
update's insert set contains exactly one client id which is not the shared
document's own.

**Note**: the two-phase signature lands here because it is the vehicle — the
compute-phase *detection* and the atomicity properties are US2.

- [X] T008 [US1] Create `server/borrowed-identity.js` with `acquire`/`endBorrow`/`isBorrowOpen`/`_resetForTests`, per-operation mint only (no cache yet): `crypto.randomInt(0, 2**32)`, collision check against `ydoc.store.clients` and `ydoc.clientID`, bounded redraws then `BorrowMintError`, and a `BorrowReentrancyError` when a borrow is already open — per [contracts/borrowed-identity.md](./contracts/borrowed-identity.md)
- [X] T009 [US1] Add `server/__tests__/borrowed-identity.test.js` covering N2 (a mint-time collision is redrawn and no colliding id ever reaches the document) and N8 (a reentrant borrow is refused loudly), driving the module directly with local `Y.Doc`s
- [X] T010 [US1] Rewrite `updateDocument` in `server/document-service.js` to the two-phase shape per [contracts/document-service.md](./contracts/document-service.md): compute phase → nullish short-circuit → origin-scoped capture → `acquire` → install `ydoc.clientID` → one `ydoc.transact(() => mutate(ydoc), origin)` → restore in `finally` on every path; **delete** the ephemeral `Y.Doc`, the seed, the merge-back and the attach-after-seed capture listener (FR-009). Leave `acquireReadyDoc`, `waitForDocReady`, the `setImmediate` turn and the post-write `BindFailedError` check untouched
- [X] T011 [US1] Correct the falsified 048 contract text in `server/document-service.js` (FR-014): the module header L8-29 ("It does NOT transact on the shared doc…"), the `getSharedDoc` warning L66-69, and the inline 048 block in `updateDocument` — each must state the borrowed-identity mechanism and why it preserves the same guarantee
- [X] T012 [US1] Migrate `createSeededDocument` in `server/document-service.js` (~L383) to `() => (ydoc) => { … }`, one transaction, meta title + seed nodes, behavior unchanged
- [X] T013 [US1] Migrate `server/markdown-import.js` (~L321): collapse the pre-transaction XPath resolution and the in-transaction re-resolution (L332-341) into **one compute-phase resolution** that throws `ImportError('XPATH_NO_MATCH')` from compute and returns the mutate closure carrying the resolved index; `append` and `replace` return their closures directly, `replace` keeping its block-level deletes/inserts against the same fragment (E-049-A, Principle IV)
- [X] T014 [P] [US1] Migrate both call sites in `server/api/chat-tools.js` (~L60 image insert, ~L108 empty-import anchor); the `frag.length === 0` guard stays inside the mutate phase
- [X] T015 [P] [US1] Migrate the empty-import anchor in `server/api/docs-import.js` (~L341)
- [X] T016 [P] [US1] Migrate the empty-import anchor in `server/mcp/tools/create-document.js` (~L197)
- [X] T017 [P] [US1] Migrate the title set in `server/mcp/tools/set-document-title.js` (~L79); permission checks stay where they are, before the call
- [X] T018 [US1] Re-point **G4** and **G4b** in place in `server/__tests__/per-operation-doc.test.js` per [contracts/invariant-guards.md](./contracts/invariant-guards.md), keeping their identifiers and position, each with a comment recording what it used to assert and why: G4 → the mutate phase receives the shared document, its writes are visible immediately, and the emitted update still carries only the borrowed id; G4b → the borrowed identity is never announced in awareness (construct a `y-protocols` `Awareness` on the doc before the call) and the document's own `clientID` is restored
- [X] T018a [US1] Write the mutate-phase prohibitions into the `updateDocument` JSDoc in `server/document-service.js` so the signature itself carries them (FR-003): must not throw, be async or await, perform I/O, read `doc.clientID`, construct anything capturing the document's client id (notably an `Awareness`), create subdocuments, or re-enter `updateDocument` — with the one-line reason for each (a subdocument added during a borrow is stamped with the borrowed id **permanently**)
- [X] T018b [US1] Extend **G6** in `server/__tests__/per-operation-doc.test.js` to the second no-change path introduced by 049: a compute phase returning nullish must also produce the zero value, write no row, open no transaction, install no borrow, leak no listener — and still run the post-write `BindFailedError` check
- [X] T019 [US1] Add pin **N1** to `server/__tests__/per-operation-doc.test.js`: the document's own `clientID` is restored after every call — success, no-change, compute-phase throw, mutate-phase throw, and `BindFailedError`
- [X] T020 [P] [US1] Migrate `server/__tests__/document-service-capture.test.js` (15 calls) to the two-phase shape; assertions must not change, and the throwing case becomes a throwing **compute** phase still asserting the original error object propagates
- [X] T021 [P] [US1] Migrate `server/__tests__/bindstate-failure.test.js` to the two-phase shape; assertions unchanged
- [X] T022 [P] [US1] Migrate `server/__tests__/live-fanout.test.js` and `server/__tests__/resupply-resolution.test.js` to the two-phase shape; assertions unchanged
- [X] T023 [P] [US1] Migrate `server/mcp/__tests__/tools/restore-document-version.test.js`, `server/mcp/__tests__/tools/read-document-version.test.js` and `server/mcp/__tests__/integration/undo-redo-workflow.test.js` to the two-phase shape; assertions unchanged
- [X] T024 [US1] Add `server/__tests__/borrowed-identity-performance.test.js` (pin **N11**): hermetic, driven through `documentService.init` with local `Y.Doc`s at ≈80 KB / ≈800 KB / ≈3 MB, asserting the **shape** with a contention-tolerant ratio ceiling and `console.log`ging the real per-operation numbers — following the `server/__tests__/import-performance.test.js` precedent
- [X] T025 [US1] Record the measured numbers in `specs/049-constant-time-write-path/performance.md` alongside the design's reference table (FR-013, SC-001)

**Checkpoint**: US1 is independently shippable — borrowed identity, constant
time, attribution unchanged, guards green.

---

## Phase 4: User Story 2 — a failed write cannot leave half an edit behind (Priority: P1)

**Goal**: everything that can fail happens before anything is touched, and a
compute phase that mutates anyway is impossible to ship unnoticed.

**Independent test**: call the write path with a compute phase that throws and
assert the document is byte-identical, no row is stored, nothing is broadcast, no
listener is left armed, and the error propagates unchanged.

- [X] T026 [US2] Add the compute-phase detectors to `updateDocument` in `server/document-service.js` (FR-004): sample `Y.encodeStateVector(ydoc)` **and** arm an `update`-event tripwire for the duration of the compute phase, disarm both in a `finally`, and throw a named `ComputePhaseMutationError` identifying the document and the acting identity if either fires. **Enabled in production**, not test-only (PD-049-3)
- [X] T027 [US2] Make a mutate-phase throw log loudly by name (mechanism + document + identity) and rethrow the **original** error object unchanged in `server/document-service.js` (PD-049-4) — error identity is part of the caller contract (`ImportError.code` drives HTTP status)
- [X] T028 [US2] Re-point **G5** in place in `server/__tests__/per-operation-doc.test.js` to the compute phase: encoded state **and** state vector byte-identical, zero rows, zero update events, zero leaked listeners, the document's own `clientID` restored, and the original error propagated
- [X] T029 [US2] Add pin **N6** to `server/__tests__/per-operation-doc.test.js`: a compute phase that **inserts** is detected and fails loudly, naming the document and identity
- [X] T030 [US2] Add pin **N7** to `server/__tests__/per-operation-doc.test.js`: a compute phase that **only deletes** is detected too — the state-vector detector alone does not see this (a delete adds no struct to `store.clients`), the update tripwire does (PD-049-3)
- [X] T030a [US2] Verify the two semantic side effects of transacting on the shared document instead of merging into it, and record the result in `specs/049-constant-time-write-path/performance.md` (or the audit): (a) the transaction is now **local** (`doc.transact`) where 048's merge-back was **non-local** (`Y.applyUpdate`) — confirmed with `grep -a` that nothing in `server/` branches on `transaction.local`, but this is also why yjs's own client-id self-heal can never fire for us and FR-007's manual re-check is required; (b) `server/import-presence.js`'s origin-filtered `observeDeep` (L404) now receives events from a local mutation rather than from an applied update — run `server/__tests__/import-presence.test.js` and confirm unchanged behavior
- [X] T031 [US2] Pin the migrated import behavior in the existing import tests (`server/__tests__/api-docs-import.test.js` / `chat-import-markdown.test.js` as applicable): an `insertAfterXPath` with no match still returns the same error code and message and leaves the document byte-unchanged, and a matching target still inserts immediately after it (US2 AS4 — compute resolves against the state mutate runs on)

**Checkpoint**: the atomicity property 048 got for free is restored by shape.

---

## Phase 5: User Story 3 — a document's sync handshake stops growing with how often it is edited (Priority: P2)

**Goal**: the borrowed identity is cached per `(identity, document)` in the
process, so state-vector growth tracks principals rather than operations — with
the clock always read from the document's own store and re-checked before reuse.

**Independent test**: N writes by one identity introduce exactly one client
entry; N writes by N identities introduce N; a cached id another writer advanced
is discarded and re-minted.

- [X] T032 [US3] Add the identity cache to `server/borrowed-identity.js`: `WeakMap<Y.Doc, { open, entries: Map<identityKey, { clientId, clock }> }>` with `identityKey = JSON.stringify([userId, agentName])` (nulls literal, RBD-049-3), oldest-first eviction above `MAX_IDENTITIES_PER_DOC` (64), and `endBorrow` recording `Y.getState(ydoc.store, clientId)` — per [contracts/borrowed-identity.md](./contracts/borrowed-identity.md)
- [X] T033 [US3] Implement the FR-007 reuse check in `server/borrowed-identity.js`: before reusing a cached id, compare `Y.getState(ydoc.store, entry.clientId)` against the clock this process left it at, and discard + re-mint on mismatch (also discard if the document's own id has become that id). Comment why this, and not `store.clients.has()`, is the right check at reuse time
- [X] T034 [P] [US3] Add unit pins **N3** (a cached id another writer advanced is discarded, and no `(clientId, clock)` pair is ever duplicated), **N5** (consecutive borrows by one identity produce strictly increasing clocks, no gap, no replay) and **N10** (eviction is harmless: the next write succeeds with a fresh id and correct attribution) to `server/__tests__/borrowed-identity.test.js`
- [X] T035 [US3] Re-point **G3** in place in `server/__tests__/per-operation-doc.test.js`: two calls by **different** identities use different ids, two calls by the **same** identity reuse one, and no id is ever shared by two identities — asserted directly by mapping every observed id to the identity that used it and checking the map is one-to-one
- [X] T036 [US3] Add pin **N4** to `server/__tests__/per-operation-doc.test.js`: N consecutive writes by one identity introduce exactly **1** new client entry into the state vector and all N updates carry that one id; N identities introduce N (SC-005)

**Checkpoint**: the handshake cost tracks principals per process generation.

---

## Phase 6: User Story 4 — the mechanism cannot break quietly, including across a library upgrade (Priority: P2)

**Goal**: a silent regression in yjs's struct signing, or a failure to restore
the document's own id, fails a **named** test; and the next upgrader finds the
obligation without reading this spec.

**Independent test**: deliberately break struct signing and deliberately break
restoration; a named guard must fail each time, with a message that names the
mechanism.

- [X] T037 [US4] Write the yjs-upgrade caveat as a comment at the `doc.clientID` assignment site in `server/borrowed-identity.js` (FR-012): public field, unsupported reassignment, works because yjs reads it at struct-creation time from the transaction's document, re-run the FR-008 verification and re-date `clientid-reader-audit.md` before any version bump, and G1/G2 are the load-bearing regression detectors
- [X] T038 [US4] Add pin **N9** to `server/__tests__/per-operation-doc.test.js`: a single named guard that fails **by name** if the structs a transaction creates stop carrying the installed id, or if the document's own id stops being restorable, with a failure message naming the borrowed-identity mechanism rather than an unrelated downstream assertion
- [X] T039 [US4] Run the SC-008 deliberate-regression check by hand per [quickstart.md](./quickstart.md) §2 (skip the install; skip the restore), confirm G1/N1/N9 fail by name each time, revert both breakages, and record that the check was **run** (which guard failed, with its message) under a "Deliberate-regression check (SC-008)" heading in `specs/049-constant-time-write-path/performance.md` — not that it was expected to pass
- [~] T040 [US4] **NOT APPLIED — OWED TO MERGE QUEUE** (implement brief reserves `docs/dev.md`; ready-to-paste text in `promotion-notes.md` §5). Add an "Upgrading yjs / y-protocols / y-websocket" checklist to `docs/dev.md` requiring the FR-008 verification to be re-run and `specs/049-constant-time-write-path/clientid-reader-audit.md` re-dated before the bump merges (FR-012, Principle I)

**Checkpoint**: the mechanism's one unsupported assumption is guarded and
documented where an upgrader will trip over it.

---

## Phase 7: Polish & cross-cutting

- [X] T041 [P] Correct the feature-048 attribution comment in `server/version-history.js` (~L1046-1052): restore still computes on its own document for **ordering** reasons, and the claim that every other server-side write is authored under a one-shot client id is superseded by the borrowed identity (FR-014). Do not change restore's behavior or its store-then-apply ordering
- [X] T042 Confirm FR-010's untouched list by inspection and by the suite: `waitForDocReady` + `acquireReadyDoc` (H class green, unchanged), origin object + origin-scoped capture with the emit-time `hadRedisHandler` sample, post-write `BindFailedError`, `via_sync` unset, `applySyncPush`'s pinned client id in `server/markdown-sync.js` (check with `grep -a`, L279 / L1063 / L1111), undo/redo inverse identity predicates, restore's own document, presence announcement wrappers
- [X] T043 Run the full backend suite serially inside the pod (`npx jest --runInBand`) and confirm zero assertion changes were needed in any migrated test file; any test that had to change to pass is a behavior regression — report it rather than accommodating it
- [X] T044 Word the performance claim honestly in `specs/049-constant-time-write-path/performance.md`: 049 makes **`updateDocument` itself** constant time. The persistence listener still runs `classifyByXml` (`server/update-classifier.js`, O(document size) per applied update, skipped above a 500 KB ceiling), which is unchanged by this feature but means the end-to-end server-side write is not constant time for documents under that ceiling. State it rather than rounding up (FR-013, SC-001)
- [X] T045 Carry FR-015's non-claim into the merge/promotion note for this feature: 049 does not fix M3, M4, the RBD-045-5 durability window, cross-pod restore serialization (RBD-041-2) or undo supersession, and the one-replica deploy constraint stands
- [X] T046 Finalize `specs/049-constant-time-write-path/clarifications-needed.md` §F: confirm PD-049-1..4 as implemented, add any new plan-vs-code drift found during implementation, and restate what is owed to Sam (the D-049-A design-sentence amendment in the Squire doc, the manual walk in [quickstart.md](./quickstart.md) §7)

---

## Dependencies

```text
Phase 1 (T001-T002)
      ↓
Phase 2 — FR-008 VERIFICATION GATE (T003-T007)   ← stop-the-line; nothing below starts until T007 passes
      ↓
Phase 3 — US1 (T008-T025)                        ← MVP
      ↓
Phase 4 — US2 (T026-T031)                        ← ships WITH US1 (spec: the signature must land with the mechanism)
      ↓
Phase 5 — US3 (T032-T036)                        ← separable; US1+US2 are correct and shippable without it
      ↓
Phase 6 — US4 (T037-T040)                        ← needs the mechanism to exist to guard it
      ↓
Phase 7 — Polish (T041-T046)
```

**Hard sequences inside phases**

- T008 → T010 (`updateDocument` calls `acquire`).
- T010 → T011 → T012 (same file, `server/document-service.js`; keep the diff readable).
- T010 → T013..T017 (call sites cannot migrate before the signature exists).
- T010 → T020..T023 (the eight test files fail until the signature exists; they must all land in the same change or the suite fails wholesale).
- T026 → T029/T030 (detectors before their pins).
- T032 → T033 → T034/T035/T036 (cache before the clock re-check before its pins).
- T037/T038 → T039 (the guard must exist before you try to break it).

**Parallel opportunities**

- T004 with T005 (different sources).
- T014, T015, T016, T017 — four different call-site files, no shared state.
- T020, T021, T022, T023 — four independent test-file migrations.
- T034 with T035/T036 (module unit file vs the guard file).
- T041 with T042.

## Independent test criteria

| Story | Independently true when |
| --- | --- |
| **US1** | a title set and a content insert on ≈80 KB / ≈800 KB / ≈3 MB documents cost the same order of time, and each emitted update's insert set is exactly one id that is not the document's own |
| **US2** | a throwing compute phase leaves encoded state and state vector byte-identical, writes no row, emits no event, leaks no listener, and propagates the original error; a mutating compute phase fails loudly |
| **US3** | 1,000 writes by one identity add exactly one client entry to the state vector; two identities never share an id; a cached id another writer advanced is re-minted |
| **US4** | breaking struct signing or breaking restoration each makes a named guard fail with a message naming the mechanism; the upgrade checklist exists in `docs/dev.md` |

## Implementation strategy

**MVP** = Phase 2 + Phase 3 + Phase 4 (US1 and US2 together). That is the
ratified mechanism with its atomicity property intact and every guard re-pointed;
it is correct and shippable without the cache.

**Increment 2** = Phase 5 (US3), the cached identity — the second half of the
ratified amendment, separable by design.

**Increment 3** = Phase 6 + 7 (US4 and polish), the anti-silent-regression work
and the documentation obligations.

Do not reorder Phase 2 later. It gates the others because a live reader changes
*what gets built*, not just whether it works.
