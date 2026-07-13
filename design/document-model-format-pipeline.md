<!-- source: https://squiredocs.com/d/6e425e03-1670-4773-987a-584d3d04dea3
     synced-by: design/sync.mjs — DO NOT HAND-EDIT; amend the Squire doc and re-sync -->

# Squire Document Model and Format Pipeline

## What this is

The document’s shape and the machinery that converts it between representations: the shared ProseMirror schema, the format registry that keeps every converter honest, markdown serialization (the export everyone consumes), the restricted markdown parser behind version diffs, and where each fidelity boundary lies.

## The schema

`shared/prosemirror-schema.js` defines the node set — paragraph, heading, bulletList/orderedList/listItem, blockquote, codeBlock, `mermaid` and `svg` diagram blocks, hardBreak, horizontalRule, image (atom; app-URL src only), and table/tableRow/tableCell/tableHeader — and the marks: bold, italic, underline, strike, code, subscript, superscript, highlight, link, textStyle (color, backgroundColor, fontFamily, fontSize, lineHeight), plus `diffInsert`/`diffDelete` used only by version diffs. Notably absent today: task lists, footnotes, math, callouts, comments/suggestions.

## The format registry

`shared/format-registry.js` (relocated from server/ when the parser generalized, 2026-07-13) is the single source of truth for inline-mark syntax: each mark declares its markdown delimiters or HTML tag once, and style props are auto-derived from the schema. The markdown serializer, both parser modes, and the inline-token regex are all registry-driven — adding a mark is one entry plus a client extension, and the round-trip test suite (`server/__tests__/format-roundtrip.test.js`) covers it by construction. This is the pattern the constitution’s Principle IV protects.

## Serialization surfaces

- **Yjs → Markdown: **`server/mcp/yjs/serialization.js` (`toMarkdown`), a custom serializer walking the Yjs tree. Diagram blocks become ```mermaid/```svg fences; underline/highlight/sub/sup and style spans emit as inline HTML (Squire-flavor, not portable CommonMark). Consumed by the editor’s Export as Markdown, MCP read tools, the REST export API, and design/sync.
- **Markdown → ProseMirror: **`shared/markdown/` (amended 2026-07-13, feature 001): `markdownToPm(markdown, diffMark, { strict })` dispatches between two modes — `strict` (the original exact-dialect parser, frozen as `strict-parser.js` and proven byte-identical by a characterization snapshot; the version-diff engine pins to it) and the default `tolerant` mode — a registry-driven CommonMark+GFM subset parser (emphasis variants, loose/lazy lists, setext, indented code, autolinks, escapes/entities, HTML whitelist) with a never-lose-content guarantee enforced by fuzz tests. General import _surfaces_ (REST/MCP/paste) remain feature 002 — see [Proposal: Markdown Import & Two-Way Repo Sync](https://squiredocs.com/d/b6edb804-cf72-416d-9c97-063a23e669c0).
- **Yjs → HTML: **`server/mcp/yjs/html-serialization.js` (DOMSerializer-based) exists but is currently referenced only by its own tests.
- **Structured JSON: **the MCP read tools’ default format — a lossless tree used by agents before targeted edits.

## Version diffs

The diff pipeline is markdown-mediated: both clock states serialize via `toMarkdown`, `diffLines` computes hunks, and `markdownToPm` rebuilds an annotated document with diffInsert/diffDelete marks the editor renders. Formatting-only changes are detected separately (equal text, different XML). This markdown-canonical-form trick is also the foundation the two-way repo sync proposal builds on.

## Editor side

The TipTap extension set is centralized in `client/src/extensions/editorExtensions.js` (`getBaseExtensions`); markdown typing shortcuts are StarterKit defaults; StarterKit undo/redo is disabled in favor of the Yjs UndoManager. Diagram fence labels are owned server-side so client and serializer cannot disagree.