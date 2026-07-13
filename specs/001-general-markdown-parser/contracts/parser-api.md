# Contract: Shared Markdown Parser API

The external interface this feature exposes to the rest of the codebase (and to features 002/003/M5). Anything not stated here is internal and free to change.

## Module: `shared/markdown` (entry `shared/markdown/index.js`, CommonJS)

### `markdownToPm(markdown, diffMark = null, options = {}) → object`

- `markdown: string` — untrusted input, any content, any size.
- `diffMark: 'diffInsert' | 'diffDelete' | null` — applied as the last mark on every emitted text node.
- `options.strict: boolean = false` — mode selector (CN-1).

**Guarantees**

| # | Guarantee | Mode | Enforced by |
|---|-----------|------|-------------|
| G1 | Output equals the pre-feature `server/markdown-to-pm.js` output byte-for-byte (same JSON structure) for any input | strict | characterization snapshot suite (CN-2, TR-004) |
| G2 | Existing 2-arg call shape `markdownToPm(md, diffMark)` remains valid and means tolerant mode | both | FR-002; round-trip suite |
| G3 | Never throws; always returns a schema-valid doc with ≥ 1 block | tolerant | fuzz suite (FR-013, TR-003) |
| G4 | Plain text of output preserves input text per the FR-013 invariant (word-subsequence oracle, research.md R6) | tolerant | fuzz suite |
| G5 | Canonical serializer output (`toMarkdown` of any schema doc) parses to equivalent structure in both modes | both | round-trip suite in both modes (FR-016, TR-002) |
| G6 | Non-whitelist HTML is emitted as literal visible text — never executed, interpreted, or dropped | tolerant | FR-010 tests + fuzz adversarial-HTML generator |
| G7 | Output is inert JSON: no network access, no code evaluation, no filesystem access during parse | both | client-safety module-graph scan (no Node built-ins) + code review |
| G8 | 100 KB typical input < 1 s; 64 KB adversarial input < 5 s | tolerant | timing guards in fuzz suite (SC-006) |

### `parseInline(text, diffMark) → TextNode[]`

Re-exported strict-path helper, kept only for signature compatibility (no external callers exist today). Not part of the tolerant grammar surface; 002/M5 must use `markdownToPm`.

## Module: `shared/format-registry.js` (CommonJS)

Existing exports keep exact behavior (the strict parser depends on them byte-for-byte): `INLINE_MARKS`, `STYLE_PROPS`, `INLINE_NEWLINE`, `INLINE_HTML_TAGS`, `attrsToCSS`, `cssToAttrs`, `buildInlineRegex`.

New derived exports (additive only):

- `getEmphasisSpec()` — delimiter metadata for the tolerant emphasis matcher (from `wrap` + new `altWrap` fields).
- `getHtmlWhitelist()` — inline-HTML whitelist derived from registry tags + schema style props (FR-010: never hardcoded in the parser).

**Compatibility rule**: adding a mark to `INLINE_MARKS` (with `wrap`/`altWrap`/`htmlTag`) extends serializer, strict regex, tolerant grammar, and the round-trip suite with zero parser edits (Constitution IV).

## Consumer contracts

| Consumer | Requirement |
|---|---|
| `server/diff-service.js` (only production caller today) | requires `../shared/markdown`; passes `{ strict: true }` at all three `computeMarkdownDiff` call sites; `CACHE_VERSION` stays `'v7'` |
| `server/mcp/yjs/serialization.js` | requires `../../shared/format-registry`; no behavioral change |
| Feature 002 (`server/markdown-import.js`, future) | wraps `markdownToPm(md)` (tolerant default); relies on G3/G4/G6; no API redesign expected |
| Feature 003 (task lists) | flips the single `taskItemNode()` seam in `shared/markdown/tolerant/block-parser.js` (documented in code at the seam); adds registry/schema entries; grammar logic untouched |
| M5 editor paste (client) | imports `shared/markdown` through the client bundler; guaranteed loadable with no Node built-ins (G7, SC-007) |

## Removal contract (FR-014)

`server/markdown-to-pm.js` and `server/format-registry.js` are **deleted** — no re-export shims. Any require of the old paths must fail at load time (stale-copy prevention).
