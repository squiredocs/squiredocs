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
- There is no server-side session store. Redis plays no role in auth — it fans out Yjs updates/awareness across instances (`server/redis-pubsub.js`), and is optional. (Amended 2026-08-02: a dormant Redis doc-cache module was never wired into any load path and is removed by feature 042; Redis is pub/sub fan-out only.)

## Abuse signals: signup/login IP + user-agent

**Why (2026-07-25):** a single actor relayed five Google accounts to farm the $10 signup AI-credit grant (exhaust one account, sign up the next minutes later). The app stored no network or device metadata anywhere, so the spray was only detectable by content/timing forensics. The edge WAF sees client IPs but never hands them to the app.

**What is recorded.** Every signup and login records the true client IP and the User-Agent header:

- `users.signup_ip` / `users.signup_user_agent` — set once at account creation (`findOrCreateUser`), never overwritten.
- `users.last_login_ip` / `users.last_login_user_agent` — refreshed on every login (`updateLastLogin`).
- `auth_events` — append-only trail: `user_id, event (signup | login), signup_source, ip (inet), user_agent, created_at`. This history powers spray correlation: shared-IP grouping across accounts and exhaust-grant-then-respawn relay detection.

- IP comes from `req.ip`, trustworthy only because trust proxy is a numeric hop count (feature 010 FR-014/RD-5) — a blanket `trust proxy true` would make these columns spoofable and MUST NOT be introduced. User-agent is truncated to 512 chars. Both are nullable; capture failure never blocks auth.
- Coverage: browser OAuth callback, agent OAuth, and the dev-only login bypass — all paths flow through the same two user-store helpers. Token refresh is deliberately NOT logged (it is a background rotation every ~15 min, not a human sign-in; logging it would drown the signal in noise).
- Exposure: admin area only (admin user list shows signup/last-login IP + UA). Never surfaced to non-admin users or in any public API.
- Privacy: the privacy policy discloses IP/UA collection at signup and sign-in for security and abuse prevention. `auth_events` rows older than 180 days are purged (the denormalized users columns are kept while the account exists); rows delete with the user via FK cascade.
- Event semantics (034 as built): only completed signups/logins are recorded — failed or abandoned auth attempts append nothing. On `login` rows, `signup_source` records the channel of that event itself (`browser` | `agent_oauth`; dev-login records `browser`), not the channel the account originally signed up through.
- Trail writer: the single `auth_events` row per completed auth is written by `updateLastLogin` (`event = isNew ? 'signup' : 'login'`) — every auth path calls both user-store helpers once, so writing from both would double-count signups.
- Purge mechanism: in-process — a boot-time sweep plus a daily `setInterval` owned by `server/auth/auth-events.js` (unref()’d; stopped via the shutdown path). There is no external scheduler; multiple replicas are harmless because the DELETE is set-based and idempotent.

## Document roles and enforcement

RBAC per document: owner > editor > viewer, stored as a Postgres enum on `document_shares`. `documents.getRole` is the single source of truth; since 053-spaces the role it returns is the effective role, the stronger of the direct document_shares row and the space-membership role via documents.space_id, computed by the document_access view (see Squire Spaces, https://squiredocs.com/d/03bac6c7-78e3-449d-ab94-806580fa5a52); `server/permissions.js` maps actions to minimum roles (view→viewer, edit→editor, manage→editor, delete→owner) and its `extractUser` unifies the three credential kinds — user JWT, agent OAuth JWT, and `sk_sqd_` API token — so HTTP, WebSocket, and MCP all authenticate through one path.

- **HTTP: **every `/api/docs/:docId/*` handler checks role and 403s.
- **WebSocket: **the upgrade is gated on view access; edit messages from non-editors are dropped; a 60-second interval re-checks the role from the DB and disconnects on revocation, failing closed on error.
- **MCP: **transport middleware enforces token scopes (documents:read/write); each tool additionally checks document access itself (e.g. modify verifies every sourceDocGuid).

## Sharing

- `POST /api/docs/:docId/share` grants a role by email. Viewers may only grant viewer; owner is never grantable. If the target has no account yet, a pending row lands in `document_share_invites` and is converted to a real share on their first login (never downgrading an existing role).
- **Outbound share email is trust-gated: **the inviter’s `users.email_enabled` flag (admin-set, read fresh per request) controls whether email is sent. When false, access is still granted — only the notification is suppressed. Email goes out via AWS SES (`server/email.js`, fire-and-forget, header-injection-sanitized).
- The MCP `share_document` tool enforces the same role rules for agent-initiated sharing.

## Admin area

Admin = `users.is_admin` (copied into the JWT claim; `requireAdmin` fast-rejects on the claim then re-verifies against the DB). Capabilities (`server/api/admin.js`): per-user stats (docs, monthly non-BYOK AI spend, credits, last login), setting monthly AI credit, granting one-off extra credits, the `email_enabled` trusted flag, reviewing a user’s sharing activity, pinning a per-user chat model override (see the in-app assistant doc), and choosing the shared assistant’s default model (stored in `app_settings`). Feature 036 adds READ-ONLY adoption reporting — agent/MCP connection state and the onboarding funnel, deployment-wide and per user (see the agent-surface doc); it reports only, never revoking, minting, or exposing secret material. The admin (`ADMIN_EMAIL`) also receives sign-up, login, credit-limit, and support-request notification emails.

## Amendment (2026-10-07, proposed): sign-in providers and team mode

Status: proposed, not yet ratified. This amendment designs team mode for self-hosted instances. It is the companion to [Proposal: Self-Hosting and Local Mode](https://squiredocs.com/d/62f408ea-a884-4d2e-a129-fbbbf8abb7e5), which defines the two instance modes, local mode, sign-in links, and the identities table. It is built as feature 061, after the self-host launch path (058 to 060). Nothing here changes the hosted service, which stays in team mode with Google as its only provider and open sign-up.

### Identities

An account can have several sign-in identities. Each row in `user_identities` is one (issuer, subject) pair: `https://accounts.google.com` plus Google's subject id, the configured OIDC issuer plus its subject, or `local` plus the user id for a password. The pair is unique. A sign-in looks up the pair, never the email.

Accounts are never linked by email automatically. Matching on email is how Grafana's CVE-2023-3128 happened: an identity provider let users set an email they did not own, and the match handed them someone else's account. The rules:

- A sign-in with an unknown (issuer, subject) creates a new account, if sign-up allows it.
- If an account with that email already exists, the sign-in is refused with a message that says to sign in with the existing method and link the new one from Settings. It does not create a duplicate account and does not link.
- Linking happens only from a signed-in session, in Settings under linked sign-in methods. Unlinking the last method is refused.

### Providers

- **Google.** Reimplemented as a preset of the generic OIDC provider (issuer `https://accounts.google.com`), so there is one OIDC code path. The callback stays at `/auth/google/callback` so the hosted service's registered redirect URI does not change. Enabled when `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` are set.
- **Generic OIDC.** One provider, configured by `OIDC_ISSUER_URL`, `OIDC_CLIENT_ID`, `OIDC_CLIENT_SECRET`, `OIDC_DISPLAY_NAME` (the button label), and `OIDC_SCOPES` (default `openid email profile`). Uses discovery, PKCE, state, and nonce through the `openid-client` library. The ID token must carry an email; the `email_verified` claim is recorded. This covers Authentik, Keycloak, Okta, Entra ID, and Google Workspace.
- **Email and password.** Enabled by `PASSWORD_LOGIN=true`. Passwords are hashed with Node's built-in `crypto.scrypt`, which avoids a new native module in the multi-architecture image. Minimum length 10, maximum 256, no composition rules. Failed sign-ins are limited by the existing per-IP limit on `/auth` plus a per-account delay that grows after five failures. Password reset sends an email when SMTP is configured; without SMTP, an administrator mints a sign-in link with `squire login-link --email`.

`GET /auth/providers` lists the enabled providers, and the sign-in and consent pages render a button or form for each. The server refuses to start in team mode with none enabled, and the error names the variables to set.

### Sign-up

- `SIGNUP_MODE`: `open` (anyone who can sign in gets an account), `invite` (only people with an invite), or `closed` (no new accounts; administrators add people with invite links). The default for a self-hosted team instance is `invite`. The hosted service sets `open`.
- `ALLOWED_EMAIL_DOMAINS`, a comma-separated list, restricts `open` sign-up to those domains.
- An invite is either an email (when SMTP is configured) or a copyable link (always available). An invite link is single-use, expires after 7 days, and is bound to one email address. Share and space invites to people without accounts produce the same kind of invite.

### Verified email and pending invites

Pending document and space invites convert to real access at sign-in by email address (`convertPendingInvites`). With providers that let a user claim any email, that would let someone register a victim's address and collect their invites. So invites convert only when the account's email is verified:

- Google: `email_verified` is true in the ID token.
- OIDC: `email_verified` is true. An administrator can set `OIDC_TRUST_EMAIL=true` for a provider that does not send the claim but does verify addresses.
- Password: the user clicked an email verification link, or the account was created from an invite link bound to that address.

An unverified account keeps its pending invites until it is verified. This rule ships before or with password sign-in, never after.

### First administrator

On an instance with no users, in either mode, `squire claim-link` creates the owner, who is an administrator (see the self-hosting proposal). `INIT_ADMIN_EMAIL` is the headless alternative for team mode: the first account to sign in with a verified email matching it becomes an administrator, once. The hardcoded administrator email in `migrations/1773952482000_add-admin-and-last-login.js` stays for the hosted service's history; a fresh database has no users, so it changes nothing there.

### Not in scope

SAML, LDAP, SCIM, trusted-header authentication, and multi-factor authentication. Teams that need SAML or LDAP can put an identity provider that speaks OIDC (Authentik, Keycloak) in front. Multi-factor authentication is left to the identity provider for now.

### Decisions for Sam

- **A1. No automatic linking by email.** Proposed: yes, as above.
- **A2. Google becomes a preset of the generic OIDC provider.** Proposed: yes. It removes the `google-auth-library` code path.
- **A3. scrypt rather than argon2 for passwords.** Proposed: scrypt, because it is built into Node and needs no native module.
- **A4. Self-hosted team instances default to ****`SIGNUP_MODE=invite`****.** Proposed: yes.
- **A5. One generic OIDC provider at launch, not several.** Proposed: yes. Several can follow with provider-keyed variables if anyone asks.

## Data model

`users` (identity, token_version, is_admin, email_enabled, BYOK keys, credits, welcome_doc_id/onboarded_at, signup/last-login IP + user-agent) · `documents` (ownership + title metadata) · `document_shares` (the authorization table) · `document_share_invites` (pending email grants) · `mcp_api_tokens` / `agent_delegations` (agent credentials — see [Squire Agent Surface (MCP)](https://squiredocs.com/d/697456a2-b42b-49b3-ae57-875d3e328809)) · `support_requests` · `app_settings` · `auth_events` (append-only signup/login IP + user-agent trail — see Abuse signals).