# CommonMark / GFM fixture exclusions (SC-001 audit surface)

For each supported construct (spec FR-003…FR-011) the fixtures under
`commonmark/` and `gfm/` curate representative official spec examples, with the
expected structure translated once to Squire's ProseMirror schema (CN-7).
Expectations were verified against CommonMark 0.31.2 / GFM spec semantics at
curation time.

Every official example in a **covered area** that we deliberately do NOT assert
is listed below with a one-line reason. Examples belonging to constructs that
are entirely out of the supported grammar (reference links, HTML blocks,
link/image reference definitions, footnotes, math, etc.) are out of scope by the
spec (Out of Scope) and are not enumerated here.

| Area | Excluded example(s) | Reason |
|------|---------------------|--------|
| Emphasis | multi-rule "rule of 3" / precedence corner cases (e.g. `*foo**bar**baz*` variants) | Delimiter-stack handles them, but exact HTML→PM translation of every precedence example adds no coverage over the nesting cases already asserted. |
| Fenced code | tilde-fence examples (` ~~~ `) | Tilde fences are excluded from the grammar (research R9); they degrade to paragraph text. Backtick fences are covered via round-trip + tolerant suites. |
| Fenced code | info-string with backtick / attributes | Only the first info word (language, mermaid/svg routing) is used; exotic info strings are not part of the dialect. |
| Indented code | indented code inside a list item's continuation | Interaction is context-dependent (de-indent relative to the item); covered structurally by the list suite rather than as isolated spec examples. |
| Entities | the full ~2100 HTML5 named-entity table | CN-4: only numeric refs + a curated named set are supported; unlisted named entities are preserved as literal text (lossless). `&unknownentity;` asserts that path. |
| Autolinks | bare email autolinks (`foo@bar.com` without angle brackets) | CN-5: bare-email detection is intentionally excluded from v1 to avoid `@handle` false positives; angle-bracket email autolinks are covered. |
| Setext | multi-line setext content exact whitespace | We join soft-wrapped heading lines with a space; the official examples keep a newline. Words preserved; asserted via `setext-03`. |
| Links | reference-style links `[text][ref]` and link reference definitions | Unsupported construct (no reference resolution); degrades to literal text. |
| Images | `![alt](src)` producing an image node | R9: images stay literal `!` + link mark in M1 (image ingestion is feature 002). |
| GFM tables | rows without a leading pipe; alignment cell rendering | CN-8: only the pipe-leading dialect is in M1 scope; non-pipe rows degrade to paragraphs. |
