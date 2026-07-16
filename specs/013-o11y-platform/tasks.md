---
description: "Task list for 013-o11y-platform (infra/config authoring only)"
---

# Tasks: Observability Platform — Monitoring Node, Collector & Alarms

**Input**: Design documents from `/specs/013-o11y-platform/`

**Prerequisites**: plan.md, spec.md, research.md, data-model.md, contracts/, quickstart.md

**Tests**: This is an infrastructure/config **authoring-only** feature with no
application code and no unit-test surface. Per the spec's Verification Gate, "tests"
= `tofu fmt/validate` + `kustomize build` per overlay + structured config review +
privacy/secrets greps (Phase 10). No `npm test`, no TDD test tasks.

**Scope guardrails** (from the orchestrator overrides — apply to every task):
nothing is applied to real AWS; stay on `main`, no branch/commit; never edit
`CLAUDE.md`/`README.md`/`docs/dev.md`; never touch `specs/014-*`; the minikube
overlay stays byte-identical; the `docs/operations.md` rewrite (FR-030) is
**merge-queue**, not done here (T041).

## Format: `[ID] [P?] [Story] Description`

- **[P]**: parallelizable (different file, no dependency on an incomplete task)
- **[Story]**: US1–US6 for user-story phases; Setup/Foundational/Polish carry no label

---

## Phase 1: Setup (shared)

- [x] T001 Extend `infra/terraform/variables.tf` with the o11y variables per data-model.md (`o11y_instance_type` default `t4g.small`, `o11y_root_volume_size` default 20, `o11y_retention_days` default 30, `openobserve_image`, `otel_collector_image`, `cf_5xx_threshold` default 5, `cf_5xx_eval_minutes` default 5, `requests_anomaly_stddev` default 2, `ready_health_check_search_string`); reuse (do NOT redeclare) `operator_cidr`, `alarm_email`, `vpc_id`, `subnet_id`.
- [x] T002 [P] Create `k8s/o11y/kustomization.yaml` skeleton (kustomize.config.k8s.io/v1beta1) listing the o11y resources as they are added by later tasks.
- [x] T003 [P] Create `k8s/o11y-dashboards/` skeleton: `dashboards/`, `alerts/`, and a stub `README.md` (filled in US5).

**Checkpoint**: variable surface + directory scaffolds exist.

---

## Phase 2: Foundational (blocks US2, US4, US5, US6 — Collector + secret/TLS scaffolding)

**⚠️ These are prerequisites for the cluster-side user stories. US1 (Terraform node)
and US3 (Terraform alarms) do not depend on this phase and may proceed in parallel.**

- [x] T004 Create `k8s/o11y/namespace.yaml` — `o11y` namespace with PSS `enforce=privileged` labels (G1, FR-021); add to `k8s/o11y/kustomization.yaml`.
- [x] T005 [P] Create `k8s/secrets/openobserve-root.enc.yaml` **scaffold** (keys `ZO_ROOT_USER_EMAIL`/`ZO_ROOT_USER_PASSWORD`, placeholder values, clearly marked "ops-track fills + `sops -e`"; no real values) per contracts/secrets.md (FR-006, SC-004).
- [x] T006 [P] Create `k8s/secrets/o11y-tls.enc.yaml` **scaffold** (keys `ca.key`, `server.key`, `server.crt`; placeholder; ops-generated) per contracts/secrets.md (FR-007, SC-004).
- [x] T007 [P] Create `k8s/o11y/ca-trust-configmap.yaml` — plaintext ConfigMap holding the public `ca.crt` (placeholder the ops track pastes) for the exporter `tls.ca_file` (FR-007, FR-019); add to kustomization.
- [x] T008 Create `k8s/o11y/collector-rbac.yaml` — ServiceAccount + ClusterRole + ClusterRoleBinding granting the `k8s_events`/`kubeletstats` receivers `events`, `nodes/stats`, `pods` access (FR-015/016); add to kustomization.
- [x] T009 Create `k8s/o11y/collector-config.yaml` ConfigMap skeleton: the single `otlp` **exporter** → `<node internal name>:5081` gRPC with `tls.ca_file`, `retry_on_failure`, bounded persistent `sending_queue`; a `file_storage` extension; a review-visible **privacy-invariant header** (FR-027/028); empty `receivers`/`pipelines` placeholders that US2/US4/US6 fill (FR-019/028); add to kustomization.
- [x] T010 Create `k8s/o11y/collector-daemonset.yaml` — OTel Collector contrib DaemonSet, image `var.otel_collector_image` (digest-pinned), read-only hostPath mount `/var/log/pods`, host-metrics access, modest `resources.requests/limits` (FR-023), mounts the config ConfigMap + CA-trust ConfigMap + `file_storage` offset hostPath (FR-014/016); add to kustomization.
- [x] T011 Create `k8s/o11y/networkpolicies.yaml` — default-deny (ingress+egress) in `o11y` + DNS egress to kube-system (FR-020/021); add to kustomization.
- [x] T012 Wire the Collector into production: add `../../o11y` to `resources` in `k8s/overlays/aws-prod/kustomization.yaml` (aws-prod only; minikube untouched — FR-014, SC-002).

**Checkpoint**: `kustomize build k8s/overlays/aws-prod` renders the o11y namespace +
Collector skeleton; `kustomize build k8s/overlays/minikube` is unchanged.

---

## Phase 3: User Story 1 — Monitoring platform provisioned as code (Priority: P1) 🎯 MVP

**Goal**: The complete locked-down OpenObserve monitoring node as reviewable Terraform
+ committed runtime config.

**Independent Test**: `tofu validate`/`tofu fmt -check` pass; every bullet of the
design's "Backend" section traces to a declared resource / committed file / documented
ops step; ingress 100% SG/CIDR-scoped; node role S3 access = exactly one bucket.

- [x] T013 [P] [US1] Create `infra/terraform/openobserve_bucket.tf` — `aws_s3_bucket.openobserve` (`squiredocs-openobserve`), SSE-KMS on the shared CMK (`bucket_key_enabled`), `public_access_block` all-true, single lifecycle `expiration.days = var.o11y_retention_days`, versioning disabled (FR-003, RD-1/RD-2).
- [x] T014 [P] [US1] Create `infra/terraform/monitoring_sg.tf` — `aws_security_group.monitoring` with four `aws_vpc_security_group_ingress_rule` (5080+5081 each from `aws_security_group.node.id` and `var.operator_cidr`) + one egress-all rule; no world-open rule (FR-004, SC-003).
- [x] T015 [US1] Create `infra/terraform/monitoring_iam.tf` — `aws_iam_role.monitoring` (EC2 assume) + `AmazonSSMManagedInstanceCore` attach + inline S3 policy scoped to `aws_s3_bucket.openobserve` only (`Put/Get/Delete/List`) + inline KMS `GenerateDataKey`/`Decrypt` on the CMK + `aws_iam_instance_profile.monitoring` (FR-002, SC-003). Depends on T013 for the bucket ARN.
- [x] T016 [US1] Create `infra/terraform/openobserve/openobserve.service` (systemd: single pinned-image container, `Restart=on-failure`, `MemoryMax=1536M`) and `infra/terraform/openobserve/openobserve.env` (`ZO_LOCAL_MODE`, `ZO_LOCAL_MODE_STORAGE=s3`, `ZO_S3_*`, `ZO_DATA_RETENTION_DAYS=${retention}` ≤ lifecycle, `ZO_*_TLS_*` cert paths, root-cred vars via ops EnvironmentFile) — committed, reviewable (FR-005/006/007/008, RD-9/RD-10).
- [x] T017 [US1] Create `infra/terraform/monitoring-cloud-init.yaml.tftpl` — write the OO unit + env + server cert/key (ops-placed) to the node, `systemctl enable --now openobserve`; templated vars (image, bucket, region, retention). Mirror `cloud-init.yaml.tftpl` style (FR-005/007).
- [x] T018 [US1] Create `infra/terraform/monitoring.tf` — `aws_instance.monitoring` (arm64 AMI data source reused, `var.o11y_instance_type`, IMDSv2 required, one encrypted gp3 root `var.o11y_root_volume_size`, no data volume, no EIP, `vpc_security_group_ids=[monitoring SG]`, `iam_instance_profile`, `user_data=templatefile(monitoring-cloud-init.yaml.tftpl,…)`, `lifecycle{ignore_changes=[user_data]}`) (FR-001/009, RD-3/RD-5). Depends on T014/T015/T017.
- [x] T019 [US1] Extend `infra/terraform/outputs.tf` — monitoring node private address + OO bucket name (for the FR-029 ops docs / cert SANs).

**Checkpoint**: US1 renders + validates independently (Terraform-only; no cluster dep).

---

## Phase 4: User Story 2 — Durable centralized logs (Priority: P1)

**Goal**: Collector logs pipeline reads container logs + k8s events and exports OTLP/TLS
to the node, surviving pod/node churn.

**Independent Test**: aws-prod render shows a Collector with `filelog` (over
`/var/log/pods`, offset-checkpointed) + `k8s_events` → OTLP/TLS exporter; minikube has none.

- [x] T020 [US2] Add to `k8s/o11y/collector-config.yaml`: `filelog` receiver (`include: /var/log/pods/*/*/*.log`, persistent offset via the `file_storage` extension — FR-015) + `k8s_events` receiver + a `logs` pipeline wired to the foundational OTLP exporter.
- [x] T021 [US2] Update `k8s/o11y/collector-daemonset.yaml`: add the `file_storage` offset hostPath volume/mount so filelog offsets survive Collector restart (FR-015 checkpointing).
- [x] T022 [US2] Add to `k8s/o11y/networkpolicies.yaml`: Collector **egress** to the monitoring node private IP on 5081 (FR-020; node IP filled by ops per RD-13).

**Checkpoint**: logs pipeline present in aws-prod render; US1 unaffected.

---

## Phase 5: User Story 3 — Independent-path alarms (Priority: P2)

**Goal**: CloudFront + Route 53 alarms on the existing SNS/email path, sharing no
dependency with the o11y stack.

**Independent Test**: `alarms.tf` declares all three paths → `aws_sns_topic.backup_alarms`;
0 references to the node/OpenObserve/Collector.

- [x] T023 [P] [US3] Create `infra/terraform/alarms.tf` — `aws_cloudwatch_metric_alarm.cf_5xx` (`5xxErrorRate` Avg, `period=60`/`eval=5`/`datapoints=5`/`>=var.cf_5xx_threshold`, `treat_missing=notBreaching`, RD-14), `aws_cloudwatch_metric_alarm.cf_requests_anomaly` (`Requests` + `ANOMALY_DETECTION_BAND(m1,var.requests_anomaly_stddev)` via `metric_query`), `aws_route53_health_check.ready` (`HTTPS_STR_MATCH`, `/ready`, `app.squiredocs.com`, `search_string=var.ready_health_check_search_string`, interval 30, failure_threshold 3) + `aws_cloudwatch_metric_alarm.ready_health` (`HealthCheckStatus` Min `<1`, `treat_missing=breaching`); all `alarm_actions`/`ok_actions=[aws_sns_topic.backup_alarms.arn]` (FR-010/011/012/013, RD-6/RD-8).
- [x] T024 [US3] Seed the `ready_health_check_search_string` default from the healthy `/ready` response literal in `server/ready.js` (read-only grep to pick a stable token; no code change) and add the ops-track "confirm against live body before trusting" note (already in promotion-notes) as a comment in `alarms.tf` (RD-7).

**Checkpoint**: three alarms declared, shared-nothing; fully independent of all other phases.

---

## Phase 6: User Story 4 — Infra, datastore & certificate metrics (Priority: P2)

**Goal**: Collector metrics pipeline covers host, pod/container, Postgres, Redis, and
cert-manager cert-expiry, with scoped NetworkPolicy allowances.

**Independent Test**: aws-prod render's Collector config contains `hostmetrics`,
`kubeletstats`, `postgresql`, `redis`, `prometheus`(cert-manager) receivers → metrics
pipeline; NetworkPolicy permits exactly Collector→PG/Redis/cert-manager.

- [x] T025 [US4] Add `hostmetrics` (cpu/memory/disk/filesystem) + `kubeletstats` receivers and a `metrics` pipeline to `k8s/o11y/collector-config.yaml` (FR-016).
- [x] T026 [US4] Add `postgresql` + `redis` receivers to `k8s/o11y/collector-config.yaml`, sourcing credentials from the existing `postgres-secret`/`redis-auth` SOPS secrets (no plaintext, no new secret — FR-017, G3).
- [x] T027 [US4] Add a `prometheus` receiver scraping cert-manager's metrics endpoint for `certmanager_certificate_expiration_timestamp_seconds` to `k8s/o11y/collector-config.yaml` (FR-018).
- [x] T028 [US4] Update `k8s/o11y/collector-daemonset.yaml` to mount `postgres-secret` + `redis-auth` into the Collector for the datastore receivers (FR-017).
- [x] T029 [US4] Add the collab-side allowances to `k8s/overlays/aws-prod/networkpolicies.yaml` (ingress on `collab-postgres`:5432 and `collab-redis`:6379 from the `o11y` namespace) and the matching Collector egress + cert-manager-metrics egress to `k8s/o11y/networkpolicies.yaml` — preserving default-deny everywhere else (FR-020, FR-021).

**Checkpoint**: metrics receivers + policies present; collab `restricted`/default-deny untouched.

---

## Phase 7: User Story 5 — Dashboards & in-stack alerts (Priority: P3)

**Goal**: Committed OpenObserve dashboards + 6 in-stack alert definitions with a
documented idempotent import.

**Independent Test**: each of the 6 alert classes + each dashboard family maps to a
committed JSON or an explicit documented step; privacy-grep clean.

- [x] T030 [P] [US5] Add OpenObserve dashboard JSON to `k8s/o11y-dashboards/dashboards/` — golden signals (rate/errors/duration/saturation) + node + Postgres + Redis panels; identifiers only, no content-bearing fields (FR-024, FR-027).
- [x] T031 [P] [US5] Add alert JSON to `k8s/o11y-dashboards/alerts/` for the 6 classes: app error rate, `/ready` failure, node CPU/mem/disk, Postgres health, Redis health, cert expiry (from `certmanager_certificate_expiration_timestamp_seconds`, actionable lead time) (FR-025).
- [x] T032 [US5] Write `k8s/o11y-dashboards/README.md` — the idempotent ops-track import (`curl` POST/PUT per artifact against the OpenObserve API with SOPS root creds) + any UI-only steps as numbered manual steps (FR-026, RD-11).

**Checkpoint**: dashboards/alerts accounted (SC-006); grep-clean (SC-007).

---

## Phase 8: User Story 6 — Ready to receive app telemetry from 014 (Priority: P3)

**Goal**: A stable in-cluster OTLP intake Service + app→Collector allowance, passive
(no dependency on 014).

**Independent Test**: aws-prod render exposes `otel-collector.o11y` on 4317/4318 backed
by an `otlp` receiver, reachable from `collab-app` under NetworkPolicy; contract doc matches.

- [x] T033 [US6] Create `k8s/o11y/collector-service.yaml` — ClusterIP Service `otel-collector` in `o11y` exposing 4317 (gRPC) + 4318 (HTTP); add the matching `otlp` intake receiver (plaintext) to `k8s/o11y/collector-config.yaml` (FR-022, G2); add Service to kustomization.
- [x] T034 [US6] Add the app→Collector NetworkPolicy pair: `collab-app` egress to `o11y`:4317/4318 in `k8s/overlays/aws-prod/networkpolicies.yaml`, and matching ingress-from-collab on the Collector in `k8s/o11y/networkpolicies.yaml` (FR-020, US6-2).
- [x] T035 [US6] Verify the rendered Service name/ports match `contracts/otlp-intake.md` (the documented `OTEL_EXPORTER_OTLP_ENDPOINT` for 014); adjust the contract doc if the render differs. Confirm the Collector functions with zero app telemetry (passive — FR-022, US6-3).

**Checkpoint**: 014 seam present + documented; passive.

---

## Phase 9: Privacy, security & ops documentation cross-cutting

- [x] T036 Add/confirm the FR-028 privacy-invariant header comment in `k8s/o11y/collector-config.yaml` and a matching note in `k8s/o11y-dashboards/README.md` so future edits inherit the constraint (FR-027/028).
- [x] T037 Author the ops-track execution guide `specs/013-o11y-platform/ops-runbook.md` (in-feature doc; the merge-queue `docs/operations.md` rewrite in T041 links/summarizes it) covering: private CA + server-cert + OO-root-cred generation commands (openssl/cfssl), apply ordering, the design's post-apply signal-path verifications (kill-a-pod log durability, `kubectl top` cross-check, synthetic alarm trips), the monitoring-node config-update path (cloud-init immutability → replace vs. SSM in-place), and the week-one memory watch with the `t4g.medium` resize trigger (FR-029). Consolidates the fragments already in promotion-notes.md / contracts/secrets.md.

---

## Phase 10: Verification Gate & polish (per quickstart.md)

- [x] T038 [P] Run Gate 1: `cd infra/terraform && tofu fmt -check && tofu validate` — 0 fmt diffs, validate passes (SC-001). If a provider can't resolve offline, fall back to structured HCL review and record it (T040).
- [x] T039 [P] Run Gate 2: `kustomize build k8s/overlays/aws-prod` (assert Collector present with all 7 receiver classes + TLS OTLP exporter + 4317/4318 Service) and `kustomize build k8s/overlays/minikube` (assert 0 Collector/monitoring refs + **byte-identical** to the pre-feature baseline via `git stash` diff) (SC-002).
- [x] T040 Run Gate 3/4: privacy grep + secrets grep across `k8s/o11y`, `k8s/o11y-dashboards`, `infra/terraform/openobserve` (0 content-bearing fields, 0 plaintext secret values — SC-004/SC-006/SC-007); record any toolchain degradation (absent `terraform`/`kubectl`/`yamllint`) in `promotion-notes.md`.
- [ ] T041 [MERGE-QUEUE — do NOT execute in this worktree] Replace the observability section of `docs/operations.md` with the real architecture (monitoring node, Collector, independent-path alarms, dashboards, accepted limitations), summarizing/linking the T037 ops-runbook. Executed at merge-queue time per the pipeline docs-convergence rule (FR-030).

---

## Dependencies & Execution Order

### Phase dependencies

- **Setup (P1)**: no dependencies.
- **Foundational (P2)**: needs Setup; **blocks US2, US4, US5-import-creds, US6** (all edit the Collector config/daemonset/policies created here).
- **US1 (P3 phase / P1 priority)**: needs only Setup (T001 vars) — Terraform-only, independent of Foundational.
- **US3 (P5 phase / P2 priority)**: needs only Setup (T001 vars) — Terraform-only, fully independent (can run anytime after T001).
- **US2, US4, US6**: need Foundational; US2/US4/US6 all edit `collector-config.yaml` (serialize edits to that file — not mutually [P]).
- **US5**: needs Setup dir scaffold (T003); otherwise standalone (dashboards/alerts JSON).
- **Phase 9**: after the files it annotates exist (T036 privacy header; T037 ops-runbook consolidates ledger fragments — authorable once the design is settled).
- **Phase 10**: after all authored files exist.

### User-story independence

- **US1** and **US3** are pure Terraform and share no files with the cluster stories — maximally parallel.
- **US5** (dashboard/alert JSON) shares no files with the Collector stories.
- **US2/US4/US6** are independently *testable* but share `collector-config.yaml`, `collector-daemonset.yaml`, and the two `networkpolicies.yaml` files — order their edits, don't parallelize same-file writes.

### Parallel opportunities

- Setup: T002, T003 [P] together (T001 first — others reference nothing it defines but it's the shared var surface).
- Foundational: T005, T006, T007 [P] (distinct new files); T008–T011 each new files but T009/T010 are referenced by T012 wiring.
- US1: T013, T014 [P]; then T015 (needs bucket), T016/T017, T018 (needs SG/IAM/tftpl), T019.
- US3: T023 [P] with any US1 task (different files); T024 follows T023.
- US5: T030, T031 [P]; T032 after.
- Polish: T038, T039 [P].

### Suggested MVP

**US1 + US2** (both P1): the monitoring node platform (US1) plus durable centralized
logs (US2) — the highest-value gap in the design's ranking (logs first). US3 (P2
alarms) is a cheap, fully-independent add that can ship alongside since it touches only
`alarms.tf`.

---

## Notes

- [P] = different file, no incomplete-task dependency. Same-file edits (esp.
  `collector-config.yaml`) are never [P] with each other.
- Every task is authoring-only; nothing here applies to AWS or runs against the cluster.
- Secret files are **scaffolds** — real CA/creds are ops-generated + `sops -e`
  encrypted post-merge (contracts/secrets.md, promotion-notes.md).
- T041 is intentionally NOT executed in the worktree (merge-queue docs convergence).
