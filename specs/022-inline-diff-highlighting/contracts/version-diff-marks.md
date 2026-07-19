# Contract — Version-diff strong marks

**Files**: `shared/prosemirror-schema.js`, `client/src/extensions/editorExtensions.js`,
`server/diff-service.js`, `server/diff/apply-word-marks.js` (NEW),
`client/src/components/VersionPreview.css`, `client/src/index.css`.

## Marks

Register two marks alongside the existing `diffInsert`/`diffDelete`:

| Mark | DOM | Parse | Provenance |
|------|-----|-------|-----------|
| `diffInsertWord` | `<ins class="diff-word">` | `ins.diff-word` | diff service only |
| `diffDeleteWord` | `<del class="diff-word">` | `del.diff-word` | diff service only |

- Registered in the shared schema (round-trip/validation) AND the editor extension set +
  `getBaseExtensions` list (so `VersionPreview` renders them).
- No input rules, keyboard shortcuts, or editing path may create them (FR-009). Adding
  them to the schema MUST NOT change any live-document behavior (SC-009).
- Must be exercised by the registry-driven round-trip suite
  (`server/__tests__/format-roundtrip.test.js`) per constitution II.

## Refinement (`server/diff/apply-word-marks.js`)

Input: `removedMd`, `addedMd` (the two sides of a replace region). Steps:

1. Parse both sides UNMARKED: `markdownToPm(removedMd, null)`, `markdownToPm(addedMd,
   null)` (strict parser; frozen, unchanged — CN-2 / FR-008).
2. Concatenate each side's text-node text, blocks joined by `'\n'` → `plainRemoved`,
   `plainAdded`. `computeWordSegments(plainRemoved, plainAdded)`.
3. Walk each side's PM text nodes tracking a char offset; split nodes at segment
   boundaries. Stamp `diffDeleteWord`/`diffInsertWord` on `changed` ranges,
   `diffDelete`/`diffInsert` on the rest. Preserve each node's existing formatting marks
   on every split piece (FR-010). The inter-block `'\n'` belongs to no text node — the
   walker skips that offset (spec Assumptions).
4. Return refined removed blocks then refined added blocks (same order as today).

**Fail-open (RBD-3 / FR-012)**: any error in steps 1–4 for a region → fall back to
today's line-level marking for that region (`markdownToPm(removedMd, 'diffDelete')` +
`markdownToPm(addedMd, 'diffInsert')`), at most a server log line. Never throws out of
`computeMarkdownDiff`; never caches an error result.

## `computeMarkdownDiff` integration (`server/diff-service.js` ~L194-212)

Per `diffLines` part:
- **Replace region** (a `removed` part immediately followed by an `added` part) →
  `apply-word-marks` refinement.
- **Lone `added`** → `markdownToPm(md, 'diffInsert')` (unchanged).
- **Lone `removed`** → `markdownToPm(md, 'diffDelete')` (unchanged).
- **Unchanged** → `markdownToPm(md, null)` (unchanged).

Bump `CACHE_VERSION` `'v7'` → `'v8'` (L22) (FR-011). Update the assertion in
`server/__tests__/markdown-strict-characterization.test.js` (~L69) to `'v8'`.

## CSS

- `client/src/index.css`: add `--canvas-diff-add-bg-strong` / `--canvas-diff-del-bg-strong`
  in the light `:root` block AND every dark block (the same places
  `--canvas-diff-add-bg`/`--canvas-diff-del-bg` are themed today).
- `client/src/components/VersionPreview.css` (after the base `ins`/`del` rules):
  `.version-preview ins.diff-word { background-color: var(--canvas-diff-add-bg-strong); }`
  and `.version-preview del.diff-word { background-color: var(--canvas-diff-del-bg-strong); }`
  (keep the base `text-decoration` behavior).
