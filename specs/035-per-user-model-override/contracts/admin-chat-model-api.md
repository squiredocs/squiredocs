# Contract — Admin per-user chat-model API + UI (035)

Everything here sits under `app.use('/api/admin', requireAdmin, admin.router)`
(`server/index.js:511`). Admin-only is enforced by that mount, not by anything added here —
which is exactly why the authorization test must mount the router the same way (a bare-router
403 assertion is vacuous).

---

## A1 — `PATCH /api/admin/users/:userId/chat-model` — NEW

Set or clear one user's chat model override.

**Request body**

```json
{ "modelKey": "claude-sonnet-5" }   // set
{ "modelKey": null }                // clear → back to the dynamic shared default
```

**Validation** (in order; nothing is written unless all pass):

| Condition | Status | Body |
|---|---|---|
| `modelKey` is neither a string nor `null` (incl. absent/`undefined`) | `400` | `{ "error": "modelKey must be a model key string or null" }` |
| `modelKey` is a string with no `MODEL_DEFS` entry | `400` | `{ "error": "Unknown model: <key>" }` |
| known key whose provider has no shared server key | `400` | `{ "error": "Model \"<key>\" has no shared server key and can't be pinned for a user" }` |
| user id matches no row | `404` | `{ "error": "User not found" }` |
| query throws | `500` | `{ "error": "Failed to update chat model override" }` |

The two 400 branches are `isSharedEligible` decomposed for message clarity — the same
two-branch shape `PUT /settings/shared-model` (`admin.js` 70–80) already uses. A test asserts
the endpoint's accept/reject decision equals `isSharedEligible(key)` for **every** registry
entry, so the two spellings cannot drift (FR-005/FR-007).

**Write**

```sql
UPDATE users SET chat_model_override = $1 WHERE id = $2 RETURNING chat_model_override
```

Parameterized; last write wins (spec Edge Cases). No audit row (explicitly out of scope).

**Success `200`**

```json
{
  "chatModelOverride": "claude-sonnet-5",
  "effectiveModelKey": "claude-sonnet-5"
}
```

- `chatModelOverride` — the value as stored (`null` after a clear), so the UI reconciles against
  reality rather than its own optimistic state.
- `effectiveModelKey` — `resolveUserChatModelKey(stored, appSettings.getSharedDefaultModel())`:
  what this user's next shared-path turn will actually run on. After a clear it is the *current*
  shared default (SC-003).

**Authorization**: no in-handler check — `requireAdmin` on the mount rejects a signed-in
non-admin with `403` and an unauthenticated caller with `401`, before the handler runs and
before any read of the column (FR-008).

**Dormant-BYOK note**: the endpoint neither reads nor cares about the target user's BYOK state
(RBD-5/FR-015). Setting an override for a BYOK-active user succeeds and simply lies dormant.

---

## A2 — `GET /api/admin/users` response delta — EDIT

Add to the SELECT and to the row mapping:

```diff
-        u.signup_ip, u.signup_user_agent, u.last_login_ip, u.last_login_user_agent,
+        u.signup_ip, u.signup_user_agent, u.last_login_ip, u.last_login_user_agent,
+        -- Feature 035 — admin-only per-user model pin; NULL = follow the shared default.
+        u.chat_model_override,
```

```diff
       lastLoginUserAgent: r.last_login_user_agent,
+      chatModelOverride: r.chat_model_override,
```

`null` for every account that has never been pinned (which is all of them at deploy time —
US2 acceptance 4). No per-row `effectiveModelKey`: the client derives the effective label from
the shared-model payload it already holds (research R4 / RBD-12).

**Exposure boundary**: this is the *only* read surface for the value outside the chat path.
`GET /auth/me` is a fixed field whitelist (pinned by 034's test) and cannot carry it;
`GET /api/settings/byok` builds an explicit literal and must not carry it (contract C3).

---

## A3 — Admin UI: the per-user picker — EDIT

**File**: `client/src/pages/AdminPage.jsx`, inside the existing expanded detail row
(`isExpanded && (…)`, ~462), as its own `admin-detail-section` — placed after the "Trusted"
toggle and before "Sign-in origin" (a routing control belongs with the other per-user
settings, above the read-only forensics).

**Data sources** (both already loaded — no new fetch):

- `sharedModel` (page state from `GET /api/admin/settings/shared-model`): `.models`,
  `.providers`, `.effectiveModelKey`; `modelLabel(sharedModel, key)` already exists (~122).
- `u.chatModelOverride` from the users list row.

**Markup** (mirrors the shared-default picker at ~289–312):

```jsx
<div className="admin-detail-section">
  <h4>Assistant model</h4>
  {!sharedModel ? (
    <div className="admin-detail-empty">Model list unavailable.</div>
  ) : (
    <select
      value={u.chatModelOverride ?? ''}
      disabled={savingModelUserId === u.id}
      onChange={(e) => handleChatModelChange(u, e.target.value)}
    >
      <option value="">
        Default ({modelLabel(sharedModel, sharedModel.effectiveModelKey)})
      </option>
      {u.chatModelOverride
        && !sharedModel.models.some((m) => m.key === u.chatModelOverride) && (
        <option value={u.chatModelOverride} disabled>
          {u.chatModelOverride} (unavailable — using {modelLabel(sharedModel, sharedModel.effectiveModelKey)})
        </option>
      )}
      {(sharedModel.providers ?? []).map((p) => (
        <optgroup key={p.id} label={p.label}>
          {sharedModel.models.filter((m) => m.provider === p.id).map((m) => (
            <option key={m.key} value={m.key}>{m.label}</option>
          ))}
        </optgroup>
      ))}
    </select>
  )}
</div>
```

**Handler** (mirrors `toggleEmailEnabled`, ~147):

```js
const handleChatModelChange = async (u, value) => {
  setSavingModelUserId(u.id);
  try {
    await api.patch(`/api/admin/users/${u.id}/chat-model`, { modelKey: value === '' ? null : value });
    fetchUsers();            // re-read stored state; expandedUserId is separate state, so the row stays open
  } catch { /* ignore — same posture as the neighbouring per-user handlers */ }
  finally { setSavingModelUserId(null); }
};
```

New state: `const [savingModelUserId, setSavingModelUserId] = useState(null);`

**Behavioral requirements**:

- Empty-string option → sends `modelKey: null` (clear), matching `handleSharedModelChange`'s
  convention exactly (FR-009).
- A user with no override shows `Default (…)` selected (FR-009).
- A stored-but-ineligible override shows the disabled "unavailable — using X" option as the
  selected value — never "Default" (FR-010/RBD-4).
- The stored key is rendered as a **text child** only (React escapes it); it is never used as
  markup, a URL, or a key into anything but the registry.
- No user-facing surface is added anywhere: this control exists only on the admin page (FR-011).

---

## Test obligations for this contract

| Assertion | Requirement | Where |
|---|---|---|
| Admin sets an override → `200`, stored value + effective key returned | FR-007, US1-1 | `server/__tests__/admin-chat-model-override.test.js` |
| Admin clears (`null`) → `200`, `chatModelOverride: null`, effective = current shared default | FR-007, US2-3 | same |
| Unknown key → `400`, nothing stored | FR-007, US1-4 | same |
| Known-but-ineligible key → `400`, nothing stored | FR-007, US1-4 | same |
| Non-string, non-null body → `400` | FR-007 | same |
| Endpoint accept/reject agrees with `isSharedEligible` for every `MODEL_DEFS` entry | FR-005 | same |
| Unknown user id → `404` | robustness | same |
| Signed-in non-admin → `403`, nothing read or changed (**real `requireAdmin` mounted**) | FR-008, US1-5 | same |
| Unauthenticated → `401` | FR-008, US1-5 | same |
| Setting an override for a BYOK-active user succeeds (dormant) | FR-015 | same |
| `GET /users` carries `chatModelOverride` (and `null` for untouched accounts) | FR-009, US2-4 | same |
| Picker renders `Default (…)` for a user with no override | FR-009 | `client/src/pages/__tests__/AdminPage.test.jsx` |
| Picker renders the stale stored value as "unavailable — using X" | FR-010 | same |
| Selecting a model PATCHes the right URL/body; selecting Default PATCHes `null` | FR-007/FR-009 | same |
