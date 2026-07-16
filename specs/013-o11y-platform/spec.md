# Feature Specification: Observability Platform — Monitoring Node, Collector & Alarms

**Feature Branch**: `013-o11y-platform`

**Created**: 2026-07-16

**Status**: Draft

**Input**: User description: "Observability platform (infra track) — feature 013-o11y-platform: dedicated OpenObserve monitoring node, OTel Collector DaemonSet on the prod cluster, independent-path CloudWatch/Route 53 alarms, dashboards and in-stack alerts, per design/observability-and-telemetry.md"

**Design ground truth**: `design/observability-and-telemetry.md` (commit 100a692) — the whole document except "Application instrumentation" (owned by feature 014). Where this spec and the design doc disagree, the design doc wins. The chosen-path plan (Sam, 2026-07-16) is normative for deployment specifics.

## Scope Boundary *(read first)*

This feature is the **infrastructure half** of the observability design, and it is **authoring only**:

- It produces OpenTofu declarations (`infra/terraform/`), Kubernetes configuration (`k8s/`), monitoring-node runtime config (cloud-init, systemd/compose unit, OpenObserve config), SOPS-encrypted secret scaffolding, and dashboard/alert definitions as code. It adds **no** application/server code and **no** database migrations.
- It **applies nothing to real AWS**: every `tofu apply`, secret generation (private CA, root credentials), image pull, and end-to-end signal-path verification is executed by the ops track (the orchestrator/Sam). The design doc's "Verification posture" (kill-a-pod log durability, `kubectl top` cross-check, synthetic alarm trips) is the ops track's post-apply acceptance, sequenced by this feature's documentation.
- **Feature 014 (app instrumentation)** owns everything inside the application process: the OTel SDK, pino structured logging, manual spans, and app metrics. The interface between the features is a single contract: **the app exports OTLP to the cluster-local Collector via the standard `OTEL_EXPORTER_OTLP_ENDPOINT` environment variable; the Collector and everything behind it (monitoring node, OpenObserve, S3, alarms, dashboards) is this feature.** This spec MUST NOT specify app/server changes.
- The Minikube development environment must remain behaviorally unchanged (no Collector, no monitoring dependencies in the minikube overlay).
- The `docs/operations.md` observability-section replacement (FR-030) is captured here as a requirement but executed at merge-queue time per the pipeline's docs-convergence rule — the authoring worktree does not edit shared ops docs.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Monitoring platform provisioned as code (Priority: P1)

As the operator, I can read `infra/terraform/` and the committed monitoring-node runtime config and see the complete, locked-down monitoring platform — a dedicated node running OpenObserve, its S3 data store, its network exposure, and its transport security — as reviewable code, so that the platform is reproducible and every access path is auditable before anything touches AWS.

**Why this priority**: Every other story ships telemetry *to* this platform; without it there is nowhere durable for any signal to land. It also carries the entire security posture (ingress lockdown, TLS, least-privilege storage) that makes running a third data store acceptable.

**Independent Test**: `tofu validate`/`tofu fmt -check` pass (subject to the Verification Gate fallback); a reviewer can trace every bullet of the design doc's "Backend: OpenObserve on a dedicated monitoring node" section to a declared resource, a committed config file, or a documented ops-track step.

**Acceptance Scenarios**:

1. **Given** the repo at this feature's completion, **When** the operator inspects `infra/terraform/`, **Then** it declares a `t4g.small` (arm64) monitoring EC2 node with: its own dedicated security group, its own SSM-managed IAM instance role (no SSH key, no port 22), IMDSv2 required, and a single small encrypted gp3 root volume (no data volume — data lives in S3).
2. **Given** the node declaration, **When** the operator inspects its user data, **Then** cloud-init lays down and starts OpenObserve as a single container (systemd unit or one-container compose) using an arm64 image, with the OpenObserve configuration and unit file committed to the repo — not inlined opaquely — and root-user credentials seeded from a SOPS-managed secret, never hardcoded.
3. **Given** the storage declarations, **When** reviewed, **Then** a dedicated S3 bucket for OpenObserve data exists with SSE-KMS encryption, all public access blocked, and a lifecycle rule expiring objects within the design's 15–30 day retention band; the monitoring node's IAM role carries an S3 policy scoped to that bucket alone (mirroring the `backup_writer` least-privilege pattern in `iam.tf`).
4. **Given** the monitoring security group, **When** reviewed, **Then** OTLP HTTP 5080 (which also serves the UI) and OTLP gRPC 5081 admit traffic **only** from the prod node's security group and the operator CIDR; no other ingress exists; the UI is reachable only via operator IP or SSM port-forward — never publicly.
5. **Given** the transport-security artifacts, **When** reviewed, **Then** a private CA and server certificate flow is fully specified: keys/certs generated once by the ops track (documented commands), private material stored SOPS-encrypted in the repo, the server certificate laid onto the node via cloud-init, and the CA certificate available to the prod Collector for `tls.ca_file` trust. cert-manager is explicitly not used for this node.
6. **Given** the node sizing, **When** the operator reads the configuration, **Then** instance type is a variable defaulting to `t4g.small` so the documented early-resize-to-`t4g.medium` escape hatch is a one-variable plan, not a rewrite.

---

### User Story 2 - Durable centralized logs that survive pod and node churn (Priority: P1)

As the operator, when a production pod crashes or restarts, I can still query its prior logs — container stdout and Kubernetes events — in the monitoring UI, so that the current top operational gap (logs dying with the pod) is closed.

**Why this priority**: The design's gap ranking puts durable centralized logs first: today the only failure signal is a best-effort exception email and logs vanish on churn. This is the highest-value signal path.

**Independent Test**: The aws-prod overlay renders a Collector DaemonSet whose pipeline reads `/var/log/pods` container logs plus Kubernetes events and exports OTLP over TLS to the monitoring node; the ops-track verification kills a pod and finds its prior logs queryable.

**Acceptance Scenarios**:

1. **Given** the k8s configuration, **When** the operator renders the aws-prod overlay, **Then** an OTel Collector DaemonSet is declared in the Kustomize tree with a `filelog` receiver over `/var/log/pods` (capturing all container logs, including the app's stdout) and a `k8s_events` receiver, exporting OTLP to the monitoring node with the private CA configured as the exporter's trust root.
2. **Given** the Collector's log pipeline, **When** the Collector restarts, **Then** file-offset checkpointing prevents wholesale re-ingestion or loss of logs across restarts.
3. **Given** the minikube overlay, **When** rendered, **Then** it contains no Collector and no monitoring-node references — dev behavior is unchanged.
4. **Given** the monitoring node is unreachable, **When** the Collector cannot export, **Then** it retries with bounded buffering and the prod workloads are unaffected (telemetry delivery is best-effort; it never backpressures the app).

---

### User Story 3 - Independent-path alarms that fire even when the o11y stack is down (Priority: P2)

As the operator, I receive an email when the site serves errors or stops responding — via AWS-native paths that do not depend on the monitoring node, the Collector, or the cluster — so that a total platform outage (including of the o11y stack itself) still produces a signal.

**Why this priority**: The design mandates these ride the same IaC pass, not a later phase; they are the only alerting that survives failure of everything this feature builds.

**Independent Test**: Terraform review shows the three alarm paths declared against the existing SNS/email topic; the ops track trips each synthetically (a forced 5xx burst, a simulated `/ready` failure) and receives email.

**Acceptance Scenarios**:

1. **Given** `infra/terraform/`, **When** reviewed, **Then** a CloudFront `5xxErrorRate` threshold alarm and a CloudFront `Requests` anomaly-detection alarm are declared on the existing distribution, publishing to the existing SNS/email path used by the backup-freshness alarm.
2. **Given** the external synthetic, **When** reviewed, **Then** it is a **Route 53 health check** performing HTTPS requests against the public `/ready` endpoint with response string matching — explicitly not a CloudWatch Synthetics canary — feeding a CloudWatch alarm on the same SNS/email path.
3. **Given** the `/ready` endpoint degrades (non-200 or missing match string), **When** the health check observes consecutive failures, **Then** the alarm transitions and the operator is emailed; recovery sends an OK notification.
4. **Given** all three alarms, **When** the monitoring node or the Collector is completely down, **Then** none of them are affected — they share no dependency with the o11y stack.

---

### User Story 4 - Infra, datastore, and certificate metrics collected (Priority: P2)

As the operator, I can see prod-node CPU/memory/disk saturation, Kubernetes pod/container resource usage, Postgres and Redis health, and TLS certificate expiry in the monitoring backend, so that saturation on the 4 GB / 20 GB prod box and datastore trouble are visible before they become outages.

**Why this priority**: Second in the design's gap ranking, after logs. Depends on the Collector (US2) existing.

**Independent Test**: The rendered Collector configuration contains the `hostmetrics`, `kubeletstats`/cAdvisor, Postgres, Redis, and `prometheus` (cert-manager scrape) receivers wired into a metrics pipeline exporting to the monitoring node; ops-track verification matches `kubectl top` against the node dashboard.

**Acceptance Scenarios**:

1. **Given** the Collector configuration, **When** reviewed, **Then** `hostmetrics` (node CPU/memory/disk/filesystem) and `kubeletstats`/cAdvisor (pod/container) receivers feed the metrics pipeline.
2. **Given** the Collector configuration, **When** reviewed, **Then** Postgres and Redis receivers collect datastore metrics (connections/locks and memory/evictions respectively), with credentials sourced from the existing SOPS-encrypted secrets — no plaintext credentials in the Collector config.
3. **Given** the Collector configuration, **When** reviewed, **Then** a `prometheus` receiver scrapes cert-manager's metrics endpoint so `certmanager_certificate_expiration_timestamp_seconds` reaches the backend — the sole source for certificate-expiry alerting.
4. **Given** the prod namespace's default-deny NetworkPolicy posture, **When** the Collector needs to reach Postgres, Redis, and cert-manager, **Then** scoped NetworkPolicy allowances exist for exactly those paths — the default-deny stance is preserved for everything else.

---

### User Story 5 - Dashboards and in-stack alerts (Priority: P3)

As the operator, I open the monitoring UI and see golden-signal dashboards (rate, errors, duration, saturation) plus node, Postgres, and Redis panels, and I am alerted from within the stack on app error rate, `/ready` failure, node saturation, datastore health, and certificate expiry.

**Why this priority**: Dashboards and in-stack alerts are only meaningful once the signals from US2/US4 flow; they are the consumption layer.

**Independent Test**: Dashboard and alert definitions exist as committed code where OpenObserve supports it (with a documented import/provisioning step for the ops track); each design-listed alert maps to a definition.

**Acceptance Scenarios**:

1. **Given** the repo, **When** the operator inspects the o11y config area, **Then** dashboard definitions covering the app's golden signals and node/Postgres/Redis panels are committed as code, with a documented ops-track step to load them into OpenObserve.
2. **Given** the alert definitions, **When** reviewed, **Then** each of the design's in-stack alerts exists: app error rate, `/ready` failure, node CPU/memory/disk saturation, Postgres health, Redis health, and certificate expiry (driven by the cert-manager metric with an actionable lead time).
3. **Given** OpenObserve features that cannot be expressed as committed config, **When** the operator follows the documentation, **Then** the manual configuration steps are explicit and reproducible (documented, not tribal knowledge).

---

### User Story 6 - Ready to receive app telemetry from feature 014 (Priority: P3)

As the app (instrumented by feature 014), I can export OTLP traces, metrics, and logs to a stable cluster-local Collector endpoint configured via the standard `OTEL_EXPORTER_OTLP_ENDPOINT` environment variable, so that app instrumentation lands in the same backend with zero knowledge of the monitoring node.

**Why this priority**: The interface must exist for 014 to verify against, but 014 ships its own value independently; nothing in this feature blocks on 014.

**Independent Test**: The rendered aws-prod overlay exposes an in-cluster OTLP receiving endpoint (standard OTLP ports) on the Collector, reachable from app pods under the NetworkPolicy posture; the endpoint contract (service name/port) is documented for 014.

**Acceptance Scenarios**:

1. **Given** the rendered Collector, **When** an app pod sends OTLP to the documented cluster-local endpoint, **Then** the Collector accepts it on the standard OTLP ports and forwards it to the monitoring node — no app-side knowledge of OpenObserve, its address, or its TLS trust is required.
2. **Given** the default-deny NetworkPolicy posture, **When** the app pod egresses to the Collector endpoint, **Then** a scoped allowance permits exactly that path.
3. **Given** feature 014 has not merged yet, **When** this feature's config is applied, **Then** everything works without app telemetry — the app endpoint is a passive interface, not a dependency.

### Edge Cases

- **Monitoring node memory pressure**: `t4g.small` is 2 GB and OpenObserve's own guidance leans 4 GB. The instance type is a variable (US1 scenario 6); the container/unit carries a memory bound so OpenObserve degrades (restarts) rather than wedging the node; the ops track watches memory in week one and takes the pre-ratified `t4g.medium` resize early if tight.
- **Monitoring node down or OpenObserve crashed**: prod is unaffected (Collector buffers and retries, then drops — telemetry is best-effort); the independent-path alarms (US3) still cover site-down detection. Single-node non-HA is a ratified accepted limitation. The systemd unit restarts OpenObserve on failure.
- **S3 lifecycle vs. OpenObserve's own retention**: if S3 expires Parquet objects the backend still indexes, queries return errors for aged ranges. OpenObserve's internal retention must be aligned to (≤) the S3 lifecycle expiry in the committed config.
- **Collector vs. Pod Security Standards**: the Collector needs hostPath access (`/var/log/pods`) and host metrics — incompatible with the `restricted` PSS profile enforced on the `collab` namespace. The Collector runs in its own namespace with an appropriate PSS level; the `collab` namespace's `restricted` enforcement is untouched (ledger G1).
- **NetworkPolicy lockout**: the `collab` namespace default-denies ingress; without explicit allowances the Collector's Postgres/Redis receivers are silently blocked (metrics gap, not an error the app feels). The allowances are enumerated in FR-020 and asserted in review.
- **Anomaly alarm cold start**: CloudWatch anomaly detection needs a training window; the `Requests` anomaly alarm may be noisy or silent in the first days after apply. Documented as expected; the threshold-based 5xx alarm and health check provide coverage meanwhile.
- **Low-traffic false alarms**: CloudFront rate metrics with sparse data can flap; alarms treat missing data as not-breaching where that is the safe reading (missing `5xxErrorRate` data means no requests, not an outage — the health check owns "site unreachable").
- **Health-check string match drift**: the Route 53 health check matches a string in the `/ready` response; if the response body format changes (an app-track change), the check fails closed (alarm fires — safe direction). The matched string is chosen from the stable, already-shipped `/ready` contract.
- **Cloud-init runs once**: the monitoring node's config (OpenObserve version, config file, certs) is laid down at first boot. Config changes therefore require node replacement (immutable-style) or a documented ops-track update path; the runbook-style docs state which.
- **Certificate expiry of the private CA/server cert itself**: a long-validity private CA (years) avoids the design's cert-expiry alerting having a blind spot for its own transport; expiry dates are recorded in the ops documentation, and the in-stack cert-expiry alert covers the prod-side (cert-manager) certificates.
- **Prod node SG egress**: the prod node must be able to egress to the monitoring node on 5080/5081; if the prod SG constrains egress, the rule is declared, not assumed.
- **UI and ingest share port 5080**: anyone who can reach OTLP-HTTP can reach the login page. Accepted: reachability is limited to the prod node SG + operator CIDR, and authentication (root creds from SOPS) gates the UI. No SSO/RBAC exists in OSS OpenObserve (ratified accepted limitation).

## Requirements *(mandatory)*

### Functional Requirements

**Monitoring node & platform (OpenTofu, `infra/terraform/`)**

- **FR-001**: The module MUST declare a dedicated monitoring EC2 node: arm64 Graviton, instance type variable defaulting to `t4g.small`, IMDSv2 required, a single encrypted gp3 root volume (size variable, small), and no data volume.
- **FR-002**: The node MUST have its own IAM instance role, SSM-managed (no SSH access path: no key pair, no port 22 ingress), mirroring the prod node's posture, plus an S3 policy scoped exclusively to the OpenObserve data bucket (least-privilege, `backup_writer`-style).
- **FR-003**: The module MUST declare a dedicated S3 bucket for OpenObserve data with SSE-KMS encryption, all public access blocked, versioning as appropriate, and a lifecycle rule expiring data within 15–30 days (default 30, variable-controlled; ledger RD-1).
- **FR-004**: The module MUST declare a dedicated monitoring security group admitting ONLY: TCP 5080 (OTLP HTTP + UI) and TCP 5081 (OTLP gRPC) from the prod node's security group and from the operator CIDR. No public UI exposure; UI access is operator IP or SSM port-forward.
- **FR-005**: OpenObserve MUST be brought up by cloud-init as a single container (systemd unit or one-container compose) from an arm64 image pinned to a specific version; the unit file and OpenObserve configuration MUST be committed to the repo (templated into user data, reviewable as files).
- **FR-006**: OpenObserve root-user credentials MUST be seeded from a SOPS-encrypted secret (generated by the ops track); no credential value may appear in plaintext in version control.
- **FR-007**: Transport security MUST use a private CA: CA + server certificate generated once by the ops track via documented commands, private material stored SOPS-encrypted, the server cert/key laid down via cloud-init, TLS enabled on the ingest ports, and the CA certificate (public) provided to the prod Collector as its `tls.ca_file` trust root. cert-manager MUST NOT be part of this path.
- **FR-008**: The OpenObserve internal retention configuration MUST be ≤ the S3 lifecycle expiry so queries never target expired objects.
- **FR-009**: The monitoring node MUST have a stable address (private-IP-based; ledger RD-5) that the server certificate's SANs cover and the Collector exporter targets; traffic between prod and monitoring stays within the VPC.

**Independent-path alarms (OpenTofu, same IaC pass)**

- **FR-010**: The module MUST declare a CloudFront `5xxErrorRate` threshold alarm on the existing distribution, publishing to the existing SNS topic/email path (the one carrying the backup-freshness alarm).
- **FR-011**: The module MUST declare a CloudFront `Requests` anomaly-detection alarm on the same distribution and SNS path.
- **FR-012**: The module MUST declare a Route 53 health check performing HTTPS requests against the public `/ready` endpoint with response string matching, and a CloudWatch alarm on that health check's status feeding the same SNS path. A CloudWatch Synthetics canary MUST NOT be used.
- **FR-013**: All three alarm paths MUST be fully independent of the monitoring node, OpenObserve, and the Collector — no shared failure domain with the o11y stack.

**OTel Collector (Kustomize, `k8s/`)**

- **FR-014**: An OTel Collector DaemonSet MUST be added to the Kustomize tree so that the aws-prod overlay renders it; the minikube overlay MUST NOT include it (dev behaviorally unchanged).
- **FR-015**: The Collector's logs pipeline MUST include a `filelog` receiver over `/var/log/pods` (all container logs) with persistent file-offset checkpointing, and a `k8s_events` receiver.
- **FR-016**: The Collector's metrics pipeline MUST include `hostmetrics` and `kubeletstats`/cAdvisor receivers (node and pod/container resource metrics).
- **FR-017**: The Collector MUST include Postgres and Redis receivers with credentials mounted from the existing SOPS-encrypted secrets (`postgres-secret`, `redis-auth`); no new plaintext credentials (ledger G3).
- **FR-018**: The Collector MUST include a `prometheus` receiver scraping cert-manager's metrics endpoint, delivering `certmanager_certificate_expiration_timestamp_seconds` to the backend.
- **FR-019**: The Collector MUST export all pipelines via OTLP over TLS to the monitoring node, trusting the private CA via `tls.ca_file`, with retry and bounded queue/buffer semantics such that monitoring-node unavailability never impacts prod workloads.
- **FR-020**: NetworkPolicy allowances MUST be added, scoped to exactly: Collector→Postgres (5432), Collector→Redis (6379), Collector→cert-manager metrics, app→Collector OTLP (for feature 014), and Collector→monitoring-node egress — preserving the default-deny posture for everything else.
- **FR-021**: The Collector MUST run in its own namespace with a PSS level compatible with its host access needs; the `collab` namespace's `restricted` enforcement MUST remain unchanged (ledger G1).
- **FR-022**: The Collector MUST expose an in-cluster OTLP receiving endpoint on the standard OTLP ports as a stable named Service, documented as the `OTEL_EXPORTER_OTLP_ENDPOINT` target for feature 014. The Collector MUST function fully before/without any app telemetry.
- **FR-023**: The Collector's resource requests/limits MUST be declared and modest — it shares the 4 GB prod node with the workload it observes.

**Dashboards & in-stack alerts (OpenObserve)**

- **FR-024**: Dashboard definitions MUST be committed as code where OpenObserve supports it: golden signals for the app (rate, errors, duration, saturation) and node, Postgres, and Redis panels, with a documented ops-track import/provisioning step.
- **FR-025**: In-stack alert definitions MUST exist for: app error rate, `/ready` failure, node CPU/memory/disk saturation, Postgres health, Redis health, and certificate expiry (from the cert-manager metric, with actionable lead time).
- **FR-026**: Any OpenObserve configuration that cannot be expressed as committed code MUST be captured as explicit, reproducible documented steps for the ops track.

**Privacy invariant**

- **FR-027**: No configuration authored by this feature may introduce document content into telemetry: Collector processors/pipelines MUST NOT add content-bearing attributes; dashboards and alerts MUST key on identifiers (document GUIDs, user IDs, route templates), never document text, titles, search queries, or chat content. (App-side emission discipline is feature 014's obligation; this feature's configs must be content-free by construction.)
- **FR-028**: The privacy invariant MUST be stated in the committed Collector/OpenObserve config (as review-visible comments/documentation) so future config edits inherit the constraint.

**Ops documentation**

- **FR-029**: The feature MUST document the ops-track execution: secret generation (CA, server cert, root creds), apply ordering, the post-apply signal-path verifications from the design's "Verification posture", the monitoring-node config-update path, and the week-one memory watch with the `t4g.medium` resize trigger.
- **FR-030**: The observability section of `docs/operations.md` MUST be replaced with the real architecture (monitoring node, Collector, alarm paths, dashboards, accepted limitations). Execution of this edit happens at merge-queue time, not in the authoring worktree.

### Key Entities

- **Monitoring node**: dedicated arm64 EC2 instance (own SG, SSM-only role, IMDSv2, encrypted root) running OpenObserve as a single supervised container; survives prod-node failure by construction.
- **OpenObserve data bucket**: dedicated S3 bucket (SSE-KMS, lifecycle-expired) — the platform's entire storage story; third store for telemetry with weaker access semantics than the database, which is why the privacy invariant exists.
- **Private CA**: SOPS-held trust anchor for the prod→monitoring OTLP path; explicitly outside cert-manager.
- **OTel Collector DaemonSet**: the single collection point on the prod cluster — seven receiver classes in (filelog, k8s_events, hostmetrics, kubeletstats, postgres, redis, prometheus/cert-manager), one OTLP/TLS exporter out; also the passive OTLP intake for feature 014.
- **Independent-path alarms**: CloudFront 5xx threshold + Requests anomaly + Route 53 `/ready` health check → existing SNS/email topic; zero dependency on the o11y stack.
- **Dashboards & in-stack alerts**: committed OpenObserve definitions (golden signals, node/PG/Redis panels; six alert classes).

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: `tofu fmt -check` reports 0 files needing formatting and `tofu validate` passes (or the documented fallback ladder is satisfied) with all new monitoring/alarm resources declared.
- **SC-002**: `kustomize build k8s/overlays/aws-prod` succeeds and renders the Collector with all 7 receiver classes and a TLS OTLP exporter; `kustomize build k8s/overlays/minikube` succeeds and contains 0 Collector/monitoring references and is byte-identical to its pre-feature render.
- **SC-003**: 100% of the monitoring node's ingress rules are scoped to the prod node SG or operator CIDR (0 world-open rules); the node role's S3 access resolves to exactly one bucket.
- **SC-004**: 0 plaintext secret values (credentials, private keys) are added to version control; every new secret file under `k8s/secrets/` carries SOPS encryption metadata.
- **SC-005**: All 3 independent-path alarms are declared with SNS actions on the existing topic, and a dependency review finds 0 references from any of them to the monitoring node, OpenObserve, or the Collector.
- **SC-006**: Each of the design's 6 in-stack alert classes and each dashboard family (golden signals + node/PG/Redis) maps to a committed definition or an explicit documented step — 0 unaccounted items.
- **SC-007**: A grep/review of all authored configs finds 0 content-bearing telemetry fields (document text, titles, search queries, chat content) referenced anywhere.
- **SC-008**: Post-apply (ops track): a killed prod pod's prior logs remain queryable; `kubectl top` matches the node dashboard; each alarm trips synthetically and delivers email; OpenObserve writes Parquet to the dedicated bucket; OTLP ports are unreachable from outside the allowed sources; monthly cost lands in the ~$12–24 + S3 envelope.

## Verification Gate *(this feature's definition of "tests pass")*

Verification is **NOT `npm test`** — no application code changes; the app suites must simply remain untouched and green. The feature's verification is:

1. `kustomize build` (or `kubectl kustomize`) on **each** overlay — must succeed, plus the SC-002 render assertions (Collector present in aws-prod with all receivers; minikube unchanged).
2. `tofu validate` and `tofu fmt -check` in `infra/terraform/`.
3. Structured review of the OpenObserve/Collector config files against FR-005–FR-009, FR-015–FR-023, and the privacy grep (SC-007).

**Toolchain fallback (explicit, inherited from feature 011)**: if `tofu`/`kustomize`/`kubectl` are unavailable in the authoring environment, fall back to `terraform` equivalents, then `kubectl kustomize`, then structured manual review (HCL syntax/reference review against the FRs; YAML cross-reference review — every resource listed exists, every patch target resolves), recording the degradation so the ops track re-runs real validators before any apply.

End-to-end signal-path proof (SC-008) is ops-track acceptance after apply, sequenced by the FR-029 documentation — it is not part of the authoring gate.

## Assumptions

- **AWS context**: account/region/VPC as established by feature 011 (`infra/terraform/` root module, us-east-1); the existing CloudFront distribution, `squiredocs.com` zone, SNS topic `squiredocs-backup-alarms` (email subscription via `var.alarm_email`), and KMS CMK (`alias/squiredocs`) are reused, not duplicated.
- **Prod cluster reality**: single-node k3s (4 GB / 20 GB), Kustomize base+overlays in `k8s/`, SOPS/age secrets under `k8s/secrets/*.enc.yaml` per `.sops.yaml`, `collab` namespace under PSS `restricted` with default-deny NetworkPolicies, cert-manager present with the standard Prometheus metrics endpoint, `/ready` endpoint live (feature 010).
- **Accepted limitations (ratified in the design doc / chosen path, recorded in promotion-notes.md)**: OSS OpenObserve has no SSO/RBAC; the single monitoring node is not HA; `t4g.small` (2 GB) may need the early `t4g.medium` resize.
- **The ops track exists**: Sam/the orchestrator holds AWS credentials and the age private key, generates the CA/creds, runs every apply, and executes the SC-008 verifications. Nothing in this feature's implementation touches live AWS.
- **Feature 014 interface**: the app will export OTLP to the Collector's in-cluster Service via `OTEL_EXPORTER_OTLP_ENDPOINT`; this feature ships that intake passively and takes no dependency on 014's timeline (ledger G2).
- **Backend swappability is preserved**: everything app- and cluster-side speaks OTLP; replacing OpenObserve later is a Collector-exporter + IaC change, never a re-instrumentation.
- All defaulted decisions are recorded as RATIFIED-BY-DEFAULT in `specs/013-o11y-platform/clarifications-needed.md` per Constitution Principle VI; flagged gaps (G1–G3) are documented there and do not block.

## Dependencies & Cross-Feature Handoffs

- **To feature 014 (app instrumentation)**: this feature provides the cluster-local OTLP endpoint (named Service, standard ports) and the app→Collector NetworkPolicy allowance; 014 configures the app's exporter against it. Neither feature blocks the other; the Collector is fully functional on infra signals alone.
- **From feature 011 (IaC baseline)**: this feature extends the existing `infra/terraform/` root module, Kustomize tree, SOPS setup, SNS/email path, and KMS key — it creates parallel structures for none of them.
- **From feature 010**: the Route 53 health check and the in-stack `/ready` alert consume the already-shipped `/ready` endpoint contract.
- **On the design doc**: `design/observability-and-telemetry.md` @ 100a692 is normative; the "Application instrumentation" section is explicitly 014's scope.
