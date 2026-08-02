# Contract — guardrail candidate widening (`server/collab-guardrail.js`, FR-011/FR-012)

## What changes

Exactly one query predicate, one classification step, and one additive alert field.

**Fresh-row query** (the block at `evaluateUpdate` step 3):

```sql
SELECT clock, agent_name, user_id, via_sync, created_at, update_data
  FROM yjs_updates
 WHERE doc_guid = $1
   AND (agent_name IS NOT NULL OR via_sync IS TRUE)     -- widened
   AND created_at > now() - ($2 * interval '1 second')
 ORDER BY clock
```

**Classification** of the returned rows, before the item-ID intersection:

| Row | Candidate | Note |
|---|---|---|
| `agent_name IS NOT NULL` | yes | existing path, untouched (the widening can only ADD rows) |
| `via_sync` + resolved origins include an agent identity | yes | sync-sourced candidate |
| `via_sync` + `unresolved` | yes | conservative inclusion, RBD-045-4 |
| `via_sync` + all origins resolve to humans | no | human content; not the guardrail's signature |

Resolution comes from the shared resolver (`resolveForRows`), so the guardrail and the
timeline can never disagree about a row. It runs only when the widened query actually returned
a `via_sync` row without an agent name — i.e. inside a live resupply window, and only after the
existing cheap-first guards (human-attributed trigger, non-empty delete set) have already
passed.

## What must NOT change (FR-012)

- **Alert-only, never blocks.** Called fire-and-forget after `storeUpdate` resolves; every
  internal failure is caught, logged, swallowed, and returns `null`. Resolution failures are
  swallowed the same way, and a swallowed resolution means the row is treated as unresolved,
  i.e. still a candidate — degradation never re-opens the blind spot.
- **Cheap-first ordering** (human-attributed only → non-empty delete set → pool present) is
  unchanged and still precedes any query or decode.
- **Item-ID intersection** semantics, `(docGuid, humanUserId)` suppression keying, the
  suppressed-count carry, and the `console.warn` "log every match" rule are unchanged.
- The existing trigger-level annotation (`syncSourced`, driven by the `viaSync` parameter of
  the TRIGGERING update) keeps its exact meaning and placement, so alerts that fire today are
  byte-identical.

## Additive alert fields

- `syncSourcedCandidates: true` in `notifyException` extras when at least one MATCHED row was
  a `via_sync` candidate (distinct from the trigger-level `syncSourced`).
- An unresolved sync candidate contributes the literal `unknown (sync-relayed)` to the
  `agentName` join, so the page never shows an empty agent field. Resolved sync candidates
  contribute their resolved agent name.
- `agentUserId` continues to be the first non-null `user_id` among matched rows; for a
  sync-sourced candidate that is the RELAYER's id, so it is reported as `relayedByUserId` when
  the matched row is sync-sourced rather than silently presented as the agent's user.

## Wiring

`init()` gains the persistence provider (`init(pool, persistence)` from `server/index.js`) so
the guardrail can call the resolver's reader interface. It keeps using the raw pool for its own
fresh-row query.
