# Implementation Plan: Observability Platform — Monitoring Node, Collector & Alarms

**Branch**: `013-o11y-platform` | **Date**: 2026-07-16 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `/specs/013-o11y-platform/spec.md`

## Summary

Author — in code only, applying nothing to AWS — the infrastructure half of the
observability design (`design/observability-and-telemetry.md` @ 100a692): a
dedicated locked-down OpenObserve monitoring node (`infra/terraform/`), an OTel
Collector DaemonSet in a new `o11y` namespace on the prod cluster (`k8s/`),
independent-path CloudFront/Route 53 alarms in the same IaC pass, and committed
dashboard/alert definitions with a documented idempotent import. The approach is
strictly additive and mirror-existing-patterns: every new Terraform file follows
the `compute.tf`/`iam.tf`/`network.tf`/`backup_bucket.tf` posture already in the
module; every new Kustomize resource lands only in the `aws-prod` overlay (minikube
stays byte-identical). Feature 014 (app instrumentation) is decoupled behind one
seam: a passive in-cluster OTLP intake Service. The `docs/operations.md` rewrite
(FR-030) is planned but flagged **merge-queue**, not executed in this worktree.

## Technical Context

**Language/Version**: OpenTofu (HCL, AWS provider ~> 5, matches existing module) /
Kustomize (kustomize.config.k8s.io/v1beta1) / cloud-init YAML + systemd unit /
OpenObserve config (env vars) / SOPS-age encrypted YAML / OpenObserve
dashboard+alert JSON. No application language surface — this feature adds no
`server/`, `client/`, or `shared/` code and no database migration.

**Primary Dependencies**: Existing `infra/terraform/` root module (CMK
`alias/squiredocs`, SNS `squiredocs-backup-alarms` + `var.alarm_email`, VPC/subnet
vars, `data.aws_route53_zone.squiredocs`, imported CloudFront distribution
`aws_cloudfront_distribution.app`); the `k8s/` base+overlays tree; the `.sops.yaml`
`k8s/secrets/*.enc.yaml` creation rule and `age-operator` recipient; OpenObserve
(pinned arm64 image); OTel Collector contrib image (pinned); cert-manager's
Prometheus metrics endpoint (already on the prod cluster); the existing
`postgres-secret` / `redis-auth` SOPS secrets; the live `/ready` endpoint
(feature 010).

**Storage**: Dedicated S3 bucket `squiredocs-openobserve` (SSE-KMS with the shared
CMK, all public access blocked, lifecycle expiry `var.o11y_retention_days` default
30). OpenObserve internal retention pinned ≤ that value. No EBS data volume — a
single 20 GiB encrypted gp3 root only.

**Testing**: Verification Gate (NOT `npm test`): `tofu fmt -check` + `tofu validate`
in `infra/terraform/`; `kustomize build` on **each** overlay with the SC-002 render
assertions; structured config review + privacy grep (SC-007). Toolchain confirmed
present in the authoring pod: `tofu` and `kustomize` (`/usr/local/bin`). Absent:
`terraform`, `kubectl`, `yamllint` — inherit feature 011's fallback ladder for those
(manual HCL/YAML review, recorded in promotion-notes).

**Target Platform**: AWS us-east-1 (existing account/VPC from feature 011);
`t4g.small` arm64 monitoring EC2 node running a single OpenObserve container under
systemd; prod single-node k3s cluster (4 GB / 20 GB) hosting the Collector DaemonSet.

**Project Type**: Infrastructure-as-code + cluster configuration authoring (no
application project structure).

**Performance Goals**: Telemetry delivery is best-effort and MUST NOT backpressure
the app (bounded queue/retry on the Collector exporter). Monitoring node fits the
~$12–24/mo + S3 cost envelope. OpenObserve constrained to ~1.5 GiB via a systemd
memory bound so OOM is a container restart, not a wedged node.

**Constraints**: Nothing applied to real AWS (authoring only; ops track applies).
Minikube overlay behaviorally unchanged. Privacy invariant (FR-027/028): no
content-bearing telemetry fields anywhere in authored config. `collab` namespace
stays PSS `restricted` + default-deny untouched. No new plaintext secret values in
git. No branch switch, no commit (pipeline orchestrator owns those).

**Scale/Scope**: Single monitoring node (non-HA, ratified). Seven Collector receiver
classes → one OTLP/TLS exporter. Three independent-path alarms. Six in-stack alert
classes + golden-signal/node/PG/Redis dashboards. ~2 new secret files (CA + server
cert, OO root creds) under the existing SOPS rule.

## Constitution Check

*GATE: evaluated against `.specify/memory/constitution.md` v1.1.1. Re-checked after
Phase 1 design — still PASS.*

- **I. Documentation Reflects Reality** — PASS with a planned obligation. This
  feature does not touch `README.md`/`docs/dev.md` (no app behavior/dev-workflow
  change). `docs/operations.md`'s observability section IS stale relative to the new
  architecture; FR-030 captures the rewrite, executed at **merge-queue** time per the
  pipeline docs-convergence rule (flagged task, not done in the worktree). No drift is
  left unrecorded.
- **II. Test-Backed Changes** — PASS (adapted). No behavioral app code changes, so
  the app suites stay untouched and green; the feature's "tests" are the Verification
  Gate (tofu/kustomize/structured review). Constitution's Jest/round-trip rules do
  not apply to an IaC-only change.
- **III. Trunk-Based Solo Workflow** — PASS. Multi-feature design-driven work → runs
  under `/the-pipeline` (worktree here, serial merge queue later). No new ceremony
  invented; branch/commit owned by the orchestrator (overrides forbid me switching).
- **IV. Collaboration-Safe Document Operations** — N/A. No document-mutating code, no
  Yjs/registry/format surface touched.
- **V. Secure by Default for Agent & User Content** — PASS and central to the design.
  New ingestion surface = the Collector's OTLP intake + the monitoring node's OTLP
  ports; trust boundary stated in spec (in-VPC only, SG-scoped, TLS via private CA,
  SOPS creds, default-deny NetworkPolicy with enumerated allowances). Privacy
  invariant FR-027/028 keeps document content out of the weaker-access third store by
  construction. No secret values committed in plaintext (SC-004).
- **VI. Design Docs Are Ground Truth** — PASS. `design/observability-and-telemetry.md`
  @ 100a692 is normative and drives every FR; the "Application instrumentation"
  section is explicitly deferred to 014. All open decisions are RATIFIED-BY-DEFAULT
  in `clarifications-needed.md` (G1–G3, RD-1..RD-12); nothing decided silently. No
  design mechanism is falsified here, so no design-doc amendment is owed.

**Result**: no violations. Complexity Tracking table below is empty.

## Project Structure

### Documentation (this feature)

```text
specs/013-o11y-platform/
├── spec.md                  # complete (input)
├── clarifications-needed.md # G1-G3 + RD-1..RD-12 ledger (input; extended by plan)
├── promotion-notes.md       # ops-track / accepted-limitations ledger (input; extended)
├── plan.md                  # this file
├── research.md              # Phase 0 — resource/pattern research + decisions
├── data-model.md            # Phase 1 — resource & entity inventory (IaC "data model")
├── quickstart.md            # Phase 1 — the Verification Gate as a runnable guide
├── contracts/               # Phase 1 — the cross-boundary contracts
│   ├── otlp-intake.md       #   014 seam: Service name/ports/env-var target
│   ├── collector-exporter.md#   Collector→monitoring-node OTLP/TLS + CA trust
│   ├── alarms-sns.md        #   3 alarms → existing SNS topic (independent path)
│   └── secrets.md           #   SOPS secret shapes (CA, server cert, OO root creds)
├── checklists/
│   └── requirements.md      # spec quality checklist (input)
└── tasks.md                 # Phase 2 — /speckit-tasks output (NOT this command)
```

### Source Code (repository root) — files this feature authors

```text
infra/terraform/                         # extend the existing root module (no new module)
├── monitoring.tf         # NEW — aws_instance.monitoring (t4g.small arm64), private-IP
│                         #       node, IMDSv2, 20GiB gp3 CMK root, no data vol
├── monitoring_sg.tf      # NEW — dedicated SG: 5080/5081 from prod-node SG + operator CIDR only
├── monitoring_iam.tf     # NEW — SSM-managed instance role + S3 policy scoped to the OO bucket
├── openobserve_bucket.tf # NEW — squiredocs-openobserve S3 (SSE-KMS, block-public, lifecycle)
├── alarms.tf             # NEW — CloudFront 5xx + Requests anomaly + Route53 health check
│                         #       → existing aws_sns_topic.backup_alarms
├── monitoring-cloud-init.yaml.tftpl  # NEW — lays down OO unit + config + server cert; starts OO
├── openobserve/          # NEW — committed, reviewable node runtime config (templated into user_data)
│   ├── openobserve.service           #   systemd unit: single container, MemoryMax~1.5G, Restart
│   └── openobserve.env               #   OO config: S3 backend, retention, TLS paths, ZO_* vars
├── variables.tf          # EXTEND — o11y_* vars (instance type, root size, retention, image ref)
├── outputs.tf            # EXTEND — monitoring node private addr / OO bucket (for ops docs)
└── (reuse) kms.tf, iam.tf data sources, backup_bucket.tf SNS, edge.tf CloudFront, network.tf SG

k8s/
├── o11y/                                # NEW resource group for the Collector (aws-prod-only)
│   ├── kustomization.yaml               #   groups the Collector resources
│   ├── namespace.yaml                   #   o11y namespace (PSS privileged labels)
│   ├── collector-daemonset.yaml         #   OTel Collector contrib, hostPath /var/log/pods, host metrics
│   ├── collector-config.yaml            #   ConfigMap: 7 receivers, pipelines, OTLP/TLS exporter, privacy note
│   ├── collector-rbac.yaml              #   ServiceAccount + ClusterRole (k8s_events, kubeletstats)
│   ├── collector-service.yaml           #   in-cluster OTLP intake 4317/4318 (014 seam)
│   ├── networkpolicies.yaml             #   o11y-namespace policies (Collector egress; app→Collector ingress)
│   └── ca-trust-configmap.yaml          #   public CA cert (plaintext) for the exporter tls.ca_file
├── secrets/                             # EXTEND — new SOPS-encrypted secret(s)
│   ├── openobserve-root.enc.yaml        #   NEW — OO root creds (scaffold; ops fills+encrypts)
│   └── o11y-tls.enc.yaml                #   NEW — private CA key + server key/cert (scaffold)
├── o11y-dashboards/                     # NEW — committed OpenObserve config-as-code (RD-11)
│   ├── dashboards/*.json                #   golden signals + node/PG/Redis panels
│   ├── alerts/*.json                    #   6 in-stack alert classes
│   └── README.md                        #   idempotent import steps (ops-track)
├── overlays/aws-prod/
│   ├── kustomization.yaml               # EXTEND — add ../../o11y + collab NetworkPolicy allowances
│   └── networkpolicies.yaml             # EXTEND — collab-side allowances: Collector→PG/Redis, app→Collector
└── overlays/minikube/                   # UNCHANGED (asserted byte-identical, SC-002)

# docs/operations.md — FR-030 observability-section rewrite: MERGE-QUEUE task, NOT edited here.
```

**Structure Decision**: No new Terraform module and no new Kustomize base tree
beyond the single-purpose `k8s/o11y/` group — the feature extends the existing
`infra/terraform/` root module and the existing `k8s/overlays/aws-prod` overlay so
it inherits the CMK, SNS topic, VPC/SG data, SOPS rule, and CloudFront/Route53 data
sources rather than duplicating them (per Dependencies "creates parallel structures
for none of them"). The Collector's privileged host access is isolated in its own
`o11y` namespace (G1); collab-side NetworkPolicy allowances are added to the existing
`aws-prod/networkpolicies.yaml` so the default-deny posture there stays visible in one
place. New secrets ride the existing `k8s/secrets/*.enc.yaml` SOPS creation rule
(RD-12 chose this over an `infra/secrets` rule to keep one encryption posture).

## Complexity Tracking

> No Constitution Check violations — table intentionally empty.

| Violation | Why Needed | Simpler Alternative Rejected Because |
|-----------|------------|-------------------------------------|
| —         | —          | —                                    |
