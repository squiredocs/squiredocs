# Phase 0 Research: Clean Hard-Break Rendering in Transcript Diffs

All decisions below are grounded in the current serializer and diff pipeline
(anchors verified 2026-07-21) and the design amendment (commit 19887fa). The two
open interpretation calls are ledgered as RBD-1..RBD-3 (RATIFIED-BY-DEFAULT).

## R1 — Stage: normalize both full serializations before the line diff (RBD-2)

**Decision**: In `computeChatDiff(mdBefore, mdAfter)`, run
`stripHardBreakMarkers` on **both** full markdown inputs, then feed the cleaned
strings to `structuredPatch`. Everything downstream — the line diff, `~~~` hunk
splitting, `postProcessDiffLines` (span strip, format-only detection, 022 word
segments), size caps, truncation — consumes the cleaned text unchanged.

**Why (verified)**:
- **Fence state is a whole-document property.** `structuredPatch` is called with
  `context: 2` (`diff-utils.js:22`); a hunk can begin mid-code-block and the hunk
  lines omit everything between hunks, so fence state cannot be reconstructed from
  diff output. Cleaning the full documents first is the only stage where FR-002(a)'s
  "outside every fenced block" can be evaluated exactly (Edge Cases, "Fence state
  across the whole document").
- **Free downstream consistency.** Context lines, format-only comparison, and 022
  word segments are all derived from the same line text after cleanup, so no
  phantom marker can survive into any of them and no second implementation is needed
  (FR-004, SC-004). Word segmentation in `diff-postprocess.js:185-187` runs on
  `stripSpanTags(lines[...].slice(1))` — already-cleaned line text — so segments
  rejoin byte-identically to the rendered row by construction.
- **Line counts are invariant.** Cleanup removes characters within a line, never a
  line (it never touches a `\n`), so gutter numbering and `hunkStarts` are unaffected
  (FR-006, Edge Cases "Gutter line numbers"). A pair differing only by a marker
  collapses to no diff at all, exactly as desired.
- **Post-hoc line walking rejected**: it would require fence heuristics over windowed
  hunks — precisely what the amendment forbids ("keyed on block context ... never by
  client substring stripping"). Ruled out.

## R2 — Placement: exported pure helper in diff-utils.js (single generation point)

**Decision**: Add `function stripHardBreakMarkers(markdown): string`, exported from
`server/mcp/diff-utils.js`, called by `computeChatDiff` on each input.

**Why (verified)**:
- Both diff producers already funnel through `computeChatDiff`: modify at
  `server/mcp/tools/modify.js:512` (`diff = computeChatDiff(mdBefore, mdAfter)`) and
  the 020 undo/redo revert diff at `server/undo/undo-service.js:77`
  (`diffUtils.computeChatDiff(inverse.preMarkdown, inverse.postMarkdown)`). Putting
  cleanup inside `computeChatDiff` satisfies FR-005 ("no producer can bypass it")
  with **zero** changes to either caller. SC-003 (undo/redo identical to modify) is
  then true by construction and only needs a test to confirm.
- **Anti-drift (Principle IV).** The helper does not re-derive format knowledge; it
  mirrors one narrow, documented emission rule of the serializer (hardBreak →
  `\` + `\n` inside paragraph-like inline content, `serialization.js:186-190`). The
  dependency is captured explicitly in the spec Assumptions and re-asserted by the
  tests, so if the serializer's hardBreak emission ever changes, the tests break
  loudly.
- Exporting it (alongside the existing `module.exports = { computeChatDiff }`) makes
  the predicate unit-testable in isolation from `structuredPatch` (R3), which is how
  the grammar edge cases (RBD-1, double-backslash, fences, container prefixes) are
  pinned precisely.

## R3 — The predicate: grammar-exact marker identification (FR-002/FR-003)

`stripHardBreakMarkers` scans the markdown line by line, tracking fenced-block
state, and strips **exactly one** trailing backslash from a line iff it is a
hard-break marker.

**A trailing `\` on line L is a hard-break marker iff BOTH hold:**
1. **L is outside every fenced block** (FR-002a). Fence state toggles on any line
   whose content — after removing a leading blockquote prefix run (`>` + optional
   space, repeated) and leading indentation — begins with a triple backtick fence.
   This covers code blocks (`serialization.js:216-218`) and diagram fences
   (mermaid/svg via `FENCE_LABEL_BY_NODE`, `serialization.js:219-221`), which the
   serializer emits with identical ```` ``` ```` syntax → RBD-3 (all fences exempt)
   falls out for free.
2. **L has a continuation line in the same paragraph-like block.** Operationally:
   line L+1 exists and, after removing its container continuation prefix (a leading
   `>`-run for blockquotes; leading whitespace for list/task-item content-column
   indent), is **non-empty**.

If both hold, remove one trailing `\` from L; otherwise leave L byte-for-byte
unchanged. Headings and table cells never reach this code as markers — the
serializer already substitutes `<br>` there (`serialization.js:214`, `:359`) — so
those lines simply fail the "ends in `\`" test and pass through (FR-003).

### Why "next line non-empty (prefix-stripped)" is exact, not heuristic

This rests on three verified serializer facts, so it is grammar-exact per the spec
Assumptions (not a substring guess):

- **Inline text carries no literal newlines** (schema invariant) and **the serializer
  never escapes literal backslashes in inline text** (`renderInline`, verified). So
  the *only* source of an internal `\n` inside a paragraph-like block is a hardBreak,
  and it *always* emits its `\` immediately before that `\n` (`getChildText`,
  `serialization.js:186-190`). Every within-block line break therefore carries the
  marker as its last character — the continuation line follows on the very next
  physical line with no blank line between.
- **Blocks are always separated by a blank line.** Top-level nodes join with `\n\n`
  (`serialization.js:383`); a paragraph emits `text\n` then the join adds the blank
  line; blockquote child-blocks join with `\n\n` which becomes a bare `>` separator
  line (`serialization.js:243-247`); plain/task list items whose paragraph text ends
  in `\` get the `+ '\n'` after text that already ends in `\n`, i.e. a trailing blank
  line. **Consequence**: a *block-final* trailing backslash (RBD-1 case) is always
  followed by an empty line (prefix-stripped), by EOF, or by a differently-prefixed
  new block start — never by a same-block non-empty continuation. So it is preserved,
  which is the grammar's own answer and matches how the markdown re-parses (RBD-1).

### Edge cases, resolved by the predicate (each becomes a test — see tasks.md)

| Case | Serialized form | Predicate result |
|---|---|---|
| Poem stanza (top-level para hard breaks) | `line1\` / `line2` | strip on `line1` (next non-empty); last stanza line before block end preserved-or-stripped per its own next line |
| List-item hard break | `- line1\` / `␠␠line2` (content-col indent, `serialization.js:339`) | next line indent-stripped is non-empty → strip |
| Blockquote hard break | `> line1\` / `> line2` (`serialization.js:243-247`) | next line `>`-stripped is non-empty → strip |
| Block-final trailing `\` (RBD-1: literal end-of-para OR trailing hardBreak) | `text\` then blank line / EOF | next line prefix-stripped empty → **preserve** |
| Double backslash + continuation (edge f) | `text\\` / `cont` (literal `\` + marker `\`) | strip **exactly one** → `text\` kept |
| Code block trailing-`\` content (SC-002c) | inside ```` ``` ```` fence | inside fence → **preserve** |
| Diagram fence trailing-`\` content (SC-002d, RBD-3) | inside ```` ```mermaid ```` / ```` ```svg ```` fence | inside fence → **preserve** |
| Hunk starting mid-code-block | fence opened on an earlier (out-of-hunk) line | full-doc scan (R1) keeps fence state → **preserve** |
| Heading / table-cell hard break | `<br>` already substituted | no trailing `\` → pass through |
| Marker-only line pair | identical after cleanup | collapses to no diff (FR-004) |

### Rejected alternatives

- **Client-side substring stripping**: forbidden by the amendment (FR-001); cannot
  know fence context; would corrupt legacy payloads. Rejected.
- **Regex `\\$` over each hunk line post-diff**: cannot see fence state across
  windowed hunks; strips content backslashes in code/diagram blocks (fails SC-002c/d).
  Rejected in favor of R1's full-document stage.
- **Counting trailing backslashes / parity tricks**: unnecessary — the serializer
  always appends the marker as the single last backslash, so "strip exactly one when
  qualifying" is both correct and minimal (handles edge f without parity logic).

## R4 — Non-goals confirmed unchanged (FR-007/FR-008)

- **Serializer** (`serialization.js`): untouched. Its hardBreak emission is
  load-bearing for export/round-trip/source-maps; we mirror it, never modify it.
- **Version-history pipeline** (`server/diff/*`): untouched; it rebuilds an annotated
  document where hardBreak renders as a real break, sharing no changed code →
  byte-identical (SC-006). The only module shared with the chat pipeline is
  `shared/diff/word-diff`, which also does not change.
- **Client / legacy payloads**: no client stripping, no migration. Persisted
  pre-feature payloads keep their markers and render as today (FR-007, SC-005).

## R5 — Testing approach (SC-007)

Extend `server/mcp/__tests__/diff-postprocess.test.js` (already imports
`postProcessDiffLines` and `computeChatDiff`; add the new `stripHardBreakMarkers`
export to its require line). Two layers:

1. **Unit** — `stripHardBreakMarkers(md)` directly: every row of the R3 table as an
   input→output assertion (fastest, pins the grammar; no `structuredPatch` involved).
2. **Integration** — `computeChatDiff(before, after)`: assert no rendered `.lines`
   row ends in a marker for hard-broken edits; content backslashes survive; gutter
   numbers/`hunkStarts` and 022 `inlineSegments` behave; context lines are cleaned;
   a marker-only difference produces no hunk. Confirms both card paths via the shared
   function (SC-003 — same function, so a modify-shaped and an undo-shaped call are
   asserted identical).

Backend suite is serial-only against a shared DB; the implementer runs it in a
worktree pointed at `collab_test_db_028` (worktree jest-config workaround +
`--forceExit`). These are pure-function tests (no DB rows), but they run inside the
same serial backend suite.
