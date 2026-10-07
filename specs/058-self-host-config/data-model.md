# Data Model: 058 Self-Host Configuration Foundation

This feature adds **no database schema change and no node-pg-migrate
migration**. Feature 059 owns this campaign's migration. Every entity below is
either in-process state or a file on the data volume.

## 1. Instance configuration (in-process, immutable)

Produced by `resolveInstanceConfig(env)` in `server/instance-config.js`
(research R1, R2, R12). Frozen; consumers never read `process.env` for these.

| Field | Type | Source and default | Validation |
| --- | --- | --- | --- |
| `appUrl` | string (origin) | `APP_URL` → `CLIENT_URL` → `http://localhost:${PORT or 3001}` | absolute `http:` or `https:` URL; normalized to `URL.origin`; else `ConfigError` naming the source variable |
| `appUrlSource` | `'APP_URL' \| 'CLIENT_URL' \| 'default'` | which link of the chain supplied `appUrl` | for logs and 059's doctor |
| `clientUrl` | string | `CLIENT_URL` verbatim when set (no normalization, so the CORS comparison is unchanged), else `appUrl` | none beyond today |
| `googleRedirectUri` | string | `GOOGLE_REDIRECT_URI`, else `${appUrl}/auth/google/callback` | none |
| `publicOrigin` | string | `PUBLIC_ORIGIN`, else `appUrl` | none |
| `cookieSecure` | boolean | `new URL(appUrl).protocol === 'https:'` | derived |
| `insecureRemoteHttp` | boolean | production, `http:` scheme, host not `localhost`, `127.0.0.0/8`, or `[::1]` | drives the one boot warning (FR-012) |
| `hosted` | boolean | `SQUIRE_HOSTED` lower-cased equals `'true'` | `'false'` or unset → false; any other value → false plus `hostedInvalidValue` set for one log line |
| `dataDir` | absolute path | `SQUIRE_DATA_DIR`, else `/data` | must be absolute, else `ConfigError` |
| `migrateOnBoot` | boolean | `MIGRATE_ON_BOOT`, default `true` | `'true'`/`'false'` case-insensitive; anything else → `ConfigError` |
| `storageDriver` | `'local' \| 's3'` | `STORAGE_DRIVER`, else `'s3'` when `S3_IMAGE_BUCKET` is set, else `'local'` | unknown value → `ConfigError` listing `local, s3` |
| `s3` | object | `{ bucket, region, accessKeyId, secretAccessKey, endpoint }` from `S3_IMAGE_BUCKET`, `S3_IMAGE_REGION` (default `us-east-1`), `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `S3_ENDPOINT` | `endpoint`, when set, must be an absolute http(s) URL |
| `smtp` | object | `{ host, port, secure, user, pass, from, viaSesAliases }`, see research R12 | `SMTP_PORT` must be an integer 1 to 65535 when set |

State transitions: none. The object is resolved once per process. Tests reset
the memo with `_resetInstanceConfigForTests()`.

## 2. Generated secrets file (`<dataDir>/secrets.json`)

```json
{
  "ACCESS_TOKEN_SECRET": "<64 hex>",
  "REFRESH_TOKEN_SECRET": "<64 hex>",
  "MCP_JWT_SECRET": "<64 hex>",
  "API_KEY_ENCRYPTION_KEY": "<64 hex>"
}
```

- Mode `0600`, owner `appuser` (uid 100). Written atomically (temp file in the
  same directory, `fsync`, `rename`).
- Holds only generated values. A key present in the environment is never
  written, even on the run that generates a different key.
- Unknown keys in an existing file are preserved on rewrite (forward
  compatibility with later images).
- Lifecycle: absent → created on first boot with all missing values; present →
  read; present but missing a key → that key generated and the file rewritten
  with the union; unreadable or unparseable → boot stops (never regenerated).
- `API_KEY_ENCRYPTION_KEY` is neither read nor generated when
  `API_KEY_ENCRYPTION_KEYS` is set (RBD-058-26).

## 3. Local image store (`<dataDir>/images/`)

```
<dataDir>/images/
├── objects/<key>          # bytes, exactly as uploaded
└── meta/<key>.json        # {"contentType":"image/png"}
```

- `<key>` is the existing opaque storage key from `document_images.s3_key` or
  `chat-attachments/<userId>/<uuid>`. Slashes become directories. The column
  keeps its name; no rename (that would be a migration).
- Key safety: rejected when empty, absolute, containing `\0` or `\`, or when the
  resolved path is not strictly under `objects/` (or `meta/`).
- Files are created with mode `0640`, directories `0750`.
- `copyObject(src, dst)` copies both files; `deleteObjects(keys)` removes both
  and ignores missing files.
- Rows written under one driver are not visible to the other (no byte
  migration; spec Assumptions).

## 4. Hosted-only surface (enumeration, not stored)

The set gated by `hosted` (FR-022 to FR-030, FR-034, FR-035):

| Surface | Hosted | Not hosted |
| --- | --- | --- |
| `/` | `landing.html` | app shell |
| `/pricing`, `/about`, `/security`, `/blog`, `/blog/*`, `/privacy`, `/terms` | served | 404 |
| `/landing.html`, `/pricing.html`, `/about.html`, `/security.html`, root `blog*` assets | served by static | 404 |
| CSP Google sources | present | absent |
| Analytics tag in the shell | injected | absent |
| `window.__SQUIRE_INSTANCE__.hosted` | `true` | `false` |
| Old-domain 301 | mounted | not mounted |
| New-user and login admin emails | sent | not sent |
| Signup credit cap | enforced | not enforced, usage recorded, `notApplicable: true` |
| `POST /api/admin/users/:id/welcome-email` | works | 404 |
| `POST /auth/prod-reset-selftest-account` | works | 404 |
| Admin welcome button and self-test card | shown | hidden |
| Settings beta note and usage meter | shown | hidden |
| Sign-in privacy and terms links | shown | hidden |
| Welcome document support paragraph and beta-credit sentence | included | omitted |
| `/agents.md` | verbatim | hosted origin replaced by the instance origin |
| OpenRouter `HTTP-Referer` | `APP_URL` (`https://squiredocs.com`) | `APP_URL` |
