# Quickstart Validation: 058 Self-Host Configuration Foundation

Runnable checks that prove the feature end to end. Unit and integration
coverage is in `tasks.md`; this guide is for the merge-queue verification and
the maintainer's pre-deploy walk. Contracts: `contracts/environment.md`,
`contracts/http-routes.md`, `contracts/storage-and-boot.md`.

## 0. Test suites (inside the app-dev pod)

```sh
npm run test:server        # DATABASE_URL is a BASE name; per-worker databases
npm run test:client
npm run test:first-run
```

Expected: all pass. New suites listed in `tasks.md` appear in the summary.

## 1. Bare image boots (US1, SC-001, SC-008)

Docker is not available inside the app-dev pod; run this on a machine with
Docker (the maintainer's laptop), from the repository root.

```sh
docker build -t squire:058 .
docker network create sq058
docker run -d --name sq058-pg --network sq058 -e POSTGRES_PASSWORD=pw \
  -e POSTGRES_DB=collab_db pgvector/pgvector:pg16
docker volume create sq058-data
docker run -d --name sq058-app --network sq058 -p 127.0.0.1:3910:3001 \
  -e DB_HOST=sq058-pg -e DB_USER=postgres -e DB_PASSWORD=pw \
  -e APP_URL=http://localhost:3910 -v sq058-data:/data squire:058
```

Expected within 90 seconds:

- `docker inspect -f '{{.State.Health.Status}}' sq058-app` prints `healthy`.
- `docker logs sq058-app` contains `[Secrets] generated ACCESS_TOKEN_SECRET, ...`
  and no `[SECURITY]`, `FATAL`, or `must be set` line.
- `docker exec sq058-app stat -c '%a %U' /data/secrets.json` prints `600 appuser`.
- `docker exec sq058-pg psql -U postgres collab_db -c "select count(*) from pgmigrations"`
  equals the number of files in `migrations/`.
- `docker restart sq058-app`; after healthy, the logs show no new `generated`
  line and `secrets.json` has the same checksum (`docker exec sq058-app sha256sum /data/secrets.json`).

Environment wins: `docker run ... -e ACCESS_TOKEN_SECRET=$(openssl rand -hex 32) ...`
on a fresh volume writes a file without `ACCESS_TOKEN_SECRET`.

Concurrency: start a second app container against the same Postgres at the
same time; exactly one logs the migration output, the other waits and reports
no migrations to run.

Unwritable data dir: `docker run --user 100:101 --tmpfs /data:ro ...` exits 1
with a message naming `/data` and the `chown` fix.

## 2. Plain-http sign-in cookies (US3, SC-003)

Against the container from step 1 (production mode, `APP_URL=http://localhost:3910`):

```sh
curl -si http://localhost:3910/auth/google | grep -i '^set-cookie'
```

Expected: `oauth_redirect` and `oauth_state` cookies without `Secure`, with
`SameSite=Lax`. Repeat with `-e APP_URL=https://docs.example.com`: all carry
`Secure`. (Google credentials are not needed for the start leg's cookies; the
route returns 500 after setting them only if the client id is missing, which
the test suite covers with stub credentials.)

## 3. Images on local storage (US4, SC-004)

In the browser at `http://localhost:3910` (after 059 there is a claim link;
until then use the test suites, which cover this path with supertest):

- `GET /api/docs/<doc>/images/<img>` returns `{ "url": "/api/docs/<doc>/images/<img>/raw" }`.
- The raw URL returns the bytes with the stored content type; a second user
  without access gets 403; an unknown id gets 404.
- `docker restart sq058-app` and fetch again: 200.

## 4. Self-hosted instance shows nothing hosted (US5, SC-005)

```sh
for p in /pricing /about /security /blog /blog/x /privacy /terms /landing.html; do
  printf '%s ' "$p"; curl -s -o /dev/null -w '%{http_code}\n' "http://localhost:3910$p"
done                                   # all 404
curl -s http://localhost:3910/ | grep -c googletagmanager          # 0
curl -s http://localhost:3910/ | grep -o '__SQUIRE_INSTANCE__={[^}]*}'  # {"hosted":false}
curl -sI http://localhost:3910/ | grep -i content-security-policy | grep -c google  # 0
curl -s http://localhost:3910/agents.md | grep -c squiredocs.com   # 0
curl -s -o /dev/null -w '%{http_code}\n' http://localhost:3910/documentation  # 301 or 200, as today
```

Then restart with `-e SQUIRE_HOSTED=true`: every path above serves as on
squiredocs.com and the tag is present.

## 5. SMTP aliases (US6, SC-006)

Covered by `server/__tests__/instance-config.test.js`. Optional live check:
run a local SMTP sink (`docker run -d --network sq058 --name sq058-mail axllent/mailpit`),
restart the app with `SMTP_HOST=sq058-mail SMTP_PORT=1025 SMTP_FROM=squire@example.test`,
share a document with an email address, and see the message in the sink.

## 6. Hosted render and deploy (US2, SC-002)

From the app-dev pod (renders only; nothing is applied):

```sh
kubectl kustomize k8s/overlays/aws-prod | grep -B1 -A1 -E 'SQUIRE_HOSTED|MIGRATE_ON_BOOT|APP_URL|STORAGE_DRIVER'
kubectl kustomize k8s/overlays/minikube | grep -B1 -A1 -E 'SQUIRE_HOSTED|MIGRATE_ON_BOOT'
```

Expected: aws-prod `collab-app` carries `SQUIRE_HOSTED=true`,
`MIGRATE_ON_BOOT=false`, `APP_URL=https://squiredocs.com`,
`STORAGE_DRIVER=s3`; the `db-migrate-job` still runs `npm run migrate`.
minikube `collab-app` carries `SQUIRE_HOSTED=true` and `MIGRATE_ON_BOOT=false`.

Deploy (maintainer only, `script/build-and-deploy-aws.sh`), then walk the
spec's Hosted Deploy Checklist: marketing pages and analytics tag present,
`Set-Cookie` carries `Secure; SameSite=Strict`, migrate Job gated the rollout,
an uploaded image resolves to an S3 presigned URL, a share email arrives, and
the Admin page shows the welcome-email button and the self-test card.

Before rebuilding the minikube image, confirm `k8s/auth.env` and the MCP
secret hold strong non-default values (RBD-058-15); the base pod now boots in
production mode.

## Cleanup

```sh
docker rm -f sq058-app sq058-pg sq058-mail; docker volume rm sq058-data; docker network rm sq058
```
