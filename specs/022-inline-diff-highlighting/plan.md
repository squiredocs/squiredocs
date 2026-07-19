# Implementation Plan: Word-Level Two-Tier Inline Diff Highlighting

**Branch**: `022-inline-diff-highlighting` | **Date**: 2026-07-19 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `/specs/022-inline-diff-highlighting/spec.md`

## Summary

Add GitHub-style word-level, two-tier inline diff highlighting to BOTH diff surfaces —
the chat tool-output diff (`DiffView`, fed by `computeChatDiff`) and the version-history
diff (`VersionPreview`, fed by `computeMarkdownDiff`) — backed by ONE shared
word-segmentation helper so the two surfaces can never disagree about what changed.
Tier 1 keeps today's subtle whole-line/row tint; Tier 2 layers a stronger highlight on
only the changed words. Segmentation is whitespace-preserving (`diffWordsWithSpace` from
the already-installed `diff` ^8.0.4). The chat payload gains one additive field
(`inlineSegments`) with a full backward-compatible fallback; the version diff gains two
service-only marks (`diffInsertWord`/`diffDeleteWord`) plus a cache-version bump (v7→v8).
The characterization-frozen strict markdown parser (CN-2) is NOT modified — word
refinement post-processes its ProseMirror JSON output. No migrations, no new
dependencies, no change to where diffs are computed or to endpoint shapes.

## Technical Context

**Language/Version**: Node.js 22+ (server), React 18 (client). `shared/` modules are
CommonJS (`require`/`module.exports`, e.g. `shared/markdown/strict-parser.js`) — the new
`shared/diff/word-diff.js` MUST follow the same CommonJS style so the server can
`require` it; the client bundler already consumes shared CommonJS.

**Primary Dependencies**: `diff` ^8.0.4 (jsdiff — already installed, already powers both
existing diffs; `diffWordsWithSpace` + `diffLines`); TipTap/ProseMirror (marks); Yjs
(unaffected — refinement runs on read-only diff docs only).

**Storage**: Redis diff cache (keyed by `CACHE_VERSION`; bumped v7→v8). No DB schema
change — chat `inlineSegments` rides existing tool-part persistence; version-diff marks
ride the existing document JSON shape.

**Testing**: Backend Jest (`server/__tests__/`, `server/mcp/__tests__/`) — serial-only,
shared DB (constitution II). Client Vitest (`client/src/**/__tests__/`).

**Target Platform**: Linux server + browser (light + every dark theme variant).

**Project Type**: Web application (Express/y-websocket backend + React/TipTap frontend +
shared logic under `shared/`).

**Performance Goals**: Segmentation cost negligible vs. existing per-diff work (both
surfaces already run full line diffs + markdown parses server-side). No new performance
budget; existing chat-diff size caps (50,000 chars / 200 lines) and version-diff caching
are reused unchanged.

**Constraints**: Strict parser frozen (CN-2) — refinement is post-processing only.
Refinement is best-effort / fail-open per pair (chat) or region (history): any error
degrades to today's line-level presentation, is at most logged, and never fails the diff
request, tool call, chat message, edit, or poisons the cache (RBD-3). Two-tier colors
derive from the existing theme-aware add/remove families (no new hue), legible in light +
every dark variant. Legacy `ychange` path out of scope.

**Scale/Scope**: 1 new shared helper, 1 new server helper, edits to 2 server files
(chat path) + 2 server files (history path) + 3 client files + 2 CSS files + schema/
extensions; 4 existing test suites extended + 1 cache-version assertion updated.

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

| Principle | Assessment |
|-----------|------------|
| **I. Documentation Reflects Reality** | No user-facing behavior in README/dev.md changes materially (diff surfaces exist; this refines their rendering). Parallel-agent overrides forbid editing README.md/docs/dev.md; design ground truth is already amended + exported and is current. PASS. |
| **II. Test-Backed Changes** | Every behavioral change is covered: chat post-process + payload threading, client render, history word-marking, cache-version assertion. Backend serial-only respected. The two new marks are serialization-relevant → the registry-driven round-trip suite (`server/__tests__/format-roundtrip.test.js`) MUST be extended so the marks get bidirectional coverage by construction. PASS (with FR-009 round-trip task). |
| **III. Trunk-Based Solo Workflow** | Stay on branch `main` per overrides; no PR ceremony; no new process. PASS. |
| **IV. Collaboration-Safe Document Operations** | Refinement runs ONLY on read-only, server-built diff documents (never live docs); no Yjs mutation, no delete-and-recreate of live content. Format knowledge stays in the single registry: the two new marks are added to the shared schema + editor extension set (registry-driven), so export/import/editor/agent tooling cannot drift. The node-splitter handling is structural (walk PM text nodes), not positional live-document indexing. New marks are diff-service-provenance-only and never alter live-document behavior. PASS. |
| **V. Secure by Default** | No new ingestion surface, no new endpoint, no script/SVG/image path touched. `inlineSegments` is server-produced from server-computed diffs; the client renders segment text as React text nodes (no HTML injection). No auth/ACL surface added. PASS. |
| **VI. Design Docs Are Ground Truth** | Both 2026-07-19 amendments (pipeline + assistant design docs) are exported to `design/` and this plan converges to them. Open decisions recorded RATIFIED-BY-DEFAULT (RBD-1..4) in `clarifications-needed.md`. No exported doc hand-edited. PASS. |

**Result: PASS — no violations, Complexity Tracking not required.** Re-checked
post-Phase-1 design: still PASS (no new dependencies, no schema migration, no new
endpoints introduced by the design artifacts).

## Project Structure

### Documentation (this feature)

```text
specs/022-inline-diff-highlighting/
├── plan.md              # This file
├── research.md          # Phase 0 output
├── data-model.md        # Phase 1 output (entities: word segment, inlineSegments, marks)
├── quickstart.md        # Phase 1 output (validation guide)
├── contracts/           # Phase 1 output
│   ├── word-diff-helper.md
│   ├── chat-diff-payload.md
│   └── version-diff-marks.md
├── clarifications-needed.md   # RBD ledger (exists)
├── checklists/requirements.md # (exists)
└── tasks.md             # /speckit-tasks output
```

### Source Code (repository root)

```text
shared/
├── diff/
│   └── word-diff.js               # NEW — computeWordSegments(before, after) via diffWordsWithSpace
├── prosemirror-schema.js          # MODIFY (~L412-424) — register diffInsertWord/diffDeleteWord marks
└── markdown/strict-parser.js      # FROZEN (CN-2) — MUST NOT change

server/
├── diff/
│   └── apply-word-marks.js        # NEW — refine a replace region: parse unmarked, segment, split PM text nodes, stamp marks
├── diff-service.js                # MODIFY (~L194-212 replace-region detection; L22 CACHE_VERSION v7→v8)
├── mcp/
│   ├── diff-postprocess.js        # MODIFY (~L132-170) — build inlineSegments in non-format-only paired branch
│   └── diff-utils.js              # MODIFY (~L40-52) — thread inlineSegments + filter on truncatedByServer branch
└── __tests__/
    ├── diff-service.test.js                       # EXTEND — word-mark cases
    ├── markdown-strict-characterization.test.js   # MODIFY (~L69) — assert CACHE_VERSION 'v8'
    └── format-roundtrip.test.js                   # EXTEND — round-trip the two new marks

server/mcp/__tests__/
└── diff-postprocess.test.js       # EXTEND — inlineSegments cases

client/src/
├── extensions/editorExtensions.js # MODIFY (~L80-90 define DiffInsertWord/DiffDeleteWord; ~L120-121 add to getBaseExtensions)
├── components/
│   ├── AiChatMessages.jsx         # MODIFY (DiffView ~L271-345) — render segments as .ai-diff-word spans, plain-string fallback
│   ├── AiPanel.css                # MODIFY — .ai-diff-word strong highlight off --success/--danger families
│   └── VersionPreview.css         # MODIFY (after ~L55-66) — ins.diff-word / del.diff-word strong tokens
├── index.css                      # MODIFY — --canvas-diff-add-bg-strong/--canvas-diff-del-bg-strong in light block (~L130-131) + EVERY dark block (~L209-210, 272-273, 295-296)
└── components/__tests__/AiChatMessages.test.jsx   # EXTEND (~L609 diffOutput fixture) — .ai-diff-word render + fallback
```

**Structure Decision**: Web-application layout. Shared logic (the word-diff helper, the
schema marks) lives under `shared/` per the constitution's shared-logic rule; both diff
paths consume the shared helper server-side (no client-side diff computation is
introduced). The chat path (US1, P1) and history path (US2, P2) are entirely separate
implementations joined only by the shared helper, matching the existing codebase and the
approved plan.

## Complexity Tracking

> Not required — Constitution Check passed with no violations.
