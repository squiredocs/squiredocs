# Implementation Plan: IaC & Config Management — Dedicated Hardened Cluster

**Branch**: `011-iac-config-management` (executed on `main` per parallel-agent override — no branch created/switched) | **Date**: 2026-07-15 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `/specs/011-iac-config-management/spec.md`

**Design ground truth**: `design/infrastructure-and-environments.md` @ d20917e — "Target: dedicated hardened cluster", "Node & cluster hardening", "Backups & data protection", "Migration & cutover", "Observability & account controls". Where plan and design disagree, the design doc wins.

## Summary

Author (never apply) the infrastructure-as-code, Kubernetes configuration, encrypted-secret scaffolding, and hardened build/deploy/backup artifacts that carry Squire from a shared node to a dedicated, hardened, single-node k3s cluster. Concretely: a new OpenTofu root module at `infra/terraform/`; a Kustomize restructure of `k8s/` into `base/` + `overlays/{minikube,aws-prod}` that replaces the `sed`/`envsubst` templating in `deploy-aws.sh`; SOPS/age-encrypted secret files under `k8s/secrets/`; digest-pinned base images (`Dockerfile`, new `Dockerfile.backup`); a hardened backup CronJob + script; a rewritten `deploy-aws.sh`; and the already-authored migration runbook. This feature adds **no** application/server code and **no** migrations, and **applies nothing to real AWS** — the runbook (`runbook.md`) hands every apply/rotation/cutover to the ops track. Two aws-prod-overlay capabilities (`/ready` readiness probe, Redis password) consume application code that **feature 010** delivers; the overlay is written to 010's contract and gated by the runbook on an ECR image containing 010.

## Technical Context

**Language/Version**: HCL (OpenTofu ≥ 1.10, for native S3 lockfile locking) · Kubernetes YAML via Kustomize (`kustomize`/`kubectl kustomize`) · SOPS + age · POSIX `sh`/`bash` · Dockerfile. **No application language touched** (Node.js 22 app suites remain untouched and green).

**Primary Dependencies**: OpenTofu `hashicorp/aws` provider (pinned); AWS us-east-1, account `<aws-account-id>`; existing CloudFront distribution `<cloudfront-distribution-id>`; existing `squiredocs.com` hosted zone (read-only data source); ECR repo `eqt/collab`; k3s (`--secrets-encryption`, `--tls-san`); SOPS/age for secrets.

**Storage**: OpenTofu state in a versioned, encrypted S3 backend (`squiredocs-tofu-state`) with native lockfile locking (RD-7). In-cluster Postgres/Redis on KMS-encrypted EBS. Backups to the new `squiredocs-db-backups` bucket (SSE-KMS, versioning, Object Lock governance mode, lifecycle).

**Testing** (this feature's Verification Gate — NOT `npm test`): `kustomize build` on each overlay (SC-001/002/003 render assertions) + `tofu validate` / `tofu fmt -check` on `infra/terraform/`, with the documented Toolchain Fallback Ladder below. Application test suites are out of scope and must stay untouched.

**Target Platform**: AWS EC2 arm64 (Graviton, `t4g.medium` default, RD-2) running k3s; local Minikube for dev (behaviorally unchanged).

**Project Type**: Infrastructure & configuration authoring (no `src/` change). New top-level `infra/terraform/` tree; restructured `k8s/` tree; script/Dockerfile deltas.

**Performance Goals**: N/A (no runtime code). Node sizing (RD-2) accommodates 2 app replicas + Postgres + Redis + k3s overhead in 4 GiB burstable.

**Constraints**: Authoring-only (Scope Boundary); Minikube dev environment behaviorally unchanged (FR-009); no plaintext secret value in git (FR-017); CloudFront imported never recreated (FR-006); `squiredocs.com` zone read-only (never a managed `aws_route53_zone`); `API_KEY_ENCRYPTION_KEY` carried unchanged at cutover (no rotation path); aws-prod overlay never applied to a pre-010 image.

**Scale/Scope**: Single dedicated node (accepted availability trade-off; durability owned by backups). 24 FRs across OpenTofu, Kustomize, SOPS, Docker/deploy, backup, runbook.

### Toolchain Fallback Ladder (verification degradation, explicit)

`tofu`, `terraform`, `kustomize`, `kubectl`, `sops`, and `age` are all **absent in the dev pod today** (verified 2026-07-15). The gate degrades in this order, and the degradation actually taken MUST be recorded in the implementation notes so the ops track re-runs the real validators before any apply:

1. `tofu fmt -check` + `tofu validate`; `kustomize build` per overlay. (Preferred — none available today.)
2. Fallbacks: `terraform fmt -check`/`terraform validate` if a Terraform binary exists; `kubectl kustomize` if kubectl exists but kustomize does not.
3. If none are installable in the environment: **structured manual review** — HCL syntax/reference review against this spec's FRs (every resource/variable/data source referenced exists and resolves), and YAML/kustomization cross-reference review (every `resources:` entry exists, every patch `target` resolves, zero `${...}` placeholders remain in either rendered overlay). Record that validators were unavailable and defer real `tofu validate`/`kustomize build` to the ops track (runbook Phase 2.1 / Phase 3.2).

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

- **I. Documentation Reflects Reality**: PASS with a deferred obligation. `README.md`/`docs/dev.md` describe the current `deploy-aws.sh` (sed/envsubst) flow; the Kustomize+SOPS flow changes it. Per the override I must NOT edit `CLAUDE.md`/`README.md`/`docs/dev.md`; runbook §5.6 assigns the post-migration docs pass to the ops track (docs describe the *live* flow, which does not change until cutover). No drift is introduced into the live-behavior docs by authoring-only artifacts.
- **II. Test-Backed Changes**: PASS (adapted). No behavioral app change → app suites unaffected. The feature's reviewer is the Verification Gate (render + validate + manual-review ladder), substituting for `npm test` exactly as the spec's Verification Gate section states.
- **III. Trunk-Based Solo Workflow**: PASS. Executing on `main`, no branch/PR ceremony; new-feature scaffolding suppressed per override.
- **IV. Collaboration-Safe Document Operations**: N/A — no document-mutating code.
- **V. Secure by Default**: PASS and reinforcing. The feature's entire thrust is hardening (SOPS-encrypted secrets, restricted PSS, default-deny NetworkPolicy, non-root/no-priv-esc/caps-dropped/seccomp, IMDSv2, KMS at rest, scoped IAM, WAF). No new ingestion surface. Live AWS keys currently sitting in a gitignored plaintext `s3cmd-configmap.yaml` move to a SOPS Secret (FR-018) — a net secret-handling improvement.
- **VI. Design Docs Are Ground Truth**: PASS. Plan traces to `design/infrastructure-and-environments.md` @ d20917e; open decisions are RATIFIED-BY-DEFAULT (RD-1..RD-14) and flagged gaps (G1–G3) live in `clarifications-needed.md`, never resolved silently. Residual design-doc/ledger wording deltas surfaced by import reality are flagged (see Edge Topology below), not silently patched.

**Gate result**: PASS — no violations; Complexity Tracking not required.

## Project Structure

### Documentation (this feature)

```text
specs/011-iac-config-management/
├── spec.md                    # Feature spec (input)
├── clarifications-needed.md   # Ledger: RD-1..RD-14, gaps G1–G3 (input)
├── runbook.md                 # FR-024 ops-track execution contract (input, authored with spec)
├── checklists/requirements.md # Spec quality checklist (input)
├── plan.md                    # This file
├── research.md                # Phase 0: decisions consolidated from ledger + import reality
├── data-model.md              # Phase 1: resource/manifest/secret inventory ("entities")
├── quickstart.md              # Phase 1: how to run the Verification Gate + fallback ladder
└── contracts/                 # Phase 1: authored-surface contracts
    ├── tofu-module.md         #   infra/terraform/ resource & variable contract
    ├── kustomize-overlays.md  #   base/overlay render contract + hardening assertions
    ├── secrets-sops.md        #   .sops.yaml + k8s/secrets/*.enc.yaml contract
    └── deploy-backup.md       #   deploy-aws.sh + Dockerfile(.backup) + CronJob contract
```

### Source Code (repository root — authored surface)

```text
infra/terraform/                  # NEW — OpenTofu root module (US1 / FR-001..007)
├── versions.tf                   # provider + OpenTofu version pins
├── providers.tf                  # aws provider (region var), default_tags
├── backend.tf                    # S3 backend: squiredocs-tofu-state, use_lockfile=true (RD-7)
├── variables.tf                  # region, instance_type, volume sizes, operator_cidr (no default, rejects 0.0.0.0/0),
│                                 #   restrict_443_to_cloudfront (default true, G1), alarm_email, tags
├── kms.tf                        # CMK alias/squiredocs, rotation on (RD-3)
├── network.tf                    # security group (443 world|CF-prefix-list toggle; 22/6443 operator_cidr only)
├── compute.tf                    # EC2 node (IMDSv2 required, encrypted root+data EBS), Elastic IP
├── cloud-init.yaml.tftpl         # k3s install: --secrets-encryption, --tls-san (EIP + DNS name)
├── iam.tf                        # instance role (ECR pull only), s3-images user, backup writer (PutObject on backup bucket)
├── backup_bucket.tf              # squiredocs-db-backups: SSE-KMS, versioning, Object Lock (governance, RD-5),
│                                 #   lifecycle (Glacier IR@30d, expire@365d), block public access, freshness alarm (RD-6, SNS)
├── edge.tf                       # CloudFront import (<cloudfront-distribution-id>, https-only, access logs); WAF WebACL (RD-4);
│                                 #   Route53 app.squiredocs.com A→EIP TTL 60 (RD-14); zone as read-only data source
├── account.tf                    # SEPARATED, ops-track-applied header: EBS default encryption, CloudTrail, GuardDuty,
│                                 #   AWS Config + IAM Access Analyzer, IAM password policy, ECR lifecycle policy (FR-007)
├── outputs.tf                    # EIP, node id, bucket names, distribution id, SG id
├── imports.tf                    # import block(s) for the CloudFront distribution (FR-006 / SC-004)
└── README.md                     # module usage; NOT the repo README (override permits infra/terraform/README.md)

k8s/                              # RESTRUCTURED (US2 / FR-008..016)
├── base/                         # environment-neutral shared manifests
│   ├── kustomization.yaml
│   ├── namespace.yaml            # collab ns (PSS labels layered per-overlay)
│   ├── app-deployment.yaml       # ${IMG} removed → Kustomize images: override
│   ├── app-service.yaml
│   ├── app-hpa.yaml
│   ├── postgres-{deployment,service,pvc}.yaml
│   ├── redis-{deployment,service,pvc}.yaml
│   ├── db-migrate-job.yaml
│   └── postgres-backup-cronjob.yaml
├── overlays/
│   ├── minikube/                 # dev: unchanged behavior (FR-009) — premium-rwo SCs, /health, passwordless redis
│   │   ├── kustomization.yaml
│   │   ├── storageclasses/       # minikube-{premium,standard}-rwo-sc.yaml (moved here, dev-only)
│   │   ├── app-dev.yaml          # app-dev tooling pod (dev-only)
│   │   └── patches/              # PSS warn=baseline only (RD-8); any minikube deltas
│   └── aws-prod/                 # hardened production posture
│       ├── kustomization.yaml    # images: postgres/redis/backup by digest (FR-015); app image set at deploy time
│       ├── patches/
│       │   ├── k3s-deltas.yaml   # local-path SC, pg PVC 5Gi, pg mem req 256Mi, HPA max 2 (FR-010)
│       │   ├── securitycontext.yaml   # runAsNonRoot/allowPrivEsc=false/drop ALL/seccomp RuntimeDefault (FR-011)
│       │   ├── redis-auth.yaml   # --requirepass from redis-auth secret, --maxmemory 192mb allkeys-lru (FR-013, RD-12)
│       │   ├── postgres-tuning.yaml   # real -c server args replacing no-op POSTGRES_* env (FR-014)
│       │   ├── app-probes.yaml   # readiness /ready, liveness /health; REDIS_PASSWORD env (FR-016, FR-013)
│       │   └── backup-hardening.yaml  # non-root, pinned Dockerfile.backup image, PGPASSFILE, Forbid, limits (FR-022/023)
│       ├── namespace-pss.yaml    # PSS enforce=restricted labels (RD-8)
│       ├── networkpolicies.yaml  # default-deny + scoped allows (FR-012)
│       └── app-ingress.yaml      # active Traefik Ingress (from k8s/aws/app-ingress.yaml): squiredocs.com +
│                                 #   app.squiredocs.com → collab-app:80; the ingress the NetworkPolicy allow targets
└── secrets/                      # NEW — SOPS/age encrypted (US3 / FR-017..019)
    ├── postgres-secret.enc.yaml
    ├── mcp-auth-secret.enc.yaml
    ├── ses-secret.enc.yaml
    ├── s3-images-secret.enc.yaml
    ├── auth-secret.enc.yaml       # from auth.production.env surface (encrypted placeholder ok)
    ├── redis-auth.enc.yaml        # NEW secret (redis password; placeholder until ops-track value)
    └── backup-s3cmd.enc.yaml      # replaces gitignored plaintext s3cmd-configmap (FR-018)

.sops.yaml                        # NEW — age recipients + creation rules for k8s/secrets/*.enc.yaml (FR-017, RD-13)
Dockerfile                        # EDIT — pin both node:22-alpine stages by digest; keep non-root appuser (FR-020)
Dockerfile.backup                 # NEW — alpine@digest + postgresql16-client + s3cmd, non-root, script baked (RD-9)
script/deploy-aws.sh              # REWRITE — set -euo pipefail; kubectl apply -k aws-prod; digest resolve-or-fail;
                                  #   rollout-status gate before deploy tag; keep context guard + migrate gate (FR-021)
script/backup-postgres.sh         # EDIT — PGPASSFILE, timestamped filename, target squiredocs-db-backups, no traced secret (FR-023)

# Left untouched (RD-11): k8s/ingress.yaml (GKE ManagedCertificates), script/deploy.sh (GKE/minikube).
# k8s/aws/app-ingress.yaml is the ACTIVE Traefik ingress — its content moves into overlays/aws-prod/app-ingress.yaml
# (not "left untouched"); k8s/aws/namespace.yaml is identical to base namespace and is superseded.
# gitignored legacy plaintext files (k8s/s3cmd-configmap.yaml, k8s/*-secret.yaml, k8s/auth.production.env) remain the
# ops-track's local source-of-truth for encrypting the .enc.yaml files; they are NOT committed.
```

**Structure Decision**: Two authored trees. (1) A brand-new `infra/terraform/` root module — no prior Terraform/Tofu exists in the repo. (2) A restructure of the existing flat `k8s/` directory into Kustomize `base/` + `overlays/{minikube,aws-prod}` with a new `k8s/secrets/` SOPS tree, plus targeted edits to `Dockerfile`, a new `Dockerfile.backup`, and rewrites of `script/deploy-aws.sh` and `script/backup-postgres.sh`. The `infra/terraform/README.md` is a module-local usage doc, not the repo `README.md` (which the override protects).

### Edge topology reconciliation (G3 — planned to import reality)

The **live** CloudFront distribution `<cloudfront-distribution-id>` has alias `squiredocs.com` and origin `app.squiredocs.com` → `<old-node-ip>` (the current EC2 IP). Therefore `app.squiredocs.com` is **already the origin A-record**, and the design doc's literal cutover wording ("the `app.squiredocs.com` Route53 record … repointed to the new node's Elastic IP") is correct as written. The plan manages exactly one Route53 record — the `app.squiredocs.com` origin A record (TTL 60) — and repoints it to the new EIP at cutover. The apex `squiredocs.com` alias to the distribution already exists and does not change (distribution is imported, not recreated); the zone stays a read-only data source.

Consequence for the ledger: **G3's RATIFIED-BY-DEFAULT default introduced a new `origin.app.squiredocs.com` hostname that import reality does not require.** Per the override I do not silently rewrite the ledger; this is surfaced as a **MEDIUM** analyze finding (ledger G3 default should be reconciled to `app.squiredocs.com`; design-doc wording needs no change). The G3 entry's own escape hatch already says "if the imported distribution's real origin/alias layout differs, the import wins" — so this is the ledger operating as designed, not a blocker. `imports.tf` + `edge.tf` are written to the `app.squiredocs.com`-origin reality; runbook §2.2 reconciliation rule stands.

### G1 reconciliation (kept as recorded default)

443-to-CloudFront scoping stays a Tofu variable `restrict_443_to_cloudfront` (default `true`, using the AWS-managed CloudFront origin-facing prefix list as a data source), with the documented fallback of flipping it to open 443 to the world (still TLS-only) if ACME origin-cert issuance/renewal fails during the runbook's parallel-validation phase (§3.4). Design grades prefix-list scoping "ideally", not "must"; MEDIUM at most, no blocker.

## Work Sequencing

The five authored surfaces are ordered so each rests only on already-authored predecessors; the runbook (already written) is the sixth and references all of them.

1. **OpenTofu tree (US1)** — foundation for the AWS-side reality every later artifact names (bucket, IAM principals, EIP, edge). Order within the module: `versions`/`providers`/`backend`/`variables` → `kms` → `network` → `iam` → `backup_bucket` (+ freshness alarm) → `compute` + `cloud-init.yaml.tftpl` → `edge` (+ `imports.tf`) → `account.tf` (separated, ops-applied) → `outputs`. Verify with `tofu fmt -check`/`tofu validate` (or fallback ladder).
2. **Kustomize restructure (US2)** — move current manifests into `base/`, strip `${IMG}`, build `overlays/minikube` (behavior-preserving; diff against today's effective manifests for SC-003) then `overlays/aws-prod` (encode `sed` k3s deltas + full hardening: securityContext quadruple, PSS restricted, default-deny NetworkPolicy, Postgres `-c` tuning, Redis auth/maxmemory, probe split, digest pins). Verify `kustomize build` on both, zero `${...}` (SC-001/002/003).
3. **SOPS/age secrets (US3)** — depends on the Kustomize wiring (secret names referenced by base/overlay). Author `.sops.yaml` (recipients + `encrypted_regex` scoped to `data`/`stringData`), create encrypted files (or encrypted placeholders) for the five existing secrets + new `redis-auth` + `backup-s3cmd`; document encrypt / decrypt-and-apply / placeholder flows (FR-019). Verify every `k8s/secrets/*` file carries SOPS metadata, zero plaintext values (SC-005).
4. **Dockerfile + Dockerfile.backup (US4/US5)** — digest-pin both `node:22-alpine` stages, preserve non-root `appuser`; author `Dockerfile.backup` (alpine@digest + pg16-client + s3cmd, non-root, script baked). Verify by review + `docker build` deferred to ops track.
5. **backup CronJob + backup-postgres.sh (US5)** — in aws-prod overlay: non-root restricted securityContext, pinned backup image, `concurrencyPolicy: Forbid`, resource requests/limits; script uses `PGPASSFILE`, timestamped filenames, targets `squiredocs-db-backups`, no traced secret. Verify by render + shell review (SC-006).
6. **deploy-aws.sh rewrite (US4)** — `set -euo pipefail`; `kubectl apply -k k8s/overlays/aws-prod` (no sed/envsubst); resolve pushed image digest from ECR (fail if unresolvable, RD-10); digest image override; keep context guard + migrate gate; gate the `deployed-collab-aws-*` tag behind `kubectl rollout status`. Verify `bash -n` + shell-logic review (SC-007).
7. **Runbook (US6)** — already authored; cross-checked in analyze against the artifacts above (SC-008), including the feature-010 image gate and CloudFront-import reconciliation rule.

## Verification Gate *(this feature's definition of "tests pass")*

**NOT `npm test`.** No application code changes, so the app suites are unaffected and MUST remain untouched and green. The gate is:

1. `kustomize build` (or `kubectl kustomize`) on **each** overlay — must succeed with **zero** unexpanded `${...}` placeholders (SC-001), plus the aws-prod hardening assertions (SC-002: 100% of workload pods carry the restricted securityContext quadruple; default-deny NetworkPolicy present; 100% non-app images digest-pinned; PSS `restricted` labels) and the minikube behavioral-identity diff (SC-003).
2. `tofu validate` + `tofu fmt -check` in `infra/terraform/` (SC-004: import binding for `<cloudfront-distribution-id>` present; zero managed `aws_route53_zone`).
3. SOPS assertion (SC-005): every committed `k8s/secrets/*` file carries SOPS metadata; zero plaintext secret values added to git.
4. Shell review (SC-006/SC-007): backup CronJob 5/5 hardening properties; `deploy-aws.sh` exits non-zero without tagging on a failed rollout, tags exactly once on success.

**Toolchain Fallback Ladder** (from Technical Context) applies: `tofu`/`terraform`/`kustomize`/`kubectl`/`sops`/`age` are absent in the dev pod today, so the gate degrades to structured manual review with the degradation recorded in implementation notes; the ops track re-runs the real validators before any apply (runbook Phase 2.1 / 3.2).

## Complexity Tracking

> No Constitution Check violations — table intentionally empty.

| Violation | Why Needed | Simpler Alternative Rejected Because |
|-----------|------------|-------------------------------------|
| — | — | — |
