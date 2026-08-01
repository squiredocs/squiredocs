# Contract — Comparison cache write rules (FR-004 … FR-007)

Module: `server/diff-service.js`. Cache: Redis, key
`diff<CACHE_VERSION>:<docGuid>:<previousClock>:<currentClock>`, TTL 3600 s.

---

## Namespace

```js
const CACHE_VERSION = 'v10';   // was 'v9' (server/diff-service.js:26)
```

**Bumped exactly once** for this entire feature (FR-007, hazard #5). Every output-shape change in
039 — the parity rewrite, the extraction fix, the strip — rides this single bump. Old entries are
discarded implicitly and expire naturally; no purge job. **Do not bump again** for a later task
in this feature.

---

## Read path

Unchanged: cache hit returns the parsed entry immediately; read errors are logged and fall through
to computation.

---

## Write predicate

Replaces `if (isRedisEnabled() && !gapped)`:

```js
const cacheable = isRedisEnabled()
  && !incomplete        // (a) FR-004 — internal gap OR short tail
  && !result.meta.diffFailed   // (b) F8
  && !timeoutDegraded;         // (c) F9 / CD-4
```

### Condition semantics

| # | Source | Cacheable when |
|---|---|---|
| (a) `incomplete` | `gapped` from `getUpdateRowsUpTo(..., { expectedTailClock: currentClock })` | row set was complete |
| (b) `diffFailed` | the existing `catch` around `computeMarkdownDiff` (`server/diff-service.js:87-93`) | computation succeeded |
| (c) `timeoutDegraded` | any region whose word segmentation degraded with reason `'timeout'` | no timeout degradation anywhere in the result |

### Rules

- **CW-1 — Veto, never trade-off.** The conditions are AND-ed; a result failing any one is
  **served** to the requester and **not** cached. A result failing several is likewise served and
  not cached (spec Edge Cases: "the no-cache conditions are OR-ed, never traded off").
- **CW-2 — Size degradation is cacheable.** A region that degraded with reason `'size'`
  (`MAX_SIDE_CHARS = 20000`, a pure function of the inputs) produces the same output on every
  recompute. It MUST NOT suppress the write (FR-005(c)).
- **CW-3 — Whole-result granularity.** ANY timeout-degraded region makes the ENTIRE comparison
  uncacheable (CD-4). No partial or per-region caching.
- **CW-4 — Exhaustive.** No other condition may suppress or force a cache write.
- **CW-5 — Transport errors stay non-fatal.** Redis read/write failures are caught and logged, as
  today; they never fail the request and never change what is served.
- **CW-6 — No TTL change.** 3600 s, unchanged (CD-3).
- **CW-7 — No new UI state.** An uncacheable result is served with today's presentation: the
  existing "Diff highlighting unavailable" notice on `diffFailed`, silent line-level fallback on
  degradation, a normal render on a short-tail serve (CD-2).

---

## Degradation report plumbing (FR-006)

A per-request mutable object, never module state:

```
computeDiff
  → creates report sink, derives timeoutDegraded
  → computeMarkdownDiff(prevDoc, currDoc, report)         // note: textIdentical param REMOVED (FR-017)
      → applyWordMarks(removedMd, addedMd, report)
          → wordDiff.computeWordSegments(before, after, report)   // stamps report.reason
```

`computeWordSegments` keeps its `null`-on-degradation return (CD-6). The caller ORs each
`reason === 'timeout'` sighting into `timeoutDegraded`. `DIFF_TIMEOUT_MS` MUST NOT change.

---

## State reconstruction (FR-015)

`buildDocsAtClocks(updates, previousClock, currentClock)` — same signature, same return shape
(`{ prevDoc, currDoc, prevText, currText }`), new internals:

```
prevDoc = new Y.Doc({ gc: false })
currDoc = new Y.Doc({ gc: false })

if previousClock >= 0:
    for row where clock <= previousClock:  Y.applyUpdate(prevDoc, row)
    Y.applyUpdate(currDoc, Y.encodeStateAsUpdate(prevDoc))     // seed once
    for row where previousClock < clock <= currentClock: Y.applyUpdate(currDoc, row)
else:
    for row where clock <= currentClock:   Y.applyUpdate(currDoc, row)   // seeding skipped
```

- **SR-1** Each log row is applied **at most once** per reconstruction (SC-006).
- **SR-2** `gc: false` on both docs is preserved — load-bearing, so the seed carries deleted structs.
- **SR-3** Output is **identical** to the double-replay result (CRDT convergence), pinned by a
  deep-equal test over representative version pairs.
- **SR-4** `previousClock < 0` skips seeding; behavior unchanged (US6 scenario 2).

---

## Metadata correctness (FR-016, FR-017)

- `extractText` (`server/yjs-utils.js`) walks the Yjs tree instead of regex-stripping tag-like
  substrings; literal angle-bracket prose survives verbatim. Line shape is preserved exactly:
  one line per top-level fragment node, descendants concatenated with no separator, `.trim()`
  at the end (CD-8). `extractXml` is **not** changed.
- `computeMarkdownDiff`'s declared-but-never-read `textIdentical` parameter
  (`server/diff-service.js:187`) is removed along with its argument at the call site (line 88).
  No behavior change — the function already re-derives the answer from `prevMd === currMd`.

---

## Test obligations

| ID | Assertion |
|---|---|
| CW-T1 | Incomplete (tail-short) read ⇒ result served, **no** `setex` call; next request after the log heals ⇒ correct diff **and** `setex` called. |
| CW-T2 | `diffFailed` ⇒ fallback served, **no** `setex`; retry with the failure removed ⇒ full diff **and** cached. |
| CW-T3 | `'size'` degradation ⇒ line-level result **is** cached. |
| CW-T4 | `'timeout'` degradation ⇒ result served, **no** `setex`; recompute without timeout ⇒ word-level result cached. |
| CW-T5 | Multiple simultaneous failures ⇒ still exactly one served response, no cache write. |
| CW-T6 | Cache key starts with `diffv10:`; `CACHE_VERSION === 'v10'`; a `v9` entry is never read. |
| CW-T7 | Healthy path: complete + successful + no timeout ⇒ cached with TTL 3600, exactly as today. |
| CW-T8 | Redis `setex` throwing is caught, logged, and does not fail the request. |
| CW-T9 | Deep-equal of `computeDiff` output before/after the FR-015 change, for ≥3 representative pairs incl. `previousClock = -1`. |
| CW-T10 | Row-application counter: no row applied more than once per reconstruction. |
| CW-T11 | Two versions differing only inside literal `<div>` prose ⇒ `textIdentical === false`, `formattingOnly === false`. |
| CW-T12 | Literal angle-bracket text inside a **bold** run survives (the `Y.XmlText` `toDelta` subtlety). |
