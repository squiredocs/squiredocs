# Promotion notes — 057-live-doc-consistency

Records the post-merge review dispositions for 057, plus the relaxations and tripwires
consciously accepted rather than fixed.

Reviewed at `4c3ea8ee`; fixes below are on `main`.

---

## Fixed

### MEDIUM — the post-subscribe reconcile raced the in-flight bind

**FIXED** — `53f2e4ce` (guard), `eab59092` (monotone assignment).

`server/index.js` chained `reconcileDoc` onto `subscribeToDocument`, which resolves on the
Redis SUBSCRIBE ack — milliseconds — while `bindState`'s load takes tens to hundreds of
them. `reconcileDoc` had no bind guard, so on the FIRST load of every document (whenever
Redis is enabled, i.e. production) it saw `_verifiedClock` undefined, took the
head-of-history branch, and fetched the entire log with bytes and the `users` LEFT JOIN
concurrently with the bind's own full load of the same rows. Double cost, on the
connection path, in the common case rather than a corner.

The clock consequence was worse. The racing pass advanced `_verifiedClock` to the log's
current tail; `collab-bind-state.js` then assigned `expectedTailClock ?? -1`, captured
BEFORE its fetch — an older clock — walking `_verifiedClock` BACKWARDS and breaking the
monotone invariant `verified-clock.js` states at `:63-67` and enforces at `:229`.

Both halves are closed:

1. **`collabReconcile.reconcileIfBound`** (`server/collab-reconcile.js`) skips a doc whose
   `_bindComplete !== true` and returns `skipped-mid-bind` without querying. `index.js`'s
   post-subscribe trigger goes through it. There is no blind window to close mid-bind: the
   subscriber's own `onUpdate` is already applying fan-out into the doc, and the binder is
   about to prove the tail itself. `_bindFailed` docs still fall through to `reconcileDoc`,
   which refuses them for its own (different) reason.
2. **The bind assignment is max-preserving**: `Math.max(existing ?? -1, expectedTailClock
   ?? -1)`. The guard removes the common race but not every one — `read-document.js`'s
   `fireRepair` calls `reconcileDoc` on the registry doc with no bind guard at all — so the
   invariant is defended at the assignment, not only by avoiding the collision.

Tests: `__tests__/integration/reconcile-fanout-loss.test.js` (post-subscribe mid-bind skip
with a `getUpdatesInRange` spy asserting **no** query, plus the refused-bind case);
`server/__tests__/collab-bind-completeness.test.js` → "monotone verified clock across bind
completion" (a REAL `reconcileDoc` landing inside the `getYDoc` await, then the bind
completing, asserting the higher clock survives; plus the `?? -1` zero-row branch and the
tail-still-wins direction). `collab-extraction-guard.test.js` G9c/G9c2 pin the call site.

### LOW-1 — the readiness gate could burn its full 10s on a concurrently-edited doc

**FIXED** — `79290f3e`.

`server/mcp/agent-presence.js` stage 1 waits for `registryDoc._verifiedClock >= armClock`,
but nothing on the live persist path advances that clock (`collab-bind-state.js:187` does
not touch it) and `check()` re-ran only on SESSION-doc updates. A row committed between the
binder's tail probe and the gate arming left verified(T0) < armClock(T1) with no trigger
inside the 10s budget — the gate burned its whole timeout on exactly the documents people
were using.

Reconciliation is the mechanism that advances the clock, so the gate asks for one: on
stage-1 failure it fires ONE `reconcileIfBound` at the registry doc, fire-and-forget, and
re-runs `check()` when it lands. Bounded work — the suffix above what is verified, never
the whole log — and it applies nothing when fan-out already delivered the bytes.

Chosen over "also re-check on registry-doc updates" (the AND/OR alternative): a second
listener on a live registry doc runs on every keystroke of every editor for the life of the
gate, and would still never fire on the case that matters, which is a document that has
gone QUIET after the racing commit.

Guards: once per gate (`nudged`), so a busy document cannot turn each session update into a
query; skipped for a doc still binding, whose binder is about to set the clock anyway; and
a failed pass is swallowed, leaving the timeout to bound the wait.

**Unchanged verbatim (RBD-057-5, SC-007):** the 10s budget, the 2s DB-error fallback, and
the resolve-anyway semantics of both. Pinned by the existing timeout tests and by a new one
asserting a failing nudge still resolves on the 10s timeout.

---

## Accepted, not implemented

### LOW-2 — first-read seeding fails on actively-edited docs

`server/mcp/tools/read-document.js:147-160` seeds the served session doc's `_verifiedClock`
from the registry doc only when the session doc DOMINATES the registry doc's state vector.
On a busy document that dominance check is refused for an ordinary reason: the registry doc
is a broadcast or two ahead of the session doc, which is the normal state of a doc being
edited, not evidence of anything wrong. The seed is then skipped and the read falls through
to the full-log fetch below it — `from = 0`, `includeData: true`, the whole history in
bytes — **awaited on the read path**, once per session, on precisely the documents where
the log is longest.

Not a correctness defect: the fetch produces the right answer and the label stays honest.
It is a latency cliff on first read of a hot document, and it is the exact case the seeding
optimisation was added to remove.

Two fix directions, either sufficient, neither taken here:

1. **Seed with `min(registryVerified, provable-from-suffix)`.** Instead of demanding
   full dominance, fetch the suffix above the registry's verified clock and seed the session
   doc with the highest clock that suffix proves it holds. Keeps the "never advance on
   trust" rule — the seed is still proven, just proven against a smaller range.
2. **Cap the fallback fetch window.** Bound the `from = 0` fetch to a suffix (the last N
   clocks, or `newestClock - K`), accepting a lower verified clock rather than an unbounded
   read. Under-labelling is already the safe direction throughout this module: it triggers
   an idempotent repair and converges.

Direction 1 is preferred — it removes the cliff without weakening the label. Direction 2 is
the cheap backstop if the suffix fetch turns out to need its own tuning.

---

## Tripwires

### `writeSetEnds` would count Skip structs as written ranges

`verified-clock.js:134-141` walks `Y.decodeUpdate(bytes).structs` and treats every struct's
`id.clock + length` as content the row WROTE. Yjs's `Skip` struct appears in that same list
and carries the same shape, so it would be counted as a written range that the doc must
hold — under-labelling a row that is in fact integrated.

**No guard is needed today, and none was added.** `Skip` structs are produced by Yjs when
it *merges* or *compacts* updates across gaps; every row in `yjs_updates` is an incremental
update written straight from a single `update` event, and nothing in this repo rewrites or
merges stored rows. Adding a filter now would be a guard against a shape the system cannot
currently produce, and it would sit in the hottest loop of the verification path.

**The tripwire:** if log compaction ever lands — merging `yjs_updates` rows, rewriting
history, or storing anything produced by `Y.mergeUpdates` — `writeSetEnds` must filter
`Skip` structs (`struct.constructor === Y.Skip`, or equivalently skip structs with no
content) BEFORE that ships. The failure mode is quiet: rows report uncovered, the verified
clock stalls below the tail, and every read on the document falls into the full-log fetch
and a spurious repair. It looks like a performance problem, not a correctness one, which is
why it is written down here rather than left to be rediscovered.
