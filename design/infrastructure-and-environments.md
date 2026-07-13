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