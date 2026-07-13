# Implementation Plan: Markdown Import Surfaces

**Branch**: `002-markdown-import-surfaces` | **Date**: 2026-07-13 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `/specs/002-markdown-import-surfaces/spec.md`

**Ground truth**: `design/markdown-import-two-way-sync.md` §1.2 (import surfaces), image-policy note, M2 milestone row. Current-state: `design/agent-surface-mcp.md`, `design/document-model-format-pipeline.md`. Clarifications settled in [`clarifications-needed.md`](./clarifications-needed.md) (CN-1…CN-12, all RATIFIED-BY-DEFAULT).

## Summary

Add one server-side import module (`server/markdown-import.js`, `importMarkdown(ydoc, markdown, { mode, imageContext })`) and expose it through four thin surfaces: an optional `markdown` param on the `create_document` MCP tool, a synchronous `fromMarkdown(md)` sandbox helper for `modify` scripts, and two REST routes (`PUT /api/docs/:docId/import`, `POST /api/docs/import`) mounted beside the export router. The module obtains ProseMirror JSON exclusively from feature 001's generalized `markdownToPm` (never re-parsing), materializes it into the live Yjs fragment as a single attributed transaction, consumes a leading `squire:` frontmatter block defensively, sanitizes link hrefs against a protocol allowlist, and rehosts external images through an SSRF-safe fetch-and-rehost pipeline (`server/image-rehost.js`) into existing document-image storage — degrading every image failure to a plain link rather than failing the import. `replace` mode is the documented Principle IV exception (block-level in-place deletes + inserts, no fragment recreation). This is M2 of the design; it depends on M1 (feature 001) and is the transport feature 004 extends.

## Technical Context

**Language/Version**: Node.js 22+ (CommonJS server modules), Express backend, Yjs CRDT, isolated-vm sandbox.

**Primary Dependencies**: `yjs`; `y-prosemirror` (already a dep — `prosemirrorJSONToYDoc`/`prosemirrorToYXmlFragment` for PM-JSON→Yjs materialization); feature 001's `markdownToPm` (relocating to `shared/`); existing `server/document-images.js` + `server/s3-images.js` (image storage); Node core `dns`, `net`, `http`/`https` (SSRF-safe fetch). **Zero new runtime dependencies** are planned (SSRF fetch is built on Node core; see research.md R4).

**Storage**: PostgreSQL (`document_images` metadata rows — no schema change), S3 (image bytes via `s3-images.js`), Yjs update log (document body). **No node-pg-migrate migration required** (see research.md R7).

**Testing**: Jest backend (`server/__tests__/`, `__tests__/integration/`), serial against the shared DB (Principle II). New suites: import-module unit, REST API auth/scope/role matrix, SSRF address-family unit tests, image-degradation, sandbox-helper, frontmatter, and the SC-007 round-trip property.

**Target Platform**: Linux server (Minikube `app-dev` pod).

**Project Type**: Web service (existing Express monolith + React client; this feature is server-only — no client surface, editor paste is M5).

**Performance Goals**: 1 MB markdown, no images < 5 s; 1 MB markdown + 10 external images (1 MB each, responsive hosts) < 30 s (SC-005). Per-fetch 10 s timeout; ≤ 20 unique image fetches/import; 3 redirect cap.

**Constraints**: Import body size cap 5 MB (rejected before parsing); image byte cap 15 MB (existing `MAX_IMAGE_BYTES`), MIME allowlist png/jpeg/gif/webp (existing `ALLOWED_IMAGE_MIME_TYPES`); no network egress except the bounded image fetch; no privileged write path (same `documentService.updateDocument` path as human edits).

**Scale/Scope**: One new module + one image-rehost module; four surface wrappers (one new tool param, one sandbox helper, two REST routes); one modify-doc edit; README + export_api doc update. Backend-only.

## Constitution Check

*GATE: evaluated against `.specify/memory/constitution.md` v1.1.1. Re-checked after Phase 1 design — still passing.*

| Principle | Assessment | Evidence / Gate |
| --- | --- | --- |
| **I — Documentation Reflects Reality** | PASS | FR-024 mandates README + export_api tool-doc + modify tool-doc updates in the same effort. Tasks include an explicit doc-pass phase. Design-doc staleness (CN-10: `documents:write` is not new) is ledgered and flagged for a Squire-source amendment + re-sync, not hand-edited (Principle VI). |
| **II — Test-Backed Changes** | PASS | Every behavioral surface has tests (spec §Constitution Notes / Principle II). SC-007 round-trip extends the property suite. Backend suites run serially. No new format marks/nodes here, so `format-roundtrip.test.js` needs no new registry entries (feature 003 owns those). |
| **III — Trunk-Based Solo Workflow** | PASS | No new process. Feature is one worktree implementer, dependency-ordered tasks, MVP = US1. |
| **IV — Collaboration-Safe Document Operations** | PASS *with one documented exception* | `append`/`insertAfterXPath` are pure in-place inserts; XPath targeting (never positional). `replace` is wholesale by definition → **Complexity Tracking entry below** (the spec-mandated Principle IV tension). No new format knowledge outside the registry: import reuses `markdownToPm` (registry-driven) and adds no parallel serializer. Attribution preserved (single transaction via `updateDocument`, `agentName`/`userId` origin). |
| **V — Secure by Default** | PASS | Trust boundary + validation policy stated in spec (mandatory for ingestion surfaces). Concrete gates: 5 MB body cap pre-parse; SSRF-safe fetch (scheme allowlist, per-hop address validation, connection pinned to validated IP, redirect/size/type/count/time budgets); `data:` rejected; link-href protocol allowlist; frontmatter never executes; auth on every surface (`requireAuth` + editor-role on PUT + `documents:write` scope). Contracts artifact `contracts/image-rehost.md` specifies the SSRF policy. |
| **VI — Design Docs Are Ground Truth** | PASS | Plan tracks design §1.2 exactly (module + 4 surfaces, `append`/`replace`/`insertAfterXPath`, REST offers only `append|replace`, fetch-and-rehost). Two current-state contradictions ledgered (CN-9 link hrefs — material silence; CN-10 `documents:write` staleness). Nothing resolved ad hoc. |

**Result**: PASS. One justified violation (replace-mode) carried in Complexity Tracking per Principle IV / Development Workflow gate.

## Project Structure

### Documentation (this feature)

```text
specs/002-markdown-import-surfaces/
├── plan.md              # This file
├── research.md          # Phase 0 — decisions R1..R9
├── data-model.md        # Phase 1 — Import request/result/report, Rehosted image, Frontmatter block
├── quickstart.md        # Phase 1 — runnable validation scenarios
├── contracts/
│   ├── import-module.md  # importMarkdown() + fromMarkdown() contract
│   ├── rest-import.md     # PUT/POST route contracts (request, response, errors)
│   └── image-rehost.md    # SSRF-safe fetch-and-rehost policy (the security-critical artifact)
├── clarifications-needed.md   # (existing) CN-1..CN-12 ledger
└── tasks.md             # Phase 2 — /speckit-tasks output
```

### Source Code (repository root)

```text
server/
├── markdown-import.js            # NEW — importMarkdown(ydoc, markdown, { mode, insertAfterXPath, imageContext })
├── image-rehost.js               # NEW — SSRF-safe fetch-and-rehost; rehostImagesInFragment(fragment, { docId, userId })
├── markdown-import-frontmatter.js# NEW (or a section of markdown-import.js) — squire: block parse/strip, non-squire → yaml codeblock
├── api/
│   └── docs-import.js            # NEW — createImportRouter(persistence): PUT /:docId/import, POST /import
├── mcp/
│   ├── tools/
│   │   ├── create-document.js    # EDIT — optional `markdown` param + title derivation
│   │   └── tool-documentation/
│   │       ├── modify.js         # EDIT — replace Example 4 regex with fromMarkdown() example
│   │       └── export-api.js     # EDIT — document PUT/POST import beside export
│   ├── sandbox/
│   │   ├── isolate-entry.js      # EDIT — expose globalThis.fromMarkdown (tracked constructors)
│   │   ├── helpers.js            # EDIT (maybe) — pmJsonToNodes helper shared with import module
│   │   └── isolate-bundle.js     # REBUILT — npm run build:sandbox-bundle (generated; do not hand-edit)
│   └── yjs/
│       └── node-builder.js       # REUSE/EXTEND — PM-JSON → Yjs materialization (or y-prosemirror)
├── document-service.js           # REUSE — createSeededDocument / updateDocument (attributed write path)
├── document-images.js            # REUSE — storeImage (validation, S3, metadata), MAX_IMAGE_BYTES, MIME allowlist
├── image-validate.js             # REUSE — reconcileCrossDocImages (cross-doc app-URL reconciliation)
└── index.js                      # EDIT — mount createImportRouter beside createExportRouter (line ~1098)

shared/
└── markdown-to-pm.js             # CONSUMED (relocated by feature 001) — markdownToPm(markdown, opts)

server/__tests__/  &  __tests__/integration/   # NEW test suites (see Technical Context)
```

**Structure Decision**: Existing Express monolith. The feature is backend-only and additive: one core module (`markdown-import.js`), one security module (`image-rehost.js`), one REST router (`api/docs-import.js`), plus edits to four existing surfaces. All materialization funnels through the single import module (FR-001); no surface carries its own parsing or materialization. The sandbox bundle is a generated artifact rebuilt via `npm run build:sandbox-bundle` after `isolate-entry.js`/`helpers.js` change.

## Complexity Tracking

*Constitution Check surfaced one justified violation (Principle IV). Recorded per the Development Workflow gate.*

| Violation | Why Needed | Simpler Alternative Rejected Because |
|-----------|------------|-------------------------------------|
| **`replace` mode performs wholesale body replacement** (block-level deletes + inserts across the live fragment), in tension with Principle IV's "targeted ops, never delete-and-recreate". | Ground truth (design §1.2) specifies `replace` as a first-class mode: it is the honest primitive for "a repo file was regenerated, make the Squire doc match" until feature 004's clock-anchored merge exists. Omitting it would leave the design's stated M2 surface incomplete and force callers into destructive hand-rolled scripts. | **Constrained, not free-form.** `replace` is the documented exception, bounded to stay as collaboration-safe as feasible: (a) a **single transaction** of block-level `delete`+`insert` against the existing `'default'` XmlFragment — **no fragment or document recreation**; document identity, `meta`/title, and version-history continuity are untouched; (b) **one undo boundary**, fully attributed via the normal `updateDocument` origin (no privileged path); (c) concurrent collaborator edits **merge per CRDT semantics** (not an error) — edits inside removed blocks are lost with those blocks, which is the accepted, documented loss. **Rejected alternatives:** (1) *"no replace, append-only"* — contradicts ground truth and leaves regenerated-file workflows unserved; (2) *recreate the Y.XmlFragment / new doc* — destroys CRDT identity, undo history, and attribution (a hard Principle IV breach, strictly worse); (3) *diff-and-patch merge now* — that IS feature 004 (clock-anchored op replay); building it here duplicates 004 and needs machinery (baselines, source maps) M2 does not have. Feature 004 is the designated successor for merge-quality replace. |
