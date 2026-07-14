# PoC relaxations owed at promotion — 001-general-markdown-parser

## Tech-debt / consolidation items surfaced by the post-merge review

These do not change behavior today; they are cleanups to fold in when the
tolerant parser is promoted past the M1 PoC. The frozen strict parser
(`shared/markdown/strict-parser.js`) and its byte-identity guarantee (CN-2) stay
untouched.

- **Registry duplication of the mermaid/svg fence map. — CLOSED (Sam P-6,
  2026-07-13; hoisted to registry).** The fence-info → diagram-type map
  `{ mermaid: 'mermaid', svg: 'svg' }` is now owned by the registry as the
  exported constant `DIAGRAM_FENCE_LABELS` (`shared/format-registry.js`). The
  tolerant `block-parser.js` (`fencedCodeNode`) consumes it, and the serializer
  (`server/mcp/yjs/serialization.js`) emits the same labels via the inverse
  `FENCE_LABEL_BY_NODE` derived from it. The frozen strict copy in
  `strict-parser.js` is retained by design — it is characterization-frozen (CN-2)
  and cannot import evolving registry state — and now carries a comment pointing
  at the registry constant as the source of truth.

- **Dead whitelist fields (`.span` / `.br`).** `getHtmlWhitelist()` returns
  `{ tags, span: { styleProps }, br: true }`, but the tolerant inline parser
  only ever reads `.tags` (span handling and `<br>` are special-cased directly).
  The `.span` and `.br` fields are dead. Either consume them in the parser or
  drop them from the registry shape at promotion.

- **Dead `parseInline` re-export.** `shared/markdown/index.js` re-exports
  `parseInline` from the strict parser, but nothing outside `strict-parser.js`
  imports it (it is only used internally by the strict parser). Drop the
  re-export from the public entry at promotion.

- **Fuzz-oracle entity self-reference.** `markdown-fuzz.test.js` computes its
  expected word set with `decodeEntities()` from the same `entities.js` module
  under test (`decodeEntitiesOutsideCode`). A bug in entity decoding would be
  masked in both the oracle and the parser. At promotion, oracle the entity
  expectation against an independent reference (e.g. a table snapshot or a
  third-party decoder) rather than the module under test.

- **Perf-family gap (closed).** The fuzz perf guards previously only covered
  single-character floods; they missed the "flood-plus-closer" O(n²) shapes
  (`'['.repeat(k)+'](x)'`, `'<span …>'.repeat(k)+'</span>'`, `'<u>'.repeat(k)+
  '</u>'`). Closed by F2 (balanced open→close maps in `inline-parser.js`) plus
  new guards in `markdown-fuzz.test.js`.

- **EXCLUSIONS.md fence-info wording (fixed).** The doc line claimed "only the
  first info word … is used"; the parser actually keeps the full trimmed info
  string as `language`. Corrected in `fixtures/markdown/EXCLUSIONS.md` and a new
  line added for the dropped link-title behavior (F3).

## Contract note — `javascript:` (and other unsafe-scheme) hrefs (review finding 7)

The tolerant parser faithfully emits whatever href a link/autolink carries,
including `javascript:` URIs (e.g. `[x](javascript:alert(1))` and
`<javascript:...>`). This is by design at the parser layer (never-lose-content;
the parser does not editorialize). It is safe **today** because the editor's
ProseMirror rendering path does not execute link hrefs as script. This is a
standing contract for downstream consumers:

- Feature 002's **FR-022 URL allowlist** must gate hrefs before they reach any
  navigation or rendering surface that would honor the scheme.
- Any future **HTML export / server-side render** path MUST sanitize/allowlist
  href schemes — the parser will not do it for them.

- **P-5 (fuzz-oracle entity blind spot) — ACCEPTED (Sam, 2026-07-13).** The never-lose-content fuzz oracle decodes entities with the implementation's own decoder, so entity-decoding bugs are invisible to the fuzzer. Accepted as recorded awareness: the entity class is covered by exact-expectation fixtures (CN-4 table), not the fuzzer. No independent oracle built.
