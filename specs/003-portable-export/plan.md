# Implementation Plan: Portable Export (M3)

**Branch**: `003-portable-export` | **Date**: 2026-07-13 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `/specs/003-portable-export/spec.md`

**Note**: This plan is executed by a single Opus worktree implementer. It plans against feature 001's
spec as the base (001 lands first and may relocate the parser + format registry under `shared/`; see
Technical Context). Ratified-by-default decisions live in [clarifications-needed.md](./clarifications-needed.md)
(RD-1…RD-10) and are settled — do not reopen.

## Summary

Make Squire's markdown export a good Git-repo citizen across five self-contained increments: (1) real
GFM **task lists** end to end — a new `taskList`/`taskItem` schema pair, editor extensions, serializer
case, parser branch (upgrading 001's degrade-to-bulletList seam), and an `appendBlocks` block type;
(2) an opt-in **`portable` flavor** that degrades HTML-only marks (underline→emphasis, highlight→bold,
styled spans→plain text) per registry-declared degradation rules, never doubling delimiters; (3) a
`squire:` **YAML frontmatter** block plus a parser strip/preserve contract (foreign keys survive
verbatim) consumed by features 002/004; (4) a **bundle** zip export (`format=bundle`) that ships image
bytes with rewritten relative references and a frontmatter images map, degrading gracefully per lost
image; (5) a **hard-break** serializer fix (trailing-backslash emission) that closes a silent
data-loss bug. All format knowledge stays in the single registry (Constitution IV); the only new
runtime dependency is a server-side zip writer (`archiver`), justified below. No database migration.

## Technical Context

**Language/Version**: Node.js 22+ (server, CommonJS `require`), React 18 + TipTap v3 + Yjs (client, ESM).

**Primary Dependencies**: `yjs`, `prosemirror-model`, TipTap StarterKit + `@tiptap/extension-*`
(client), Express (export route). **New**: `archiver` (server-side streaming zip). `js-yaml` promoted
from transitive to a direct dependency for frontmatter parse/validate (already resolvable in the tree).

**Storage**: PostgreSQL (`document_images` table; **no schema change** this feature), S3 for image bytes
(`server/s3-images.js`), Redis (unaffected). Documents store short app URLs `/api/docs/:docId/images/:imageId`.

**Testing**: Backend Jest (`server/__tests__/`), registry-driven round-trip suite
(`server/__tests__/format-roundtrip.test.js`), run serially against the shared DB. Client Vitest
(`client/src/**/__tests__/`). New: task-list/hardBreak/portable/frontmatter round-trip coverage +
bundle unit tests + a client TipTap task-list test.

**Target Platform**: Linux server + browser. The shared schema (`shared/prosemirror-schema.js`) and
format registry must stay client-safe (no Node built-ins).

**Project Type**: Web application (server + client) with a shared schema/registry layer.

**Performance Goals**: Export latency unchanged for `format=markdown`; bundle export streams the zip
(no full-buffer requirement). Frontmatter parse is O(size) with a hard size cap (RD-10).

**Constraints**: `format=markdown` with no new options MUST be byte-identical to today (FR-022, SC-003).
Task-list + hard-break round-trips MUST be byte-stable at squire flavor (FR-006, SC-001, SC-007).
Zero new format/serialization *third-party* libraries — all serialization stays registry-driven
in-house (archiver writes bytes only; it holds no format knowledge).

**Scale/Scope**: Single-document exports; bundles carry a document's referenced images (typically
< 15 MB each, `MAX_IMAGE_BYTES`). No new persistence, no GC.

### Dependency on feature 001 (base)

001 generalizes the parser and, per design §1.2, may relocate `markdown-to-pm.js` and
`format-registry.js` under `shared/`. This plan references current paths (`server/markdown-to-pm.js`,
`server/format-registry.js`); **if 001 has moved them, apply edits at the new `shared/` location** —
nothing here depends on the move itself (spec Assumptions). 001 delivers:

- **Task-list recognition seam** (001 FR-004): 001 recognizes `- [ ]`/`- [x]` and *degrades to
  bulletList with the literal marker preserved as leading text*, at a single isolated seam documented
  in code referencing feature 003. **003 flips that seam** to emit `taskList`/`taskItem` with a
  `checked` attr — no other grammar logic is re-touched.
- **Hard-break parsing** (001 FR-011): 001 parses trailing backslash, two-space, and `<br>` into the
  existing `hardBreak` node. 003 adds the **serializer emission** (backslash form) and ensures the
  emitted form round-trips; the parser side is 001's, coordinated (see Complexity Tracking / analyze).
- 001 has **no frontmatter awareness** (explicit). Frontmatter strip/preserve is entirely 003's.

## Constitution Check

*GATE: evaluated against `.specify/memory/constitution.md` v1.1.1. Re-checked after Phase 1 — PASS.*

| Principle | Assessment |
|-----------|------------|
| **I. Documentation Reflects Reality** | FR-024 requires README export description + the export API tool documentation (`get_tool_documentation({tool:"export_api"})`) updated in the same change. A Polish-phase task covers both. **PASS** (enforced by task). |
| **II. Test-Backed Changes** | FR-023 extends the registry-driven round-trip suite so every new node (`taskList`/`taskItem`, hardBreak emission), each degradation rule, and each flavor gets bidirectional coverage *by construction*; portable coverage is derived from registry degradation declarations, so a future mark gains portable tests with zero test-file edits (SC-006). Bundle + frontmatter get dedicated tests. Backend serial. **PASS**. |
| **III. Trunk-Based Solo Workflow** | No new ceremony. Feature-branch parallel-pipeline work; implementer commits per orchestrator. **PASS**. |
| **IV. Collaboration-Safe Document Operations** | Degradation rules are **declared in the registry** (FR-011), not hard-coded in the serializer — the registry stays the single source of format knowledge. Task-list toggling in the editor is an in-place Yjs edit, attributed like any edit (FR-002); `appendBlocks` uses the injected tracked `XmlElement` constructor (FR-003). Export is read-only (no doc mutation). **PASS**. |
| **V. Secure by Default** | Frontmatter is untrusted input: values treated strictly as data (no evaluation via a safe YAML load), a size cap (RD-10) beyond which the block degrades to content, malformed frontmatter degrades to content (never-lose-content), `squire:` metadata is advisory — confers no access, triggers no privileged behavior at parse time (FR-016). Bundle export reuses the export route's auth + view-access check and includes only images belonging to the exported document — `getImage(imageId, docId)` is doc-scoped; no new scope/ACL (FR-017). Bundle assets are inert image bytes from S3; no external SVG-source assets fetched. **PASS**. |
| **VI. Design Docs Are Ground Truth** | Plan derives from design §2.1–2.3 + the `format=bundle` note; all deferred product questions are RATIFIED-BY-DEFAULT in the ledger (RD-1…RD-10). No design-doc contradiction introduced; 001-relocation handled by reference. **PASS**. |

**New runtime dependency** (`archiver`): the constitution's dependency posture (Tech Constraints)
constrains **third-party markdown/serialization** libraries against Principle IV's single-registry
rule. `archiver` is a zip/archive writer — it holds no format knowledge and does not touch the
serialization pipeline — so it is *not* a Principle IV concern. Recorded in Complexity Tracking for
transparency per the orchestrator's instruction. See research.md for the rejected in-house-zip
alternative.

**Result: PASS (no violations).** Complexity Tracking documents the new dependency and the 001
hard-break coordination for transparency, neither of which is a constitution violation.

## Project Structure

### Documentation (this feature)

```text
specs/003-portable-export/
├── plan.md              # This file
├── research.md          # Phase 0 — decisions (archiver, YAML handling, degradation model, seams)
├── data-model.md        # Phase 1 — schema nodes, registry degradation shape, frontmatter/bundle entities
├── quickstart.md        # Phase 1 — runnable validation scenarios per user story
├── contracts/
│   ├── frontmatter-squire-block.md   # squire: YAML schema + strip/preserve contract (002/004 consume)
│   ├── bundle-zip-layout.md          # zip structure, asset naming, images map, degradation
│   ├── export-api.md                 # GET /api/docs/:docId/export query contract (format/flavor/frontmatter)
│   └── registry-degradation.md       # per-mark degradation declaration shape + serializer contract
├── clarifications-needed.md          # RD-1…RD-10 ledger (RD-9, RD-10 appended this phase)
└── tasks.md             # Phase 2 output (/speckit-tasks)
```

### Source Code (repository root)

```text
shared/
└── prosemirror-schema.js          # ADD taskList + taskItem nodes (client-safe)

server/
├── format-registry.js             # ADD per-mark degradation declarations + degradeInline() helper
│                                   #   (or shared/ location if 001 moved it)
├── markdown-to-pm.js              # FLIP 001's task-list seam → taskList/taskItem; frontmatter parse
│                                   #   (parseFrontmatter); hardBreak round-trip verification
├── mcp/yjs/serialization.js       # flavor param through toMarkdown/toMarkdownNodes; taskList case;
│                                   #   hardBreak emission in getChildText; lossy-set collection;
│                                   #   buildFrontmatter()
├── mcp/yjs/block-types.js         # register taskList/taskItem in the block taxonomy sets
├── mcp/sandbox/helpers.js         # ADD 'taskList' appendBlocks case + createTaskItem (checked attr)
├── api/docs-export.js             # format=bundle branch; flavor/frontmatter query validation;
│                                   #   assemble zip; slugifyDocTitle; wire persistence + images
├── document-images.js             # reuse getImage; add doc-image enumeration if needed
├── s3-images.js                   # reuse getObject/isEnabled — no change expected
└── __tests__/
    ├── format-roundtrip.test.js   # EXTEND: registry-derived portable coverage; taskList/hardBreak/frontmatter
    ├── api-docs-export.test.js    # EXTEND: flavor/frontmatter query validation + route behavior
    ├── docs-export-bundle.test.js # NEW: bundle assembly, naming, images map, graceful degradation, auth
    └── frontmatter.test.js        # NEW: strip/preserve, size cap, malformed→content, foreign verbatim
        (plus server/mcp/sandbox/__tests__/helpers.test.js — EXTEND for the taskList appendBlocks type)

client/src/extensions/
├── editorExtensions.js            # register TaskList + TaskItem TipTap extensions
└── __tests__/taskList.test.js     # NEW: editor creates/nests/toggles task items; schema parity
```

**Structure Decision**: Web-application layout with a shared schema/registry layer. New capability is
spread across the existing pipeline seams rather than a new module, because the registry pattern makes
each touch point small (design §2.1). The only new files are tests plus the bundle route concern
living in the existing `server/api/docs-export.js`.

## Complexity Tracking

> Recorded for transparency per the orchestrator's instruction. Neither entry is a Constitution
> Check violation; both are dependency/coordination notes.

| Item | Why Needed | Simpler Alternative Rejected Because |
|------|------------|-------------------------------------|
| New runtime dependency `archiver` (server-side zip) | `format=bundle` must emit a real zip of markdown + image assets (FR-017); Node has no built-in zip writer. `archiver` is a mature, streaming, widely-used MIT library that writes bytes only — no format knowledge, so it does not implicate Principle IV's single-registry rule. | An in-house STORE-only zip writer (~100–150 LOC, CRC32 + local/central-directory records) was considered. Rejected: reimplements a well-solved binary format, adds correctness/maintenance risk for zero portability benefit, and the constitution's dependency concern targets *format/serialization* libraries, which a zip container is not. Recorded here, not as a violation. |
| `js-yaml` promoted from transitive to direct runtime dependency (frontmatter YAML parsing) | FR-015/FR-016: foreign frontmatter is arbitrary untrusted YAML that must parse safely (plain-data schema, no evaluation) and degrade to content on failure. YAML is file metadata, not the document format — markdown serialization stays fully in-house/registry-driven, so Principle IV is not implicated. The `squire:` block is *emitted* by a hand-rolled deterministic emitter (research R2); js-yaml is parse-only. | A hand-rolled YAML-subset parser was rejected: foreign tooling keys are arbitrary YAML, and a subset parser would misclassify valid YAML as malformed→content, corrupting the RD-4 preserve contract. js-yaml is already in the dependency tree (transitive), so the footprint change is a package.json line. |
| Hard-break split with feature 001: 001 delivers baseline hard-break parsing (its FR-011); 003 owns the serializer emission AND guarantees the two spec-required accepted forms (trailing backslash, `<br>`) at the parser (spec FR-008) | Avoids two features re-implementing the same grammar. 003's confined parser touches are: task-list seam flip, frontmatter strip/preserve, and — only if 001's delivered parser lacks one — adding a missing hard-break accepted form at the existing hardBreak handling. | Fully re-implementing hard-break parsing inside 003 was rejected: it duplicates 001's `hardBreak` handling and risks drift. Instead 003's round-trip tests (tasks T026) assert both forms parse; a gap is closed with a confined addition at the seam, not a grammar fork. |
