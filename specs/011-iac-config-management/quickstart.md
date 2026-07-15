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

## What this quickstart does NOT do

No `tofu apply`, no `kubectl apply` to a real cluster, no image push, no cutover. The end-to-end migration is the runbook (`runbook.md`), executed by the ops track — gated on an ECR image containing feature 010.
