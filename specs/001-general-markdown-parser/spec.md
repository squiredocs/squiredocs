# Feature Specification: General Markdown Parser (Tolerant CommonMark + GFM Subset)

**Feature Branch**: `001-general-markdown-parser`

**Created**: 2026-07-13

**Status**: Draft

**Input**: User description: "M1 — General parser: generalize markdownToPm from 'the dialect toMarkdown emits' to a tolerant CommonMark+GFM subset per design/markdown-import-two-way-sync.md §Design Decision and §1.1; move parser and format registry under shared/; keep signature with a strict mode for diff-service; enforce the never-lose-content rule; CommonMark/GFM fixture, round-trip, and fuzz testing."

**Design ground truth**: `design/markdown-import-two-way-sync.md` (sections "Design Decision: Extend the In-House Parser" and "Part 1 — 1.1 Parser generalization"); current-state architecture in `design/document-model-format-pipeline.md`. Where this spec had to settle something those documents leave open, the decision is recorded as RATIFIED-BY-DEFAULT in `specs/001-general-markdown-parser/clarifications-needed.md` (referenced below as CN-#).

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Real-world markdown parses into correctly structured documents (Priority: P1)

An AI agent or a human produces ordinary markdown — a spec written by an agent, a GitHub README, spec-kit output — using the constructs people actually type: `*bold*`-style emphasis variants, task-list checkboxes, lists with blank lines between items and multi-paragraph items, setext headings, indented code, bare URLs, backslash escapes, and HTML entities. When that markdown is converted to a Squire document (today: by the parser directly; from feature 002 on: via import surfaces), the resulting document has the structure the author intended — not a pile of literal-text paragraphs.

**Why this priority**: This is the entire point of M1. Today the parser accepts only the exact dialect Squire's own serializer emits; every downstream milestone (import surfaces, portable export, two-way sync, editor paste) depends on tolerant parsing existing first.

**Independent Test**: Feed the parser curated CommonMark and GFM specification examples for each supported construct, plus real-world samples (agent-generated specs, GitHub-flavored READMEs, spec-kit output), and verify the produced document structure matches the expected structure for every fixture.

**Acceptance Scenarios**:

1. **Given** markdown using `**bold**`, `__bold__`, `*italic*`, `_italic_`, and nested forms like `**bold with *italic* inside**`, **When** parsed in tolerant mode, **Then** the corresponding bold/italic marks are applied per CommonMark emphasis rules (including intraword `_` restrictions), regardless of which delimiter variant the author chose.
2. **Given** a list whose items are separated by blank lines (loose list), contain multiple paragraphs, or use lazy continuation lines, **When** parsed in tolerant mode, **Then** a single list is produced with each item containing all of its paragraphs, and continuation text stays inside its item.
3. **Given** a heading written in setext form (`Title` underlined with `===` or `---`), **When** parsed in tolerant mode, **Then** a level-1 or level-2 heading node is produced.
4. **Given** a code block written as four-space-indented lines, **When** parsed in tolerant mode, **Then** a code block node is produced containing the de-indented text.
5. **Given** text containing `<https://example.com>`, a bare `https://example.com`, or `www.example.com`, **When** parsed in tolerant mode, **Then** a link is produced whose visible text is the URL (per CN-5 for the supported scheme set).
6. **Given** text containing `\*not emphasis\*` and `&amp;` / `&#65;` entities, **When** parsed in tolerant mode, **Then** the output text contains the literal `*not emphasis*` and the decoded characters `&` / `A`, with no emphasis marks applied.
7. **Given** a GFM task list (`- [ ] todo` / `- [x] done`), **When** parsed in tolerant mode, **Then** a bullet list is produced and the checkbox state text is preserved in each item (degradation per CN-3; native task-list nodes arrive in feature 003 — see Dependencies & Handoffs).
8. **Given** markdown containing `<u>underlined</u>`, `<mark>highlighted</mark>`, `<sub>`/`<sup>`, `<span style="color:#333">styled</span>`, and `<br>`, **When** parsed in tolerant mode, **Then** the registry-known tags become their corresponding marks (and `<br>` a hard line break), exactly as the canonical dialect already does.
9. **Given** markdown containing HTML the registry does not know (`<div>`, `<script>alert(1)</script>`, `<custom-tag>`), **When** parsed in tolerant mode, **Then** that HTML appears in the document as literal, visible text — never executed, never dropped.

---

### User Story 2 - No input ever loses content (Priority: P1)

Anyone converting markdown of unknown provenance — malformed, hostile, or simply using unsupported constructs (footnotes, math, callouts) — gets a document that still contains every piece of their text. Worst case, structure degrades to plain paragraphs; the words always survive.

**Why this priority**: This is the design's explicit safety rule for all import work ("Import must never lose content — worst case it loses structure"), and it is what makes tolerant parsing safe to expose to untrusted agent output (Constitution Principle V: agent content is untrusted input).

**Independent Test**: A fuzz/property test generates arbitrary and adversarial inputs (random text, truncated constructs, pathological nesting, binary-ish garbage) and asserts for every input that the parsed document's plain text contains the input's plain text.

**Acceptance Scenarios**:

1. **Given** any input string, **When** parsed in tolerant mode, **Then** a structurally valid document is produced (never an exception, never an empty result for non-empty input) whose plain text preserves the input's textual content (whitespace/structural markers may normalize; see FR-013 for the precise invariant).
2. **Given** markdown using unsupported constructs (footnote `[^1]`, math `$x^2$`, callout `> [!NOTE]` beyond plain blockquote), **When** parsed, **Then** the text of those constructs is preserved as literal text (inside whatever enclosing structure does parse).
3. **Given** an unclosed code fence or unbalanced HTML tags, **When** parsed, **Then** all remaining text is preserved (as code-block content or literal text respectively) and the parser terminates normally.

---

### User Story 3 - Version diffs behave exactly as they do today (Priority: P2)

A user viewing version history sees the same diff rendering before and after this feature ships. The diff engine — today the parser's only production consumer — re-parses markdown that Squire itself emitted, including partial hunk fragments produced by line-based diffing, and must not be affected by tolerant re-interpretation of those fragments (for example, a hunk fragment ending in `---` must remain a horizontal rule, not become a setext heading underline).

**Why this priority**: Protects an existing, working, user-visible feature from regression. It is P2 only because it is a preservation requirement rather than new value — but it is a hard gate for shipping.

**Independent Test**: The diff engine opts into strict mode (CN-1); the full existing diff-service and round-trip test suites pass with byte-identical parser output for all canonical-dialect inputs.

**Acceptance Scenarios**:

1. **Given** any markdown produced by Squire's own serializer, **When** parsed in strict mode, **Then** the output is identical to the current parser's output (CN-2).
2. **Given** the diff engine computing a version diff whose hunks split blocks at arbitrary line boundaries, **When** the diff document is built, **Then** the rendered diff is unchanged from today's behavior.
3. **Given** any markdown produced by Squire's own serializer, **When** parsed in tolerant mode, **Then** the resulting document structure is also unchanged — tolerance extends the accepted grammar; it must not alter the meaning of the canonical dialect (see Edge Cases for the one construct requiring care: `---`).

---

### User Story 4 - One grammar serves server and client (Priority: P3)

The parser and the format registry live in the shared client-safe area of the codebase, so the same grammar that powers server-side import (feature 002) can power editor paste (deferred to M5) without a second implementation. All existing consumers keep working.

**Why this priority**: Pure enablement/refactoring value — required by the design's shared-code note and the constitution ("Shared client/server logic (schema, sanitizers, parsers) belongs under `shared/`"), but it delivers no user-visible behavior by itself.

**Independent Test**: Parser and registry modules reside under `shared/`, every import site is updated, both modules load in a browser-like (non-Node) module environment, and all existing server and client test suites pass.

**Acceptance Scenarios**:

1. **Given** the relocated modules, **When** the full backend test suite runs, **Then** all serializer, diff, and round-trip tests pass with no behavioral change.
2. **Given** the relocated modules, **When** loaded in a client (bundler/browser) context, **Then** they import successfully with no Node-only dependencies (no `fs`, `path`, `Buffer`, etc.).

---

### Edge Cases

- **`---` disambiguation** (the one place tolerant grammar could collide with the canonical dialect): the serializer emits `---` for horizontal rules and always separates blocks with a blank line. Per CommonMark, `---` immediately following a paragraph line is a setext H2 underline; `---` after a blank line is a thematic break. Tolerant mode MUST implement this correctly so canonical exports keep parsing as horizontal rules while human-authored setext headings work. Strict mode keeps today's unconditional horizontal-rule behavior.
- **Unclosed code fence**: consumes to end of input as code content (today's behavior; content preserved).
- **Escapes and entities inside code**: backslash escapes and entities are NOT processed inside code spans or code blocks (CommonMark); fenced/indented code content is verbatim.
- **`<span style>` with unrecognized CSS properties**: recognized registry properties are applied; unrecognized properties are dropped (styling loss is acceptable, text is not); a span with zero recognized properties is preserved as literal text, tags included (CN-6).
- **Nested / unbalanced whitelist tags**: balanced nesting of whitelist tags parses as nested marks; unbalanced whitelist tags degrade to literal text for the unmatched portion.
- **Task-list marker in ordered lists** (`1. [x] item`): GFM defines task items for list items generally, but Squire's degradation target is a bullet list; ordered-list checkbox syntax is preserved as literal item text inside the ordered list (CN-3).
- **Ordered list not starting at 1** (`3. first`): tolerant mode honors the first item's number as the list's start value; strict mode keeps today's fixed start of 1.
- **CRLF / mixed line endings**: tolerant mode treats `\r\n` as a line ending (real-world files are frequently CRLF); no `\r` characters leak into document text.
- **Pathological inputs** (thousands of nested emphasis delimiters, enormous single lines): the parser must terminate in reasonable time (see SC-006) — no catastrophic backtracking or unbounded recursion.
- **Empty input / whitespace-only input**: produces a valid document with a single empty paragraph (today's behavior).
- **YAML frontmatter** (`---\nkey: value\n---` at document start): M1 has no frontmatter awareness — it parses under normal rules (thematic break + paragraphs, per CommonMark precedence). Frontmatter semantics belong to features 002/003 (see Dependencies & Handoffs).
- **GFM tables beyond the current pipe-leading dialect** (rows without a leading `|`, alignment semantics beyond separator tolerance): not in the design's M1 priority list; such input degrades to paragraphs preserving text (CN-8).

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: The parser MUST provide two modes: **tolerant** (the default) and **strict**. Strict mode MUST reproduce the current parser's exact-dialect behavior: for any input, strict-mode output is identical to the output of the parser as it exists before this feature (CN-2).
- **FR-002**: The public entry point MUST keep its current signature shape — a function taking `(markdown, diffMark)` — extended only in a backward-compatible way (an optional options argument selecting the mode). Existing two-argument call sites MUST remain valid. The diff engine MUST opt into strict mode explicitly (CN-1).
- **FR-003 (Emphasis variants)**: Tolerant mode MUST accept `*emph*` and `_emph_` as italic and `**strong**` and `__strong__` as bold, including nested combinations (e.g. `**bold with *italic* inside**`), following CommonMark left-/right-flanking delimiter rules and the intraword restriction on `_`. Conformance is measured against the curated CommonMark example subset (CN-7).
- **FR-004 (Task-list syntax)**: Tolerant mode MUST recognize GFM task-list item syntax (`- [ ]` / `- [x]`, case-insensitive `x`, also under `*` and `+` bullets) as list items. Until feature 003 adds task-list nodes to the schema, recognized task items MUST degrade to regular bullet-list items with the literal checkbox marker preserved as leading item text, so checked-state information survives (CN-3). The recognition point MUST be a single, isolated seam such that feature 003 can switch the produced node type without re-touching grammar logic (see Dependencies & Handoffs).
- **FR-005 (Lists)**: Tolerant mode MUST parse: loose lists (blank lines between items) and tight lists into the same list structure; multi-paragraph list items (indented continuation blocks belong to the item); lazy continuation lines (unindented paragraph continuation inside list items and blockquotes); nested lists at CommonMark-compatible indentation (not only the serializer's exact indent widths); `-`, `*`, and `+` bullet markers; and `1.` / `1)` ordered markers with the start number honored.
- **FR-006 (Setext headings)**: Tolerant mode MUST parse a paragraph line underlined by `=` characters as a level-1 heading and by `-` characters as a level-2 heading, per CommonMark precedence rules (including the `---` disambiguation in Edge Cases).
- **FR-007 (Indented code)**: Tolerant mode MUST parse four-space/tab-indented blocks (outside list-item continuation context) as code blocks with verbatim, de-indented content.
- **FR-008 (Autolinks)**: Tolerant mode MUST parse CommonMark angle-bracket autolinks (`<absolute-uri>`, `<email>` → mailto link) and GFM bare-URL autolinks for `http://`, `https://`, and `www.`-prefixed URLs (CN-5), producing link marks whose visible text is the URL.
- **FR-009 (Escapes and entities)**: Tolerant mode MUST honor CommonMark backslash escapes of ASCII punctuation (escaped characters are literal, never structural) and MUST decode HTML entities: all numeric character references (decimal and hexadecimal) plus a curated set of common named entities; unrecognized named entities are preserved as literal text (CN-4). No escape/entity processing inside code content.
- **FR-010 (HTML passthrough whitelist)**: Tolerant mode MUST convert exactly the registry-known inline HTML to marks/nodes — the tags the canonical dialect already uses (underline, highlight, subscript, superscript tags as derived from the schema; `<span style>` with registry style properties; `<br>` → hard line break) — and MUST preserve ALL other HTML (tags, attributes, scripts, comments, block-level HTML) as literal visible text. HTML is never executed, never interpreted beyond the whitelist, and never silently dropped. The whitelist MUST be derived from the format registry, not hardcoded, so future registry marks join it automatically. Trust boundary (Constitution Principle V): all parser input is untrusted text; the parser's only output is inert document JSON — no code execution, no network access, no URL fetching.
- **FR-011 (Hard line breaks)**: Tolerant mode MUST parse CommonMark hard line breaks (trailing backslash and two-or-more trailing spaces) and `<br>` into the schema's existing hard-break node (CN-9).
- **FR-012 (Preserved canonical behavior)**: Everything the parser handles today MUST keep working identically in both modes for canonical (serializer-emitted) input: ATX headings, fenced code with language, mermaid/svg fence routing to diagram nodes, pipe tables (with escaped `\|` in cells and alignment-colon separators tolerated), blockquotes, nested lists, images, links, all registry inline marks and style spans, inline-HTML newline continuation, and diff-mark application to every text node.
- **FR-013 (Never-lose-content invariant)**: For every input string, tolerant mode MUST produce a schema-valid document without throwing, and the document's plain text MUST preserve the input's textual content. Precisely: after accounting for markdown syntax legitimately consumed into structure (heading/list/quote markers, fence delimiters, emphasis delimiters, escape backslashes, entity source text replaced by decoded characters, whitelist HTML tags replaced by marks, line-ending normalization), every remaining character of the input's text MUST appear in the output document's plain text, in order. Unparseable or unknown constructs degrade to literal-text paragraphs — degradation loses structure, never words.
- **FR-014 (Shared relocation)**: The parser and the format registry MUST live under `shared/` (alongside the shared schema), MUST be loadable in both server and client module environments, and MUST have no Node-only dependencies. All import sites (serializer, diff engine, tests) MUST be updated; no stale copies remain under `server/`.
- **FR-015 (Registry-driven, single source of truth)**: Inline-mark grammar MUST remain driven by the format registry (Constitution Principle IV): alternate emphasis delimiters and any new inline token forms are expressed as registry entries/extensions, not parser-local knowledge, so export, import, and future surfaces cannot drift apart.
- **FR-016 (Round-trip invariant)**: For every mark and node in the registry/schema, serialize-then-parse MUST preserve it (the existing registry-driven round-trip suite, extended, is the enforcement mechanism). Canonical serializer output MUST parse to equivalent structure in both strict and tolerant modes.

### Testing Requirements *(Constitution Principle II)*

- **TR-001**: Import curated subsets of the official CommonMark and GFM specification examples covering every supported construct (emphasis, lists, setext, indented code, autolinks, escapes, entities, hard breaks, task-list syntax); each excluded example in a covered area MUST carry a documented reason (CN-7).
- **TR-002**: Extend the registry-driven round-trip suite (`server/__tests__/format-roundtrip.test.js`) so it exercises both parser modes and continues to cover new marks/nodes by construction.
- **TR-003**: Add a fuzz/property test enforcing FR-013 across generated inputs (random text, mutated markdown, truncated constructs, adversarial HTML, pathological nesting).
- **TR-004**: Existing diff-service tests MUST pass unchanged (strict-mode preservation), and a regression test MUST pin the `---`-after-paragraph disambiguation in both modes.
- **TR-005**: A test MUST verify the shared modules are client-safe (importable without Node built-ins).

### Key Entities

- **Parser (tolerant mode)**: converts a markdown string (plus optional diff-mark) into document JSON per the supported grammar; the default mode and the foundation for features 002/004/M5.
- **Parser (strict mode)**: frozen exact-dialect behavior for the diff engine; identical output to the pre-feature parser.
- **Format registry**: the single source of truth for inline mark syntax (markdown delimiters, HTML tags, style properties); gains alternate-delimiter knowledge; relocates to `shared/`.
- **Supported grammar**: the explicit, documented list of constructs the tolerant parser understands (FR-003…FR-012) — deliberately a subset of full CommonMark, with everything outside it covered by the degradation rule.
- **Degradation ladder**: unknown/unparseable constructs → literal-text paragraphs; task lists → bullet lists with markers preserved; unknown HTML → literal text; unknown style properties → dropped styling. Structure may degrade; text never disappears.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: 100% of the curated CommonMark/GFM specification examples for supported constructs pass; the exclusion list is empty or every entry carries a written reason.
- **SC-002**: A corpus of at least 10 real-world documents (agent-generated specs, GitHub READMEs, spec-kit output) parses with correct block structure — zero blocks incorrectly degraded to literal-text paragraphs for constructs within the supported grammar.
- **SC-003**: The fuzz/property suite demonstrates zero content-loss violations and zero parser crashes across its full generated-input run (thousands of inputs per run).
- **SC-004**: All pre-existing backend and client test suites pass after the relocation and strict-mode wiring, with version-diff output byte-identical for canonical inputs.
- **SC-005**: The registry round-trip suite passes for every registry mark, style property, and block type in both parser modes.
- **SC-006**: Parsing a typical large document (100 KB of markdown) completes in under 1 second, and no fuzz input of 64 KB or less takes longer than 5 seconds (guards against pathological backtracking).
- **SC-007**: The parser and registry import cleanly in a client-context test with no Node-only dependency errors.

## Assumptions

- The shared modules keep the module format of the existing shared schema (CommonJS `require`, which the client bundler already consumes for `shared/prosemirror-schema.js`); the unmerged Vitest+ESM migration branch will adapt them the same way it adapts the rest of the backend.
- "Client-safe" in M1 means importable and unit-testable in a browser-like module environment; actually wiring editor paste is M5 and out of scope.
- The diff engine's Redis-cached diff documents remain valid because strict mode is byte-identical; no cache-version bump is required. If implementation cannot achieve byte-identical strict output, a cache-version bump becomes required.
- Backend tests continue to run serially against the shared test database (Constitution Principle II); the new fixture and fuzz suites are pure-function tests needing no database.
- Zero new runtime dependencies for parsing, per the design's "extend in-house parser" decision. Test-only additions (a property-testing helper, spec-example fixture data checked in as files) are acceptable if justified at plan time.
- Feature 002 (import surfaces) is the first production consumer of tolerant mode; within M1, tolerant mode ships exercised by tests only. This is intentional per the milestone plan (M1 has no dependencies; M2 depends on M1).
- Documentation duty (Constitution Principle I): the design docs' current-state descriptions (parser lives under `server/`, parses only the serializer dialect) become stale when this ships. Exported design docs must be amended in Squire and re-synced, and `README.md` updated, as part of the implementation/merge phase — flagged as CN-10 rather than performed here.

## Out of Scope

- Import surfaces — MCP `fromMarkdown` helper, `create_document` markdown parameter, REST import routes, image fetch-and-rehost (feature 002).
- Schema additions (taskList/taskItem), portable export flavor, frontmatter emission/stripping, hardBreak serializer fix (feature 003).
- Sync protocol, baseline reconstruction, source maps, op replay (feature 004).
- Editor paste conversion (deferred to M5).
- Full CommonMark conformance — the supported grammar above is the contract; everything else degrades per FR-013.
- Footnotes, math, callouts (no schema support; degrade to literal text).

## Dependencies & Handoffs

- **To feature 003 (task lists)**: FR-004's recognition seam. M1 parses task-list syntax and degrades to bullet lists with markers preserved; 003 adds the schema nodes and flips the seam to emit them. The seam location and degradation behavior MUST be documented in code at the seam itself, referencing feature 003.
- **To feature 002 (import surfaces)**: tolerant mode's contract (default mode, never-lose-content, HTML whitelist) is what 002 wraps in its import module; no parser API redesign is expected there.
- **Upstream**: none — M1 is the root of the milestone graph (design milestone table: depends on "—").
