# Contract: admin users API delta + exposure boundary

**Feature**: 034-auth-ip-capture | Surface: `GET /api/admin/users` (`server/api/admin.js`), rendered by `client/src/pages/AdminPage.jsx`.

## Authorization (unchanged)

The whole `server/api/admin.js` router already sits behind `requireAuth` + `requireAdmin`. This feature adds **no new endpoint** and **no new authorization path** — it widens one already-admin-gated payload.

## `GET /api/admin/users` — response delta

Existing shape (unchanged):

```jsonc
{ "users": [ { "id": "...", "name": "...", "email": "...", "picture": "...",
               "isAdmin": false, "emailEnabled": false, "welcomeEmailSentAt": null,
               "aiCreditCents": 1000, "createdAt": "...", "lastLoginAt": "...",
               "docCount": 3, "aiUsedCents": 0, "aiExtraCreditCents": 0,
               "aiRemainingCents": 1000 } ] }
```

Four fields added to each element (FR-011):

| Field | Type | Source column | Absent value |
|-------|------|---------------|--------------|
| `signupIp` | `string \| null` | `u.signup_ip` | `null` — pre-feature accounts, or capture unavailable |
| `signupUserAgent` | `string \| null` | `u.signup_user_agent` | `null` |
| `lastLoginIp` | `string \| null` | `u.last_login_ip` | `null` |
| `lastLoginUserAgent` | `string \| null` | `u.last_login_user_agent` | `null` |

**Implementation contract**

- Add the four columns to the explicit `SELECT` list on `u` (the query already lists columns explicitly — no `SELECT *`).
- Add the four keys to the row→object mapping, passing values through verbatim. **No** server-side truncation, masking, anonymization, or reformatting: the admin is the abuse investigator and needs the exact stored value. (`inet` is returned by `pg` as a plain string.)
- The join/aggregate subqueries and `ORDER BY u.created_at DESC` are untouched.
- No new query parameters, no filtering by IP, no aggregation — grouping/correlation UI is the explicitly out-of-scope follow-on.

## Admin page rendering contract (`AdminPage.jsx`)

| Element | Contract |
|---------|----------|
| Header row | Two new `<th>`: `Signup IP` and `Login IP`, placed immediately after `Last Login`. |
| `colCount` | `9` → `11` (drives the detail row's `colSpan`). |
| IP cells | Render the value or the table's existing `—` placeholder when `null`. Each cell carries `title={u.signupUserAgent \|\| 'No user-agent recorded'}` (resp. `lastLoginUserAgent`) so the fingerprint is available on hover. |
| Detail row | New `admin-detail-section` titled `Sign-in origin`, listing all four values with labels (`Signup IP`, `Signup user-agent`, `Last login IP`, `Last login user-agent`), full untruncated user-agent strings, `—` for absent. |
| Escaping | Values are rendered as React text children (auto-escaped). MUST NOT use `dangerouslySetInnerHTML` — the user-agent is attacker-controlled input. |
| Errors | No new fetch, no new state, no new loading path — the values ride the existing `/api/admin/users` response. |

## Non-exposure contract (FR-012 / SC-005)

The following surfaces MUST NOT contain any of the four values, and this is asserted by test:

| Surface | Why it is safe today |
|---------|---------------------|
| `GET /auth/me` | Explicit eight-field whitelist (`id, email, name, picture, isAdmin, emailEnabled, welcomeDocId, onboarded`) — new columns cannot leak through it. |
| `PATCH /auth/me` | Explicit four-field whitelist. |
| MCP / agent-facing tools, collaborator and share payloads, public endpoints | Never select from `users` capture columns; none added by this feature. |
| `auth_events` | No HTTP surface of any kind. Reachable only via SQL. |

Regression guard: `server/__tests__/admin-auth-capture.test.js` asserts (a) an admin `GET /api/admin/users` includes the four keys with the stored values, and (b) a non-admin caller receives `403` and no capture data, and that the `/auth/me` payload keys are exactly the documented whitelist.
