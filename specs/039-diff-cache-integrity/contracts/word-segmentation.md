# Contract — Shared word segmentation & two-surface parity (FR-006, FR-008 … FR-011)

Module: `shared/diff/word-diff.js` (consumed by both server diff surfaces).

---

## `computeWordSegments(before, after, report?)`

```
→ { before: Segment[], after: Segment[] } | null
Segment = { text: string, changed: boolean }
```

**Unchanged**: the algorithm, the `null` return on degradation, the coalescing, the guardrail
values (`MAX_SIDE_CHARS = 20000`, `DIFF_TIMEOUT_MS = 250`).

**New**: an optional third argument `report`. When degradation occurs, the function sets
`report.reason = 'size'` (either side exceeded `MAX_SIDE_CHARS`) or `report.reason = 'timeout'`
(jsdiff returned `undefined` for the time budget) before returning `null`.

### Guarantees

- **WS-1 — Faithfulness (existing, now load-bearing for the re-split).**
  `result.before.map(s => s.text).join('') === before` and likewise for `after`.
- **WS-2 — Coalesced.** No two consecutive segments in a side share the same `changed` flag.
- **WS-3 — `null` preserved.** Degradation still returns `null`; `report` is purely out of band
  (CD-6). A caller that passes no `report` observes today's behavior exactly.
- **WS-4 — Budget frozen.** `DIFF_TIMEOUT_MS` MUST NOT change (FR-006, CD-3, spec US3 scenario 4).
- **WS-5 — Reason accuracy.** `'size'` is deterministic (a pure function of input lengths);
  `'timeout'` is load-dependent. The distinction is what makes FR-005(c) implementable.

---

## `computeLineWordSegments(beforeLines, afterLines, report?)` — NEW

```
beforeLines: string[]      // rendered text of each removed row (prefix- and span-stripped)
afterLines:  string[]      // rendered text of each added row
→ { before: Segment[][], after: Segment[][] } | null
```

### Algorithm

1. `before = beforeLines.join('\n')`, `after = afterLines.join('\n')`.
2. `segs = computeWordSegments(before, after, report)`; return `null` if `null`.
3. Re-split each side's segment stream at `'\n'`: walk the coalesced segments, cutting at every
   newline; the newline character itself is **dropped** (it is a row separator, not row content);
   a new per-row array begins after each cut.
4. Return one array per input row, in order.

### Guarantees

- **LS-1 — Row count preserved.** `result.before.length === beforeLines.length`; likewise `after`.
  Holds for empty rows and for a trailing empty row.
- **LS-2 — Per-row rejoin is byte-identical.**
  `result.before[k].map(s => s.text).join('') === beforeLines[k]` for every `k`. Follows from
  WS-1; MUST be asserted **as bytes**, not as visual plausibility (hazard #3).
- **LS-3 — Same degradation semantics.** `null` ⇒ the WHOLE region falls back; guardrails apply to
  the joined region, identically on both surfaces (FR-010).
- **LS-4 — No emphasis invented.** A row whose text is unchanged in the region-level segmentation
  carries only `changed: false` segments.
- **LS-5 — Surplus rows covered.** Rows beyond the shorter side's count receive segments like any
  other row (FR-009). There is no `Math.min` anywhere in the new path.

---

## Chat surface — `server/mcp/diff-postprocess.js`

**Replaces** the positional pairing block (`pairCount = Math.min(delOutIdx.length, addOutIdx.length)`,
lines 183-191).

```js
const beforeLines = delOutIdx.map((_, k) => stripSpanTags(lines[delStart + k].slice(1)));
const afterLines  = addOutIdx.map((_, k) => stripSpanTags(lines[addStart + k].slice(1)));
const perRow = computeLineWordSegments(beforeLines, afterLines, report);
if (perRow) {
  delOutIdx.forEach((outIdx, k) => { inlineSegments[outIdx] = perRow.before[k]; });
  addOutIdx.forEach((outIdx, k) => { inlineSegments[outIdx] = perRow.after[k]; });
}
// perRow === null → no inlineSegments for this region: row tint only (FR-010)
```

### Guarantees

- **CS-1 — Client contract unchanged.** `inlineSegments` remains an object keyed by the stringified
  **output** row index, values `Segment[]`, consumed at
  `client/src/components/AiChatMessages.jsx:318`. No new field, no shape change.
- **CS-2 — Segment text matches rendered text.** Segmentation runs on the same
  `stripSpanTags(line.slice(1))` strings the rows render, so LS-2 is an invariant about what the
  browser actually displays.
- **CS-3 — Truncation filter still applies.** `computeChatDiff`'s
  `Object.entries(...).filter(([k]) => Number(k) < MAX_DIFF_LINES)` (`server/mcp/diff-utils.js:129`)
  is unchanged and still drops keys referencing truncated-away lines.
- **CS-4 — Format-only branch untouched.** The `delLines.length === addLines.length` +
  identical-plain-text branch runs **before** word segmentation and is not modified.
- **CS-5 — Hard-break strip untouched.** `stripHardBreakMarkers` (`server/mcp/diff-utils.js`,
  ratified 028) stays verbatim, chat-only (FR-011).

---

## Version-history surface — `server/diff/apply-word-marks.js`

**No algorithmic change** — it is already per-region and is the reference behavior. It gains only
the `report` pass-through: `applyWordMarks(removedMd, addedMd, report)` →
`wordDiff.computeWordSegments(plainRemoved, plainAdded, report)`.

### Guarantees

- **VH-1 — Fail-open preserved.** The `catch` still degrades the whole region to line-level marks
  (RBD-3 / 022 FR-012). The `loggedOnce` throttle is preserved.
- **VH-2 — Traversal agreement.** `plainTextOf` (line 52) and `stampSide`'s `isTextBlock` (line 44)
  are two separate implementations of the same traversal and MUST stay in agreement. Any change
  near them requires a test covering a block with **no direct text child** (hazard #4).

---

## Parity criterion (SC-003) — the acceptance test

For a before/after pair within guardrails, for each replace region, per side:

> the ordered list of (row-relative start, end) ranges marked `changed` is **identical** across the
> two surfaces, and the rows the chat surface leaves without segments are exactly the rows version
> history renders without word marks (none when within guardrails; the whole region when the
> guardrails trip).

The test drives both pipelines from the same input and compares derived range lists — it does not
compare the surfaces' native output shapes (PM JSON vs. keyed segment arrays), which legitimately
differ.

---

## Test obligations

| ID | Assertion |
|---|---|
| WD-1 | `computeWordSegments` with an oversized side stamps `report.reason === 'size'` and returns `null`. |
| WD-2 | A forced jsdiff timeout stamps `report.reason === 'timeout'` and returns `null`. |
| WD-3 | No `report` argument ⇒ identical behavior to today (existing suite passes unmodified). |
| WD-4 | `DIFF_TIMEOUT_MS === 250` and `MAX_SIDE_CHARS === 20000` (pinned constants). |
| LS-T1 | Row counts preserved for both sides, incl. unequal row counts and empty rows. |
| LS-T2 | **Byte-identical per-row rejoin** for a corpus incl. multi-byte UTF-8, leading/trailing whitespace, and an empty row. |
| LS-T3 | Line inserted at the top of an otherwise-unchanged multi-line block ⇒ unchanged rows carry **no** `changed` segments. |
| LS-T4 | More added rows than removed (and vice versa) ⇒ **every** row receives segments. |
| LS-T5 | Oversized region ⇒ `null` ⇒ chat emits no `inlineSegments` for that region. |
| PAR-1 | **SC-003 parity**: same input through both pipelines ⇒ identical changed-range lists, row-for-row, per side. |
| PAR-2 | Guardrail-tripping region ⇒ both surfaces fall back for the whole region. |
| VH-T1 | A block with no direct text child (empty paragraph / list wrapper) is handled identically by `plainTextOf` and `stampSide`. |
| CS-T1 | `inlineSegments` keys remain stringified output-row indices; existing client rendering test still passes. |
| CS-T2 | 028 hard-break regression suite passes unmodified. |
