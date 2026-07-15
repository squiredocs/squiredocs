# Contract — OpenTofu root module (`infra/terraform/`)

**Consumers**: the ops track (runbook Phases 1–4). **Producer**: this feature (authoring only). **Verification**: `tofu fmt -check` + `tofu validate` or fallback ladder.

## Interface

- **Inputs (variables.tf)** — `region` (default `us-east-1`), `instance_type` (default `t4g.medium`), `root_volume_size` (20), `data_volume_size` (30), `operator_cidr` (**required, no default**; validation MUST reject `0.0.0.0/0` and `::/0`), `restrict_443_to_cloudfront` (bool, default `true`), `alarm_email` (string), `tags` (map). Real values supplied via untracked tfvars at apply time.
- **Outputs (outputs.tf)** — Elastic IP, node instance id, `squiredocs-db-backups` + `squiredocs-tofu-state` bucket names, distribution id `<cloudfront-distribution-id>`, security group id.
- **State** — S3 backend `squiredocs-tofu-state`, `use_lockfile=true`, encrypt, versioned. Bucket bootstrapped once by ops track (not managed by the state it stores).

## Guarantees (checked in analyze / verification)

1. `imports.tf` contains an `import` block (or documented `tofu import`) binding `<cloudfront-distribution-id>` → the `aws_cloudfront_distribution` resource. **The distribution is never destroyed/recreated.** (SC-004)
2. **Zero** managed `aws_route53_zone` resources; `squiredocs.com` appears only as `data "aws_route53_zone"`. (SC-004)
3. Exactly one managed Route53 record: `app.squiredocs.com` A → EIP, TTL 60 (the origin/cutover record; G3 reconciled to import reality — no `origin.*` hostname).
4. Security group: 443 from world OR CloudFront origin-facing prefix list (per `restrict_443_to_cloudfront`); 22/6443 from `operator_cidr` only; no other ingress.
5. EC2 node: `http_tokens=required`, root+data EBS encrypted with the CMK; cloud-init installs k3s with `--secrets-encryption` and `--tls-san` (EIP + DNS name).
6. Backup bucket: SSE-KMS, versioning, Object Lock governance 30d, lifecycle (Glacier IR@30d, expire@365d), block-all-public; freshness alarm → SNS email.
7. Account controls (`account.tf`) carry a header stating the ops track applies them; they are drift-tracked here, not a done-ness condition of this feature.
8. IAM is three separated least-privilege principals (instance role ECR-pull-only; images user object-only; backup writer PutObject-on-backup-bucket-only).

## Non-goals

No `tofu apply`, no account-setting changes, no credential creation/rotation, no cutover — all ops-track (runbook).
