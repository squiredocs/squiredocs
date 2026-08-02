# Implementation Plan: Presence Awareness Guard

**Branch**: `044-presence-awareness-guard` | **Date**: 2026-08-02 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `/specs/044-presence-awareness-guard/spec.md`

## Summary

A connected participant of any role can today hand-craft a Yjs awareness frame carrying
**another** participant's clientID and either overwrite their displayed name/colour or evict
their presence outright, fanned out to every connection and across instances — the MEDIUM
the 038 post-merge reviewer reproduced and deferred.

The fix adds one orthogonal check on the frame-interception point 038 already owns: an
awareness frame arriving on a client WebSocket may assert only clientIDs that connection
legitimately controls — its own, an unclaimed one, or one held by another connection of the
**same authenticated user**. Anything else drops the whole frame, silently, with a
rate-suppressed `WS_AWARENESS_BLOCKED` event. Ownership is first-writer-wins, read from the
per-connection controlled-id set `y-websocket` already maintains for presence eviction, so
no second identity model appears. Detection and drop only — no disconnects, no re-encoding,
no new message plumbing, no schema change.

**Technical approach**: a new `server/ws-awareness-guard.js` holds the payload parser, the
ownership rule, and the per-connection log suppressor; `server/ws-edit-gate.js`'s
`installGate` gains two optional handlers (`getConns`, `principalOf`) and calls the guard for
awareness frames; `server/index.js` wires a lazily-resolved doc handle into the gate, since
the gate is installed before the doc exists. Edit classification is untouched.

## Technical Context

**Language/Version**: Node.js 22+ (CommonJS server)

**Primary Dependencies**: `y-websocket` (`bin/utils` — `WSSharedDoc.conns`,
`setupWSConnection`, `closeConn`), `y-protocols/awareness` (`applyAwarenessUpdate`),
`lib0/decoding` (the decode primitives that define correctness here), `ws`

**Storage**: **none** — awareness is ephemeral in-memory state. No migrations, no schema
change, no `yjs_updates` involvement.

**Testing**: Jest. Unit (`server/__tests__/`) + protocol-level integration
(`__tests__/integration/`). Backend suites are serial against a shared DB; the new
integration suite needs **no** DB.

**Target Platform**: Linux server (k3s), single or multi-instance behind Redis pub/sub

**Project Type**: Web service — server-side change only. **No client changes.**

**Performance Goals**: SC-004 — no perceptible latency on honest awareness traffic. The
common path is one `Set.has` on top of a decode the applier performs anyway (research R8).

**Constraints**: The guard's view of which ids a frame asserts must never be narrower than
the applier's (FR-003, and research R2 for the non-atomic-applier corollary). Zero
false-positive drops on the FR-006 legitimate cases. No disconnects, no client notification.

**Scale/Scope**: Two new/changed server modules, one wiring change, three test files.
Awareness frames fire per cursor move and per 15 s heartbeat, on connections in the single
digits to low tens per document.

**Sequencing**: 044 implements **third**, branching from `main` after 041 and 042 merge —
both touch `server/index.js`. Every `server/index.js` reference in these artifacts is
symbol-anchored (`wss.on('connection')` handler, the `installGate(` call, the
`getYDoc(wsDocName, true)` line, the 038 US5 presence-cleanup comment block) precisely
because the line numbers **will** have moved by then.

## Constitution Check

*GATE: evaluated against `.specify/memory/constitution.md` v1.1.1. Re-checked after Phase 1.*

| Principle | Assessment |
|---|---|
| **I. Documentation Reflects Reality** | `README.md`/`docs/dev.md` describe no user-visible behavior this changes (presence still "just works"; the guard is invisible to honest traffic) and are **out of this agent's edit scope** per the pipeline overrides. The `server/index.js` comment block recording 038 US5's parser deletion **must** be updated (contract §6) — leaving it would tell the next reader the deleted bug was resurrected. **PASS.** |
| **II. Test-Backed Changes** | Three layers, mirroring 038: unit against the real exported module, protocol-level integration through the real `installGate` wiring with hand-crafted bytes (including non-canonical varints), and structural drift guards on `server/index.js`. New integration suite needs no DB; the rest stays serial. **PASS.** |
| **III. Trunk-Based Solo Workflow** | Runs on the standard pipeline: worktree branch → serial merge queue → post-merge adversarial review. No new ceremony. **PASS.** |
| **IV. Collaboration-Safe Document Operations** | The feature never touches document content — awareness frames are explicitly not edits and never reach `Y.applyUpdate` (037 invariant). Attribution is unaffected. It *protects* a provenance surface (who is displayed as present). **PASS.** |
| **V. Secure by Default for Agent & User Content** | This is the principle the feature serves. The spec states the trust boundary (§Context) before implementation, as required for an ingestion surface: an awareness frame on a client socket is untrusted input. The parser is total and throw-free on hostile input and re-encodes nothing. **PASS.** |
| **VI. Design Docs Are Ground Truth** | `design/collaboration-core.md` line 14 documents presence-as-awareness and eager disconnect eviction; this feature changes **no** documented mechanism — it constrains who may assert an id, which the doc never spoke to. Adding that constraint to the doc is nonetheless worth doing; recorded as **owed to Sam** below (design/ is export-only — amend the Squire doc, then `node design/sync.mjs`; agents must not hand-edit). All four open decisions carry RATIFIED-BY-DEFAULT entries in `clarifications-needed.md`; the two new plan-time decisions are recorded below rather than taken silently. **PASS.** |

**Result: PASS, no violations.** Complexity Tracking table is empty by design.

## Decisions taken at plan time

Both refine the spec rather than contradict it; both are flagged for post-merge review.

### D-044-1 — A decodable *prefix* asserts its ids, even when the frame is truncated

`applyAwarenessUpdate` is **not atomic**: it decodes and applies entries in a loop, so a
failure on entry *N* leaves entries *1..N-1* applied, and `messageListener`'s `try/catch`
swallows the throw. A literal reading of the spec's "undecodable ⇒ the guard treats it as
asserting no ids and lets the applier's own handling stand" would therefore let
`[spoof of Ca][garbage]` through *and let the spoof land*.

**Decision**: parse incrementally; every clientID decoded before a failure counts as
asserted. A frame that fails before a single complete entry still asserts nothing and passes
through — the case the spec was actually describing, preserved. `truncated` is reported but
never shrinks the id set. (Research R2; covered by the truncated-tail-smuggle test.)

### D-044-2 — The guard reads the state string but does not `JSON.parse` it

The applier does `JSON.parse(readVarString(...))`; the guard only calls `readVarString` to
advance the decoder. The guard therefore sees ids in entries whose state is invalid JSON,
which the applier would never reach — a **superset**, i.e. conservative in the safe
direction. The only cost is a theoretical false-positive drop on a frame no honest client
can emit (every client encodes via `encodeAwarenessUpdate`, which `JSON.stringify`s), and it
keeps per-cursor-tick JSON parsing off the hot path (SC-004). (Research R3.)

## Approach

**1. New module `server/ws-awareness-guard.js`** — the security logic, unit-testable in
isolation: `parseAwarenessFrame`, `evaluateAwarenessFrame`, `createDropSuppressor`,
`AWARENESS_BLOCKED_EVENT`, `AWARENESS_BLOCK_LOG_WINDOW_MS`. Full signatures and invariants
in [contracts/awareness-ownership-guard.md](./contracts/awareness-ownership-guard.md).

*Why a separate module rather than growing `ws-edit-gate.js`*: that file's header states
"Nothing here parses frame payloads beyond the two header varints." Awareness ownership is
payload parsing. Splitting keeps each module's stated invariant true while preserving **one**
interception point — `installGate` still owns the `ws.emit` wrapper and simply calls into the
guard. The edit gate's header note gains a pointer to the new module.

**2. `server/ws-edit-gate.js`** — `installGate` accepts optional `getConns` and
`principalOf`. Per frame: edit classification first (038, unchanged), then, for
non-edit awareness frames with a resolvable conns Map, parse → evaluate → drop. Both
handlers are optional, so every existing caller and test keeps working byte-for-byte.

**3. `server/index.js`** — a `let sharedDoc = null` above the `installGate(` call,
`getConns: () => (sharedDoc ? sharedDoc.conns : null)` passed in, and `sharedDoc = doc`
assigned right after the existing `getYDoc(wsDocName, true)`. The gate is installed before
`setupWSConnection` and must stay there (038's wiring and its C1 guards); resolving the doc
lazily is what makes that possible. A `null` return means the frame cannot reach any applier
yet — there is no `conn.on('message')` listener until `setupWSConnection` runs — so
pass-through is safe. `onBlocked` learns the new event name. The 038 US5 comment block is
amended per contract §6.

**4. FR-008 needs no code.** The Redis relay calls `applyAwarenessUpdate` directly with
`ORIGIN_REDIS` and never traverses `ws.emit`; it is exempt by construction. Covered by a test
that pins the exemption, not by an implementation task (research R7).

**5. Tests**, mirroring 038's three layers — see
[quickstart.md](./quickstart.md) for the full scenario matrix.

## Project Structure

### Documentation (this feature)

```text
specs/044-presence-awareness-guard/
├── plan.md                                  # This file
├── spec.md
├── clarifications-needed.md                 # Q1-Q4, RATIFIED-BY-DEFAULT
├── research.md                              # Phase 0 — R1-R10
├── data-model.md                            # Phase 1 — in-memory entities only
├── quickstart.md                            # Phase 1 — run + validation scenarios
├── contracts/
│   └── awareness-ownership-guard.md         # Phase 1 — frame disposition table + module API
├── checklists/
└── tasks.md                                 # Phase 2 (/speckit-tasks)
```

### Source Code (repository root)

```text
server/
├── ws-awareness-guard.js        # NEW — parser, ownership rule, drop suppressor
├── ws-edit-gate.js              # CHANGED — installGate gains getConns/principalOf
├── index.js                     # CHANGED — lazy doc handle into the gate; onBlocked;
│                                #           038 US5 comment block amended
└── __tests__/
    ├── ws-awareness-guard.test.js   # NEW — unit: parse / evaluate / suppress
    └── ws-edit-gate.test.js         # CHANGED — awareness interceptor cases + C1 guards

__tests__/integration/
└── awareness-spoof-block.test.js    # NEW — real frames, real installGate, no DB
```

**Structure Decision**: Server-only change inside the existing flat `server/` module layout,
alongside the 038 gate it extends. No client, shared, or migration surface. The one new
module exists to keep `ws-edit-gate.js`'s "no payload parsing" invariant honest while
retaining a single frame-interception point.

## Risks & mitigations

| Risk | Mitigation |
|---|---|
| A false positive breaks real presence (worse than the cosmetic gap it closes — spec US2) | Every FR-006 case is an explicit integration assertion, plus a whole-scenario "zero `WS_AWARENESS_BLOCKED`" check. The same-user tie-break is tested against its own negative (same conditions, *different* user ⇒ dropped). |
| Guard/applier drift — the 038 failure mode, three times over | Same `lib0/decoding` primitives; non-minimal varints tested at both unit and protocol level; D-044-1 keeps the guard's id set a superset of the applier's; structural C1 guards pin the wiring. |
| Merge conflict in `server/index.js` after 041/042 | Every reference symbol-anchored, never line-numbered. The `server/index.js` diff is deliberately tiny (one `let`, one handler arg, one assignment, one `onBlocked` branch, one comment block). |
| Log-volume incident from a spoof flood | Per-connection suppressor, first-then-windowed, counts carried in the payload; unit-tested with an injected clock. |
| `ws.userId` missing on some connection shape turns the tie-break into a bypass | `null`/`undefined` principals never match, on either side. Explicit unit case. |
| Reviewer misreads the reintroduced parser as 038 US5's deleted bug | Contract §6 plus the amended comment block in `server/index.js` state the difference: the deleted code guessed *the sender's* id from a broadcast-about-others; this asks *which ids the frame asserts*, which is what such a frame does tell you. Eviction still comes solely from `closeConn`. |

## Owed / follow-ons (not gating merge)

- **Design-doc amendment (Sam)**: add the ownership constraint to the presence bullet of the
  Squire source doc behind `design/collaboration-core.md`, then `node design/sync.mjs`.
  Agents must not hand-edit the export (Constitution VI).
- **Manual presence walk (Sam, post-deploy)**: quickstart §"Manual check" — two-browser
  presence, agent avatar, reconnect flicker, and a `grep WS_AWARENESS_BLOCKED` on a day of
  prod logs (expected count: zero).
- **Pre-existing, out of scope**: the same-user reconnect race can transiently evict the
  reconnected client's own presence (≤15 s, self-healing) because `y-websocket` only records
  `added` ids into a connection's controlled set. Not caused by this feature, and the guard
  deliberately does not "fix" it by writing to `doc.conns` (research R4).

## Complexity Tracking

> No Constitution Check violations. Table intentionally empty.
