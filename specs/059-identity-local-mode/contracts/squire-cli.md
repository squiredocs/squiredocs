# Contract: the `squire` CLI

Serves FR-038 to FR-044, RBD-059-7, -13, -22, -23. Runs inside the app
container as `docker compose exec app squire <command>` (and, in development,
`node bin/squire.js <command>`).

## Process rules

- stdout carries only machine-relevant output: the bare link line, the JSON
  document for `doctor --json`, or the token for `token create --stdout`.
  Everything else goes to stderr.
- Exit code 0 on success, 1 on any failure, 2 on a usage error.
- Every failure message ends with a concrete next action (FR-044). The set of
  failure cases and their messages is enumerated in
  `server/cli/messages.js` and covered by one table-driven test (SC-008).
- Before requiring anything under `server/`, `bin/squire.js` runs 058's secret
  resolver (no-op when the variables are already set) and
  `script/setup-db-env.js`.

## `squire claim-link [--name N] [--email E]`

| Instance state | Effect | stdout | stderr |
| --- | --- | --- | --- |
| zero users | mints a `claim` link with the prefill | the URL, one line | "Open this link within 15 minutes to create the owner account." |
| claimed, owner resolvable | mints a `signin` link for the owner | the URL | "This instance already has an owner (<name>, <email>); --name and --email were ignored. The link signs in the owner." (the "ignored" clause only when either flag was given) |
| claimed, owner not resolvable | nothing minted, exit 1 | nothing | "Could not tell which account is the owner (several administrators and no recorded owner). Run: squire login-link --email <address>" |

`--email` is syntax-checked when given (exit 2 with the reason). Empty
`--name`/`--email` are allowed: the claim page asks for them.

## `squire login-link --email E`

Case-insensitive lookup. Found: mints a `signin` link, prints the URL. Not
found: exit 1, "No account has the email E." plus, when the instance has zero
users, "This instance has no owner yet. Run: squire claim-link".

## `squire mode`

stdout (human text, both modes), for example:

```
Mode: local
Sign-in: one owner, by links from `squire claim-link`. Sign-up is closed.
To switch to team mode: set SQUIRE_MODE=team and GOOGLE_CLIENT_ID and
GOOGLE_CLIENT_SECRET in .env, then run docker compose up -d.
```

## `squire doctor [--json]`

JSON document (one object, one line or pretty-printed, always parseable):

```json
{
  "ok": true,
  "checks": {
    "database":   { "ok": true },
    "migrations": { "ok": true, "pending": 0 },
    "server":     { "ok": true, "ready": true },
    "mode":       { "ok": true, "mode": "local", "providers": [] },
    "appUrl":     { "ok": true, "value": "http://localhost:3910" },
    "owner":      { "ok": true, "hasOwner": false }
  },
  "info": {
    "redis":          { "state": "up" },
    "email":          { "on": false, "reason": "SMTP_HOST is not set" },
    "imageStorage":   { "driver": "local" },
    "semanticSearch": { "on": false, "reason": "no embedding key (GOOGLE_GENERATIVE_AI_API_KEY)" },
    "assistantKeys":  { "on": false, "providers": [] }
  }
}
```

- `ok` is the AND of `checks.*.ok`. `owner.ok` is always true (no owner is a
  normal fresh state); it is reported, not gating. `info` never affects `ok`.
- Each failing check carries `message` with the next action, for example
  `"Database unreachable at collab-postgres:5432. Check that the postgres container is healthy: docker compose ps"`,
  `"2 migrations pending. Restart the app container to run them: docker compose restart app"`,
  `"APP_URL http://192.168.1.5:3910 is neither localhost nor https. Put a TLS proxy in front and set an https APP_URL."`.
- `server` probes `http://127.0.0.1:${PORT || 3001}/ready` with a 2 s timeout;
  not listening or non-200 makes `ok` false (SC-006 parity).
- Human output (no `--json`): one line per check, `ok` or `FAIL` plus the
  message, then the `info` lines.
- Whole command bounded to 5 seconds (SC-006): the database, Redis, and `/ready` probes run concurrently, each with a 2 s timeout; the migrations and owner checks reuse the database connection and are skipped (reported as `ok: false` with the database message, or as unknown for owner) when it failed.

## `squire token create --name N [--email E] [--scopes S] [--expires-in D] [--out PATH] [--stdout]`

- Target user: local mode, the resolved owner (refuse with the claim-link
  next action if none); team mode, `--email` required (exit 2: "In team mode,
  name the account: squire token create --name N --email you@example.com").
  `--email` is honored in local mode too.
- `--scopes`: comma list, subset of `documents:read,documents:write`; default
  both.
- `--expires-in`: `<n>d` or `<n>h`, 1 hour to 365 days; default `30d`.
- Minted with `createToken(userId, name, { scopes, expiresAt })`: same cap,
  hashing, `sk_sqd_` prefix, and Settings listing; no minted-by columns.
- File: `--out` or `<data dir>/tokens/<slug(name)>.token`; directory created
  0700; file created with `O_EXCL` and mode 0600; an existing file is refused
  ("<path> already exists. Choose another --out path, or delete the file and
  revoke the old token in Settings."). The token is minted only after the file
  is open, and the file is removed if minting fails, so no token is orphaned.
- stderr: "Token "N" for <email> written to <path> (expires <date>). Copy it to
  your machine: docker compose cp app:<path> ~/.squire/token && chmod 600
  ~/.squire/token".
- `--stdout`: writes no file; prints the do-not-echo warning on stderr and the
  token alone on stdout.

## Database unreachable (every command)

exit 1, "Cannot connect to the database (DB_HOST=..., DB_PORT=..., DB_NAME=...).
Check that the postgres container is healthy: docker compose ps".
