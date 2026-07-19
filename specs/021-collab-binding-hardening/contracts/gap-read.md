# Contract: Gap-Tolerant `getYDoc` (`server/postgres-persistence.js`)

Single choke point: every log-rebuild reader (version history, diffs, exports, MCP
`read_document`, `getDiff`/bindState) funnels through `getYDoc` — fixing here covers all
(verified, research R7).

## Behavior

1. Row query selects `clock, update_data` (today: `update_data` only), still
   `ORDER BY clock ASC`.
2. **Detection** (FR-013): one pass over fetched rows; gap ⇔ `rows[i].clock !==
   rows[i-1].clock + 1`. Contiguity is judged only **within** the fetched rows — no
   assumption about the first clock value (head-of-history edge case). Empty and single-row
   results are trivially gap-free.
3. **Retry** (FR-014, RBD-5): on gap, wait then re-run the **full** fetch, up to
   `COLLAB_READ_GAP_RETRIES` times (default 2) with waits from
   `COLLAB_READ_GAP_RETRY_DELAYS_MS` (default `100,300`). First gap-free fetch is built and
   returned immediately. The budget is bounded regardless of how many gaps exist (never
   compounds per-gap; spec edge case "multiple gaps / large gap").
4. **Serve-as-is** (FR-015): still gapped after the budget ⇒ build from the rows in hand and
   return — never an error, never an unbounded wait (append-only log; the next read heals).
   Log one structured line: `[Postgres] getYDoc <docGuid>: served with clock gap
   (retries=<n>, rows=<count>, firstGapAfterClock=<k>)`.
5. **Hot path unchanged** (FR-016): gap-free reads take zero retries, zero waits; added cost
   is the single integer-compare pass over rows already in memory. Existing perf log line
   preserved.

## Test obligations (backend jest, serial)

| Test | Asserts |
|------|---------|
| gap heals within window | store clocks `…k, k+2…` (withhold `k+1`); read; release `k+1` during the retry window ⇒ returned doc is the complete one |
| gap persists past window | keep `k+1` withheld ⇒ read returns (as-is) within the bounded budget — no hang, no throw — and the gapped-serve log line is emitted |
| gap-free fast path | contiguous rows ⇒ no retry, no timer, result identical to today |
| head-of-history | rows starting at clock 5 contiguous 5..n ⇒ no gap detected |
| multiple gaps | two gaps ⇒ same single retry budget (waits not doubled) |
| empty / single row | zero added behavior |

Timing-sensitive tests must drive the retry waits via the env knobs (small values), not
wall-clock sleeps at defaults.
