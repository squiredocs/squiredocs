# Phase 1 Data Model — 026-openrouter-shared-models

No database schema change (FR-010): no new tables, columns, or migrations. The only persisted state
is the pre-existing shared-default-model app_settings row (migration `1789000000000`). The "entities"
below are in-memory registry/config structures and one persisted setting.

## E1 — Model registry entry (`MODEL_DEFS` in `server/api/chat-models.js`)

Ordinary registry object; gateway entries are structurally identical to every other entry.

| Field | Type | Notes |
|-------|------|-------|
| `key` | string | Stable app-internal key (e.g. `or-glm-5`, and NEW: `kimi-k3`/`qwen3.7-max`/`qwen3.7-plus`/`minimax-m3` — final keys chosen at authoring, prefixing convention consistent with `or-glm-*` may apply). Persisted as the shared-default setting and BYOK choice; **must be stable forever**. |
| `provider` | string | `'openrouter'` for all new gateway entries. |
| `modelId` | string | Namespaced OpenRouter id verbatim from the catalog: `moonshotai/kimi-k3`, `qwen/qwen3.7-max`, `qwen/qwen3.7-plus`, `minimax/minimax-m3`. |
| `label` | string | Human label shown in pickers (family name, e.g. `Kimi K3`). |
| `pricing.input` | number | Cents per 1M input tokens — authoring-time snapshot = USD-per-token × 10^8. |
| `pricing.output` | number | Cents per 1M output tokens — same conversion. |
| `contextWindow` | number | From catalog `context_length`. |
| `supportsImages` | boolean (optional) | Set `true` **only** when catalog declares `image` input AND live round-trip verified (D5); otherwise omit → derives text-only from `VISION_PROVIDERS` (openrouter not a member). Default action at plan time: ship text-only (no funded key to verify). |

**Validation rules**:
- Pricing/context are authoring-time snapshots from `https://openrouter.ai/api/v1/models`
  (unauthenticated), annotated with the read date in the block comment.
- New entries MUST NOT duplicate GLM (already covered by `or-glm-*`).
- `supportsImages` fails closed (text-only unless verified).

**Mutations this feature makes**:
- ADD 4 curated entries (Kimi/Qwen×2/MiniMax) per D1.
- UPDATE `or-glm-4.6/4.7/5/5.2` pricing + context from the same catalog read (FR-009/D3); refresh the
  authoring-date comment.

## E2 — Provider configuration (`PROVIDERS.openrouter` in `server/api/ai-providers.js`)

| Field | Before | After |
|-------|--------|-------|
| `serverKeyEnv` | `null` | `'OPENROUTER_API_KEY'` (**the only functional change** — flips shared eligibility) |
| block comments | "no shared key / never a shared default / default client never used" | rewritten to describe shared-gateway reality (FR-001) |
| all other fields (`defaultClient`, `createClient`, `validateKey`, `buildWebSearch`, `classifyError`, `capabilities`) | — | **unchanged** |

`hasServerKey('openrouter')` becomes `true` exactly when `process.env.OPENROUTER_API_KEY` is set —
the sole shared-eligibility signal. z.ai's `serverKeyEnv: null` is unchanged (stays BYOK-only).

## E3 — Shared default model setting (persisted, `app_settings`)

- Existing single-row setting (`getSharedDefaultModel` / `setSharedDefaultModel` in `app-settings.js`).
- **No schema change.** Value is a `MODEL_DEFS.key` string or `null`.
- **Resolution order (non-BYOK)**: stored default (if its provider `hasServerKey`) → `AI_CHAT_MODEL`
  env → `DEFAULT_MODEL_KEY` (`claude-opus`). The eligibility guard on the stored value is the FR-005
  behavior change (see research R4); the persisted shape is untouched.

## E4 — Resolution state transitions (FR-005 / D4)

Non-BYOK model resolution, given a stored shared-default key `S`:

| State of `S` | `hasServerKey(provider(S))` | Effective key (serving **and** admin display) |
|--------------|------------------------------|-----------------------------------------------|
| null / unset | — | `AI_CHAT_MODEL` else `DEFAULT_MODEL_KEY` |
| known, eligible | true | `S` |
| known, provider lost server key (e.g. OPENROUTER_API_KEY removed) | false | `AI_CHAT_MODEL` else `DEFAULT_MODEL_KEY` + logged warning |
| unknown key (removed in a later release) | false (no def) | `AI_CHAT_MODEL` else `DEFAULT_MODEL_KEY` + logged warning |

BYOK resolution is a separate, untouched path: BYOK-on-but-unresolvable → `byok_misconfigured` (never
enters E4, never falls back to a shared/operator key).

## E5 — Admin shared-model API response shape (in-memory contract, see contracts/)

Additive field for provider grouping (D2). See [contracts/admin-shared-model.md](./contracts/admin-shared-model.md).

| Field | Type | Change |
|-------|------|--------|
| `modelKey` | string \| null | unchanged (stored key) |
| `effectiveModelKey` | string | now reflects FR-005 degradation (true fallback in use) |
| `models` | array of `{ key, label, provider, modelId, supportsImages }` | unchanged shape; list grows with the new eligible entries |
| `providers` | array of `{ id, label }` | **NEW (additive)** — eligible providers for `<optgroup>` grouping |
