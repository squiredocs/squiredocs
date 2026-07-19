# Contract — Chat diff payload (`inlineSegments`)

**Producers**: `server/mcp/diff-postprocess.js` → `server/mcp/diff-utils.js`
(`computeChatDiff`). **Consumer**: `client/src/components/AiChatMessages.jsx` (`DiffView`).

## Payload shape (additive)

```jsonc
{
  "lines": ["...", "-old line", "+new line", "..."],   // unchanged meaning
  "hunkStarts": [ ... ],                                 // unchanged meaning
  "formatAnnotations": { "<outIdx>": "bold added" },    // unchanged meaning
  "truncatedByServer": true,                            // unchanged meaning (optional)

  // NEW — additive, optional (absent when no pair produced segments):
  "inlineSegments": {
    "<removedOutputIdx>": [ { "text": "-old ", "changed": false }, { "text": "word", "changed": true } ],
    "<addedOutputIdx>":   [ { "text": "+new ", "changed": false }, { "text": "term", "changed": true } ]
  }
}
```

## Server rules

- Only the **non-format-only** paired `-`/`+` branch of `postProcessDiffLines` produces
  segments (FR-002/FR-003).
- Pair del/add lines by index up to `min(delCount, addCount)`; segment each pair's
  **prefix-stripped** text (`line.slice(1)`) with `computeWordSegments`.
- Key by the line's **output index** in the `result`/`lines` array (same discipline as
  `formatAnnotations`). Store `segments.before` under the removed line's index,
  `segments.after` under the added line's index.
- **Note**: the segment `text` values are prefix-stripped content; the client re-prepends
  the row's prefix char when rendering (see client rules).
- Unpaired surplus del/add lines, format-only annotated pairs, and context lines get NO
  entry (FR-003).
- Return `undefined` (not `{}`) when empty; `computeChatDiff` threads it through and, on
  the `truncatedByServer` branch, filters keys to `Number(k) < MAX_DIFF_LINES` (200) —
  exactly mirroring `formatAnnotations` filtering (FR-005).

## Client rules (`DiffView`)

- `const inlineSegments = diff.inlineSegments || {}`.
- For row `i`: if `inlineSegments[String(i)]` exists, render the prefix char
  (`entry.line[0]`) followed by the segments — `changed:false` as plain text,
  `changed:true` wrapped in `<span className="ai-diff-word">`. Otherwise render
  `{entry.line}` unchanged (backward-compatible fallback; also covers pre-feature cached
  payloads).
- Row tint, gutter, hunk separators, `formatAnnotation`, expand/collapse, and truncation
  notice are all UNCHANGED (FR-006). A row without segments renders byte-identically to
  today.

## External MCP clients

`inlineSegments` is an ignorable additive field (same posture as 020's `diff` field);
agents reading modify/undo/redo results are unaffected (spec Assumptions).
