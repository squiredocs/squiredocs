# Contract: sign-in links

Serves FR-026 to FR-037, FR-045, FR-047, D5, D11, RBD-059-4, -5, -12, -20.

## Token and URL

- Token: 32 random bytes, base64url, 43 characters, no padding.
- Stored: `sha256(token)` as lowercase hex in `signin_links.token_hash`.
- Printed URL: `${APP_URL}/claim#<token>`. `APP_URL` comes from 058's
  configuration module, falling back to `CLIENT_URL`, then
  `http://localhost:${PORT || 3001}` until 058 merges.
- The token never appears in a path, a query string, a `Referer`, or a server
  log line other than the D11 startup block.

## Module `server/auth/signin-links.js`

No load-time secret checks; safe for the CLI to require.

| Function | Behavior |
| --- | --- |
| `mintLink(db, { kind, userId, prefillName, prefillEmail, source })` | prunes old rows (used or expired more than 24 h ago), inserts a row with `expires_at = now() + 15 min`, returns `{ token, id, expiresAt }` |
| `buildLinkUrl(token)` | `${appUrl}/claim#${token}` |
| `peekLink(db, token)` | read-only; returns the peek body below |
| `redeemLink(db, token, { name, email, ctx })` | one transaction; returns `{ user, isNew }` or throws `SigninLinkError` with a `code` |
| `maybeLogStartupClaimLink({ pool, mode, log })` | D11; mints and logs only in local mode with zero users |

## `POST /auth/signin-link/peek`

Request: `Content-Type: application/json`, body `{ "token": "<43 chars>" }`.

Response 200 (always 200 for a well-formed request; validity is in the body):

```json
{ "valid": true, "kind": "claim", "expiresAt": "2026-10-07T18:15:00.000Z",
  "prefill": { "name": "Sam", "email": "sam@example.com" } }
```

```json
{ "valid": true, "kind": "signin", "expiresAt": "...",
  "prefill": { "name": "Sam", "email": "sam@example.com" } }
```

```json
{ "valid": false }
```

A link is invalid when its hash is unknown, it is used or voided, it has
expired, or it is a `claim` link and the instance now has users. The response
does not say which (FR-047 allows only kind, prefill, expiry, and validity),
and an invalid response carries no kind and no prefill. For a `claim` link, `prefill` holds the CLI arguments (either field
may be null). For a `signin` link, `prefill` holds the target user's current
name and email (RBD-059-20). Nothing else is ever returned (FR-047).

Response 400 `{ "error": "token_required" }` when the body has no string token
of plausible length (20 to 128 characters).

The peek never writes.

## `POST /auth/signin-link`

Request, form mode (the claim page): `Content-Type:
application/x-www-form-urlencoded`, fields `token`, and for a claim `name`,
`email`.

Request, JSON mode (feature 060's CI driver): `Content-Type:
application/json`, `Accept: application/json`, same fields.

Mode selection: JSON when the request's `Accept` header prefers
`application/json` (`req.accepts(['html', 'json']) === 'json'`), form
otherwise.

Validation before any database write (FR-031): for a `claim` link on an
unclaimed instance, `name` trimmed 1 to 255 characters and `email` trimmed,
at most 255 characters, matching `^[^\s@]+@[^\s@]+\.[^\s@]+$`. A failure does
not spend the link.

Redemption transaction (see `research.md` R6): conditional `UPDATE` marks the
row used; `signin` loads the target; `claim` locks `users`, requires zero
rows, creates the owner (`is_admin = true`, `signup_source = 'signin_link'`,
capture pair from `authContext(req)`), records `instance_owner_user_id`, and
voids every other unused claim link.

After commit, `signupSource = 'signin_link'` and `rawReturnTo = null`:

| Outcome | Form mode | JSON mode |
| --- | --- | --- |
| success | `completePostAuth`: cookies, one `auth_events` row, invite conversion, then `302` to the welcome document (`/d/<id>?welcome=1`) or `/docs?signup=1` | `establishSession` (same cookies and row), onboarding seed, `200 { ok: true, user: { id, email, name, isAdmin, welcomeDocId, onboarded } }` |
| `claim_invalid` (missing or bad name/email) | `303` to `/claim?error=claim_invalid` (no fragment: the page asks the user to reopen the link from the terminal) | `400 { ok: false, error: "claim_invalid", field: "email" }` |
| `link_invalid` (unknown, used, expired) | `302` to `/login?error=link_invalid` | `400 { ok: false, error: "link_invalid" }` |
| `instance_claimed` | `302` to `/login?error=instance_claimed` | `409 { ok: false, error: "instance_claimed" }` |

No refusal sets cookies. A sign-in link never carries a return path, so the
feature 031 auto-issue can never fire on this route (FR-011, D2): this is
asserted by a test that sets a valid `oauth_return_to` cookie for an
`/authorize` request with a localhost redirect and confirms no authorization
code is minted.

Messages (rendered by the client from the error codes):

- `link_invalid`: "This sign-in link has expired or was already used. Run `docker compose exec app squire claim-link` for a new one."
- `instance_claimed`: "This instance already has an owner. Run `docker compose exec app squire claim-link` to get a sign-in link for the owner."
- `claim_invalid`: "Enter a name and a valid email address."

## Startup-log block (D11, FR-036)

Printed with `console.log`, local mode and zero users only, once per process
start, before `/ready` turns 200:

```
==================== Squire Docs: claim this instance ====================
Open this link within 15 minutes to create the owner account:
http://localhost:3910/claim#<token>
Expired? Run: docker compose exec app squire claim-link
==========================================================================
```

The link line holds only the URL.
