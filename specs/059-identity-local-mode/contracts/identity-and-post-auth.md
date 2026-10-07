# Contract: identity resolution and the shared post-sign-in path (internal)

Serves FR-001 to FR-013 and the regression contract in User Story 2. These are
module boundaries, not HTTP surfaces, but every sign-in method depends on them
and the regression tests pin them.

## `server/auth/users.js`

```
GOOGLE_ISSUER = 'https://accounts.google.com'
DEV_ISSUER    = 'dev'

resolveIdentityUser(
  { issuer, subject, email, name, picture = null, emailVerified = undefined },
  { signupSource = 'browser', ip = null, userAgent = null } = {}
) -> Promise<user & { isNew: boolean }>
  throws AccountExistsError (code 'account_exists') when the pair is unknown
  and lower(email) already belongs to a user. Creates nothing in that case.

findOrCreateUser({ googleId, email, name, picture }, ctx)    // @deprecated fixture wrapper
  = resolveIdentityUser({ issuer: GOOGLE_ISSUER, subject: googleId, ... }, ctx)
    then convertPendingInvites(user)
  No production route calls it (source-regex test).

createOwnerUser(client, { name, email, ctx }) -> user     // used only inside the claim transaction
  INSERT with is_admin = true, signup_source = 'signin_link', google_id NULL.

findUserByEmail(db, email) -> user | null                 // case-insensitive; CLI login-link and token create
```

Invariants (each pinned by a test):

| Id | Invariant |
| --- | --- |
| I1 | Lookup is by `(issuer, subject)` only; email is never used to match a returning identity. |
| I2 | `signup_source`, `signup_ip`, `signup_user_agent` appear only in the INSERT; a returning sign-in never changes them. |
| I3 | A returning identity refreshes `email`, `name`, `picture` (today's upsert columns), the identity's `last_used_at`, and `email_verified` when sent. |
| I4 | New users are inserted with `google_id` NULL. |
| I5 | Two concurrent first sign-ins for one pair yield one user and one identity. |
| I6 | `resolveIdentityUser` writes no `auth_events` row and converts no invites. |

## `server/auth/post-auth.js`

```
isValidReturnTo(value) -> boolean                  // moved from routes.js, unchanged
tryParseAuthorizeReturnTo(rawReturnTo) -> params | null   // moved, unchanged
signupSourceFor(rawReturnTo) -> 'agent_oauth' | 'browser'

establishSession(res, user, { signupSource, ctx, notify }) -> Promise<void>
  1. convertPendingInvites(user)       // one transaction, never throws (FR-012)
  2. if notify and not isSyntheticEmail(user.email):
       notifyNewUser when user.isNew, notifyLogin always   // today's order: after conversion
  3. updateLastLogin(user.id, { ...ctx, signupSource, isNew: user.isNew })   // the one auth_events row (FR-009)
  4. set accessToken and refreshToken cookies

completePostAuth(res, { user, signupSource, clientUrl, rawReturnTo, ctx }) -> Promise<response>
  1. establishSession(res, user, { signupSource, ctx, notify: true })
  2. if isValidReturnTo(rawReturnTo):
       feature 031 gate, unchanged: user.isNew === true AND tryParseAuthorizeReturnTo(rawReturnTo)
       AND isLocalhostUri(redirect_uri) -> approveAuthorization -> redirect to agent callback;
       otherwise redirect to clientUrl + rawReturnTo (no welcome doc)
  3. else onboarding.resolveOnboarding(user, { seed: true }) -> welcome doc or /docs?signup=1
```

Neither function receives `req` (U2/INV-3 from feature 031). The order of side
effects is exactly today's: invite conversion (today inside
`findOrCreateUser`), notification, `updateLastLogin`, cookies.

`notify` by caller: Google callback and faucet browser mode (through
`completePostAuth`) true, as today; faucet fixed and fresh JSON modes false, as
today; sign-in link, both response modes, true (a real sign-in; 058 decides
whether admin notifications are sent at all on a non-hosted instance).

`server/auth/routes.js` re-exports `isValidReturnTo` and
`tryParseAuthorizeReturnTo` for existing importers.

## Signup source by method

| Method | `users.signup_source` on create | `auth_events.signup_source` |
| --- | --- | --- |
| Google, no valid returnTo | `browser` | `browser` |
| Google, valid returnTo | `agent_oauth` | `agent_oauth` |
| Faucet, all modes | `browser` (as today; browser mode with a valid returnTo: `agent_oauth`, as today) | same |
| Claim link (owner creation) | `signin_link` | `signin_link` (`event = signup`) |
| Sign-in link to an existing user | unchanged | `signin_link` (`event = login`) |
