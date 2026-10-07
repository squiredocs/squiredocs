# Contract: compose file, wrapper, settings file, release script

## `distribution/self-host/compose.yml`

```yaml
# Squire Docs self-host stack. docs: https://squiredocs.com/documentation/self-hosting
services:
  app:
    image: ghcr.io/<REPOSITORY>:${SQUIRE_VERSION:-__SQUIRE_VERSION__}
    restart: unless-stopped
    env_file:
      - path: .env
        required: false
    environment:
      APP_URL: ${APP_URL:-http://localhost:${SQUIRE_PORT:-3910}}
      DATABASE_URL: postgresql://squire:squire@postgres:5432/squire
      REDIS_HOST: redis
      REDIS_PORT: "6379"
    ports:
      - "127.0.0.1:${SQUIRE_PORT:-3910}:3001"
    volumes:
      - squire-data:/data
    depends_on:
      postgres: { condition: service_healthy }
      redis: { condition: service_healthy }
    healthcheck:
      test: ["CMD", "node", "-e", "<same /ready probe as the Dockerfile>"]
      interval: 10s
      timeout: 3s
      retries: 3
      start_period: 90s
  postgres:
    image: pgvector/pgvector:pg16
    restart: unless-stopped
    environment: { POSTGRES_USER: squire, POSTGRES_PASSWORD: squire, POSTGRES_DB: squire }
    volumes: [postgres-data:/var/lib/postgresql/data]
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -h 127.0.0.1 -U squire -d squire"]
  redis:
    image: redis:7
    restart: unless-stopped
    volumes: [redis-data:/data]
    healthcheck:
      test: ["CMD", "redis-cli", "ping"]
volumes:
  squire-data: {}
  postgres-data: {}
  redis-data: {}
```

Structure test (`compose-and-assets.test.mjs`, js-yaml) asserts: exactly the
three services; `postgres` and `redis` have no `ports`; every service has a
`healthcheck`; the postgres check contains `pg_isready -h 127.0.0.1`; the app
check targets `/ready`; `depends_on` both `service_healthy`; the three named
volumes and the `/data` mount; the port string; `APP_URL` default form; no
`SQUIRE_MODE`, `SQUIRE_HOSTED`, or `NODE_ENV` anywhere; the image line uses
`REPOSITORY` and the version token.

## `distribution/self-host/squire`

Mode 100755. Body in research R4. Test asserts: POSIX shebang, `cd
"$(dirname "$0")"`, `exec docker compose exec` with and without `-T` gated on
`[ -t 0 ] && [ -t 1 ]`, `"$@"` passthrough; and, with a stub `docker` on PATH,
that the exit code passes through and `-T` is used when stdout is a pipe.

## `distribution/self-host/.env.example`

Order and content (RBD-060-11), every optional line commented out with its
default:

1. Header: what the file is; local mode is the default; copy lines to `.env`.
2. `SQUIRE_PORT=3910` (commented, with "if 3910 is taken").
3. `SQUIRE_VERSION=__SQUIRE_VERSION__` (uncommented; stamped).
4. `# SQUIRE_MODE=local` with "team mode arrives in a later release".
5. Assistant keys read by `server/api/ai-providers.js` (the test derives the
   list from that module's environment-variable names).
6. Semantic search: `GOOGLE_GENERATIVE_AI_API_KEY`.
7. Email: `SMTP_HOST`, `SMTP_PORT` (465), `SMTP_SECURE`, `SMTP_USER`,
   `SMTP_PASS`, `SMTP_FROM`.
8. Images: `STORAGE_DRIVER` (local), `S3_IMAGE_BUCKET`, `S3_IMAGE_REGION`,
   `S3_ENDPOINT`, `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`.
9. `APP_URL`: derived from `SQUIRE_PORT`; set an https URL only behind a TLS
   proxy (FR-040).
10. Closing line pointing at the README's configuration table.

Never present (test-enforced): `SQUIRE_HOSTED`, `NODE_ENV`, `CLIENT_URL`,
`MIGRATE_ON_BOOT`, `ACCESS_TOKEN_SECRET`, `REFRESH_TOKEN_SECRET`,
`MCP_JWT_SECRET`, `API_KEY_ENCRYPTION_KEY`, `ENABLE_DEV_ENDPOINTS`,
`DATABASE_URL`, `DB_`, `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, and any
uncommented `SQUIRE_MODE=team`.

## `distribution/self-host/release.mjs`

```text
export const REPOSITORY            // '<org>/<repo>' until decided
export const VERSION_TOKEN         // '__SQUIRE_VERSION__'
export const ASSET_NAMES           // ['compose.yml', 'squire', 'env.example', 'SHA256SUMS']
export function parseReleaseTag(tag)               -> { version, prerelease } | throws
export function validateRepository(repo, ghRepo)   -> void | throws
export function stampAssets({ version, outDir, srcDir? }) -> { files: string[] }
CLI:
  node distribution/self-host/release.mjs validate --tag vX.Y.Z --github-repository owner/name
      stdout: version=X.Y.Z / prerelease=true|false / image=ghcr.io/<repo>   (exit 0)
      stderr: one message naming the problem                                 (exit 1)
  node distribution/self-host/release.mjs stamp --version X.Y.Z --out DIR
      writes the four assets; fails if any token or placeholder remains     (exit 0/1)
```
