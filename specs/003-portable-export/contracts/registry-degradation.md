# Contract: Registry Degradation Declarations (portable flavor)

**Location**: `server/format-registry.js` (or its `shared/` location after feature 001's move).
**Rule** (FR-011, Constitution IV): degradation knowledge lives ONLY here — one declaration per
mark; the serializer consults declarations generically and contains no per-mark degradation logic.

## Declaration shape

On an `INLINE_MARKS` entry:

```js
portable: {
  wrap: [open, close],      // markdown delimiters replacing the HTML tag in portable flavor
  collapsesWith: '<mark>',  // optional: native mark with identical delimiters
}
```

Registry-level for the style mark (not an INLINE_MARKS entry):

```js
const TEXTSTYLE_PORTABLE = { drop: true }; // styling dropped, text preserved, lossy name 'textStyle'
```

## M3 declarations (RD-2, RD-10)

| Mark | Squire flavor | Portable flavor | Lossy name | Collapses with |
|------|---------------|-----------------|------------|----------------|
| underline | `<u>…</u>` | `_…_` (emphasis) | `underline` | `italic` |
| highlight | `<mark>…</mark>` | `**…**` (bold) | `highlight` | `bold` |
| textStyle (any style prop) | `<span style="…">…</span>` | plain text | `textStyle` | — |
| bold, italic, strike, code, link | identical in both flavors | — | never lossy | — |
| subscript, superscript | `<sub>`/`<sup>` in both flavors (RD-10) | — | never lossy | — |

## Serializer semantics (consumed contract)

For each text segment in portable flavor:

1. Marks without `portable` render exactly as in squire flavor.
2. A mark with `portable.wrap` renders with those delimiters instead of its HTML tag; its name is
   added to the export's lossy set.
3. **Collapse rule (FR-012)**: identical delimiter pairs on one segment are emitted once — if the
   segment also carries the `collapsesWith` mark (or any mark, native or degraded, resolving to the
   same wrap), a single pair wraps the segment. Never `__text__`-style doubling. The degraded mark
   still counts as lossy.
4. `textStyle` with `TEXTSTYLE_PORTABLE.drop`: emit the text with no span; add `textStyle` to lossy
   (regardless of which style properties were set).
5. Diagram fences, tables, task lists, hard breaks, and all markdown-native constructs are
   flavor-independent (FR-013).

## Test derivation (FR-023 / SC-006)

The round-trip suite iterates `INLINE_MARKS`:

- entries **with** `portable` ⇒ generated cases: portable export contains no HTML tag for the mark,
  contains the declared wrap (or plain text for `drop`), parses back to a valid document containing
  the degraded form, mark name appears in the lossy set; plus a collapse case when `collapsesWith`
  is declared (mark + its native partner ⇒ single delimiter pair).
- entries **without** `portable` ⇒ generated assertion: squire and portable outputs are identical
  for that mark.

Adding a future mark with a `portable` declaration therefore gains portable coverage with zero
test-file edits.
