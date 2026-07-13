# Tasks: Portable Export (M3)

**Input**: Design documents from `/specs/003-portable-export/`

**Prerequisites**: plan.md, spec.md, research.md, data-model.md, contracts/, quickstart.md

**Tests**: Included — the spec mandates them (FR-023 registry-driven round-trip extension;
Constitution II). Backend Jest suites run **serially** (`--runInBand`, shared DB); client Vitest.

**Executor**: a single Opus worktree implementer, so tasks are strictly dependency-ordered; [P]
markers indicate what *could* parallelize (different files, no pending dependency) if ever split.

**Path caveat (feature 001 base)**: 001 lands first and may have relocated
`server/markdown-to-pm.js` and `server/format-registry.js` under `shared/`. Before starting, run
`ls shared/markdown-to-pm.js shared/format-registry.js` — if they exist, apply every parser/registry
task at the `shared/` path instead. 001 also provides the task-list recognition seam (documented in
code, referencing feature 003) and hard-break *parsing*; do not re-implement either.

**No database migration expected.** If any task appears to require one, STOP and flag prominently in
promotion-notes.md before proceeding — that contradicts the plan.

## Format: `[ID] [P?] [Story] Description`

---

## Phase 1: Setup

- [X] T001 Add `archiver` and promote `js-yaml` to direct runtime dependencies in `package.json` (npm install; verify `require('archiver')` and `require('js-yaml')` resolve in the server context). Justification recorded in plan.md Complexity Tracking — archiver is a zip container writer, not a format/serialization library.

---

## Phase 2: Foundational (blocking prerequisites)

**Purpose**: schema + taxonomy every story's serializer/parser work builds on.

- [X] T002 Add `taskList` and `taskItem` node specs to `shared/prosemirror-schema.js` per data-model.md §1 (`taskItem` attrs `checked: {default: false}`, content `paragraph block*`; `taskList` content `taskItem+`; `data-type`/`data-checked` parseDOM/toDOM matching TipTap's DOM contract). Keep the module client-safe (no Node built-ins).
- [X] T003 Register `taskList` in `LIST_CONTAINERS` and `taskItem` alongside `listItem` in `INLINE_CONTENT_BLOCKS` in `server/mcp/yjs/block-types.js`; add both to `BLOCK_ELEMENTS` per data-model.md §1.
- [X] T004 Thread a backward-compatible options argument `{ flavor = 'squire', lossy = null }` through `toMarkdown(fragment, options)` and `toMarkdownNodes(nodes, options)` in `server/mcp/yjs/serialization.js` (no behavior change yet — squire output byte-identical; existing call sites untouched). Contract: contracts/export-api.md "Serializer options".

**Checkpoint**: `cd server && npx jest --runInBand __tests__/format-roundtrip.test.js` passes unchanged.

---

## Phase 3: User Story 1 — Checklists round-trip as real task lists (P1) — MVP

**Goal**: taskList/taskItem end to end: editor, agent API, serializer (GFM markers), parser
(upgrading 001's seam), byte-stable round-trip.

**Independent Test**: quickstart.md §US1 — create nested checklist via editor and script, export
shows `- [ ]`/`- [x]`, re-import restores structure + checked state, re-export byte-identical.

### Implementation

- [X] T005 [US1] Serializer: add `taskList` case to `processNode` in `server/mcp/yjs/serialization.js` — reuse `renderListItem` with marker `- [x] ` / `- [ ] ` from the item's `checked` attr (`'true'` string → `x`, always lowercase per RD-8); nested content indents to the 6-char content column (existing `' '.repeat(marker.length)` mechanics). Identical in all flavors (FR-004).
- [X] T006 [US1] Parser: flip feature 001's task-list degradation seam in `server/markdown-to-pm.js` (or `shared/` — see caveat) to emit `taskList` > `taskItem` (checked from `[ ]`/`[x]`/`[X]`) instead of bulletList-with-literal-marker, per data-model.md §1 and spec FR-005. A list is a taskList iff items carry checkbox markers; mixed task/bullet nesting re-parses to the same structure; checkbox syntax never leaks literal `[x]` text (spec Edge Cases). Do not touch other grammar logic, and do NOT alter strict mode (001 froze it for the diff service; task-list recognition exists only in tolerant mode).
- [X] T007 [P] [US1] Structured/plain-text serialization: expose `taskItem.checked` as a boolean in `toStructured` (add `checked` to the attr-parsing in `toStructuredNode` in `server/mcp/yjs/serialization.js`, alongside `level`/`colspan`) and keep item text in plain text (via T003 taxonomy) — FR-005 "structured output shows checked state". Add explicit tests for structured (checked visible as boolean) and plain-text (item text preserved) output in the suite covering these serializers.
- [X] T008 [P] [US1] `appendBlocks`: add `case 'taskList'` to `createBlock` and a `createTaskList`/`createTaskItem` pair in `server/mcp/sandbox/helpers.js` per data-model.md §8 (items accept string | formatted array | `{content, checked?, items?, type?}`; `checked` defaults false; errors match existing list-type style: `appendBlocks: taskList items must be a non-empty array`). Update the doc-comment block list (lines ~330–390) and the `createBlock` unknown-type error's "Supported:" list.
- [X] T009 [P] [US1] Client editor: register TipTap `TaskList` + `TaskItem` (nested: true) in `client/src/extensions/editorExtensions.js` per research.md R6 (TipTap v3 list package; confirm exact import against installed version). All editors get it via `getBaseExtensions()` (FR-002).
- [X] T010 [P] [US1] Client test in `client/src/extensions/__tests__/taskList.test.js` (Vitest): editor with base extensions creates a task list, toggles `checked`, nests items; serialized editor JSON node/attr names match `shared/prosemirror-schema.js` (schema parity guard).
- [X] T011 [US1] Round-trip tests in `server/__tests__/format-roundtrip.test.js`: taskList fixtures — flat, nested (task-in-bullet, bullet-in-task), multi-paragraph items (6-space continuation), checked/unchecked, empty item; assert GFM marker emission, parse-back structure + checked state, and **byte-stable** serialize→parse→serialize at squire flavor (FR-006, SC-001); `- [X]` parses checked and re-emits `- [x]` (RD-8).
- [X] T012 [US1] Sandbox test coverage for the new block type in `server/mcp/sandbox/__tests__/helpers.test.js` (the existing appendBlocks suite): valid shapes, checked flag, nesting, invalid-shape errors (FR-003).

**Checkpoint**: US1 independently shippable — checklists are first-class before any other story.

---

## Phase 4: User Story 2 — Portable flavor renders cleanly on GitHub (P2)

**Goal**: registry-declared degradations (underline→emphasis, highlight→bold, textStyle→plain),
collapse rule, flavor option on the REST route, degraded-set computation.

**Independent Test**: quickstart.md §US2 — portable export of a doc using every degradable mark has
zero raw HTML for them; collapse never doubles delimiters; default output unchanged.

### Implementation

- [X] T013 [US2] Registry: add `portable` declarations to `underline` and `highlight` entries and the `TEXTSTYLE_PORTABLE = { drop: true }` export in `server/format-registry.js` (or `shared/` — see caveat), exactly per contracts/registry-degradation.md (RD-2 highlight→bold; RD-10 sub/superscript get NO declaration). Export whatever helper shape the serializer consumes.
- [X] T014 [US2] Serializer: implement portable-flavor rendering in `renderInline` in `server/mcp/yjs/serialization.js` consuming ONLY registry declarations (FR-011): degraded wrap substitution, textStyle drop, per-segment delimiter de-dup implementing the collapse rule (FR-012 — one pair when degraded target coincides with a present native mark), and lossy-set population (`options.lossy.add(name)` on actual degradation, RD-6). Squire flavor path must remain byte-identical (FR-022).
- [X] T015 [US2] Export route: accept + validate `flavor` query param in `server/api/docs-export.js` per contracts/export-api.md (`squire` default, `portable` opt-in per RD-1; unknown → 400 naming accepted values); pass through to `toMarkdown`.
- [X] T016 [US2] Registry-derived portable tests in `server/__tests__/format-roundtrip.test.js` per contracts/registry-degradation.md "Test derivation": iterate `INLINE_MARKS` — entries with `portable` get generated cases (no HTML tag in portable output, declared form present, parses back valid, name in lossy set, collapse case when `collapsesWith` declared); entries without get squire≡portable assertions; plus textStyle drop case and the no-degradable-marks ⇒ identical-output case (SC-002/SC-003/SC-006). Add a byte-compat regression: default-option export of a fixture doc equals its pre-feature snapshot.
- [X] T017 [US2] Route tests: extend `server/__tests__/api-docs-export.test.js` (existing export-route suite): `flavor=portable` degrades, `flavor=squire` and no-param are byte-identical, `flavor=github` → 400; mermaid/svg fences identical across flavors (US2-AS7).

**Checkpoint**: portable exports render clean on GFM; defaults untouched.

---

## Phase 5: User Story 3 — Frontmatter makes the file self-describing (P2)

**Goal**: `frontmatter=true` emission with the `squire:` block; parser strip/preserve contract for
002/004. Depends on US2 only for the `lossy` list contents (emission works regardless).

### Implementation

- [X] T018 [US3] `parseFrontmatter(markdown)` → `{ body, squire, foreignRaw }` in `server/markdown-to-pm.js` (or `shared/`), exported, per contracts/frontmatter-squire-block.md §2: line-1-only recognition, valid closing fence, 64 KB cap (RD-9), js-yaml safe load to a mapping, degrade-to-content on any failure (FR-015/FR-016); `squire:` raw-line excision with the conservative whole-block-foreign fallback; `markdownToPm` itself stays frontmatter-unaware. Values are inert data — no evaluation, no privileged behavior.
- [X] T019 [US3] `buildFrontmatter(meta, foreignRaw)` in `server/mcp/yjs/serialization.js`: hand-rolled deterministic YAML emission per contracts/frontmatter-squire-block.md §1 (fixed key order docGuid→images; YAML-quote strings needing it; `lossy` flow list only when non-empty; `images` block map sorted, bundle only; foreignRaw verbatim first, single fence pair) — research.md R2.
- [X] T020 [US3] Export route: accept + validate `frontmatter` query param in `server/api/docs-export.js` (contracts/export-api.md value rules; default off for `format=markdown`); gather `docGuid`, `title`, `clock`, `lastModifiedBy` from the persistence/documents layer (same sources as `list_documents` — research.md R12), `exportedAt` = now, `flavor` = effective flavor, `lossy` from the T014 set; prepend `buildFrontmatter` output (FR-014).
- [X] T021 [P] [US3] Frontmatter tests in `server/__tests__/frontmatter.test.js`: strip (squire block gone from body, metadata surfaced); preserve (foreign keys byte/order-verbatim through parse→buildFrontmatter, single block, squire last — SC-005); not-frontmatter cases (lone `---` stays horizontalRule downstream, unclosed fence, non-mapping YAML, >64 KB block ⇒ all content, never throw); hostile YAML (anchors/aliases/billion-laughs-shaped input stays inert plain data under the cap or degrades to content over it); body-starting-with-`---` disambiguation (spec Edge Cases); squire-block excision fallback when raw scan and parsed keys disagree. ALSO add a frontmatter strip/preserve round-trip case to `server/__tests__/format-roundtrip.test.js` (export with frontmatter → parseFrontmatter → re-export preserves foreign keys and body) so FR-023's round-trip-suite requirement is honored in that suite itself.
- [X] T022 [US3] Route tests in `server/__tests__/api-docs-export.test.js` (same suite as T017): `frontmatter=true` emits documented keys with correct values; no `lossy` at squire flavor for a degradable-mark doc; `lossy` present at portable; no frontmatter and byte-identical output when off (US3-AS5); invalid `frontmatter` value → 400.

**Checkpoint**: the 002/004 contract is live and pinned by tests.

---

## Phase 6: User Story 4 — Bundle export (P3)

**Goal**: `format=bundle` zip with assets, rewritten relative refs, images map, graceful
degradation, determinism. Depends on US3 (images map lives in frontmatter) and US2 (RD-3 defaults).

### Implementation

- [X] T023 [US4] Bundle assembly in `server/api/docs-export.js` per contracts/bundle-zip-layout.md and research.md R9/R10/R11: add `bundle` to accepted formats; RD-3 defaults (`flavor=portable`, `frontmatter=true`, overridable); `slugifyDocTitle` (NFKD, strip diacritics, lowercase, `[^a-z0-9]+`→`-`, ≤60, fallback `doc`; exported for tests); scan emitted markdown for this doc's app-URL image refs (`/api/docs/<docId>/images/<imageId>`, this docId only); resolve via `documentImages.getImage(imageId, docId)` + `s3Images.getObject(s3_key)` with per-image skip on `isEnabled()===false`/missing row/fetch failure (FR-021); rewrite refs to `./assets/<docSlug>/<imageId>.<ext>` (ext from `mime_type`; duplicates → one asset, one map entry); build frontmatter with sorted `images` map; stream archiver zip (md first, assets sorted) with `application/zip` + `.zip` Content-Disposition (RFC 5987 handling as today).
- [X] T024 [US4] Bundle tests in `server/__tests__/docs-export-bundle.test.js` (mock/stub S3 per existing image-test patterns): zip contains md + one asset per image; refs rewritten; duplicate-ref doc → single asset + single map entry + both refs rewritten; no-images doc → valid single-entry zip; images map matches every rewritten ref (US4-AS2); per-image degradation (missing S3 object / storage disabled ⇒ 200, original URL kept, asset+map omitted); determinism (two exports: identical entry names + identical rewritten refs — SC-004); foreign-doc image URL left untouched and excluded; slug edge cases (empty title, non-ASCII → `doc` fallback; slug derivation never throws); no-access requester → 403 identical to markdown export; `format=bundle&flavor=squire&frontmatter=false` overrides honored (FR-020).

**Checkpoint**: bundles render offline; repo diffs quiet.

---

## Phase 7: User Story 5 — Hard line breaks survive export (P3)

**Goal**: serializer emits trailing-backslash for every hardBreak node; parser accepts both spec
forms (001 baseline + 003-owned gap-fill, see T026). Independent of US2–US4; ordered last per spec
priority but can be done any time after Phase 2.

### Implementation

- [X] T025 [US5] Serializer: emit hard breaks in `server/mcp/yjs/serialization.js` — handle the `hardBreak` element inside inline content (`getChildText`/`renderInline` path) as `\` + newline (trailing backslash at end of line), all flavors, no text loss (FR-007, RD-7). Verify continuation behavior inside list items/blockquotes keeps valid markdown (following lines re-prefixed/indented as their container requires).
- [X] T026 [US5] Parser acceptance + round-trip tests: verify the parser (001's base) accepts BOTH hard-break input forms — trailing backslash and `<br>` — producing hardBreak nodes (FR-008). If either form is missing from 001's delivered parser, ADD it at the parser's hardBreak handling in `server/markdown-to-pm.js` (or `shared/`) — this confined addition is owned by 003 (orchestrator scope: "hardBreak accepted forms"); do not re-implement forms 001 already provides. Tests in `server/__tests__/format-roundtrip.test.js`: paragraph with hard breaks → export contains trailing `\`; both input forms parse to hardBreak and re-export as backslash (canonical, RD-7); serialize→parse→serialize byte-stable (SC-007); hard break inside a list item and inside a blockquote.

**Checkpoint**: zero silent break loss; M4 invariant holds for breaks.

---

## Phase 8: Polish & Cross-Cutting

- [ ] T027 [P] Docs (FR-024, Constitution I): update `README.md` export feature description (task lists; `flavor`/`frontmatter` options; `format=bundle`) and the MCP export API tool documentation (`get_tool_documentation({tool:"export_api"})` source — find it under `server/mcp/`) with the new query options and defaults. Update the `modify`/scripting docs listing appendBlocks types to include `taskList`.
- [ ] T028 [P] Byte-compat sweep (SC-003/FR-022): run the FULL backend suite serially (`npx jest --runInBand`) + client suite (`npx vitest run`); confirm diff-service/read_document/chat-tools call sites still pass no options and their outputs are unchanged; grep for other `toMarkdown(` call sites to verify none accidentally opted in.
- [ ] T029 Run quickstart.md end-to-end in the dev pod (all five US sections) and record outcomes; append any design-doc drift or 001-seam gaps discovered to `specs/003-portable-export/promotion-notes.md`.

---

## Dependencies & Execution Order

```text
T001 (deps)
  └─ T002 → T003 → T004 (foundation)
       ├─ US1: T005 → T006 → {T007, T008, T009} → T010 → T011 → T012
       ├─ US2: T013 → T014 → T015 → T016 → T017        (needs T004)
       │    ├─ US3: T018, T019 → T020 → {T021, T022}   (lossy list from T014)
       │    │    └─ US4: T023 → T024                   (images map from T019/T020)
       └─ US5: T025 → T026                              (independent; any time after T004)
```

- **Critical path**: T001 → T002 → T003 → T004 → T013 → T014 → T015 → T018/T019 → T020 → T023 → T024 → T027–T029.
- **MVP** = Phases 1–3 (US1): checklists first-class, independently shippable.
- Story order honors spec priority (P1 → P2 → P2 → P3 → P3); US5 may be reordered earlier freely.
- Parallel opportunities (if ever split): T007/T008/T009 (different files), T010, T021/T022, T027/T028.

## Notes

- Backend tests: **always `--runInBand`** against the shared test DB (Constitution II).
- Squire-flavor byte-compat is the non-negotiable regression guard — pin it early (T016) and sweep
  at the end (T028).
- Registry is the only home for degradation knowledge; if a task tempts you to branch on a mark name
  in the serializer, move that knowledge to the registry instead (FR-011).
