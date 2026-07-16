# Feature 013 — Promotion / ops-track notes

Started at spec time (2026-07-16). Items here are accepted limitations, ops-track
actions, and follow-ups that outlive the authoring work. Extend during plan /
implement / review.

## Verification-gate results (authoring, 2026-07-16)

Ran in the authoring pod (`tofu` + `kustomize` present; `terraform`/`kubectl`/
`yamllint` absent — inherited 011 fallback ladder):

- **Gate 1 (Terraform)** — `tofu fmt -check`: 0 diffs. `tofu validate`: Success
  (providers reused from the main tree's `.terraform`). All monitoring/alarm
  resources declared. **PASSED.**
- **Gate 2 (Kustomize)** — `kustomize build` on both overlays succeeds. aws-prod
  renders the Collector with all 7 receiver classes + the OTLP/TLS exporter to the
  node + the `otel-collector` 4317/4318 Service + `o11y` at `enforce=privileged` +
  the 5 NetworkPolicy paths. **minikube is byte-identical** to the pre-013 baseline
  (`git stash -u` diff) with **0** collector/openobserve/o11y/monitoring references.
  **PASSED.**
- **Gate 3/4 (privacy + secrets grep)** — 0 content-bearing telemetry fields in the
  authored config. The `"title"` grep hits are all **dashboard/panel display names**
  ("Postgres — Health", "Deadlocks", …) — infra identifiers, not document content.
  Both new `k8s/secrets/*.enc.yaml` are clearly-marked PLACEHOLDER scaffolds with 0
  real values (SC-004). **PASSED.**

**One intended aws-prod render delta (functionally inert):** removing the redundant
overlay-level `namespace: collab` (so it stops clobbering the o11y group) means the
cert-manager **ClusterIssuer** `letsencrypt-prod` no longer renders a `namespace:
collab` line. A ClusterIssuer is CLUSTER-SCOPED — that namespace field is meaningless
metadata the API server ignores, so `kubectl apply -k` produces the identical
cluster object with or without it (a re-apply shows no server-side diff). This is the
ONLY collab-side render change (the collab app Deployment/Service/PVC/NetworkPolicy/
Certificate/etc. are byte-identical); the o11y resources and the US4/US6 collab
NetworkPolicy allowances are the intended additions. Flagged for review; no action
needed.

**Could NOT be verified in authoring (ops re-runs before apply):**
- `tofu plan`/`apply` against real AWS (by design — ops track holds creds).
- The embedded Collector `collector.yaml` was YAML-parsed (valid) but **not**
  validated by the actual `otelcol validate` binary (not installed) — a semantic
  Collector-config check the ops track should run (`otelcol-contrib validate
  --config`) before apply.
- No `kubectl`/server-side/dry-run validation and no `yamllint` — only client-side
  `kustomize build`.
- Image **digests are placeholders** (dev pod has no registry access) — resolve
  before apply (see below).
- OpenObserve `ZO_*` env-var names unverified against a running OpenObserve (below).

## Accepted limitations (ratified in the design doc / chosen path, 2026-07-16)

- **No SSO/RBAC on OpenObserve** — enterprise-gated in OSS. Acceptable for a single
  operator behind the security group (5080 reachable only from prod node SG +
  operator IP; root creds from SOPS). Revisit if teammates ever need the o11y UI.
- **Single monitoring node, not HA** — monitoring-node loss means a telemetry gap
  until rebuild, not a prod outage. The independent-path CloudWatch/Route 53
  alarms are the coverage during such a gap; prod is never impacted (Collector
  buffers then drops).
- **`t4g.small` is 2 GB against OpenObserve's ~4 GB guidance** — ratified as
  "try it first" with an early resize escape hatch. Ops action: watch node memory
  in week one of beta data; take the `t4g.medium` resize (instance-type variable)
  early if tight. The unit's memory limit (ledger RD-10) makes the failure mode a
  container restart, not a wedged node.
- **OpenObserve's trace/APM UI is less mature than SigNoz/ClickStack** — accepted
  to try; the OTLP-everywhere architecture keeps the backend swappable via a
  Collector-exporter + IaC change if it disappoints.

## Ops-track actions owed (post-merge; sequenced by the FR-029 docs)

- Generate the private CA + server cert and the OpenObserve root credentials;
  SOPS-encrypt and commit; then `tofu apply` the monitoring stack.
- Run the design's "Verification posture" end to end: kill a prod pod → prior
  logs queryable; `kubectl top` vs. node dashboard; trip each alarm synthetically
  (5xx burst, simulated `/ready` failure, forced cert-renewal check) → SNS email.
- Provision dashboards/alerts into OpenObserve via the documented import steps.
- Confirm the Route 53 health check's string-match token against the live
  `/ready` response body before enabling the alarm.
- Cost check after the first week of beta data against the ~$12–24 + S3 envelope;
  tune `o11y_retention_days` (the design's stated tuning knob) if S3 grows.
- CloudWatch `Requests` anomaly alarm needs a training window — expect it to be
  uninformative for the first days after apply; the 5xx threshold alarm and the
  health check carry coverage meanwhile.
- **Confirm the OpenObserve `ZO_*` env-var names/casing** against the pinned
  OpenObserve version's docs before apply (plan §research-2): versions rename config
  vars, and the committed `openobserve/openobserve.env` uses the names as of the
  pinned tag — a mismatch silently disables S3/TLS/retention. Authoring gate cannot
  run OpenObserve to verify.
- **Confirm the OpenObserve image registry** (public registry vs. ECR mirror) at
  image-pin time: if the arm64 image is pulled from ECR, add the read-only ECR
  attachment to the monitoring node role (mirroring the prod node); the plan assumes a
  public registry and omits it (plan §research-4).
- **Fill the monitoring node's private IP** into the server-cert SANs and the
  Collector exporter's `hostAliases` (collector-daemonset.yaml) AND the
  `allow-collector-to-monitoring-node` egress ipBlock (`k8s/o11y/networkpolicies.yaml`)
  at cert-generation time (RD-13) — the IP is stable once the instance exists
  (`tofu output monitoring_private_ip`) but is unknown at authoring time. Placeholders
  (`10.0.0.2`) are used in both places.
- **Materialize the datastore secrets into the `o11y` namespace** (FR-017, G3): the
  Collector's Postgres/Redis receivers read `postgres-secret`/`redis-auth` via
  `secretKeyRef`, which requires those secrets to exist IN `o11y`. They currently
  live only in `collab`. The ops track must `sops -d` the existing
  `k8s/secrets/{postgres-secret,redis-auth}.enc.yaml` and apply a copy with
  `namespace: o11y` (documented in ops-runbook.md). No new secret VALUES — the same
  credentials, a second namespace.
- **Fill the CA cert + server cert/key + OO root creds** into the scaffolds: paste the
  real PEM/creds into `k8s/o11y/ca-trust-configmap.yaml` (public CA cert),
  `k8s/secrets/o11y-tls.enc.yaml` + `k8s/secrets/openobserve-root.enc.yaml` (then
  `sops -e -i`), and SSM-place `server.crt`/`server.key`/`openobserve-root.env` on the
  node (ops-runbook.md). Authoring committed structure-only placeholders (SC-004).
- **Digest-pin the Collector + OpenObserve images**: resolve the real arm64 digests
  and replace the placeholder digest in `k8s/o11y/kustomization.yaml` (`images:`) and
  the tag in `var.otel_collector_image` / `var.openobserve_image` before first apply
  (runbook §3.2) — the dev pod has no registry access.

## Follow-ups (not blockers)

- **Dedicated read-only Postgres monitoring role** (ledger G3): the Collector's
  Postgres receiver initially reuses `postgres-secret`. Creating a least-privilege
  `pg_monitor` role is a database change owned by the app/db track; swap the
  receiver's credentials once it exists.
- **Private-CA expiry is outside the cert-expiry alerting** (ledger RD-12): the
  in-stack cert-expiry alert watches cert-manager metrics, not the o11y transport
  CA. Expiry dates are recorded in the ops docs with a documented re-issue path;
  consider adding a calendar/dead-man reminder at provisioning time.
- **`docs/operations.md` observability section** (FR-030): replaced at
  merge-queue time with the real architecture — not edited in the authoring
  worktree.
- **Narrow the Collector `hostfs` mount** (post-merge review, finding 6): the
  Collector DaemonSet mounts host `/` read-only at `/hostfs` for the hostmetrics
  `root_path` — which includes the Postgres data directory, so a Collector compromise
  could read DB files and exfiltrate over allowed egress. Accepted with documentation
  (standard hostmetrics pattern; mitigations: read-only mount,
  `readOnlyRootFilesystem`, dropped caps / no privilege escalation, default-deny
  egress). Promotion follow-up: narrow the mount to just the paths hostmetrics needs
  (`/proc`, `/sys`, mountpoints) instead of `/`. Residual-risk block is at the mount
  site in `k8s/o11y/collector-daemonset.yaml`.

## Post-merge review dispositions (2026-07-16)

Adversarial post-merge review of 013-o11y-platform; six findings, all dispositioned in
the main tree (server/ and 014 untouched). Verified with `tofu fmt/validate` +
`kustomize build` on both overlays (minikube still 0 o11y refs).

| # | Sev | Area | Disposition |
|---|-----|------|-------------|
| 1 | HIGH | `alarms.tf` R53 health-check target | **FIXED** — probe `squiredocs.com` (CloudFront viewer alias), not `app.squiredocs.com` (origin record, prefix-list-scoped 443 that blocks R53 checkers → false page forever). Comment + `outputs`/ledger corrected. **RATIFIED by Sam 2026-07-16.** |
| 2 | HIGH | `networkpolicies.yaml` egress | **FIXED** — added `allow-collector-to-node-kubelet-and-apiserver` egress (TCP 10250 + 6443 to the prod node IP placeholder); without it kubeletstats + k8s_events were silently dead on first apply. Ops fills the node-IP placeholder in the same step as the monitoring-node IP; §6 verification line added. **RATIFIED by Sam 2026-07-16** (node-IP egress placeholder approach). |
| 3 | MEDIUM | `monitoring.tf` internet path | **FIXED** — explicit `associate_public_ip_address = true` (egress only; ingress SG-locked); "private-IP only" comments in `monitoring.tf` + `outputs.tf` corrected. Recorded RD-15 RATIFIED-BY-DEFAULT (public-IP-with-locked-SG over NAT on cost, ~$32/mo vs $0). |
| 4 | MEDIUM | `o11y-dashboards/README.md` import | **FIXED** — dashboard import rewritten to list-then-create-or-update-by-id (blind POST duplicated); dropped the unconditional "re-running is safe" claim; route-confirmation hedge now covers BOTH dashboard and alert routes; runbook records confirmed routes post-verify. |
| 5 | LOW | `variables.tf` operator_cidr desc | **FIXED** — description now names the o11y UI/OTLP (5080/5081) ingress it also scopes. |
| 6 | LOW | `collector-daemonset.yaml` hostfs `/` mount | **ACCEPTED-DOCUMENTED** — residual-risk block at the mount site + follow-up above (narrow to proc/sys/mountpoints). |

Two HIGHs (1 and 2) apply chosen fixes RATIFIED by Sam 2026-07-16: the
`squiredocs.com` probe target, and the node-IP egress placeholder for kubelet/API.
