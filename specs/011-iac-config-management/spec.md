# Feature Specification: IaC & Config Management — Dedicated Hardened Cluster

**Feature Branch**: `011-iac-config-management`

**Created**: 2026-07-15

**Status**: Draft

**Input**: User description: "011-iac-config-management: IaC + config management — OpenTofu infra, Kustomize restructure, SOPS secrets, hardened Dockerfile/deploy/backup, migration runbook"

**Design ground truth**: `design/infrastructure-and-environments.md` (commit d20917e) — sections "Target: dedicated hardened cluster (2026-07 migration)", "Backups & data protection", "Migration & cutover", and "Observability & account controls". Where this spec and the design doc disagree, the design doc wins.

## Scope Boundary *(read first)*

This feature is **authoring only**. It produces infrastructure code, Kubernetes configuration, encrypted secret scaffolding, hardened build/deploy/backup artifacts, and an executable runbook. It:

- adds **no** application/server code and **no** database migrations;
- **applies nothing to real AWS** — every `tofu apply`, account-setting change, credential rotation, image push, and the cutover itself are executed by the ops track (the orchestrator/Sam) following the runbook (`specs/011-iac-config-management/runbook.md`);
- declares account-level toggles (EBS default encryption, CloudTrail, GuardDuty, AWS Config + IAM Access Analyzer, IAM password policy) in OpenTofu so they are code-reviewed and drift-tracked, but their application is explicitly an ops-track step, not part of this feature's done-ness;
- must leave the Minikube development environment behaviorally unchanged.

Two capabilities in the `aws-prod` overlay depend on application code that **feature 010** delivers (cross-feature handoff, see Dependencies): the `/ready` readiness endpoint and app-side Redis password support. This feature authors the config that consumes them; the config must not be applied to production before an image containing feature 010 exists.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - All AWS infrastructure declared as OpenTofu (Priority: P1)

As the operator, I can read `infra/terraform/` and see the complete footprint of the dedicated Squire cluster — node, volumes, network exposure, IAM, backup bucket, edge — as reviewable, validatable code, so that provisioning is reproducible and any manual console change surfaces as drift in `tofu plan`.

**Why this priority**: The design names IaC as the mechanism everything else hangs off ("All AWS infrastructure is declared in OpenTofu"). Without it, the hardening posture is unauditable one-off console work — exactly the state being migrated away from.

**Independent Test**: `tofu fmt -check` and `tofu validate` pass in `infra/terraform/` (with a documented offline fallback, see Verification Gate); a reviewer can trace every design-doc bullet in "Node & cluster hardening" and "Observability & account controls" to a declared resource or a documented ops-track step.

**Acceptance Scenarios**:

1. **Given** the repo at this feature's completion, **When** the operator inspects `infra/terraform/`, **Then** it declares: the EC2 node (encrypted root + data EBS volumes, IMDSv2 required, an Elastic IP), a dedicated security group (443 from the world or the CloudFront origin-facing prefix list; 22 and 6443 restricted to an operator CIDR variable that has no default and rejects `0.0.0.0/0`), a scoped IAM instance role (ECR pull only), the least-privilege app S3 images user, a backup-writer principal scoped to `PutObject` on the backup bucket alone, the `squiredocs-db-backups` bucket (SSE-KMS, versioning, Object Lock, lifecycle policy), and the edge (CloudFront origin `https-only`, an AWS WAF WebACL with managed rule sets and a rate rule, the `app.squiredocs.com` Route53 record with a low TTL).
2. **Given** the pre-existing CloudFront distribution `<cloudfront-distribution-id>` and the pre-existing `squiredocs.com` hosted zone, **When** the configuration is planned by the ops track, **Then** the distribution is **imported** (via an `import` block or documented `tofu import` command), never destroyed/recreated, and the hosted zone is referenced **read-only** as a data source (it hosts unrelated records that must not be managed or touched).
3. **Given** the node declaration, **When** the operator inspects its user data, **Then** a `cloud-init.yaml.tftpl` template installs k3s with `--secrets-encryption` and `--tls-san` (covering the Elastic IP and the cluster's DNS name) so cluster Secrets are encrypted at rest in etcd and the API server cert is valid for remote kubectl.
4. **Given** the configuration, **When** the operator runs `tofu init`, **Then** state is configured for a versioned, encrypted S3 backend with native lockfile locking (`backend.tf`), and provider/version pins live in a dedicated versions/providers file with all tunables (region, instance type, volume sizes, operator CIDR, CIDR-scoping toggle) exposed as documented variables.
5. **Given** the account-level controls (EBS default encryption, CloudTrail multi-region to S3, GuardDuty, AWS Config + IAM Access Analyzer, IAM password policy, ECR lifecycle policy), **When** the operator reads the configuration, **Then** they are declared in a clearly separated area (e.g. an `account.tf` or module) whose header states that the ops track applies them — this feature only authors them.

---

### User Story 2 - k8s manifests restructured as Kustomize base + overlays (Priority: P1)

As the operator, I can render the exact manifests for either environment with `kustomize build k8s/overlays/minikube` or `kustomize build k8s/overlays/aws-prod`, so that environment differences are declarative patches instead of `sed`/`envsubst` pipelines buried in a deploy script, and the production overlay carries the full in-cluster hardening posture from the design doc.

**Why this priority**: Every other config change in this feature (securityContexts, NetworkPolicies, Redis auth, digest pinning) needs a structured home; the current `envsubst`/`sed` templating cannot express them reviewably.

**Independent Test**: Both overlays render successfully with zero unexpanded `${...}` placeholders; a diff of the minikube render against today's effective manifests shows no behavioral change; the aws-prod render passes the hardening assertions in SC-002.

**Acceptance Scenarios**:

1. **Given** the restructure, **When** the operator lists `k8s/`, **Then** shared manifests live in `k8s/base/` and environment deltas in `k8s/overlays/minikube/` and `k8s/overlays/aws-prod/`, each with a `kustomization.yaml`; the `${IMG}` placeholders in the app deployment, migrate Job, and backup CronJob are replaced by the Kustomize image-override mechanism.
2. **Given** the minikube overlay, **When** it is rendered and compared to the current manifests as applied in Minikube today, **Then** the dev environment is behaviorally unchanged: the `app-dev` pod, storage classes (`premium-rwo` mapping), PVC sizes, services, and probe targets (`/health`) all match the pre-restructure state.
3. **Given** the aws-prod overlay, **When** it is rendered, **Then** it reproduces the k3s adjustments currently done by `sed` in `deploy-aws.sh` (storage class `local-path`, postgres PVC 5Gi, postgres memory request 256Mi, HPA max 2) as declarative patches.
4. **Given** the aws-prod overlay, **When** it is rendered, **Then** every workload (app, postgres, redis, migrate Job, backup CronJob) carries a securityContext with `runAsNonRoot: true`, `allowPrivilegeEscalation: false`, all capabilities dropped, and a `RuntimeDefault` seccomp profile; the `collab` namespace carries Pod Security Standards labels enforcing the `restricted` profile; a default-deny NetworkPolicy exists with scoped allows for exactly app→postgres, app→redis, backup→postgres, DNS egress, and ingress-controller→app.
5. **Given** the aws-prod overlay, **When** it is rendered, **Then** Redis runs with `--requirepass` (sourced from a SOPS-encrypted Secret), a bounded `--maxmemory` with `allkeys-lru`, and the app deployment injects the matching password env var; Postgres receives real tuning via `-c` server arguments (the current `POSTGRES_*` tuning env vars are decorative — the postgres image ignores them — and are replaced); postgres and redis images are pinned by digest; the app readinessProbe targets `/ready` (liveness stays `/health`).

---

### User Story 3 - Secrets are SOPS/age-encrypted files in version control (Priority: P2)

As the operator, I can commit secret material safely because every secret file under `k8s/secrets/` is SOPS/age-encrypted, so that secret changes are versioned, diffable, and deployable without a side-channel of gitignored plaintext files.

**Why this priority**: Depends on the Kustomize structure (US2) for wiring; unblocks the backup-credential fix (US5) and the deploy simplification (US4).

**Independent Test**: A `.sops.yaml` exists with creation rules scoped to `k8s/secrets/*.enc.yaml` encrypting only `data`/`stringData`; every committed file under `k8s/secrets/` is verifiably encrypted (SOPS metadata present, no plaintext values); placeholder/template flow is documented for secrets whose real values only the ops track holds.

**Acceptance Scenarios**:

1. **Given** the feature's completion, **When** the operator inspects the repo, **Then** `.sops.yaml` defines age recipients and creation rules for `k8s/secrets/*.enc.yaml`, and the secret surface currently deployed from gitignored files (`postgres-secret`, `mcp-auth-secret`, `ses-secret`, `s3-images-secret`, `auth-secret`) plus the new `redis-auth` secret each has an encrypted file or a documented encrypted-placeholder awaiting ops-track values.
2. **Given** the s3cmd backup credentials currently mounted from a plaintext ConfigMap (gitignored, containing live AWS keys in the working tree), **When** the restructure lands, **Then** the backup configuration is consumed from a SOPS-encrypted **Secret** instead, and the runbook includes rotating those credentials to the new scoped backup-writer principal (the old key is broadly scoped and must be deactivated at cutover).
3. **Given** an encrypted secret file, **When** a collaborator without the age private key reads it, **Then** no secret value is recoverable; **When** the ops track (holding the key) runs the documented decrypt-and-apply flow, **Then** the secret applies cleanly to the cluster.

---

### User Story 4 - Hardened build & deploy path (Priority: P2)

As the operator, I can run one deploy command that fails loudly and never tags a broken deploy, so that a failed rollout can't masquerade as a shipped release.

**Why this priority**: The current `deploy-aws.sh` runs without `set -e` (only `set -x`), so unchecked failures fall through to the git deploy-tag at the end.

**Independent Test**: Shell review + `bash -n`: the script runs under `set -euo pipefail`, applies via `kubectl apply -k` (no `envsubst`/`sed` templating), and the deploy tag is unreachable unless `kubectl rollout status` for the app deployment succeeded.

**Acceptance Scenarios**:

1. **Given** the reworked `script/deploy-aws.sh`, **When** any command in it fails (including in a pipeline), **Then** the script exits non-zero immediately and the `deployed-collab-aws-*` git tag is **not** created.
2. **Given** the reworked script, **When** it deploys, **Then** manifests come from `kubectl apply -k k8s/overlays/aws-prod` with the image reference set via the Kustomize image-override mechanism (digest-based), the existing kube-context guard and migrate-Job gate are preserved, and a `kubectl rollout status` gate on the app deployment must pass before deploy-tagging.
3. **Given** the `Dockerfile`, **When** it is inspected, **Then** both `node:22-alpine` stage base images are pinned by digest (`node:22-alpine@sha256:...`), and the existing non-root `appuser` runtime is preserved unchanged.

---

### User Story 5 - Hardened backup CronJob and dedicated backup bucket (Priority: P2)

As the operator, I trust the nightly Postgres backup because it runs non-root from a pinned image, writes timestamped dumps to a dedicated locked-down bucket, and cannot leak the database password or overwrite a good dump with a corrupt one.

**Why this priority**: The current job runs as root, installs tooling at runtime (`apk add` on every run), passes `PGPASSWORD` on a traced (`set -x`) command line, names files by day-of-year (a corrupt dump silently overwrites last year's good one), and uploads to the shared earthquake-project bucket.

**Independent Test**: Render the aws-prod overlay and review the CronJob + backup script: every hardening property in the acceptance scenarios is present; the target bucket is `squiredocs-db-backups`.

**Acceptance Scenarios**:

1. **Given** the hardened CronJob, **When** it is rendered, **Then** it runs as non-root with the full restricted securityContext, uses a dedicated pinned backup image with `pg_dump` and the S3 upload tool baked in (no runtime package installation), sets `concurrencyPolicy: Forbid`, and declares CPU/memory requests and limits.
2. **Given** the hardened backup script, **When** it runs, **Then** the database password is supplied via `PGPASSFILE` (a mounted file), never on a command line or in traced output; dump filenames are timestamped (date+time, not day-of-year); and the upload targets `squiredocs-db-backups`, not the legacy shared bucket.
3. **Given** the backup bucket declaration (US1), **When** it is reviewed, **Then** it has SSE-KMS encryption, versioning, Object Lock, and a lifecycle policy (Glacier-class transition plus bounded retention), and a backup-freshness alarm is declared so a silently failing backup alerts the operator.

---

### User Story 6 - Migration & cutover runbook (Priority: P3)

As the operator executing the ops track, I can follow `specs/011-iac-config-management/runbook.md` step by step — each step with a verification and a rollback — to take the platform from the shared node to the dedicated hardened cluster inside a maintenance window, reversibly.

**Why this priority**: The runbook is the bridge between this feature's authored artifacts and the real migration; it is last because it references everything the other stories produce.

**Independent Test**: A reviewer can walk the runbook and find: prerequisite/bootstrap steps, account-setting enablement, `tofu apply` ordering (including the CloudFront import), node build and validation-in-parallel, backup bucket + credential rotation, the maintenance-window cutover sequence, and an explicit rollback path — with no step that assumes undeclared infrastructure or unwritten config.

**Acceptance Scenarios**:

1. **Given** the runbook, **When** the ops track reaches the cutover section, **Then** it sequences exactly the design's window: lower DNS TTL ahead of the window → scale the old app to zero (quiescing Yjs writes) → final `pg_dump` of `collab_db` → restore into the new cluster's Postgres → carry `API_KEY_ENCRYPTION_KEY` over **unchanged** with a verification step (a stored BYOK key must decrypt post-restore; there is no rotation path) → repoint DNS to the new node's Elastic IP → smoke-test.
2. **Given** the runbook, **When** the operator needs to abort, **Then** rollback is documented as repointing DNS back to the old node (kept warm for a defined window before decommission), with the old app scaled back up.
3. **Given** the runbook, **When** it covers what does *not* move, **Then** it states the `squiredocs-images` bucket is shared and unchanged (no image migration) and Redis is a cache that warms cold, and it includes a post-cutover restore drill of the first nightly backup.
4. **Given** the runbook, **When** it sequences the first production apply of the aws-prod overlay, **Then** it gates on an image containing feature 010 (`/ready` endpoint, Redis password support) existing in ECR.

### Edge Cases

- **Overlay applied before feature 010 ships**: the `/ready` probe would 404 (pods never Ready) and Redis auth would break the app's unauthenticated client. Mitigation: the runbook ordering gate (US6 scenario 4); the minikube overlay keeps `/health` and passwordless Redis until 010 is merged and verified there.
- **CloudFront-scoped 443 vs. origin certificate issuance**: restricting 443 to the CloudFront prefix list can break ACME certificate issuance/renewal on the node. The scoping is a variable-controlled toggle with a documented fallback (see ledger G1); the runbook's parallel-validation phase verifies cert issuance before cutover.
- **CloudFront import mismatch**: if the imported distribution `<cloudfront-distribution-id>`'s real settings differ from the declared config (origin scheme, aliases), `tofu plan` will show destructive diffs. The runbook requires reconciling the declaration to the imported reality before any apply; the distribution must never be replaced.
- **Route53 zone safety**: the `squiredocs.com` zone hosts unrelated records; only the `app.squiredocs.com` record (and any new origin record) may be managed. The zone itself is a data source and must never appear as a managed resource.
- **State backend bootstrap (chicken-and-egg)**: the S3 state bucket cannot be managed by the state it stores; it is created by a documented one-time bootstrap step in the runbook.
- **Object Lock misconfiguration**: compliance-mode lock would make mistaken uploads immutable even to the account root; governance mode is chosen (ledger RD-5) so errors are recoverable with elevated permissions.
- **`kustomize edit set image` vs. missing digest**: if the deploy script cannot resolve the pushed image digest from ECR, it must fail before applying, not fall back to a mutable tag silently.
- **Legacy GKE artifacts** (`k8s/ingress.yaml` with GKE ManagedCertificates, `script/deploy.sh`): excluded from the Kustomize tree and left untouched — deleting them is out of scope (ledger RD-11).
- **Secrets with values only the ops track holds** (live OAuth/AI keys): the encrypted files may be committed as encrypted placeholders; the runbook covers ops-track re-encryption with real values. Plaintext never lands in git either way.
- **NetworkPolicy on k3s**: default-deny must still allow DNS egress and the ingress controller (Traefik) to reach the app, or the cluster renders itself unreachable; the policy set enumerates these allows explicitly.

## Requirements *(mandatory)*

### Functional Requirements

**OpenTofu (`infra/terraform/`)**

- **FR-001**: The repository MUST contain an OpenTofu root module at `infra/terraform/` with pinned provider versions, an S3 state backend using versioning, encryption, and native lockfile locking (`backend.tf`), and documented input variables; `tofu fmt`-clean and `tofu validate`-clean (subject to the Verification Gate fallback).
- **FR-002**: The module MUST declare the dedicated EC2 node with: encrypted root and data EBS volumes (customer-managed KMS key), IMDSv2 required (`http_tokens = "required"`), an Elastic IP, and user data rendered from `cloud-init.yaml.tftpl` that installs k3s with `--secrets-encryption` and `--tls-san` (Elastic IP + DNS name).
- **FR-003**: The module MUST declare a dedicated security group: 443 ingress from the world or, when the scoping toggle is on (default), from the AWS-managed CloudFront origin-facing prefix list; 22 and 6443 ingress ONLY from an operator CIDR variable with no default whose validation rejects `0.0.0.0/0`; no other ingress.
- **FR-004**: The module MUST declare IAM as three separated principals: (a) the node instance role scoped to ECR pull only; (b) the app's S3 images user, least-privileged to object operations on the images bucket (mirroring the posture of `script/provision-s3-images.sh`); (c) a backup writer allowed `s3:PutObject` on the backup bucket only.
- **FR-005**: The module MUST declare the `squiredocs-db-backups` bucket with SSE-KMS (the project CMK), versioning, Object Lock (governance mode, per ledger RD-5), a lifecycle policy (Glacier-class transition + bounded expiry), all public access blocked, and a backup-freshness alarm/notification path.
- **FR-006**: The module MUST declare the edge: the existing CloudFront distribution `<cloudfront-distribution-id>` adopted via import (origin protocol policy `https-only`, access logging enabled), an AWS WAF WebACL (managed rule sets + a rate-based rule, per ledger RD-4) associated with the distribution, and the `app.squiredocs.com` Route53 record with a low TTL in the existing `squiredocs.com` zone referenced strictly as a read-only data source.
- **FR-007**: The module MUST declare the account-level controls (EBS default encryption on, CloudTrail multi-region to S3, GuardDuty, AWS Config + IAM Access Analyzer, strengthened IAM password policy) and the ECR lifecycle policy, in a clearly separated file/module documented as applied-by-ops-track.

**Kustomize (`k8s/`)**

- **FR-008**: Kubernetes manifests MUST be restructured into `k8s/base/` plus `k8s/overlays/minikube/` and `k8s/overlays/aws-prod/`; both overlays MUST render with `kustomize build` (or `kubectl kustomize`) with zero `${...}` placeholders; image references MUST use the Kustomize image-override mechanism.
- **FR-009**: The minikube overlay MUST preserve current development behavior exactly (app-dev workload, storage classes, PVC sizes, `/health` probes, passwordless Redis) — no behavioral change to the dev environment.
- **FR-010**: The aws-prod overlay MUST encode the k3s deltas currently applied by `sed` in the deploy script (storage class `local-path`, postgres PVC 5Gi, postgres memory request 256Mi, HPA max 2) as declarative patches.
- **FR-011**: In the aws-prod overlay, every workload pod spec MUST set `runAsNonRoot: true`, `allowPrivilegeEscalation: false`, `capabilities.drop: [ALL]`, and `seccompProfile.type: RuntimeDefault`; the namespace MUST carry Pod Security Standards labels enforcing `restricted`.
- **FR-012**: The aws-prod overlay MUST include NetworkPolicies: default-deny (ingress+egress) for the namespace, with scoped allows limited to app→postgres:5432, app→redis:6379, backup→postgres:5432, DNS egress, ingress-controller→app:3001, and the egress the app and backup legitimately need (HTTPS to AWS/AI-provider endpoints).
- **FR-013**: In the aws-prod overlay, Redis MUST run with `--requirepass` sourced from a SOPS-encrypted Secret, `--maxmemory` bounded under `allkeys-lru`; the app deployment MUST inject the matching password env var (consumed by feature 010's app code).
- **FR-014**: In the aws-prod overlay, Postgres tuning MUST be applied via real `-c` server arguments (shared_buffers, work_mem, maintenance_work_mem, effective_cache_size, max_connections), replacing the current no-op `POSTGRES_*` env vars.
- **FR-015**: In the aws-prod overlay, third-party images (postgres, redis, backup base) MUST be pinned by digest; the app image MUST be set by digest at deploy time by the deploy script.
- **FR-016**: In the aws-prod overlay, the app readinessProbe MUST target `/ready` (feature 010) while liveness stays `/health`; the minikube overlay keeps `/health` for both until 010 lands.

**Secrets (SOPS/age)**

- **FR-017**: A `.sops.yaml` MUST define age recipients and creation rules scoped to `k8s/secrets/*.enc.yaml`, encrypting only secret values (`encrypted_regex` on `data`/`stringData`); every file committed under `k8s/secrets/` MUST be SOPS-encrypted; no plaintext secret value may be added to version control.
- **FR-018**: The s3cmd backup credentials MUST move from the plaintext ConfigMap to a SOPS-encrypted Secret consumed by the backup CronJob; the runbook MUST include rotating to the new scoped backup-writer credentials and deactivating the old broadly-scoped key.
- **FR-019**: The documented secret flow MUST cover: encrypting a new value, decrypt-and-apply to a cluster, and the placeholder pattern for secrets whose live values only the ops track holds.

**Build & deploy hardening**

- **FR-020**: The `Dockerfile`'s base images MUST be pinned by digest in both stages; the existing non-root runtime user MUST be preserved.
- **FR-021**: `script/deploy-aws.sh` MUST run under `set -euo pipefail`, apply manifests via `kubectl apply -k` on the aws-prod overlay (no `envsubst`/`sed`), preserve the kube-context guard and migration gate, resolve the pushed image digest (failing if unresolvable), and gate the git deploy-tag behind a successful `kubectl rollout status` on the app deployment.

**Backup hardening**

- **FR-022**: The backup CronJob MUST run non-root with the full restricted securityContext, use a dedicated pinned image with `pg_dump` and the S3 upload tool baked in (no runtime `apk add`), set `concurrencyPolicy: Forbid`, and declare resource requests/limits.
- **FR-023**: The backup script MUST read the database password via `PGPASSFILE`, produce timestamped filenames (full date+time), upload to `squiredocs-db-backups`, and never expose secrets in traced output.

**Runbook**

- **FR-024**: `specs/011-iac-config-management/runbook.md` MUST document the ops-track execution end to end: bootstrap (tools, age keys, state bucket), account-setting enablement, `tofu apply` order including the CloudFront import and plan-reconciliation rule, node build + k3s validation, backup bucket + credential rotation, parallel validation of the new cluster, the maintenance-window cutover (old app to zero → final dump/restore → `API_KEY_ENCRYPTION_KEY` carried unchanged and verified → DNS repoint), the rollback path, the feature-010 image gate, and the post-cutover restore drill; every step MUST have a verification and (where meaningful) a rollback.

### Key Entities

- **OpenTofu root module** (`infra/terraform/`): the single declaration of Squire's AWS footprint; consumes two pre-existing read-only/imported objects (hosted zone, CloudFront distribution).
- **Kustomize base** (`k8s/base/`): environment-neutral manifests shared by both overlays.
- **Overlays** (`k8s/overlays/{minikube,aws-prod}`): declarative environment deltas; aws-prod is the hardened production posture.
- **SOPS-encrypted secrets** (`k8s/secrets/*.enc.yaml` + `.sops.yaml`): committed, versioned, age-encrypted secret material.
- **Backup pipeline**: hardened CronJob + pinned backup image + `squiredocs-db-backups` bucket + freshness alarm.
- **Runbook** (`specs/011-iac-config-management/runbook.md`): the ops-track execution contract bridging authored code to the live migration.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: Both `kustomize build k8s/overlays/minikube` and `kustomize build k8s/overlays/aws-prod` succeed, and neither render contains an unexpanded `${` placeholder (0 occurrences).
- **SC-002**: In the aws-prod render: 100% of workload pod specs carry the restricted securityContext quadruple (non-root, no privilege escalation, all caps dropped, seccomp RuntimeDefault); a default-deny NetworkPolicy is present; 100% of non-app container images are digest-pinned; the namespace carries PSS `restricted` labels.
- **SC-003**: The minikube render is behaviorally identical to the pre-restructure manifests (probe paths, storage classes, PVC sizes, image tags, env vars) — verified by diffing the render against the pre-change effective manifests.
- **SC-004**: `tofu fmt -check` reports 0 files needing formatting and `tofu validate` passes (or the documented fallback ladder is satisfied); the configuration contains an import binding for distribution `<cloudfront-distribution-id>` and zero managed `aws_route53_zone` resources.
- **SC-005**: 0 plaintext secret values are added to version control by this feature; every committed file under `k8s/secrets/` carries SOPS encryption metadata.
- **SC-006**: The backup CronJob spec satisfies all five hardening properties (non-root, pinned tooling image, no password in argv/trace, timestamped filenames, `concurrencyPolicy: Forbid` + resource limits) — 5 of 5 on review.
- **SC-007**: A simulated failing rollout (or shell-logic review) shows `deploy-aws.sh` exits non-zero without creating a deploy tag; a passing run tags exactly once.
- **SC-008**: The runbook covers 100% of the design doc's "Migration & cutover" numbered steps, each with a verification and a rollback note, and includes the feature-010 ordering gate.

## Verification Gate *(this feature's definition of "tests pass")*

Verification for this feature is **NOT `npm test`** — no application code changes, so the app suites are unaffected (they must simply remain untouched and green). The feature's verification is:

1. `kustomize build` (or `kubectl kustomize`) on **each** overlay — must succeed, plus the SC-001/SC-002/SC-003 render assertions.
2. `tofu validate` and `tofu fmt -check` in `infra/terraform/`.

**Toolchain fallback (explicit)**: `tofu` may be absent in the worktree/dev pod (it is absent today, as are `kustomize` and `kubectl`). The fallback ladder is: use `terraform fmt -check`/`terraform validate` if a Terraform binary is available; use `kubectl kustomize` if kubectl is available but kustomize is not; if none are installable in the environment, verification degrades to structured manual review — HCL syntax/reference review against this spec's FRs, and YAML/kustomization cross-reference review (every resource listed exists, every patch target resolves) — with the degradation recorded in the implementation notes so the ops track re-runs the real validators before any apply.

## Assumptions

- **AWS context**: account `<aws-account-id>`, region `us-east-1`, ECR repo `eqt/collab`, existing CloudFront distribution `<cloudfront-distribution-id>`, existing `squiredocs.com` hosted zone. The images bucket (`squiredocs-images` pattern via `provision-s3-images.sh`) already exists and does not move.
- **Architecture**: the node is arm64 (Graviton) — the image pipeline already builds `linux/arm64`.
- **Single node is accepted**: node loss = outage until rebuild is a ratified design trade-off; durability is owned by the backup posture, not replication.
- **The ops track exists**: Sam/the orchestrator holds AWS credentials, the age private key, and executes the runbook; nothing in this feature's implementation touches live AWS.
- **Feature 010** delivers `/ready` and app-side Redis password consumption (`REDIS_PASSWORD`); this feature's aws-prod overlay is written against that contract (see ledger G2). Verified absent from the app today (`server/redis.js` reads only host/port; only `/health` exists in `server/index.js`).
- **Secret values**: live values for auth/AI/SES secrets exist only in the operator's gitignored files; encrypted placeholders are acceptable until the ops track re-encrypts with real values.
- All defaulted decisions are recorded as RATIFIED-BY-DEFAULT in `specs/011-iac-config-management/clarifications-needed.md` per Constitution Principle VI; flagged gaps (G1–G3) need Sam's eyes but do not block.

## Dependencies & Cross-Feature Handoffs

- **To feature 010 (app hardening)**: (a) the aws-prod readinessProbe targets `GET /ready` on port 3001 — 010 must implement it reporting Postgres reachability and Redis state; (b) the aws-prod overlay injects a Redis password env var from the `redis-auth` SOPS secret — 010's Redis client code must authenticate with it (and tolerate its absence for minikube/dev). Deploy ordering: the aws-prod overlay is never applied to a cluster whose image predates 010.
- **From feature 008/BYOK surface**: `API_KEY_ENCRYPTION_KEY` has no rotation path; the runbook treats carrying it unchanged as a hard invariant with a post-restore decryption check.
- **On the design doc**: `design/infrastructure-and-environments.md` @ d20917e is normative; the runbook mirrors its "Migration & cutover" sequence exactly.
