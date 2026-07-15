# Contract — Build/deploy + backup hardening

**Verification**: `bash -n` + shell-logic review (SC-007); overlay render + CronJob/script review (SC-006); Dockerfile review.

## `script/deploy-aws.sh` (FR-021 / SC-007 / RD-10)

Guarantees:
1. Runs under `set -euo pipefail` — any failed command (incl. in a pipeline) exits non-zero immediately.
2. Applies manifests via `kubectl apply -k k8s/overlays/aws-prod` — no `envsubst`/`sed` templating.
3. Resolves the pushed image digest from ECR (`aws ecr describe-images`); if unresolvable, **fails before applying** (no mutable-tag fallback). Sets `repo@digest` via the Kustomize image override.
4. Preserves the existing kube-context guard and the migrate-Job gate.
5. The `deployed-collab-aws-*` git tag is **unreachable** unless `kubectl rollout status` on the app deployment succeeded — a failed rollout never tags.

## `Dockerfile` (FR-020)
6. Both `node:22-alpine` stage bases pinned by `@sha256:` digest; non-root `appuser` runtime preserved unchanged.

## `Dockerfile.backup` (RD-9)
7. `alpine@sha256:…` base + `postgresql16-client` + `s3cmd` installed at build time; non-root user; `backup-postgres.sh` baked in. No runtime `apk add`.

## `script/backup-postgres.sh` (FR-023 / SC-006)
8. Database password read via `PGPASSFILE` (mounted file) — never on a command line or in traced (`set -x`) output.
9. Dump filenames timestamped (full date+time), not day-of-year — a corrupt dump cannot overwrite a good one.
10. Upload targets `squiredocs-db-backups` (not the legacy shared `earthquaketracksql` bucket).

## Backup CronJob (aws-prod overlay) (FR-022 / SC-006)
11. Runs non-root with the full restricted securityContext, uses the pinned `Dockerfile.backup` image, sets `concurrencyPolicy: Forbid`, declares CPU/memory requests and limits. (5/5 hardening properties with #8–10.)
