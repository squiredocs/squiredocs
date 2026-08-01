# Contract — Read completeness (FR-001 … FR-004)

Internal module contract. **039 territory: the READ path of `server/postgres-persistence.js` only.**
The WRITE path (`storeUpdate`) belongs to feature 038 and MUST NOT be modified.

---

## `_fetchRowsWithGapRetry(client, sql, params, label, opts)`

```
opts: {
  descending?: boolean          // existing, unchanged
  expectedTailClock?: number     // NEW, optional
}
→ Promise<{ rows: Array, gapped: boolean, retries: number }>
```

### Behavior

| `expectedTailClock` | Behavior |
|---|---|
| omitted / `null` / `undefined` | **Byte-identical to today.** Only `_findFirstGap` decides `gapped`. Zero rows is a legitimate empty document. |
| supplied | A fetch is *incomplete* if `_findFirstGap(rowsAsc) !== null` **OR** the tail is short (below). Incomplete triggers the same retry loop; still-incomplete after the budget returns `gapped: true`. |

### Tail-short predicate

Evaluated on the ascending view of rows (respecting `descending`):

```
rowsAsc.length === 0
  ? expectedTailClock >= 0
  : Number(rowsAsc[rowsAsc.length - 1].clock) < expectedTailClock
```

### Guarantees

- **G1 — One budget.** Uses the existing `COLLAB_READ_GAP_RETRIES` (default 2) and
  `COLLAB_READ_GAP_RETRY_DELAYS_MS` (default `100,300`). **No new environment variable, no
  per-path budget** (ratified 023 FR-008).
- **G2 — Opt-in.** Every existing call site that does not pass `expectedTailClock` observes
  unchanged behavior, including identical retry counts and log output.
- **G3 — Observability.** A still-incomplete read emits the existing structured `console.warn`
  line, extended to name the reason (gap vs. short tail) so the two causes are distinguishable in
  production logs. Never throws, never waits unboundedly.
- **G4 — Caller decides.** The function never suppresses a result; `gapped` is advisory and the
  caller owns the consequence (serve / skip-cache / abort — 023 D-2).

---

## `getUpdateRowsUpTo(docGuid, clock, opts)`

```
opts: { expectedTailClock?: number }
→ Promise<{ rows: Array<{clock, update_data}>, gapped: boolean }>
```

Forwards `expectedTailClock` to `_fetchRowsWithGapRetry`. Return shape unchanged.

### Guarantees

- **G5 — Never derived.** `expectedTailClock` MUST NOT default to, or be inferred from, `clock`
  (CD-5). `server/scripts/backfill-meaningful-classification.js:100` calls
  `getUpdateRowsUpTo(docGuid, MAX_CLOCK)` with `MAX_CLOCK = 2147483647`; a derived expectation
  would burn the full retry budget on **every** document and log a false incomplete-read warning.
  This is the single most important negative requirement in the contract (FR-002, hazard #1).

---

## `_findFirstGap(rows)`

**Unchanged.** Judges contiguity strictly *within* the fetched rows. Empty and single-row sets
remain trivially gap-free — which is exactly why the tail check is needed and why it must live
outside this function.

---

## Consumer: `DiffService.computeDiff`

MUST call:

```js
const { rows, gapped } = await this.persistence.getUpdateRowsUpTo(
  docGuid, currentClock, { expectedTailClock: currentClock }   // FR-003
);
```

`gapped` (now meaning *incomplete*) feeds condition (a) of the cache-write gate — see
[cache-write-rules.md](./cache-write-rules.md).

---

## Non-consumers (explicitly unchanged — CD-1)

`getYDoc`, `getYDocAtClock`, `_queryUpdatesWithUsers` (and therefore history, exports, MCP read,
timeline) do **not** opt in. They are serving-only readers that self-heal on the next read; only
the diff path freezes an answer for an hour.

---

## Test obligations

| ID | Assertion |
|---|---|
| RC-1 | With `expectedTailClock` supplied and the newest row missing, the fetch is retried up to the budget. |
| RC-2 | Budget exhausted with a short tail ⇒ `gapped: true` and a warn line naming the tail reason. |
| RC-3 | The newest row appearing on retry *N* ⇒ `gapped: false`, rows include it, no further retries. |
| RC-4 | Zero rows **with** `expectedTailClock >= 0` ⇒ incomplete (retried). |
| RC-5 | Zero rows **without** the option ⇒ complete, no retry (empty document). |
| RC-6 | Omitting the option reproduces today's retry count and `gapped` value on gapped, gap-free, and empty inputs. |
| RC-7 | `getUpdateRowsUpTo(guid, MAX_CLOCK)` with no option performs **exactly one** query (backfill regression guard). |
| RC-8 | The `descending: true` path evaluates the tail on the ascending view. |
