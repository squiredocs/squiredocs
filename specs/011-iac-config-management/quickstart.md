# Quickstart — Verifying 011-iac-config-management

This feature is **authoring only** — it applies nothing to AWS. "Running it" means running the **Verification Gate** (NOT `npm test`). Below is how to validate the authored artifacts, plus the fallback ladder for when the real tools are absent (they are absent in the dev pod today: `tofu`, `terraform`, `kustomize`, `kubectl`, `sops`, `age` all missing as of 2026-07-15).

## Prerequisites (preferred path)

`tofu` ≥ 1.10, `kustomize` (or `kubectl` with built-in kustomize), `sops`, `age`. None required to author; all required to run the preferred gate. If unavailable, use the fallback ladder (below) and record the degradation in the implementation notes so the ops track re-runs the real validators (runbook Phase 2.1 / 3.2).

## Gate 1 — Kustomize renders (SC-001/002/003)

```
kustomize build k8s/overlays/minikube   # or: kubectl kustomize k8s/overlays/minikube
kustomize build k8s/overlays/aws-prod
```
Expected:
- Both succeed; **zero** occurrences of `${` in either render (`… | grep -c '\${'` → 0).
- aws-prod: every workload pod carries the restricted securityContext quadruple; a default-deny NetworkPolicy is present; every non-app image is `@sha256:`-pinned; namespace has PSS `enforce=restricted`.
- minikube: diff the render against today's effective manifests — no behavioral change (probe paths `/health`, storage classes, PVC sizes, image tags, env vars).

## Gate 2 — OpenTofu (SC-004)

```
cd infra/terraform
tofu fmt -check     # 0 files need formatting
tofu validate       # passes
```
Expected: an `import` binding for distribution `<cloudfront-distribution-id>` is present; **zero** managed `aws_route53_zone` resources (grep the tree). `tofu init`/`plan`/`apply` are **ops-track only** (real credentials + tfvars).

## Gate 3 — Secrets (SC-005)

- Every committed file under `k8s/secrets/` carries a `sops:` metadata block; no plaintext secret values.
- `git grep` finds no plaintext credential added by this feature.
- (Ops track, with the age key) `sops -d k8s/secrets/<file>.enc.yaml` round-trips.

## Gate 4 — Build/deploy/backup review (SC-006/007)

- `bash -n script/deploy-aws.sh` clean; logic review confirms: `set -euo pipefail`; `kubectl apply -k`; digest resolve-or-fail; deploy tag gated behind `kubectl rollout status`.
- Backup CronJob + `script/backup-postgres.sh`: 5/5 hardening properties (non-root, pinned tooling image, no password in argv/trace, timestamped filenames, `concurrencyPolicy: Forbid` + resource limits).
- `Dockerfile`: both stage bases `@sha256:`-pinned; non-root `appuser` preserved.

## Fallback ladder (when validators are absent)

1. `terraform fmt -check` / `terraform validate` if a Terraform binary exists; `kubectl kustomize` if kubectl exists but kustomize does not.
2. Else **structured manual review**: HCL syntax/reference review against the FRs (every resource/variable/data source referenced exists and resolves); YAML/kustomization cross-reference (every `resources:` entry exists, every patch `target` resolves, zero `${...}` in the conceptual render). Record "validators unavailable — deferred to ops track" in the implementation notes.

## Implementation notes — verification record (2026-07-15, IMPLEMENT agent)

**Which rung actually ran.** The dev pod ships without `tofu`/`kustomize`/`sops`/
`age` (T002 confirmed them absent), but the pod HAS outbound network, so the
implement agent installed pinned binaries and ran the **PREFERRED** gate — not a
fallback — for the whole feature:

| Validator | Version | Result |
|-----------|---------|--------|
| `tofu fmt -check -recursive` | OpenTofu 1.10.0 (arm64) | **CLEAN** (0 files) |
| `tofu validate` (after `tofu init -backend=false`, providers fetched) | OpenTofu 1.10.0 + hashicorp/aws ~>5.60 | **Success! The configuration is valid.** |
| `kustomize build k8s/overlays/minikube` | kustomize 5.4.3 (arm64) | OK — 15 objects, **0** `${...}` |
| `kustomize build k8s/overlays/aws-prod` | kustomize 5.4.3 (arm64) | OK — 19 objects, **0** `${...}` |
| `sops -e`/`-d` round-trip | sops 3.9.0 + age 1.2.0 (arm64) | 7/7 files encrypted; decrypt round-trips; **0** plaintext values |

**Verified assertions on the real renders**: aws-prod carries the restricted
securityContext quadruple on all 5 workloads (app/postgres/redis/migrate/backup),
PSS `enforce=restricted`, a `default-deny-all` NetworkPolicy + 5 scoped allows,
3/3 non-app images `@sha256:`-pinned, redis `--requirepass`/maxmemory, postgres
`-c` tuning (no-op env removed), app readiness `/ready` + liveness `/health`,
backup CronJob `concurrencyPolicy: Forbid`. minikube renders behaviorally
identical (collab:latest, `/health` both probes, premium-rwo SCs, PVC 20Gi/1Gi,
passwordless redis, PSS warn=baseline, no backup CronJob). OpenTofu tree: import
binding for `<cloudfront-distribution-id>` present, **0** managed `aws_route53_zone`, single
managed `app.squiredocs.com` A record, `operator_cidr` rejects `0.0.0.0/0`.

**What the ops track MUST still re-run before any apply** (authoring could not
resolve these):
1. Replace the **placeholder third-party image digests** (`sha256:0000…` for
   `pgvector/pgvector`, `redis`, `collab-backup`) with real resolved arm64
   digests (runbook §3.2). The pins are structurally correct; only the SHAs are
   placeholders.
2. Replace the **placeholder `.sops.yaml` age recipient** with the real operator
   public key and re-encrypt every `k8s/secrets/*.enc.yaml` with real values
   (runbook §0.2/§0.4). The committed ciphertext holds placeholder values only.
3. `tofu init` (real S3 backend) → `tofu import` the CloudFront distribution →
   `tofu plan` reconciliation (runbook §2.1–2.3) before `tofu apply`.

## What this quickstart does NOT do

No `tofu apply`, no `kubectl apply` to a real cluster, no image push, no cutover. The end-to-end migration is the runbook (`runbook.md`), executed by the ops track — gated on an ECR image containing feature 010.
