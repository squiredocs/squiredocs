# Feature Specification: Portable Export (M3)

**Feature Branch**: `003-portable-export`

**Created**: 2026-07-13

**Status**: Draft

**Input**: Design doc `design/markdown-import-two-way-sync.md`, Part 2 sections 2.1 (task lists), 2.2 (export fidelity), 2.3 (frontmatter), plus the `format=bundle` asset export. Milestone M3: "taskList/taskItem schema + editor + serializer + parser; hardBreak fix; flavor=portable; frontmatter; asset bundle export."

## Overview

Squire's markdown export today is faithful to Squire but a poor citizen in a Git repository: task lists don't exist in the schema (checklists degrade to plain bullets), hard line breaks are silently dropped on export, underline/highlight/style spans emit as raw HTML that GitHub renders as literal tags, image links point at auth-gated app URLs that are broken outside the app, and an exported file carries no self-describing metadata a sync tool could use. This feature makes exported markdown live well in a repo: real GFM task lists end to end, a lossless hard-break fix, an opt-in `portable` flavor that degrades HTML-only formatting for GitHub rendering (with degradations declared, not hidden), a `squire:` YAML frontmatter block that makes each file self-describing, and a bundle export that ships image bytes alongside the markdown with working relative references.

This is milestone M3 of the markdown import & two-way sync program. It depends on feature 001 (generalized parser) and is consumed by features 002 (import surfaces) and 004 (two-way sync): the frontmatter strip/preserve contract defined here is what 002's importer and 004's push protocol read.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Checklists round-trip as real task lists (Priority: P1)

A team runs spec-driven workflows in Squire: acceptance criteria and task breakdowns are checklists. A user creates a checklist in the editor (or an agent writes one through the scripting API), checks items off collaboratively, exports the document to markdown, and sees standard GFM `- [ ]` / `- [x]` syntax that GitHub renders as checkboxes. When that markdown comes back into Squire (via the feature-001/002 import path), the checklist arrives as a real, interactive task list with each item's checked state intact — not a bullet list with literal `[x]` text.

**Why this priority**: The design doc calls task-list round-tripping "table stakes for the target market" — spec-kit and agent workflows are checklist-heavy, and this is the only item in M3 that adds a new document capability rather than improving an existing one. The repo-sync story is not credible without it.

**Independent Test**: Create a document with a nested checklist (some items checked), via both the editor and an agent script; export to markdown; verify GFM task syntax; re-import the export; verify structure, nesting, and checked state are identical. Delivers value standalone: checklists become a first-class document feature even before any sync tooling exists.

**Acceptance Scenarios**:

1. **Given** an empty document, **When** a user creates a task list in the editor and checks two of three items, **Then** all collaborators see the same checklist state in real time and version history attributes the toggles to the user who made them.
2. **Given** a document containing a task list with items checked and unchecked, **When** it is exported to markdown (any flavor), **Then** each item serializes as `- [ ]` or `- [x]` with nesting preserved by indentation.
3. **Given** markdown containing `- [ ]` / `- [x]` items (including nested items and multi-paragraph items), **When** it is parsed by the markdown pipeline, **Then** it produces real task-list structure with per-item checked state — not a plain bullet list.
4. **Given** an agent modify script, **When** it appends a block of type `taskList` with items carrying `checked` flags, **Then** the document gains an interactive checklist identical to one authored in the editor.
5. **Given** a task list, **When** it round-trips export → import → export, **Then** the serialized markdown is unchanged (byte-stable at squire flavor).

---

### User Story 2 - Portable flavor renders cleanly on GitHub (Priority: P2)

A user exports a design document that uses underline, highlight, and colored text, and commits it to a Git repository. With the portable flavor selected, the file renders on GitHub with no raw HTML tags visible: underlined text appears emphasized, highlighted text appears bold, and colored/styled text appears as plain text — content is never lost, only styling. The file's frontmatter declares exactly which formatting was degraded, so downstream tooling knows the file is not a faithful source for those marks.

**Why this priority**: Raw `<u>`/`<mark>`/`<span style>` tags in a README-adjacent file make Squire exports look broken in the very place the target audience lives. This is the core "repo-portable" promise, and its degradation annotations are a prerequisite for feature 004's write-back safety.

**Independent Test**: Export a document exercising every HTML-only mark with `flavor=portable`; confirm the output contains no inline HTML for degraded marks, renders acceptably in a GFM renderer, and (with frontmatter enabled) lists the degraded marks. Confirm default exports are byte-identical to today's output.

**Acceptance Scenarios**:

1. **Given** a document with underlined text, **When** exported with `flavor=portable`, **Then** the text is emitted as markdown emphasis (`_text_`) and `underline` appears in the frontmatter `lossy` list (when frontmatter is enabled).
2. **Given** a document with highlighted text, **When** exported with `flavor=portable`, **Then** the text is emitted as bold (`**text**`) and `highlight` appears in the `lossy` list.
3. **Given** a document with color/font/size styled spans, **When** exported with `flavor=portable`, **Then** the text content is preserved with styling dropped, and `textStyle` appears in the `lossy` list.
4. **Given** a document using none of the HTML-only marks, **When** exported with `flavor=portable`, **Then** the output equals the squire-flavor output and no `lossy` list is emitted.
5. **Given** any export request without a flavor option, **When** it is served, **Then** the output is byte-identical to the pre-feature output (squire flavor remains the default; no existing consumer sees a change).
6. **Given** text that is both underlined and italic (or highlighted and bold), **When** exported portable, **Then** the delimiters are not doubled — the run emits a single emphasis (or bold) wrapping, never accidental `__text__` / `****text****`.
7. **Given** a mermaid or svg diagram block, **When** exported in either flavor, **Then** it emits the same fenced form as today (GitHub renders mermaid natively; no degradation).

---

### User Story 3 - Frontmatter makes the exported file self-describing (Priority: P2)

A sync tool (or a curious human) looks at an exported `.md` file in a repo and can tell, from the file alone, which Squire document it came from, which version it snapshots, when and by whom it was last modified, which flavor it was exported in, and what formatting was lost — no side-channel mapping file. When the file is later imported, the Squire metadata block is stripped from the content (it describes the file, it is not part of the document), while any frontmatter owned by other tooling (spec-kit, static-site generators) is preserved.

**Why this priority**: The frontmatter is the sync contract — features 002 and 004 consume it for targeting (docGuid) and baseline reconstruction (clock). Without it the bundle images map (US4) also has nowhere to live. It is P2 rather than P1 because it delivers value only in combination with import/sync surfaces.

**Independent Test**: Export with `frontmatter=true`; verify the YAML block contains the documented keys with correct values; feed the exported file back through the parser; verify the squire block is gone from the parsed content, the metadata is surfaced to the caller, and a foreign frontmatter block survives the trip.

**Acceptance Scenarios**:

1. **Given** a document, **When** exported with `frontmatter=true`, **Then** the file begins with a YAML frontmatter block whose `squire:` key contains `docGuid`, `title`, `clock` (the document version at export), `exportedAt` (UTC timestamp), `lastModifiedBy`, and `flavor`; `lossy` appears only when degradations occurred, `images` only for bundle exports.
2. **Given** an exported file with a `squire:` frontmatter block, **When** it is parsed by the markdown pipeline, **Then** the block is absent from the resulting document content and its fields are made available to the calling surface as metadata.
3. **Given** a file whose frontmatter contains both a `squire:` key and foreign keys (e.g. spec-kit's), **When** it is imported and later re-exported with `frontmatter=true`, **Then** the foreign keys survive verbatim (content and order) in a single frontmatter block alongside the regenerated `squire:` key.
4. **Given** a file starting with `---` that is not valid frontmatter (no closing fence, or non-YAML content), **When** parsed, **Then** it is treated as ordinary content per the never-lose-content rule (a lone `---` remains a horizontal rule).
5. **Given** an export without `frontmatter=true`, **Then** no frontmatter is emitted and output is unchanged from today (back-compat).

---

### User Story 4 - Bundle export: images work outside Squire (Priority: P3)

A user exports a document containing screenshots and pasted images for use in a Git repository. Instead of a lone `.md` whose image links point at auth-gated app URLs (broken outside Squire), they download a zip containing the markdown file plus every image, with references rewritten to relative `./assets/<docSlug>/…` paths. The file renders with images anywhere — GitHub, a local editor, a static-site build. The frontmatter `images` map records which relative path corresponds to which Squire image, so a later import can resolve the references back to the original images and diagrams/images round-trip.

**Why this priority**: Completes the portability story for media-heavy documents. Depends on frontmatter (US3) for the images map, and its round-trip half is only exercised once 002/004 land — so it is sequenced after US2/US3, but is independently valuable as "export that works offline".

**Independent Test**: Export a document with several images as a bundle; unzip; open the markdown in a plain renderer and confirm every image displays; verify the frontmatter images map covers every rewritten reference.

**Acceptance Scenarios**:

1. **Given** a document with images, **When** `GET /api/docs/:docId/export?format=bundle` is requested by a user (or token) with view access, **Then** the response is a zip containing the markdown file and one asset file per referenced document image, and every in-document image reference is rewritten to a `./assets/<docSlug>/<file>` relative path.
2. **Given** a bundle export, **Then** its frontmatter `images` map has one entry per rewritten reference, mapping the relative path to the Squire image id.
3. **Given** a document with no images, **When** exported as a bundle, **Then** the zip contains just the markdown file (valid, no error).
4. **Given** an image whose bytes cannot be retrieved (missing from storage, storage disabled), **When** a bundle is exported, **Then** the markdown keeps that image's original app-URL reference, the image is omitted from the assets and the images map, and the rest of the bundle is produced normally — export never fails wholesale over one lost image.
5. **Given** two bundle exports of the same unchanged document, **Then** the asset filenames and rewritten references are identical (deterministic naming — repo diffs stay quiet across pulls).
6. **Given** a requester without view access to the document, **When** they request a bundle, **Then** the request is rejected exactly as the existing export is (no new access path; assets included are only those belonging to the exported document).

---

### User Story 5 - Hard line breaks survive export (Priority: P3)

A user writes an address or poem using Shift+Enter line breaks within a paragraph. Today those breaks vanish from every markdown export — the lines run together. After this fix, exports preserve them (trailing-backslash form) in both flavors, and the parser reads both the backslash form and `<br>` back into real line breaks.

**Why this priority**: A silent-data-loss bug fix — small, self-contained, and required for the M4 round-trip invariant (a dropped break is a phantom edit on every sync cycle). Priority P3 only because the blast radius is small; it can ship first or last without affecting the other stories.

**Independent Test**: Create a paragraph with hard breaks; export; verify each break emits as a trailing backslash; re-import; verify the breaks are real line-break nodes again; round-trip is byte-stable.

**Acceptance Scenarios**:

1. **Given** a paragraph containing hard line breaks, **When** exported to markdown in either flavor, **Then** each break is emitted as a trailing backslash at end of line and no text is lost.
2. **Given** markdown containing a trailing-backslash break or a `<br>` tag, **When** parsed, **Then** each produces a hard line break within the paragraph (canonical re-export uses the backslash form).
3. **Given** a paragraph with hard breaks, **When** it round-trips export → import → export at squire flavor, **Then** the markdown is byte-stable.

---

### Edge Cases

- **Uppercase checkbox**: `- [X]` parses as checked; canonical serialization always emits lowercase `x`.
- **Task/bullet nesting mixes**: a task list nested inside a bullet list item (and vice versa) serializes with correct indentation and re-parses to the same structure; checkbox syntax on a line only creates a task item, never leaks `[x]` as literal text into bullet items.
- **Multi-paragraph task items**: continuation blocks indent to the content column of the `- [ ] ` marker (6 characters), matching the existing list-item convention.
- **Empty task list / empty task item**: serializes to a valid marker line; re-parses without error.
- **Degradation collision**: underline on already-italic text, or highlight on already-bold text, must collapse to a single delimiter pair (see US2 scenario 6) — doubled delimiters would change meaning under CommonMark.
- **Portable without frontmatter**: `flavor=portable` with `frontmatter` off still degrades marks; the degradation is simply unannotated (there is nowhere to put the `lossy` list). Documented behavior, not an error.
- **Document body starting with `---`**: with `frontmatter=true` the exported file's frontmatter block is closed before body content, so a leading horizontal rule in the body cannot be confused with the frontmatter fence; the parser must handle the converse (frontmatter fence detection only at line 1 with a valid closing fence and YAML mapping between).
- **Huge or hostile frontmatter on parse**: frontmatter is untrusted input — values are treated strictly as data (never evaluated), a size cap applies (oversized blocks are treated as content), and `squire:` metadata is advisory only: it confers no access and triggers no privileged behavior at parse time; authorization always happens at the consuming surface.
- **Non-ASCII or empty document title**: the doc slug falls back to a safe default (same spirit as the existing export filename sanitization); slug derivation never fails an export.
- **Unsupported `format` values**: continue to be rejected with a clear error, with `bundle` added to the accepted set; `flavor` and `frontmatter` values are validated (unknown flavor → rejected).
- **Duplicate image references**: the same image referenced twice in one document yields one asset file, two identical relative references, and one images-map entry.

## Requirements *(mandatory)*

### Functional Requirements

**Task lists (design §2.1)**

- **FR-001**: The shared document schema MUST define `taskList` (containing task items) and `taskItem` (with a boolean `checked` attribute, defaulting to unchecked) block types, available identically to server and client.
- **FR-002**: All editor instances MUST register task-list support (create, nest, toggle checkboxes) via the centralized shared-extensions configuration, so no editor has a divergent schema; toggling an item is an edit requiring editor role and is attributed like any other edit.
- **FR-003**: The agent scripting API's block builder (`appendBlocks`) MUST accept a `taskList` block type whose items carry optional `checked` flags and support the same nesting forms as existing list items; invalid item shapes produce the same clear errors as existing list types.
- **FR-004**: The markdown serializer MUST emit task lists as GFM syntax — `- [ ] ` / `- [x] ` markers, lowercase `x`, nested content indented to the marker's content column — in all flavors.
- **FR-005**: The markdown parser MUST parse `- [ ]` / `- [x]` / `- [X]` bullet items into `taskList`/`taskItem` structure with checked state, replacing feature 001's degrade-to-bulletList behavior. **Dependency**: feature 001 (general parser) lands first; this feature upgrades 001's task-list degradation branch. Structured-JSON and plain-text serializations MUST represent task items without loss (checked state visible in structured output).
- **FR-006**: Task lists MUST round-trip: serialize → parse → serialize is byte-stable at squire flavor, and structure/checked state are preserved exactly.

**Hard breaks (design §2.2)**

- **FR-007**: The markdown serializer MUST emit an explicit trailing-backslash line break for every hard-break node, in all flavors; hard breaks are never silently dropped.
- **FR-008**: The markdown parser MUST accept both the trailing-backslash form and the `<br>` tag form as hard breaks; the backslash form is canonical on re-export.

**Portable flavor (design §2.2)**

- **FR-009**: The serializer MUST support a flavor option with values `squire` (default, byte-identical to current output) and `portable`. The REST export route accepts `flavor=portable` as opt-in; the default remains `squire` (Ratified Decision RD-1).
- **FR-010**: In portable flavor, HTML-only inline marks MUST degrade for GFM rendering: underline → emphasis, highlight → bold (Ratified Decision RD-2), and styled spans (color, background, font family/size, line height) → plain text with styling dropped. Text content is never lost, only styling.
- **FR-011**: Degradation rules MUST be declared in the format registry (one declaration per mark), not hard-coded in the serializer — the registry remains the single source of format knowledge (Constitution IV), and the round-trip suite derives portable-flavor coverage from these declarations.
- **FR-012**: Degraded output MUST remain valid CommonMark: when a degraded mark coincides with the mark it degrades to (underline+italic, highlight+bold), the serializer emits a single delimiter pair.
- **FR-013**: Each export MUST compute the set of marks actually degraded in that document; when frontmatter is enabled, that set is emitted as the `lossy` list (empty set → key omitted). Diagram fences, tables, and all markdown-native constructs are identical across flavors.

**Frontmatter (design §2.3)**

- **FR-014**: Export MUST support a `frontmatter=true` option emitting a single leading YAML block with a `squire:` key containing: `docGuid`, `title`, `clock` (document version at export), `exportedAt` (UTC ISO-8601), `lastModifiedBy`, `flavor`, plus `lossy` (only when non-empty) and `images` (only for bundle exports).
- **FR-015**: The markdown parser MUST implement the strip/preserve contract (consumed by features 002/004): a frontmatter block is recognized only at the very start of the input with a valid closing fence; the `squire:` top-level key is stripped from document content and surfaced to the caller as structured metadata; remaining foreign keys are preserved so that a later `frontmatter=true` export re-emits them verbatim (content and order) in the same single block ahead of the regenerated `squire:` key (Ratified Decision RD-4).
- **FR-016**: Frontmatter parsing MUST treat all values as untrusted data: no evaluation, a size cap beyond which the block is treated as ordinary content, and malformed frontmatter degrades to content (never-lose-content). `squire:` metadata is advisory — it MUST NOT grant access or trigger privileged behavior at parse time.

**Bundle export (design §2.2)**

- **FR-017**: `GET /api/docs/:docId/export?format=bundle` MUST return a zip archive containing the document's markdown file plus one asset file per resolvable document image, under `assets/<docSlug>/`; the endpoint enforces the same authentication and view-access check as the existing export (browser session or scoped token with `documents:read`) and includes only images belonging to the exported document.
- **FR-018**: In bundle output, every image reference MUST be rewritten from its app URL to the relative path `./assets/<docSlug>/<assetFilename>`; the frontmatter `images` map records `relative path → image id` for every rewritten reference, enabling later imports to resolve references back to original images.
- **FR-019**: Bundle asset filenames MUST be deterministic across exports of an unchanged document (Ratified Decision RD-5); the doc slug is a filesystem-safe derivation of the document title with a safe fallback for empty/non-ASCII titles.
- **FR-020**: Bundle export defaults to `flavor=portable` and `frontmatter=true` (a new surface with no back-compat constraint; Ratified Decision RD-3); both remain overridable via the same query options. `format=markdown` defaults are unchanged (`squire`, no frontmatter).
- **FR-021**: Bundle export MUST degrade gracefully per image: an image whose bytes cannot be retrieved keeps its original app-URL reference and is excluded from assets and the images map; the export still succeeds.

**Cross-cutting**

- **FR-022**: All existing export consumers MUST be unaffected: a request with no new options produces byte-identical output to the pre-feature system (default flavor `squire`, no frontmatter, `format=markdown`).
- **FR-023**: The registry-driven round-trip test suite MUST be extended so that every new node (`taskList`, `taskItem`, hard-break emission), every registry degradation rule, and each flavor gets bidirectional coverage by construction (Constitution II) — including: squire-flavor byte-stability for task lists and hard breaks; portable-flavor exports parsing back to the degraded-but-valid document; frontmatter strip/preserve round-trip.
- **FR-024**: User-facing export documentation (README feature description and the export API tool documentation) MUST be updated in the same change that ships the new options (Constitution I).

### Key Entities

- **Task list / task item**: new block types in the shared document model; a task item carries a `checked` boolean and the same nested-content capabilities as an ordinary list item.
- **Export flavor**: a named serialization profile — `squire` (full fidelity, HTML-in-markdown allowed) or `portable` (GFM-renderable, HTML-only marks degraded per registry rules).
- **Degradation rule**: a per-mark declaration in the format registry stating how the mark serializes in portable flavor (target markdown form, or "drop styling, keep text") and that its use makes the export lossy.
- **Squire frontmatter block**: the `squire:` YAML mapping at the top of an exported file — file-level metadata (identity, version snapshot, provenance, flavor, lossiness, image map), stripped on import, regenerated on export.
- **Foreign frontmatter**: frontmatter keys owned by other tooling; preserved verbatim across import/export cycles.
- **Export bundle**: a zip of one markdown file plus its image assets under `assets/<docSlug>/`, with relative references and a frontmatter images map (`relative path → image id`).

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: 100% of checklist round-trip fixtures (flat, nested, mixed with other lists, multi-paragraph items, checked/unchecked) survive export → import → export byte-stable at squire flavor with checked state intact.
- **SC-002**: A portable-flavor export of a document exercising every degradable mark contains zero raw HTML tags for those marks, and a stock GFM renderer displays all of its text content.
- **SC-003**: Documents that use no degradable formatting produce identical output in both flavors; requests using no new options produce byte-identical output to the pre-feature system (zero regressions for existing consumers).
- **SC-004**: An exported bundle, unzipped on a machine with no Squire access, renders 100% of resolvable document images in a plain markdown viewer; two consecutive bundle exports of an unchanged document are identical in structure (same filenames, same references).
- **SC-005**: For any exported file with frontmatter, a consumer can determine source document, version snapshot, export time, flavor, and lossiness from the file alone; importing then re-exporting preserves foreign frontmatter keys byte-for-byte.
- **SC-006**: Every mark and node in the format registry — including the new ones and every degradation rule — has automatically derived round-trip coverage; adding a future mark with a degradation rule gains portable-flavor tests with zero test-file edits.
- **SC-007**: Hard line breaks survive export/import in 100% of round-trip fixtures (zero silent content loss).

## Ratified Decisions

Recorded in full in `clarifications-needed.md`; summarized here because they shape requirements:

- **RD-1** (design open question #2): `flavor=portable` is **opt-in** on the existing REST export route; `squire` stays the default. Flipping the default is deferred to a future versioned v2 route (out of scope).
- **RD-2** (design open question #3): highlight degrades to **bold** in portable flavor (GitHub does not render `==text==`; bold is lossy-but-visible). Encoded in the registry.
- **RD-3**: `format=bundle` defaults to `flavor=portable` + `frontmatter=true` (new surface, no back-compat constraint; the bundle exists precisely for portability).
- **RD-4**: Foreign frontmatter contract — single merged frontmatter block on export: foreign keys verbatim first, regenerated `squire:` key appended.
- **RD-5**: Bundle asset filenames are derived from the image id plus content-type extension (deterministic, collision-free); readability is secondary to quiet repo diffs.

## Assumptions

- **Merge order / feature 001**: Feature 001 (parser generalization) lands before this feature. Both touch the markdown parser; this feature's parser changes are strictly confined to (a) upgrading 001's task-list degrade branch to real task nodes, (b) the two hard-break input forms, and (c) frontmatter strip/preserve. If 001 relocates the parser and registry under `shared/` (per design §1.2), this feature's changes apply at the new location; nothing here depends on the move itself.
- **Features 002/004 are consumers, not dependencies**: this feature defines the frontmatter and images-map contracts; import surfaces (002) and sync (004) consume them later. Nothing in M3 requires them to exist.
- **Existing auth model suffices**: bundle export reuses the export route's session/token auth and view-access check; no new scopes or ACL semantics are introduced (export remains read-scoped).
- **Version clock and last-modifier data are already available** server-side (exposed today via document listing); frontmatter reads them, it does not create new tracking.
- **Diagram blocks are already portable** (```mermaid fences render on GitHub) and are explicitly unchanged in both flavors.
- **Zip generation may add a utility dependency** (archive writing); this does not conflict with the no-third-party-markdown-library constraint, which this feature fully respects (all serialization stays registry-driven and in-house). Client task-list support uses the editor framework's standard task extensions, consistent with how all other editor nodes are provided.
- **Asset garbage collection is out of scope**: bundles are generated per request from current document images; nothing new is persisted server-side.

## Out of Scope

- Parser generalization beyond the three confined changes above — emphasis variants, loose lists, setext headings, HTML passthrough policy, `strict` mode (feature 001).
- Import surfaces — MCP `fromMarkdown` helper, `create_document` markdown parameter, REST import routes, editor paste, image fetch-and-rehost (feature 002).
- Two-way sync — baseline reconstruction, source maps, op replay, overlap flags, push endpoint (feature 004); this feature only guarantees the frontmatter fields sync will need.
- A versioned v2 export route or any change to existing defaults (RD-1 defers this).
- Importing bundle zips (zip is an export format only in M3; imports consume `.md` files plus the images-map contract).
- `squire-sync` CLI / GitHub Action (M5), raw-markdown editing view, comments/suggestions schema, footnotes/math/callouts.
