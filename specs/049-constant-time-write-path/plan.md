# Implementation Plan: Constant-Time Server-Side Write Path

**Branch**: none — authored on `main` alongside the spec (pipeline override; no branch created, nothing committed by this stage) | **Date**: 2026-08-03 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `/specs/049-constant-time-write-path/spec.md`

**Design ground truth**: `design/collaboration-core.md` → "Per-identity server
docs", its 2026-08-03 049 amendment, the RATIFIED two-phase option list, and the
two corrections appended the same day (cached-identity clock re-check; the honest
note on library support). Principle VI: the doc wins over this plan and over the
code.

## Summary

Replace 048's ephemeral per-operation `Y.Doc` with a **borrowed client identity**
installed on the shared document for the duration of one synchronous
transaction, restored in a `finally`. The attribution property 048 bought is
unchanged — the emitted update's insert set still carries exactly one client id
that maps to exactly one `(user, agent)` identity — and the cost stops tracking
document size (measured 97x–1224x, and flat).

Two consequences ride with the mechanism because they cannot follow it:

1. **Two-phase writes.** `updateDocument`'s second parameter becomes a *compute*
   phase that may throw and must not mutate, returning the *mutate* phase that
   mutates and must not throw. Yjs does not roll back a transaction whose
   function throws, so this is the ratified way the atomicity 048 got for free is
   kept. This is the headline change, not a footnote: it is a breaking signature
   change across seven production call sites and eight test files.
2. **A per-`(identity, document)` identity cache**, so a document's state vector
   grows with the number of principals that wrote to it rather than the number of
   writes — with the clock always read from the document's own store and a
   re-check before every reuse.

Everything else stays exactly where it is: the bind-readiness gate, the H1
staleness re-acquire, the origin object and origin-scoped capture, the post-write
`BindFailedError` check, `via_sync` unset, the sync-push pinned client id,
restore's own document and its store-then-apply ordering, presence, broadcast,
persistence and fan-out semantics.

---

### LOUD FLAG 1 — FR-008 is a gate that runs BEFORE any mechanism code, and the borrow window is confirmed wider than the caller's function

The spec's preliminary sweep found no live reader of `doc.clientID`. It is
evidence, **not discharge**, and this plan does not treat it as done. The
verification is scheduled as the first work item, produces
`clientid-reader-audit.md` with versions and line references, and **any live
reader stops the line** — implementation halts and reports rather than narrowing
the mechanism on its own.

The window is not "inside the caller's function". Probed against this repo's
`yjs@13.6.30`: a document-level `update` listener reads `doc.clientID` **as the
borrowed id**, because yjs emits the document update event from inside
transaction cleanup. Persistence, broadcast, the Redis fan-out handler and the
origin capture all run inside that window. The audit must cover every doc-level
listener this server attaches at runtime, including the presence and
awareness-guard machinery — enumerated from the wiring, not from a grep (and
never from a plain `grep`: NUL-bearing files in this repo silently report no
matches, which has already produced one withdrawn finding in this feature's own
ledger).

### LOUD FLAG 2 — the caller inventory is 7 production sites AND 8 test files; there is no gradual migration

The signature change is breaking for every direct caller. FR-005 enumerates the
production seven (all verified present at the stated lines, including
`createSeededDocument`, which is its own call site). It does not enumerate tests,
and eight test files call `updateDocument` directly — `document-service-capture.test.js`
alone has 15 calls. Migrating them is not optional cleanup: skip one and the
backend suite fails wholesale instead of usefully. Full list in
[research.md](./research.md) §R7.

### LOUD FLAG 3 — the ratified compute-phase detector has a measured hole, and the plan strengthens it rather than substituting for it

RBD-049-2 ratified state-vector comparison. Probed: a **delete-only** mutation
does not change the state vector (deletes create no struct in `store.clients`),
so a delete escaping the compute phase would escape the detector too — and an
escaped delete carries no origin, i.e. an unattributed row, exactly the defect
class the detector exists to catch. The plan keeps the ratified detector wired as
ratified and **adds** an `update`-event tripwire armed across the compute phase.
Both are O(1) in document size. Recorded as PD-049-3, not applied silently.

### LOUD FLAG 4 — a spec-internal tension is honored in the direction of the anti-leak MUST, and reported

FR-006 requires cache entries not to outlive the document's presence in the
process; US3 AS3 imagines a cached id surviving an unload/reload. Under this
plan's doc-keyed `WeakMap` a reload is a new document object and mints a fresh
id. The plan takes the anti-leak MUST (RBD-049-4 records two prior leaks of
exactly this shape here) and keeps the safety property AS3 actually asserts:
the clock always comes from the document's own store, and no `(clientId, clock)`
pair is ever minted twice. Recorded as PD-049-2 and reported, not resolved away.

### LOUD FLAG 5 — NO MIGRATION, and no scale-out claim

Nothing about the durable schema changes; there is no ordering constraint against
the pending migration queue. And per FR-015 this feature changes how a write is
authored and what it costs — it does not advance M3, M4, the RBD-045-5 durability
window, cross-pod restore serialization, or undo supersession. The one-replica
deploy constraint stands.

---

## Technical Context

**Language/Version**: Node.js 22 (CommonJS server), React 18 client (untouched)

**Primary Dependencies**: `yjs@13.6.30`, `y-protocols@1.0.7`, `y-websocket@1.5.4`
— exact versions matter here and are recorded in the FR-008 audit artifact

**Storage**: PostgreSQL (`yjs_updates`); **no schema change, no migration**

**Testing**: Jest (`server/__tests__/`, `server/mcp/__tests__/`,
`__tests__/integration/`), serial against the shared DB. The mechanism guards are
hermetic — they drive `documentService` through its `init` seam with local
`Y.Doc`s, no DB and no WebSocket.

**Target Platform**: Linux app pods (k3s), one replica today

**Project Type**: web service (backend-only change)

**Performance Goals**: per-operation wall time does not scale with document size;
sub-millisecond for a metadata write on a 3 MB document (design's measured table:
0.16 / 0.06 / 0.17 ms at 79 KB / 794 KB / 3.2 MB)

**Constraints**: the mutate phase is synchronous, no I/O, no awaits, no
`clientID` read, no awareness construction, no subdocuments, no reentrancy; the
detection added to the hot path must be O(1) in document size

**Scale/Scope**: `server/document-service.js` + one new module, 7 production call
sites, 8 test files, 1 guard file re-pointed in place, 2 code-comment corrections,
1 developer-doc checklist

---

## Constitution Check

*GATE: evaluated before Phase 0 and re-evaluated after Phase 1 design. Constitution `.specify/memory/constitution.md` v1.2.0.*

| Principle | Verdict | Evidence |
| --- | --- | --- |
| **I. Documentation Reflects Reality** | PASS (with owed work scheduled) | `README.md` checked with `grep -an` — it does not describe the 048 write mechanism, so no README change is required. `docs/dev.md` gains the yjs-upgrade checklist (FR-012). FR-014's falsified code comments are corrected in the same effort. `design/` is export-only and untouched; the design sentence D-049-A flags is already recorded as owed to Sam. |
| **II. Test-Backed Changes** | PASS | Every behavioral change is pinned: the FR-011 guards re-pointed in place with new pins added (`contracts/invariant-guards.md`), a hermetic performance guard (R8), and a deliberate-regression check for SC-008. Backend suites run serially. No new format/serialization surface, so the round-trip registry suite is untouched. |
| **III. Trunk-Based Solo Workflow** | PASS | No new ceremony. The pipeline's existing worktree/merge-queue flow applies; this stage produces documents only. |
| **IV. Collaboration-Safe Document Operations** | PASS — and strengthened | The mutate phase is contractually restricted to targeted operations against the existing tree (FR-003); wholesale delete-and-recreate and positional targeting stay forbidden. `markdown-import`'s `replace` mode keeps its block-level deletes/inserts against the same fragment. Provenance is the point of the feature: one client id, one identity, by construction. |
| **V. Secure by Default** | PASS (not applicable) | No new ingestion surface, no change to the sandbox, sanitizer, image guardrail, or token scoping. Borrowed ids are internal and never leave the process. |
| **VI. Design Docs Are Ground Truth** | PASS | The plan implements the ratified amendment. Two design-doc gaps (D-049-A, D-049-B) and one codebase discrepancy (E-049-A) were already flagged by the spec; this plan adds PD-049-1..4 to the same ledger rather than deciding silently, and hand-edits nothing under `design/`. |
| **VII. Horizontally Scalable App Pods** | PASS | The identity cache is process-local **and correctness does not depend on it**: losing it costs one extra client id in a state vector (RBD-049-4). Two pods never need to agree on borrowed ids — ids are random per process and collision-checked against shared durable state (the document's own client store), which is the "structurally unnecessary" remedy Principle VII names. No new single-replica precondition. FR-015 explicitly declines to claim the scale-out gates. |

**Post-Phase-1 re-evaluation**: unchanged, all PASS. The Phase 1 design added one
module (`server/borrowed-identity.js`) and no new dependency, no new persistence,
and no new process-local correctness-bearing state.

**Complexity Tracking**: no violations to justify — table below left empty.

---

## Project Structure

### Documentation (this feature)

```text
specs/049-constant-time-write-path/
├── spec.md                      # committed input (0660bc5c)
├── clarifications-needed.md     # ledger; plan appends §F (PD-049-1..4)
├── checklists/requirements.md   # committed input
├── plan.md                      # this file
├── research.md                  # Phase 0
├── data-model.md                # Phase 1 — entities and their invariants
├── contracts/
│   ├── document-service.md      # the two-phase updateDocument contract
│   ├── borrowed-identity.md     # mint / reuse / collision / clock / reentrancy / cache
│   └── invariant-guards.md      # FR-011 re-pointing map + the new pins
├── quickstart.md                # Phase 1 — how to validate, including the probes
├── clientid-reader-audit.md     # produced by implementation (FR-008 artifact)
├── performance.md               # produced by implementation (FR-013 evidence)
└── tasks.md                     # produced by /speckit-tasks
```

### Source Code (repository root)

```text
server/
├── borrowed-identity.js            # NEW — the only place doc.clientID is assigned
├── document-service.js             # CHANGED — two-phase updateDocument; ephemeral doc deleted
│                                   #   unchanged: getSharedDoc, peekSharedDoc,
│                                   #   waitForDocReady, acquireReadyDoc (H1)
├── markdown-import.js              # CHANGED — call site; in-transaction XPath re-resolve
│                                   #   moves to the compute phase (E-049-A)
├── api/chat-tools.js               # CHANGED — image insert; empty-import anchor
├── api/docs-import.js              # CHANGED — empty-import anchor
├── mcp/tools/create-document.js    # CHANGED — empty-import anchor
├── mcp/tools/set-document-title.js # CHANGED — title set
├── version-history.js              # COMMENT ONLY — restore keeps its own doc (FR-010)
└── __tests__/
    ├── per-operation-doc.test.js               # re-pointed IN PLACE (FR-011)
    ├── borrowed-identity.test.js               # NEW — the module's own unit guards
    ├── borrowed-identity-performance.test.js   # NEW — SC-001 evidence
    ├── document-service-capture.test.js        # migrated to the two-phase shape
    ├── bindstate-failure.test.js               # migrated
    ├── live-fanout.test.js                     # migrated
    └── resupply-resolution.test.js             # migrated

server/mcp/__tests__/
├── tools/restore-document-version.test.js      # migrated
├── tools/read-document-version.test.js         # migrated
└── integration/undo-redo-workflow.test.js      # migrated

docs/dev.md                          # CHANGED — yjs/y-protocols/y-websocket upgrade checklist
```

**Structure Decision**: backend-only, inside the existing `server/` layout. One
new module because the `doc.clientID` assignment deserves exactly one home — the
place where the FR-012 upgrade caveat lives in code and where the cache is unit
testable without the write path wrapped around it. No client change, no shared
change, no migration.

---

## Implementation phases

Ordered by dependency. Phase A is a hard gate.

### Phase A — the verification (FR-008, DEC-049-7) — GATES EVERYTHING

Enumerate and classify every reader of a document's client id across
`yjs@13.6.30`, `y-protocols@1.0.7`, `y-websocket@1.5.4`, and this repo's
`server/` — including every doc-level listener attached at runtime by the
presence and awareness-guard machinery, enumerated from the wiring. Record file,
line, version and classification (construction-time / struct-creation-time /
live) in `clientid-reader-audit.md`. Re-verify the spec's sweep rather than
citing it. Use `grep -a` or read the file; a plain `grep` is not evidence here.

**A live reader stops the line.** Report and halt; the narrowing decision
(passing the real id explicitly, or a narrower borrow) is recorded before any
mechanism code is written.

### Phase B — the mechanism (`server/borrowed-identity.js`, FR-001/002/006/007)

Mint with a collision check against `doc.store.clients`; cache per
`(identity, document)` in a doc-keyed `WeakMap` with a bounded per-document
identity map; re-check the clock via `Y.getState(doc.store, id)` before every
reuse and discard on mismatch; refuse a reentrant borrow loudly; restore the
document's own id in a `finally` on every path. Unit-guarded in
`server/__tests__/borrowed-identity.test.js` with no write path around it.
Contract: [contracts/borrowed-identity.md](./contracts/borrowed-identity.md).

### Phase C — the write path (`server/document-service.js`, FR-001/003/004/009/014)

Two-phase `updateDocument`; delete the ephemeral doc, the seed, the merge-back
and the ordering-sensitive capture listener; arm the compute-phase detector
(state vector + update tripwire); keep the gate, the acquire, the origin, the
origin-scoped capture with its emit-time `hadRedisHandler` sample, the
`setImmediate` persistence-initiated turn, and the post-write `BindFailedError`
check byte-for-byte in behavior. Correct the falsified module header and
`getSharedDoc` warning in the same change.
Contract: [contracts/document-service.md](./contracts/document-service.md).

### Phase D — the seven production call sites (FR-005)

Mechanical `fn` → `() => fn` everywhere **except** `markdown-import.js`, where
the in-transaction XPath re-resolution and its `ImportError('XPATH_NO_MATCH')`
throw move into the compute phase and collapse with the pre-existing
pre-transaction resolution into one resolution (E-049-A — a contract fix, not a
bug fix; behavior-preserving because compute and mutate run back to back with no
awaits on the same document). `createSeededDocument` is its own call site.
Observable behavior — content placement, attribution, error codes and messages,
undo, presence — is unchanged everywhere.

### Phase E — the guards (FR-011/012) and the eight test files (R7)

Re-point G3, G4, G4b and G5 **in place**, keeping their identifiers and their
position in the file, each with a comment recording what it used to assert and
why that changed. G1, G2, the whole H class, G6 and C1 keep their assertions
(C1's callers migrate to the new shape). Add the new pins: own id restored after
every call including a throwing compute phase; a cached id reused by one identity
and never shared across identities; a mint-time collision redrawn; a cached id
another writer advanced discarded; the named loud guard for FR-012. Migrate the
other eight test files. No guard is weakened and each re-pointed guard must still
fail when its invariant is broken.
Map: [contracts/invariant-guards.md](./contracts/invariant-guards.md).

### Phase F — evidence and documentation (FR-012/013/014, Principle I)

The performance guard and the recorded numbers (`performance.md`); the
`docs/dev.md` upgrade checklist; the `server/version-history.js` comment
correction; the SC-008 deliberate-regression check (break struct signing, break
restoration — a named guard must fail, verified by doing it, not assumed).

---

## Key risks and how the design answers them

| Risk | Answer |
| --- | --- |
| A live reader of `doc.clientID` mid-transaction makes the whole mechanism unsafe | Phase A gates everything and stops the line. The window is confirmed real (probed), so this is treated as a live risk, not a formality. |
| A future caller puts throwing work in the mutate phase | The signature makes it a deliberate act (the mutation cannot exist until compute succeeds); the residual is recorded in the design and logged loudly at runtime. Not compensated — option (2) was rejected on cost in the design and this feature does not reopen it. |
| A stale caller passes a bare mutate function | It mutates during compute, and both detectors fire (state vector for inserts, update tripwire for anything including deletes) → loud failure naming the document and identity. Detection is on in production for exactly this reason. |
| The identity cache leaks documents | Doc-keyed `WeakMap`: no release hook to forget. The two prior leaks in this area (041 `peekSharedDoc`, pre-deploy H2) were both forgotten-release shapes. |
| A cached id another writer advanced silently duplicates `(clientId, clock)` | FR-007's clock re-check before every reuse, discarding on mismatch — the analogue of yjs's own self-heal, which a cached borrowed id does not get. |
| A yjs upgrade silently breaks struct signing | The FR-012 named guard fails loudly; the upgrade checklist in `docs/dev.md` requires re-running Phase A before the bump merges; G1/G2 become the load-bearing regression detectors the design says they are. |
| The migration disturbs `acquireReadyDoc` (048 review H1) | It sits immediately above the changed code and is explicitly out of scope; the H class pins it and must pass unchanged. |
| Reentrant borrow permanently corrupts the document's own identity | Refused loudly (RBD-049-5). No caller does this today; the mutate phase is synchronous and does no I/O. |

## Merge-queue notes

- **Depends on 048 being merged** — 049 replaces its mechanism in place and
  re-points its guards.
- **Rides on the same file as the 048 review's H1 fix** — `acquireReadyDoc` is
  untouched but adjacent; a merge that disturbs it is a defect.
- **No migration**, so no ordering constraint against the pending migration queue.
- Verification for the queue: full backend suite (serial), plus the hermetic
  mechanism guards, plus the recorded FR-008 audit and FR-013 numbers as
  artifacts. Phase A's artifact must exist and classify every reader before the
  merge is considered.
- Deploy stays with Sam.

## Complexity Tracking

> Fill ONLY if Constitution Check has violations that must be justified.

*No Constitution Check violations. This feature removes a mechanism (the
ephemeral copy, its seed, its merge-back, and the attach-after-seed ordering
subtlety) and adds one module; it is a net simplification.*
