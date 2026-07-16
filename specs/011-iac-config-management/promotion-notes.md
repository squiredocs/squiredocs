# Feature 011 — Promotion / ops-track notes (post-merge review fixes)

Landed on branch `011-review-fixes` (fix agent). These are the items where the
review fix implements a **safe default in code** but the value or an action is
genuinely an **ops-track / runtime choice** the operator must confirm or flip.
Strict, self-contained fixes (H2, H3, M2, M5, L1, L2, F2, drain) are not repeated
here — see the commits.

## H1 — origin A record: default is a NO-OP; cutover FLIPS a variable

`aws_route53_record.origin` (`app.squiredocs.com`) is now:
- **imported** (an `import` block in `edge.tf`) — it already exists as the live
  CloudFront origin, so it is brought under management, never created; and
- valued by **`var.origin_target_ip`**, which **defaults to the current live node
  IP `<old-node-ip>`**.

Consequence: a pre-cutover `tofu plan/apply` is a **no-op on this record** — it
does NOT repoint the live origin to the new, unvalidated node.

**Ops action (cutover, runbook §4.6):** set `origin_target_ip` in the tfvars file
to the NEW node's Elastic IP (`tofu output` of `aws_eip.node.public_ip`) and
`tofu apply`. A `plan` immediately before this MUST show a change to ONLY this one
record. Rollback = set it back to `<old-node-ip>` and apply (sub-minute at TTL 60).

> If `<old-node-ip>` is not the live origin IP at cutover time, correct the default
> (or supply the real current IP via tfvars) BEFORE the first apply, and re-confirm
> the pre-cutover plan is clean. Verify with:
> `dig +short app.squiredocs.com` before touching anything.

## M4 — data volume format/mount: verify device + first-boot-only format

`cloud-init.yaml.tftpl` now formats the 30 GiB encrypted volume (ext4, label
`k3s-data`) and mounts it at k3s's default local-path dir
(`/var/lib/rancher/k3s/storage`) so PVCs land on it, not the 20 GiB root.

- Device is `/dev/sdf` (matches `aws_volume_attachment.data`). On Nitro/Graviton
  the kernel enumerates EBS as NVMe, but **AL2023's ebs-nvme udev rules keep the
  `/dev/sdf` symlink**, and the mount binds by `LABEL=k3s-data` so a rename can't
  break it. **Ops verify (runbook §2.4):** `lsblk -f` shows `k3s-data` mounted at
  `/var/lib/rancher/k3s/storage`; `df -h` shows PVCs consuming the data volume.
- `fs_setup` uses `overwrite: false` — it formats only a blank volume. A re-run /
  reboot will NOT reformat existing data. A genuinely fresh replacement volume WILL
  be formatted on first boot (intended).

## M1 — CloudFront-logs bucket now has ACLs ENABLED

To satisfy CloudFront standard logging, the `squiredocs-cloudtrail-logs` bucket now
uses **BucketOwnerPreferred** ownership (ACLs enabled) plus an ACL granting the
CloudFront log-delivery account FULL_CONTROL (fixed canonical id, same in every AWS
account). Public access is still fully blocked. If a bucket-level control (SCP /
Config rule) mandates `BucketOwnerEnforced` account-wide, the alternative is to
point `logging_config` at a separate, correctly-configured log bucket instead —
note the deviation if you take that path.

## M3 — AWS Config now actually RECORDS (cost + delivery)

`aws_config_configuration_recorder_status` starts the recorder (previously created
but never started, so it recorded nothing). Config now delivers snapshots to
`squiredocs-aws-config` (role S3 perms + bucket policy added). This has a small
ongoing cost. It is an account-level control applied by the ops track in **runbook
Phase 1.1** and is independently disableable (set `is_enabled=false` / stop the
recorder) with no effect on the serving workload.

## Left for the ops track (unchanged from the runbook, not fixed here)

- Third-party image digests in `k8s/overlays/aws-prod/kustomization.yaml` are still
  `sha256:0000…` placeholders (no registry access in the authoring/fix pod) —
  resolved by the ops track in runbook §3.2. Structurally they are digest pins.
- The KMS/CloudTrail/Config/edge resources are authored but **not applied** — every
  AWS mutation stays on the human-supervised ops track (Phase 1/2).

## Post-cutover (2026-07-16) — converged, with follow-ups

- **Origin TLS back-ported.** cert-manager + Let's Encrypt (Route53 DNS-01) is now in
  the repo: `k8s/overlays/aws-prod/tls/{clusterissuer,certificate}.yaml`,
  `k8s/secrets/route53-dns01.enc.yaml` (SOPS), the `squiredocs-cert-dns01` IAM user
  in `iam.tf` (imported), and `script/bootstrap-cluster-addons.sh` (pinned
  cert-manager install). Was live-only before; no longer out-of-repo memory.
- **`cert-dns01` policy is broader than strictly needed.** It mirrors the live,
  working policy (`ChangeResourceRecordSets` + `ListResourceRecordSets` +
  `ListHostedZonesByName`). With a pinned `hostedZoneID`, cert-manager needs only
  `GetChange` + `ChangeResourceRecordSets`. **Owed:** drop the two `List*` actions
  and confirm a forced `cmctl renew app-squiredocs-tls -n collab` still succeeds
  before removing them — tightening unverified risks a silent renewal failure →
  cert expiry → outage.
- **Third-party image digests were resolved** during provisioning (real arm64
  digests pinned in `kustomization.yaml`); the `sha256:0000…` note above is
  historical.
- **`.sops.yaml` recipient is the real operator key** (matches
  `k8s/secrets/age-operator.key`), and the committed `*.enc.yaml` hold real in-use
  values — the earlier "throwaway placeholder recipient" framing was retired.
</content>
