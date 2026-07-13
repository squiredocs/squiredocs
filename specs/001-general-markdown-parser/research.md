# Research & Decisions — 001-general-markdown-parser

Phase 0 output. All spec-level open questions were already settled in `clarifications-needed.md` (CN-1…CN-10); this file records the **implementation-level** decisions, each grounded in the design docs and the real code (`server/markdown-to-pm.js`, `server/format-registry.js`, `server/diff-service.js`, `server/mcp/yjs/serialization.js`, `server/__tests__/format-roundtrip.test.js`, `client/vite.config.js`). No NEEDS CLARIFICATION items remain.

---

## R1 — Strict mode is a frozen verbatim copy, not a branch-flagged single implementation

**Decision**: Move the current `server/markdown-to-pm.js` to `shared/markdown/strict-parser.js` **verbatim** (only the `require('./format-registry')` path changes to `require('../format-registry')`). The tolerant parser is a separate implementation under `shared/markdown/tolerant/`. `shared/markdown/index.js` dispatches: `{ strict: true }` → frozen parser; default → tolerant.

**Rationale**: CN-2 defines strict mode as *byte-identical for any input* to the pre-feature parser. A single implementation with `if (strict)` branches makes that guarantee fragile — every tolerant-grammar change re-risks the diff engine, and "identical" would have to be re-proven per change. A frozen copy makes byte-identity true by construction (same code, same registry inputs — `buildInlineRegex()` is untouched), verified by a characterization snapshot generated from the pre-move parser. It also keeps the Redis diff cache valid with no `CACHE_VERSION` bump (spec Assumption).

**Alternatives considered**:
- *Single implementation, mode flags throughout*: rejected — cannot structurally guarantee CN-2; every future tolerant fix becomes a diff-engine regression risk; testing burden (prove byte-identity after each change) exceeds the cost of ~330 duplicated lines.
- *Strict = "tolerant minus risky extensions"*: rejected in CN-2 itself.

**Non-duplication note (Constitution IV)**: what is duplicated is block-scanning control flow, not format knowledge. Both parsers consume the same registry (`INLINE_MARKS`, `INLINE_HTML_TAGS`, `STYLE_PROPS`, `cssToAttrs`, `buildInlineRegex`); adding a mark still means one registry entry and zero parser edits on the strict path, one metadata read on the tolerant path.

## R2 — Emphasis via the CommonMark delimiter-stack algorithm, driven by registry metadata

**Decision**: The tolerant inline parser implements CommonMark's delimiter-stack algorithm (spec appendix "phase 2: inline structure"): scan delimiter runs of `*`, `_`, `~~`, record can-open/can-close via left-/right-flanking rules (with the intraword `_` restriction), then match with the `openers_bottom` optimization. The mapping *delimiter run → mark* comes from the registry: `INLINE_MARKS` entries gain optional `altWrap` metadata (bold: `**`/`__`; italic: `*`/`_`; strike: `~~` unchanged), and a new derived export (`getEmphasisSpec()`) hands the tolerant parser `{ char, length, markName, intraword }` tuples.

**Rationale**: Regex alternation (the strict approach) cannot express flanking rules, nested emphasis like `**bold with *italic* inside**` across delimiter variants, or `_intra_word` restrictions — this is exactly the "hand-built emphasis nesting" cost the design accepted. The delimiter stack is the reference algorithm, terminates in O(n) with `openers_bottom`, and satisfies SC-006 against pathological delimiter floods. Registry-sourced metadata satisfies FR-015/Constitution IV: a future mark with new delimiters is a registry entry, not parser code.

**Alternatives considered**: recursive-descent regex per mark (rejected: incorrect nesting semantics + catastrophic backtracking risk); porting micromark (rejected by the design decision itself — no third-party markdown code).

## R3 — Fuzz/property testing with `fast-check` (devDependency)

**Decision**: Add `fast-check` to root `package.json` `devDependencies` for `server/__tests__/markdown-fuzz.test.js`. Fixed seed committed in the test (deterministic CI) plus `numRuns` in the low thousands per property (SC-003 "thousands of inputs per run").

**Rationale**: Spec Assumptions explicitly allow a test-only property-testing helper "if justified at plan time". Justification: shrinking (a failing 4 KB garbage input auto-reduces to a minimal repro — hand-rolled PRNG fuzzers make failures nearly undebuggable), seeded reproducibility, arbitraries for weighted generator mixes (random unicode / mutated markdown / truncated constructs / adversarial HTML / pathological nesting), and it works under today's Jest and the unmerged Vitest branch. Zero runtime-dependency posture is untouched.

**Alternatives considered**: hand-rolled seeded generator (rejected: no shrinking); jsverify (unmaintained).

## R4 — Module format: CommonJS; client-safety proven by Vitest import + module-graph scan

**Decision**: All `shared/markdown/*` and `shared/format-registry.js` stay CommonJS, matching `shared/prosemirror-schema.js` (spec Assumption). TR-005/SC-007 is enforced by `client/src/__tests__/sharedMarkdown.test.js` (Vitest, jsdom): (a) import the shared entry and registry through the client toolchain, (b) parse a sample and assert structure, and (c) statically walk the shared module graph (read files, collect `require()` targets) asserting every target is a relative path inside `shared/` or `prosemirror-model` — no Node built-ins (`fs`, `path`, `buffer`, `crypto`, …).

**Rationale**: The static graph scan encodes FR-014 directly and fails loudly if anyone adds a Node built-in later; the runtime import proves the client toolchain loads the modules (Vite/Vitest handle CJS interop; the client already imports from `../shared` — `svg-sanitizer.mjs`). Actual editor-paste bundling is M5; if the M5 dev-server path needs ESM, the Vitest+ESM migration branch already plans the conversion.

**Alternatives considered**: convert shared modules to ESM now (rejected: server is CJS under Jest, and Jest does not support `require(esm)`; the migration branch owns that change); dual CJS/ESM builds (rejected: build machinery for a problem M1 doesn't have).

## R5 — Fixture strategy: curated spec examples translated to ProseMirror JSON at curation time

**Decision**: Fixtures are checked-in JSON files under `server/__tests__/fixtures/markdown/`:
- `commonmark/<construct>.json` and `gfm/<construct>.json` — arrays of `{ id, section, markdown, expected }` where `id` is the official spec example number (CommonMark 0.31.2 / GFM spec section) and `expected` is Squire ProseMirror JSON (translated once from the spec's HTML expectation, per CN-7).
- `EXCLUSIONS.md` — one line per excluded example in a covered area: example id + reason (e.g. "requires reference-link definitions — unsupported construct").
- `real-world/*.md` with `*.expected.json` structural expectations (block-type sequence, not full JSON) for ≥10 documents: agent-generated specs, GitHub READMEs, spec-kit output (SC-002).
- `strict-characterization.json` — `{ input, expected }` pairs generated by running the **pre-move** parser over a corpus (canonical serializer outputs incl. every registry mark/style/block, diff-style hunk fragments, edge inputs); regenerating requires deliberately re-running the generator script, so drift is loud.

**Rationale**: Translating expectations to Squire's schema once at curation time (CN-7) keeps the runner trivial (`parse(markdown)` deep-equals `expected`) and avoids importing an HTML renderer. Example ids keep the curation auditable against the official specs. A dedicated exclusions file makes SC-001's "every exclusion carries a written reason" checkable.

**Alternatives considered**: vendoring the full spec.txt runners (rejected: imports full-conformance scope the design explicitly rejected); HTML-expectation comparison via serializer (rejected: conflates serializer bugs with parser conformance).

## R6 — Fuzz oracle for FR-013: ordered word-subsequence preservation with entity-decode preprocessing

**Decision**: The property for "never lose content": for input `s`, let `expected = words(decodeEntitiesOutsideCode(normalizeLineEndings(s)))` where `words` extracts maximal alphanumeric/unicode-letter runs; let `actual = plainText(parse(s))`. Assert (1) parse never throws, (2) `schema.nodeFromJSON(result).check()` passes (schema validity), (3) `expected` is an ordered subsequence of `words(actual)`, (4) non-empty input yields non-empty text unless input contains no letters/digits.

**Rationale**: FR-013's precise invariant permits syntax consumption (markers, delimiters, escape backslashes, entity source text, whitelist tags, line endings) — all of which affect only punctuation/whitespace, never letters/digits, *except* entity decoding (`&#65;` → `A`), which the oracle handles by decoding the input first (using the same entities module, acceptable for an inequality-style safety property since entities are additionally covered by exact-expectation fixtures). Word-level comparison makes the oracle implementation-independent and robust across all five generator families.

**Alternatives considered**: exact character accounting of consumed syntax (rejected: re-implements the parser in the oracle); substring containment of raw input (rejected: legitimately false — markers are consumed).

## R7 — `shared/markdown/` module layout and public surface

**Decision**: Public entry `shared/markdown/index.js` exporting `markdownToPm(markdown, diffMark = null, { strict = false } = {})` and `parseInline` (re-exported from the strict parser for signature compatibility; no external callers exist today — verified by grep). Internal modules: `strict-parser.js` (frozen), `tolerant/block-parser.js`, `tolerant/inline-parser.js`, `tolerant/entities.js`. Nothing under `server/` re-exports them (FR-014: import sites updated, originals deleted).

**Rationale**: Matches design §1.1's "small line-classifier plus an inline tokenizer" structure; a single entry point keeps 002's import module and M5 paste on one contract (see `contracts/parser-api.md`). Options-object mode selection follows the design's "add a `strict` option" wording (CN-1) and is backward compatible per FR-002.

## R8 — Diff-engine wiring: three call sites opt into strict; no cache bump

**Decision**: `server/diff-service.js` changes `require('./markdown-to-pm')` → `require('../shared/markdown')` and passes `{ strict: true }` at all three `markdownToPm` calls in `computeMarkdownDiff` (added / removed / unchanged hunks — all parse partial hunk fragments). `CACHE_VERSION` stays `'v7'`.

**Rationale**: CN-1 (diff engine explicitly opts into strict); all three calls parse line-diff fragments, so all three need fragment-stable strict semantics (a fragment ending in `---` must stay a horizontalRule). Byte-identical strict output (R1) keeps cached diff documents valid per the spec Assumption.

## R9 — Tolerant-grammar boundary decisions (within FR-003…FR-012)

Small grammar calls the spec leaves to the plan, all bounded by "tolerance must not change canonical parses" (US3 AS-3):

- **Thematic breaks**: accept CommonMark runs of 3+ `-`, `*`, or `_` (with interior spaces) as `horizontalRule`. Canonical `---` unchanged; `***`/`___` acceptance is part of the `---` disambiguation logic and costs nothing. Setext takes precedence for `-` runs directly under a paragraph line (Edge Case rule).
- **Fenced code**: backtick fences per CommonMark (info string, up to 3 leading spaces, closing run ≥ opening run, unclosed → EOF). Tilde fences (`~~~`) are **excluded** (degrade to paragraph text; entry in EXCLUSIONS.md) — canonical dialect and target corpora use backticks.
- **ATX trailing hashes** (`## title ##`): accepted per CommonMark (closing sequence stripped).
- **Images**: `![alt](src)` keeps parsing exactly as today (literal `!` + link mark on `alt`) in **both** modes. Verified against the current code: the inline link regex matches `[alt](src)` and `!` stays literal text. Producing real `image` nodes would change canonical-input structure (violating US3 AS-3/FR-012) and image ingestion policy is explicitly 002's scope (fetch-and-rehost). FR-012's "images" therefore means "identical to today's handling".
- **Blockquotes**: `>` with optional space, nested quotes, lazy continuation (FR-005); `> [!NOTE]` parses as a plain blockquote whose first text is `[!NOTE]` (spec US2 AS-2).
- **Tables**: current pipe-leading dialect only (line starts with `|`), alignment-colon separators tolerated, `\|` escapes in cells — unchanged from today (CN-8). Rows without a leading `|` degrade to paragraphs.
- **Task-list seam (FR-004/CN-3)**: `tolerant/block-parser.js` contains a single function `taskItemNode({ checked, contentNodes })` — the only place that decides what a recognized task item becomes. M1 body: return a `listItem` whose first paragraph is prefixed with literal `[x] `/`[ ] ` text. A code comment at the seam documents the feature-003 handoff (flip to `taskItem` node with `checked` attr).
- **CRLF**: `\r\n` → `\n` normalization as the tolerant parser's first step; lone `\r` also normalized. Strict path untouched (byte-identity).
- **Setext underline**: `=` runs → H1, `-` runs → H2, only when the previous line is a paragraph continuation line (not blank, not another construct), per CommonMark precedence.
- **Autolink schemes (CN-5)**: angle-bracket autolinks per CommonMark (scheme `[a-zA-Z][a-zA-Z0-9+.-]{1,31}:`, no spaces/`<`; email form → `mailto:`); bare autolinks per GFM www/url productions only (`http://`, `https://`, `www.` + valid-domain check + trailing-punctuation trimming); **no** bare-email detection.
- **Entities (CN-4)**: decimal `&#N;` (with `&#0;` and out-of-range → U+FFFD per spec), hex `&#xN;`, plus the CN-4 curated named list; unknown named entities stay literal. No decoding inside code spans/blocks (FR-009).

## R10 — Performance strategy and measurement (SC-006)

**Decision**: Complexity budget: block scan is single-pass over lines with a bounded container stack; inline parsing is single-pass tokenization + delimiter-stack matching with `openers_bottom` (prevents O(n²) on `****…` floods); no regex with nested unbounded quantifiers over untrusted input on the tolerant path; recursion only over container depth with an explicit cap (nesting deeper than 64 containers degrades to literal text — content preserved). Measurement: `markdown-fuzz.test.js` includes timing assertions — a generated ~100 KB representative document parses < 1 s, and every fuzz case ≤ 64 KB is wall-clocked with a 5 s guard; generous bounds keep CI non-flaky while still catching catastrophic blowups.

**Rationale**: The known markdown DoS shapes are emphasis-delimiter floods, deep nesting, and backtracking regexes; each has a named mitigation above. The depth cap is a degradation (text preserved), consistent with FR-013.
