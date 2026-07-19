# Data Model: Version History Hardening (023)

Delta-model: only entities this feature touches. Ground truth for semantics:
spec.md Key Entities + research.md R1/R3/R6/R7/R9.

## 1. Update log row — `yjs_updates` (modified)

| Column | Type | Change | Semantics |
|---|---|---|---|
| doc_guid | uuid | — | document key |
| clock | integer | **semantics hardened** | per-doc monotonic version coordinate; after 023, clock order = causal order by construction (R1). Uniqueness: existing PK/unique (doc_guid, clock) retained as the mixed-window backstop. |
| update_data | bytea | — | Yjs update payload |
| user_id / agent_name / on_behalf_of | uuid / text / jsonb | — | attribution (unchanged) |
| created_at | timestamptz | — | |
| **meaningful** | **boolean NULL** | **NEW (migration 1799000000000)** | Write-time classification: does this update change `extractXml` output? `true` = meaningful, `false` = noise (CRDT bookkeeping), **`NULL` = unknown ⇒ every reader treats as meaningful** (D-3 fail-visible). Written by storeUpdate's new option; never blocks persistence (classification failure ⇒ NULL, FR-018). |

**Validation / invariants**
- Causally ordered same-stream updates have strictly increasing clocks (FR-001/002);
  enforcement is mechanism (queue + advisory lock), not schema.
- `meaningful` has no default and no NOT NULL — old pods during the rollout window
  write NULL legally (D-8).
- Backfill (server/scripts/backfill-meaningful-classification.js) only ever writes
  where `meaningful IS NULL`; idempotent, resumable, gap-aware (R5).

## 2. Named version — `document_versions` (modified)

| Column | Change |
|---|---|
| id, doc_id, name, clock_start, clock_end, created_by, created_at | preserved — the label IS the version (FR-013) |
| **snapshot_data** | **DROPPED (migration 1799100000000)** — no content blob exists anywhere; content = replay of `yjs_updates` to `clock_end` under the gap-tolerant read path (FR-011/012). Pre-023 diverged blobs heal silently to replayed truth (D-6). |

**State transitions**: none — a named version is immutable except `name`
(rename), and creation no longer performs any read of the log (pure INSERT).

## 3. Edit record — `agent_edits` (usage extended, schema unchanged)

No migration. New writer: `restoreVersion` records one row per restore (FR-020).

| Field | Restore-row value |
|---|---|
| doc_guid | restored document |
| user_id | performing user (both surfaces) |
| agent_name | acting agent name (MCP/chat restore) or **`''` (empty string) for a human UI restore** — the column is `text NOT NULL`; `''` is the canonical "no agent" identity value (D-4, R7). Identity queries (`agent_name = $3`) and the identity-unique constraint work unchanged. |
| edit_clock_start / edit_clock_end | `newClock` / `newClock` (the restore's single persisted row, FR-024) |
| undo_target_start/end, undo_target_clocks | `newClock` / `newClock` / `[newClock]` |
| state | `'active'` |

Undo/redo transitions are unchanged 016 semantics; a restore row is an ordinary
member of the chain (FR-021). Which identities each undo surface targets remains
016 scoping (D-4).

## 4. State-vector row — `yjs_state_vectors` (DELETED)

Table dropped (migration 1799200000000). Writer sites removed (FR-026):
`storeUpdate` first-update branch, `clearDocument`, `clearAll`, onboarding
welcome-doc reset. No reader ever existed; document birth = first `yjs_updates`
row only.

## 5. Version timeline (derived view — no storage)

Pure function of stored rows after 023:
`getUpdatesWithUsers` rows (now carrying `meaningful`) → filter
`meaningful !== false` → group by inactivity (thresholds unchanged) → merge
named-version labels. No content replay, no per-update serialization (FR-016);
all-noise ranges produce no version (FR-019); `totalEdits` = filtered row count.

## 6. In-process structures (non-persistent)

- **Per-doc write queue** (`PostgresPersistence`): `Map<docGuid, Promise>` tail
  chain; entry removed when tail settles; rejected slots do not break the chain
  (D-9). Not shared cross-instance by design (R1 documents the honest story).
- **Advisory lock key**: `pg_advisory_xact_lock(NS_023_CLOCK, hashtext(doc_guid))`
  with a fixed integer namespace constant; scope = transaction (auto-release).
- **Classification context** (`bindState`): last-known `extractXml` string per live
  ydoc (`ydoc._lastClassifiedXml`), initialized after DB load; uninitialized ⇒
  classify NULL (unknown).
- **Diff cache key** (Redis, unchanged shape `diffv8:{doc}:{prev}:{curr}`): a
  gapped computation is never written (FR-009/D-2); no cache-version bump needed —
  entries remain immutable-correct because they were only ever written gap-free
  after 023, and pre-023 entries expire on their existing TTL (3600s).
