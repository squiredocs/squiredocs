# Runbook — Migration to the Dedicated Hardened Cluster (feature 011)

**Executor**: the ops track (Sam / the orchestrator) — this feature authored the
artifacts; nothing here was applied by the implementing agent. Every step below is
run by a human-supervised session holding real AWS credentials and the age private
key.

**Ground truth**: `design/infrastructure-and-environments.md` (d20917e), "Migration
& cutover". **Hard invariant**: `API_KEY_ENCRYPTION_KEY` is carried over
**unchanged** — there is no rotation path; a new key renders every stored BYOK key
undecryptable.

**Conventions**: each step has ✅ *Verify* and, where meaningful, ↩ *Rollback*.
Stop on any failed verification. Decisions referenced as RD-n / G-n live in
`clarifications-needed.md`.

---

## Status (as of 2026-07-16)

This runbook was authored before anything was applied. Much of it has since been
**executed** while the old shared node keeps serving production. Snapshot:

- **Phase 2 (provision) — DONE.** The dedicated cluster is up: node
  `<prod-instance-id>`, EIP `<prod-eip>`, k3s (arm64) in the wft-public VPC
  (`<vpc-id>` / `<subnet-id>`; **no default VPC**, so
  VPC/subnet are explicit vars). State in `s3://squiredocs-tofu-state`; gitignored
  `terraform.tfvars` (`operator_cidr <operator-ip>/32`, `alarm_email admin@example.com`).
  Applied with the edge (`aws_cloudfront_distribution.app`, `aws_route53_record.origin`)
  excluded — edge stays deferred until cutover so the live origin is untouched.
  The node is managed via **SSM only** (`AmazonSSMManagedInstanceCore` on the role,
  no SSH key). Fixes made live + in IaC during apply: no-default-VPC, non-ASCII SG
  description, WAF parens, pre-existing images IAM user left unmanaged, data-volume
  mount via `runcmd` (Nitro `fs_setup` race), app `runAsUser: 100`.
- **Phase 3 (deploy & validate) — DONE.** App stack deployed via SSM (manifests +
  secrets relayed through presigned S3, deleted after): all pods Running,
  migrations complete, `/ready` → `{datastore: up, cache: up}`, Redis
  password-auth + pub/sub working, serving through Traefik. The `collab-backup`
  overlay digest was resolved and the backup image built/pushed to ECR.
- **Backup pipeline — DONE + validated.** Reworked from s3cmd to **AWS CLI v2**
  (`postgres:16-bookworm`) because s3cmd can't satisfy Object Lock's required
  `PutObject` checksum; secret renamed `backup-s3cmd` → `backup-writer-creds`
  (env creds, not an s3cfg mount); CronJob runs the script under `/bin/bash`
  (Debian `/bin/sh` = dash, no `pipefail`). A test dump landed in the SSE-KMS +
  Object-Lock `squiredocs-db-backups` via the scoped writer; nightly CronJob live.
- **ECR pull-secret refresh — DONE.** A host `systemd` timer mints the `ecr-creds`
  secret from the instance role every 6h (pods can't reach IMDS at hop limit 1);
  ECR workloads carry `imagePullSecrets`. Back-ported to cloud-init.
- **Edge reconciliation — DONE (authoring), apply deferred.** `edge.tf` aligned to
  the live CloudFront config (so a cutover apply is a clean in-place change — only
  intended deltas: WAF, access logging, https-only origin, `/assets/*` caching);
  still `-exclude`d from apply until cutover.
- **Data restore — REHEARSED, success.** A real prod dump was restored into the new
  cluster (scale app 0 → drop/recreate `collab_db` → `gunzip -c | k3s kubectl exec
  -i deploy/collab-postgres -- psql` → migrate delta was a no-op → scale up). The
  new cluster currently holds a **throwaway** copy of real data, to be replaced by
  the final dump at the actual cutover.

- **STILL OWED**: the **maintenance-window cutover itself (Phase 4)** and
  **Phase 5 post-cutover**; **SNS subscription email confirmation** for the backup
  alarm; the **010 browser smoke** (SC-009); ratification of **G1** (443-scope vs
  ACME) and **G2** (feature-010 image). Sam drives the cutover — it needs his
  go-ahead and a window.

> **Repo-branch note**: several of the DONE items above (AWS-CLI backup rework, ECR
> timer in cloud-init, edge caching + deploy-time CloudFront invalidation) landed on
> a **concurrent infra branch not yet merged to `main`**. On `main`, the
> corresponding code (`Dockerfile.backup`, `script/backup-postgres.sh`,
> `cloud-init.yaml.tftpl`, `edge.tf`, `deploy-aws.sh`) still shows the earlier
> approach. `docs/operations.md` documents the operational reality; when the infra
> branch merges, this note can be dropped.

---

## Phase 0 — Prerequisites & bootstrap (any time)

0.1 **Tooling** on the operator workstation: `tofu` (OpenTofu ≥ 1.10 for native S3
    lockfile locking), `aws` CLI v2, `sops`, `age`, `kubectl` (with kustomize
    built in), `docker`, `jq`.
    ✅ `tofu version && sops --version && age --version`.

0.2 **age keypair** (RD-13): generate once, store the private key in the standard
    sops-age location. The committed `.sops.yaml` ships with a **throwaway
    placeholder recipient** (authoring key; its private key was never committed),
    so **replace that recipient with your real public key** in `.sops.yaml`
    before doing anything else. The committed `k8s/secrets/*.enc.yaml` hold
    placeholder values encrypted to the throwaway key — you re-create them with
    real values (and your key) in 0.4, so do not expect to decrypt them yet.
    ✅ After 0.4, `sops -d k8s/secrets/<any>.enc.yaml` round-trips with your key.

0.3 **State backend bootstrap** (RD-7): create `squiredocs-tofu-state` once —
    versioned, SSE, all public access blocked (mirror the hardening pattern of
    `script/provision-s3-images.sh`). Not managed by Tofu.
    ✅ `aws s3api get-bucket-versioning --bucket squiredocs-tofu-state` → Enabled.

0.4 **Re-encrypt real secrets**: replace any encrypted placeholders under
    `k8s/secrets/` with real values from the operator's gitignored sources
    (`k8s/auth.production.env`, `k8s/*-secret.yaml`), plus a newly generated
    strong Redis password for `redis-auth`. Commit the re-encrypted files.
    ✅ `git diff` shows only SOPS ciphertext; `sops -d` yields correct values.

## Phase 1 — Account-level enablement (before or parallel to Phase 2)

1.1 Apply the account-controls declaration (`tofu apply` targeted at the
    account file/module, or console with the Tofu config as the checklist):
    EBS default encryption → CMK (RD-3), CloudTrail (multi-region → S3),
    GuardDuty, AWS Config + IAM Access Analyzer, IAM password policy, ECR
    lifecycle policy. Confirm MFA on every human principal.
    Review-fix deltas landed here (see `promotion-notes.md`): the CMK now carries
    a key policy that lets CloudTrail encrypt its logs (M2); the CloudTrail-logs
    bucket now has ACLs enabled (BucketOwnerPreferred) for CloudFront standard
    logging (M1); **AWS Config is now actually STARTED and delivering** — a
    recorder-status + config-bucket policy + role S3 perms were added (M3), so
    Config incurs its normal ongoing cost from this apply onward.
    ✅ CloudTrail delivering; GuardDuty enabled; `aws ec2 get-ebs-encryption-by-default` → true;
    `aws configservice describe-configuration-recorder-status` → `recording: true`.
    ↩ Each toggle is independently disableable; none affect the serving workload.

## Phase 2 — Provision the new cluster (old node keeps serving)

2.1 `cd infra/terraform && tofu init` (backend from Phase 0.3).
    ✅ init succeeds with lockfile locking; `tofu validate` clean.

2.2 **Import the existing edge**: bring CloudFront distribution `<cloudfront-distribution-id>`
    under management (import block / `tofu import`); confirm the `squiredocs.com`
    zone appears only as a data source. The `app.squiredocs.com` origin A record
    is ALSO imported (an `import` block in `edge.tf`, H1) and its value is
    `var.origin_target_ip`, which **defaults to the current live node IP
    `<old-node-ip>`** — so this record plans as a **no-op** pre-cutover (it is
    never created-and-collided-with, nor repointed to the unvalidated node).
    First confirm the default matches reality: `dig +short app.squiredocs.com`.
    ✅ `tofu plan` after import shows **no replace/destroy** on the distribution
    **and no change to `aws_route53_record.origin`**.
    **Reconciliation rule (G3)**: if the plan shows destructive diffs, amend the
    declaration to match imported reality — never apply a replace. If the real
    origin/alias topology differs from the RD default (viewer→CloudFront alias,
    origin A record → EIP), the declaration and the cutover step 4.6 follow
    reality, and the design doc gets amended.

2.3 `tofu plan` for the full stack with real `operator_cidr` (RD-1) supplied via
    an untracked tfvars file. Review every resource; then `tofu apply`:
    KMS CMK → security group → IAM (instance role, images user, backup writer) →
    `squiredocs-db-backups` bucket + freshness alarm (RD-6) → EC2 node
    (cloud-init installs k3s with `--secrets-encryption`, `--tls-san`) →
    Elastic IP → WAF WebACL → Route53 records (TTL 60, RD-14).
    ✅ Plan and apply agree; EIP allocated; SNS subscription confirmed by email.
    ↩ `tofu destroy` is safe for everything created here (nothing serves yet);
    never destroy the imported distribution — `tofu state rm` it instead if
    backing out entirely.

2.4 **Node validation**: fetch the k3s kubeconfig (new context, e.g.
    `k3s-squiredocs`); confirm 22/6443 reachable **only** from the operator CIDR;
    IMDSv2 required; volumes encrypted with the CMK; secrets encryption active
    (`k3s secrets-encrypt status`). **Confirm the data volume is mounted (M4):**
    `lsblk -f` shows the `k3s-data` (ext4) volume mounted at
    `/var/lib/rancher/k3s/storage`, so local-path PVCs land on the 30 GiB
    encrypted volume, not the 20 GiB root (`df -h /var/lib/rancher/k3s/storage`).
    ✅ All checks pass; a probe from a non-operator IP times out on 22/6443; the
    data volume is mounted at the local-path dir.

2.5 **Backup credentials rotation** (G-adjacent, FR-018): create the access key
    for the new scoped backup writer; encrypt it into the backup SOPS secret;
    plan the deactivation of the old broadly-scoped s3cmd key (it targeted the
    legacy `earthquaketracksql` bucket) for Phase 5 — do not deactivate yet if
    the old node's nightly backup still uses it.
    ✅ Manual `s3cmd put` (or equivalent) with the new key lands an object in
    `squiredocs-db-backups`; the object shows SSE-KMS + Object Lock retention.

## Phase 3 — Deploy & validate the app on the new cluster (in parallel)

3.1 **Feature-010 gate (G2)**: confirm the image to deploy contains feature 010
    (`/ready` endpoint, `REDIS_PASSWORD` support). Do not proceed with a pre-010
    image.
    ✅ `git log` of the image's SHA includes 010; local smoke of `/ready`.

3.2 Build/push the app image and the backup image (`Dockerfile.backup`, RD-9).
    NOTE: `script/build-and-deploy-aws.sh` still hardcodes the **legacy**
    `k3s-wft-aws` context and forwards its args to `deploy-aws.sh`, whose guard
    now expects the new cluster (`DEPLOY_CONTEXT`, default `k3s-squiredocs`) — so
    either set `DEPLOY_CONTEXT`/point the wrapper at the new context, or build,
    push, and run `deploy-aws.sh` manually. The guard fails closed on a context
    mismatch (no wrong-cluster deploy).
    **Resolve the placeholder third-party image digests**: the aws-prod overlay
    (`k8s/overlays/aws-prod/kustomization.yaml`) pins `pgvector/pgvector`,
    `redis`, and `collab-backup` to **placeholder** `sha256:0000…` digests (the
    authoring pod had no registry access). Replace each with the real resolved
    arm64 digest before applying —
    `docker buildx imagetools inspect pgvector/pgvector:pg16` (and `redis:7-alpine`),
    and the pushed `collab-backup` digest from ECR. Then apply secrets
    (`for f in k8s/secrets/*.enc.yaml; do sops -d "$f" | kubectl apply -f -; done`)
    and run `script/deploy-aws.sh` (it resolves the app digest from ECR and does
    `kubectl apply -k`).
    ✅ No `sha256:0000…` placeholder remains in the overlay; rollout gate passes;
    migrate Job completes; all pods Ready via `/ready`.

3.3 **Hardening validation on the live cluster**: PSS `restricted` labels active;
    NetworkPolicies enforced (an ad-hoc pod cannot reach postgres; app can);
    Redis rejects unauthenticated `PING`; backup CronJob dry-run (manual Job from
    the CronJob spec) lands a timestamped dump in `squiredocs-db-backups`.
    ✅ Each check individually.

3.4 **Edge validation**: hit the new node through CloudFront (staging alias or
    Host-header test); WAF metrics visible; origin cert issuance/renewal works
    under the CloudFront-scoped 443 (G1) — if ACME fails, flip
    `restrict_443_to_cloudfront=false`, re-apply, and note the deviation.
    ✅ End-to-end 200s through the edge; WebSocket upgrade works (collab session).

3.5 Lower/confirm DNS TTLs at 60s (RD-14) at least one old-TTL period before the
    window.
    ✅ `dig` shows TTL ≤ 60 from public resolvers.

## Phase 4 — Maintenance-window cutover (design steps, in order)

4.1 Announce/schedule the window. Take a pre-cutover `tofu plan` (must be clean —
    no drift) and a fresh manual backup of the old DB.
4.2 **Scale the old app to zero** (quiesces Yjs writes):
    `kubectl --context k3s-wft-aws -n collab scale deploy/collab-app --replicas=0`.
    ✅ Old app pods gone; no active WebSocket sessions.
    ↩ Scale back to 2 — service restored, window aborted.
4.3 **Final dump**: `pg_dump` of `collab_db` from the old cluster (timestamped
    file, kept locally *and* uploaded to the backup bucket).
    ✅ Dump size sane vs. previous nightlies; `pg_restore --list`/gunzip test OK.
4.4 **Restore** into the new cluster's Postgres (fresh DB; restore; run the
    migrate Job — should be a no-op if versions match).
    ✅ Row counts on key tables match the old DB; migrate Job reports no pending
    migrations.
4.5 **`API_KEY_ENCRYPTION_KEY` invariant**: confirm the new cluster's
    `auth-secret` carries the identical value (byte-for-byte) from the old
    cluster.
    ✅ A stored BYOK provider key decrypts and validates on the new cluster
    (e.g., a chat-model key check succeeds for a BYOK user). **If this fails,
    stop — do not repoint DNS.**
4.6 **Repoint DNS** to the new node's Elastic IP — per G3's topology this is the
    origin A record (or whichever record Phase 2.2 reconciliation identified).
    **Flip the variable, not the console** (H1): set `origin_target_ip` in the
    tfvars file to the new EIP (`tofu output` → `aws_eip.node.public_ip`) and
    `tofu apply`. A `plan` immediately before MUST show a change to ONLY
    `aws_route53_record.origin`.
    ✅ Within ~60s, requests through `app.squiredocs.com` serve from the new
    node; login, doc open, collab edit, import/export, MCP login flow all pass.
    ↩ Rollback = set `origin_target_ip` back to the old IP (`<old-node-ip>`) and
    apply — sub-minute at TTL 60 (this is the DNS revert referenced in 4.7).
4.7 **Smoke & soak**: watch logs, `/ready`, WAF metrics, and error rates for the
    remainder of the window. Redis warms cold — expect a brief cache-miss bump;
    images serve unchanged from the shared `squiredocs-images` bucket (no
    migration).
    ↩ **Rollback path (any failure after 4.6)**: repoint the same DNS record back
    to the old node's IP (Tofu revert), scale the old app back up, done —
    sub-minute propagation at TTL 60. Any writes made on the new cluster during
    the failed window are reconciled manually from its dump before a retry.

## Phase 5 — Post-cutover

5.1 Old node stays **warm for 7 days** (scaled-down app, DB intact) as the
    rollback target; calendar the decommission.
5.2 First nightly backup: confirm a timestamped object in
    `squiredocs-db-backups`; confirm the freshness alarm stays green (and fires
    when tested by suspending the CronJob for a day, optional).
5.3 **Restore drill**: restore that first nightly into a scratch database and
    verify a document's full history (`yjs_updates`) survives. An untested backup
    is not a backup.
5.4 **Deactivate the old broadly-scoped s3cmd key** (from 2.5); remove the old
    cluster's backup CronJob.
5.5 Decommission after the warm window: final archival dump of the old DB to the
    backup bucket, then remove Squire's workloads from the shared node and delete
    the old kube context. (The shared node itself belongs to wildfiretrackers —
    do not touch its infrastructure.)
5.6 Post-migration docs pass (separate commit, ops track): README/dev docs deploy
    sections reflect Kustomize + SOPS flow; design doc amended if any runbook
    step deviated (G1 fallback, G3 reconciliation).
