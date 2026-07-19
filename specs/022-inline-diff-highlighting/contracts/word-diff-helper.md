# Contract — Shared word-diff helper

**File**: `shared/diff/word-diff.js` (NEW)

## Signature

```js
computeWordSegments(before: string, after: string) => {
  before: Array<{ text: string, changed: boolean }>,
  after:  Array<{ text: string, changed: boolean }>,
}
```

## Behavior

- Implemented with `diffWordsWithSpace(before, after)` from the `diff` package.
- For each jsdiff part:
  - `.removed` → append `{ text, changed: true }` to `before`.
  - `.added` → append `{ text, changed: true }` to `after`.
  - neither (common) → append `{ text, changed: false }` to BOTH `before` and `after`.
- Coalesce adjacent segments on each side that share the same `changed` flag.
- Whitespace-preserving: whitespace-only changed runs are emitted as `changed:true`
  segments, unsuppressed (RBD-1).

## Guarantees (test targets)

- **Faithfulness**: `before.map(s => s.text).join('') === before` (same for `after`).
- **Parity**: identical inputs yield identical outputs regardless of caller (SC-003).
- **One-word change**: `computeWordSegments("the quick fox", "the slow fox")` →
  `before` marks only `quick` changed, `after` marks only `slow` changed; the surrounding
  `the ` / ` fox` are unchanged on both sides.
- **Identical inputs**: `computeWordSegments(x, x)` → no `changed:true` segments on either
  side (a single unchanged segment per side, coalesced).
- **Whitespace-only**: `computeWordSegments("a  b", "a b")` → the differing whitespace run
  is a `changed:true` segment.

## Consumers

- `server/mcp/diff-postprocess.js` (chat) — uses the literal `text` segments.
- `server/diff/apply-word-marks.js` (history) — uses segments as character ranges over
  the parser's concatenated plain text.

No other module may re-implement tokenization (FR-001).
