# Data Model — 021-collab-binding-hardening

Minimal by design: **no schema migrations**. One new key in an existing table, two in-memory
structures, one transient wire payload.

## Existing tables (read-only / reused)

### `yjs_updates` (read-only for this feature)

| Column | Use here |
|--------|----------|
| `doc_guid` | guardrail + gap-read scoping |
| `clock` | gap detection (contiguity within fetched rows); guardrail alert's "affected clock range". **DB clock space — distinct from Yjs item-ID clocks** |
| `update_data` | `Y.decodeUpdate` → insert struct ID ranges (guardrail) / doc rebuild (gap read) |
| `user_id`, `agent_name` | attribution classification: human-attributed = `user_id` set AND `agent_name` NULL (RBD-2); agent-created = `agent_name` NOT NULL |
| `created_at` | freshness window predicate (default 10 s) |

### `app_settings` (one new row, existing table — no migration)

| Key | Values | Meaning |
|-----|--------|---------|
| `collab_binding_hardening` | absent \| `'true'` \| `'false'` | absent/`'true'` = patch behaviors ON (default); `'false'` = kill-switch engaged, binding reverts to stock. Admin-editable; cache-coherent via `setSetting` |

## In-memory structures

### Binding skip registry (client, per binding instance)

- `skippedTypes: Set<Y.AbstractType>` — Y children currently unrenderable in this instance;
  rebuilt each Yjs→view render pass (fail ⇒ add, success ⇒ remove). Consulted by the patched
  `updateYFragment`: members are invisible to the PM→Y diff (never deleted, never counted).
- `standIns: Map<Y.AbstractType, PMNode>` — createAndFill stand-ins paired with their Y
  element; the pair is diff-excluded together.
- `loggedFailures: Set<elementKey>` — once-per-element-per-instance log/report bounding
  (RBD-6). Cleared on binding destroy (editor recreation re-logs by design).

### Guardrail suppression map (server, module-level)

- `Map<"docGuid:userId", { firstAlertAt, suppressedCount }>` — entries expire after
  `GUARDRAIL_SUPPRESSION_MS` (default 5 min). Not persisted; restart loses suppression state
  (worst case: one extra page — accepted, research R6).

## Transient wire payloads (contracts/ hold field-level detail)

- **Client config** (`GET /api/client-config`): `{ collabBindingHardening: boolean }`.
- **Skip report** (`POST /api/collab/render-skip-report`):
  `{ docId, bindingVersion, events: [{ nodeType, errorName, count }] }` — content-free by
  construction (names/classes/counts only, never document text or attrs).
- **Guardrail alert** (exception-notifier `extra`): `{ docGuid, humanUserId, agentName,
  agentClockRange: [min, max], overlappedItemRanges, suppressedSinceLastAlert }`.

## Environment configuration (all optional, defaults in code)

| Var | Default | Governs |
|-----|---------|---------|
| `GUARDRAIL_FRESHNESS_SECONDS` | `10` | FR-009 freshness window |
| `GUARDRAIL_SUPPRESSION_MS` | `300000` | FR-012 / RBD-1 suppression window |
| `COLLAB_READ_GAP_RETRIES` | `2` | FR-014 / RBD-5 retry count |
| `COLLAB_READ_GAP_RETRY_DELAYS_MS` | `100,300` | FR-014 / RBD-5 retry waits |
