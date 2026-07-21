# Implementation Plan: Clean Hard-Break Rendering in Transcript Diffs

**Branch**: `028-clean-diff-hard-breaks` | **Date**: 2026-07-21 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `/specs/028-clean-diff-hard-breaks/spec.md`

## Summary

Assistant edits of hard-broken content (poem stanzas, etc.) render in the chat
transcript's inline diff with a literal trailing `\` on every hard-broken line,
because the diff payload is computed from canonical markdown where a `hardBreak`
serializes as a backslash-before-newline (serialization syntax, not content).

The fix removes that marker at diff-payload **generation time** on the server,
keyed on the serializer's own grammar. A new pure helper
`stripHardBreakMarkers(markdown)` in `server/mcp/diff-utils.js` normalizes each
of the two full canonical serializations **before** they reach `structuredPatch`
(RBD-2). Because both diff-producing card types — modify
(`server/mcp/tools/modify.js:512`) and the shared 020 undo/redo handler
(`server/undo/undo-service.js:77`) — build their payload through the single
`computeChatDiff` entry point, one cleanup point covers both by construction
(FR-005). Word-level segments (022) and format-only detection are computed
downstream from the same cleaned text, so they stay consistent for free (FR-004).

The serializer, `server/diff/*` (version history), `shared/diff/word-diff`, and
all client code are untouched (FR-008). Legacy persisted payloads keep their
markers and render exactly as today (FR-007). No migrations, no new dependencies,
no payload-shape changes.

## Technical Context

**Language/Version**: Node.js 22+ (CommonJS server modules)

**Primary Dependencies**: `diff` (npm, `structuredPatch`) — already a dependency;
no new packages. In-house registry-driven serializer (`server/mcp/yjs/serialization.js`).

**Storage**: N/A — this feature adds no persistence and no schema change. Diff
payloads are computed on the fly and embedded in tool-part results.

**Testing**: Jest. Extend `server/mcp/__tests__/diff-postprocess.test.js` (already
imports both `postProcessDiffLines` and `computeChatDiff`). Backend suite is
serial-only against a shared DB; the implementer runs in a worktree with
`collab_test_db_028` (plus the worktree jest-config workaround and `--forceExit`).

**Target Platform**: Linux server (Minikube `app-dev` pod).

**Project Type**: Web service (Squire Docs backend); single-file logic change plus tests.

**Performance Goals**: No regression. `stripHardBreakMarkers` is a single O(n) line
scan over each already-materialized markdown string, run once per diff — negligible
next to the existing `structuredPatch`. The existing `MAX_DIFF_CHARS`/`MAX_DIFF_LINES`
caps are unchanged; cleanup only removes characters within lines, never lines.

**Constraints**: Byte-identical output for the version-history pipeline (FR-008,
SC-006); byte-identical rendering of legacy payloads (FR-007, SC-005); zero client change.

**Scale/Scope**: One new exported pure function (~40 LOC) in `diff-utils.js`, two
call-site lines in `computeChatDiff`, and a new test block. No other files change.

## Constitution Check

*GATE: evaluated against `.specify/memory/constitution.md` v1.1.1.*

- **I. Documentation Reflects Reality**: PASS. No behavior described in `README.md`
  or `docs/dev.md` changes (diff cleanup is internal to the chat pipeline; no
  workflow, API, or feature surface changes). Design ground truth is the amended
  `design/in-app-ai-assistant.md` (commit 19887fa), which this plan converges to
  and cites rather than re-deciding. No doc edits required by this feature.
- **II. Test-Backed Changes**: PASS. Every behavioral change is covered by new
  cases extending the established `diff-postprocess.test.js` suite (SC-007). This is
  not a format/serialization change (the serializer is explicitly untouched,
  FR-008), so the round-trip suite is not in scope — but the new predicate is
  grammar-derived from that serializer and cross-checked against it in research.md.
  Backend suite runs serially.
- **III. Trunk-Based Solo Workflow**: PASS. Single-file logic change; no new ceremony.
  (Pipeline overrides for this parallel run: stay on `main`, no branch/commit/push.)
- **IV. Collaboration-Safe Document Operations**: PASS. No document mutation
  whatsoever — this operates only on already-serialized markdown strings destined
  for a display payload. No Yjs tree access, no delete-and-recreate, no attribution
  path touched. Format knowledge stays in the registry/serializer, which is unchanged;
  the cleanup mirrors the serializer's emission grammar rather than duplicating format
  knowledge (see research.md R2 for the anti-drift argument).
- **V. Secure by Default**: PASS. No new ingestion surface, no script execution, no
  auth/ACL/URL surface. Input is server-produced canonical markdown; output is a
  strict subset with characters removed. No sanitizer boundary crossed.
- **VI. Design Docs Are Ground Truth**: PASS. Converges to the 2026-07-21 amendment
  (RATIFIED, commit 19887fa). Residual interpretation calls are ledgered as
  RBD-1..RBD-3 (RATIFIED-BY-DEFAULT, Sam pre-authorized). No exported design file is
  hand-edited.

No violations → Complexity Tracking is empty. Re-check after Phase 1 design: still
PASS (the design confirms a single pure helper at one call site, no new modules,
no dependency, no cross-cutting surface).

## Project Structure

### Documentation (this feature)

```text
specs/028-clean-diff-hard-breaks/
├── spec.md                     # Feature spec (input)
├── clarifications-needed.md    # RBD-1..RBD-3 ledger (input)
├── checklists/requirements.md  # Spec quality checklist (input)
├── plan.md                     # This file (/speckit-plan output)
├── research.md                 # Phase 0 output — mechanism, predicate, grammar proof
├── quickstart.md               # Phase 1 output — how to verify locally
└── tasks.md                    # Phase 2 output (/speckit-tasks)
```

**data-model.md / contracts/**: intentionally omitted. This feature introduces no
new entities, no persisted state, and no request/response contract — it alters the
text content of an existing internal payload only. The "Key Entities" in the spec
(hard-break marker, paragraph-like block, fenced block, cleaned diff input) are
descriptive grammar concepts, fully captured in research.md; there is nothing to model.

### Source Code (repository root)

```text
server/mcp/
├── diff-utils.js              # CHANGED: add exported stripHardBreakMarkers(md);
│                              #   computeChatDiff cleans BOTH inputs before structuredPatch
├── diff-postprocess.js        # UNCHANGED (022 span-strip, format-only, word segments)
├── tools/modify.js            # UNCHANGED — line 512 already calls computeChatDiff
└── __tests__/
    └── diff-postprocess.test.js  # CHANGED: add stripHardBreakMarkers unit block +
                                  #   computeChatDiff integration/regression cases

server/undo/undo-service.js    # UNCHANGED — line 77 already calls computeChatDiff
server/mcp/yjs/serialization.js # UNCHANGED (FR-008; the emission grammar this predicate mirrors)
server/diff/*                   # UNCHANGED (FR-008; version-history pipeline, SC-006)
shared/diff/word-diff.js        # UNCHANGED (FR-008; shared word-segmentation helper)
client/**                       # UNCHANGED (FR-001/FR-007; no client stripping, no render change)
```

**Structure Decision**: Web-service backend, single-point change. The helper lives
in `server/mcp/diff-utils.js` beside `computeChatDiff` — the one function both card
types already route through (verified: `modify.js:512`, `undo-service.js:77`) — so
placement guarantees FR-005's "no producer can bypass it" without touching either
caller. Exporting the helper makes it unit-testable in isolation (Phase 0 R3),
independent of the full diff pipeline. **Concurrency note**: a parallel implementer
owns `server/mcp/yjs/cursor-operations.js` and `specs/027-*`; this plan touches
neither — the two file sets are disjoint (spec Dependencies §, FR-008).

## Complexity Tracking

*No Constitution violations — table intentionally empty.*
