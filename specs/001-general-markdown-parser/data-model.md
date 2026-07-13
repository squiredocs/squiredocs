# Data Model — 001-general-markdown-parser

Phase 1 output. This feature is a pure transformation library; its "data model" is the shapes flowing through the parser and the registry metadata that drives it. No database entities, no migrations.

## 1. Parser invocation

```
markdownToPm(markdown: string, diffMark: string|null = null, options?: { strict?: boolean })
  → ProseMirrorDocJSON
```

| Field | Type | Rules |
|-------|------|-------|
| `markdown` | string | Untrusted input; any string, any size. Tolerant path normalizes `\r\n`/`\r` → `\n` first; strict path uses it verbatim. |
| `diffMark` | `'diffInsert' \| 'diffDelete' \| null` | When set, appended as the **last** mark on every text node produced (both modes; existing behavior). |
| `options.strict` | boolean, default `false` | `true` → frozen pre-feature parser (CN-1/CN-2). Omitted/`false` → tolerant grammar. |
| return | object | `{ type: 'doc', content: Block[] }`; always ≥ 1 block (empty/whitespace input → `[{ type: 'paragraph' }]`); MUST satisfy `schema.nodeFromJSON(result).check()` for the shared schema. |

**Error contract**: the tolerant path never throws for any string input (FR-013). The strict path keeps today's (unspecified) throw behavior — it is frozen, and its only caller wraps in try/catch (`diff-service.computeDiff`).

## 2. Supported grammar → node/mark mapping (tolerant mode)

Output vocabulary is exactly the existing shared schema — **no schema changes in M1**.

| Construct (FR) | Input forms | Output |
|---|---|---|
| ATX heading (FR-012) | `#`–`######` + text, optional closing hashes | `heading{level}` |
| Setext heading (FR-006) | paragraph line + `=`-run / `-`-run underline | `heading{1}` / `heading{2}` |
| Thematic break (FR-012, Edge Case) | `---` (canonical), `***`, `___`, 3+ with spaces — only where setext precedence doesn't apply | `horizontalRule` |
| Fenced code (FR-012) | backtick fence + info string; unclosed → EOF | `codeBlock{language}`; info `mermaid`/`svg` → `mermaid`/`svg` diagram nodes |
| Indented code (FR-007) | 4-space/tab indented lines outside list continuation | `codeBlock` (de-indented, verbatim) |
| Lists (FR-005) | `-`/`*`/`+` bullets; `1.`/`1)` ordered (start honored); loose/tight; multi-paragraph items; lazy continuation; CommonMark-compatible nesting indents | `bulletList`/`orderedList{start}` → `listItem` → block content |
| Task-list item (FR-004) | `- [ ]` / `- [x]` (case-insensitive, `-`/`*`/`+`) | via `taskItemNode()` seam → `listItem` with literal `[x] `/`[ ] ` prefix (CN-3); 003 flips seam |
| Blockquote (FR-012) | `>` lines, nesting, lazy continuation; `> [!NOTE]` = plain quote | `blockquote` |
| Table (FR-012, CN-8) | pipe-leading dialect only; `\|` escapes; alignment separators tolerated | `table`/`tableRow`/`tableHeader`+`tableCell` |
| Emphasis (FR-003) | `*`/`_` (italic), `**`/`__` (bold), CommonMark flanking + intraword-`_` rule, nesting | `bold`, `italic` marks |
| Strike (FR-012) | `~~text~~` | `strike` mark |
| Code span (FR-012) | backtick runs, CommonMark matching | `code` mark (no escape/entity processing inside) |
| Link (FR-012) | `[text](url)` | `link{href}` mark |
| Image (FR-012, R9) | `![alt](src)` | unchanged from today: literal `!` text + `link` mark on alt (image nodes are 002 scope) |
| Autolinks (FR-008) | `<uri>`, `<email>` → mailto; bare `http://`/`https://`/`www.` (CN-5) | `link{href}` mark, visible text = URL |
| Escapes (FR-009) | `\` + ASCII punctuation | literal character, never structural |
| Entities (FR-009, CN-4) | `&#N;`, `&#xN;`, curated named set | decoded character; unknown named → literal |
| Hard break (FR-011, CN-9) | 2+ trailing spaces, trailing `\`, `<br>`/`<br/>` | `hardBreak` node |
| HTML whitelist (FR-010, CN-6) | registry tags (`<u>`, `<mark>`, `<sub>`, `<sup>` — derived), `<span style>` with ≥1 registry prop, `<br>` | corresponding marks / `hardBreak` |
| Everything else | unknown HTML, footnotes, math, callout syntax, non-pipe tables, tilde fences, malformed constructs | **degradation ladder** (below) |

## 3. Degradation ladder (FR-013)

Ordered, most-specific first; applied wherever a construct fails to parse:

1. Unbalanced/unknown inline HTML → literal text (tags visible, nothing executed/dropped).
2. `<span style>` with some registry props → mark with recognized props, unknown props dropped; zero recognized props → whole span literal (CN-6).
3. Task item in ordered list (`1. [x]`) → ordered `listItem` with literal checkbox text (CN-3 edge).
4. Unclosed fence → code block to EOF.
5. Unsupported block construct / container nesting > 64 deep → literal-text paragraph(s), input lines preserved in order.
6. Any internal tolerant-parser error (safety net at `index.js`) → whole input as literal-text paragraphs, one per line group. Structure lost, words never.

Invariant across all rungs: the oracle of research.md R6 holds.

## 4. Registry extensions (`shared/format-registry.js`)

Existing exports unchanged (byte-compat for strict path): `INLINE_MARKS`, `STYLE_PROPS`, `INLINE_NEWLINE`, `INLINE_HTML_TAGS`, `attrsToCSS`, `cssToAttrs`, `buildInlineRegex`.

New, additive:

| Addition | Shape | Consumer |
|---|---|---|
| `altWrap` field on `INLINE_MARKS` entries | `string[]` of alternate delimiters (bold: `['__']`; italic: `['*']`) | tolerant inline parser only; `buildInlineRegex()` ignores it |
| `getEmphasisSpec()` | derived: `[{ char, length, markName, intraword }]` from `wrap`+`altWrap` (e.g. `{char:'*',length:2,markName:'bold'}`, `{char:'_',length:1,markName:'italic',intraword:false}`) | tolerant delimiter-stack matcher |
| `getHtmlWhitelist()` | derived: `{ tags: [{tag, markName}], span: { styleProps: STYLE_PROPS }, br: true }` from `INLINE_MARKS[].htmlTag` + schema | tolerant HTML tokenizer (FR-010: derived, not hardcoded) |

Rule (FR-015 / Constitution IV): the tolerant parser contains **no** literal mark names, delimiters, or tag names for inline formats — only registry lookups. `link` and `code` handling may special-case algorithmically (CommonMark requires it) but read their syntax from registry entries.

## 5. Fixture entities (checked-in test data)

| File | Shape |
|---|---|
| `server/__tests__/fixtures/markdown/commonmark/<construct>.json`, `gfm/<construct>.json` | `[{ id: <official example number>, section: string, markdown: string, expected: <PM doc JSON> }]` (CN-7: expected translated once at curation) |
| `.../EXCLUSIONS.md` | table: example id · construct area · one-line reason (SC-001 audit surface) |
| `.../real-world/<name>.md` + `<name>.expected.json` | source doc + structural expectation `{ blocks: [<type sequence w/ key attrs>] }` (SC-002: no false literal-text degradation) |
| `.../strict-characterization.json` | `[{ name, input, diffMark, expected }]` — generated by pre-move parser via a committed generator script; strict mode must deep-equal forever (CN-2) |

## 6. State transitions

None — the parser is stateless and pure. The only stateful consumer (diff cache in Redis) is unaffected by design: strict output byte-identical ⇒ `CACHE_VERSION v7` entries remain valid.
