# Data Model — 011-iac-config-management

"Entities" here are the declarative artifacts this feature authors (infrastructure resources, Kubernetes objects, encrypted secrets, build/deploy artifacts). No application data model or DB schema changes — this feature adds no migrations.

## A. OpenTofu resources (`infra/terraform/`)

| Entity | Kind | Key attributes | FR / RD |
|--------|------|----------------|---------|
| State backend | `backend "s3"` | bucket `squiredocs-tofu-state`, `use_lockfile=true`, encrypt, versioned (bucket bootstrapped by ops track) | FR-001, RD-7 |
| KMS CMK | `aws_kms_key` + `aws_kms_alias` | `alias/squiredocs`, rotation enabled | RD-3 |
| EC2 node | `aws_instance` | arm64 `t4g.medium` (var), IMDSv2 `http_tokens=required`, encrypted root+data EBS (CMK), user_data from template | FR-002, RD-2 |
| Elastic IP | `aws_eip` | associated to node; the cutover target | FR-002 |
| Cloud-init | `templatefile("cloud-init.yaml.tftpl")` | k3s install `--secrets-encryption`, `--tls-san` (EIP + DNS name) | FR-002 |
| Security group | `aws_security_group` (+ rules) | 443 world OR CF origin-facing prefix list (toggle); 22/6443 from `operator_cidr` only; no other ingress | FR-003, G1 |
| Instance role | `aws_iam_role` + instance profile | ECR pull only | FR-004 |
| S3 images user | `aws_iam_user` + policy | least-priv object ops on images bucket (mirrors `provision-s3-images.sh`) | FR-004 |
| Backup writer | `aws_iam_user`/role + policy | `s3:PutObject` on `squiredocs-db-backups` only | FR-004 |
| Backup bucket | `aws_s3_bucket` + config resources | SSE-KMS (CMK), versioning, Object Lock (governance 30d), lifecycle (Glacier IR@30d, expire@365d), block public access | FR-005, RD-5 |
| Backup freshness alarm | `aws_cloudwatch_metric_alarm` + `aws_sns_topic` + subscription | fire when no `PutRequests` in 26h → email (`alarm_email` var) | FR-005, RD-6 |
| CloudFront distribution | `aws_cloudfront_distribution` (imported) | `<cloudfront-distribution-id>`, origin `https-only`, access logging; import block; NEVER recreated | FR-006, SC-004 |
| WAF WebACL | `aws_wafv2_web_acl` (+ association) | ~~Common (body-size→count) +~~ KnownBadInputs + IpReputation + rate 2000/5min **(Common removed 2026-07-18 — false-positived on OAuth loopback redirect URIs and doc/chat bodies)** | FR-006, RD-4 |
| Route53 origin record | `aws_route53_route53_record` (A) | `app.squiredocs.com` → EIP, TTL 60; in existing zone via data source | FR-006, RD-14, G3 |
| Hosted zone | `data "aws_route53_zone"` | `squiredocs.com` **read-only** — never a managed resource | FR-006, SC-004 |
| CF prefix list | `data "aws_ec2_managed_prefix_list"` | AWS-managed CloudFront origin-facing list (for 443 scoping) | FR-003, G1 |
| Account controls | `account.tf` (separated, ops-applied header) | EBS default encryption, CloudTrail (multi-region→S3), GuardDuty, AWS Config + IAM Access Analyzer, IAM password policy | FR-007 |
| ECR lifecycle | `aws_ecr_lifecycle_policy` | bound image accumulation on `eqt/collab` | FR-007 |

**Variables** (`variables.tf`): `region`, `instance_type`, `root_volume_size`, `data_volume_size`, `operator_cidr` (no default; validation rejects `0.0.0.0/0`/`::/0`), `restrict_443_to_cloudfront` (default `true`), `alarm_email`, `tags`. **Outputs**: EIP, node id, backup/state bucket names, distribution id, SG id.

## B. Kubernetes objects (`k8s/`)

### base/ (environment-neutral)

| Object | Notes vs. today |
|--------|-----------------|
| Namespace `collab` | PSS labels applied per-overlay |
| Deployment `collab-app` | `${IMG}` removed → Kustomize `images:` override; env unchanged in base |
| Service `collab-app`, HPA `collab-app` | HPA maxReplicas base value patched per overlay |
| Deployment/Service/PVC `collab-postgres` | PVC size + mem + tuning patched per overlay |
| Deployment/Service/PVC `collab-redis` | auth/maxmemory patched in aws-prod |
| Job `db-migrate-job` | `${IMG}` removed → image override |
| CronJob `postgres-backup` | base carries schedule/structure; hardening patched in aws-prod |

### overlays/minikube/ (FR-009 — behavior identical to today)

StorageClasses `premium-rwo`/`standard-rwo` (dev-only), `app-dev` pod, `/health` for both probes, passwordless Redis, PSS `warn=baseline` only. **SC-003**: render diff against current effective manifests shows no behavioral change.

### overlays/aws-prod/ (hardened)

| Patch/object | Content | FR / SC |
|--------------|---------|---------|
| k3s-deltas | storageClass `local-path`, pg PVC 5Gi, pg mem req 256Mi, HPA max 2 | FR-010 |
| securityContext (all workloads) | `runAsNonRoot:true`, `allowPrivilegeEscalation:false`, `capabilities.drop:[ALL]`, `seccompProfile:RuntimeDefault` | FR-011, SC-002 |
| namespace PSS | `enforce=restricted` (+ audit/warn) | FR-011, SC-002, RD-8 |
| NetworkPolicies | default-deny (ingress+egress) + allows: app→postgres:5432, app→redis:6379, backup→postgres:5432, DNS egress, ingress-controller→app:3001, app/backup HTTPS egress | FR-012, SC-002 |
| Redis auth | `--requirepass` from `redis-auth` secret; `--maxmemory 192mb --maxmemory-policy allkeys-lru` | FR-013, RD-12 |
| Postgres tuning | real `-c shared_buffers/work_mem/maintenance_work_mem/effective_cache_size/max_connections`; drop no-op `POSTGRES_*` env | FR-014 |
| app probes/env | readiness `/ready`:3001, liveness `/health`; inject `REDIS_PASSWORD` from `redis-auth` (optional) | FR-016, FR-013 |
| image digests | postgres, redis, backup pinned by digest; app image set at deploy time | FR-015, SC-002 |
| backup CronJob hardening | non-root restricted SC, `Dockerfile.backup` image, `concurrencyPolicy:Forbid`, requests+limits | FR-022, SC-006 |

## C. SOPS-encrypted secrets (`k8s/secrets/*.enc.yaml` + `.sops.yaml`)

| File | Source surface | Notes |
|------|----------------|-------|
| `.sops.yaml` | — | age recipient(s) (RD-13); creation rule `k8s/secrets/*.enc.yaml`, `encrypted_regex` on `data`/`stringData` |
| `postgres-secret.enc.yaml` | `k8s/postgres-secret.yaml` (gitignored) | username/password |
| `mcp-auth-secret.enc.yaml` | `k8s/mcp-auth-secret.yaml` | MCP_* secrets |
| `ses-secret.enc.yaml` | `k8s/ses-secret.yaml` | SES SMTP |
| `s3-images-secret.enc.yaml` | `k8s/s3-images-secret.yaml` | image bucket creds (optional feature) |
| `auth-secret.enc.yaml` | `k8s/auth.production.env` | OAuth/JWT/AI/`API_KEY_ENCRYPTION_KEY`; encrypted placeholder ok until ops-track re-encrypts |
| `redis-auth.enc.yaml` | NEW | Redis password; placeholder until ops-track value (G2 consumes) |
| `backup-s3cmd.enc.yaml` | replaces `k8s/s3cmd-configmap.yaml` (gitignored plaintext, live keys) | s3cmd config as a Secret (FR-018); rotated to scoped backup writer in runbook §2.5 |

**Invariant (SC-005)**: every committed file under `k8s/secrets/` carries SOPS metadata; 0 plaintext secret values in git. Legacy gitignored plaintext files stay the ops track's local encryption source, never committed.

## D. Build / deploy / backup artifacts

| Artifact | Change | FR |
|----------|--------|----|
| `Dockerfile` | pin both `node:22-alpine` stages by `@sha256:` digest; preserve non-root `appuser` | FR-020 |
| `Dockerfile.backup` (NEW) | alpine@digest + pg16-client + s3cmd, non-root user, `backup-postgres.sh` baked in | RD-9 |
| `script/backup-postgres.sh` | `PGPASSFILE` (mounted), timestamped filename (date+time), target `squiredocs-db-backups`, no secret in traced output | FR-023, SC-006 |
| `script/deploy-aws.sh` | `set -euo pipefail`; `kubectl apply -k k8s/overlays/aws-prod`; resolve ECR digest (fail if unresolvable); digest image override; keep context guard + migrate gate; deploy-tag gated behind `kubectl rollout status` | FR-021, SC-007, RD-10 |

## E. Runbook (`runbook.md`) — already authored

The ops-track execution contract (FR-024). Cross-checked in analyze against A–D for coverage (SC-008): bootstrap, account enablement, `tofu apply` order + CloudFront import + reconciliation rule, node/k3s validation, backup bucket + credential rotation, parallel validation, maintenance-window cutover (old app→0 → final dump/restore → `API_KEY_ENCRYPTION_KEY` carried unchanged + verified → DNS repoint), rollback, feature-010 gate, post-cutover restore drill.
