<!-- source: https://squiredocs.com/d/cc54717e-2a4c-4f7d-ba91-2b518c83f85e
     synced-by: design/sync.mjs — DO NOT HAND-EDIT; amend the Squire doc and re-sync -->

# Squire Observability and Telemetry

## What this is

How Squire sees itself in production: metrics, traces, durable centralized logs, dashboards, and alerting for both the infrastructure and the application. This document is the design ground truth for the observability platform (a dedicated monitoring node receiving OpenTelemetry data) and for the application's instrumentation. Companion to Squire Infrastructure and Environments, which owns the cluster and node topology this plugs into.

## Why (the pre-beta gap)

Before this design landed, observability was effectively absent: health probes and account-level audit existed, but there were no metrics, no traces, no durable logs (container logs died with the pod), and almost no alerting — the only failure signal was a best-effort exception email. For a public beta that is the largest operational blind spot. The gap ranking that drives build order: durable centralized logs first, then infra/datastore metrics with alarms, then app metrics, then distributed traces.

## The load-bearing architectural decision

The application is instrumented with **vendor-neutral OpenTelemetry** and every signal ships through an **OTel Collector**. The backend is therefore swappable: every candidate backend speaks OTLP, so choosing wrong costs a Collector config change, not re-instrumentation. Instrumentation is identical regardless of backend.

## Backend: OpenObserve on a dedicated monitoring node

- **Deployment model:** a dedicated monitoring EC2 node, separate from the prod cluster — it isolates o11y load from the 4 GB prod node and survives prod-node failure, so the outage remains visible while it happens. Chosen over on-cluster (competes for scarce RAM and dies with the node it observes) and managed SaaS (self-hosted/OSS was a requirement).
- **Backend:** **OpenObserve** — single Rust binary, OTLP-native, **S3-backed** (Parquet). No ClickHouse, no Mongo. Chosen as the cheapest, lightest-ops option whose S3-only storage model fits; the OTLP-everywhere architecture keeps SigNoz/ClickStack/Grafana LGTM available as drop-in replacements if it disappoints.
- **Node:** `t4g.small` (2 GB), resized to `t4g.medium` early if memory is tight (OpenObserve's own guidance leans 4 GB). Provisioned in `infra/terraform/` mirroring the prod node's posture: own security group, own SSM-managed IAM role (no SSH), IMDSv2 required, small encrypted gp3 root volume only — data lives in S3.
- **Storage:** a dedicated S3 bucket for OpenObserve data (SSE-KMS, lifecycle expiry for retention, ~15–30 days), with a least-privilege S3 policy on the node role scoped to that bucket alone.
- **Ingress lockdown:** OpenObserve ingests OTLP on HTTP **5080** (also the UI) and gRPC **5081**; both open only to the prod node's security group plus the operator IP. The UI is never public — operator IP or SSM port-forward only.
- **Transport security:** a **private CA** — generated once, stored in SOPS, server cert laid down via cloud-init; the prod Collector's OTLP exporter trusts it via `tls.ca_file`. (cert-manager does not apply here: it lives on the prod k3s cluster and the monitoring node is bare EC2 running a systemd/compose container.) Root-user credentials are seeded from a SOPS secret.
- **Accepted limitation:** OSS OpenObserve has no SSO/RBAC (enterprise-gated) — acceptable for a single operator behind the security group; revisit if teammates need the UI.

## Collection: OTel Collector on the prod cluster

A Collector DaemonSet on the prod cluster gathers everything and ships OTLP to the monitoring node:

- **Logs:** `filelog` receiver over `/var/log/pods` (container logs, including the app's stdout) plus `k8s_events` — logs survive pod and node churn, closing the top gap.
- **Host and cluster metrics:** `hostmetrics` and `kubeletstats`/cAdvisor — prod-node CPU, memory, and disk saturation matter on a 4 GB / 20 GB box.
- **Datastores:** Postgres and Redis receivers — connections, locks, slow queries; memory, evictions.
- **Certificate expiry:** a `prometheus` receiver scraping cert-manager's own metrics (`certmanager_certificate_expiration_timestamp_seconds`) — no other receiver surfaces it.

## Application instrumentation

- **Tracing/metrics SDK:** `@opentelemetry/sdk-node` auto-instrumentation at the single `server/index.js` entrypoint covering http, Express, pg, and ioredis. The server is **CommonJS and stays that way** — CJS is where OTel's `require`-hook instrumentation just works; any future ESM migration must carry the loader-hook change with it.
- **Manual spans** cover what lives outside the Express request lifecycle: the WebSocket/Yjs collaboration path (Redis pub/sub, markdown sync) and the MCP subsystem.
- **Structured logging:** a central **pino** logger emitting JSON with trace/span IDs, installed behind a `console` shim so the ~382 existing call sites need no rewrite; every log line correlates to its trace.
- **App metrics:** request rate/latency/5xx, the rate-limit 429 counter (previously silent), and PG pool gauges.
- **Redundancy:** the existing exception-email notifier stays as an independent channel.

## Privacy invariant

**Document content never enters telemetry.** Logs, span attributes, and metrics labels may carry identifiers (document GUIDs, user IDs, route templates) but never document text, titles, search queries, or chat content. Telemetry lands in a third store (the o11y S3 bucket) with weaker access semantics than the database — the instrumentation layer enforces this boundary, and reviews treat a violation as a trust-invariant break, not a style issue.

## Alerting and dashboards

- **Independent-path alarms (CloudWatch → SNS → email):** CloudFront `5xxErrorRate` and `Requests` anomaly alarms, plus an external `/ready` synthetic via a **Route 53 health check** (HTTPS + string match — chosen over a Synthetics canary on cost, ~$1.50/mo vs ~$5–10/mo) feeding the same SNS path as the existing backup-freshness alarm. These live outside the o11y stack so they still fire when the o11y stack itself is down.
- **In-stack alerts (OpenObserve):** app error rate, `/ready` failure, node CPU/memory/disk saturation, Postgres and Redis health, certificate expiry.
- **Dashboards:** golden signals (rate, errors, duration, saturation) for the app; node, Postgres, and Redis panels; a few SLO-based alerts once baselines exist.

## Cost envelope

Monitoring node ~$12–24/month (`t4g.small`–`medium`) plus a small gp3 root volume and a few dollars of S3 with lifecycle expiry. Confirmed against actuals after the first week of beta data; the S3 lifecycle is the tuning knob.

## Verification posture

The build is verified by proving each signal path end to end: killing a prod pod and finding its prior logs still queryable (durable logging), matching `kubectl top` against the node dashboard (metrics), following one request as a correlated HTTP→PG→Redis trace with matching structured log lines (instrumentation), and tripping each alarm synthetically (alerting).