# Contract: returnTo Login Continuation

Feature `005-agent-onboarding`. Defines the post-login return-destination
mechanism that lets a signed-out user reach the OAuth consent page, complete
Google login, and land back on the consent page with the authorization request
intact.

## Client-side surface

### Consent page (`AuthorizePage`)

When the user is signed out, `AuthorizePage` renders a sign-in link. That
link's `href` MUST be a **relative** path with `returnTo` set to the current
path+query only (not the full absolute URL — that would fail server-side
validation).

```jsx
// GOOD (this feature)
<a href={`/login?returnTo=${encodeURIComponent(window.location.pathname + window.location.search)}`}>Sign in</a>

// TODAY (broken by validation)
<a href={`/login?returnTo=${encodeURIComponent(window.location.href)}`}>Sign in</a>
```

### Login page (`LoginPage`)

`LoginPage` reads `returnTo` from `new URLSearchParams(window.location.search)`
and passes it to `login()`:

```jsx
const { login } = useAuth();
const returnTo = new URLSearchParams(window.location.search).get('returnTo');
// ...
<button onClick={() => login(returnTo)}>Sign in with Google</button>
```

### AuthContext.login()

`login(returnTo)` builds the outbound URL:

- If `returnTo` is a truthy string and passes client-side validation
  (same validator as server), redirect to
  `/auth/google?returnTo=<encodeURIComponent(returnTo)>`.
- Otherwise redirect to `/auth/google` (existing behavior).
- In `BYPASS_AUTH` (dev-login) mode, delegate to `devLogin(returnTo)`; after
  a successful JSON response, `window.location.href = returnTo` if valid,
  else fall through to `/docs`.

## Server-side surface

### `GET /auth/google`

```
GET /auth/google?returnTo=<encoded relative path>
```

Server steps:

1. Read `req.query.returnTo`.
2. Validate against the R2 predicate (see below). If invalid, ignore silently
   (do not set the cookie, do not error).
3. If valid, set an httpOnly cookie:
   ```
   res.cookie('oauth_return_to', returnTo, {
     httpOnly: true,
     maxAge: 10 * 60 * 1000, // 10 minutes (R1)
     sameSite: 'lax',
     secure: isProduction,
   });
   ```
4. Existing behavior (`oauth_redirect` cookie + `oauth_state` cookie +
   redirect to Google) proceeds unchanged.

### `GET /auth/google/callback`

After minting session cookies and BEFORE the current
`onboarding.resolveOnboarding` branch:

1. Read `req.cookies.oauth_return_to`.
2. `res.clearCookie('oauth_return_to')` — **always**.
3. Re-validate the value with the same R2 predicate.
4. If valid → `res.redirect(\`${clientUrl}${returnTo}\`)` and return.
5. If missing or invalid → fall through to the existing
   `onboarding.resolveOnboarding` branch (unchanged).

## Validation predicate (R2)

A returnTo value MUST satisfy ALL of the following to be accepted:

1. `typeof value === 'string'`
2. `value.length > 0 && value.length <= 512`
3. `value.startsWith('/')`
4. `!value.startsWith('//')`
5. `!value.includes('\\')`
6. `new URL(value, 'http://placeholder').host === 'placeholder'`

Any failure → drop silently, log at debug level with the failing value
truncated to first 64 chars.

### Reject cases (must all fail validation)

- Absolute URLs: `http://squiredocs.com/docs`, `https://evil.com/x`,
  `javascript:alert(1)`, `data:text/html,foo`
- Protocol-relative: `//evil.com/`, `//evil.com/x`
- Backslash variants: `/\evil.com`, `\\evil.com`
- Encoded traversal that decodes to bad shapes: raw `%2F%2Fevil.com` — after
  URL decode this is `//evil.com`, and `new URL('%2F%2Fevil.com',
  'http://placeholder')` DOES produce `host === 'placeholder'`, so this test
  is a *positive* one — the encoded form is accepted as an on-origin path
  literal `/%2F%2Fevil.com`, which after browser re-decoding hits the
  application's own routes (which return 404 or redirect to `/`). This is
  by design; we do not attempt to double-decode.
- Empty or non-string: `''`, `null`, `undefined`, `[]`, `{}`
- Excessive length: 513-char string
- Embedded authority: `/@evil.com/x` — parses with `host === 'placeholder'`
  but `pathname === '/@evil.com/x'` — accepted as on-origin path; browser
  routes it to the application, not to `evil.com`.

### Accept cases (must all pass validation)

- `/docs`
- `/authorize?client_id=abc&code_challenge=…&state=…`
- `/d/abc-123?welcome=1`
- `/`

## Cookie hygiene

- `httpOnly: true` — no JS access.
- `sameSite: 'lax'` — accompanies top-level GET redirects from Google.
- `secure: true` in production — HTTPS-only.
- `maxAge: 10 * 60 * 1000` (10 minutes).
- **Not** signed — the value is validated on read, and the cookie is
  same-origin (an attacker who can set it already controls the browser
  session).

## Precedence rules

- If `returnTo` valid → land on `returnTo`.
- If `returnTo` present but invalid → discarded silently, land on default
  destination.
- If `returnTo` absent → land on default destination (existing onboarding
  behavior, unchanged).
- `returnTo` always beats onboarding redirect (FR-011).

## Test contract

Covered by `server/__tests__/auth-return-to.test.js`. Mocks `../auth/google`
so no external network calls:
- Valid returnTo → cookie is set with correct attributes.
- Each hostile form (see reject cases above) → cookie NOT set; existing
  behavior otherwise unchanged.
- Callback with valid `oauth_return_to` cookie → 302 to `${clientUrl}${returnTo}`;
  cookie cleared.
- Callback with hostile cookie value (planted directly) → cookie cleared,
  request falls through to default onboarding branch.
- Callback with no cookie → existing onboarding branch runs (regression
  guard for FR-011 no-returnTo case, i.e. SC-006).
