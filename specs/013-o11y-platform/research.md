# Phase 0 Research — 013-o11y-platform

All product-level open decisions were resolved at spec time and live in
`clarifications-needed.md` (G1–G3, RD-1..RD-12) — this file resolves the *technical
how* for each authored artifact by pinning it to an existing repo pattern or a known
OpenObserve/OTel/AWS mechanism. Format per item: **Decision / Rationale /
Alternatives considered**. No `NEEDS CLARIFICATION` markers remain in the plan.

## 1. Monitoring EC2 node (FR-001/002/009, RD-3/RD-5/RD-10)

- **Decision**: New `monitoring.tf` declaring `aws_instance.monitoring`, mirroring
  `compute.tf`: `data.aws_ami.al2023_arm64`, `instance_type = var.o11y_instance_type`
  (default `t4g.small`), `metadata_options { http_tokens = "required" ... hop_limit
  = 1 }`, one `root_block_device` (gp3, `var.o11y_root_volume_size` default 20,
  `encrypted = true`, `kms_key_id = aws_kms_key.squiredocs.arn`), **no** data volume,
  **no** EIP (private-IP only, in-VPC). `user_data = templatefile("monitoring-cloud-
  init.yaml.tftpl", { openobserve_image, s3_bucket, region, retention_days, ... })`.
  Reuse the same `lifecycle { ignore_changes = [user_data] }` note as `compute.tf`
  (cloud-init is first-boot only; live edits go via SSM and are back-ported).
- **Rationale**: The node's posture is a near-exact copy of the prod node minus the
  data volume and EIP; reusing the AMI data source, CMK, and IMDSv2 block keeps one
  reviewable posture. Addressing is private-IP (RD-5) since ingest never leaves the
  VPC.
- **Alternatives considered**: A separate Terraform *module* — rejected (Dependencies:
  "creates parallel structures for none of them"; the module is small and shares the
  CMK/VPC/SG data). Public EIP — rejected (no public ingest path; UI is operator-IP/
  SSM only).
- **RD-5 addressing sub-decision (recorded to ledger, RATIFIED-BY-DEFAULT)**: The
  design/ledger floats a *private Route 53 record* (`o11y.internal...`) as the cert
  SAN + exporter target. The existing `squiredocs.com` zone is **public** (edge.tf
  `data.aws_route53_zone.squiredocs`, `private_zone = false`) and there is no private
  hosted zone in the module. Creating one is extra managed infra for a single node.
  **Plan default**: the server cert carries the node's **private IP as an IP SAN**
  and a stable internal DNS name SAN (`o11y.squiredocs.internal`), and the Collector
  exporter targets that name via an `endpoints`/`hostAliases` mapping to the private
  IP — no managed private Route 53 zone required. Ops track fills the concrete
  private IP at cert-generation time (the IP is stable once the instance exists;
  documented in FR-029). If a private zone is later desired it is an additive change.
  → **RD-13 added to ledger.**

## 2. OpenObserve runtime: S3 backend, TLS, retention, memory bound (FR-005/006/007/008, RD-1/RD-9/RD-10)

- **Decision**: OpenObserve runs as a single container under a committed systemd unit
  (`openobserve/openobserve.service`) — `podman`/`docker run` of the pinned arm64
  image `var.openobserve_image` (tag + digest where practical), `Restart=on-failure`,
  `MemoryMax=1536M`, `MemoryHigh=1400M`. Config via `openobserve/openobserve.env`
  using OpenObserve `ZO_*` env vars: `ZO_LOCAL_MODE=true`, `ZO_LOCAL_MODE_STORAGE=s3`,
  `ZO_S3_BUCKET_NAME`, `ZO_S3_REGION`, `ZO_S3_SERVER_URL`, server-side encryption
  left to the bucket (SSE-KMS default); `ZO_DATA_RETENTION_DAYS` set to
  `var.o11y_retention_days` (≤ the S3 lifecycle, FR-008); TLS via
  `ZO_GRPC_TLS_ENABLED=true` + `ZO_HTTP_TLS_ENABLED` with cert/key paths pointing at
  the cloud-init-laid `/etc/openobserve/tls/{server.crt,server.key}`; root creds via
  `ZO_ROOT_USER_EMAIL` / `ZO_ROOT_USER_PASSWORD` sourced from the SOPS secret
  (rendered into an `EnvironmentFile` on the node by the ops track, never committed).
- **Rationale**: Env-var config is OpenObserve's native single-binary story; keeping
  the unit + env file as committed, reviewable files (not opaque inline user_data)
  satisfies FR-005. S3-only storage is the whole storage model (no ClickHouse/EBS
  data volume). The memory bound (RD-10) turns the 2 GB risk into a restart, not a
  wedge. Retention pinned ≤ lifecycle closes the aged-object query gap (Edge Case).
- **Alternatives considered**: `docker-compose` one-container — equivalent; systemd
  unit chosen to match the node's no-k8s, systemd-native footprint and give
  `Restart=`/`MemoryMax=` directly. Inline user_data heredoc — rejected (FR-005 wants
  files, not opaque inlining). Unpinned `latest` — rejected (RD-9; reproducibility).
- **Open ops-track item**: the exact `ZO_*` variable names/casing must be confirmed
  against the pinned OpenObserve version's docs before apply (versions rename vars);
  recorded in promotion-notes as a pre-apply confirmation, consistent with the
  authoring-only gate.

## 3. OpenObserve data bucket (FR-003, RD-1/RD-2)

- **Decision**: New `openobserve_bucket.tf` mirroring `backup_bucket.tf` minus Object
  Lock/versioning/Glacier: `aws_s3_bucket.openobserve` (`squiredocs-openobserve`),
  `aws_s3_bucket_server_side_encryption_configuration` (aws:kms, CMK,
  `bucket_key_enabled = true`), `aws_s3_bucket_public_access_block` (all four true),
  `aws_s3_bucket_lifecycle_configuration` with a single `expiration { days =
  var.o11y_retention_days }` rule (default 30). Versioning: **disabled** (telemetry is
  disposable, ephemeral, lifecycle-expired — versioning would fight the expiry and add
  cost).
- **Rationale**: SSE-KMS + block-public + a lifecycle-expire rule is the whole
  storage story (spec Key Entities); Object Lock/Glacier are backup-integrity
  features irrelevant to expendable telemetry. One CMK keeps the key policy reviewable
  (RD-2, mirrors 011 RD-3).
- **Alternatives considered**: Versioning enabled (as backups have) — rejected
  (noncurrent versions dodge the expiry lifecycle, growing cost for zero value on
  disposable data). A per-service KMS key — deferred (RD-2).

## 4. Node IAM: SSM role + bucket-scoped S3 policy (FR-002)

- **Decision**: New `monitoring_iam.tf`: `aws_iam_role.monitoring` (EC2 assume, reuse
  the `data.aws_iam_policy_document.ec2_assume` shape), attach
  `AmazonSSMManagedInstanceCore` (keyless management, no SSH), plus an inline policy
  scoped to **exactly** `${aws_s3_bucket.openobserve.arn}` + `/*` for the S3 actions
  OpenObserve needs (`s3:PutObject`, `GetObject`, `DeleteObject`, `ListBucket`) and
  `kms:GenerateDataKey`/`kms:Decrypt` on the CMK (SSE-KMS read+write needs Decrypt,
  unlike the write-only `backup_writer`). `aws_iam_instance_profile.monitoring`.
- **Rationale**: Mirrors the `backup_writer` least-privilege pattern (iam.tf §3) but
  the OO node both writes and reads its Parquet, so it needs `GetObject`/`ListBucket`
  + `kms:Decrypt` where the backup writer needed only `PutObject` + `Encrypt`. No ECR
  attachment (the OO image comes from a public registry, not ECR — confirm at pin
  time; if ECR is used, add the read-only attachment like the prod node).
- **Alternatives considered**: Reusing the prod node role — rejected (least-privilege;
  separate blast radius). A managed `AmazonS3FullAccess` — rejected (SC-003 requires
  the role resolve to exactly one bucket).

## 5. Monitoring security group (FR-004, SC-003)

- **Decision**: New `monitoring_sg.tf`: `aws_security_group.monitoring` with exactly
  two ingress rules **per port**, using `aws_vpc_security_group_ingress_rule` (the
  module's style): 5080 and 5081 each admitted from (a) the prod node SG via
  `referenced_security_group_id = aws_security_group.node.id` and (b)
  `cidr_ipv4 = var.operator_cidr`. One egress-all rule (image pulls, S3, SSM). No
  other ingress; no world-open rule (SC-003: 0 world-open). Also add — in
  `network.tf` or here — a prod-node **egress** allowance to the monitoring SG on
  5080/5081 (Edge Case "prod node SG egress"): the prod SG currently egresses all
  (`all_out`), so this is already permitted; record that no new prod-egress rule is
  needed unless the prod egress is later tightened.
- **Rationale**: SG-to-SG references are the correct in-VPC scoping (survives IP
  churn) and match the design's "only from the prod node's SG + operator IP". Four
  ingress rules total (2 ports × 2 sources), all scoped.
- **Alternatives considered**: A single rule with a port range 5080–5081 — acceptable
  but two explicit port rules read clearer in review and match how the module writes
  discrete-port rules (22, 6443). CIDR of the prod node instead of SG reference —
  rejected (SG reference is churn-proof).

## 6. Independent-path alarms (FR-010/011/012/013, RD-6/RD-7/RD-8)

- **Decision**: New `alarms.tf`, all publishing to the **existing**
  `aws_sns_topic.backup_alarms` (RD-8, no new topic):
  - **5xx threshold** — `aws_cloudwatch_metric_alarm` on `AWS/CloudFront`
    `5xxErrorRate`, `statistic = "Average"`, `period = 300`, `threshold = 5`,
    `comparison_operator = "GreaterThanOrEqualToThreshold"`, `evaluation_periods = 1`,
    `treat_missing_data = "notBreaching"` (missing = no traffic; the health check owns
    "site unreachable" — Edge Case), dimensions `DistributionId =
    aws_cloudfront_distribution.app.id`, `Region = "Global"`.
  - **Requests anomaly** — anomaly detection via `metric_query` blocks: one `metric`
    query for `AWS/CloudFront Requests` and one `ANOMALY_DETECTION_BAND(m1, 2)`
    expression query; alarm `comparison_operator =
    "GreaterThanUpperOrLowerThreshold"`, `threshold_metric_id` = the band query id.
    Documented cold-start caveat (Edge Case) in promotion-notes.
  - **Route 53 health check** — `aws_route53_health_check` (`type = "HTTPS_STR_MATCH"`,
    `resource_path = "/ready"`, `fqdn = "app.squiredocs.com"`, `port = 443`,
    `search_string = <token>`, `request_interval = 30`, `failure_threshold = 3`) +
    `aws_cloudwatch_metric_alarm` on `AWS/Route53` `HealthCheckStatus`, `statistic =
    "Minimum"`, `comparison_operator = "LessThanThreshold"`, `threshold = 1`,
    `treat_missing_data = "breaching"` (fail closed). **Route 53 health-check metrics
    live in us-east-1** — the module's provider is already us-east-1, so no extra
    provider alias is needed.
  - All three: `alarm_actions` + `ok_actions = [aws_sns_topic.backup_alarms.arn]`.
    Numeric thresholds exposed as variables (RD-6).
- **Rationale**: One-to-one with the design's three paths on the existing SNS/email
  path; each reads a CloudFront/Route53-native metric with **zero** reference to the
  monitoring node/OpenObserve/Collector (SC-005, FR-013). The `search_string` token
  is confirmed against the live `/ready` body at plan time (RD-7) — see item 11.
- **Alternatives considered**: CloudWatch Synthetics canary — explicitly forbidden
  (FR-012, cost). A second SNS topic — rejected (RD-8, churns the subscription).
  `evaluation_periods = 5` on the 5xx alarm — the ledger RD-6 says "≥5% for 5
  consecutive minutes"; with a 300s period that is 1 period of a 5-min average OR 5
  periods of a 60s average. **Chosen**: `period = 60`, `evaluation_periods = 5`,
  `datapoints_to_alarm = 5` to match the ledger's "5 consecutive minutes" literally.
  → sub-decision recorded in data-model.md.

## 7. OTel Collector DaemonSet + `o11y` namespace (FR-014/015/016/019/021/023, G1)

- **Decision**: New `k8s/o11y/` group added to the **aws-prod** overlay only. A
  `namespace.yaml` for `o11y` with PSS labels `enforce=privileged` (G1). A
  `collector-daemonset.yaml` (image `otel/opentelemetry-collector-contrib` pinned by
  digest) with `hostPath` mounts for `/var/log/pods` (+ `/var/lib/docker/containers`
  if needed) read-only, host `hostNetwork`/`hostPID` only as required by hostmetrics,
  `securityContext` matching the privileged needs, and modest
  `resources.requests/limits` (e.g. 128Mi/256Mi request, 512Mi limit — FR-023, shares
  the 4 GB node). A `collector-config.yaml` ConfigMap holds the pipeline. RBAC
  (`ServiceAccount` + `ClusterRole`/`ClusterRoleBinding`) grants the `k8s_events` and
  `kubeletstats` receivers the API access they need (`events`, `nodes/stats`,
  `pods`).
- **Rationale**: DaemonSet + hostPath is the canonical node-agent log/metric
  collection shape; isolating it in a privileged `o11y` namespace keeps `collab` at
  `restricted` (G1). Contrib image because filelog/k8s_events/hostmetrics/kubeletstats
  /postgresql/redis/prometheus receivers are all contrib components.
- **Alternatives considered**: Deployment (not DaemonSet) — rejected (filelog/
  hostmetrics are per-node; the cluster is single-node today but DaemonSet is the
  correct, churn-proof shape). Running in `collab` with relaxed PSS — rejected (G1;
  erodes 011 hardening for every workload).

## 8. Collector pipeline: receivers, checkpointing, exporter (FR-015..019)

- **Decision** (all in `collector-config.yaml`):
  - **logs**: `filelog` (`include: [/var/log/pods/*/*/*.log]`, `storage:
    file_storage` extension for **persistent offset checkpointing** — FR-015 — backed
    by a hostPath dir so offsets survive restart) + `k8s_events`. Pipeline
    `logs → [batch, k8s_attributes?] → otlp`.
  - **metrics**: `hostmetrics` (cpu/memory/disk/filesystem/network scrapers),
    `kubeletstats` (node/pod/container), `postgresql` (endpoint = collab
    postgres Service, `username`/`password` from the mounted `postgres-secret`),
    `redis` (endpoint = collab redis Service, `password` from `redis-auth`),
    `prometheus` (a scrape_config targeting cert-manager's metrics Service for
    `certmanager_certificate_expiration_timestamp_seconds`). Pipeline `metrics →
    [batch] → otlp`.
  - **exporter**: single `otlp` exporter → `${monitoring node name}:5081`, gRPC,
    `tls: { ca_file: /etc/otel/ca/ca.crt }` (RD-4), `retry_on_failure: { enabled:
    true }`, `sending_queue: { enabled: true, storage: file_storage }` with bounded
    size so node-down = buffer-then-drop, never app backpressure (FR-019, Edge Case).
  - **privacy note** (FR-028): a header comment block stating the FR-027 invariant —
    no content-bearing processors; no `attributes`/`transform` processor adds document
    text, titles, queries, or chat content; identifiers only.
- **Rationale**: Standard contrib receiver wiring; file_storage-backed offsets and
  sending queue are the documented OTel mechanisms for FR-015 durability and FR-019
  best-effort delivery. Credentials come only from the two existing SOPS secrets
  (FR-017, G3) mounted as env/files — no plaintext, no new secret.
- **Alternatives considered**: `loki`/vendor exporters — rejected (OTLP-everywhere
  keeps the backend swappable). In-memory-only queue — rejected (loses buffered
  telemetry on Collector restart; file_storage persists it).

## 9. In-cluster OTLP intake for 014 (FR-022, G2)

- **Decision**: `collector-service.yaml` — a stable named `Service`
  (`otel-collector.o11y.svc.cluster.local`) exposing `4317` (gRPC) and `4318`
  (HTTP) backed by an `otlp` receiver in the Collector (plaintext in-cluster). The
  documented 014 target (contract): `OTEL_EXPORTER_OTLP_ENDPOINT =
  http://otel-collector.o11y.svc.cluster.local:4318` (gRPC 4317 available). Functions
  fully with zero app telemetry (passive intake).
- **Rationale**: Standard OTLP ports + standard env var = zero-surprise contract any
  OTel SDK expects (G2). Plaintext in-cluster matches app→PG/Redis posture; TLS
  begins at the Collector→node hop.
- **Alternatives considered**: TLS in-cluster — rejected (G2; unnecessary inside the
  default-deny cluster, adds cert plumbing for 014). A headless Service — rejected
  (a normal ClusterIP Service is the stable name 014 dials).

## 10. NetworkPolicy allowances (FR-020, US6)

- **Decision**: Two locations. In `k8s/o11y/networkpolicies.yaml`: default-deny in
  `o11y` + Collector **egress** to (collab) Postgres 5432, Redis 6379, cert-manager
  metrics port, DNS, and the monitoring node's private IP on 5081; **ingress** to the
  Collector's 4317/4318 from the `collab` namespace (app). In the existing
  `k8s/overlays/aws-prod/networkpolicies.yaml` (collab side): **ingress** allowances
  on `collab-postgres`/`collab-redis` from the `o11y` namespace, and an **egress**
  allowance on `collab-app` to the `o11y` Collector 4317/4318 (the app→Collector path
  for 014). Everything else stays default-deny (FR-021 unchanged).
- **Rationale**: Cross-namespace flows need both a source egress and a destination
  ingress rule under default-deny on both sides; enumerating exactly the five paths
  (spec FR-020) preserves the posture. Adding the collab-side rules to the existing
  file keeps the collab default-deny picture in one reviewable place.
- **Alternatives considered**: `namespaceSelector` matching the `o11y` namespace label
  vs. pod-level selectors — use `namespaceSelector` on
  `kubernetes.io/metadata.name: o11y` (mirrors the existing kube-system selector
  pattern in the file). Opening broad egress from the Collector — rejected (default-
  deny preservation is the whole point).

## 11. Route 53 health-check match string against live `/ready` (RD-7)

- **Decision**: The `search_string` is a **stable token from the live `/ready`
  response body**. `server/ready.js` is the contract owner (feature 010). At authoring
  time the exact body is not fetchable from the pod (no prod access), so the plan
  **parameterizes** it as `var.ready_health_check_search_string` with a documented
  default derived from the `/ready` contract, and records an **ops-track pre-enable
  confirmation** (promotion-notes) to verify the token against the live body before
  the alarm is trusted (spec Independent Test / FR-029). Fails closed if the body
  changes (Edge Case).
- **Rationale**: The token must match the *actual* shipped body; parameterizing +
  an ops confirmation is the authoring-only-safe way to honor RD-7 without prod
  access. (A task will grep `server/ready.js` for the healthy-response literal to seed
  the default.)
- **Alternatives considered**: Hardcoding a guessed token — rejected (a wrong token
  fails closed = false page storm). Probing the origin directly — rejected (RD-7: the
  synthetic enters where users enter, through CloudFront).

## 12. Dashboards & in-stack alerts as code (FR-024/025/026, RD-11)

- **Decision**: `k8s/o11y-dashboards/` holds OpenObserve-importable **dashboard JSON**
  (golden signals rate/errors/duration/saturation + node/PG/Redis panels) and **alert
  JSON** for the six classes (app error rate, `/ready` failure, node CPU/mem/disk,
  Postgres health, Redis health, cert expiry from
  `certmanager_certificate_expiration_timestamp_seconds` with an actionable lead
  time). A `README.md` documents the **idempotent** import: `curl` against the
  OpenObserve dashboards/alerts API with the SOPS root creds (a documented,
  re-runnable `POST`/`PUT` per artifact), plus any UI-only steps as numbered manual
  steps (FR-026). All definitions key on identifiers only — privacy grep-clean
  (SC-007, FR-027).
- **Rationale**: OpenObserve has no mature IaC provider (RD-11); committed JSON +
  documented idempotent API import is the strongest reproducibility available and
  keeps the files reviewable for the privacy grep.
- **Alternatives considered**: Inventing a Terraform provider/wrapper — rejected
  (RD-11, out of scope). UI-click-only with screenshots — rejected (not reproducible;
  fails FR-026).

## 13. SOPS secret scaffolding (FR-006/007, RD-12, SC-004)

- **Decision**: Two new files under `k8s/secrets/` (existing `.sops.yaml` rule
  matches `k8s/secrets/*.enc.yaml`, `encrypted_regex` on data/stringData): (a)
  `openobserve-root.enc.yaml` — `ZO_ROOT_USER_EMAIL`/`ZO_ROOT_USER_PASSWORD`; (b)
  `o11y-tls.enc.yaml` — private CA key, server key, server cert (the CA *cert* is
  committed plaintext as a ConfigMap `k8s/o11y/ca-trust-configmap.yaml`). This feature
  commits **scaffold** files (structure + key names, **placeholder/empty encrypted
  values or a `.example`**), because generating the real CA/creds and `sops -e`
  encrypting them is an **ops-track** action (spec: "secret generation … executed by
  the ops track"). Zero plaintext secret values enter git (SC-004).
- **Rationale**: RD-12 keeps one encryption posture (the existing k8s/secrets rule)
  rather than adding an `infra/secrets` rule. The node needs the server cert/key +
  root creds, but those are ops-generated; the authoring worktree can only ship the
  shape + the documented generation commands (FR-029). The monitoring node is bare
  EC2, so cloud-init consumes the cert/creds the ops track places (via SSM/rendered
  EnvironmentFile), not the k8s Secret — the k8s Secret form is for review-visible
  shape + the CA-trust ConfigMap the *Collector* mounts. → clarify node-vs-cluster
  secret delivery in contracts/secrets.md.
- **Alternatives considered**: Committing real encrypted secrets now — impossible
  (agent has no age private key / cannot generate the CA per overrides & scope). A new
  `infra/secrets` SOPS rule — deferred (RD-12 allows it but one rule is simpler).

## Toolchain / verification (Verification Gate + 011 fallback ladder)

- **Decision**: In the authoring pod, `tofu` and `kustomize` are present
  (`/usr/local/bin`); `terraform`, `kubectl`, `yamllint` are **absent**. Gate ⇒ run
  `tofu fmt -check` + `tofu validate` in `infra/terraform/`, and `kustomize build` on
  both overlays with the SC-002 render assertions. For anything needing the absent
  tools, fall back to structured manual review and **record the degradation** in
  promotion-notes so the ops track re-runs real validators before apply.
- **Rationale**: Matches the spec's Verification Gate + the inherited 011 fallback
  ladder verbatim; end-to-end signal-path proof (SC-008) is ops-track acceptance, not
  the authoring gate.
- **Alternatives considered**: Skipping validation because some tools are missing —
  rejected (the two present tools cover the bulk; degradation is recorded, not
  silent).
