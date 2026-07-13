<!-- source: https://squiredocs.com/d/503fb6a8-d165-49c7-bc98-883a68b14540
     synced-by: design/sync.mjs — DO NOT HAND-EDIT; amend the Squire doc and re-sync -->

# Squire Authentication and Sharing

## What this is

How Squire knows who you are and what you may touch: Google OAuth identity, stateless JWT sessions, per-document role-based access, sharing (including invites to people who have no account yet), and the admin area. Documents the current implementation; code pointers throughout.

## Identity: Google OAuth

The only sign-in path is Google OAuth (`server/auth/google.js`, routes in `server/auth/routes.js`). `GET /auth/google` sets a 32-byte CSRF state in an httpOnly cookie (5-minute TTL) plus a post-login redirect cookie; the callback validates state, verifies the Google ID token, upserts the user, records `last_login_at`, fires admin notification emails, and issues app JWTs. A dev-only `POST /auth/dev-login` bypass exists outside production.

## Sessions: stateless JWTs

- Two token types with separate secrets (`server/auth/jwt.js`): access (15 min; carries userId, email, name, picture, isAdmin) and refresh (7 days; carries userId + tokenVersion). Production refuses to boot on missing/default secrets.
- Stored as httpOnly cookies (secure + strict SameSite in production); the access token is also returned in the JSON body for Authorization-header clients.
- `POST /auth/refresh` re-checks `token_version` against the DB and rotates both cookies WITHOUT incrementing the version — deliberate, to avoid a multi-tab revocation race. Logout increments `users.token_version`, invalidating every outstanding refresh token at once.
- There is no server-side session store. Redis plays no role in auth — it caches Yjs docs and fans out updates/awareness across instances (`server/redis-persistence.js`, `server/redis-pubsub.js`), and is optional.

## Document roles and enforcement

RBAC per document: owner > editor > viewer, stored as a Postgres enum on `document_shares`. `documents.getRole` is the single source of truth; `server/permissions.js` maps actions to minimum roles (view→viewer, edit→editor, manage→editor, delete→owner) and its `extractUser` unifies the three credential kinds — user JWT, agent OAuth JWT, and `sk_sqd_` API token — so HTTP, WebSocket, and MCP all authenticate through one path.

- **HTTP: **every `/api/docs/:docId/*` handler checks role and 403s.
- **WebSocket: **the upgrade is gated on view access; edit messages from non-editors are dropped; a 60-second interval re-checks the role from the DB and disconnects on revocation, failing closed on error.
- **MCP: **transport middleware enforces token scopes (documents:read/write); each tool additionally checks document access itself (e.g. modify verifies every sourceDocGuid).

## Sharing

- `POST /api/docs/:docId/share` grants a role by email. Viewers may only grant viewer; owner is never grantable. If the target has no account yet, a pending row lands in `document_share_invites` and is converted to a real share on their first login (never downgrading an existing role).
- **Outbound share email is trust-gated: **the inviter’s `users.email_enabled` flag (admin-set, read fresh per request) controls whether email is sent. When false, access is still granted — only the notification is suppressed. Email goes out via AWS SES (`server/email.js`, fire-and-forget, header-injection-sanitized).
- The MCP `share_document` tool enforces the same role rules for agent-initiated sharing.

## Admin area

Admin = `users.is_admin` (copied into the JWT claim; `requireAdmin` fast-rejects on the claim then re-verifies against the DB). Capabilities (`server/api/admin.js`): per-user stats (docs, monthly non-BYOK AI spend, credits, last login), setting monthly AI credit, granting one-off extra credits, the `email_enabled` trusted flag, reviewing a user’s sharing activity, and choosing the shared assistant’s default model (stored in `app_settings`). The admin (`ADMIN_EMAIL`) also receives sign-up, login, credit-limit, and support-request notification emails.

## Data model

`users` (identity, token_version, is_admin, email_enabled, BYOK keys, credits, welcome_doc_id/onboarded_at) · `documents` (ownership + title metadata) · `document_shares` (the authorization table) · `document_share_invites` (pending email grants) · `mcp_api_tokens` / `agent_delegations` (agent credentials — see [Squire Agent Surface (MCP)](https://squiredocs.com/d/697456a2-b42b-49b3-ae57-875d3e328809)) · `support_requests` · `app_settings`.