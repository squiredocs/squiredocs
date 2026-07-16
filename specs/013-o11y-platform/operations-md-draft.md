# MERGE-QUEUE DRAFT — docs/operations.md observability section (FR-030)

**Do NOT apply from the authoring worktree.** The merge queue places this into
`docs/operations.md` per the pipeline docs-convergence rule (T041). The current
`## Observability & account controls` heading (≈ line 397) covers only account-level
AUDIT controls (CloudTrail/GuardDuty/Config/IAM) — it says nothing about telemetry.
Recommended placement: **rename** that heading to `## Account controls & audit`
(its content is unchanged and correct) and **insert the section below** as a new
`## Observability & telemetry` immediately before it. Links target the in-feature
`specs/013-o11y-platform/ops-runbook.md`.

---

## Observability & telemetry

Squire's production observability is a dedicated monitoring node plus an in-cluster
collection agent, with independent-path alarms that survive failure of the o11y
stack itself. Design ground truth: `design/observability-and-telemetry.md`. Ops
execution: `specs/013-o11y-platform/ops-runbook.md`. Application instrumentation
(the OTel SDK, pino logging, app metrics) is feature 014; this section is the
platform (feature 013).

**Architecture (OTLP everywhere → swappable backend):**

- **Monitoring node** — a dedicated `t4g.small` arm64 EC2 box (`infra/terraform/
  monitoring*.tf`), separate from the 4 GB prod node so o11y load is isolated and the
  outage stays visible while it happens. Own security group, SSM-managed IAM role (no
  SSH), IMDSv2, single encrypted gp3 root. Runs **OpenObserve** (single Rust binary,
  OTLP-native) as one podman container under systemd, **S3-backed** (Parquet) — no
  data volume. Data lives in the `squiredocs-openobserve` bucket (SSE-KMS, all public
  access blocked, lifecycle expiry `var.o11y_retention_days`, default 30d).
- **OTel Collector** — a DaemonSet in a dedicated **privileged `o11y` namespace**
  (`k8s/o11y/`), isolating the one host-privileged workload so the `collab` namespace
  stays PSS-restricted. Seven receiver classes in: `filelog` (`/var/log/pods`,
  offset-checkpointed), `k8s_events`, `hostmetrics`, `kubeletstats`, `postgresql`,
  `redis`, `prometheus` (cert-manager cert-expiry). One OTLP/gRPC exporter out to the
  node on 5081 over TLS (private CA, `tls.ca_file`), with a bounded persistent queue
  so node-down is buffer-then-drop, never app backpressure. It also exposes a passive
  in-cluster OTLP intake (`otel-collector.o11y:4317/4318`) — the feature-014 seam.
- **Transport security** — a private CA (SOPS-held, cert-manager does NOT apply to the
  bare-EC2 node); the server cert is SSM-placed, the public CA cert is a plaintext
  ConfigMap the Collector trusts. Ingress to the node is 5080 (UI + OTLP-HTTP) / 5081
  (OTLP-gRPC) from the prod node SG + operator CIDR only — the UI is never public.
- **Independent-path alarms** (`infra/terraform/alarms.tf`) — CloudFront
  `5xxErrorRate` (≥5% for 5 consecutive minutes) + `Requests` anomaly (2σ) + a Route
  53 `/ready` HTTPS string-match health check, all → the existing
  `squiredocs-backup-alarms` SNS/email topic. These share NO dependency with the o11y
  stack, so they fire even when everything above is down.
- **Dashboards & in-stack alerts** (`k8s/o11y-dashboards/`) — committed OpenObserve
  JSON (golden signals + node/Postgres/Redis panels; six alert classes: app error
  rate, `/ready` failure, node saturation, Postgres/Redis health, cert expiry),
  imported idempotently per the directory README.

**Privacy invariant:** document content never enters telemetry — identifiers only
(GUIDs, user IDs, route templates), never document text, titles, search queries, or
chat content. The Collector/dashboard configs are content-free by construction.

**Accepted limitations (ratified):** OSS OpenObserve has no SSO/RBAC (single operator
behind the SG); the single monitoring node is not HA (a node loss is a telemetry gap,
not a prod outage — the independent-path alarms cover it); `t4g.small` (2 GB) may need
the pre-ratified early `t4g.medium` resize (`var.o11y_instance_type`); the exception-
email notifier stays as a redundant channel. Cost envelope ~$12–24/mo + S3.
