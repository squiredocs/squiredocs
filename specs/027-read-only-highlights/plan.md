# Implementation Plan: Read-Only Highlights — Position Math Never Writes

**Branch**: `027-read-only-highlights` | **Date**: 2026-07-21 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `/specs/027-read-only-highlights/spec.md`

**Design ground truth**: `design/agent-surface-mcp.md`, "Amendment (Sam, 2026-07-21) — reads never write" (commit 6bacaf7). Constitution Principles IV (Collaboration-Safe Document Operations) and VI (Design Docs Are Ground Truth).

## Summary

The presence-position helpers in `server/mcp/yjs/cursor-operations.js` insert an empty `Y.XmlText` placeholder into a text-less block (empty paragraph, image, horizontal rule, empty document) so they have a text node to anchor a Yjs `RelativePosition` to. That insertion is a real, persisted, agent-attributed document edit produced by a read-only operation — polluting version history and attribution and breaching the read/write boundary.

The fix removes the two insertion sites (`createCursorPosition` lines 68–72; `createCursorPositionFromPath` lines 595–599) and replaces the "create a text node" fallback with **element-boundary anchoring**: `Y.createRelativePositionFromTypeIndex(targetElement, 0)`, which references the (empty) element type itself at child index 0 and writes nothing. Because both public helpers, and everything built on them (`createNodeSelection`, `createExpandingBlockHighlights`, `createOperationSelection`, `createBlockRangeSelection`), route their text-less handling through these two branches, the invariant becomes true on every path — read highlights, query-scoped node selections, whole-document expanding sweeps, operation selections, and mutation cursor sweeps — with no mode flag.

No schema, API/tool-contract, client, or awareness-transport change. The riskiest correctness point is confirming that a boundary-anchored position resolves non-null through **y-prosemirror's** `relativePositionToAbsolutePosition` on a live replica (the client viewer's resolution path), which is written as a mandatory verification test.

## Technical Context

**Language/Version**: Node.js 22+ (server); Yjs `^13.6.27` server-side, `^13.6.8` client-side; y-prosemirror `^1.2.0`.

**Primary Dependencies**: `yjs` (`Y.createRelativePositionFromTypeIndex`, `Y.createAbsolutePositionFromRelativePosition`, `Y.relativePositionToJSON/FromJSON`); y-prosemirror (`relativePositionToAbsolutePosition`, `ySyncPluginKey`) for the client-resolution-parity test only; y-websocket presence transport (unchanged).

**Storage**: PostgreSQL update log (`yjs_updates` / persisted CRDT updates) and version-history query surfaces — asserted-against, not modified. No migration.

**Testing**: Jest (`server/mcp/__tests__/`, `server/__tests__/`). Backend suites share one DB and run serially (Constitution II). Implementer uses a per-agent DB `collab_test_db_027` in a worktree; jest config ignores `/.claude/worktrees/`, so a temp jest config / `rootDir` override plus `--forceExit` is required (prior-feature workaround).

**Target Platform**: Linux server (Minikube `app-dev` pod).

**Project Type**: Web application — server-side MCP presence subsystem. This feature is server-only.

**Performance Goals**: No perf change. Boundary anchoring is O(1) vs. the current O(1) insert; sweeps unchanged in step count.

**Constraints**: Position math MUST be side-effect-free on every path (FR-001). Text-bearing positions MUST be byte-identical to today (FR-005/SC-004). No client changes (FR-007). CRDT discipline preserved (FR-008).

**Scale/Scope**: Two edited functions in one file; ~5 consumer functions inherit the fix transitively; one latent-behavior test file to re-pin; new regression/integration tests. No production data affected (presence positions are ephemeral, never persisted).

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

- **I. Documentation Reflects Reality** — PASS. No README/dev.md behavior change (internal mechanism; presence positions are ephemeral). Design doc is already amended (ground truth, commit 6bacaf7); no further doc edit owed. Parallel-safe override forbids editing CLAUDE.md/README.md/docs/dev.md anyway.
- **II. Test-Backed Changes** — PASS (and central). The invariant is enforced by tests: zero-new-update-rows after reads (integration), pure mutation sweeps, byte-identical text-path positions (regression corpus), and a live-replica resolvability test using the client's y-prosemirror resolution semantics. The one existing test that pins the buggy placeholder insertion (`cursor-operations-empty-blocks.test.js`) is honestly re-pinned to the new invariant, not deleted. No format-registry/round-trip surface touched.
- **III. Trunk-Based Solo Workflow** — PASS. PARALLEL-SAFE OVERRIDE in force: stay on `main`, no branch/commit/push, implementer works in a worktree via the pipeline.
- **IV. Collaboration-Safe Document Operations** — PASS, strongly reinforced. The change *removes* the only wholesale content mutation on the read path. No delete-and-recreate; structural (XPath/path) targeting unchanged; existing relative-position adjustment under concurrent edits preserved; provenance restored (agent no longer appears as author of docs it only read). This feature exists to satisfy Principle IV.
- **V. Secure by Default** — PASS. Closes a privilege-boundary hole: a read-scoped credential could previously cause a persisted write. No new ingestion surface.
- **VI. Design Docs Are Ground Truth** — PASS. Implements the 2026-07-21 amendment verbatim ("position math itself never writes"); the four judgment calls are recorded RATIFIED-BY-DEFAULT (D-1..D-4) in `clarifications-needed.md`.

**No violations. Complexity Tracking table not required.**

Post-Phase-1 re-check: still PASS. The chosen construction adds no new dependency, no mode flag, no client change, and no schema change; it strictly narrows behavior (removes writes) while preserving text-path output.

## Project Structure

### Documentation (this feature)

```text
specs/027-read-only-highlights/
├── plan.md              # This file
├── research.md          # Phase 0 output — anchoring construction decision + resolver-parity analysis
├── data-model.md        # Phase 1 output — presence-position shape (no persisted schema)
├── quickstart.md        # Phase 1 output — how to reproduce the bug + validate the fix
├── clarifications-needed.md   # D-1..D-4 RATIFIED-BY-DEFAULT (pre-existing)
├── checklists/requirements.md # spec quality checklist (pre-existing)
└── tasks.md             # Phase 2 output (/speckit-tasks)
```

### Source Code (repository root)

```text
server/mcp/
├── yjs/
│   └── cursor-operations.js        # EDIT: two text-less branches → element-boundary anchoring
│                                   #   createCursorPosition (L52-77), createCursorPositionFromPath (L580-605)
├── tools/
│   └── read-document.js            # Consumer (read highlight path) — unchanged code; behavior asserted
├── mutation-aggregator.js          # Consumer (mutation sweep) — unchanged code; behavior asserted
├── sandbox/
│   └── bridge.js                   # Consumer (createOperationSelection) — unchanged code; behavior asserted
└── agent-presence.js               # queueHighlightSequence / awareness transport — untouched

client/src/components/
└── CollaborationCursorWithSelection.js  # OUT OF SCOPE — resolver untouched; parity is asserted, not changed

server/mcp/__tests__/
├── yjs/cursor-operations-empty-blocks.test.js   # RE-PIN to no-write + boundary-resolvable
├── yjs/cursor-operations-boundary.test.js       # NEW: byte-zero + resolvable unit tests (all text-less shapes)
├── yjs/cursor-operations-resolver-parity.test.js # NEW: y-prosemirror relativePositionToAbsolutePosition non-null
├── yjs/cursor-operations-textpath-regression.test.js # NEW: byte-identical text-path positions (FR-005/SC-004)
└── integration/read-zero-writes.test.js         # NEW: P1 acceptance — zero update rows / clock / author after reads
```

**Structure Decision**: Single server-side module change (`server/mcp/yjs/cursor-operations.js`) with consumer-behavior assertions and new test suites under the existing `server/mcp/__tests__/` tree. No new directories, no client tree changes.

## Chosen Anchoring Construction (Phase 0 result, summarized)

For a target element with no text run, anchor at the element boundary with
`Y.createRelativePositionFromTypeIndex(targetElement, 0)` (default assoc), where
`targetElement` is the empty `Y.XmlElement` itself. Verified locally: writes **0
bytes**, inserts **no** child, and resolves **non-null** at index 0 via
`Y.createAbsolutePositionFromRelativePosition`. See `research.md` for the
alternatives (fragment-index anchor; skip-the-block) and why they were rejected,
and for the mandatory y-prosemirror live-replica parity check.

## Complexity Tracking

> No Constitution Check violations — table intentionally empty.

| Violation | Why Needed | Simpler Alternative Rejected Because |
|-----------|------------|-------------------------------------|
| — | — | — |
