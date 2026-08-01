# Data Model — 039-diff-cache-integrity

**No database schema changes.** No table, column, index, or migration is added, altered, or
dropped by this feature (feature 038 holds the only in-flight migration slot). Everything below
is an in-memory / cache-layer entity.

---

## 1. Update-log row set (read result)

**Producer**: `PostgresPersistence._fetchRowsWithGapRetry` → `getUpdateRowsUpTo`
**Backing store**: `yjs_updates` (unchanged; read-only here)

| Field | Type | Notes |
|---|---|---|
| `rows` | `Array<{ clock: number, update_data: Buffer }>` | ascending by clock; unchanged |
| `gapped` | `boolean` | **Semantics widened.** Was "internal gap after retry budget"; now "**incomplete** after retry budget" = internal gap **OR** short tail. Callers already treat it as "do not freeze this" (023 D-2), so no caller semantics change. |
| `retries` | `number` | unchanged |

**New input**: `expectedTailClock` (optional, `number`).

**Completeness rule** (evaluated on the ascending view of the fetched rows):

```
internalGap = _findFirstGap(rowsAsc) !== null              // unchanged
tailShort   = expectedTailClock != null && (
                rowsAsc.length === 0
                  ? expectedTailClock >= 0
                  : Number(rowsAsc[rowsAsc.length - 1].clock) < expectedTailClock
              )
incomplete  = internalGap || tailShort
```

**State transitions**: `incomplete` → retry (same shared budget: `COLLAB_READ_GAP_RETRIES`
default 2, delays `COLLAB_READ_GAP_RETRY_DELAYS_MS` default `100,300`) → `complete` (break) or
budget exhausted (`gapped: true`, structured warn line naming the reason).

**Validation / invariants**:
- Omitting `expectedTailClock` MUST leave the code path byte-identical to today (FR-002).
- `expectedTailClock` MUST NOT be derived from the `clock` upper bound (CD-5; backfill sentinel).
- No new environment variable, no per-path budget (023 FR-008).

---

## 2. Word-emphasis segment

**Producer**: `computeWordSegments` (`shared/diff/word-diff.js`) — **shape unchanged**.

| Field | Type | Notes |
|---|---|---|
| `text` | `string` | verbatim slice of the input |
| `changed` | `boolean` | strong emphasis when true |

**Invariants (unchanged, load-bearing)**:
- Faithfulness: `side.map(s => s.text).join('') === input` for both `before` and `after`.
- Coalesced: no two consecutive segments share the same `changed` flag.

---

## 3. Per-row segment arrays (NEW derived entity)

**Producer**: `computeLineWordSegments(beforeLines, afterLines, report)`
(`shared/diff/word-diff.js`, new).

| Field | Type | Notes |
|---|---|---|
| `before` | `Segment[][]` | one array per element of `beforeLines`, in order |
| `after` | `Segment[][]` | one array per element of `afterLines`, in order |

Returns `null` when the underlying `computeWordSegments` degrades (size or timeout) — the whole
region then falls back.

**Derivation**: join each side's rows with `'\n'`, segment once, cut the resulting segment stream
at every `'\n'` (dropping the newline character itself, which is a row separator, not row content).

**Invariants**:
- Row count preserved: `result.before.length === beforeLines.length` (same for `after`).
- **Per-row rejoin is byte-identical**: `result.before[k].map(s => s.text).join('') === beforeLines[k]`
  for every `k`. This is a *derived consequence* of the segmenter's faithfulness invariant and MUST
  be tested as bytes (hazard #3).
- Coalescing is preserved *within* a row; a row boundary may legitimately produce two adjacent rows
  whose first/last segments share a `changed` flag (they are in different arrays — not a violation).
- A row may legitimately yield `[]` only when its text is the empty string.

---

## 4. Degradation report (NEW transient entity)

A plain mutable object created per comparison and threaded down the call chain.

| Field | Type | Notes |
|---|---|---|
| `reason` | `'size' \| 'timeout' \| undefined` | stamped by `computeWordSegments` on each degradation |

Aggregated by the caller into:

| Signal | Type | Meaning |
|---|---|---|
| `timeoutDegraded` | `boolean` | true if **any** region in the comparison degraded with reason `'timeout'` (whole-result granularity — CD-4) |

**Rules**:
- `'size'` degradation is deterministic (`MAX_SIDE_CHARS = 20000`, a pure function of the inputs)
  ⇒ **cacheable**.
- `'timeout'` degradation is load-dependent (`DIFF_TIMEOUT_MS = 250`, wall clock) ⇒ **never
  cacheable**.
- `DIFF_TIMEOUT_MS` MUST NOT change (FR-006, CD-3).
- The report is per-request; never module-level state (re-entrancy).

---

## 5. Comparison (diff) cache entry

**Key**: `diff<CACHE_VERSION>:<docGuid>:<previousClock>:<currentClock>`
**Namespace**: `CACHE_VERSION` `'v9'` → **`'v10'`** — bumped exactly once (FR-007, D8/hazard #5).
**TTL**: 3600 s — unchanged (CD-3).
**Store**: Redis. Read/write transport errors remain non-fatal and logged.

**Value shape** (unchanged fields; no new fields):

```
{ document, currentDocument, meta: { previousClock, currentClock, textIdentical, formattingOnly, diffFailed } }
```

**Write predicate (FR-005) — replaces `isRedisEnabled() && !gapped`:**

```
cacheable = isRedisEnabled()
         && !incomplete        // (a) FR-004: internal gap OR short tail
         && !diffFailed        // (b) F8
         && !timeoutDegraded   // (c) F9 / CD-4
```

Conditions are **OR-ed into a veto** — never traded off (spec Edge Cases). No other condition may
suppress or force a write.

**Old entries**: discarded implicitly by the namespace bump; they expire naturally. No purge job.

---

## 6. Model-bound comparison result (serialization view)

Applies to the `modify`, `undo`, and `redo` tool results, whose `diff` is produced by
`computeChatDiff` (`server/mcp/diff-utils.js`).

| Field | Model-bound copy | Stored / browser-bound copy |
|---|---|---|
| `diff.lines` | kept | kept |
| `diff.hunkStarts` | **kept** (FR-012) | kept |
| `diff.formatAnnotations` | **kept** (FR-012) | kept |
| `diff.truncatedByServer` | kept | kept |
| `diff.inlineSegments` | **stripped** | **kept** (FR-013) |

**Transform**: `stripUiOnlyDiffFields(result)` — pure, non-mutating; returns the input unchanged
unless `result.diff.inlineSegments` exists, else a shallow clone with `diff` shallow-cloned minus
`inlineSegments`. Non-mutating is load-bearing: the same object is the persisted and
browser-bound copy.

**Applied at exactly three seams** (FR-012): MCP tool-result serialization; the live chat turn's
`toModelOutput`; the history-replay strip pass. Never at write/storage time.

---

## 7. Replace region (conceptual, both surfaces)

A removed run immediately followed by an added run in the line diff. Now the unit of word-level
refinement on **both** surfaces (FR-008) — previously the unit on version history only, while chat
used the individual row pair.

| Surface | Region detection | Fallback when guardrails trip |
|---|---|---|
| Version history (`server/diff/apply-word-marks.js`) | `part.removed` immediately followed by `parts[idx+1].added` in `diffLines` output | whole region → line-level `diffDelete`/`diffInsert` marks (unchanged) |
| Chat (`server/mcp/diff-postprocess.js`) | consecutive `-` run followed by consecutive `+` run in `structuredPatch` output | whole region → **no** `inlineSegments` (row tint only) — *changed*: was per-row |

**Unchanged and out of scope**: the format-only pairwise branch (`delLines.length === addLines.length`
+ identical plain text) runs **before** word segmentation and is untouched; the chat-only
`stripHardBreakMarkers` (028 / FR-011) is untouched.
