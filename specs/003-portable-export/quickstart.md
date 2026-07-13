# Quickstart Validation — Portable Export (M3)

Runnable scenarios proving each user story end-to-end. Contracts referenced, not duplicated:
[export-api](./contracts/export-api.md), [frontmatter](./contracts/frontmatter-squire-block.md),
[bundle](./contracts/bundle-zip-layout.md), [degradation](./contracts/registry-degradation.md).

## Prerequisites

- Dev environment per `docs/dev.md` (commands run in the Minikube app-dev pod; server on
  `http://localhost:3001` or the pod's dev URL — adjust `$BASE` below).
- An `sk_sqd_` API token with `documents:read` + `documents:write` (mint via the MCP
  `create_access_token` tool). `export TOKEN=sk_sqd_…`
- Backend tests run **serially** (shared DB): `cd server && npx jest --runInBand <suite>`.

## Automated suites (the primary gate)

```bash
# Registry-driven round-trip incl. taskList/hardBreak/portable/frontmatter coverage
cd server && npx jest --runInBand __tests__/format-roundtrip.test.js

# Frontmatter strip/preserve + size cap + hostile input
npx jest --runInBand __tests__/frontmatter.test.js

# Bundle assembly, determinism, degradation, auth
npx jest --runInBand __tests__/docs-export-bundle.test.js

# Client task-list editor coverage
cd client && npx vitest run src/extensions/__tests__/taskList.test.js
```

Expected: all pass; format-roundtrip shows generated portable cases for underline/highlight/textStyle
and identical-flavor assertions for every non-degrading mark.

## US1 — Task lists round-trip (P1)

1. Create a doc with a checklist via the scripting API (exercises FR-003):
   - MCP `create_document`, then `modify` with
     `appendBlocks(doc, [{ type: 'taskList', items: ['todo', { content: 'done', checked: true }, { content: 'parent', items: ['child'] }] }])`
2. In the editor: verify interactive checkboxes render, toggle one (collaborator sees it live;
   version history attributes the toggle).
3. Export: `curl -H "Authorization: Bearer $TOKEN" "$BASE/api/docs/$DOC/export" -o out.md`
   - Expect `- [ ] todo`, `- [x] done`, nested `child` indented 6 spaces under `- [ ] parent`.
4. Round-trip: feed `out.md` through the parser (`node -e` against `markdownToPm`) and re-serialize —
   byte-identical (SC-001); `- [X]` input parses as checked, re-emits lowercase `x` (RD-8).

## US2 — Portable flavor (P2)

1. Create a doc with underlined, highlighted, colored, and underline+italic text.
2. `curl … "$BASE/api/docs/$DOC/export?flavor=portable" -o portable.md`
   - No `<u>`, `<mark>`, `<span style>` anywhere; underline → `_…_`, highlight → `**…**`,
     colored text plain; underline+italic → single `_…_` (no `__…__`) (FR-010/FR-012).
3. `curl … "$BASE/api/docs/$DOC/export?flavor=portable&frontmatter=true"` — frontmatter `lossy:`
   lists exactly `[underline, highlight, textStyle]`.
4. Control: a doc with no degradable marks → portable output identical to squire output; and
   `…/export` with no options is byte-identical to a pre-feature export of the same doc (SC-003).
5. Unknown flavor: `…/export?flavor=github` → 400.

## US3 — Frontmatter (P2)

1. `curl … "$BASE/api/docs/$DOC/export?frontmatter=true" -o fm.md`
   - File starts `---`; `squire:` contains docGuid/title/clock/exportedAt/lastModifiedBy/flavor;
     no `lossy` (squire flavor), no `images` (not a bundle).
2. Strip: `node -e` `parseFrontmatter(fs.readFileSync('fm.md'))` → `body` has no frontmatter,
   `squire.docGuid` matches, `foreignRaw` null.
3. Preserve: prepend a foreign key (`speckit: {phase: plan}`) into the block, parse, then
   `buildFrontmatter(meta, foreignRaw)` — foreign line byte-identical, single block, `squire:` last.
4. Hostile: a file starting `---` with no closing fence parses as content (lone `---` = horizontal
   rule); a >64 KB block parses as content (RD-9).

## US4 — Bundle (P3)

1. Doc with ≥2 images (one referenced twice):
   `curl … "$BASE/api/docs/$DOC/export?format=bundle" -o bundle.zip && unzip -o bundle.zip -d out/`
2. `out/` contains `<title>.md` + `assets/<docSlug>/<imageId>.<ext>`; open the md in any viewer —
   all images render (SC-004). Duplicate reference → one asset file, one map entry.
3. Frontmatter `images:` maps every rewritten path → image id; flavor is `portable` (RD-3 defaults).
4. Determinism: export twice, `zipinfo -1` listings identical; rewritten refs identical.
5. Degradation: delete one image's S3 object (or run with storage disabled) → export still 200; that
   reference keeps its app URL and is absent from assets/map (FR-021).
6. Auth: request with a no-access user/token → 403, same as markdown export.

## US5 — Hard breaks (P3)

1. In the editor create a paragraph `line1⇧↵line2` (Shift+Enter).
2. Export (any flavor): `line1\` then `line2` — the break survives as a trailing backslash (FR-007).
3. Parse `line1\\\nline2` and `line1<br>line2` → both produce a hardBreak node; re-export emits the
   backslash form; round-trip byte-stable (FR-008, SC-007).

## Documentation gate (Constitution I)

- `README.md` export section mentions flavor/frontmatter/bundle options and task lists.
- MCP `get_tool_documentation({ tool: "export_api" })` documents the new query options.
