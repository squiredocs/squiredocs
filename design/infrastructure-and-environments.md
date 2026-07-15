<!-- source: https://squiredocs.com/d/c97e58df-4104-4e5d-8ab6-711a7b115696
     synced-by: design/sync.mjs — DO NOT HAND-EDIT; amend the Squire doc and re-sync -->

# Squire Infrastructure and Environments

## What this is

Where Squire runs and how it ships: the production k3s cluster, the Minikube development environment, the deploy scripts, and the supporting tiers (Postgres, Redis, S3, SES). Also the testing infrastructure, since the test-commit-deploy loop is the whole release process.

## Runtime shape

One Node process (`server/index.js`, port 3001) serves the API, the WebSocket collaboration endpoint, the MCP server, and the built client. Kubernetes Deployment `collab-app` (namespace `collab`) runs 2 replicas behind a Service with ClientIP session affinity for WebSocket stability, HPA-scaled; Redis pub/sub makes multi-replica collaboration correct. Postgres runs `pgvector/pgvector:pg16` (embeddings need the extension) with a daily pg_dump-to-S3 backup CronJob; Redis 7 with AOF. Migrations run as a dedicated Job (`npm run migrate`, node-pg-migrate, 38 migrations).

## Production (AWS k3s)

`script/build-and-deploy-aws.sh` builds a linux/arm64 image tagged with the git SHA, pushes to ECR, and hands off to `script/deploy-aws.sh` — which guards the kube context, right-sizes the k8s manifests for k3s (storage class, Postgres resources, HPA cap 2), deploys secrets from `k8s/auth.production.env` (fails fast on missing required ones; image uploads degrade gracefully if the S3 secret is absent), waits for migrations, then rolls the app. Traefik ingress serves squiredocs.com. Deploys are tagged in git. A GKE/minikube variant (`script/deploy.sh`) predates it.

## Development (Minikube + app-dev pod)

Dev happens _inside_ the cluster: the `app-dev` Deployment sleeps forever with the repo mutagen-synced to `/local-dev`, sharing the cluster’s Postgres/Redis/secrets. `npm run dev` runs Express (3001) and Vite (5173, HMR disabled — unreliable through the k8s tunnel) exposed as NodePorts. `docs/dev.md` is the authoritative guide; the collab-devcontainer CLI wraps the same substrate. Claude Code runs in this pod. Caveat: mutagen can leave a dev server running on stale code — restart when in doubt.

## Build

Two-stage Dockerfile: a client builder (Vite; mermaid split into its own chunk; `shared/` copied because the client imports the shared sanitizer) and a node:22-alpine runtime as a non-root user with fontconfig + DejaVu (resvg rasterization) and node-pg-migrate retained for the migrate Job.

## Testing infrastructure

- **Backend: **Jest, `--runInBand` (the test DB is shared state — never run two backend suites against one database; a worktree agent gets its own via `DATABASE_URL`). globalSetup creates the test DB and migrates it.
- **Client: **Vitest + jsdom, colocated __tests__ dirs.
- **Integration: **multi-client collaboration, edge cases, and Redis sync under the root `__tests__/integration/`.
- **LLM-friendly reporters: **custom Jest/Vitest reporters compress passing runs to one line, expanding only failures — required by the constitution so agent context stays small.

## Target: dedicated hardened cluster (2026-07 migration)

The sections above describe the pre-migration state, where Squire shared a node, security group, and IAM instance role with the wildfiretrackers workload. The target — and the ground truth code converges toward — is a dedicated, hardened, single-node k3s cluster that is Squire's alone: its own EC2 instance, security group, and instance role, so blast radius and audit scope belong to Squire only. Single-node is an accepted availability trade-off for beta (node loss = outage until rebuild); data durability is decoupled from it by the backup posture below.

### Infrastructure as code

All AWS infrastructure is declared in **OpenTofu** under `infra/terraform/`, with state in a versioned, encrypted S3 backend using native locking. It covers the EC2 node, the encrypted EBS volumes, the dedicated security group, the scoped IAM instance role, the backup bucket, and the edge (the CloudFront origin config, the WAF WebACL, and the `app.squiredocs.com` Route53 record). The pre-existing `squiredocs.com` hosted zone is referenced read-only — it hosts unrelated records — and the existing CloudFront distribution is imported rather than recreated. Manual console changes are drift, surfaced by `tofu plan`.

Kubernetes manifests are **Kustomize** (`k8s/base` plus `k8s/overlays/minikube` and `k8s/overlays/aws-prod`), replacing the `envsubst` templating in the deploy scripts. `deploy-aws.sh` becomes a thin wrapper: build and push the image, then `kubectl apply -k`, running under `set -euo pipefail` with a `kubectl rollout status` gate before it tags the deploy. Secrets are **SOPS/age**-encrypted files committed under `k8s/secrets/`; k3s itself runs with `--secrets-encryption`, so Secrets are encrypted at rest in etcd.

### Node & cluster hardening

- **Encryption at rest:** account-level EBS default encryption is on; the node's root and data volumes are KMS-encrypted, so the in-cluster Postgres and Redis PVCs are encrypted at rest.
- **Instance metadata:** IMDSv2 is required (`HttpTokens: required`).
- **Network exposure:** the dedicated security group opens 443 to the world (ideally scoped to the CloudFront prefix list); 22 (SSH) and 6443 (the k3s API server) are restricted to an operator CIDR, never `0.0.0.0/0`.
- **Edge:** CloudFront terminates TLS and reaches the origin `https-only` (Traefik terminates TLS at the node); an AWS WAF WebACL with managed rule sets and rate rules fronts the distribution; CloudFront access logging is enabled.
- **In-cluster:** a default-deny NetworkPolicy in the `collab` namespace allows only app→postgres, app→redis, and backup→postgres; the namespace enforces Pod Security Standards; every workload runs with a non-root, no-privilege-escalation, all-capabilities-dropped securityContext and a seccomp profile. Redis requires a password (`--requirepass`) and runs with a bounded `--maxmemory` under `allkeys-lru`.
- **IAM:** the node instance role is scoped to ECR pull only; the app's S3 access stays a least-privileged object-only user on the images bucket; the backup writer is scoped to `PutObject` on the backup bucket alone.

## Application hardening posture

The Node process is hardened for multi-tenant public exposure independent of where it runs:

- **Graceful shutdown:** a SIGTERM handler drains WebSocket sessions and flushes in-flight Yjs persistence before exit, so a rolling deploy never loses the tail of a document's edits.
- **Rate limiting:** Redis-backed limits (so they survive restarts and span replicas) — per-IP on unauthenticated routes (auth, OAuth token, MCP client registration) and per-user on expensive routes (content search, import/export, chat). `trust proxy` is set to the real hop count, not blanket-true, so a client-supplied `X-Forwarded-For` cannot spoof the limiter key.
- **Request bounds:** the chat body limit is small and attachment bytes travel the S3 upload path, not inline JSON, so an oversized body cannot exhaust pod memory before quota checks run.
- **Health vs readiness:** `/health` is a liveness signal only; a separate `/ready` probe reports Postgres reachability and Redis state, so a pod with a dead dependency stops taking traffic instead of staying in rotation.
- **Datastore limits:** the Postgres pool has an explicit max, a connection timeout, and a server-side statement timeout so a heavy query cannot pin every connection and starve auth. Redis unavailability degrades gracefully (cache and pub/sub feature-gated), never crashes the process.

## Backups & data protection

Postgres stays in-cluster on encrypted EBS, so backup durability is owned here, not delegated to a managed service:

- A nightly `pg_dump` lands in a **dedicated** `squiredocs-db-backups` bucket — separate from the images bucket and from the earthquake-project bucket that previously held the dumps — with SSE-KMS, versioning, **Object Lock**, and a lifecycle policy (retention plus a Glacier transition). Filenames are timestamped, not day-of-year, so a corrupt dump cannot overwrite a good one.
- The backup Job runs non-root with its tooling baked into a pinned image (no runtime `apk add`), reads the database password from a file rather than a traced command line, and alerts on failure.
- A restore procedure is documented and periodically drilled — an untested backup is not a backup. WAL archiving for point-in-time recovery is the path to a sub-24h RPO if the beta needs it.
- Redis is not backed up (it is a 24h-TTL cache plus pub/sub and rate-limit budgets); Postgres is the source of truth and the full document history (`yjs_updates`) is inside the dump.

## Migration & cutover

Moving from the shared node to the dedicated cluster is a maintenance-window cutover — not zero-downtime — and is reversible:

1. The new cluster is provisioned and validated in parallel while the shared node keeps serving.
2. The `app.squiredocs.com` Route53 TTL is lowered ahead of the window.
3. In the window: the old app is scaled to zero (quiescing Yjs writes), a final `pg_dump` of `collab_db` is restored into the new cluster's Postgres, `API_KEY_ENCRYPTION_KEY` is carried over **unchanged** (there is no key-rotation path — a new key would render every stored BYOK key undecryptable), and the DNS record is repointed to the new node's Elastic IP.
4. Rollback is repointing DNS back; the old node stays warm for a defined window before decommission.
5. The `squiredocs-images` S3 bucket is shared and unchanged, so images do not migrate; Redis is a cache and warms up cold.

## Observability & account controls

- CloudTrail (multi-region, to S3), GuardDuty, and AWS Config with IAM Access Analyzer are enabled at the account level — audit history and threat detection are prerequisites for enterprise review, not afterthoughts.
- ECR keeps scan-on-push and gains a lifecycle policy so image accumulation is bounded.
- The IAM password policy is strengthened and MFA is confirmed on every human principal.