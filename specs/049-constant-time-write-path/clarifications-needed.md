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

---

## F. Plan-stage decisions and findings (2026-08-03, plan agent)

Same rules as sections A–E: nothing decided silently, nothing under `design/`
hand-edited, every contradiction reported rather than designed around. Sam may
overturn any entry.

### PD-049-1 — **RATIFIED-BY-DEFAULT (plan stage)** — The two-phase signature takes one function and accepts NO mutate-only form

- **Question**: RBD-049-1 fixed the shape ("compute returns mutate") and
  explicitly deferred "the exact parameter names and whether a plain function is
  still accepted for a mutate-only caller".
- **Decision**: `updateDocument(docGuid, computeMutation, { userId, agentName })`
  where `computeMutation(ydoc)` may read, may throw, must not mutate, and returns
  the mutate phase or a nullish value meaning "nothing to do". **A bare mutate
  function is not accepted.** A title set reads
  `() => (doc) => doc.getMap('meta').set('title', t)`.
- **Rationale**: a plain function is indistinguishable from a compute phase that
  returns nothing, and the ambiguity resolves in the dangerous direction — the
  mutation runs *outside* the transaction, so yjs wraps it in an implicit one and
  it broadcasts, persists and fans out **with no origin object**: an unattributed
  row, the exact defect class RBD-049-2 cites. One shape, no overload, and the
  compute-phase detectors catch a stale caller loudly rather than silently.
- **Residual**: three extra characters at the simplest call sites. Accepted.

### PD-049-2 — **RATIFIED-BY-DEFAULT (plan stage)** — The identity cache is keyed by the LIVE DOCUMENT OBJECT, which resolves a tension inside FR-006/US3

- **Question**: FR-006 requires that "cache entries for a document MUST NOT
  outlive the document's presence in the process", while US3 acceptance scenario
  3 imagines the *same cached id* being reused after "a document that is unloaded
  and later reloaded". In y-websocket an unload destroys the `Y.Doc` and a later
  access constructs a **new** one, so the two cannot both hold literally.
- **Decision**: `WeakMap<Y.Doc, …>`. Entries are released with the document by
  construction, and a reload mints a fresh id.
- **Rationale**: the anti-leak clause is the MUST, and RBD-049-4 records that
  this exact shape has already leaked twice in this area (041 `peekSharedDoc`,
  the pre-deploy H2 awareness timer) — both times because a release hook was not
  called. A WeakMap has no release hook to forget. The property US3 AS3 is
  actually protecting survives intact and is pinned by tests: the clock always
  comes from the document's own store rather than a remembered counter, and no
  `(clientId, clock)` pair is ever minted twice. What is given up is one extra
  client id per document generation, which DEC-049-8 already accounts for
  ("principals × process generations").
- **Reported, not resolved away**: if Sam reads US3 AS3 as binding literally, the
  alternative is a guid-keyed bounded LRU with an explicit release on document
  destroy — strictly leakier, for one client id per reload.

### PD-049-3 — **RATIFIED-BY-DEFAULT (plan stage)** — The ratified compute-phase detector is KEPT and STRENGTHENED, and it runs in production

- **Finding (measured, not reasoned)**: RBD-049-2 ratified detecting a
  compute-phase mutation by comparing the document's state vector before and
  after. Probed against this repo's `yjs@13.6.30`, a **delete-only** mutation
  leaves the state vector byte-identical — deletes mark items and record a delete
  set, adding no struct to `store.clients`. So the ratified detector does not see
  a compute phase that only deletes, and an escaped delete carries no origin,
  which is precisely the unattributed-row failure the detector exists to catch.
- **Decision**: keep the state-vector comparison exactly as ratified **and add**
  an `update`-event tripwire armed for the duration of the compute phase (a bare
  mutation fires the document update event synchronously — probed). Both are O(1)
  in document size. This strengthens the ratified decision; it does not replace
  it.
- **Second decision**: detection is **enabled in production**, not test-only
  (RBD-049-2 left this as a plan-phase call). It is what makes PD-049-1's single
  shape safe against a stale caller, and it costs two constant-time samples on a
  path that just became ~1000x cheaper.

### PD-049-4 — **RATIFIED-BY-DEFAULT (plan stage)** — A mutate-phase throw is logged loudly by name and the ORIGINAL error is rethrown

- **Question**: the contract says the mutate phase must not throw, and neither
  shape can enforce it (RBD-049-1's recorded residual). What does the mechanism
  do when it happens anyway?
- **Decision**: log loudly and by name (naming the mechanism, the document and
  the acting identity), then rethrow the **original** error object unchanged. No
  compensation, no wrapping.
- **Rationale**: error identity is part of the caller contract —
  `ImportError.code` drives the HTTP status on the import routes, and FR-010
  requires error surfaces to be unchanged. Compensation is design option (2),
  rejected there on cost rather than doubt, and this feature does not reopen it.
  The partial edit that escapes is the design's recorded residual; the log is
  what stops it from being silent.

### N-049-2 — NOTE (no decision required) — FR-005's inventory is the PRODUCTION inventory; eight test files also call `updateDocument` directly

Verified with `grep -an` (never a plain `grep` in this repo):
`server/__tests__/per-operation-doc.test.js`,
`server/__tests__/document-service-capture.test.js` (15 calls),
`server/__tests__/bindstate-failure.test.js`,
`server/__tests__/live-fanout.test.js`,
`server/__tests__/resupply-resolution.test.js`,
`server/mcp/__tests__/tools/restore-document-version.test.js`,
`server/mcp/__tests__/tools/read-document-version.test.js`,
`server/mcp/__tests__/integration/undo-redo-workflow.test.js`.

The signature change is breaking for every direct caller, so these migrate in the
same change or the backend suite fails wholesale instead of usefully. Not a
contradiction of the spec — FR-005 is explicitly about call *sites* in production
paths — but it roughly doubles the migration surface and is recorded so the task
list cannot miss it.

### N-049-3 — NOTE (evidence for FR-008) — The borrow window was reproduced, not assumed

A document-level `update` listener reading `doc.clientID` during transaction
cleanup sees the **borrowed** id (probed, `yjs@13.6.30`). That is direct evidence
for the spec's claim that the window covers persistence, broadcast, the Redis
fan-out handler and the origin-scoped capture. It raises the stakes on FR-008
rather than discharging any part of it: the verification remains scheduled as the
first implementation work, with `clientid-reader-audit.md` as its artifact, and a
live reader still stops the line.

### E-049-D — The spec's sweep claim "no `.clientID` read on a document anywhere in `server/`" is FALSE (analyze stage, 2026-08-03)

- **The claim** (§B, DEC-049-7, "This repo's server code"): *"no `.clientID` read
  on a document anywhere in `server/` outside `server/mcp/sandbox/isolate-bundle.js`."*
- **What is actually true**: `server/resupply-resolution.js:339`,
  `learnLiveServerClient` — `if (doc && Number.isFinite(doc.clientID)) noteServerDocClient(docGuid, doc.clientID)`
  — reads the client id off the **live shared document**. Found with `grep -a`.
- **Why the sweep missed it**: `server/resupply-resolution.js` is one of the
  NUL-bearing files a plain `grep` silently treats as binary. This is the
  **fourth** finding this hazard has produced in this repo and the second in this
  feature (see E-049-B, withdrawn for the same reason). The standing rule holds:
  never conclude "X is not in file Y" from a plain `grep`.
- **Is it a live reader during a borrow?** Traced during analysis: the only
  caller is `computeOutcomes`, reached through `resolveForRows` from
  version-history, docs-export, and the collab guardrail — and the guardrail runs
  strictly **post-persist**, inside a `.then()` after an awaited DB write. The
  borrow window is synchronous from install to restore with no awaits, so none of
  these can execute inside it. **The mechanism is not at risk today.**
- **Why it still matters**: if resupply resolution ever becomes reachable
  synchronously from the document `update` event, it would record the **borrowed**
  id as a shared-doc client id and poison it — making the resolver refuse
  attribution for rows that are legitimately attributed. That is an accuracy loss,
  never a wrong author, but it is exactly the kind of coupling FR-008's audit
  exists to notice.
- **Handling**: scheduled as task **T005a** — classified and reasoned about in
  `clientid-reader-audit.md`, not waved through. Reported here rather than quietly
  patched into the spec, which is committed and belongs to the spec stage.
- **Orchestrator verification (2026-08-03)**: independently confirmed with
  `grep -an '\.clientID' server/resupply-resolution.js`. Now at **line 340**, not
  339 — the file gained a `telemetry/metrics` require in the same session. The
  reachability argument was re-read and accepted: the borrow window is
  synchronous from install to restore, and every path to `learnLiveServerClient`
  crosses an await. Not stop-the-line, correctly classified. Note the shape of
  this near-miss for the implementer: the sweep that missed it was looking for
  exactly the right thing, in the right place, with a tool that lies about this
  file. T005a must use `grep -a` or Read, and must state which it used.

---

## G. Implementation-stage findings (2026-08-03, implement agent)

### N-049-4 — NOTE (T001/T002) — The inventory and the versions are unchanged

Re-verified with `grep -arn "updateDocument(" server/ __tests__/`. All **7
production call sites** are at the lines `research.md` §R7 states
(`document-service.js:383`, `markdown-import.js:321`, `chat-tools.js:60` and
`:108`, `docs-import.js:341`, `create-document.js:197`,
`set-document-title.js:79`), and exactly **8 test files** call `updateDocument`
directly. No drift. Installed versions match the plan exactly: `yjs@13.6.30`,
`y-protocols@1.0.7`, `y-websocket@1.5.4`.

### F-049-1 — REFINEMENT to E-049-D's reachability argument — the decisive barrier is a microtask, not an `await`

The record (orchestrator note on E-049-D) accepted T005a on the grounds that
"every path to `learnLiveServerClient` crosses an await". **That argument is
weaker than it looks, and it is not the one the audit rests on.**

`learnLiveServerClient` is the **first statement of `computeOutcomes`, before any
`await`** (`resupply-resolution.js:589`). The synchronous prefix of an `async`
function runs synchronously at the call. So "the caller awaits it" does not by
itself keep the read out of a synchronous window — if `computeOutcomes` were ever
*invoked* from inside the borrow window, the `doc.clientID` read would execute
inside it.

What actually settles it: `computeOutcomes` is invoked **only** through
`withFoldSlot` (`resolveForRows:658`), which dispatches as `prev.then(task, task)`.
A `.then()` callback always runs in a microtask, never in the calling synchronous
frame. The borrow window is one synchronous frame and restores `doc.clientID`
before any microtask runs. Verified empirically (probe P6).

This is recorded as a refinement rather than a contradiction — the conclusion
(not stop-the-line) is unchanged. It matters because the barrier that holds is a
**structural** property of the dispatch that a new caller inherits automatically,
whereas the `await` argument would have to be re-checked against every future
caller. Full reasoning in `clientid-reader-audit.md` §5.

### F-049-2 — NEW FINDING (T003) — yjs stamps SUBDOCUMENTS with the live `doc.clientID` inside the borrow window

Not previously flagged at any stage. `yjs.cjs:3402`, inside transaction cleanup
and therefore **inside the borrow window**:

```js
subdocsAdded.forEach(subdoc => { subdoc.clientID = doc.clientID; … })
```

This is a genuine **live** read. A subdocument created by a mutate phase would be
stamped with the **borrowed** id **permanently** — the borrow is restored, the
subdocument's id is not, and nothing later repairs it.

**Not stop-the-line**: it is unreachable today. A NUL-safe sweep of `server/` for
`new Y.Doc()` finds 17 sites, all standalone documents; none is inserted into
another document's type, so `subdocsAdded` is always empty for our transactions.

**Disposition**: this is exactly the hazard T018a's JSDoc prohibition names, and
it is now backed by a located line rather than by contract prose. It is
unenforceable by shape — hence written into the signature's documentation. **If a
future caller creates a subdocument in a mutate phase, the FR-008 GO verdict no
longer covers it.**

### F-049-3 — CONFIRMED MECHANICALLY (T003, analyze F4) — yjs's client-id self-heal can never fire for a 049 write

`yjs.cjs:3379` guards the self-heal with `!transaction.local && …`. 048's
merge-back used `Y.applyUpdate`, which yjs runs **non-local**, so the self-heal
could fire. 049's `doc.transact` is **local**, so the condition short-circuits
and `doc.clientID` is not even evaluated (probe P2).

Recorded because it upgrades FR-007 from a precaution to a **requirement with a
located mechanical cause**: a borrowed id receives no protection from yjs's own
duplicate-id repair, and caching stretches that exposure across the process
lifetime. The manual clock re-check is the only thing standing in for it.
