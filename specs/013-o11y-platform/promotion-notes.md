# Feature 013 — Promotion / ops-track notes

Started at spec time (2026-07-16). Items here are accepted limitations, ops-track
actions, and follow-ups that outlive the authoring work. Extend during plan /
implement / review.

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
  Collector exporter's `hostAliases` at cert-generation time (RD-13) — the IP is
  stable once the instance exists but is unknown at authoring time.

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
