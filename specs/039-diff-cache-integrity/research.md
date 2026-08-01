# Phase 0 Research — 039-diff-cache-integrity

All Technical Context unknowns are resolved; no `NEEDS CLARIFICATION` remains. Every finding
below is grounded in a read of the current code, not priors.

---

## R1 — Where the tail-completeness check belongs

**Decision**: inside `_fetchRowsWithGapRetry` (`server/postgres-persistence.js:365`), as an
optional `expectedTailClock` key on its existing trailing options object; surfaced through
`getUpdateRowsUpTo(docGuid, clock, { expectedTailClock })` (line 741).

**Rationale**: `_fetchRowsWithGapRetry` already owns the *one* shared retry budget
(`COLLAB_READ_GAP_RETRIES`, `COLLAB_READ_GAP_RETRY_DELAYS_MS`) and the structured warn line, and
the retry loop already re-runs the full fetch. A tail-short read is semantically the same failure
as an internal gap — a torn read the gap detector simply cannot see, because `_findFirstGap`
(line 330) only judges contiguity *within* the fetched rows and is trivially gap-free for an empty
or truncated-at-the-end set. Putting the check anywhere else would either duplicate the budget
(forbidden by ratified 023 FR-008, "one shared budget, no per-path knobs") or leave the retry
unavailable.

**Alternatives considered**:
- *A separate `getUpdateRowsUpToStrict`*: duplicates the retry loop and the warn line; two code
  paths to keep in sync. Rejected.
- *Deriving the expectation from the `clock` argument*: fatal. The backfill
  (`server/scripts/backfill-meaningful-classification.js:100`) passes `MAX_CLOCK = 2147483647`
  as `clock`; a derived expectation would make every backfilled document exhaust the retry budget
  and then log a false "incomplete" warning. This is hazard #1 and the reason FR-002 exists.
- *Checking the tail in `DiffService.computeDiff` after the fetch*: detects the problem but cannot
  retry (the rows are already returned), so it converts a self-healing race into a permanent
  serve-without-cache. Rejected.

**Contract detail (retry loop, exact)**: the loop's break condition becomes
`if (!incomplete || retries >= maxRetries) break;` where
`incomplete = firstGapAfterClock !== null || tailShort`, and
`tailShort = expectedTailClock != null && (rows.length === 0 ? expectedTailClock >= 0 : Number(newest.clock) < expectedTailClock)`.
`newest` is the last row in the *ascending* view (i.e. respects `descending`). The returned
`gapped` flag becomes true for either condition — callers already treat `gapped` as "do not
freeze this" (023 D-2), so no caller semantics change. The warn line gains the tail reason so the
two causes are distinguishable in logs.

---

## R2 — How the word-diff degradation reason reaches the cache decision

**Decision**: an out-of-band mutable `report` object, created in `DiffService.computeDiff` and
threaded `computeDiff → computeMarkdownDiff → applyWordMarks → computeWordSegments`. The segmenter
stamps `report.reason = 'size' | 'timeout'`; the caller ORs `timeout` sightings into a
`timeoutDegraded` flag. `computeWordSegments` **keeps returning `null`** on degradation.

**Rationale**: FR-006 asks literally for "an out-of-band degradation signal threaded from the
segmentation step through the version-history word-marking step to the comparison computation".
`computeWordSegments` today returns `null` for both reasons (`shared/diff/word-diff.js:68,71`) and
its two call sites both guard with `if (!segs)`. Keeping `null` means a missed call site is a
loud no-emphasis, not a silent wrong-emphasis.

**Alternatives considered**:
- *Discriminated result (`{ before, after } | { degraded: 'size'|'timeout' }`)*: cleaner typing, but
  a truthy degraded object slips past every existing `if (!segs)` guard and produces
  `segs.before === undefined` downstream. Rejected on blast radius (see plan Complexity Tracking).
- *Throwing on timeout*: `applyWordMarks` has a fail-open `catch` (line 169) that would swallow it
  into the generic "refinement failed" path, losing the distinction between size and timeout —
  which is exactly what FR-005(c) needs to keep. Rejected.
- *A module-level counter in `word-diff.js`*: not re-entrant; concurrent requests would cross-talk.
  Rejected.

**Why `size` must remain cacheable**: `MAX_SIDE_CHARS = 20000` is a pure function of the inputs, so
a size-capped region degrades identically on every recompute. Caching it is not freezing luck —
it is caching the correct answer. `DIFF_TIMEOUT_MS = 250` is wall-clock and load-dependent, so
caching its outcome freezes server load as truth. That is the entire distinction FR-005(c) draws.

---

## R3 — Restoring two-surface parity (F10)

**Current divergence, exactly**:
- Version history (`server/diff/apply-word-marks.js:156-167`) segments the region **as a whole**:
  both sides parsed unmarked, `plainTextOf` joins textblocks with `'\n'`, one
  `computeWordSegments(plainRemoved, plainAdded)` call, then `stampSide` walks text nodes by
  character offset.
- Chat (`server/mcp/diff-postprocess.js:183-191`) pairs **row k of removed with row k of added**
  (`pairCount = Math.min(delOutIdx.length, addOutIdx.length)`) and gives surplus rows no segments.

Positional pairing is why a line inserted at the top of a rewritten block makes every subsequent
(unchanged) line diff against its neighbour and light up as changed — the exact false-emphasis
symptom in US4.

**Decision**: new shared helper `computeLineWordSegments(beforeLines, afterLines, report)` in
`shared/diff/word-diff.js`:

1. `before = beforeLines.join('\n')`, `after = afterLines.join('\n')`.
2. `segs = computeWordSegments(before, after, report)`; on `null`, return `null` (whole region
   falls back).
3. Re-split each side's coalesced segment stream at `'\n'` boundaries into per-row arrays. A
   segment containing newlines is cut at each one; the newline character itself is dropped (it is
   the row separator, not row content).
4. Return `{ before: Segment[][], after: Segment[][] }` — one array per input row, in order.

`diff-postprocess.js` then assigns `inlineSegments[delOutIdx[k]] = perRow.before[k]` for **all**
rows on each side. The client contract (`inlineSegments` keyed by stringified output-row index,
consumed at `client/src/components/AiChatMessages.jsx:318`) is unchanged.

**Why the re-split is exact**: `computeWordSegments` guarantees
`side.map(s => s.text).join('') === input` (documented at `shared/diff/word-diff.js:58`, asserted
in `shared/diff/__tests__/word-diff.test.js`). Cutting that stream at every `'\n'` therefore
reproduces `input.split('\n')` exactly, so each row's segments rejoin byte-identically to that
row's text. This is a *derived* invariant of the segmenter's faithfulness and must be tested as
bytes (hazard #3), because a future change to `coalesce` or to whitespace handling would break the
re-split silently.

**Text the chat surface segments**: the row text used today is
`stripSpanTags(lines[i].slice(1))` — the prefix- and span-stripped text the row actually renders.
The joined region must be built from those same stripped strings so segments still rejoin to
rendered text. Do **not** join the raw prefixed lines.

**Guardrail relocation (approved)**: `MAX_SIDE_CHARS`/`DIFF_TIMEOUT_MS` now apply to the joined
region rather than to each row pair, so a very large replace region falls back to row-tint-only in
chat slightly more often — the same fallback version history already uses. Explicitly approved in
spec Assumptions and FR-010.

**`applyWordMarks` needs no algorithmic change** — it is already per-region and already the
reference behavior. It gains only the `report` pass-through.

---

## R4 — The three model-bound seams (F11)

Traced to concrete lines. The UI-only payload is `result.diff.inlineSegments`, produced by
`computeChatDiff` (`server/mcp/diff-utils.js:129,140`) and attached to `modify`, `undo`, and
`redo` tool results (`server/mcp/tools/modify.js:549`, `server/undo/undo-service.js:77`).

| Seam | Location | Mechanism |
|---|---|---|
| (a) MCP tool result | `server/mcp/index.js:69` — `JSON.stringify(result, null, 2)` | wrap `result` in `stripUiOnlyDiffFields(result)` before stringify |
| (b) live in-app chat turn | `server/api/chat-tools.js:467-521` (`buildTools`, the MCP-bridge `tool({...})`) | add `toModelOutput: ({ output }) => ({ type: 'json', value: stripUiOnlyDiffFields(output) })` — the AI SDK's sanctioned hook; the *stored* output (what the browser renders) is untouched |
| (c) replayed history | `server/api/chat.js:959-975`, before `convertToModelMessages` at line 976 | new `stripUiOnlyDiffParts(messages)` in `server/api/chat-models.js`, called beside `stripReasoningParts` (line 964) |

**Decision**: one shared pure helper `stripUiOnlyDiffFields(toolResult)` exported from
`server/mcp/diff-utils.js`, non-mutating, that returns the input unchanged unless
`toolResult.diff.inlineSegments` exists, in which case it returns a shallow clone with `diff`
shallow-cloned minus `inlineSegments`. `hunkStarts`, `formatAnnotations`, `lines`, and
`truncatedByServer` are retained (FR-012).

**Rationale**: three seams, one implementation. Non-mutating matters at seam (b) and (c) because
the same object is also the persisted/browser-bound copy (FR-013) — an in-place delete would
silently break rendering of the current turn.

**Alternatives considered and rejected**:
- *Passing `{ tools }` into `convertToModelMessages`* to get `toModelOutput` applied to history in
  one line. **Explicitly forbidden by FR-014 and hazard #2**: `view_image` and `view_svg_blocks`
  define `toModelOutput` at `server/api/chat-tools.js:321` and `:386` specifically to *add* image
  bytes that the stored history deliberately omits (see the comments at `:312` and `:370`).
  Applying them to replayed history would re-inline every image on every turn — a far larger token
  regression than the one being fixed, plus a 404 risk on text-only models.
- *Stripping at write time (never store segments)*: violates FR-013 — the browser renders the diff
  from stored history when a conversation is reopened.
- *A generic deep walk that removes any key named `inlineSegments`*: over-broad on unrelated tool
  results and slow on large payloads. Targeted top-level `.diff` handling is sufficient — all three
  producers put it there.

**Note on `MAX_RESULT_CHARS`**: `chat-tools.js:501` measures `JSON.stringify(result).length`
against the oversize limit *before* any strip. Leave it measuring the full result — it is a guard
on what gets stored and rendered, not only on what the model sees. Changing it is out of scope and
would alter unrelated truncation behavior.

---

## R5 — Single-replay state reconstruction (F12)

**Current**: `buildDocsAtClocks` (`server/diff-service.js:134-158`) loops once over all rows and
applies each row to `prevDoc` (if `clock <= previousClock`) **and** to `currDoc` (if
`clock <= currentClock`). Every row in the shared prefix is therefore applied twice.

**Decision**:

```
prevDoc = new Y.Doc({ gc: false })
currDoc = new Y.Doc({ gc: false })
if previousClock >= 0:
    apply rows with clock <= previousClock  → prevDoc
    Y.applyUpdate(currDoc, Y.encodeStateAsUpdate(prevDoc))     // seed, one merge
apply rows with previousClock < clock <= currentClock → currDoc
```

When `previousClock < 0` the seeding step is skipped and `currDoc` receives all rows
`clock <= currentClock`, exactly as today (FR-015 / US6 scenario 2).

**Rationale**: Yjs is a CRDT — applying the prefix updates and applying their merged encoded form
are equivalent by convergence. `gc: false` on `prevDoc` is what makes the seed safe: deleted
structs survive `encodeStateAsUpdate`, so `currDoc` sees the same struct store it would have built
from the raw rows. Both docs already use `gc: false` (lines 135-136) and must continue to.

**Risk & mitigation**: the guarantee is convergence, not byte-identity of the *update stream* — but
the diff is computed from the resulting document (`toMarkdown` over the XmlFragment), which is what
converges. Mitigation is a direct test: deep-equal the full `computeDiff` output before/after for
representative pairs (SC-006), plus an application counter proving each row is applied ≤ 1× per
reconstruction.

**Alternatives considered**: *cloning `prevDoc`* — Yjs has no cheap deep clone; the documented
idiom is exactly `applyUpdate(target, encodeStateAsUpdate(source))`. *Two passes over the row
array* — no benefit; the single pass with a clock partition is simpler.

---

## R6 — Faithful plain-text extraction (F13)

**Current bug**: `extractText` (`server/yjs-utils.js:28-37`) does
`node.toString().replace(/<[^>]*>/g, '')` on each top-level node. Prose containing literal
angle-bracket text — e.g. `use <div> tags for layout` — is serialized as escaped or literal markup
by `Y.XmlElement.toString()` and then *deleted* by the regex. Two versions differing only inside
such prose extract to the same string ⇒ `textIdentical === true` ⇒ the comparison reports
"Formatting changes only" over a visible text change.

**Decision**: walk the Yjs tree. For each top-level fragment node, recursively concatenate the
text of `Y.XmlText` descendants (via `.toString()` on `Y.XmlText`, or the delta's string inserts)
and recurse into `Y.XmlElement`/`Y.XmlFragment` children; join top-level node texts with `'\n'`;
`.trim()` the result.

**Shape preservation (CD-8)**: descendants are concatenated with **no separator**, and only
top-level nodes are newline-joined — reproducing exactly what the regex version produced for
tag-free prose. This keeps `textIdentical` semantics stable for the 99% case; the only intended
behavior change is that literal angle-bracket prose is now preserved.

**Blast radius**: `extractText` has exactly **one** consumer — `server/diff-service.js:21`
(verified by repo-wide grep; `server/version-history.js:8` and `server/update-classifier.js:16`
import only `extractXml`). So the change reaches `meta.textIdentical`, `meta.formattingOnly`, and
the `computeMarkdownDiff` short-circuit — nothing else. `extractXml` is deliberately **not**
changed: `formattingOnly` needs the markup-bearing form, and `update-classifier` depends on it.

**Note on `Y.XmlText` inline formatting**: `Y.XmlText.toString()` emits inline formatting as tags.
The walk must extract the *string inserts* (e.g. via `toDelta()`), not `toString()`, on
`Y.XmlText` nodes — otherwise the bug simply moves one level down. This is the single subtlety in
the implementation and needs its own test (bold text containing a literal `<`).

**FR-017 (dead parameter)**: `computeMarkdownDiff(prevDoc, currDoc, textIdentical)` declares
`textIdentical` (`server/diff-service.js:187`) and never reads it — the function re-derives the
answer from `prevMd === currMd` at line 195. Remove the parameter and update the call site at
line 88. No behavior change.

---

## R7 — Stable history badge color (F14)

**Current**: `client/src/components/HierarchicalVersionList.jsx:56` —
`backgroundColor: author.color || generateColorFromId(author.id)`.
`generateColorFromId` (`client/src/utils/colorUtils.js:58-71`) salts the hash with
`new Date().toISOString().slice(0, 10)`, so a colorless author's badge changes color every day —
in a *history* record.

**Decision**: replace the fallback with the literal `'#888888'`, matching the server's
no-identity fallback (`server/version-history.js:60`, and `colorUtils.js:59` for the empty-id
case). `generateColorFromId` itself and the presence palette rotation are **not** touched (FR-018;
presence rotation is deliberate product behavior and out of scope per the spec).

**Note**: the server normally supplies `author.color` via `generateColorFromId(authorKey)` at
`server/version-history.js:111`, so this is a near-dead path — which is precisely why it must be
made deterministic rather than clever.

---

## R8 — Worktree / test-environment facts

- Worktrees do not inherit `node_modules`: `npm ci && (cd client && npm ci)` is required.
- Backend tests are serial-only per database (memory: `backend-test-db-serial-only`); a parallel
  agent MUST use its own database (`collab_test_db_039`) and pass `DATABASE_URL` on every command.
  `server/__tests__/helpers/db.js` respects `DATABASE_URL`. `--runInBand` is already wired — do not
  defeat it.
- Redis is shared across agents and that is fine here: the `CACHE_VERSION` bump to `v10` namespaces
  039's entries away from anything 038 or the dev server writes.
- Client Vitest and `npm run build` are worktree-safe as-is.
- `.env` should be copied from the main tree if present.

---

## Resolved unknowns summary

| Unknown | Resolution |
|---|---|
| Where the tail check lives without new knobs | R1 — `_fetchRowsWithGapRetry` options key, reusing the one shared budget |
| How `timeout` vs `size` reaches the cache gate | R2 — out-of-band `report` sink, `null` return preserved |
| How to make the two surfaces agree | R3 — `computeLineWordSegments`, per-region segment + lossless newline re-split |
| Which three seams leak `inlineSegments` | R4 — `mcp/index.js:69`, `chat-tools.js` `toModelOutput`, `chat.js` history pass |
| Whether the seed-from-prev reconstruction is safe | R5 — yes, `gc:false` + CRDT convergence; pinned by a deep-equal test |
| What `extractText` should become without changing `textIdentical` semantics | R6 — structural walk, same line shape, `toDelta()` on `Y.XmlText` |
| Whether `generateColorFromId` should change | R7 — no; only the history call site's fallback |
