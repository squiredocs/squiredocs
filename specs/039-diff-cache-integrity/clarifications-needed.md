# Clarifications — 039-diff-cache-integrity

Decisions Sam has not explicitly answered, resolved with best defaults per the
parallel-agent protocol. Each is **RATIFIED-BY-DEFAULT (Sam pre-authorized,
2026-08-01)** — flag at review if any default is wrong.

---

## CD-1: Which readers opt in to the tail-completeness expectation

**Status**: RATIFIED-BY-DEFAULT (Sam pre-authorized, 2026-08-01)

**Question**: The new opt-in expected-tail-clock check (FR-001) could be adopted
by other log readers that know a target clock (e.g. future callers of
`getUpdateRowsUpTo`), not just the diff service. Should any reader besides the
version-comparison computation opt in as part of this feature?

**Why it came up**: The audit fix (F7) prescribes the mechanism and mandates
opt-in (the backfill's MAX_CLOCK sentinel must not burn retries) but names only
the diff path as a consumer.

**Default chosen**: Only the version-comparison computation (`computeDiff` →
`getUpdateRowsUpTo`) supplies the expectation in this feature. All other readers
(getYDoc, history, exports, MCP read) keep today's behavior byte-for-byte.

**Rationale**: The diff cache is the only place a tail-short read gets frozen
for an hour; serving-only readers self-heal on the next read (023's ratified
serve-as-is posture). Widening adoption is a separate, low-risk follow-on that
should not ride a cache-integrity fix.

---

## CD-2: User-facing indication for served-but-not-cached results

**Status**: RATIFIED-BY-DEFAULT (Sam pre-authorized, 2026-08-01)

**Question**: When a comparison is served but deliberately not cached
(tail-short, gapped, diff-failed, timeout-degraded), should the UI say anything
new (e.g. a "temporary view, refresh for final" hint)?

**Why it came up**: FR-004/FR-005 create more served-not-cached outcomes than
today; a visible hint could prompt users to refresh.

**Default chosen**: No new UI states. Keep exactly today's presentation (the
existing "Diff highlighting unavailable" notice for failures, silent line-level
fallback for degradation, normal render for short-tail serves) plus the existing
structured server warn line for observability.

**Rationale**: 023 D-2 ratified serve-silently-and-heal for torn reads; the fix
makes healing actually happen (next request recomputes). New UI copy is a
product decision Sam hasn't seen, and the conditions are transient by nature.

---

## CD-3: Cache TTL and retry budget stay unchanged

**Status**: RATIFIED-BY-DEFAULT (Sam pre-authorized, 2026-08-01)

**Question**: While changing cache-write rules, should the 1-hour TTL or the
shared gap-retry budget (2 retries, 100/300ms) be tuned — e.g. a shorter TTL as
an extra backstop against any future poisoning class?

**Why it came up**: Adjacent knobs to the code being changed; a reviewer will
ask.

**Default chosen**: Both unchanged. The feature changes only *when* a write is
allowed and *what counts as incomplete*; TTL and budget values are out of scope.

**Rationale**: The correct fix is preventing bad writes, not shortening how long
they live; the retry budget is a ratified single shared budget (023 FR-008,
"no per-path knobs") and the tail-check deliberately reuses it. Shrinking TTL
would cut cache efficacy for the healthy 99% case to paper over a bug this
feature actually fixes.

---

## CD-4: Timeout-degradation granularity for the cache-skip decision

**Status**: RATIFIED-BY-DEFAULT (Sam pre-authorized, 2026-08-01)

**Question**: A comparison can contain several replace regions; if only one
region timed out, should the whole result be uncacheable, or could the clean
regions' work be salvaged (partial caching / per-region cache)?

**Why it came up**: FR-005(c) says "no word-level segmentation in the result
degraded due to the time budget" — the strictest reading. Per-region caching
would be a bigger design.

**Default chosen**: Whole-result granularity: ANY timeout-degraded region makes
the entire comparison result uncacheable. The next request recomputes everything.

**Rationale**: The cache stores one blob per (doc, prevClock, currClock); the
determinism goal (SC-004) is about what that blob contains. Partial caching
would change the cache's shape for a rare, transient condition, and recompute
cost is bounded by the same caps that caused the timeout.

---

## CD-5: How the tail expectation is supplied (never derived)

**Status**: RATIFIED-BY-DEFAULT (Sam pre-authorized, 2026-08-01) — added at plan time

**Question**: FR-001 requires an opt-in expected-tail-clock. Should it be an
explicit option, or could `_fetchRowsWithGapRetry` infer it from the `clock`
upper bound the caller already passes?

**Why it came up**: Inferring it would need no API change at all, which is
superficially attractive.

**Default chosen**: An explicit optional key on the existing trailing options
object — `getUpdateRowsUpTo(docGuid, clock, { expectedTailClock })` →
`_fetchRowsWithGapRetry(client, sql, params, label, { descending, expectedTailClock })`.
The value is **never** derived from `clock`. Absent the key, the code path is
byte-identical to today. Additionally: when `expectedTailClock` is supplied and
`>= 0`, a zero-row fetch counts as incomplete (retry), not as an empty document;
without the key, zero rows remains a legitimate empty document.

**Rationale**: `server/scripts/backfill-meaningful-classification.js:100` passes
`MAX_CLOCK = 2147483647` as `clock`. A derived expectation would make **every**
backfilled document exhaust the retry budget and emit a false incomplete-read
warning — precisely what FR-002 forbids. Explicit opt-in is also the only form
that keeps the four other `_fetchRowsWithGapRetry` call sites untouched.

---

## CD-6: Shape of the degradation-reason signal

**Status**: RATIFIED-BY-DEFAULT (Sam pre-authorized, 2026-08-01) — added at plan time

**Question**: FR-006 requires `computeWordSegments` to distinguish `size` from
`timeout` degradation and surface it. Should it return a discriminated result
(`{ before, after } | { degraded: 'size'|'timeout' }`) or keep returning `null`
and report the reason out of band?

**Why it came up**: The spec says "out-of-band degradation signal" but does not
fix the mechanism, and a discriminated return is the more idiomatic design.

**Default chosen**: Keep the `null`-on-degradation return exactly as today, and
accept an optional `report` object that the function stamps with
`report.reason = 'size' | 'timeout'`. The same object is threaded
`computeDiff → computeMarkdownDiff → applyWordMarks → computeWordSegments`, and
`computeDiff` ORs any `'timeout'` sighting into the cache-write gate.

**Rationale**: Both existing call sites guard with `if (!segs)`. A truthy
`{ degraded: … }` object would slip past any guard that was missed during the
change and produce `segs.before === undefined` downstream — a silent
wrong-output bug instead of a loud no-emphasis one. It also matches FR-006's
literal wording. Revisit if a third caller ever appears.

---

## CD-7: Two mechanisms for one logical strip (live turn vs. history)

**Status**: RATIFIED-BY-DEFAULT (Sam pre-authorized, 2026-08-01) — added at plan time

**Question**: FR-012 names three model-bound seams. The live in-app turn and the
replayed history could plausibly share one mechanism. Should they?

**Why it came up**: Two call sites for one rule invites a later "simplification"
that reintroduces the exact bug FR-014 forbids.

**Default chosen**: Two mechanisms, one shared implementation. The live turn uses
`toModelOutput` on the MCP-bridged chat tools (`server/api/chat-tools.js`); the
replay uses a dedicated `stripUiOnlyDiffParts(messages)` pass over UI messages in
`server/api/chat-models.js`, called beside `stripReasoningParts` *before*
`convertToModelMessages`. Both call the same pure `stripUiOnlyDiffFields(result)`
helper. `convertToModelMessages` is still called **without** a `{ tools }`
argument.

**Rationale**: FR-014 and the audit hazard: passing tool definitions to the
history conversion would invoke `view_image` / `view_svg_blocks`'s
`toModelOutput`, which exist specifically to ADD image bytes that stored history
deliberately omits — re-inlining every image on every turn (a far bigger token
regression than the one being fixed, plus a 404 on text-only models). A code
comment at both call sites must record this so the "simplification" is never
attempted.

---

## CD-8: Line shape of the rewritten plain-text extraction

**Status**: RATIFIED-BY-DEFAULT (Sam pre-authorized, 2026-08-01) — added at plan time

**Question**: FR-016 replaces `extractText`'s regex tag-strip with a structural
walk. A structural walk could reasonably emit a newline per *block* (including
nested list items and table cells), which would change `textIdentical` for many
documents beyond the angle-bracket bug.

**Why it came up**: The spec fixes the extraction *method* but not the output
*shape*, and `extractText` feeds `textIdentical` / `formattingOnly`.

**Default chosen**: Preserve today's shape exactly — one line per **top-level**
fragment node, all descendants concatenated with **no** separator, `.trim()` at
the end. The only intended behavioral difference is that literal angle-bracket
prose survives. `extractXml` is not touched.

**Rationale**: `extractText` has exactly one consumer (`server/diff-service.js`),
so the change is contained — but its output drives the "Formatting changes only"
banner and the identical-text short-circuit for every comparison. Fixing the bug
while holding the shape constant makes the change auditable: any test that flips
is a real regression, not a shape change. A prettier block-per-line extraction is
a separate, opt-in decision.

