# Phase 1 Data Model — Per-User Chat Model Override (035)

One nullable column. No new table, no index, no constraint, no backfill.

## `users` delta

| Column | Type | Null | Default | Notes |
|---|---|---|---|---|
| `chat_model_override` | `text` | YES | none (NULL) | A model key from the code-side registry (`MODEL_DEFS[].key`), e.g. `claude-sonnet-5`, `or-kimi-k2.6`. NULL = follow the shared default **dynamically**. |

**Migration**: `migrations/1799500000000_add-chat-model-override-to-users.js`

- `up`: `pgm.addColumns('users', { chat_model_override: { type: 'text', notNull: false } })`
- `down`: `pgm.dropColumns('users', ['chat_model_override'])`
- Timestamp `1799500000000` > `1799400000000` (`add-auth-ip-capture`, current latest), satisfying
  node-pg-migrate `checkOrder`, and trivially above the stale `>1795000000000` rolled-back-008 floor.
- **No backfill.** Existing rows get NULL by definition of `ADD COLUMN` without a default, which is
  exactly the required post-deploy state (FR-001, US2 acceptance 4): every account behaves as before.
- **No CHECK constraint / enum / FK** — see research R2 (legal values are a code-side, deployment-dependent
  registry).
- **No index** — the column is only ever read on a row already being fetched by primary key.

**Lifecycle**: the column lives and dies with the user row (no FK of its own, so account deletion removes
it with the account — spec Edge Cases, "User deletion").

## States

| Stored value | Eligible now? | What the user's next shared-path turn uses | What the admin sees |
|---|---|---|---|
| `NULL` | n/a | `resolveSharedDefaultKey(sharedDefault)` — dynamic | `Default (<shared effective label>)` selected |
| `'claude-sonnet-5'` | yes | `claude-sonnet-5` | that model selected in the picker |
| `'or-glm-5'` | no (provider key withdrawn) | `resolveSharedDefaultKey(...)` + one warning log per turn | `or-glm-5 (unavailable — using <shared effective label>)`, disabled option, selected |
| `'ghost-model'` | no (unknown key, e.g. removed in a later release) | `resolveSharedDefaultKey(...)` + one warning log per turn | same "unavailable" rendering |

Two rules make the table complete:

- **Ineligible is never persisted away** (RBD-2): eligibility is evaluated *per turn*, so if the provider
  key returns, the override resumes with no admin action.
- **Ineligible never fails a chat** (FR-006/SC-004): the fallback is the existing shared-default
  resolution, which itself terminates at `DEFAULT_MODEL_KEY`.

## Transitions

| From | Action | To | Effect timing |
|---|---|---|---|
| `NULL` | admin `PATCH { modelKey: 'x' }` (x eligible) | `'x'` | user's **next** turn (in-flight turns finish on their original model) |
| `'x'` | admin `PATCH { modelKey: 'y' }` (y eligible) | `'y'` | next turn |
| `'x'` | admin `PATCH { modelKey: null }` | `NULL` | next turn — rejoins the shared default **as it is at that moment**, not as it was when the override was set (US2 acceptance 3 / SC-003) |
| `'x'` | admin `PATCH { modelKey: 'z' }` (z unknown or ineligible) | unchanged `'x'` | none — `400`, nothing stored (FR-007) |
| any | deployment loses the provider's shared key | unchanged | resolution falls back per turn; value retained |
| any | user row deleted | gone with the row | n/a |

Concurrent admin edits: last write wins (single `UPDATE … RETURNING`); the response carries the stored
state so the UI can reconcile (spec Edge Cases).

## Related entities (unchanged by this feature)

- **Model registry entry** (`MODEL_DEFS` in `server/api/chat-models.js`) — `{ key, provider, modelId, label,
  pricing, contextWindow, supportsImages }`. The override stores **only** the key; label, provider grouping,
  and pricing are always read live from the registry, never copied onto the user row.
- **Shared default setting** (`app_settings` row, read via `appSettings.getSharedDefaultModel()`) — untouched;
  the override slots immediately above it in precedence.
- **BYOK columns on `users`** (`byok_enabled`, `byok_model_key`, per-provider key columns) — untouched. They
  are read by the same per-turn `SELECT` that now also returns `chat_model_override`, and they continue to win
  outright when BYOK is active (FR-003).
- **Metering** (`ai_usage_log`, credits, quotas) — untouched. An overridden turn is an ordinary shared-key
  turn priced from the *resolved* model's registry pricing (FR-014).
