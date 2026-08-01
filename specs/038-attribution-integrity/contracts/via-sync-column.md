# Contract: the `via_sync` channel marker

`yjs_updates.via_sync` — nullable boolean channel metadata on history rows.
Design basis: `design/collaboration-core.md` amendment "reconnect re-supply is sync, not
authorship" (Sam, 2026-08-01).

## The rule of thumb (FR-015)

> A `via_sync` row proves the content reached the server **through** that client,
> never that the client **wrote** it.

Attribution (`user_id`, `agent_name`) on a flagged row is unchanged and still correct as
*transport* attribution; a genuine offline edit synced on reconnect remains that user's
work and stays attributed to them. The marker records the **channel**, not a verdict on
authorship.

## Producer contract (write side)

- Set `true` exactly for rows whose update was produced during the synchronous
  application of a `SYNC_STEP2` frame on the originating connection (FR-011).
- The flag's lifetime is one frame application: set immediately before the frame is
  handed to protocol processing, cleared in a `finally` immediately after (a throw cannot
  leave it stuck). Interleaved live updates on the same connection are never flagged;
  updates from other connections carry different origin objects and cannot see the flag.
- Sentinel-origin updates (db-load, redis, sync-push, inverse-apply, restore) are skipped
  before any flag read — server-side paths can never produce flagged rows.
- All other writers leave the column `NULL` (writing explicit `false` is permitted for
  future positive-assertion paths, never required — D5).
- **Synchronicity assumption (documented at the flag site)**: frame application is fully
  synchronous (message dispatch → `readSyncMessage` → `readSyncStep2` → `Y.applyUpdate`
  → doc `update` listeners). If the sync library ever defers application, this scoping
  must be revisited.

## Consumer contract (read side)

Uniform read rule: **only `true` means sync**; `null` and `false` are identical
("not known to be sync") — never treat `null` as suspicious (D1/D5). No backfill exists;
all pre-feature rows read `null`.

| Consumer | Obligation |
|---|---|
| Log-derived undo (`server/undo/legacy.js`) | A `viaSync === true` row is **not** the acting identity's authored work: it breaks a contiguous identity run exactly like a foreign user's row (D2). Never transparently skip a flagged row to stitch two runs. An all-flagged candidate window yields the honest refusal ("nothing to undo"). Undo never inverts content the identity merely relayed (SC-004). |
| Collab guardrail (`server/collab-guardrail.js`) | When the triggering update was sync-sourced, annotate the match log line and the page's extra payload (`syncSourced: true`). Annotation NEVER changes whether a page fires (D3, SC-005). |
| Version history / timeline | No behavior change in this feature (rows merely carry the field). Author display is feature-040 scope. |
| Diff subsystem | Out of scope here — feature 039 owns it, including any diff-side consumption of `via_sync`. |
| Any future consumer | Apply the rule of thumb above; treat `null` ≡ `false`. |

## Where the contract is documented in code (FR-015)

1. `server/postgres-persistence.js` — on the `via_sync` column mapping/INSERT
   (the persistence module log-consumers read).
2. `server/index.js` — at the step2 flag site (with the synchronicity assumption).
