# Data Model — 013-o11y-platform (resource & entity inventory)

This is an IaC/config feature: the "data model" is the inventory of declared
resources, config artifacts, and the variables/attributes that parameterize them,
plus the invariants review must assert. Grouped by the spec's Key Entities. Every
row traces to an FR and (where relevant) a ledger decision.

## Entity A — Monitoring node (`aws_instance.monitoring`)

| Attribute | Value / source | FR / RD |
|---|---|---|
| AMI | `data.aws_ami.al2023_arm64` (reused) | FR-001 |
| instance_type | `var.o11y_instance_type` default `t4g.small` | FR-001, RD-cited, US1-6 |
| metadata_options | `http_tokens=required`, hop_limit 1 | FR-001 |
| root_block_device | gp3, `var.o11y_root_volume_size` default 20 GiB, `encrypted=true`, CMK | FR-001, RD-3 |
| data volume | **none** | FR-001 |
| address | private IP only (no EIP), in-VPC | FR-009, RD-5/RD-13 |
| iam_instance_profile | `aws_iam_instance_profile.monitoring` | FR-002 |
| vpc_security_group_ids | `[aws_security_group.monitoring.id]` | FR-004 |
| user_data | `templatefile(monitoring-cloud-init.yaml.tftpl, {...})` | FR-005 |
| lifecycle | `ignore_changes = [user_data]` (first-boot-only note) | Edge Case "cloud-init runs once" |

**Invariants**: arm64; IMDSv2 required; exactly one encrypted gp3 root; no data
volume; no SSH key; not publicly addressed.

## Entity B — OpenObserve data bucket (`aws_s3_bucket.openobserve`)

| Resource | Config | FR / RD |
|---|---|---|
| `aws_s3_bucket.openobserve` | name `squiredocs-openobserve` | FR-003, RD-2 |
| `aws_s3_bucket_server_side_encryption_configuration` | `aws:kms`, CMK arn, `bucket_key_enabled` | FR-003, RD-2 |
| `aws_s3_bucket_public_access_block` | all four `true` | FR-003, SC-003 |
| `aws_s3_bucket_lifecycle_configuration` | one rule `expiration.days = var.o11y_retention_days` (30) | FR-003, RD-1 |
| versioning | disabled (disposable telemetry) | research §3 |

**Invariants**: SSE-KMS on the shared CMK; 0 public access; single lifecycle expiry
in the 15–30d band; OpenObserve `ZO_DATA_RETENTION_DAYS` ≤ this value (FR-008).

## Entity C — Node IAM (`monitoring_iam.tf`)

| Resource | Scope | FR / RD |
|---|---|---|
| `aws_iam_role.monitoring` | EC2 assume | FR-002 |
| attach `AmazonSSMManagedInstanceCore` | keyless mgmt (no SSH) | FR-002 |
| inline S3 policy | `s3:{Put,Get,Delete}Object`,`ListBucket` on `openobserve` bucket **only** | FR-002, SC-003 |
| inline KMS policy | `kms:GenerateDataKey`,`kms:Decrypt` on the CMK | FR-002 |
| `aws_iam_instance_profile.monitoring` | binds role to instance | FR-002 |

**Invariants** (SC-003): the role's S3 access resolves to exactly one bucket; no
wildcard-bucket or managed-full-access policy.

## Entity D — Monitoring security group (`monitoring_sg.tf`)

| Rule | Port | Source | FR |
|---|---|---|---|
| ingress | 5080 | `aws_security_group.node.id` (prod SG ref) | FR-004 |
| ingress | 5080 | `var.operator_cidr` | FR-004 |
| ingress | 5081 | `aws_security_group.node.id` | FR-004 |
| ingress | 5081 | `var.operator_cidr` | FR-004 |
| egress | all | 0.0.0.0/0 (image/S3/SSM) | — |
| (prod egress→node) | 5080/5081 | already covered by prod `all_out` egress | Edge Case "prod node SG egress" |

**Invariants** (SC-003): 100% of ingress scoped to prod SG or operator CIDR; **0
world-open ingress rules**; UI never publicly reachable.

## Entity E — Independent-path alarms (`alarms.tf`)

| Resource | Metric / config | FR / RD |
|---|---|---|
| `aws_cloudwatch_metric_alarm.cf_5xx` | `AWS/CloudFront 5xxErrorRate` Avg, `period=60`,`eval=5`,`datapoints=5`,`>=5`,`treat_missing=notBreaching` | FR-010, RD-6 |
| `aws_cloudwatch_metric_alarm.cf_requests_anomaly` | `Requests` + `ANOMALY_DETECTION_BAND(m1,2)` via `metric_query`, `GreaterThanUpperOrLowerThreshold` | FR-011, RD-6 |
| `aws_route53_health_check.ready` | `HTTPS_STR_MATCH`, fqdn `app.squiredocs.com`, path `/ready`, `search_string=var.ready_health_check_search_string`, interval 30, failure_threshold 3 | FR-012, RD-7 |
| `aws_cloudwatch_metric_alarm.ready_health` | `AWS/Route53 HealthCheckStatus` Min `<1`, `treat_missing=breaching` | FR-012, RD-6 |
| SNS action (all) | `aws_sns_topic.backup_alarms.arn` (existing) | FR-010..012, RD-8 |

**Sub-decision (RD-6 literalization)**: 5xx alarm uses `period=60` /
`evaluation_periods=5` / `datapoints_to_alarm=5` to realize "≥5% for 5 consecutive
minutes" exactly (rather than one 5-min-average period). Thresholds are variables.

**Invariants** (SC-005, FR-013): all three declared with SNS actions on the existing
topic; **0 references** from any alarm to the monitoring node, OpenObserve, or the
Collector (shared-nothing).

## Entity F — Private CA + transport (secrets + cloud-init + ConfigMap)

| Artifact | Content | Committed as | FR / RD |
|---|---|---|---|
| CA cert (public) | trust anchor | plaintext ConfigMap `k8s/o11y/ca-trust-configmap.yaml` | FR-007 |
| CA key (private) | signing key | SOPS `k8s/secrets/o11y-tls.enc.yaml` (scaffold) | FR-007, SC-004 |
| server key/cert | node TLS, SANs = internal name + private IP | SOPS scaffold; laid via cloud-init | FR-007, FR-009, RD-5 |
| OO root creds | `ZO_ROOT_USER_EMAIL/PASSWORD` | SOPS `k8s/secrets/openobserve-root.enc.yaml` (scaffold) | FR-006, SC-004 |

**Invariants** (SC-004): 0 plaintext secret values in git; each `*.enc.yaml` carries
SOPS metadata (or ships as documented `.example` scaffold the ops track encrypts);
CA validity ~10y, server cert ~2–3y with expiry recorded in ops docs (RD-12);
cert-manager NOT in this path (FR-007).

## Entity G — OTel Collector (`k8s/o11y/`)

| Resource | Role | FR / RD |
|---|---|---|
| `namespace.yaml` (`o11y`) | PSS `enforce=privileged` | FR-021, G1 |
| `collector-daemonset.yaml` | contrib image (digest-pinned), hostPath `/var/log/pods` ro, host metrics, modest resources | FR-014/016/023 |
| `collector-config.yaml` (ConfigMap) | 7 receivers, 2 pipelines, OTLP/TLS exporter, privacy header | FR-015..019/028 |
| `collector-rbac.yaml` | SA + ClusterRole (events, nodes/stats, pods) | FR-015/016 |
| `collector-service.yaml` | OTLP intake 4317/4318 (014 seam) | FR-022, G2 |
| `ca-trust-configmap.yaml` | CA cert for exporter `tls.ca_file` | FR-019 |
| `networkpolicies.yaml` (o11y) | default-deny + scoped egress/ingress | FR-020 |

**Receiver set (7 classes, FR-015..018)**: `filelog` (offset checkpoint via
file_storage), `k8s_events`, `hostmetrics`, `kubeletstats`, `postgresql` (creds from
`postgres-secret`), `redis` (creds from `redis-auth`), `prometheus` (cert-manager
scrape). **Exporter**: single `otlp` → node:5081 gRPC, `tls.ca_file`, retry +
bounded persistent `sending_queue` (FR-019).

**Invariants**: aws-prod render contains the Collector with all 7 receivers + a TLS
OTLP exporter (SC-002); minikube render contains 0 Collector/monitoring references
and is byte-identical (SC-002); credentials only from the 2 existing SOPS secrets
(FR-017); privacy header present, 0 content-bearing fields (SC-007, FR-027/028).

## Entity H — NetworkPolicy allowances (FR-020)

| Path | Direction / rule location | FR |
|---|---|---|
| Collector → Postgres 5432 | o11y egress + collab-postgres ingress-from-o11y | FR-020 |
| Collector → Redis 6379 | o11y egress + collab-redis ingress-from-o11y | FR-020 |
| Collector → cert-manager metrics | o11y egress (+ cert-manager ns ingress if enforced there) | FR-020 |
| app → Collector OTLP 4317/4318 | collab-app egress + o11y Collector ingress-from-collab | FR-020, US6 |
| Collector → monitoring node 5081 | o11y egress to node private IP | FR-020 |

**Invariants**: exactly these five paths added; default-deny preserved everywhere
else; `collab` `restricted` PSS + its existing policies untouched (FR-021).

## Entity I — Dashboards & in-stack alerts (`k8s/o11y-dashboards/`)

| Family | Count | FR / RD |
|---|---|---|
| dashboards | golden signals (rate/errors/duration/saturation) + node + Postgres + Redis | FR-024 |
| in-stack alerts | 6 classes: app error rate, `/ready` failure, node CPU/mem/disk, Postgres health, Redis health, cert expiry | FR-025 |
| import doc | idempotent API import + numbered manual steps | FR-026, RD-11 |

**Invariants** (SC-006/SC-007): each of the 6 alert classes + each dashboard family
maps to a committed JSON or an explicit documented step (0 unaccounted); 0
content-bearing fields anywhere.

## Variables added to `infra/terraform/variables.tf`

| Variable | Type | Default | Purpose |
|---|---|---|---|
| `o11y_instance_type` | string | `t4g.small` | monitoring node size; resize escape hatch (US1-6) |
| `o11y_root_volume_size` | number | 20 | node root gp3 GiB (RD-3) |
| `o11y_retention_days` | number | 30 | S3 lifecycle expiry + OO retention (RD-1, FR-008) |
| `openobserve_image` | string | pinned arm64 ref | OO image (tag+digest) (RD-9) |
| `otel_collector_image` | string | pinned digest | Collector image (RD-9; also referenced in k8s pin) |
| `cf_5xx_threshold` | number | 5 | 5xx alarm % (RD-6) |
| `cf_5xx_eval_minutes` | number | 5 | consecutive minutes (RD-6) |
| `requests_anomaly_stddev` | number | 2 | anomaly band width (RD-6) |
| `ready_health_check_search_string` | string | (seed from `/ready` body; ops-confirmed) | RD-7 |

`operator_cidr`, `alarm_email`, `vpc_id`, `subnet_id`, CMK, SNS — **reused**, not
redeclared.

## State transitions (alarms — the only stateful surface here)

- **5xx / Route53 health**: `OK → ALARM` on breach → SNS email; `ALARM → OK` →
  SNS OK notification. Health check fails **closed** (missing data breaching).
- **Requests anomaly**: `INSUFFICIENT_DATA` during the training window (cold start,
  Edge Case) → `OK` once trained → `ALARM` on 2σ excursion. Documented as expected.
