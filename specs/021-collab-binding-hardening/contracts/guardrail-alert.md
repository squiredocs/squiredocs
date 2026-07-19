# Contract: Server Guardrail Alert (`server/collab-guardrail.js`)

Detection, never prevention (FR-011). Evaluation is asynchronous, post-persist,
best-effort (RBD-4).

## Trigger

Called fire-and-forget from the bindState persistence listener in `server/index.js`
(after `storeUpdate`'s promise resolves; failure of evaluation is caught, logged, and
swallowed — it can never affect, delay, or fail persistence or broadcast):

```js
evaluateUpdate({ docGuid, update, userId, agentName })
```

Preconditions checked inside the module (cheap-first ordering):

1. **Human-attributed only** (RBD-2): `userId` truthy AND `agentName` falsy — else return.
2. `Y.decodeUpdate(update).ds` non-empty — else return (no deletions; no DB work).

## Matching algorithm (research R6)

1. Fetch agent rows for the doc younger than the freshness window:
   `SELECT clock, agent_name, created_at, update_data FROM yjs_updates WHERE doc_guid = $1
   AND agent_name IS NOT NULL AND created_at > now() - ($2 * interval '1 second')`.
2. For each row, `Y.decodeUpdate(row.update_data).structs` → inserted item ID ranges
   `(id.client, id.clock, length)`. Intersect against the human update's delete-set ranges
   (`ds.clients: Map<clientID, {clock, len}[]>`). **Yjs item-ID clocks and
   `yjs_updates.clock` are different spaces — never conflated**; intersection happens in
   Yjs-ID space, the alert reports the matched rows' DB clock range.
3. Any overlap ⇒ match.

## Alert (FR-009, FR-010)

`notifyException(error, { source: 'collab-guardrail', extra })` (existing channel/idiom —
`server/exception-notifier.js`, cf. `server/index.js:298`), where `extra` carries:

| Field | Meaning |
|-------|---------|
| `docGuid` | the document |
| `humanUserId` | whose identity the deleting update rode |
| `agentName` (+ `agentUserId` when present) | whose content was deleted |
| `agentClockRange` | `[minClock, maxClock]` of matched agent rows (DB clock space — feature-016 invertible) |
| `overlappedItemRanges` | matched Yjs ID ranges (forensics) |
| `suppressedSinceLastAlert` | count of matches suppressed since the last fired alert for this (doc, user) |

## Suppression (FR-012, RBD-1)

- Keyed by `(docGuid, humanUserId)`; window `GUARDRAIL_SUPPRESSION_MS` (default 5 min).
- First match pages; further matches for the same pair within the window increment
  `suppressedCount` (logged at debug level, not paged); the next fired alert carries the
  count. Different docs/humans alert independently.

## Non-negotiables (test-enforced)

- The update is stored and broadcast **exactly as today** whether or not the guardrail
  matches, throws, or is misconfigured (FR-011). Test: evaluation stubbed to throw ⇒
  persistence and broadcast unaffected, error logged.
- No alert for: agent-attributed deleters (RBD-2); human deletion of agent content older
  than the window (US2 scenario 3); human updates with empty delete sets; normal human
  editing.
- Env: `GUARDRAIL_FRESHNESS_SECONDS` (default 10), `GUARDRAIL_SUPPRESSION_MS`
  (default 300000).
- Independent of the client kill-switch: active regardless of
  `app_settings.collab_binding_hardening` (DR-2).
