# Research — Portable Export (M3)

Phase 0 output. Each entry: Decision / Rationale / Alternatives considered. All product-level
choices trace to spec Ratified Decisions (RD-1…RD-8) or are recorded as new ledger entries
(RD-9, RD-10 appended to `clarifications-needed.md` in this phase).

## R1. Zip generation: `archiver` (server-side, streaming)

**Decision**: Add `archiver` as a runtime dependency; assemble the bundle server-side in
`server/api/docs-export.js`, streaming the zip to the response (`Content-Type: application/zip`).
No client-side zip work at all — the browser just downloads a file.

**Rationale**: The orchestrator directed "prefer server-side zip with a well-justified minimal
dependency". Server-side keeps auth, image-byte access (S3 via `s3-images.getObject`), and
determinism in one place; the client change surface stays zero for US4. `archiver` is the de-facto
standard Node zip writer: streaming (no buffering all assets in memory against the 15 MB/image cap),
mature, MIT, no native addons. It writes a container format; it contains zero markdown/serialization
knowledge, so the constitution's Principle-IV dependency posture (which targets format/serialization
libraries) is not implicated — recorded in plan Complexity Tracking anyway for transparency.
Determinism note (RD-5/SC-004): entries are appended in a deterministic order (markdown first, then
assets sorted by filename); "identical in structure (same filenames, same references)" is the SC-004
bar — byte-identical zips are NOT promised (zip timestamps differ), and the contract says so.

**Alternatives considered**:
- *In-house STORE-only zip writer* (~100–150 LOC: local file headers, CRC32, central directory).
  Rejected: reimplements a solved binary format; correctness bugs corrupt user downloads; saves one
  small dependency at ongoing maintenance cost. (Kept in back pocket if `archiver` install is vetoed.)
- *`jszip`*: buffers in memory, larger API surface aimed at browsers. Rejected.
- *`yazl`*: fine and minimal, but less maintained/battle-tested than archiver. Second choice.
- *Client-side zip*: new client dependency + moving image fetching to the browser (N auth'd requests,
  CORS, memory). Rejected outright.

## R2. YAML emission and parsing: `js-yaml` (direct dependency), emission hand-rolled

**Decision**: **Parse** frontmatter YAML with `js-yaml`'s `load` using the default schema restricted
to plain JS types (`JSON_SCHEMA`), wrapped in try/catch → malformed degrades to content. Promote
`js-yaml` from transitive (already in the dependency tree) to a direct `package.json` dependency.
**Emit** the `squire:` block with a small hand-rolled emitter in the serializer module (fixed key
order, known value types), and re-emit foreign frontmatter **verbatim from the preserved raw text**
— never re-serialized through a YAML library.

**Rationale**: Parsing arbitrary user YAML safely by hand is error-prone; `js-yaml` with
`JSON_SCHEMA` yields plain data only (no anchors-to-objects tricks, no type coercion surprises, and
never code execution — satisfying FR-016's "values are data, never evaluated"). Emission is trivial
(9 known keys, deterministic order for byte-stable exports) — hand-rolling avoids formatting drift
from library defaults and keeps emitted bytes under our control for round-trip stability. RD-4
requires foreign keys re-emitted *byte-for-byte in order*; only raw-text preservation guarantees
that (any parse→dump cycle can reorder/reformat), so the parser keeps the foreign block's raw lines.

**Alternatives considered**:
- *Hand-rolled YAML subset parser*: rejected — frontmatter is untrusted, foreign keys are arbitrary
  YAML, and a subset parser would misclassify valid-but-fancy YAML as "malformed → content", harming
  the preserve contract.
- *`yaml` package*: equivalent capability; `js-yaml` wins because it is already in the tree.
- *Library-emitted YAML for the squire block*: rejected; deterministic bytes matter for the M4
  round-trip invariant and library formatting can change across versions.

## R3. Flavor plumbing: an options argument through the serializer

**Decision**: `toMarkdown(xmlFragment, options)` and `toMarkdownNodes(nodes, options)` gain an
optional `{ flavor = 'squire', lossy = null }` options argument (backward-compatible; all existing
call sites pass nothing). `flavor` selects degradation behavior at the single point where inline
marks are rendered (`renderInline` in `server/mcp/yjs/serialization.js`); when the caller supplies a
`lossy` Set, the serializer adds each mark name it actually degraded (FR-013/RD-6 "actual
degradations only"). Export route validates `flavor` ∈ {`squire`, `portable`} and rejects unknown
values (400), per spec Edge Cases.

**Rationale**: `renderInline` already iterates `INLINE_MARKS` from the registry — degradation slots
in as a per-mark registry property consulted there (see R4), keeping the serializer generic.
Returning the lossy set via a caller-provided Set avoids changing the string return type of
`toMarkdown` (used by many call sites: export route, MCP read_document, diff service, chat tools).

**Alternatives considered**: returning `{ markdown, lossy }` objects (breaks every call site);
a module-level "current flavor" (hidden state, concurrency-hostile); post-processing squire output
with regexes (fragile, violates single-registry knowledge).

## R4. Degradation rules as registry declarations

**Decision**: Each HTML-only mark entry in `INLINE_MARKS` gains a `portable` property describing its
portable-flavor form: `underline: { wrap: ['_', '_'], collapsesWith: 'italic' }`,
`highlight: { wrap: ['**', '**'], collapsesWith: 'bold' }`. `textStyle` (not an INLINE_MARKS entry)
gets an explicit registry-level declaration `TEXTSTYLE_PORTABLE = { drop: true }` — text preserved,
styling dropped, reported as `textStyle` in lossy. Marks with native markdown forms (`bold`,
`italic`, `strike`, `code`, `link`) have no `portable` property → identical in both flavors.
`subscript`/`superscript` have **no** degradation rule in M3 → they keep their HTML tags in portable
flavor (spec FR-010 names only underline, highlight, styled spans; `<sub>`/`<sup>` render fine on
GitHub — GitHub permits these tags in markdown; ledger entry RD-10). The round-trip suite iterates
registry entries and derives portable-flavor cases from the presence of `portable` declarations
(SC-006: future mark + rule ⇒ tests with zero test-file edits).

**Collapse semantics (FR-012)**: in `renderInline`, marks are applied innermost-first over a text
segment. In portable flavor, before wrapping, the effective delimiters are computed per segment: if
a degraded mark's target `wrap` equals a native mark's `wrap` also present on the segment
(underline+italic → `_…_`, highlight+bold → `**…**`), only one delimiter pair is emitted. Simplest
correct implementation: compute the set of wrap-pairs for the segment (native + degraded) and emit
each distinct pair once. The mark still counts as degraded → still listed in `lossy`.

**Alternatives considered**: hard-coding degradation in the serializer switch (violates FR-011 /
Constitution IV); a separate degradation map keyed by mark name outside the registry (drifts from
INLINE_MARKS; rejected — the declaration must live *on* the mark entry, textStyle excepted since it
is registry-adjacent already via STYLE_PROPS).

## R5. Task-list serialization and parsing forms

**Decision**:
- Serializer: `taskList` renders like `bulletList` but each item's marker is `- [ ] ` / `- [x] `
  (from the item's `checked` attr; always lowercase `x` — RD-8). Continuation blocks indent to the
  marker's content column: 6 spaces (spec Edge Cases). Same in both flavors (FR-004).
- Parser: flip 001's degradation seam so `- [ ]`/`- [x]`/`- [X]` items produce
  `taskList` > `taskItem`(checked) > paragraph+blocks. A list is a `taskList` iff its items carry
  checkbox markers; a checkbox-syntax line inside an otherwise plain bullet context creates a task
  item, never literal `[x]` text (spec Edge Cases). Mixed nesting (taskList inside bulletList item
  and vice versa) follows the existing nested-list mechanics.
- Yjs/structured/plain-text: `taskItem` joins `INLINE_CONTENT_BLOCKS`-adjacent handling via
  `block-types.js` (`taskList` in `LIST_CONTAINERS`, `taskItem` alongside `listItem`), so
  `toStructured` exposes `checked` (attr extraction is generic) and plain text keeps item text.

**Rationale**: reuses `renderListItem` with a computed marker string; the 6-char content column
matches the existing "indent by marker width" convention already implemented (`' '.repeat(marker.length)`).
`checked` stored as string attr `'true'`/`'false'` in Yjs (attributes are strings), parsed to boolean
in structured output like `level`/`colspan` are.

**Alternatives considered**: representing checked state as a mark (wrong — item-level, not inline);
`data-checked` DOM attr naming per TipTap (kept for client parseDOM compat, but the Yjs attr name is
`checked` to match the design doc and appendBlocks shape).

## R6. Client editor: TipTap TaskList/TaskItem extensions

**Decision**: Add `@tiptap/extension-list` derived TaskList + TaskItem (TipTap v3 exposes them via
`@tiptap/extension-list` / `TaskList`, `TaskItem` exports) configured with `nested: true`, registered
in `getBaseExtensions()` so every editor instance (main, version preview) shares the schema. The
shared server schema (`shared/prosemirror-schema.js`) adds matching `taskList`/`taskItem` node specs
(content `'taskItem+'` / `'paragraph block*'`, `checked` attr default `false`, `data-checked`
parseDOM/toDOM to match TipTap's DOM contract).

**Rationale**: spec Assumption: "Client task-list support uses the editor framework's standard task
extensions, consistent with how all other editor nodes are provided." Checkbox toggling is a normal
Yjs attribute edit → attribution/undo/version history work unchanged (FR-002). The exact package
entry point (`@tiptap/extension-list` vs legacy `@tiptap/extension-task-list`) is confirmed at
implementation time against the installed TipTap v3 version; both ship the same node names.

**Alternatives considered**: custom Node implementations (needless — schema parity with the standard
extensions is the point); checkbox as decoration-only (loses collaborative state).

## R7. Frontmatter strip/preserve implementation shape

**Decision**: A `parseFrontmatter(markdown)` function in the parser module (exported for 002/004):

```
{ body, squire /* object|null */, foreignRaw /* string|null */ } = parseFrontmatter(markdown)
```

Recognition: input starts (line 1, no BOM-leniency beyond stripping `﻿`) with `---\n`, a closing
`\n---\n` (or `\n---` EOF) fence exists, the enclosed text is ≤ the size cap (RD-10) and `js-yaml`
parses it to a YAML **mapping** — otherwise the whole input is body (degrade-to-content, FR-016;
a lone `---` stays a horizontal rule). On success: `squire` = the parsed `squire` top-level key
(plain data, advisory only); `foreignRaw` = the raw YAML lines minus the `squire:` key's lines
(byte-preserved, order-preserved); `body` = everything after the closing fence. The main
`markdownToPm` entry stays frontmatter-unaware (001 owns its grammar); export surfaces call
`parseFrontmatter` first and parse `body`. Emission (`buildFrontmatter` in serialization.js): one
block — `foreignRaw` verbatim first, then the hand-emitted `squire:` mapping (RD-4).

**How `squire:` lines are excised from raw text**: the `squire:` top-level key's raw span is located
by line scan (a line matching `/^squire:/` through the last subsequent line indented ≥1 space or
blank) — safe because YAML top-level keys are column-0 by construction in a valid mapping; validated
against the parsed object (if the raw scan disagrees with js-yaml's key set, fall back to treating
the *whole* block as foreign and surface `squire` as null — conservative, never corrupts foreign keys).

**Rationale**: RD-4's byte-stable foreign re-emission forces raw-text preservation (R2). Keeping
`markdownToPm` unaware avoids grammar coupling with 001. Callers (002 import, 004 push) receive
metadata without side channels.

**Alternatives considered**: storing foreign frontmatter *inside the document* as a hidden node
(rejected: pollutes the schema and the CRDT for file-level metadata; RD-4 explicitly leaves
representation open — callers of parseFrontmatter/buildFrontmatter own carrying `foreignRaw`);
parse-and-redump foreign keys (violates byte-stability).

## R8. Frontmatter size cap: 64 KB (new ledger entry RD-9)

**Decision**: Cap = **64 KB** for the frontmatter block (opening fence to closing fence inclusive).
Oversized → the entire input is treated as ordinary content (never an error). Recorded as a
RATIFIED-BY-DEFAULT ledger entry.

**Rationale**: The ledger flagged the value as a plan-phase choice, suggesting alignment with
request-body limits; realistic frontmatter (squire block + spec-kit keys + a large images map) is
< 8 KB; 64 KB gives 8× headroom while bounding `js-yaml` work on hostile input to trivial cost, and
is comfortably under any request-body limit an import surface will use.

**Alternatives considered**: 8 KB (too tight for a 500-image images map at ~60 B/entry ≈ 30 KB);
1 MB (needlessly generous for a metadata block; weakens the untrusted-input bound).

## R9. Doc slug derivation (bundle asset directory)

**Decision**: `slugifyDocTitle(title)`: lowercase, Unicode-normalize (NFKD) and strip diacritics,
replace non `[a-z0-9]` runs with `-`, trim `-`, cap at 60 chars, fallback `doc` when empty.
Deterministic pure function of the title; lives next to `sanitizeFilename` in `docs-export.js` and
is exported for tests. The markdown file inside the zip is named `<sanitizeFilename(title)>.md`
(reusing the existing download-name convention); assets live under `assets/<docSlug>/<imageId>.<ext>`
with `ext` mapped from the image's stored `mime_type` (`image/png`→`png`, `image/jpeg`→`jpg`,
`image/gif`→`gif`, `image/webp`→`webp` — the full `ALLOWED_IMAGE_MIME_TYPES` set).

**Rationale**: matches spec Edge Case ("same spirit as the existing export filename sanitization");
RD-5 fixes asset filenames to `<imageId>.<ext>`; slug only needs filesystem/URL safety and
determinism, not uniqueness (single-doc zip).

**Alternatives considered**: transliteration libraries (dependency for cosmetics); docGuid as slug
(ugly paths, human-hostile; title-based is the design doc's `./assets/payments/…` example shape).

## R10. Bundle image resolution flow

**Decision**: In the bundle branch of the export route: (1) serialize with
`{ flavor, lossy }`; (2) scan the emitted markdown for image references matching the app-URL shape
`/api/docs/<docId>/images/<imageId>` **for this docId only** (guardrail: foreign-doc URLs are left
untouched and excluded — FR-017 "only images belonging to the exported document"); (3) for each
distinct imageId, `documentImages.getImage(imageId, docId)` → row with `s3_key`, `mime_type`;
`s3Images.isEnabled()` false, missing row, or `getObject(s3_key)` failure ⇒ **skip** that image
(keep original URL, omit from assets + images map — FR-021); (4) rewrite references string-wise
`![alt](appUrl)` → `![alt](./assets/<docSlug>/<imageId>.<ext>)`; (5) build frontmatter with the
`images` map (`./assets/<docSlug>/<file>: <imageId>`, sorted by path for determinism); (6) stream
zip: `<file>.md` first, then assets sorted by filename. Duplicate references: one asset, one map
entry, both references rewritten (spec Edge Cases).

**Rationale**: The serializer emits `![alt](src)` from image node `src` attrs verbatim, so post-scan
rewriting requires no serializer change and keeps image knowledge out of the format pipeline.
Doc-scoped `getImage(imageId, docId)` enforces ownership at the DB.

**Alternatives considered**: rewriting inside the serializer via an option (leaks export-surface
concerns into the format layer); walking the Yjs tree for image nodes instead of scanning output
(equivalent set, but scanning the output guarantees the rewrite matches exactly what was emitted).

## R11. Export route option validation & defaults

**Decision**: `format` ∈ {`markdown`, `md`, `bundle`} (else 400, listing accepted values);
`flavor` ∈ {`squire`, `portable`} (else 400); `frontmatter` ∈ {`true`, `1`} → on, {`false`, `0`,
absent} → off, other values → 400. Defaults: `format=markdown` ⇒ `flavor=squire`, frontmatter off
(FR-022 byte-compat); `format=bundle` ⇒ `flavor=portable`, `frontmatter=true`, both overridable
(RD-3). Bundle response: `Content-Type: application/zip`, `Content-Disposition` filename
`<sanitized>.zip` with the same RFC 5987 non-ASCII handling already present.

**Rationale**: FR-009, FR-020, spec Edge Cases (unknown values rejected). Strictness on `frontmatter`
values keeps future extension room.

## R12. `lastModifiedBy` / `clock` sources for frontmatter

**Decision**: Reuse the same server-side sources the document listing exposes (spec Assumption:
"exposed today via document listing"): the document's Yjs `clock` (version counter used by
`list_documents`/versions) and last-modifier identity resolved to the email/display used there.
The export route already loads the persisted doc via `persistence.getYDoc(docId)`; clock and
last-modified metadata come from the same persistence/documents layer (`documents` module /
`yjs_updates` clock max), NOT from any new tracking. Exact accessor confirmed at implementation
time; `list_documents`' `clock`/`lastModifiedAt` plumbing (recent commit 4d6b4c7) is the reference.

**Rationale**: FR-014 fields; Assumption says the data exists — implementation reuses it. `exportedAt`
= `new Date().toISOString()` at serialization time (documented: NOT byte-stable across exports;
the M4 round-trip invariant diffs *content*, not the `squire:` block, which is stripped on import).
