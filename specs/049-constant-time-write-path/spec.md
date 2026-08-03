# Feature Specification: Constant-Time Server-Side Write Path

**Feature Branch**: `049-constant-time-write-path` (spec authored in parallel on `main`; no branch created)

**Created**: 2026-08-03

**Status**: Draft

**Input**: Replace feature 048's ephemeral per-operation `Y.Doc` with a **borrowed client identity** on the shared document, adopt **two-phase (compute / mutate) writes**, and cache the borrowed identity **per (identity, document)** within a process.

**Design ground truth**: `design/collaboration-core.md`, section **"Per-identity server docs"** — specifically the closing **"Amendment (2026-08-03) — the constant-time write path (feature 049)"** and everything after it (the measured table, the RATIFIED two-phase option list, "Why (1), and what it leaves open", "The one open verification", and "Honest note on library support"). Committed at `7e04914c`. Per Constitution Principle VI the design doc wins over this spec, over code, and over any model prior; contradictions found in code are recorded in `clarifications-needed.md`, never resolved silently.

---

## The problem (from the design contract)

Feature 048 shipped and it is **correct**: every server-side content operation now carries a Yjs client id that belongs to exactly one `(user, agent)` identity, so the resupply resolver can never confidently name the wrong author, on any pod, at any replica count.

It buys that correctness at a price proportional to the document. `documentService.updateDocument` serializes the entire shared document, deserializes it into a throwaway `Y.Doc`, runs the caller's operation there, and merges the resulting bytes back. Every server-side write — including a title set, which is one map assignment — pays O(document size). Measured on the repo's own yjs:

| Document | Ephemeral copy | Borrowed identity | Speedup |
| --- | --- | --- | --- |
| 79 KB | 15.6 ms | 0.16 ms | 97x |
| 794 KB | 56.4 ms | 0.06 ms | 918x |
| 3.2 MB | 211.8 ms | 0.17 ms | 1224x |

The point is not the multiplier, it is the **shape**: the borrowed path stops tracking document size at all.

The property 048 actually needs is narrower than the copy. All that is required is that an operation's content ops carry a client id belonging to exactly one identity — **not** that they were computed somewhere else. So: before the transaction, assign the shared document a fresh collision-checked random client id; run the caller's mutation inside one transaction **on the shared document**; restore the original id in a `finally`. No copy, no seed, no merge-back.

Two consequences follow, and both are in scope here.

1. **Atomicity.** The copy gave failure isolation for free — a throwing update function discarded the copy and left the shared document byte-identical (048 FR-006). Borrowing does not: yjs does **not** roll back a transaction whose function throws. Testing confirmed a function that mutates and then throws leaves the mutation in place **and** fires the document update event, so a half-written edit reaches broadcast, persistence, and the Redis fan-out. Sam ratified option (1), **two-phase writes**: a compute phase that may throw but must not touch the document, and a mutate phase that mutates and must not throw. The failure stops being something to handle and becomes something that cannot be expressed.

2. **State-vector growth.** 048 mints a client id per **operation**, so a document's state vector grows without bound and is pushed to every browser on every handshake. Measured: 5,000 writes on a near-empty document ended at 27 ms per write and left a 30 KB state vector. Caching the borrowed identity per `(identity, document)` inside a process makes growth track **how many principals have edited the document** rather than how many times.

---

## User Scenarios & Testing *(mandatory)*

### User Story 1 - A server-side write costs the same on a 3 MB document as on an empty one (Priority: P1)

An agent sets the title of a large document, or the chat assistant drops an image into it, or a user imports markdown into it. Today each of those pays for the whole document before it does its one small thing, and the cost grows as the document grows — exactly as the document becomes more valuable and more actively collaborated on. After this feature the cost is flat and sub-millisecond, and the attribution guarantee 048 bought is unchanged: the row still names exactly the person or agent that acted, and every pod still agrees.

**Why this priority**: it is the feature. The attribution property is already shipped and must survive untouched; the cost is what 049 removes.

**Independent Test**: run a title set and a content insert against documents of ~80 KB, ~800 KB, and ~3 MB, measuring wall time per operation; assert the time does not scale with document size and that the emitted update's insert set contains exactly one client id which is **not** the shared document's own.

**Acceptance Scenarios**:

1. **Given** a loaded 3 MB document, **When** an agent sets its title, **Then** the operation completes in the same order of time as the same operation on an empty document, the title is set, one durable row is stored stamped with the acting identity, and connected browsers receive the change.
2. **Given** any converged write path, **When** the operation completes, **Then** the emitted update's insert set contains only the borrowed client id and never the shared document's own id.
3. **Given** any converged write path, **When** the operation completes — successfully, or with the compute phase throwing — **Then** the shared document's own `clientID` is exactly what it was before the call.
4. **Given** a document already carrying a title, **When** a title set runs through the borrowed path, **Then** the new title wins deterministically (the write is causally after the state it replaces), never by client-id coin flip.
5. **Given** a peer that applies the emitted bytes, **When** it does, **Then** it converges to the same document state as the writer.

---

### User Story 2 - A failed write cannot leave half an edit behind (Priority: P1)

An import re-resolves its target inside the write and finds the target gone; a caller's validation fails late. Today (048) the throwaway copy absorbs that and the shared document is untouched. Under borrowing, the same code would leave a partial mutation applied, broadcast to every open browser, persisted as a durable row, and fanned out cross-pod — a fragment of an edit that nobody asked for and that undo now has to reason about. Two-phase writes make that shape unavailable: everything that can fail happens before anything is touched.

**Why this priority**: it is the one property 049 would otherwise regress, it is ratified, and it changes the signature every caller uses — so it must land with the mechanism, not after it.

**Independent Test**: call the write path with a compute phase that throws and assert the document is byte-identical, no row is stored, nothing is broadcast, and the error propagates to the caller unchanged.

**Acceptance Scenarios**:

1. **Given** a write whose compute phase throws, **When** the call is made, **Then** the shared document's encoded state and state vector are byte-identical to before, no durable row is written, no update event fires, no listener is left armed, and the caller receives the original error.
2. **Given** a write whose compute phase attempts to mutate the document, **When** the call is made, **Then** the violation is detected and surfaced loudly rather than silently tolerated.
3. **Given** each of the converged call sites, **When** its logic is expressed in the two-phase shape, **Then** its observable behavior — content placement, attribution, error codes and messages, undo behavior, presence behavior — is unchanged.
4. **Given** the markdown import's target re-resolution (which today runs **inside** the transaction so it sees current state), **When** it moves to the compute phase, **Then** it still resolves against the same document state the mutation will run on, because compute and mutate run back to back with no awaits between them.

---

### User Story 3 - A document's sync handshake stops growing with how often it is edited (Priority: P2)

Every browser that opens a document exchanges its state vector on every handshake. Under 048 that vector gains an entry per server-side operation, forever — 30 KB after 5,000 writes on an otherwise empty document, and it never shrinks. Caching the borrowed identity per `(identity, document)` inside a process makes the vector track the number of distinct principals that have written to the document, which is the number a reader would expect.

**Why this priority**: separable from US1 and US2 (they are correct and shippable without it), but it is the difference between fixing the write's cost and fixing the document's cost. It is the second half of the ratified amendment.

**Independent Test**: perform N writes by one identity on one document and assert the number of distinct client ids introduced is 1 (not N), while N writes by N distinct identities introduce N ids; assert the state vector's growth tracks principals, not operations.

**Acceptance Scenarios**:

1. **Given** 1,000 consecutive writes by the same identity on the same document in one process, **When** they complete, **Then** the document's state vector has grown by exactly one client entry and every one of the 1,000 emitted updates carries that same single id.
2. **Given** two distinct identities writing to the same document, **When** both complete, **Then** their updates carry **different** client ids, and no client id is ever shared by two identities.
3. **Given** a document that is unloaded and later reloaded, **When** the same identity writes again through a cached id, **Then** the write continues from the clock recorded in the document's own store and no `(client id, clock)` pair is ever minted twice.
4. **Given** two processes writing to the same document, **When** both borrow, **Then** they draw from independent random pools and a collision is detected and healed rather than silently corrupting the document.
5. **Given** long-running processes and many documents, **When** the cache fills, **Then** its memory is bounded and eviction is harmless (an evicted entry simply mints a new id).

---

### User Story 4 - The mechanism cannot break quietly, including across a library upgrade (Priority: P2)

Reassigning `doc.clientID` is reading a public field in a way the library does not promise to support. It works because of *how* yjs happens to consume that field — at struct-creation time, from the document — not because of a contract. Two obligations follow: the current library versions must be **verified**, not assumed, to have no live reader of that field during an open transaction; and a future version bump must re-run that verification before it merges, backed by tests that fail loudly rather than degrade silently.

**Why this priority**: this is the "stop the line" gate. A live reader of the client id mid-transaction would make the whole mechanism unsafe, and this area (presence, awareness, sync) has already produced findings from exactly this class of assumption.

**Independent Test**: enumerate every code path — application, y-websocket, y-protocols, yjs itself — that reads a document's `clientID`, classify each as construction-time / struct-creation-time / live, and record the enumeration as a durable artifact with the exact library versions it was performed against.

**Acceptance Scenarios**:

1. **Given** the verification is performed, **When** it finds any path that reads the document's client id **live** while a transaction may be open, **Then** the finding stops the feature: the mechanism is narrowed, or that path is given the real id explicitly, before implementation continues.
2. **Given** the verification is performed, **When** it finds no such path, **Then** the enumeration, the versions it was checked against, and the specific line references are recorded in the feature's artifacts so the next upgrade has a checklist rather than a memory.
3. **Given** a future upgrade to yjs, y-protocols, or y-websocket, **When** it is proposed, **Then** the upgrade checklist requires re-running the verification before merge.
4. **Given** a library change that stops the borrowed id from signing the structs, **When** the test suite runs, **Then** a guard test fails with a message that names the mechanism — not an unrelated assertion failing somewhere downstream.

---

### Edge Cases

- **A collision at mint time**: the drawn id already appears in the document's own client store. It MUST be rejected and redrawn, bounded, before it is ever installed.
- **A collision discovered later**: another process (or a browser) writes under the same id a cached entry is using. Detection and re-mint are required; a cached id that another writer has advanced MUST NOT be reused. See FR-007.
- **A write whose mutate phase makes no change**: no update event fires, the zero value is returned, no row is written, no listener leaks, and the borrowed id is still restored.
- **A write whose mutate phase throws anyway** (a caller working around the shape): the partial mutation is broadcast, persisted, and undoable. This is the recorded residual of the ratified option, and it is a deliberate act rather than an easy accident.
- **A bind refused between the readiness gate and the write**: unchanged from 048 — the post-write bind check still fails the call rather than resolving as success for content that exists nowhere.
- **A document torn down while the readiness gate awaits**: unchanged from 048's review fix (H1) — the doc is re-acquired before the caller's function runs.
- **A restore**: keeps its own separate document, because that document exists to make restore store-then-apply — an ordering decision, not an identity one.
- **A sync push**: keeps its pinned deterministic client id, because idempotent retries need byte-identical updates. Explicitly outside the borrow.
- **Reentrancy**: a write initiated from inside another write's mutate phase would nest borrows on one document. It MUST be prevented or detected, not left to chance.
- **Subdocuments created during a borrow**: yjs assigns a newly added subdocument the parent's *current* `clientID`, which during a borrow is the borrowed one — permanently. No current path creates subdocuments; the mutate-phase contract MUST forbid it so a future one cannot.

---

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001 (mechanism — borrow, do not copy)**: `documentService.updateDocument` MUST remain the single implementation point for server-side content operations, and MUST author them **on the shared document** under a borrowed client identity. The sequence is: obtain a client id for this `(identity, document)` (FR-006), verify it does not collide with any id already present in the document's own client store, install it as the document's client id, run the caller's mutate phase inside **one** transaction on the shared document with the caller's origin object, and restore the document's original client id in a `finally` that runs on **every** path — success, no-change, and throw. No copy of the document is made, no seed is applied, and no merge-back occurs.

- **FR-002 (collision check is mandatory, and it is not optional at reuse)**: an id MUST NOT be installed without first checking it against the document's own client store. A fresh draw that collides MUST be redrawn (bounded attempts, then fail the call rather than install a colliding id). The check MUST also run when a **cached** id is reused (FR-007).

- **FR-003 (two-phase writes — a first-class signature change)**: `updateDocument` MUST take the caller's work as **two phases**:
  - a **compute phase** that MAY throw and MUST NOT touch the document; and
  - a **mutate phase** that mutates the document and MUST NOT throw.

  The compute phase runs **before** the borrow is installed and before the transaction opens. The mutate phase runs inside the transaction. The two run back to back with no awaits between them, so the mutate phase sees exactly the state the compute phase resolved against.

  The mutate phase **MAY**: read the document, and mutate it through targeted Yjs operations against the existing tree (Constitution Principle IV — never delete-and-recreate wholesale, never positional targeting where structural targeting exists).

  The mutate phase **MUST NOT**: throw; be asynchronous or await; perform I/O; read the document's `clientID` (during the mutate phase it holds the borrowed id, not the document's own); construct anything that captures the document's client id (notably an awareness instance); create subdocuments; or re-enter `updateDocument`.

  The signature MUST carry this requirement — a future caller has to work around the shape rather than merely not read a comment.

- **FR-004 (compute-phase mutation is detected, not tolerated)**: a compute phase that mutates the document MUST be detected and surfaced loudly. Detection MUST be constant-time (it MUST NOT reintroduce a cost proportional to document size) and MUST be active in the test suite at minimum. Detection after the fact is acceptable — the goal is that the violation is impossible to ship unnoticed, not that it is impossible to write.

- **FR-005 (caller migration — the full inventory, verified against code)**: every current caller MUST be migrated to the two-phase shape with **no** change in observable behavior. The inventory, verified against the codebase on 2026-08-03 (the design doc's table describes the write *paths*; these are the call *sites*):
  - `server/markdown-import.js` (~L321) — the one-transaction import write (REST PUT import, MCP `create_document` body, chat `import_markdown`). **Note**: this caller today performs its `insertAfterXPath` re-resolution *inside* the transaction and throws from there on no match. That work moves to the compute phase; the pre-existing pre-transaction resolution and the in-transaction re-resolution collapse into one compute-phase resolution.
  - `server/api/chat-tools.js` (~L60) — the chat image insert.
  - `server/api/chat-tools.js` (~L108) — the empty-import anchor paragraph (chat import path).
  - `server/api/docs-import.js` (~L341) — the empty-import anchor paragraph (REST import path).
  - `server/mcp/tools/create-document.js` (~L197) — the empty-import anchor paragraph (MCP create path).
  - `server/mcp/tools/set-document-title.js` (~L79) — the MCP title set.
  - `server/document-service.js` `createSeededDocument` (~L383) — the document seed (meta title + seed nodes), reached by MCP create, chat import, REST create, and `server/onboarding.js` (~L50) for the welcome document.

  These are the only callers. `server/version-history.js` restore keeps its own document (FR-009).

- **FR-006 (per-(identity, document) identity cache)**: a borrowed client id MUST be cached per `(identity, document)` within the process, where identity is the exact `(userId, agentName)` tuple the write is attributed with. Consequences that MUST hold:
  - A client id still maps to exactly **one** identity. Many ids mapping to one identity remains fine; one id mapping to two identities is the defect 048 ended and MUST stay ended.
  - Repeated writes by one identity on one document introduce **one** client entry, not one per operation, so state-vector growth tracks principals rather than operations.
  - The clock MUST come from the **document's own store**, so a cached id resumes at the correct clock after an unload/reload and never replays a clock it has already used.
  - Ids MUST be drawn at random **per process**, so two processes cannot deterministically collide on one.
  - The cache MUST be bounded and evictable, and eviction MUST be harmless: an evicted entry simply mints a new id on the next write. Cache entries for a document MUST NOT outlive the document's presence in the process (a cache keyed by document that never releases is the memory-leak shape this area has already been burned by twice).

- **FR-007 (cached-id collision detection — a required analogue of yjs's own self-heal)**: yjs regenerates a document's `clientID` when a **remote** transaction advances the clock of the id the document is using — its own protection against a client-id collision. A cached borrowed id gets **no** such protection, because it is not the document's client id at rest, and the cache extends the exposure from one operation to the process's lifetime. Therefore: before reusing a cached id, the implementation MUST establish that no other writer has advanced that id in this document since this process last used it (for example, by comparing the clock this process left the id at against the clock the document's store now reports). On a mismatch the cached id MUST be discarded and a new one minted. This requirement corrects the design's "no better and no worse [than yjs's own residual]" sentence, which holds for the mint-time draw but not for reuse; the correction is recorded in `clarifications-needed.md` as a design-doc gap.

- **FR-008 (BLOCKING — the one open verification)**: borrowing is safe only if **nothing else reads the document's client id while a transaction is open**, because for that window the field holds the borrowed id rather than the document's real one. The window is wider than it looks: yjs fires the document `update` event from inside transaction cleanup, so the persistence listener, the WebSocket broadcast, the Redis fan-out handler, and the origin-scoped capture all run **before** the `finally` restores the id.

  Before implementation proceeds, the implementer MUST enumerate and classify every reader of a document's client id, and record the result — with library versions and line references — as a durable artifact in this feature's directory.

  - **Already settled** (per the design doc, re-confirmed during spec authoring): `y-protocols` `Awareness` captures the client id **at construction** and keeps it for the life of the connection, so presence is unaffected by anything that happens to the field later. It follows that no awareness instance may be constructed while a borrow is open (FR-003).
  - **Still owed**: `y-websocket`'s sync and broadcast paths, and any document-level listener that can run mid-transaction (including this repo's own persistence, broadcast, fan-out, and capture listeners, and anything the presence and awareness-guard machinery attaches).

  **If any path reads the field live, that is a stop-the-line finding**: the feature does not proceed on the assumption that it is fine. The remedy is either passing the real id to that path explicitly or narrowing the borrow, and the choice MUST be recorded before implementation resumes.

- **FR-009 (what this feature deletes)**: the following MUST be removed, not left dormant:
  - the ephemeral `Y.Doc` in `updateDocument`;
  - the seed that applied the shared document's whole encoded state into it;
  - the merge-back through `Y.applyUpdate`;
  - the capture listener attached to the ephemeral document, and with it the **ordering subtlety** that it may be attached only *after* the seed (attached earlier, the seed itself is captured as "the operation", which is the entire document). A mechanism whose correctness depends on the order of two lines is a mechanism worth not having.

  `server/version-history.js`'s restore document is **not** in this list. It stays.

- **FR-010 (what this feature MUST NOT change)**: all of the following MUST behave exactly as they do today, and MUST be covered by the existing tests continuing to pass:
  - the **bind-readiness gate** (`waitForDocReady`) and the post-gate **staleness re-acquire** (`acquireReadyDoc`, from the 048 review's H1). These solve the load race, which is a different problem from identity and is neither helped nor hurt by this change.
  - the **origin object** and the **origin-scoped capture** (capture is scoped by object identity, not shape) — including the `hadRedisHandler` sample being taken at emit time.
  - the post-write **`BindFailedError`** check.
  - `via_sync` stays **unset** for these writes.
  - the **sync-push pinned client id** exception (`applySyncPush`), which stays for the idempotent-retry reason recorded in the design.
  - the **undo/redo inverse** scratch-document pattern (store-then-apply) and the identity predicates, which match on row stamps plus the sync-channel guard and never on client ids.
  - **restore's** own document and its **store-then-apply** ordering.
  - **presence**: the borrowed identity is never announced in awareness; the announcing wrappers stay exactly where they are; import-presence's origin-filtered observation keeps working because the transaction carries the same origin object.
  - **broadcast, persistence, and cross-pod fan-out** semantics, including the one-event-loop-turn "persistence initiated" contract callers were written against.

- **FR-011 (invariant pins, re-pointed rather than deleted)**: the 048 invariant guards in `server/__tests__/per-operation-doc.test.js` MUST keep passing, except where 049 deliberately falsifies them — in which case each MUST be **consciously re-pointed** at the property 049 provides, never weakened or dropped. Specifically:
  - **G1** (a converged write's insert set never contains the shared document's client id) — unchanged, and remains the load-bearing assertion.
  - **G3** ("two consecutive calls author under two DISTINCT one-shot clientIDs") — MUST be re-pointed. Under FR-006 two calls by the **same** identity legitimately reuse one id; the property that must hold is that two calls by **different** identities use different ids, and that no id is ever shared by two identities.
  - **G4** ("updateFn receives an EPHEMERAL doc, and its writes are invisible until the merge") — falsified by design. MUST be re-pointed to: the mutate phase receives the shared document, its writes are visible on it immediately, and the emitted update still carries only the borrowed id.
  - **G4b** ("the ephemeral doc is destroyed and never announces awareness") — MUST be re-pointed to: the borrowed identity is never announced in awareness, and the document's own client id is restored after the call, including after a throw.
  - **G5** ("a throwing updateFn leaves the shared doc byte-identical and writes no row") — MUST be re-pointed to the **compute** phase, which is where throwing now lives, and MUST additionally assert the document's own client id is restored.
  - **G2** (restore never authors under the shared document's client id) and the **H** class (bind readiness / staleness) — unchanged.
  - **C1** (anchor paragraph placement, chat image start/end position) — unchanged behavior, migrated to the two-phase shape.

  New pins required: the document's own client id is restored after every call including a throwing compute phase; a cached id resumes at the correct clock after a document reload; a collision at mint is redrawn; a cached id another writer has advanced is discarded (FR-007).

- **FR-012 (library-support caveat and the loud guard)**: reassigning the document's client id is a use of a public field that the library does not document as supported. A guard test MUST exist that fails **loudly and by name** if the mechanism stops behaving — specifically, if the structs a transaction creates stop carrying the installed id, or if the document's own id stops being restorable. The upgrade checklist for yjs / y-protocols / y-websocket MUST require re-running the FR-008 verification before a version bump merges. This obligation MUST be recorded where an upgrader will find it (the developer documentation and the code that performs the borrow), not only in this spec.

- **FR-013 (performance is a requirement, not a hope)**: the per-operation cost of a server-side write MUST NOT scale with document size. This MUST be demonstrated by measurement across at least three document sizes spanning roughly two orders of magnitude, and the measurement MUST be recorded. The previously accepted cost "each server-side operation pays O(doc size)" and the deferred "meta-only cheap path for title sets" are both retired by this feature.

- **FR-014 (correct the falsified record in code)**: per Constitution Principle VI, code comments and contract text asserting the 048 mechanism MUST be corrected in the same effort — notably the `server/document-service.js` module header ("It does NOT transact on the shared doc… a fresh, single-use ephemeral `Y.Doc` seeded from the shared doc's current state"), the `getSharedDoc` warning ("no server-side content operation should transact on it directly"), the inline 048 block comments in `updateDocument`, and the feature-048 attribution comment in `server/version-history.js`. Each MUST state the borrowed-identity mechanism and why it preserves the same guarantee. Design docs under `design/` MUST NOT be hand-edited (they are already amended and are the source of this spec).

- **FR-015 (scope boundary — stated so nobody over-reads this feature)**: this feature changes **how** a server-side write is authored and **what it costs**. It does not change what the resolver guarantees, and it does not advance the scale-out gates. It MUST NOT be represented as fixing, and does not touch: M3 (a refused bind plus a fast reconnect leaving the Redis subscription bound to a dead evicted document), M4 (a cross-pod reconnect awareness blackout), the RBD-045-5 durability window, cross-pod restore serialization (RBD-041-2), or undo supersession consulting only the local live document. The one-replica deploy constraint stands until 048's guarantees plus M3 and M4 all land.

### Out of Scope

- Pooling documents. The cached borrowed identity **is** the pooling the 048 design deferred, and it needs no document to pool. The "pooled per-identity, per-document doc with an idle TTL" follow-on is superseded and MUST NOT be built.
- A meta-only cheap path for title sets. Moot: a title set is O(1) again.
- A stamp-level discriminator for chat-assistant rows (048's RBD-048-1). Unchanged posture.
- Deleting the resolver's live-peek tripwire (048's RBD-048-3). It stays as the fail-honest backstop; deleting it is still recorded cleanup for after the guards have soaked.
- Sharing borrowed identities across processes. Rejected in the design and forbidden by Constitution Principle VII's cache-only rule for process-local knowledge — and unnecessary, since correctness here does not depend on any process knowing another's ids.
- Any change to browser, agent-session, sync-push, undo/redo-inverse, or restore authoring.

### Key Entities

- **Borrowed client identity**: a random 32-bit Yjs client id, drawn per process, collision-checked against the document's own client store, installed on the shared document for the duration of exactly one synchronous transaction, and restored afterward. It signs content operations only and is never announced in awareness.
- **Identity**: the `(userId, agentName)` tuple a write is attributed with — the same tuple that stamps the durable row. It is the cache key's first component and the thing a client id must map to one-to-one.
- **Identity cache entry**: `(identity, document) → (borrowed client id, last clock this process left it at)`, process-local, bounded, evictable, and released when the document leaves the process.
- **Compute phase**: caller work that may fail. Runs before the borrow, outside the transaction, and must not touch the document.
- **Mutate phase**: caller work that changes the document. Runs inside the transaction under the borrowed identity, synchronously, and must not fail.
- **Client-id reader classification**: for each code path that reads a document's client id, one of *construction-time* (safe), *struct-creation-time from the transaction's document* (the property borrowing relies on), or *live* (a stop-the-line finding).

---

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: A server-side write's wall time does not scale with document size — measured across documents spanning roughly two orders of magnitude (about 80 KB to about 3 MB), the per-operation time stays within the same order of magnitude and stays sub-millisecond for a metadata write, versus a cost that today grows roughly linearly with the document.
- **SC-002**: The 048 attribution property is preserved exactly: for every row written by a server-side operation, the payload's authoring client id maps to exactly one `(user, agent)` identity, and authorship answers are identical on every process. Zero client ids in the durable log map to two identities.
- **SC-003**: The shared document's own client id appears in **zero** emitted insert sets across every converged path, and is **restored** after 100% of calls including every failure path.
- **SC-004**: A compute phase that throws leaves the document byte-identical (encoded state and state vector), writes zero rows, emits zero update events, and leaks zero listeners — on every converged path.
- **SC-005**: N consecutive writes by one identity on one document introduce exactly **1** new client entry into the document's state vector, not N. The 5,000-write scenario that produced a 30 KB state vector produces a state vector that grows by one entry.
- **SC-006**: Every converged operation is behavior-identical from the user's perspective — same content outcome, same displayed attribution, same undo behavior, same presence behavior, same error surfaces — with the full backend suite and affected client suites passing.
- **SC-007**: The client-id reader verification is recorded as an artifact naming the exact library versions checked, and every reader is classified. Zero readers remain unclassified.
- **SC-008**: Deliberately breaking the mechanism (making struct creation stop using the installed id, or preventing restoration of the document's own id) causes a named guard test to fail — verified by a deliberate-regression check during review, not assumed.
- **SC-009**: A cached client id that another writer has advanced is never reused: constructing that situation produces a re-mint, and zero duplicate `(client id, clock)` pairs are ever created.

---

## Assumptions

Recorded reasonable defaults where the design doc was silent or where the codebase needed to be consulted. Every decision below is also entered in `clarifications-needed.md` with its rationale.

1. **Identity key includes nulls as-is.** The cache key's identity component is the literal `(userId, agentName)` tuple, including the fully-unattributed `(null, null)` case. All unattributed writes therefore share one client id per document per process, which still satisfies "one client id, one identity" — that id maps to the unattributed identity, which is what its rows honestly say.
2. **The two-phase shape is expressed so that the compute phase produces the mutate phase.** The design ratifies "two phases" without fixing the ergonomics. The recommended default is that the caller supplies one function which computes (and may throw) and returns the mutation to run; this makes the ordering unrepresentable-wrong and migrates all seven call sites naturally. The exact signature is a plan-phase decision.
3. **Compute-phase mutation detection is by state-vector comparison.** Comparing the document's state vector before and after the compute phase is constant-time in document size (it is proportional to the number of clients, not the content) and is therefore acceptable on the hot path.
4. **The cache is bounded per process with harmless eviction.** No specific bound is mandated; the requirement is that memory cannot grow without limit and that eviction costs only a fresh id. Entries are released when the document is evicted from the process.
5. **State-vector growth is bounded per process generation, not absolutely.** With caching, growth tracks (principals × process generations) rather than operations. This is a very large improvement over per-operation growth and is not a claim of a fixed ceiling; stating it honestly matters more than overselling it.
6. **The verification result is recorded in the feature's research artifact.** During spec authoring a preliminary sweep of the installed libraries (yjs 13.6.30, y-protocols 1.0.7, y-websocket 1.5.4) and this repo's server code found no live reader of a document's client id outside yjs's own struct-creation path. This is recorded in `clarifications-needed.md` as evidence, **not** as discharge of FR-008 — the implementer still performs and records the verification, because a spec-phase sweep is not an implementation-phase proof.

---

## Sequencing & Interlocks

- **Depends on 048 being merged.** 049 replaces 048's mechanism in place and re-points its guards. It cannot land before it.
- **Rides on the same file as the 048 review's H1 fix.** `acquireReadyDoc` is untouched by this feature but sits immediately above the changed code; the migration must not disturb it.
- **No database migration.** Nothing about the durable schema changes; no ordering constraint against the pending migration queue.
- **The FR-008 verification gates implementation, not merge.** It is performed before the mechanism is built, because a live reader changes what gets built.
