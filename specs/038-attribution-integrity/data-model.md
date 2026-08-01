# Data Model — 038-attribution-integrity

One schema change. Everything else in this feature is behavior on existing entities.

## `yjs_updates` (existing table — extended)

The append-only per-document update log; clock order is causal order (023). Existing
columns unchanged: `doc_guid`, `clock` (PK pair), `update_data`, `user_id`, `agent_name`,
`on_behalf_of`, `meaningful`, `created_at`.

### New column: `via_sync`

| Property | Value |
|---|---|
| Type | `boolean` |
| Nullable | yes (`notNull: false`) |
| Default | none (rows persist `NULL` unless the write path positively sets the flag) |
| Index | none (readers already fetch by `(doc_guid, clock)`) |
| Backfill | none (D1 — historical channel is indistinguishable; fabricating `false` would assert false certainty) |

### Value semantics (FR-009, D1/D5)

| Value | Meaning | Consumer obligation |
|---|---|---|
| `true` | The row's update originated from a `SYNC_STEP2` frame (a sync catch-up reply). Proves the content **reached the server through** the stamped client — never that the client wrote it. | Authorship-sensitive consumers discount it (undo: foreign to identity runs; guardrail: annotate). |
| `null` | Channel unknown — every pre-feature row, and any write path that does not positively identify a step2 source. | Treat identically to `false` ("not known to be sync"). Never interpret `null` as suspicious. |
| `false` | Permitted for future explicit-live paths; **not written** by this feature. | Same as `null`. Only `true` carries meaning. |

Attribution columns (`user_id`, `agent_name`) are **never** modified by this feature —
`via_sync` is additive channel metadata (FR-010).

### State transitions

None — rows are append-only and `via_sync` is written once at INSERT, never updated.

### Write rule (FR-011/FR-012)

`via_sync = true` iff the doc `update` event fired during the synchronous application of
a step2 frame on the originating connection (per-connection flag, set before protocol
processing, cleared in `finally`). Sentinel-origin updates (db-load, redis, sync-push,
inverse-apply, restore) are skipped by the persistence listener **before** any flag read,
so server-side paths can never be flagged.

## Migration

`migrations/1799700000000_add-via-sync-to-yjs-updates.js`

- **Timestamp**: `1799700000000` — strictly > current head `1799600000000` (FR-016) and
  > the `1795000000000` floor required by `script/migrate.js`'s phantom-008-row cleanup.
- **Up**: `pgm.addColumns('yjs_updates', { via_sync: { type: 'boolean', notNull: false } })`
- **Down**: `pgm.dropColumns('yjs_updates', ['via_sync'])` (reversible, FR-016)
- **Rolling-deploy safety**: old pods INSERT without the column ⇒ `NULL` ⇒ legal
  "unknown" (same pattern as `meaningful`, 023 D-8).
- **Slot ownership**: this is the feature's single migration and the repo's single
  in-flight migration slot; no other schema change ships concurrently.

## Derived/consumer entities (no schema change)

- **Update row JS shape** (`_mapUpdateRow`): gains `viaSync: row.via_sync ?? null`
  (`undefined`-safe when the column is unselected by legacy call sites).
- **Identity run** (undo `deriveLegacyRange` input rows): a row with `viaSync === true`
  is not an identity row — it breaks runs like a foreign user's row (D2).
- **Guardrail evaluation**: gains a boolean `viaSync` input and a `syncSourced`
  annotation on its warn line / notifier extra (D3; paging unchanged).
- **Connection edit capability** (in-memory, per WS connection): unchanged derivation
  (role ≥ editor, 60 s re-check, fail-closed); now gates step2 frames in addition to
  update frames.
