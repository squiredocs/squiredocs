# Contract: Environment Variables (058)

The operator-facing configuration surface. New variables are marked **new**;
changed behavior is marked **changed**. Defaults are the image defaults.
`README.md`, `docs/dev.md`, and `.env.example` must match this table
(FR-037).

| Variable | Status | Default | Accepted values | Effect |
| --- | --- | --- | --- | --- |
| `NODE_ENV` | changed (image) | `production` (Dockerfile `ENV`) | `production`, `development`, `test` | Production guards on in a bare container |
| `APP_URL` | new | `CLIENT_URL`, else `http://localhost:${PORT:-3001}` | absolute http(s) URL; path and trailing slash dropped | Public origin; drives cookie `Secure`, redirect and callback defaults, welcome-doc URLs, MCP fallback base URL, OpenRouter referer |
| `CLIENT_URL` | changed | `APP_URL` | URL | Post-sign-in redirect and CORS origin (explicit value wins) |
| `GOOGLE_REDIRECT_URI` | changed | `${APP_URL}/auth/google/callback` | URL | Google callback (explicit value wins) |
| `PUBLIC_ORIGIN` | changed | `APP_URL` | URL | Canonical origin returned for hosted alias hosts (`server/url.js`) |
| `SQUIRE_HOSTED` | new | unset (off) | `true`, `false` (case-insensitive); anything else fails boot | Turns on every hosted-only surface (data-model section 4) |
| `SQUIRE_DATA_DIR` | new | `/data` | absolute path | Root for `secrets.json` and `images/` |
| `MIGRATE_ON_BOOT` | new | `true` | `true`, `false` (case-insensitive) | Entrypoint runs `script/migrate.js` under an advisory lock before the server loads |
| `STORAGE_DRIVER` | new | `s3` when `S3_IMAGE_BUCKET` is set, else `local` | `local`, `s3` | Image byte storage |
| `S3_ENDPOINT` | new | unset (AWS) | absolute http(s) URL | S3-compatible endpoint with path-style addressing; also the CSP image origin |
| `SMTP_HOST` | new | `SES_SMTP_HOST`, else the SES default host only when configured through `SES_*` names | hostname | Mail server |
| `SMTP_PORT` | new | `465` | integer 1 to 65535 | Port |
| `SMTP_SECURE` | new | `true` for port 465, else `false` (STARTTLS) | `true`, `false` | Implicit TLS override |
| `SMTP_USER` | new | `SES_SMTP_USER` | string | Auth user |
| `SMTP_PASS` | new | `SES_SMTP_PASS` | string | Auth password |
| `SMTP_FROM` | new | `SES_FROM_EMAIL` | email address | Sender; unset means email is off (one boot log line) |
| `ACCESS_TOKEN_SECRET`, `REFRESH_TOKEN_SECRET`, `MCP_JWT_SECRET`, `API_KEY_ENCRYPTION_KEY` | changed | generated into `${SQUIRE_DATA_DIR}/secrets.json` when unset | strong values | Environment always wins over the file |
| `SES_SMTP_HOST`, `SES_SMTP_USER`, `SES_SMTP_PASS`, `SES_FROM_EMAIL` | kept as aliases | | | Generic name wins when both are set |
| `MCP_REFRESH_SECRET`, `MCP_AUTH_CODE_SECRET`, `JWT_SECRET` | unchanged, unused | | | Read by no server code; not generated (RBD-058-17) |

## Boot failures (exit non-zero, message names the variable)

- `APP_URL` (or `CLIENT_URL` when it is the source) not an absolute http(s) URL.
- `STORAGE_DRIVER` not `local` or `s3`: "STORAGE_DRIVER must be one of: local, s3".
- `MIGRATE_ON_BOOT` or `SQUIRE_HOSTED` not `true` or `false` (058 review M2: a malformed `SQUIRE_HOSTED` used to be treated as off with a warning).
- `SQUIRE_DATA_DIR` not absolute.
- `S3_ENDPOINT` not an absolute http(s) URL.
- `SMTP_PORT` not an integer in range.
- `secrets.json` unreadable or unparseable; data directory not writable when a
  secret must be generated.
- Postgres unreachable for 60 seconds, or a migration failure, when
  `MIGRATE_ON_BOOT=true`.

## Boot log lines (one each, at most)

- `[Config] APP_URL is http on a non-local host (<host>). Serving plain HTTP
  beyond localhost is not supported; put a TLS-terminating proxy in front and
  set an https APP_URL.` (production only)
- `[Email] off (no SMTP_FROM)` or `[Email] SMTP_FROM is set but SMTP_HOST is not; email is off`.
- `[Storage] local image storage at <dir> is not writable: <reason>` (uploads
  then return 503).
- `[Secrets] generated <names> into <path>` (names only, never values).
