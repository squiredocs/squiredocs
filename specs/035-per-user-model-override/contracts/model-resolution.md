# Contract — Model resolution with a per-user override (035)

Module seams touched on the serving path. Three files, four small edits. Line numbers are
indicative (`chat-models.js` is under concurrent registry edits) — **re-read before editing**.

---

## C1 — `resolveUserChatModelKey(overrideKey, sharedDefaultKey)` — NEW

**File**: `server/api/chat-models.js` (place immediately after `resolveSharedDefaultKey`, before
`resolveChatModel`, so the file reads in precedence order.)

```js
/**
 * Resolve the model KEY for a shared-key (non-BYOK) turn, honoring an admin-set
 * per-user override (feature 035):
 *   1. users.chat_model_override — when it is shared-eligible.
 *   2. resolveSharedDefaultKey(sharedDefaultKey) — the existing chain
 *      (app_settings → AI_CHAT_MODEL → DEFAULT_MODEL_KEY).
 *
 * An override that is unknown or currently ineligible (its provider lost its shared
 * server key) is SKIPPED with a warning and the turn proceeds on the shared default —
 * a stale override never fails a chat (FR-006). The stored value is deliberately NOT
 * cleared here: eligibility is re-evaluated every turn, so a temporarily-withdrawn
 * provider key resumes the override automatically once restored (RBD-2).
 *
 * @param {string} [overrideKey]      users.chat_model_override (may be null/undefined).
 * @param {string} [sharedDefaultKey] Admin-selected shared default from app_settings.
 * @returns {string} The resolved model key.
 */
function resolveUserChatModelKey(overrideKey, sharedDefaultKey) { … }
```

**Behavior table** (exhaustive):

| `overrideKey` | `isSharedEligible(overrideKey)` | returns | logs |
|---|---|---|---|
| falsy (`null` / `undefined` / `''`) | n/a | `resolveSharedDefaultKey(sharedDefaultKey)` | nothing new |
| known key, provider has server key | `true` | `overrideKey` | nothing |
| known key, provider has **no** server key | `false` | `resolveSharedDefaultKey(sharedDefaultKey)` | one `console.warn` naming the key and the reason |
| unknown key | `false` | `resolveSharedDefaultKey(sharedDefaultKey)` | one `console.warn` |

Called once per turn on the serving path → at most one warning per turn (FR-006). The admin
API also calls it (to compute `effectiveModelKey`); a warning there is operator-relevant and
harmless.

**Purity**: no I/O, no DB, no provider instantiation — unit-testable without mocks.

---

## C2 — `resolveChatModel` gains `userOverrideKey` — EDIT

**File**: `server/api/chat-models.js` (~388)

```diff
-function resolveChatModel({ isByok, byokSettings, decryptKey, sharedDefaultKey }) {
+function resolveChatModel({ isByok, byokSettings, decryptKey, sharedDefaultKey, userOverrideKey }) {
   if (isByok && byokSettings) {
     …unchanged BYOK branch, including the byok_misconfigured return…
   }

-  const modelKey = resolveSharedDefaultKey(sharedDefaultKey);
+  const modelKey = resolveUserChatModelKey(userOverrideKey, sharedDefaultKey);
   const resolved = resolveModel(modelKey);
   …unchanged…
 }
```

**Contract guarantees**:

- `userOverrideKey` is **optional**. Omitting it reproduces today's behavior exactly, so every
  existing caller and test keeps passing unchanged (`chat-models-byok.test.js`,
  `chat-models.test.js`, `chat.durable-failures.test.js`).
- The BYOK branch is **not modified**. Both BYOK invariants therefore hold structurally:
  - active BYOK returns the user's model+key before the override is ever consulted (FR-003, US3-1);
  - `{ error: 'byok_misconfigured' }` returns from inside that branch — it can never fall through
    to the override or the shared default (FR-003, US3-2). Note this branch is entered on
    `isByok` = the caller's *byokEnabled* (intent), which is why a misconfigured BYOK user with a
    stored override still errors rather than silently running on the operator's key.
- Return type is unchanged: `{ model, def, provider } | { error: 'byok_misconfigured', provider } | null`.

**Export delta**: add `resolveUserChatModelKey` **and** `isSharedEligible` to `module.exports`
(the latter so the admin write-time validation and the resolution-time fallback are the same
predicate — FR-005).

---

## C3 — `loadByokSettings` returns the override column — EDIT

**File**: `server/api/byok-settings.js` (~155)

```diff
 async function loadByokSettings(userId) {
-  const columns = ['byok_enabled', 'byok_model_key', ...listProviders().map((p) => p.keyColumn)];
+  // This is the per-turn user-settings row for a chat turn, not just BYOK state:
+  // chat_model_override (feature 035) rides the same SELECT so an admin's change
+  // applies on the user's very next turn with no cache and no re-login (FR-012).
+  // NOTE: buildResponse() below builds an explicit key set — the override must never
+  // be added to it (FR-011: the user it applies to must not learn it exists).
+  const columns = ['byok_enabled', 'byok_model_key', 'chat_model_override',
+    ...listProviders().map((p) => p.keyColumn)];
```

**Guarantees**:

- No extra query, no extra round trip per turn.
- `buildResponse(row)` is **unchanged** and must stay an explicit literal; the returned
  `GET/PUT /api/settings/byok` payload keys remain exactly
  `{ enabled, providers, modelKey, models, <providerId>: { hasKey } … }`.
- `isByokActive(settings)` is unchanged and ignores the new column.

---

## C4 — The single call site — EDIT

**File**: `server/api/chat.js` (~860)

```diff
     const resolved = chatModels.resolveChatModel({
       isByok: byokEnabled,
       byokSettings,
       decryptKey: decrypt,
       sharedDefaultKey: appSettings.getSharedDefaultModel(),
+      // Feature 035 — admin-set per-user pin; NULL for everyone by default. Read from
+      // the same per-turn row as BYOK state, so a set/clear lands on the next turn.
+      userOverrideKey: byokSettings?.chat_model_override || null,
     });
```

`byokSettings` may legitimately be `null` (no pool, or user row missing) — optional chaining
plus `|| null` keeps that path identical to today's.

**Not touched anywhere**: `getCompactionModel`, `getContextualizerModel`,
`getThinkingSummaryModels` (FR-013 — auxiliary models stay separately fixed), metering
(`aiUsage.recordUsage` prices from `def` = the *resolved* model, so FR-014 holds for free),
quota checks, and the image-support pre-flight (it reads `def.supportsImages` of whatever was
resolved, so an override onto a text-only model produces the existing honest
`model_no_image_support` error rather than a crash).

---

## Test obligations for this contract

| Assertion | Requirement | Where |
|---|---|---|
| Eligible override beats the shared default | FR-002, US1-1 | `server/api/__tests__/chat-model-override.test.js` |
| No override → shared default, and follows it when the shared default changes | FR-004, US2-1 | same |
| Ineligible override (provider key withdrawn) → shared default + warn; value not mutated | FR-006, US3-3 | same |
| Unknown override key → shared default + warn | FR-006 | same |
| Override equal to the shared default is honored (pinned, not "no-op") | Edge case | same |
| **BYOK active wins over a stored override** | FR-003, US3-1 | same (explicit test) |
| **`byok_misconfigured` never falls back to the override or shared key** | FR-003, US3-2 | same (explicit test) |
| Omitting `userOverrideKey` reproduces prior behavior | regression | same |
| `chat.js` passes the stored override into `resolveChatModel` | FR-012 wiring | `server/__tests__/chat-model-override-wiring.test.js` |
| The user-facing BYOK payload never carries the override | FR-011, SC-005 | `server/__tests__/byok-settings.test.js` |
