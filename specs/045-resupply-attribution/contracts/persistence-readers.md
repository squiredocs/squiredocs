# Contract — persistence readers added for resolution (`server/postgres-persistence.js`)

Two narrow READ-ONLY methods. No schema change, no write path, no change to any existing
method's signature or default behavior.

## `getUpdatePayloads(docGuid, clocks)`

```js
async getUpdatePayloads(docGuid, clocks /* number[] */) -> Array<{ clock, updateData: Uint8Array }>
```

```sql
SELECT clock, update_data FROM yjs_updates
 WHERE doc_guid = $1 AND clock = ANY($2::int[]) ORDER BY clock
```

- Payloads for the `via_sync` rows being resolved. Uses the `(doc_guid, clock)` primary key.
- Empty `clocks` ⇒ returns `[]` without querying.
- Deliberately NOT routed through `_queryUpdatesWithUsers`: no `users` join is needed, and the
  gap-retry budget of the shared choke point exists for log REBUILDS. Resolution is not a
  rebuild — a missing row simply means one target stays unresolved, which is honest.

## `getDirectAttributedRows(docGuid, { afterClock, beforeClock, limit })`

```js
async getDirectAttributedRows(docGuid, opts) -> Array<{ clock, userId, agentName, updateData }>
```

```sql
SELECT clock, user_id, agent_name, update_data FROM yjs_updates
 WHERE doc_guid = $1
   AND clock > $2 AND clock < $3
   AND (via_sync IS NOT TRUE)     -- NULL and false are both "not known to be sync" (038)
   AND user_id IS NOT NULL
 ORDER BY clock ASC
 LIMIT $4
```

- The evidence batch reader. `afterClock` is the fold's high-water mark (exclusive),
  `beforeClock` the highest target clock (exclusive — evidence is strictly prior, R2).
- `via_sync IS NOT TRUE` is the exact 038 read rule: only `true` means sync; `NULL` and
  `false` are identical and are never treated as suspicious.
- Ordered ascending so the caller's single-pass fold can snapshot targets in clock order.

## `getUserDisplayFields(userIds)`

```js
async getUserDisplayFields(ids /* string[] */) -> Map<userId, { userName, userEmail, userPicture }>
```

```sql
SELECT id, name, email, picture FROM users WHERE id = ANY($1::uuid[])
```

- Called only for resolved user ids that are absent from the caller's already-fetched rows
  (the timeline never needs it; the drill-down and recent-100 windows can).
- A missing id is the deleted-account signal (RBD-045-11) and renders `UNKNOWN_AUTHOR`.

## Reader interface used by the resolver

```js
{ getUpdatePayloads, getDirectAttributedRows, getUserDisplayFields }
```

`PostgresPersistence` satisfies it; tests may pass a fake. The resolver depends on this
interface only — never on a pool, never on `pg`.
