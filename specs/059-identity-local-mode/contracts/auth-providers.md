# Contract: `GET /auth/providers` and provider start paths

Serves FR-015 to FR-019, FR-023, FR-047. Mounted on the existing `/auth`
router, so it sits behind the per-IP `/auth` limiter (FR-035).

## Request

`GET /auth/providers`. No authentication. No parameters. Cookies ignored.

## Response 200

Headers: `Content-Type: application/json`, `Cache-Control: public, max-age=60`.

```json
{
  "mode": "team",
  "hasOwner": true,
  "signupOpen": true,
  "providers": [
    { "id": "google", "label": "Google", "startPath": "/auth/google" }
  ]
}
```

| Field | Type | Meaning |
| --- | --- | --- |
| `mode` | `"local"` \| `"team"` | resolved instance mode |
| `hasOwner` | boolean | `resolveOwner` found an owner (recorded, or exactly one administrator) |
| `signupOpen` | boolean | `true` iff `mode === "team"` in 059 (061 adds `SIGNUP_MODE`) |
| `providers` | array | listed, enabled providers only, in display order |
| `providers[].id` | string | stable id (`google`) |
| `providers[].label` | string | display label used in "Sign in with <label>" and "Continue with <label>" |
| `providers[].startPath` | string | same-origin path that starts sign-in; the client appends `?returnTo=` |

Local mode: `providers` is `[]`, `signupOpen` is `false`.

Never present: client ids, secrets, redirect URIs, user counts, emails, the
dev faucet (RBD-059-19).

Database failure while computing `hasOwner`: respond 200 with `hasOwner:
false` and log the error. The sign-in page must not fail because the owner
probe failed.

## Provider start paths in local mode (FR-019)

`GET /auth/google` and `GET /auth/google/callback` when `mode === "local"`:

- `302` to `${clientUrl}/login?error=provider_disabled`.
- No `Set-Cookie` header at all (the check runs before any `res.cookie`).
- The callback never calls the Google adapter and never touches the database.

In team mode both routes behave exactly as today, including when Google
credentials are absent (today's `config_error` redirect).

## Unknown identity with an existing email (FR-004)

`GET /auth/google/callback`, team mode, `(issuer, subject)` unknown,
`lower(email)` matches an existing user:

- `302` to `${clientUrl}/login?error=account_exists`.
- No session cookies, no user row, no identity row, no `auth_events` row.

## Boot log lines (FR-020 to FR-023)

Exactly one line naming the mode, for example:

```
[Auth] Instance mode: team (providers: google)
[Auth] Instance mode: local (sign in with: docker compose exec app squire claim-link)
[Auth] Google sign-in is configured but inactive in local mode (set SQUIRE_MODE=team to enable it)
```

Fatal (exit code 1, before `app.listen`). The invalid-mode error is a
`ConfigError` from 058's `resolveInstanceConfig`, so in the image it surfaces
from the entrypoint with 058's `[Boot]` prefix; the provider error comes from
`assertBootable` in `server/index.js`:

```
[Boot] SQUIRE_MODE must be "local" or "team" (got "teams").
[Auth] FATAL: SQUIRE_MODE=team needs at least one sign-in provider. Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET, or use SQUIRE_MODE=local.
```
