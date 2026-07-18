# Implementation Plan: Log-Derived Agent-Edit Undo/Redo

**Branch**: `016-log-derived-undo` | **Date**: 2026-07-18 | **Spec**: [spec.md](spec.md)

**Input**: Feature specification from `/specs/016-log-derived-undo/spec.md`, design
ground truth `design/collaboration-core.md` ("Version history" amendment, Sam,
2026-07-18) and `design/agent-surface-mcp.md` (cross-reference amendment), decisions
ledger `clarifications-needed.md` (RBD-1..7 pre-existing; RBD-8..10 added at plan
stage).

## Summary

Agent-edit undo/redo stops depending on the presence session's in-memory
`Y.UndoManager` and becomes log-derived and stateless: every content-changing `modify`
records a durable clock-range identifier for exactly its own rows in `yjs_updates`
(post-durability, RBD-1/FR-004); undo rebuilds a gc-off scratch doc from the log,
replays the target range through a **replica `Y.UndoManager`** (the edit's rows as the
one tracked stack item), and pops it — yielding the exact popStackItem-equivalent
surgical inverse as a single normal update, which is stored with attribution and
applied to the live shared doc via the established store-then-apply sentinel pattern
(broadcast + Redis fan-out, no double-store, no session). Redo inverts the inverse
from its own recorded range; a new `agent_edits` table is both the durable inverse
record and the at-most-once claim guard. Both surfaces (chat button endpoints and MCP
`undo`/`redo` tools) converge on this one core. Full mechanics and justification:
[research.md](research.md) R1–R10.

## Technical Context

**Language/Version**: Node.js 22+ (CommonJS server), React 18 client

**Primary Dependencies**: yjs 13.6.30 (public API only: `UndoManager`, `applyUpdate`,
`encodeStateVector`, `encodeStateAsUpdate`, `decodeUpdate`, `parseUpdateMeta`,
`mergeUpdates`, `getState`), y-websocket, Express, pg / node-pg-migrate. **No new
external dependencies.**

**Storage**: PostgreSQL — existing `yjs_updates` append-only log (read-only input;
never mutated); one new table `agent_edits` (migration `1796000000000_*`, the only
in-flight feature adding migrations; timestamp must exceed 1795000000000 per the
retired-008 phantom-row constraint). Redis only via the existing pub/sub fan-out.

**Testing**: Backend Jest (`server/**/__tests__`), serial only (shared test DB);
client Vitest (`client/src/**/__tests__`). Heavy Yjs fixtures acceptable.

**Target Platform**: Linux server (multi-replica k8s, non-sticky routing) + browser
client

**Project Type**: Web application (Express server + React client, existing layout)

**Performance Goals**: undo-status poll stays cheap (2 indexed lookups; SC-007, 30 s
per open chat); modify's identifier recording adds no user-perceptible latency
(bounded durability wait, typically one DB round-trip — SC-010); inverse computation
is a full-log gc-off rebuild, same cost class as the existing diff/restore paths.

**Constraints**: correctness under fully non-sticky routing and restarts (SC-001/002);
at-most-once inverse application (FR-028); no presence session created or touched by
undo/redo/status (FR-008, SC-006); history never rewritten (SC-009); backend tests
serial.

**Scale/Scope**: beta-scale documents (full-log replay already standard in diffs,
restore, version history); 2-replica production cluster.

## Constitution Check

*GATE: evaluated against constitution v1.1.1 before Phase 0; re-checked after Phase 1
design — PASS, no violations to track.*

- **I. Documentation Reflects Reality**: README's agent-surface/undo description and
  any dev-doc mention of session-bound undo must be updated in the same effort —
  tasked explicitly (tasks Polish phase). PASS with task.
- **II. Test-Backed Changes**: every behavioral change carries tests (semantics
  matrix, redo chains, concurrency, legacy, parity, access, client button); backend
  suites run serially against the shared DB. No new marks/nodes/serialization — the
  format round-trip registry is untouched. PASS.
- **III. Trunk-Based Solo Workflow**: no new ceremony; work stays on the feature's
  existing pipeline branch; no PR machinery added. PASS.
- **IV. Collaboration-Safe Document Operations**: the entire feature is targeted
  in-place transformation — the inverse addresses structs by CRDT identity (stronger
  than structural targeting; no positional indexing anywhere), never
  delete-and-recreates wholesale, and preserves attribution/provenance (FR-026: the
  inverse is a normally-attributed update). PASS.
- **V. Secure by Default**: no new ingestion surface — the inverse only re-materializes
  content that already passed a write boundary's sanitizers (spec "Untrusted-content
  replay" edge; the existing deliberate no-resanitize decision is preserved and its
  comment kept). Endpoints keep auth + editor-role ACLs, now enforced without session
  creation (FR-025); MCP scopes unchanged (`documents:write`). PASS.
- **VI. Design Docs Are Ground Truth**: mechanics follow the 2026-07-18 amendments
  verbatim; every decision the amendment left open is ledgered (RBD-1..7 pre-plan,
  RBD-8..10 added by this plan — durability-wait posture, supersession-evaluation
  basis, legacy run segmentation). No design-doc hand-edits. PASS.
- **Technology & Architecture Constraints**: schema change via node-pg-migrate; no
  third-party markdown/serialization dependency; no AI-provider surface touched;
  nothing belongs in `shared/` (server-only mechanics). PASS.

**Post-Phase-1 re-check** (2026-07-18): data model adds exactly one table; contracts
keep the 16-tool MCP surface and existing endpoint shapes (additive result fields
only). Still PASS; Complexity Tracking left empty.

## Project Structure

### Documentation (this feature)

```text
specs/016-log-derived-undo/
├── plan.md              # This file
├── research.md          # Phase 0 — CRDT strategy R1-R11
├── data-model.md        # Phase 1 — agent_edits, identifiers, records, migration
├── quickstart.md        # Phase 1 — validation guide
├── contracts/
│   ├── http-undo-api.md      # POST /undo, /redo; GET /undo-status
│   └── mcp-undo-redo-tools.md # modify result additions; undo/redo tool contracts
└── tasks.md             # Phase 2 (/speckit-tasks — not created by /speckit-plan)
```

### Source Code (repository root)

```text
migrations/
└── 1796000000000_create-agent-edits.js   # NEW — agent_edits table + indexes

server/
├── origin.js                              # + ORIGIN_INVERSE_APPLY sentinel
├── postgres-persistence.js                # storeUpdate: optional external client
├── undo/                                  # NEW — the log-derived core
│   ├── inverse.js                         # scratch-doc replica-UndoManager inverse (R1)
│   ├── edit-records.js                    # agent_edits access: record/claim/queries (R5,R6)
│   ├── legacy.js                          # pre-016 range derivation (R7)
│   ├── undo-service.js                    # performUndo/performRedo/getUndoStatus
│   └── __tests__/
│       ├── inverse.test.js                #   semantics matrix (US2)
│       ├── edit-records.test.js           #   claims, LIFO, at-most-once
│       └── legacy.test.js                 #   honest degradation (US5/SC-011)
├── mcp/
│   ├── agent-presence.js                  # retire undoManager + getUndoRedoAvailability
│   ├── yjs/edit-range.js                  # NEW — capture + durability verify (R2)
│   ├── tools/
│   │   ├── modify.js                      # editRange recording + result field
│   │   ├── undo-redo-handler.js           # rewritten thin shared handler → undo-service
│   │   ├── undo.js / redo.js              # descriptions + result shape (RBD-5)
│   └── __tests__/
│       ├── yjs/edit-range.test.js
│       ├── tools/modify-edit-range.test.js
│       └── integration/undo-redo-workflow.test.js  # rewritten end-to-end (US1-US4)
├── index.js                               # endpoints: undo/redo passthrough, undo-status rewrite
└── __tests__/undo-status-api.test.js      # NEW — endpoint tests (US5)

client/src/components/
├── AiChatMessages.jsx                     # UndoEditButton: comments, honest-empty UX
└── __tests__/AiChatMessages.test.jsx      # extended button tests
```

**Structure Decision**: existing web-app layout (flat `server/` + `client/src/`); the
only new directory is `server/undo/`, holding the one shared core both surfaces call —
mirroring how sibling mechanisms (`diff-service.js`, `version-history.js`) live as
top-level server modules.

## Complexity Tracking

*No Constitution Check violations — table intentionally empty.*
