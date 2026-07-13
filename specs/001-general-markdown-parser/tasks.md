# Tasks: General Markdown Parser (Tolerant CommonMark + GFM Subset)

**Input**: Design documents from `/specs/001-general-markdown-parser/`

**Prerequisites**: plan.md, spec.md, research.md, data-model.md, contracts/parser-api.md, quickstart.md, clarifications-needed.md (CN-1…CN-10)

**Tests**: INCLUDED — the spec has explicit Testing Requirements (TR-001…TR-005) and the constitution (Principle II) mandates test-backed changes. New backend suites are pure-function (no DB) but always run serially with the rest (`--runInBand`).

**Organization**: Sized for a single implementer working sequentially in a pipeline worktree. Phases follow user-story priority; [P] marks tasks that touch disjoint files and could be done in either order.

**Execution notes for the implementer**:
- Work on the current branch of the worktree; never run concurrent backend test invocations.
- T001–T003 MUST be completed **before** any file moves — they capture the pre-feature parser's behavior, which is the CN-2 byte-identity baseline.
- The frozen strict parser (`shared/markdown/strict-parser.js`) must never be "improved". Any grammar work happens only under `shared/markdown/tolerant/`.

## Format: `[ID] [P?] [Story?] Description with file path`

---

## Phase 1: Setup (baseline capture + test scaffolding)

**Purpose**: Pin the pre-feature parser's exact behavior and prepare fixtures/deps. No production code changes yet.

- [x] T001 Write and run the characterization generator `server/__tests__/fixtures/markdown/generate-strict-characterization.js` (committed): it requires the CURRENT `server/markdown-to-pm.js` and emits `server/__tests__/fixtures/markdown/strict-characterization.json` (`[{ name, input, diffMark, expected }]`). Corpus: canonical `toMarkdown` output for every registry inline mark, every STYLE_PROP, links, and every block type (heading, codeBlock+language, mermaid, svg, bulletList incl. nested, orderedList, blockquote, horizontalRule, table incl. `\|` cells, paragraph); diff-hunk-style fragments (fragment ending in `---`, partial list, unclosed fence, `<span style>` line + continuation line, lone closing tag); edge inputs (empty string, whitespace-only, CRLF text, `![alt](src)` image markdown); each with `diffMark` null, `'diffInsert'`, and `'diffDelete'` variants for a representative subset. Check the JSON in.
- [x] T002 [P] Add `fast-check` to root `package.json` devDependencies (`npm install --save-dev fast-check` at repo root; commit `package.json` + `package-lock.json`) and create fixture directories `server/__tests__/fixtures/markdown/{commonmark,gfm,real-world}/`.
- [x] T003 Create `server/__tests__/markdown-strict-characterization.test.js`: loads `strict-characterization.json` and deep-equals parser output for every case. Initially requires `../markdown-to-pm` (must be green before any move); T006 repoints it to `require('../../shared/markdown')` with `{ strict: true }`. Run: `npx jest server/__tests__/markdown-strict-characterization.test.js --runInBand`.

**Checkpoint**: baseline snapshot committed and green against the untouched parser.

---

## Phase 2: Foundational (relocation + strict mode + consumer wiring) — BLOCKS all user stories

**Purpose**: Move registry + parser under `shared/`, introduce the mode dispatch, wire the diff engine to strict. After this phase the public contract (contracts/parser-api.md) exists; tolerant mode temporarily delegates to strict until Phase 3 flips it.

- [x] T004 Move `server/format-registry.js` → `shared/format-registry.js` verbatim except the schema require becomes `require('./prosemirror-schema')`; update `server/mcp/yjs/serialization.js` to `require('../../shared/format-registry')`; delete `server/format-registry.js` (no shim — FR-014).
- [x] T005 Move `server/markdown-to-pm.js` → `shared/markdown/strict-parser.js` verbatim except the registry require becomes `require('../format-registry')`; create `shared/markdown/index.js` exporting `markdownToPm(markdown, diffMark = null, { strict = false } = {})` (both branches call the strict parser for now; add `// TOLERANT PATH lands in T012` marker) and re-exporting `parseInline`; delete `server/markdown-to-pm.js` (FR-014, removal contract).
- [x] T006 Update all remaining import sites: `server/diff-service.js` (`require('../shared/markdown')`; pass `{ strict: true }` at the three `markdownToPm` calls in `computeMarkdownDiff` — added, removed, unchanged hunks; leave `CACHE_VERSION = 'v7'` untouched, per CN-1/CN-2/R8); `server/__tests__/format-roundtrip.test.js` (all four requires); `server/__tests__/diff-service.test.js` (two requires); `server/__tests__/markdown-strict-characterization.test.js` (require `../../shared/markdown`, call with `{ strict: true }`).
- [x] T007 Foundation verification: `npm run test:server` green with zero assertion changes (characterization, diff-service, round-trip all pass); `grep -rn "markdown-to-pm\|server/format-registry" server/ client/src/ shared/ --include='*.js'` shows no stale requires (comment mentions in `client/src/extensions/diagramBlock.js` may be updated or left; no code references).

**Checkpoint**: parser lives in `shared/`, diff engine on strict, everything byte-identical. User story phases may begin.

---

## Phase 3: User Story 1 — Real-world markdown parses into correctly structured documents (Priority: P1) 🎯 MVP

**Goal**: Tolerant mode parses the CommonMark+GFM subset of FR-003…FR-012 (emphasis variants, loose/lazy/multi-paragraph lists, setext, indented code, autolinks, escapes/entities, hard breaks, task-list degradation, registry-derived HTML whitelist) into correct Squire structure.

**Independent Test**: curated CommonMark/GFM fixture suite + real-world corpus pass (`npx jest server/__tests__/markdown-fixtures.test.js server/__tests__/markdown-tolerant.test.js --runInBand`); quickstart §2 spot-check produces heading/task-bullet/bold/italic structure.

- [x] T008 [P] [US1] Registry tolerant metadata in `shared/format-registry.js`: add `altWrap` fields (`bold: ['__']`, `italic: ['*']`), implement derived exports `getEmphasisSpec()` (`[{ char, length, markName, intraword }]` from wrap+altWrap; `_` entries get `intraword: false`) and `getHtmlWhitelist()` (`{ tags: [{tag, markName}], span: { styleProps }, br: true }` from `INLINE_MARKS[].htmlTag` + STYLE_PROPS) per data-model.md §4. Constraint: existing exports byte-compatible — `buildInlineRegex()` output unchanged; characterization suite must stay green (FR-015, Constitution IV).
- [x] T009 [P] [US1] Create `shared/markdown/tolerant/entities.js`: `decodeEntities(text)` + `decodeEntity(ref)` — decimal `&#N;` and hex `&#xN;` numeric refs (`&#0;`/out-of-range → U+FFFD per CommonMark), plus the CN-4 curated named-entity table; unknown named entities returned as literal source text. Pure, no Node built-ins.
- [x] T010 [US1] Create `shared/markdown/tolerant/inline-parser.js` (depends on T008, T009): single-pass tokenizer producing text/hardBreak nodes with marks — code spans (backtick-run matching, verbatim content, no escapes/entities inside — FR-009); whitelist HTML via `getHtmlWhitelist()` with balanced-nesting parsing, unbalanced → literal, `<span style>` per CN-6 (≥1 recognized prop → mark via `cssToAttrs`, else literal); angle-bracket autolinks (absolute URI + email → `mailto:`) and GFM bare autolinks (`http://`, `https://`, `www.` with trailing-punctuation trimming — CN-5/FR-008); `[text](url)` links; backslash escapes of ASCII punctuation (FR-009); entity decoding; hard breaks (2+ trailing spaces, trailing `\`, `<br>`/`<br/>` → `hardBreak` — FR-011/CN-9); CommonMark delimiter-stack emphasis with flanking rules, intraword-`_` restriction, and `openers_bottom` (research R2), delimiter→mark mapping from `getEmphasisSpec()` only; `![alt](src)` intentionally left to today's behavior (literal `!` + link — R9); `diffMark` appended as last mark on every text node.
- [x] T011 [US1] Create `shared/markdown/tolerant/block-parser.js` (depends on T010): container-stack line classifier per data-model.md §2 — ATX headings (incl. trailing-hash close), setext headings with the `---`-after-paragraph disambiguation (Edge Case: canonical `blank line + ---` stays `horizontalRule`), thematic breaks (`---`/`***`/`___`, 3+, interior spaces), backtick fenced code with info string + mermaid/svg routing + unclosed-fence-to-EOF, indented code (FR-007, not inside list continuation), lists per FR-005 (`-`/`*`/`+`, `1.`/`1)` with start honored in tolerant mode, loose/tight to same structure, multi-paragraph items, lazy continuation, CommonMark-compatible nesting), the **task-list seam**: single function `taskItemNode({ checked, contentNodes })` returning a `listItem` with literal `[x] `/`[ ] ` prefix and a code comment documenting the feature-003 handoff (FR-004/CN-3; ordered-list `1. [x]` stays literal item text), blockquotes (`>` optional space, nesting, lazy continuation, `> [!NOTE]` as plain quote), pipe-leading tables exactly as today (CN-8), CRLF/`\r` normalization as first step, container-depth cap 64 with literal-text degradation, unknown block constructs → literal-text paragraphs (FR-013 ladder).
- [x] T012 [US1] Flip `shared/markdown/index.js` default branch to the tolerant block parser and add the top-level never-throw safety net (any internal error → literal-text paragraphs, data-model ladder rung 6); write construct-level tests in `server/__tests__/markdown-tolerant.test.js` covering all nine US1 acceptance scenarios and every spec Edge Case (`---` disambiguation, unclosed fence, escapes/entities-in-code, span-style policies, unbalanced whitelist tags, ordered-list checkbox, list start number incl. strict-mode fixed start 1, CRLF, empty input, YAML-frontmatter-as-normal-markdown, non-pipe table degradation).
- [x] T013 [US1] Extend `server/__tests__/format-roundtrip.test.js`: run every registry-driven round-trip assertion in BOTH modes (parameterize `roundTrip(doc, diffMark, { strict })`), and add a canonical-equivalence check — for each corpus doc, tolerant-mode structure deep-equals strict-mode structure on serializer output (FR-012, FR-016, TR-002, SC-005, US3 AS-3).
- [ ] T014 [P] [US1] Curate spec-example fixtures (CN-7/TR-001/SC-001): `server/__tests__/fixtures/markdown/commonmark/{emphasis,lists,setext-headings,indented-code,autolinks,escapes,entities,hard-breaks}.json` and `gfm/{task-lists,strikethrough,autolinks,tables}.json` — each entry `{ id: <official example number>, section, markdown, expected: <PM JSON> }` translated to Squire schema at curation time; every skipped example in a covered area gets a row in `server/__tests__/fixtures/markdown/EXCLUSIONS.md` (id · area · one-line reason, e.g. reference links, tilde fences, full named-entity table, indented-code-in-list interactions); create runner `server/__tests__/markdown-fixtures.test.js` (parse → deep-equal, one test per fixture entry).
- [ ] T015 [P] [US1] Real-world corpus (SC-002): add ≥10 documents under `server/__tests__/fixtures/markdown/real-world/` (agent-generated specs, GitHub-flavored READMEs, spec-kit output — e.g. sanitized copies of this repo's own spec/design docs) each with `<name>.expected.json` structural expectation (ordered block-type sequence + key attrs); extend `server/__tests__/markdown-fixtures.test.js` to assert the sequence and assert zero literal-text-paragraph degradations for in-grammar constructs.

**Checkpoint**: US1 fully functional — tolerant default parses real markdown correctly; strict untouched (characterization green). MVP deliverable.

---

## Phase 4: User Story 2 — No input ever loses content (Priority: P1)

**Goal**: FR-013 holds for arbitrary/hostile input: never throw, schema-valid output, words survive in order.

**Independent Test**: `npx jest server/__tests__/markdown-fuzz.test.js --runInBand` — thousands of generated inputs, zero violations, timing guards green.

- [ ] T016 [US2] Degradation-ladder tests in `server/__tests__/markdown-tolerant.test.js` (US2 acceptance scenarios): unknown HTML (`<div>`, `<script>alert(1)</script>`, `<custom-tag>`, comments, block HTML) appears as literal visible text (FR-010); unsupported constructs (footnote `[^1]`, math `$x^2$`, `> [!NOTE]` content) preserve text; unclosed code fence and unbalanced whitelist tags terminate normally with text preserved; every output validates via `schema.nodeFromJSON(...).check()` against `shared/prosemirror-schema.js`.
- [ ] T017 [US2] Create `server/__tests__/markdown-fuzz.test.js` (TR-003/SC-003/SC-006, depends on T002): fast-check properties with fixed seed and numRuns in the low thousands across five generator families (random unicode text, mutated canonical markdown, truncated constructs, adversarial HTML, pathological nesting/delimiter floods); oracle per research R6 — no throw, `schema.nodeFromJSON(result).check()` passes, ordered word-subsequence preservation with entity-decode preprocessing, non-empty text for letter/digit-bearing input; timing guards — representative ~100 KB document < 1 s, every ≤64 KB case wall-clocked under 5 s.

**Checkpoint**: never-lose-content proven; safe for untrusted agent output (Constitution V).

---

## Phase 5: User Story 3 — Version diffs behave exactly as they do today (Priority: P2)

**Goal**: Diff engine regression-proof: strict mode byte-identical (already wired in Phase 2), fragment re-interpretation pinned.

**Independent Test**: `npx jest server/__tests__/diff-service.test.js server/__tests__/markdown-strict-characterization.test.js --runInBand` — green with zero assertion edits to the diff suite.

- [ ] T018 [US3] Add `---`/fragment regression pins to `server/__tests__/markdown-strict-characterization.test.js` (TR-004, US3 AS-2): a hunk-style fragment ending in `paragraph line\n---` parses as paragraph+horizontalRule in strict mode and as a setext H2 in tolerant mode (documented divergence); canonical `paragraph\n\n---\n` parses as paragraph+horizontalRule in BOTH modes; partial-list and unclosed-fence fragments produce today's structures in strict mode; assert `require('../diff-service').CACHE_VERSION === 'v7'` unchanged.
- [ ] T019 [US3] Diff end-to-end verification (SC-004, US3 AS-1/AS-2): run the full existing `server/__tests__/diff-service.test.js` unchanged; audit the characterization corpus against `server/mcp/yjs/serialization.js` emissions for any serializer construct not yet covered (images `![alt](src)`, `[image]` plain-text markers, inline-HTML continuation lines) and extend `server/__tests__/fixtures/markdown/strict-characterization.json` via the T001 generator if gaps exist; re-run generator only against the frozen strict parser and verify output identical to the pre-move baseline (regenerated file must produce zero git diff).

**Checkpoint**: shipped diff behavior provably unchanged.

---

## Phase 6: User Story 4 — One grammar serves server and client (Priority: P3)

**Goal**: Relocated modules proven client-safe (already moved in Phase 2; this phase proves the client-side contract).

**Independent Test**: `cd client && npx vitest run src/__tests__/sharedMarkdown.test.js` — green.

- [ ] T020 [US4] Create `client/src/__tests__/sharedMarkdown.test.js` (Vitest/jsdom, TR-005/SC-007, US4 AS-1/AS-2): (a) `import` `../../../shared/markdown/index.js` and `../../../shared/format-registry.js` through the client toolchain and parse a sample (`'# Hi\n\n- [x] done\n\n**bold _nested_**'`) asserting heading/list/bold/italic structure in tolerant mode and strict mode both callable; (b) module-graph scan — starting from the two entry files, recursively read files and collect `require()` specifiers, asserting every specifier is a relative path resolving inside `shared/` or the bare specifier `prosemirror-model` (no `fs`, `path`, `buffer`, `crypto`, `os`, `util`, or any `node:*`); no changes needed to `client/vite.config.js` (`fs.allow: ['..']` already covers `../shared` — plan.md Structure Decision).

**Checkpoint**: all four user stories independently verified.

---

## Phase 7: Polish & Cross-Cutting Concerns

- [ ] T021 Update `README.md` (Constitution I, CN-10): markdown pipeline section — parser + registry now under `shared/` (`shared/markdown/`, `shared/format-registry.js`), tolerant CommonMark+GFM default mode with strict mode for the diff engine, never-lose-content rule, pointer to the supported-grammar table in `specs/001-general-markdown-parser/data-model.md`. Same commit as the shipping change.
- [ ] T022 Design-doc amendment (Constitution VI, CN-10): amend the **Squire source documents** for `design/document-model-format-pipeline.md` (parser location + "parses only the dialect toMarkdown emits" statements) and the current-state bullets of `design/markdown-import-two-way-sync.md`, then re-export via `node design/sync.mjs` and commit the synced files. NEVER hand-edit files under `design/`. If Squire access is unavailable from the worktree, record the pending amendment in the pipeline decisions ledger so the merge phase performs it — it must not be silently dropped.
- [ ] T023 Final gate: execute `specs/001-general-markdown-parser/quickstart.md` end-to-end — `npm run test:server` (serial) and `npm run test:client` fully green with no assertion changes outside this feature's files; confirm deletions (`server/markdown-to-pm.js`, `server/format-registry.js`) and zero stale requires; record observed SC-006 timings (100 KB parse, worst fuzz case) in the commit/PR notes.

---

## Dependencies & Execution Order

### Phase dependencies

- **Phase 1 (Setup)**: none. T001 → T003 (fixture before test); T002 independent [P]. T001–T003 MUST precede Phase 2 (baseline captured pre-move).
- **Phase 2 (Foundational)**: T004 → T005 → T006 → T007 (strictly sequential; each touches files the next depends on). BLOCKS all user stories.
- **Phase 3 (US1)**: after Phase 2. T008 [P] and T009 [P] independent → T010 → T011 → T012 → T013; T014 [P] and T015 [P] can be authored anytime after Phase 2 but only pass after T012.
- **Phase 4 (US2)**: after T012 (needs tolerant path); T016 → T017 (T017 also needs T002).
- **Phase 5 (US3)**: T018 after T012 (tolerant-mode half of the `---` pin); T019 after T018. Strict-only protection is already live from Phase 2.
- **Phase 6 (US4)**: T020 any time after Phase 2 (strict) but assert-complete after T012 (tolerant sample).
- **Phase 7 (Polish)**: T021 [P-able with T022] → T023 last.

### Critical path

T001 → T003 → T004 → T005 → T006 → T007 → T008/T009 → T010 → T011 → T012 → T013 → T017 → T023

### Parallel opportunities (single implementer: use as ordering freedom)

- Phase 1: T002 alongside T001/T003.
- Phase 3: T008 ∥ T009; T014 ∥ T015 (fixture curation is independent of parser code).
- Phase 7: T021 ∥ T022.

---

## Implementation Strategy

**MVP = Phases 1–3** (Setup + Foundational + US1): tolerant parsing exists, strict protection is already wired (the diff engine was moved to strict in Phase 2, so the P2 story's hard gate is structurally satisfied from the first commit). **Stop-and-validate** after T015: quickstart §§1–2.

Incremental delivery after MVP: Phase 4 (fuzz safety, required before any 002 exposure), Phase 5 (diff regression pins), Phase 6 (client-safety proof), Phase 7 (docs + final gate). Every phase ends with the full backend suite green — there is no point at which trunk would be broken if merged.

**Task count**: 23 (Setup 3, Foundational 4, US1 8, US2 2, US3 2, US4 1, Polish 3).
