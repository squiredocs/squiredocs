# Promotion Notes — 003-portable-export

Items to promote out of this feature (design-doc amendments, decisions to ratify upstream,
follow-ups for other features). Empty at spec time; populated during plan/implement/review.

## Design-doc amendments to propose

### A1 (analyze I1) — FR-022 wording amendment for the task-list/hard-break bug-fix exception

FR-022 as written ("a request with no new options produces byte-identical output to the
pre-feature system") is literally violated by the feature's own P1/P3 stories for documents
that contain task lists or hard breaks — their pre-feature serialization was the bug being
fixed. contracts/export-api.md already documents the exception class; the spec text should
match. Proposed one-line amendment to FR-022 (spec.md deliberately NOT edited in-branch):

> **FR-022**: All existing export consumers MUST be unaffected: a request with no new
> options produces byte-identical output to the pre-feature system (default flavor
> `squire`, no frontmatter, `format=markdown`) — **except documents containing task lists
> or hard line breaks, whose previously-lossy serialization (checklists as plain bullets,
> breaks silently dropped) is corrected in every flavor per FR-004/FR-007**.

The byte-compat guarantee for everything else is pinned by
`server/__tests__/fixtures/pre-feature-export-baseline.md` (generated from the merge-base
serializer) and asserted in the round-trip suite.

### FR-007 implementation detail — hard breaks in structurally constrained containers

FR-007 mandates the trailing-backslash form "in all flavors". Inside **table cells** and
**headings** a literal backslash-newline would break the enclosing block (split the row /
end the ATX heading), so the serializer emits `<br>` there instead (the GFM-conventional
form for cells; parses back to the same hardBreak node, byte-stable round-trip).
Paragraphs, list items, task items, and blockquotes use the canonical backslash form with
container-correct continuation (re-indent to content column / re-prefix `> `). Worth a
half-sentence in design §2.2 if promoted.

## Decisions needing explicit ratification by Sam

- **js-yaml v4 (not the in-tree v3) as the direct dependency.** Research R2 assumed
  promoting the transitive v3; v3 drags in `esprima` (function-type support) and its
  `load` is unsafe by default. v4 is pure JS, `load` is safe by default, JSON_SCHEMA
  restricts to plain data. The v3 copy remains nested under jest's toolchain. Low risk;
  flagging because it deviates from the research note's letter.
- **archiver pinned to v7** (v8 is ESM-only and cannot be `require`d under jest's CJS
  runtime). Same API; revisit on a future ESM migration (vitest-esm branch).
- **`@tiptap/extension-list` declared as a direct client dependency** (exact in-tree
  version 3.15.3, already installed via starter-kit — zero new packages). The plan's
  "standard task extensions" assumption implied this; declaring it makes the import
  explicit rather than relying on hoisting.

## Handoffs to other features

- **002/004 — frontmatter module import path**: `parseFrontmatter` lives at
  `shared/markdown/frontmatter.js` and is deliberately NOT re-exported from
  `shared/markdown/index.js`: it requires the `js-yaml` bare specifier, and the parser
  index's module graph is pinned self-contained/client-safe by
  `client/src/__tests__/sharedMarkdown.test.js`. Import it directly:
  `require('.../shared/markdown/frontmatter')`. Contract behavior is exactly
  contracts/frontmatter-squire-block.md (verified by 25 tests in
  `server/__tests__/frontmatter.test.js`).
- **002 — modify-tool documentation**: per the collision boundary, only the appendBlocks
  TYPE lists in `server/mcp/tools/tool-documentation/modify.js` were touched (taskList in
  the block-type list, `checked?`/`'taskList'` in NestedItem, one line in "TipTap Block
  Types"). No examples were added or edited — if 002 rewrites the examples section,
  merge conflicts should be trivial.
- **002 — parser now emits real task lists**: 001 suites that pinned the degradation seam
  were updated in this branch (markdown-tolerant AS-7, gfm/task-lists fixtures + a new
  mixed-run case, two real-world corpus block sequences, fuzz oracle now strips the
  consumed checkbox marker). If 002's branch also touches those suites, take this
  branch's versions.
- **004 — `lossy` list order**: emitted sorted alphabetically (deterministic); the
  contract leaves order unspecified.
- **004 — `clock` in frontmatter** is the max `yjs_updates.clock` (same as
  `list_documents`); a never-edited document exports `clock: 0` with
  `lastModifiedBy: ""`.

## 001-seam verification (T026 / analyze items)

- **Hard-break accepted forms**: 001's tolerant inline parser already accepts trailing
  backslash, two-space, AND `<br>`/`<br/>` — no 003 gap-fill was needed; 003 added only
  serializer emission + round-trip tests. Strict mode untouched (frozen).
- **Task-list seam**: flipped exactly at `taskItemNode` in
  `shared/markdown/tolerant/block-parser.js` plus one confined addition: task-item
  continuation lines shift back the 4 columns the `[x] ` marker occupies (the marker is
  syntax now, so the serializer's 6-column content convention must classify nested
  blocks correctly), and unordered runs group into consecutive homogeneous
  taskList/bulletList nodes (schema requires `taskList: taskItem+`).
- **Pre-existing (not 003) limitation**: multi-paragraph REGULAR list items still
  serialize without blank-line separation and re-parse merged (001 behavior, frozen for
  byte-compat). Task items DO blank-line-separate their blocks (required for FR-006
  byte-stability).

## T029 — quickstart outcomes (run 2026-07-13, worktree server on :3103 against collab_test_db_003, real S3)

- Automated suites (primary gate): format-roundtrip 110, frontmatter 25,
  docs-export-bundle 12, api-docs-export 25, sandbox helpers 140, client taskList 6 —
  all green; full backend 2208/2208, client 541/541, build green.
- **US1**: checklist created via `appendBlocks` (taskList type); export shows
  `- [ ] todo`, `- [x] done`, nested child at 6-space column; parse→re-export
  byte-identical; `- [X]` re-emits `- [x]`. Editor toggle/attribution covered by the
  headless-editor client suite (create/toggle/nest + schema-parity + Yjs-attr edit);
  not re-driven by hand.
- **US2**: portable export has zero raw HTML for degraded marks; `_underlined_`,
  `**highlighted**`, plain `colored`, single-pair `_under-italic_`; `flavor=github` →
  400; mermaid fence identical across flavors; no-option export byte-matches the
  baseline serializer.
- **US3**: frontmatter block carries docGuid/title/clock/exportedAt/lastModifiedBy/
  flavor (+ sorted `lossy` at portable); strip/preserve verified including foreign-key
  verbatim re-emission, single block, squire last; unclosed fence and >64 KB blocks
  degrade to content.
- **US4**: bundle zip = `Quickstart 003.md` + `assets/quickstart-003/<imageId>.png`
  (one asset for the twice-referenced image, both refs rewritten); images map matches
  every rewritten ref; two exports have identical `zipinfo -1` listings; unzipped PNGs
  are valid image bytes; unauthenticated request → 401 (403-parity covered in tests).
- **US5**: hard break exports as `line1\` + `line2`; both input forms parse to
  hardBreak; round-trip byte-stable.
- No database migrations were needed (none created).
