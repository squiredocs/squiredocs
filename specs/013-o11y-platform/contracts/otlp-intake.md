# Contract — In-cluster OTLP intake (the feature-014 seam)

**Owner**: 013 (this feature) provides it; **consumer**: 014 (app instrumentation).
Resolves ledger **G2**. Passive interface — 013 takes no dependency on 014's timeline.

## The contract

| Property | Value |
|---|---|
| Kubernetes Service | `otel-collector` in namespace `o11y` |
| Cluster DNS | `otel-collector.o11y.svc.cluster.local` |
| OTLP gRPC port | `4317` |
| OTLP HTTP port | `4318` |
| Transport | **plaintext** (in-cluster; TLS begins at the Collector→node hop) |
| Documented `OTEL_EXPORTER_OTLP_ENDPOINT` for 014 | `http://otel-collector.o11y.svc.cluster.local:4318` |
| gRPC alternative | `http://otel-collector.o11y.svc.cluster.local:4317` (set `OTEL_EXPORTER_OTLP_PROTOCOL=grpc`) |

## Guarantees to 014

1. The Collector accepts OTLP traces, metrics, and logs on both ports and forwards
   them to the monitoring node — **014 needs no knowledge** of OpenObserve, its
   address, or its TLS trust (FR-022).
2. The Collector is **fully functional before/without any app telemetry** — the
   intake is passive; infra signals flow regardless (FR-022, US6-3).
3. A scoped NetworkPolicy permits exactly `collab-app → o11y:otel-collector:4317/4318`
   (FR-020); no other collab pod gains Collector access.

## Requirements on 014 (informational — not implemented here)

- Set `OTEL_EXPORTER_OTLP_ENDPOINT` to the value above; do not hardcode the node.
- Honor the privacy invariant (FR-027) app-side: emit identifiers, never document
  content. (013's configs are content-free by construction; 014 owns emission.)

## Verification (013 side)

`kustomize build k8s/overlays/aws-prod` renders the `otel-collector` Service in
`o11y` with ports 4317 + 4318 and a matching `otlp` receiver in the Collector config;
the app→Collector NetworkPolicy pair exists (SC-002, FR-022).
