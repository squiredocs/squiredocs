# Clarifications & Decisions Ledger — 049-constant-time-write-path

Decisions made without live maintainer input during parallel spec authoring
(2026-08-03). Per Constitution Principle VI nothing here was decided silently:
each entry records the question, why it matters, the chosen default, and the
rationale. Sam may overturn any entry.

The feature's headline decision — **the atomicity trade, resolved by two-phase
writes (option 1)** — is **not** in this ledger, because it is not a default:
Sam ratified it in `design/collaboration-core.md` on 2026-08-03. It is spec'd as
FR-003/FR-004 as a first-class requirement.

This file also carries two **design-doc gaps** (section D) and one
**codebase-vs-design discrepancy** (section E). Those are flagged, not resolved
ad hoc.

---

## A. Ratified-by-default product/mechanism decisions

### RBD-049-1 — **RATIFIED-BY-DEFAULT (Sam pre-authorized, 2026-08-03)** — The two-phase signature is "compute returns mutate"

- **Question**: the design ratifies *two phases* but does not fix the
  ergonomics. Two obvious shapes: (a) an options object with separate
  `compute` and `mutate` functions, or (b) one function that computes, may
  throw, and **returns** the mutation to run.
- **Why it matters**: it is the signature every server-side write path uses,
  and the design's whole argument for option (1) is that "the signature carries
  the requirement, so a future caller has to work around the shape rather than
  merely not read a comment." A weak shape forfeits the reason the option was
  chosen.
- **Decision**: **(b), compute returns mutate.** The exact parameter names and
  whether a plain function is still accepted for a mutate-only caller are
  plan-phase decisions.
- **Rationale**: (b) makes the ordering unrepresentable-wrong — the mutation
  cannot exist until the computation has succeeded, so "compute first" is not a
  convention the caller can forget. It also lets the compute phase hand its
  results to the mutation through an ordinary closure, which is exactly how all
  seven call sites already read (they compute nodes/URLs/titles, then insert
  them). (a) requires threading a value between two separately-passed functions
  and leaves "compute ran but mutate used stale locals" expressible.
- **Residual, recorded**: neither shape can *enforce* "mutate must not throw".
  The design records this plainly and so does FR-003. The shape makes a partial
  edit a deliberate act rather than an easy accident.

### RBD-049-2 — **RATIFIED-BY-DEFAULT (Sam pre-authorized, 2026-08-03)** — Compute-phase mutation is detected by state-vector comparison, and it is a hard failure

- **Question**: "the compute phase must not touch the document" cannot be
  enforced by the type system. Detect it, or document it?
- **Why it matters**: a compute-phase mutation escapes the transaction
  entirely. Yjs wraps a bare mutation in an implicit transaction of its own, so
  it broadcasts, persists, and fans out **with no origin object** — an
  unattributed row, which is precisely the class of defect the 041–048 train
  exists to end. Silence here would be worse than the failure two-phase writes
  were adopted to prevent.
- **Decision**: **detect it.** Capture the document's state vector immediately
  before the compute phase and compare immediately after; a difference fails the
  call loudly and names the violating caller. Active at least in tests; enabling
  it in production is a plan-phase call (it is cheap enough to leave on).
- **Rationale**: `encodeStateVector` is proportional to the number of distinct
  clients in the document, not to its content, so this does **not** reintroduce
  the O(document) cost the feature exists to remove. Detection is after the fact
  and cannot undo the escaped mutation, but the goal is that such a caller
  cannot ship unnoticed — which this achieves at effectively zero cost.

### RBD-049-3 — **RATIFIED-BY-DEFAULT (Sam pre-authorized, 2026-08-03)** — The identity cache key uses the literal `(userId, agentName)` tuple, nulls included

- **Question**: what exactly is "identity" for cache purposes, and what happens
  to writes with `userId === null` and/or `agentName === null`?
- **Why it matters**: the invariant is "one client id maps to exactly one
  identity". If nulls were normalized or bucketed carelessly, two genuinely
  different principals could share an id and the 048 guarantee would be
  reopened by the cache.
- **Decision**: the key is the **literal tuple**, nulls included and not
  collapsed. All fully-unattributed writes on one document in one process share
  one client id.
- **Rationale**: that shared id maps to exactly one identity — the
  unattributed one — so the invariant holds by construction. Their rows carry no
  user and no agent, so the resolver has nothing to be confidently wrong about;
  it renders them the same honest way it does today. Normalizing (e.g. treating
  `(u, null)` and `(u, "")` as one) would be a silent semantic change to
  attribution keys and is deliberately not done here.

### RBD-049-4 — **RATIFIED-BY-DEFAULT (Sam pre-authorized, 2026-08-03)** — The cache is bounded, and eviction is a non-event

- **Question**: the design says "cache the borrowed identity per (identity,
  document) inside a process" without bounding it. A `Map` keyed by document
  that is never released is a memory leak.
- **Why it matters**: this exact shape has already burned this area twice —
  the connection-less documents that read operations leaked (fixed in 041's
  `peekSharedDoc`), and the refused-bind documents pinned by an awareness timer
  (H2 in the 2026-08-03 pre-deploy review). A third one would be a pattern.
- **Decision**: the cache MUST be bounded, and entries for a document MUST be
  released when the document leaves the process. Eviction is explicitly
  **harmless**: an evicted entry mints a fresh id on the next write, which is
  exactly 048's behavior.
- **Rationale**: unlike the resupply resolver — where FIFO eviction of learned
  knowledge could reopen a wrong-author path (a 2026-08-03 review finding) —
  losing a cache entry here costs one extra client id in the state vector and
  nothing else. That asymmetry is what makes an aggressive bound safe, and it is
  exactly the "process-local memory as a cache whose loss degrades honestly"
  posture Constitution Principle VII requires.

### RBD-049-5 — **RATIFIED-BY-DEFAULT (Sam pre-authorized, 2026-08-03)** — Reentrancy is refused, not nested

- **Question**: the design does not say what happens if a write is initiated
  from inside another write's mutate phase on the same document. Nested borrows
  would restore the *outer* borrow's id in the inner `finally`, leaving the
  document permanently carrying a borrowed id.
- **Why it matters**: it converts a caller mistake into permanent corruption of
  the document's own identity — the exact invariant FR-001 exists to hold.
- **Decision**: **refuse.** A borrow attempted while one is already open on the
  same document fails the call loudly. Nested borrows are never attempted.
- **Rationale**: no current caller does this (the mutate phase is synchronous
  and does no I/O), so refusing costs nothing today and makes the failure
  visible the first time someone tries. Supporting nesting would require a
  borrow stack for a case with no use.

### RBD-049-6 — **RATIFIED-BY-DEFAULT (Sam pre-authorized, 2026-08-03)** — 048's re-pointed guards are re-pointed in place, not deleted and rewritten

- **Question**: three of 048's `per-operation-doc.test.js` guards (G3, G4, G4b)
  and one (G5) are falsified or narrowed by 049. Delete them, or rewrite them?
- **Why it matters**: they are the only reviewer this project has
  (Constitution Principle II/III), and this is exactly the moment where a guard
  quietly disappears and nobody notices for six months.
- **Decision**: **re-point in place**, keeping each test's identifier and its
  place in the file, with the assertion changed to the property 049 provides and
  a comment recording what it used to assert and why that changed. No guard is
  deleted. FR-011 enumerates each one.
- **Rationale**: keeping the identifiers means the diff shows a *changed*
  assertion rather than a shrinking file, which is what makes the change
  reviewable. G1 and G2 — the load-bearing insert-set assertions — are untouched
  by 049 and get *more* load-bearing under it (the design says so explicitly:
  they are what will catch a silent yjs regression).

---

## B. The blocking verification

### DEC-049-7 — **BLOCKING, NOT A DEFAULT** — Nothing may read the document's client id live during a borrow

Recorded here so it cannot be lost between spec and implementation. This is
FR-008 and it is **stop-the-line**, not a preference.

- **The requirement**: the implementer performs the enumeration and records it,
  with library versions and line references, as a durable artifact. If any path
  reads the document's client id **live** while a transaction may be open, the
  feature stops and is narrowed before implementation resumes.
- **The window is wider than "inside the caller's function"**: yjs emits the
  document `update` event from **inside** transaction cleanup, so the
  persistence listener, the WebSocket broadcast, the Redis fan-out handler and
  the origin-scoped capture all run while the borrowed id is still installed.
  Any of them reading the field would see the wrong id.
- **Preliminary spec-phase sweep** (evidence, **not** discharge). Against the
  installed `yjs@13.6.30`, `y-protocols@1.0.7`, `y-websocket@1.5.4`:
  - **yjs, struct creation** — `const ownClientId = doc.clientID` read from the
    transaction's document at struct-creation time (several sites, e.g.
    `node_modules/yjs/dist/yjs.cjs:5407, 5608, 6403, 6461, 6496, 6525, 9671`).
    **This is the property borrowing relies on.** Classified *struct-creation-time*.
  - **yjs, collision self-heal** — `node_modules/yjs/dist/yjs.cjs:3379-3381`
    regenerates `doc.clientID` after a **non-local** transaction whose after-state
    advanced the current id's clock. Never fires during our (local) borrow.
    Classified *live but non-local-only*. See D-049-A: it has a consequence for
    the cache.
  - **yjs, subdocs** — `node_modules/yjs/dist/yjs.cjs:3402` assigns a newly added
    subdocument `doc.clientID`, i.e. the borrowed id, **permanently**. No path in
    this repo creates subdocuments (verified: no `subdoc` usage in `server/`
    outside the bundled sandbox copy of yjs). Forbidden in the mutate-phase
    contract so a future one cannot regress it. Classified *live — mitigated by
    contract*.
  - **y-protocols `Awareness`** — `node_modules/y-protocols/awareness.js:49`,
    `this.clientID = doc.clientID` in the constructor; every later use reads
    `this.clientID`. Classified *construction-time*. Matches the design's
    settled finding. Consequence: no awareness may be constructed during a borrow.
  - **y-protocols `sync`** — no `doc.clientID` read at all. State vectors come
    from `doc.store.clients` (`sync.js:50`), which is the correct source and
    reflects the borrowed id only once it has actually written. Classified
    *clean*.
  - **y-websocket server utils** — `node_modules/y-websocket/bin/utils.js` reads
    client ids only from awareness change lists (`:113-114`), never
    `doc.clientID`. Classified *clean*. (`src/y-websocket.js` reads
    `provider.doc.clientID` but is the **browser** provider, not the server.)
  - **This repo's server code** — no `.clientID` read on a document anywhere in
    `server/` outside `server/mcp/sandbox/isolate-bundle.js` (a bundled yjs copy
    running inside the isolate against its own documents, never the shared one).
    The persistence listener, broadcast, Redis fan-out and origin capture do not
    read it. Classified *clean*.
  - **Result**: no live reader found. **FR-008 is still owed** — this sweep was
    performed by the spec agent from source reading, and the design's own
    standard for this feature is "verified, not assumed". The implementer
    re-performs it, extends it to anything the presence and awareness-guard
    machinery attaches at runtime, and records it as the artifact.

---

## C. Performance and growth claims

### DEC-049-8 — State-vector growth is bounded per **process generation**, not absolutely

The design says caching "makes the growth proportional to how many principals
have edited the document rather than how many times". True within a process.
Across process restarts and pod replacements, each generation mints new ids, so
the true growth is `principals × process generations`. Stated honestly in the
spec's Assumptions rather than rounded up to "bounded", because the marketing-
copy standard Sam has set for user-facing claims applies at least as strongly to
correctness claims. It remains an enormous improvement (from per-operation to
per-principal-per-generation) and no further work is proposed.

---

## D. Design-doc gaps (flagged, per Principle VI — not resolved ad hoc)

### D-049-A — The design's "no better and no worse" residual claim does not survive caching

- **The design text** (Per-identity server docs, the amended "A clientID that
  belongs to exactly one identity is mandatory" paragraph): *"Randomness still
  matters per process, because it is what keeps two pods from drawing the same
  id; the draw is from the same 32-bit space yjs uses for its own client ids and
  carries the same residual, no better and no worse."*
- **What the code shows**: yjs's own client ids are **not** left unprotected.
  `yjs.cjs:3379-3381` detects the collision case — a remote transaction that
  advanced the clock of the id this document is using — and regenerates the id,
  printing a warning. A **cached borrowed** id gets none of that, because it is
  not the document's client id at rest (it is installed only for the duration of
  a transaction, and yjs's check reads `doc.clientID`). The cache also stretches
  the exposure from one operation to the lifetime of the process.
- **So the residual is genuinely worse than yjs's own**, not equal to it — not
  in the probability of the initial draw colliding (that part is equal), but in
  what happens afterward: yjs heals, a cached id does not.
- **How the spec handles it**: FR-007 requires the analogue — before reusing a
  cached id, establish that no other writer has advanced it in this document
  since this process last used it (compare the clock this process left it at
  against what the document's store now reports); on mismatch, discard and
  re-mint. That is cheap, precise, and restores parity with yjs's own protection.
- **Owed to Sam**: the design sentence should be amended in the Squire doc to
  say that borrowing's residual is equal to yjs's *at draw time* and requires an
  explicit re-check at reuse time. Not hand-edited here — `design/` is
  export-only.

### D-049-B — The design does not say what happens to the cache when a document is evicted, nor bound it

Covered by RBD-049-4 above. Flagged separately because it is a silence in the
design rather than a decision the design made — and because the two prior
memory-leak findings in this exact area (041 `peekSharedDoc`, pre-deploy H2)
make it a recurring shape rather than a hypothetical.

---

## E. Codebase-vs-design discrepancies (reported, never designed around)

### E-049-A — One caller today throws from **inside** the transaction, so "every caller today already works this way" is very slightly optimistic

- **The design text** (RATIFIED option 1): *"Every caller today already works
  this way, so this writes down what they do rather than asking them to change."*
- **What the code shows**: `server/markdown-import.js` (L332-341) re-resolves
  its `insertAfterXPath` target **inside** the update function and throws
  `ImportError('XPATH_NO_MATCH')` from there, with the comment *"Re-resolve
  inside the transaction; throwing here aborts before any mutation (nothing has
  been inserted or deleted yet)."* Under 048 that is safe (the copy is
  discarded). Under 049 it would be a throw inside the mutate phase, which the
  contract forbids.
- **Severity correction (orchestrator, 2026-08-03)**: the original wording
  ("the exact shape two-phase writes exist to eliminate") overstated it. The
  throw is positioned *before* any mutation in its branch, and a function that
  throws before touching the document was measured to be clean under borrowing:
  no update event, no mutation. So this caller is not a live hazard today. It is
  a CONTRACT violation to fix, not a bug to chase — the mutate phase must not
  throw even when the throw happens to be harmless, or the contract stops
  meaning anything.
- **Why it is nonetheless a non-issue**: the throw happens *before* any
  mutation, so it is compute-phase work that merely lives in the wrong place.
  Moving it to the compute phase is behavior-preserving, because compute and
  mutate run back to back with no awaits between them on the same shared
  document — so the "re-resolve against current state" property the comment is
  protecting is fully preserved. (Under 048 it also had to be re-resolved on the
  *ephemeral copy*; under 049 there is only one document, which makes this
  strictly simpler.)
- **Spec handling**: called out explicitly in FR-005's inventory note, so the
  migration cannot mistake it for a mechanical rename. Reported here rather than
  quietly fixed.

### E-049-B — WITHDRAWN (false finding). The design's pointer is correct; the search that contradicted it was wrong

- **What was originally claimed**: that `server/markdown-sync.js` contains no
  `applySyncPush`, no fork document and no `clientID` reference, so the design's
  file pointer was stale and owed Sam a correction.
- **What is actually true** (orchestrator verification, 2026-08-03): the design
  is right. `server/markdown-sync.js` defines `syntheticClientId` at L279,
  `applySyncPush` at L1063, and pins `fork.clientID = syntheticClientId(...)` at
  L1111, exactly as ground truth describes. **Nothing is owed to Sam, and the
  Squire doc must NOT be "corrected" here** — doing so would have replaced a
  correct pointer with a wrong one.
- **Why the search lied**: `markdown-sync.js` contains NUL bytes (`file` reports
  it as `data`), so plain `grep` treats it as binary and silently reports no
  matches. `grep -a` finds all three. This is a KNOWN repo hazard already
  recorded for `server/resupply-resolution.js`, and this is the third agent it
  has caught.
- **Standing rule for this repo**: never conclude "X is not in file Y" from a
  plain `grep` alone. Use `grep -a`, or Read the file. A negative grep result on
  a NUL-bearing file is indistinguishable from a genuine absence.

### E-049-C — 048's own module header will be falsified the moment 049 lands

`server/document-service.js:8-29` documents the ephemeral-copy mechanism as the
contract ("It does NOT transact on the shared doc"), and `getSharedDoc`'s warning
at `:66-69` says no server-side content operation should transact on the shared
doc directly — which 049 makes exactly what they do. Not a discrepancy today;
recorded so it cannot be missed. FR-014 requires both, plus the inline 048 block
comments and the 048 note in `server/version-history.js:1046-1052`, to be
corrected in the same effort.
