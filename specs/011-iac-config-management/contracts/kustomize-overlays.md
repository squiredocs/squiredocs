# Contract — Kustomize base + overlays (`k8s/`)

**Consumers**: `deploy-aws.sh` (aws-prod), local dev (minikube). **Verification**: `kustomize build` / `kubectl kustomize` per overlay, or fallback manual cross-reference.

## Interface

- `kustomize build k8s/overlays/minikube` → dev manifests.
- `kustomize build k8s/overlays/aws-prod` → hardened production manifests.
- Image references set via the Kustomize `images:` override (no `${IMG}` templating).

## Guarantees

### Both overlays
1. Render succeeds; **zero** unexpanded `${...}` placeholders in either render. (SC-001)
2. Every `resources:`/`patches:` target resolves to a file that exists; no dangling references.

### minikube (FR-009 / SC-003)
3. Behaviorally identical to today's effective manifests: `app-dev` pod, `premium-rwo`/`standard-rwo` storage classes, PVC sizes, services, `/health` for both probes, passwordless Redis, image tags, env vars. PSS `warn=baseline` only (no enforcement) so the dev pod is never evicted.

### aws-prod (FR-010..016 / SC-002)
4. k3s deltas as declarative patches: storageClass `local-path`, postgres PVC 5Gi, postgres mem request 256Mi, HPA maxReplicas 2.
5. 100% of workload pod specs (app, postgres, redis, migrate Job, backup CronJob) carry the restricted quadruple: `runAsNonRoot:true`, `allowPrivilegeEscalation:false`, `capabilities.drop:[ALL]`, `seccompProfile.type:RuntimeDefault`.
6. Namespace carries PSS `enforce=restricted` labels.
7. A default-deny (ingress+egress) NetworkPolicy exists, with scoped allows exactly: app→postgres:5432, app→redis:6379, backup→postgres:5432, DNS egress, ingress-controller→app:3001, plus app/backup HTTPS egress to AWS/AI endpoints.
8. Redis: `--requirepass` (from `redis-auth` SOPS secret), `--maxmemory 192mb`, `--maxmemory-policy allkeys-lru`; app injects matching `REDIS_PASSWORD` (optional so absence doesn't break dev).
9. Postgres tuning via real `-c` server args (shared_buffers, work_mem, maintenance_work_mem, effective_cache_size, max_connections); no-op `POSTGRES_*` env vars removed.
10. postgres, redis, backup images pinned by `@sha256:` digest (100% of non-app images). App image set by digest at deploy time.
11. App readinessProbe → `/ready`:3001 (feature 010); livenessProbe stays `/health`.

## Cross-feature dependency (G2)
Guarantees 8 & 11 consume feature-010 app code (`/ready`, `REDIS_PASSWORD`). The aws-prod overlay MUST NOT be applied to a cluster whose image predates 010 (runbook §3.1 gate). minikube overlay is 010-independent.
