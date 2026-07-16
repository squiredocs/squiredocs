# Clarifications Ledger — 013-o11y-platform

Per Constitution Principle VI: unanswered decisions get the best default, recorded
here as RATIFIED-BY-DEFAULT; material design gaps or tensions are flagged, never
resolved silently. Design ground truth: `design/observability-and-telemetry.md`
(commit 100a692); the chosen-path plan (Sam, 2026-07-16) is normative for
deployment specifics. Decisions already made there are **Sam-ratified 2026-07-16**
and are cited in the spec, not re-decided — see "Cited decisions" at the end.

All entries below: **RATIFIED-BY-DEFAULT (Sam pre-authorized, 2026-07-16)** unless
amended in the design doc.

---

## Flagged design gaps (tensions/silences — need Sam's eyes, resolved by default)

### G1 — Collector host access vs. the `collab` namespace's `restricted` PSS enforcement

- **Question**: The Collector DaemonSet needs hostPath mounts (`/var/log/pods` for
  filelog) and host-level metrics (hostmetrics) — capabilities the `restricted`
  Pod Security Standards profile forbids. The `collab` namespace enforces
  `restricted` (feature 011, ledger RD-8). Where does the Collector run, and at
  what PSS level?
- **Why it matters**: Deploying it into `collab` either fails admission (feature
  dead on arrival) or forces weakening the namespace's enforcement (eroding 011's
  hardening posture for every workload, not just the Collector).
- **Chosen default**: A dedicated namespace (e.g. `o11y`) for the Collector with
  PSS `privileged` (the standard posture for node-agent DaemonSets that need host
  access), while `collab` keeps `enforce=restricted` untouched. NetworkPolicy
  allowances (FR-020) are the cross-namespace seams, enumerated explicitly.
- **Rationale**: Isolating the one host-privileged workload in its own namespace is
  the k8s-conventional resolution: the hardened app namespace stays hardened, and
  the privileged surface is a single, reviewable, agent-only namespace. Spec:
  FR-014, FR-020, FR-021; Edge Cases.

### G2 — The feature-014 interface: endpoint contract fixed before 014 is specced

- **Question**: 014 is being specced in parallel; the orchestrator fixed the
  interface as "app exports OTLP via standard `OTEL_EXPORTER_OTLP_ENDPOINT` to
  the cluster-local Collector". This feature must pick the concrete Service
  name/port that variable will hold, without seeing 014's spec.
- **Why it matters**: If the two specs assume different endpoints or protocols,
  app telemetry silently goes nowhere at integration time.
- **Chosen default**: The Collector exposes a Service reachable from the `collab`
  namespace on the standard OTLP ports (4317 gRPC, 4318 HTTP), both enabled; the
  documented contract for 014 is the HTTP endpoint form
  (`http://<collector-service>.<o11y-namespace>.svc.cluster.local:4318`), with
  gRPC available at 4317 if 014 prefers it. Plain in-cluster OTLP (no TLS inside
  the cluster); TLS begins at the Collector→monitoring-node hop.
- **Rationale**: Standard OTLP ports + the standard env var is the zero-surprise
  contract any OTel SDK expects; offering both protocols means 014 can't guess
  wrong. In-cluster plaintext matches the existing intra-namespace posture (app→PG
  /Redis are also plaintext inside the default-deny cluster). Spec: FR-020, FR-022;
  Dependencies.

### G3 — Postgres/Redis receiver credentials: no monitoring user exists

- **Question**: The design mandates Postgres and Redis receivers but is silent on
  what credentials they use. No read-only monitoring role exists in Postgres, and
  creating one is a database change this infra-track feature must not make.
- **Why it matters**: Datastore credentials mounted into a new pod widen the blast
  radius of a Collector compromise from "telemetry" to "the database".
- **Chosen default**: Reuse the existing SOPS-encrypted secrets (`postgres-secret`
  for the Postgres receiver, `redis-auth` for the Redis receiver), mounted into
  the Collector — no new credentials, no plaintext. A dedicated least-privilege
  Postgres monitoring role (`pg_monitor`) is recorded in promotion-notes.md as a
  follow-up owned by the app/db track, since role creation is a database change.
- **Rationale**: Smallest change that satisfies the design now; the secrets are
  already SOPS-managed and the Collector's namespace is operator-only. The
  follow-up (not a blocker) restores least-privilege once a db-change vehicle
  exists. Spec: FR-017; Edge Cases.

---

## Ratified-by-default decisions

### RD-1 — S3 retention within the design's 15–30 day band

- **Question**: The design says lifecycle expiry "~15–30 days". Which value?
- **Default**: 30 days, as a Tofu variable (`o11y_retention_days`, default 30);
  OpenObserve's internal retention set to the same value (FR-008 keeps it ≤ the
  lifecycle).
- **Rationale**: The top of the ratified band maximizes debugging lookback for
  pennies of S3 at beta volume; the design names the lifecycle as "the tuning
  knob", so it ships as a variable, tuned after the first week's cost check.

### RD-2 — Bucket name and KMS key

- **Question**: What is the OpenObserve bucket called and which key encrypts it?
- **Default**: Bucket `squiredocs-openobserve` (following the existing
  `squiredocs-*` convention), SSE-KMS with the existing project CMK
  (`alias/squiredocs`, 011 ledger RD-3). All public access blocked.
- **Rationale**: One CMK keeps the key-policy surface reviewable at this scale
  (same reasoning as 011 RD-3); a per-service key is a later refinement.

### RD-3 — Monitoring node root volume size

- **Question**: The plan says "~20–30 GB gp3, root only". Which?
- **Default**: 20 GiB gp3, encrypted with the project CMK, as a variable.
- **Rationale**: Data lives in S3; the root holds OS + container image + OpenObserve
  scratch. 20 GiB matches the prod node's root sizing and is a plan-visible
  variable if it ever needs growth.

### RD-4 — OTLP export protocol from Collector to monitoring node

- **Question**: The design opens both 5080 (HTTP) and 5081 (gRPC). Which does the
  Collector's exporter use?
- **Default**: gRPC to 5081 (OTLP/gRPC exporter, TLS with the private CA). 5080
  stays open for the UI (operator) and as the fallback ingest path.
- **Rationale**: gRPC is the OTel-default, more efficient exporter transport;
  keeping 5080 admitted preserves the UI path and a same-SG fallback without any
  extra exposure.

### RD-5 — Monitoring node addressing and certificate SANs

- **Question**: What address does the Collector dial, and what must the server
  cert's SANs cover? (The design is silent; certs bind to names.)
- **Default**: The node keeps a stable private IP within the VPC; a private
  Route 53 record (e.g. `o11y.internal.squiredocs.com` or equivalent internal
  name) points at it, the server certificate's SANs cover that name (plus the
  private IP as an IP SAN), and the Collector exporter targets the name. All
  telemetry traffic stays in-VPC; no public path is required for ingest.
- **Rationale**: A name (not a raw IP) in the exporter config survives node
  replacement without re-issuing the cert being the only fix; in-VPC private
  addressing means the SG rules and the cert story stay simple. Exact record
  mechanics are a plan-time detail behind this contract.

### RD-6 — Alarm thresholds and anomaly sensitivity

- **Question**: The design names the alarms but not their numbers.
- **Default**: `5xxErrorRate` average ≥ 5% for 5 consecutive minutes (missing
  data = not breaching — the health check owns "no traffic at all");
  `Requests` anomaly alarm with a 2-standard-deviation band on the anomaly
  detector; Route 53 health check on a 30-second interval with the default 3-of-3
  failure threshold, alarming on `HealthCheckStatus` minimum < 1 for 2 of 3
  minutes. All values are variables/tunables.
- **Rationale**: Standard starting values that bias toward catching real outages
  over page noise at beta traffic; the design's SLO-based tuning explicitly comes
  "once baselines exist", so these ship adjustable.

### RD-7 — Route 53 health check target and match string

- **Question**: Does the synthetic probe the CloudFront viewer path or the origin
  directly, and what string does it match?
- **Default**: HTTPS against the public hostname (`app.squiredocs.com`), path
  `/ready`, matching a stable marker from the endpoint's existing healthy
  response body (exact token confirmed against the live `/ready` contract at
  plan time). This exercises the full viewer path: DNS → CloudFront → origin →
  app → Postgres (the `/ready` gate).
- **Rationale**: An "external synthetic" that enters where users enter catches
  edge failures (CloudFront, DNS, WAF misconfig) that an origin-direct probe
  would miss; `/ready` is PG-gated so it is a real depth probe, and string
  matching fails closed if the body changes.
- **Correction (2026-07-16, post-merge review)**: The default above named
  `app.squiredocs.com` as "the public hostname / viewer path" — that was wrong.
  `app.squiredocs.com` is the CloudFront **origin** A record (points at the node
  EIP), and the origin's 443 ingress is scoped to the CloudFront origin-facing
  prefix list, so Route 53's distributed checkers are BLOCKED at the origin — the
  health check would fail and page falsely forever. The check now probes
  `squiredocs.com`, the CloudFront **viewer** alias (full public path, no caching,
  all methods forwarded; WAF fronts it and R53 checker volume is far below any rate
  rule). The RATIONALE is unchanged — enter where users enter, full DNS → CloudFront
  → origin → app `/ready` depth probe, string match fails closed. Fix in
  `infra/terraform/alarms.tf` (`aws_route53_health_check.ready.fqdn`). Flagged for
  Sam's ratification of the corrected probe target.

### RD-8 — Reuse of the existing SNS topic

- **Question**: The design says the new alarms feed "the existing SNS/email path
  alongside the backup-freshness alarm". Reuse `squiredocs-backup-alarms`
  verbatim, or generalize?
- **Default**: Reuse the existing `squiredocs-backup-alarms` topic and its
  `var.alarm_email` subscription as-is; no rename, no second topic.
- **Rationale**: The design's words are "the existing SNS/email path"; renaming a
  live topic churns the subscription (re-confirmation email) for zero functional
  gain. A cosmetic rename can ride a later cleanup Sam ratifies explicitly.

### RD-9 — OpenObserve image pinning and upgrade path

- **Question**: How is the OpenObserve version controlled on an immutable-ish
  cloud-init node?
- **Default**: The arm64 image reference (specific version tag, digest-pinned
  where practical) is a Tofu variable rendered into the committed unit/compose
  file. Upgrades are a variable change + node user-data replacement (or the
  documented in-place `systemctl` update path in the ops docs, FR-029) — never an
  unpinned `latest`.
- **Rationale**: Matches the repo's digest-pinning posture (011 FR-015/RD-10);
  a floating tag on the telemetry store would make its behavior non-reproducible.

### RD-10 — Memory guardrail on the 2 GB node

- **Question**: The design accepts t4g.small with an early-resize escape hatch;
  what stops OpenObserve from wedging the 2 GB node before the resize decision?
- **Default**: The systemd unit/compose sets a memory limit (~1.5 GiB) so the OOM
  outcome is a container restart, not a dead node; restart-on-failure is set; the
  week-one memory watch and resize trigger are explicit ops-doc steps (FR-029).
- **Rationale**: Converts the known risk into a self-healing degradation with a
  documented human decision point, exactly matching the ratified "watch memory in
  week one, resize early" posture.

### RD-11 — Dashboards/alerts-as-code mechanism

- **Question**: "Config as code where OpenObserve supports it" — what does that
  concretely mean for dashboards and alerts?
- **Default**: Dashboard definitions committed as OpenObserve-importable JSON and
  alert definitions committed as code (JSON/API payloads) under the o11y config
  area, with a documented, idempotent ops-track provisioning step (API calls or
  UI import, stated explicitly per artifact). Anything OpenObserve cannot ingest
  as config is written down as numbered manual steps (FR-026).
- **Rationale**: OpenObserve has no mature IaC provider; committed-definitions +
  documented import is the strongest reproducibility available without inventing
  tooling, and it keeps review possible (SC-006, SC-007 grep across these files).

### RD-12 — Private CA parameters

- **Question**: Key type, validity, and storage layout for the private CA?
- **Default**: A minimal single-purpose CA (modern key type per the design's
  posture, e.g. EC P-256): CA validity ~10 years, server cert validity ~2–3 years
  with expiry dates recorded in the ops docs (FR-029); private keys SOPS-encrypted
  under the existing `k8s/secrets/*.enc.yaml` creation rule (or an added
  `infra/secrets` rule if plan prefers — same encryption posture either way); the
  CA *certificate* (public) committed plaintext for the Collector's `tls.ca_file`.
- **Rationale**: Long-lived private-path certs are the standard trade for a
  single-operator internal CA — the alternative (short certs on a node that only
  reprovisions via cloud-init) manufactures an outage-by-expiry risk the design's
  cert-expiry alerting doesn't cover (it watches cert-manager, not this CA).
  Recording expiry + a documented re-issue path closes the loop.

### RD-13 — Monitoring-node addressing without a managed private hosted zone (plan-time)

- **Question**: RD-5 floated a *private Route 53 record* (`o11y.internal...`) as the
  cert SAN + exporter target. But the `squiredocs.com` zone in the module is **public**
  (`edge.tf` `data.aws_route53_zone.squiredocs`, `private_zone = false`) and there is
  **no private hosted zone** declared. Do we add one?
- **Default (RATIFIED-BY-DEFAULT, Sam pre-authorized, 2026-07-16)**: No managed private
  zone. The server certificate carries the node's **private IP as an IP SAN** plus a
  stable internal DNS name SAN (`o11y.squiredocs.internal`); the Collector exporter
  targets that name resolved to the private IP (a `hostAliases`/static mapping), all
  in-VPC. Ops fills the concrete private IP at cert-generation time (stable once the
  instance exists; FR-029). A managed private hosted zone remains an additive option
  later if desired.
- **Rationale**: A private hosted zone is extra managed infra for a single node whose
  IP is stable; an IP SAN + internal-name SAN gives the same churn-resilience for the
  cert story without a new Route 53 zone resource. Honors RD-5's intent (a name, not a
  raw IP, in the exporter config; traffic stays in-VPC). Spec: FR-009; contracts/
  collector-exporter.md.

### RD-14 — 5xx alarm evaluation window literalization (plan-time)

- **Question**: RD-6 says "`5xxErrorRate` average ≥ 5% for **5 consecutive minutes**".
  With a single 300s period that is one 5-minute average; with 60s periods it is 5
  consecutive one-minute datapoints. Which realizes "5 consecutive minutes"?
- **Default (RATIFIED-BY-DEFAULT, Sam pre-authorized, 2026-07-16)**: `period = 60`,
  `evaluation_periods = 5`, `datapoints_to_alarm = 5` — five consecutive one-minute
  breaches. `cf_5xx_threshold` (5) and `cf_5xx_eval_minutes` (5) are variables.
- **Rationale**: Matches the ledger wording literally (sustained 5-minute breach, not
  a single 5-minute average that a one-minute spike could trip), and keeps both the
  threshold and the window tunable per RD-6's "all values are variables". Spec: FR-010;
  data-model.md Entity E.

### RD-15 — Monitoring-node internet egress path (public IP vs NAT/endpoints) (post-merge review)

- **Question**: `monitoring.tf` left the node's internet path to subnet defaults. That
  is a silent fork: on a subnet with no auto-assign public IP and no NAT gateway / VPC
  endpoints, cloud-init and SSM brick (no package/image pulls, no Session Manager); on a
  subnet that auto-assigns, the node silently gets a public IP that contradicted the
  "private-IP only" comments in `monitoring.tf` and `outputs.tf`. Which path?
- **Default (RATIFIED-BY-DEFAULT, Sam pre-authorized, 2026-07-16)**: Set
  `associate_public_ip_address = true` EXPLICITLY. The node has a public IP for EGRESS
  ONLY (image/package pulls, S3, SSM). Ingress remains locked to the prod-node SG +
  operator CIDR on 5080/5081 only (monitoring_sg.tf, SC-003) — the public IP admits
  nothing inbound. The prod → monitoring OTLP ingest path stays on PRIVATE IPs in-VPC
  (RD-5/RD-13). The misleading "private-IP only" comments were corrected to match.
- **Rationale**: Public-IP-with-locked-SG chosen over a NAT gateway / VPC endpoints on
  cost — ~$32/mo for a NAT gateway vs $0 — for a beta telemetry node whose inbound is
  already SG-sealed. Making the choice explicit removes the subnet-default fork.
  Revisit (NAT / VPC endpoints) if the posture tightens. Fix in `infra/terraform/
  monitoring.tf`, comment corrections in `monitoring.tf` + `outputs.tf`.

---

## Cited decisions (Sam-ratified 2026-07-16 in the design doc / chosen-path plan — not re-decided here)

- OpenObserve as the backend; dedicated monitoring node (deploy model A); backend
  swappable via OTLP-everywhere.
- `t4g.small` with the early `t4g.medium` resize escape hatch; arm64 image;
  systemd/compose single container via cloud-init; config + unit committed.
- Dedicated S3 bucket, SSE-KMS, lifecycle expiry 15–30 d; least-privilege node
  role scoped to that bucket; no EBS data volume.
- Ingress lockdown: 5080/5081 only from prod node SG + operator IP; UI private
  (operator IP / SSM port-forward), never public.
- Private CA via SOPS + cloud-init; prod Collector trusts via `tls.ca_file`;
  cert-manager explicitly not applicable; root creds seeded from SOPS.
- Collector receiver set: filelog (`/var/log/pods`), k8s_events, hostmetrics,
  kubeletstats/cAdvisor, Postgres, Redis, prometheus scrape of cert-manager
  (`certmanager_certificate_expiration_timestamp_seconds`).
- Independent-path alarms in the same IaC pass: CloudFront `5xxErrorRate` +
  `Requests` anomaly; Route 53 health check for the `/ready` synthetic (HTTPS +
  string match) — explicitly not a Synthetics canary — on the existing SNS/email
  path.
- In-stack alerts: app error rate, `/ready` failure, node CPU/mem/disk, PG/Redis
  health, cert expiry. Dashboards: golden signals + node/PG/Redis panels.
- Accepted limitations: no SSO/RBAC in OSS OpenObserve; single monitoring node is
  not HA; exception-email notifier stays as a redundant channel.
- Privacy invariant: document content never enters telemetry — identifiers only.
- Two-feature split: 013 = platform (this spec), 014 = app instrumentation; the
  interface is `OTEL_EXPORTER_OTLP_ENDPOINT` → cluster-local Collector.

## RD-4 amendment (2026-07-16, rollout — reality falsified the gRPC choice)

RD-4 chose OTLP/gRPC 5081 for the Collector→OpenObserve hop. In production,
OpenObserve's internal flight-search dials its OWN gRPC port for every query and
rejects the private-CA server cert (`InvalidCertificate(UnknownIssuer)`), breaking
all search while ingest appeared healthy. Amended (Sam-authorized rollout, applied
live + back-ported): the Collector exports **OTLP/HTTP over TLS on 5080** (same
private CA via `tls.ca_file`, same basicauth); `ZO_GRPC_TLS_ENABLED=false` so 5081
carries only OpenObserve's self-dialing and never crosses the network (SG-locked
regardless). The prod→monitoring ingest hop remains TLS end-to-end.
