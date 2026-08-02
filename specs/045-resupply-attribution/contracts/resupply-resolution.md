# Contract — forensic resupply resolution (`server/resupply-resolution.js`)

The ONE place that decides who authored the content in a `via_sync` row. Every display
surface and the guardrail consume its output; nothing implements a second copy (FR-007).

## Module surface

```js
// Resolve every via_sync row present in `rows`. Rows are the caller's ALREADY-FETCHED
// metadata rows (they carry viaSync, clock, userId, agentName and the users join).
// Returns a resolution context; callers thread it into the display helpers.
async function resolveForRows(reader, docGuid, rows) -> {
  outcomes: Map<number /*clock*/, { origins: [{userId, agentName}], unresolved: boolean }>,
  directory: Map<string /*userId*/, { userName, userEmail, userPicture }>,
}

// The empty context. Passing it (or nothing) makes every consumer behave exactly as
// it did before this feature — the pre-045 baseline is always one argument away.
const EMPTY_RESOLUTION;

// Test seams (FR-009 / SC-005).
function _stats() -> { evidenceRowsDecoded, targetRowsDecoded, evidenceQueries };
function _resetForTest();
```

`reader` is the narrow persistence interface (see `persistence-readers.md`), satisfied by
`PostgresPersistence`. The resolver never opens its own pool and never writes.

## Guarantees

1. **Cheap when nothing is relayed.** If no row in `rows` has `viaSync === true`, the call
   performs ZERO queries and ZERO decodes and returns `EMPTY_RESOLUTION`. This is the
   overwhelmingly common path.
2. **Compute once.** An outcome for `(docGuid, clock)` is computed at most once per process
   and memoized permanently (it is immutable — evidence is prior-only over an append-only
   log). A repeat request over already-resolved history performs zero payload decodes
   (SC-005).
3. **Deterministic.** Same row ⇒ same outcome, on every surface and every request. Origins
   are deduped and sorted so serialized output is byte-stable.
4. **Never guesses.** Ambiguity, absence, deletion-only payloads, and the evidence cap all
   produce `unresolved: true`. There is no "most recent wins" and no "most frequent wins".
5. **Never trusts the stamp.** A row's own `user_id`/`agent_name` are NOT evidence for that
   row and never enter its outcome.
6. **Display only.** The resolver has no write path, no cache invalidation hooks, and is
   imported by exactly: `server/version-history.js`, `server/mcp/tools/read-document.js`,
   `server/collab-guardrail.js` (FR-010 — enforced by test).

## Algorithm

```
targets := { r.clock | r ∈ rows, r.viaSync === true } \ memoized
if targets = ∅: return context built from memo + directory

payloads := reader.getUpdatePayloads(docGuid, targets)          // one query
for each target: originIds := parseUpdateMeta(payload).to.keys()
                 if originIds = ∅ → outcome {origins: [], unresolved: true}   // FR-005

needed := targets still needing evidence, ascending
scan direct rows ascending (batched, default 500) with clock < max(needed):
    evidence row ≡ via_sync IS NOT TRUE ∧ user_id IS NOT NULL
    fold clientID → (userId, agentName) | AMBIGUOUS      // see data-model §3
    when the scan passes a target's clock, snapshot that target's outcome
    stop at RESUPPLY_EVIDENCE_MAX_ROWS (default 20000) → remaining targets unresolved

memoize outcomes; build directory (rows first, then one batched users lookup)
```

Evidence-scan state (`byClient`, `scannedThroughClock`) is retained per document so later,
higher-clock targets extend the fold. A needed target BELOW `scannedThroughClock` (reachable
only after memo eviction) restarts the fold from the document's first row.

## Configuration

| Env | Default | Meaning |
|---|---|---|
| `RESUPPLY_EVIDENCE_MAX_ROWS` | 20000 | evidence rows decoded per document before honest refusal |
| `RESUPPLY_EVIDENCE_BATCH` | 500 | evidence rows per query |
| `RESUPPLY_CACHE_MAX_DOCS` | 100 | documents retained (insertion-order eviction) |
| `RESUPPLY_CACHE_MAX_OUTCOMES` | 5000 | memoized outcomes retained overall |

Caches are per process and in memory by design: outcomes are derivable from the durable log,
so eviction costs a recompute and never correctness. No Redis (042 removed the dormant Redis
doc cache; reintroducing one for this is ceremony).

## Failure posture

Any internal failure (decode error on one payload, evidence query error) is caught: the
affected target resolves `unresolved: true` and the surface renders the synced contribution.
Resolution NEVER throws into a display path and never prevents a timeline from rendering.
A payload that fails to decode is logged once with its clock.
