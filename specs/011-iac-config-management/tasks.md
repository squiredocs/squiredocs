---

description: "Task list for feature 011-iac-config-management"
---

# Tasks: IaC & Config Management — Dedicated Hardened Cluster

**Input**: Design documents from `/specs/011-iac-config-management/`

**Prerequisites**: plan.md, spec.md, research.md, data-model.md, contracts/

**Tests**: This feature adds **no application code**, so no unit/integration test tasks. Verification is the plan's **Verification Gate** (`kustomize build` per overlay + `tofu validate`/`tofu fmt -check`, with the Toolchain Fallback Ladder to structured manual review). Verification tasks appear per story and in Polish.

**Scope reminder (authoring only)**: no task applies anything to real AWS. Every `tofu apply`, account-setting change, credential rotation, image push, and the cutover are **ops-track** steps in `runbook.md` — never in these tasks.

**Parallel-agent constraints**: stay on the current branch; never commit; never edit `CLAUDE.md`/`README.md`/`docs/dev.md`; the legacy gitignored plaintext files (`k8s/s3cmd-configmap.yaml`, `k8s/*-secret.yaml`, `k8s/auth.production.env`) are the ops track's local encryption source and are never committed.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: can run in parallel (different files, no dependency on incomplete tasks)
- **[Story]**: US1..US6 (Polish/Setup/Foundational carry no story label)

---

## Phase 1: Setup (Shared Infrastructure)

**Purpose**: create the directory skeleton the authored trees live in.

- [X] T001 Create the OpenTofu module directory `infra/terraform/` and the Kustomize skeleton `k8s/base/`, `k8s/overlays/minikube/`, `k8s/overlays/aws-prod/`, `k8s/secrets/` (empty dirs with `.gitkeep` where needed) per plan.md Project Structure.
- [X] T002 Record the verification degradation up front: confirm `tofu`/`terraform`/`kustomize`/`kubectl`/`sops`/`age` availability in the environment and note which gate rung (preferred / terraform / kubectl-kustomize / manual review) will be used, to be captured in the implementation notes per the Toolchain Fallback Ladder.

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: shared decisions and wiring both the Kustomize and secrets work depend on. No user story should start its overlay/secret wiring before these.

- [X] T003 Author `infra/terraform/versions.tf` and `providers.tf`: pin OpenTofu ≥ 1.10 and the `hashicorp/aws` provider; configure the `aws` provider from the `region` variable with `default_tags`. (FR-001)
- [X] T004 Author `infra/terraform/backend.tf`: S3 backend `squiredocs-tofu-state`, `use_lockfile=true`, `encrypt=true` (bucket bootstrapped by ops track, not managed here). (FR-001, RD-7)
- [X] T005 Author `infra/terraform/variables.tf`: `region`, `instance_type`, `root_volume_size`, `data_volume_size`, `operator_cidr` (**no default**; validation rejecting `0.0.0.0/0` and `::/0`), `restrict_443_to_cloudfront` (default `true`), `alarm_email`, `tags`. (FR-001, FR-003, RD-1, RD-2, G1)
- [X] T006 Decide and document the secret-name contract shared by base/overlays and `k8s/secrets/`: `postgres-secret`, `mcp-auth-secret`, `ses-secret`, `s3-images-secret`, `auth-secret`, `redis-auth` (new), `backup-s3cmd` (new). Capture in `contracts/secrets-sops.md` reference so US2 and US3 stay consistent. (FR-017, FR-018)

**Checkpoint**: provider/backend/variables scaffold validates (fmt/validate or manual review); secret-name contract fixed.

---

## Phase 3: User Story 1 — All AWS infrastructure declared as OpenTofu (Priority: P1)

**Goal**: `infra/terraform/` declares the complete dedicated-cluster footprint as reviewable, validatable code; CloudFront imported, hosted zone read-only.

**Independent test**: `tofu fmt -check` + `tofu validate` pass (or fallback); every "Node & cluster hardening" and "Observability & account controls" design bullet traces to a declared resource or a documented ops-track step; import binding for `<cloudfront-distribution-id>` present; zero managed `aws_route53_zone`. (SC-004)

- [X] T007 [P] [US1] Author `infra/terraform/kms.tf`: customer-managed KMS key + `alias/squiredocs`, annual rotation enabled. (FR-002/005, RD-3)
- [X] T008 [P] [US1] Author `infra/terraform/network.tf`: dedicated security group — 443 from world OR the CloudFront origin-facing managed prefix list (data source) per `restrict_443_to_cloudfront`; 22 and 6443 from `operator_cidr` only; no other ingress. (FR-003, G1)
- [X] T009 [US1] Author `infra/terraform/iam.tf`: three separated least-privilege principals — instance role (ECR pull only) + instance profile; S3 images user (object-only on images bucket, mirroring `script/provision-s3-images.sh`); backup writer (`s3:PutObject` on `squiredocs-db-backups` only). (FR-004)
- [X] T010 [US1] Author `infra/terraform/backup_bucket.tf`: `squiredocs-db-backups` with SSE-KMS (CMK), versioning, Object Lock (governance, 30d), lifecycle (Glacier IR@30d, expire current+noncurrent@365d), block-all-public; plus freshness alarm — S3 request metrics, `aws_cloudwatch_metric_alarm` on absent `PutRequests` > 26h, `aws_sns_topic` + email subscription (`alarm_email`). (FR-005, RD-5, RD-6)
- [X] T011 [US1] Author `infra/terraform/cloud-init.yaml.tftpl` and `compute.tf`: EC2 node (arm64 `instance_type`, `http_tokens=required`, encrypted root+data EBS via CMK), Elastic IP; user_data renders the template installing k3s with `--secrets-encryption` and `--tls-san` (EIP + DNS name). (FR-002)
- [X] T012 [US1] Author `infra/terraform/edge.tf` + `imports.tf`: import distribution `<cloudfront-distribution-id>` (origin `https-only`, access logging), WAF WebACL (Common with `SizeRestrictions_BODY`→count, KnownBadInputs, IpReputation, rate rule 2000/5min/IP block) associated to it, and the single managed Route53 record `app.squiredocs.com` A→EIP TTL 60; `squiredocs.com` as `data "aws_route53_zone"` only. Written to import reality (origin = `app.squiredocs.com`; no `origin.*` hostname). (FR-006, RD-4, RD-14, G3, SC-004)
- [X] T013 [P] [US1] Author `infra/terraform/account.tf` with an explicit "ops-track applies these" header: EBS default encryption (→ CMK), CloudTrail (multi-region → S3), GuardDuty, AWS Config + IAM Access Analyzer, strengthened IAM password policy, and the ECR lifecycle policy on `eqt/collab`. (FR-007)
- [X] T014 [US1] Author `infra/terraform/outputs.tf` (EIP, node id, bucket names, distribution id, SG id) and `infra/terraform/README.md` (module usage, variable table, ops-track apply notes). (FR-001)
- [X] T015 [US1] Verify US1: run `tofu fmt -check`/`tofu validate` or the fallback ladder; confirm the import binding for `<cloudfront-distribution-id>`, zero managed `aws_route53_zone`, `operator_cidr` has no default and rejects `0.0.0.0/0`. Record the degradation rung used. (SC-004)

**Checkpoint**: OpenTofu footprint complete and validation-clean (or manually reviewed with degradation recorded).

---

## Phase 4: User Story 2 — k8s manifests restructured as Kustomize base + overlays (Priority: P1)

**Goal**: both overlays render from `k8s/base/` + overlays; minikube behaviorally unchanged; aws-prod carries the full hardening posture.

**Independent test**: both overlays render with zero `${...}`; minikube render diffs clean against today's effective manifests; aws-prod render satisfies SC-002. (SC-001/002/003)

- [X] T016 [US2] Move current manifests into `k8s/base/` (namespace, app deployment/service/hpa, postgres deployment/service/pvc, redis deployment/service/pvc, db-migrate-job, postgres-backup-cronjob), strip `${IMG}` from app deployment, migrate Job, and backup CronJob, and author `k8s/base/kustomization.yaml` with an `images:` entry for the app image. (FR-008)
- [X] T017 [US2] Author `k8s/overlays/minikube/`: `kustomization.yaml` referencing base; move dev-only `minikube-premium-rwo-sc.yaml`/`minikube-standard-rwo-sc.yaml` and `app-dev.yaml` here; PSS `warn=baseline` only (no enforce). No behavioral change to app-dev, storage classes, PVC sizes, `/health` probes, or passwordless Redis. (FR-009, RD-8)
- [X] T018 [US2] Verify minikube parity: render `k8s/overlays/minikube` and diff against today's effective manifests (probe paths, storage classes, PVC sizes, image tags, env vars) — no behavioral change; zero `${...}`. (SC-003, SC-001)
- [X] T019 [US2] Author `k8s/overlays/aws-prod/kustomization.yaml` + `patches/k3s-deltas.yaml`: encode the `sed` k3s deltas declaratively — storageClass `local-path`, postgres PVC 5Gi, postgres memory request 256Mi, HPA maxReplicas 2. (FR-010)
- [X] T020 [P] [US2] Author `k8s/overlays/aws-prod/patches/securitycontext.yaml` and `namespace-pss.yaml`: restricted quadruple (`runAsNonRoot:true`, `allowPrivilegeEscalation:false`, `capabilities.drop:[ALL]`, `seccompProfile.type:RuntimeDefault`) on all workloads (app, postgres, redis, migrate Job, backup CronJob); namespace PSS `enforce=restricted` (+ audit/warn). (FR-011, RD-8, SC-002)
- [X] T021 [P] [US2] Author `k8s/overlays/aws-prod/networkpolicies.yaml`: default-deny (ingress+egress) + scoped allows exactly app→postgres:5432, app→redis:6379, backup→postgres:5432, DNS egress, ingress-controller→app:3001, and app/backup HTTPS egress. (FR-012, SC-002)
- [X] T022 [P] [US2] Author `k8s/overlays/aws-prod/patches/postgres-tuning.yaml`: replace the no-op `POSTGRES_*` env vars with real `-c` server args (shared_buffers, work_mem, maintenance_work_mem, effective_cache_size, max_connections). (FR-014)
- [X] T023 [P] [US2] Author `k8s/overlays/aws-prod/patches/redis-auth.yaml`: Redis `--requirepass` from the `redis-auth` secret, `--maxmemory 192mb`, `--maxmemory-policy allkeys-lru`. (FR-013, RD-12)
- [X] T024 [US2] Author `k8s/overlays/aws-prod/patches/app-probes.yaml`: readinessProbe → `/ready`:3001, livenessProbe stays `/health`; inject `REDIS_PASSWORD` from the `redis-auth` secret (optional). Written to feature-010's contract; consumed only when a 010 image is deployed (runbook gate). (FR-016, FR-013, G2)
- [X] T025 [US2] Pin postgres, redis, and backup images by `@sha256:` digest in `k8s/overlays/aws-prod/kustomization.yaml` `images:`; leave the app image to be set at deploy time. (FR-015, RD-10, SC-002)
- [X] T025a [US2] Move the active Traefik Ingress content from `k8s/aws/app-ingress.yaml` into `k8s/overlays/aws-prod/app-ingress.yaml` (hosts `squiredocs.com` + `app.squiredocs.com` → `collab-app:80`, `ingressClassName: traefik`) and add it to the aws-prod `kustomization.yaml resources:`; this is the ingress the default-deny NetworkPolicy's `ingress-controller→app:3001` allow presupposes and replaces the `kubectl apply -f k8s/aws/app-ingress.yaml` line the old deploy script ran. (FR-008, FR-012)
- [X] T026 [US2] Verify aws-prod render: `kustomize build k8s/overlays/aws-prod` (or fallback) succeeds with zero `${...}`; 100% workloads carry the securityContext quadruple; default-deny NetworkPolicy present; 100% non-app images digest-pinned; PSS `restricted` labels present. (SC-001, SC-002)

**Checkpoint**: both overlays render; minikube parity proven; aws-prod hardening assertions pass.

---

## Phase 5: User Story 3 — Secrets are SOPS/age-encrypted files in version control (Priority: P2)

**Goal**: every `k8s/secrets/*` file is SOPS/age-encrypted; the backup credential moves out of the plaintext ConfigMap.

**Independent test**: `.sops.yaml` scoped to `k8s/secrets/*.enc.yaml` encrypting only `data`/`stringData`; every committed file verifiably encrypted (SOPS metadata, no plaintext); placeholder flow documented. (SC-005)

**Depends on**: US2 secret-name wiring (T016–T025) and Foundational T006.

- [X] T027 [US3] Author `.sops.yaml` at repo root: age recipient(s) (RD-13) and a creation rule for `k8s/secrets/*.enc.yaml` with `encrypted_regex` scoped to `data`/`stringData`. (FR-017, RD-13)
- [X] T028 [P] [US3] Create encrypted files (or documented encrypted placeholders) for the existing secret surface under `k8s/secrets/`: `postgres-secret.enc.yaml`, `mcp-auth-secret.enc.yaml`, `ses-secret.enc.yaml`, `s3-images-secret.enc.yaml`, `auth-secret.enc.yaml` (from the `auth.production.env` surface, incl. `API_KEY_ENCRYPTION_KEY`). Placeholders where only the ops track holds live values. (FR-017, FR-019)
- [X] T029 [P] [US3] Create `k8s/secrets/redis-auth.enc.yaml` (new Redis password secret; encrypted placeholder until the ops track generates the real value in runbook §0.4). (FR-017, G2)
- [X] T030 [US3] Create `k8s/secrets/backup-s3cmd.enc.yaml` replacing the gitignored plaintext `k8s/s3cmd-configmap.yaml`; wire the aws-prod backup CronJob to consume the s3cmd config from this SOPS Secret instead of the ConfigMap. (FR-018)
- [X] T031 [US3] Document the secret flow (in `contracts/secrets-sops.md` / module README as appropriate, not the repo README): encrypt a new value, decrypt-and-apply (`sops -d … | kubectl apply -f -`), and the encrypted-placeholder pattern. (FR-019)
- [X] T032 [US3] Verify US3: every committed file under `k8s/secrets/` carries a `sops:` metadata block; `git grep`/manual review finds zero plaintext secret values added by this feature. (SC-005)

**Checkpoint**: secret surface encrypted and committable; backup credential de-plaintexted.

---

## Phase 6: User Story 4 — Hardened build & deploy path (Priority: P2)

**Goal**: one deploy command that fails loudly and never tags a broken deploy; digest-pinned base images.

**Independent test**: `bash -n` + shell review — `set -euo pipefail`, `kubectl apply -k`, deploy tag unreachable unless `kubectl rollout status` succeeded; Dockerfile bases digest-pinned. (SC-007)

**Depends on**: US2 (aws-prod overlay exists to apply).

- [X] T033 [P] [US4] Edit `Dockerfile`: pin both `node:22-alpine` stage bases by `@sha256:` digest; preserve the non-root `appuser` runtime unchanged. (FR-020)
- [X] T034 [US4] Rewrite `script/deploy-aws.sh`: `set -euo pipefail`; deploy via `kubectl apply -k k8s/overlays/aws-prod` (remove `envsubst`/`sed` templating and `patch_for_k3s`); resolve the pushed image digest from ECR and set `repo@digest` via the Kustomize image override, failing before applying if unresolvable; preserve the kube-context guard and the migrate-Job gate; gate the `deployed-collab-aws-*` git tag behind a successful `kubectl rollout status` on `collab-app`. (FR-021, RD-10)
- [X] T035 [US4] Verify US4: `bash -n script/deploy-aws.sh` clean; logic review confirms a failed rollout exits non-zero without tagging and a passing run tags exactly once; Dockerfile digest pins present. (SC-007)

**Checkpoint**: deploy path hardened; no mutable-tag fallback; broken deploy cannot tag.

---

## Phase 7: User Story 5 — Hardened backup CronJob and dedicated backup bucket (Priority: P2)

**Goal**: nightly Postgres backup runs non-root from a pinned image, timestamped, to `squiredocs-db-backups`, no leaked password.

**Independent test**: render aws-prod overlay + review CronJob and script — 5/5 hardening properties; target bucket is `squiredocs-db-backups`. (SC-006)

**Depends on**: US2 (CronJob in overlay), US3 (`backup-s3cmd` secret), US1 (bucket declared).

- [X] T036 [P] [US5] Author `Dockerfile.backup`: `alpine@sha256:…` base + `postgresql16-client` + `s3cmd` installed at build time, non-root user, `script/backup-postgres.sh` baked in (no runtime `apk add`). (RD-9)
- [X] T037 [US5] Rewrite `script/backup-postgres.sh`: read the DB password via `PGPASSFILE` (mounted file) — never on a command line or in traced output; timestamped filenames (full date+time, not day-of-year); upload to `squiredocs-db-backups` (not `earthquaketracksql`); drop the runtime `apk add` and the `set -x` secret exposure. (FR-023, SC-006)
- [X] T038 [US5] Author `k8s/overlays/aws-prod/patches/backup-hardening.yaml`: backup CronJob runs non-root with the full restricted securityContext, uses the pinned `Dockerfile.backup` image (digest), `concurrencyPolicy: Forbid`, CPU/memory requests+limits; consumes `backup-s3cmd` Secret + `PGPASSFILE` mount. (FR-022)
- [X] T039 [US5] Verify US5: render aws-prod + review — non-root, pinned tooling image, no password in argv/trace, timestamped filenames, `concurrencyPolicy: Forbid` + resource limits (5/5); bucket is `squiredocs-db-backups`; backup-freshness alarm declared in US1 confirmed present. (SC-006, FR-005)

**Checkpoint**: backup pipeline hardened end to end.

---

## Phase 8: User Story 6 — Migration & cutover runbook (Priority: P3)

**Goal**: the runbook is a complete, verifiable, reversible ops-track contract covering 100% of the design's cutover steps.

**Independent test**: a reviewer can walk the runbook and find bootstrap, account enablement, `tofu apply` order + CloudFront import + reconciliation rule, node/k3s validation, backup bucket + credential rotation, parallel validation, the maintenance-window cutover sequence, rollback, feature-010 gate, restore drill — with no step assuming undeclared infra or unwritten config. (SC-008)

**Note**: `runbook.md` was authored alongside the spec (FR-024). These tasks reconcile it against the artifacts US1–US5 actually produced.

- [X] T040 [US6] Cross-check `runbook.md` against US1–US5: every referenced resource/manifest/secret/script exists in the authored trees; the `tofu apply` ordering in §2.3 matches the module; §3.2 references the real overlay path and secret-apply flow; §2.5/§5.4 match `backup-s3cmd` + the scoped backup writer. Fix any drift in `runbook.md` only. (FR-024, SC-008)
- [X] T041 [US6] Confirm the runbook encodes the cutover invariants: old app→0 → final `pg_dump` → restore → `API_KEY_ENCRYPTION_KEY` carried unchanged + verified (stop-if-fails) → DNS repoint of `app.squiredocs.com` (G3 reconciled record) → smoke; rollback (repoint back, warm window); the feature-010 image gate (§3.1); and the post-cutover restore drill (§5.3). (FR-024, SC-008, G2, G3)

**Checkpoint**: runbook consistent with authored artifacts; every step has verify + (where meaningful) rollback.

---

## Phase 9: Polish & Cross-Cutting Concerns

- [X] T042 Run the full Verification Gate once more across both trees (renders + `tofu` fmt/validate or fallback); write the implementation notes recording exactly which fallback rung was used and that the ops track must re-run `tofu validate` / `kustomize build` / `sops -d` before any apply. (Verification Gate)
- [X] T043 [P] Confirm the scope boundary held: no application/server code changed, no migrations added, nothing applied to AWS; `git status` shows only the authored surface; legacy gitignored plaintext files were not committed.
- [X] T044 [P] Confirm RD-11 legacy artifacts (`k8s/ingress.yaml` GKE, `script/deploy.sh`) were left untouched and excluded from the Kustomize tree. Note `k8s/aws/app-ingress.yaml`'s Ingress content was migrated into the aws-prod overlay (T025a) — not a legacy artifact — and `k8s/aws/namespace.yaml` is superseded by base.

---

## Dependencies & Execution Order

- **Setup (T001–T002)** → **Foundational (T003–T006)** block everything.
- **US1 (T007–T015)** — independent after Foundational; the AWS reality other stories name.
- **US2 (T016–T026)** — independent after Foundational; T016 (base) precedes all aws-prod patches.
- **US3 (T027–T032)** — depends on US2 secret-name wiring (T016–T025) + T006.
- **US4 (T033–T035)** — depends on US2 (overlay to apply).
- **US5 (T036–T039)** — depends on US2 (CronJob), US3 (`backup-s3cmd`), US1 (bucket).
- **US6 (T040–T041)** — depends on US1–US5 existing.
- **Polish (T042–T044)** — last.

## Parallel Opportunities

- Within US1: T007, T008, T013 are `[P]` (distinct files); T009–T012 touch interdependent resources — sequence them.
- Within US2: after T016+T019, the patch files T020, T021, T022, T023 are `[P]` (distinct files).
- Within US3: T028, T029 are `[P]`.
- Cross-story once Foundational is done: **US1 and US2 can proceed in parallel** (disjoint trees: `infra/terraform/` vs `k8s/`). US4's Dockerfile task (T033) and US5's Dockerfile.backup (T036) are `[P]` relative to each other.

## Implementation Strategy

- **MVP = US1 + US2** (both P1): the OpenTofu footprint and the rendering Kustomize overlays are the core reviewable delta; everything else hardens on top.
- Then P2 in any order (US3 secrets, US4 deploy, US5 backup) — US3 before US5 (backup consumes the SOPS secret).
- US6 (P3) last: reconcile the already-authored runbook against what US1–US5 produced.
- **Verification is not `npm test`**: run the Verification Gate (renders + tofu validate/fmt) or the fallback ladder, and record the degradation for the ops track.

## Total: 45 tasks

- Setup: 2 · Foundational: 4 · US1: 9 · US2: 12 · US3: 6 · US4: 3 · US5: 4 · US6: 2 · Polish: 3
