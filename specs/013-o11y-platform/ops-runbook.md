---
squire:
  docGuid: a60195d0-4c02-4581-b254-ee2853fd12bb
  title: Ops runbook — 013-o11y-platform (post-merge execution)
  clock: 1
  exportedAt: 2026-07-16T22:43:22Z
  lastModifiedBy: admin@example.com
  flavor: portable
---

# Ops runbook — 013-o11y-platform (post-merge execution)

Everything the ops track (Sam / orchestrator, holding AWS creds + the age private key) executes to bring the observability platform live. **Authoring applied nothing to AWS** (FR-029). The `docs/operations.md` observability rewrite is a separate merge-queue task (T041 / FR-030); this runbook is the in-feature source it links.

Order: **secrets → tofu apply → node cert/cred placement → cluster apply → dashboards → verification**.

> **Status 2026-07-16 (orchestrator prep):** §1 is DONE except the server cert — the private CA, server key, and OpenObserve root creds are generated and live SOPS-encrypted in the two `k8s/secrets/*.enc.yaml` files, and the public CA cert is in `ca-trust-configmap.yaml`. After `tofu apply` (§2), run `script/finalize-o11y-cert.sh <monitoring_private_ip> <prod_node_private_ip>` — it issues the server cert into the SOPS secret AND fills all three RD-13 IP placeholders (§3's substitutions). Remaining manual §3 work: laying the material onto the node via SSM.

---

## 1. Generate secrets (CA, server cert, OpenObserve root creds)

Private CA + monitoring-node server cert (RD-12; cert-manager is NOT used here). Do this once; record expiry dates (CA ~10y, server ~2–3y) and a calendar reminder — the in-stack cert-expiry alert watches cert-manager, not this CA.

```bash
# --- Private CA (EC P-256, ~10y) ---
openssl ecparam -name prime256v1 -genkey -noout -out ca.key
openssl req -x509 -new -key ca.key -sha256 -days 3650 \
  -subj "/CN=squiredocs-o11y-ca" -out ca.crt

# --- Server cert for the monitoring node (~2.5y) ---
# SANs MUST cover the exporter target: the internal DNS name AND the node private IP
# (RD-13). Fill NODE_PRIVATE_IP from `tofu output monitoring_private_ip` AFTER step 2
# (the node must exist first) — so this cert step is split: generate the key now,
# finalize the cert once the IP is known, then restart the node's service.
NODE_PRIVATE_IP="<tofu output monitoring_private_ip>"
openssl ecparam -name prime256v1 -genkey -noout -out server.key
cat > san.cnf <<EOF
[req]
distinguished_name = dn
[dn]
[v3]
subjectAltName = DNS:o11y.squiredocs.internal,IP:${NODE_PRIVATE_IP}
EOF
openssl req -new -key server.key -subj "/CN=o11y.squiredocs.internal" -out server.csr
openssl x509 -req -in server.csr -CA ca.crt -CAkey ca.key -CAcreateserial \
  -days 900 -sha256 -extfile san.cnf -extensions v3 -out server.crt

# --- OpenObserve root credentials ---
OO_ROOT_EMAIL="ops@squiredocs.com"
OO_ROOT_PASS="$(openssl rand -base64 24)"
```

Store the private material SOPS-encrypted (never plaintext in git, SC-004):

```bash
# Paste real values into the scaffolds, then encrypt in place (matches .sops.yaml):
#   k8s/secrets/o11y-tls.enc.yaml         ca.key / server.key / server.crt
#   k8s/secrets/openobserve-root.enc.yaml ZO_ROOT_USER_EMAIL / ZO_ROOT_USER_PASSWORD
sops -e -i k8s/secrets/o11y-tls.enc.yaml
sops -e -i k8s/secrets/openobserve-root.enc.yaml
# Public CA cert is NOT secret — paste it into k8s/o11y/ca-trust-configmap.yaml (ca.crt).
```

## 2. Digest-pin images, then `tofu apply`

```bash
# Resolve the real arm64 digests (dev pod cannot):
docker buildx imagetools inspect otel/opentelemetry-collector-contrib:0.116.0
docker buildx imagetools inspect public.ecr.aws/zinclabs/openobserve:v0.14.4
# Replace: the placeholder digest in k8s/o11y/kustomization.yaml (images:) and the
# tags in var.otel_collector_image / var.openobserve_image (tfvars).
```

Confirm the OpenObserve `ZO_*` env-var names against the pinned version's docs (`openobserve/openobserve.env`) — versions rename config vars, and a mismatch silently disables S3/TLS/retention. Confirm the image registry (public vs ECR): if ECR-mirrored, add `AmazonEC2ContainerRegistryReadOnly` to `aws_iam_role.monitoring` (monitoring_iam.tf note).

```bash
cd infra/terraform
tofu plan   # review: monitoring node, SG, IAM, OO bucket, 3 alarms — no destructive diffs
tofu apply
tofu output monitoring_private_ip   # feeds the cert SAN (step 1) + the placeholders below
```

## 3. Place cert/creds on the node + finalize the exporter target

The node boots with the committed unit/env; the TLS-enabled service crash-loops (`Restart=on-failure`) until the ops track places the material — then it self-heals.

```bash
# Via SSM Session Manager to the monitoring instance (monitoring_instance_id):
#   /etc/openobserve/tls/server.crt   (0644)   from o11y-tls.enc.yaml
#   /etc/openobserve/tls/server.key   (0600)   from o11y-tls.enc.yaml
#   /etc/openobserve/openobserve-root.env       ZO_ROOT_USER_EMAIL/PASSWORD from SOPS
# then:
systemctl restart openobserve
```

Fill the **monitoring node** private IP (`tofu output monitoring_private_ip`) into the two RD-13 placeholders — same sed-style substitution in both:

- `k8s/o11y/collector-daemonset.yaml` → `hostAliases[0].ip` (placeholder `10.0.0.2`)
- `k8s/o11y/networkpolicies.yaml` → `allow-collector-to-monitoring-node` egress `ipBlock.cidr` (`/32`, placeholder `10.0.0.2/32`)

In the **same step**, fill the **prod node** private IP (the k3s node — e.g. `kubectl get node -o wide`, INTERNAL-IP) into the kubelet/API-server egress placeholder (RD-13 style; on single-node k3s the kubelet at :10250 and the API server at :6443 share the node IP):

- `k8s/o11y/networkpolicies.yaml` → `allow-collector-to-node-kubelet-and-apiserver` egress `ipBlock.cidr` (`/32`, placeholder `10.0.0.3/32`)

WITHOUT this last substitution the kubeletstats and k8s_events receivers are silently blocked by default-deny egress (no scrape, no events, no error surfaced) — see the §6 verification line.

## 4. Cluster apply (Collector + policies + secrets)

```bash
# Materialize the datastore secrets into o11y (G3 — Collector receivers read them
# via secretKeyRef; they exist only in collab today). Same values, second namespace:
for s in postgres-secret redis-auth; do
  sops -d k8s/secrets/$s.enc.yaml | sed 's/namespace: collab/namespace: o11y/' | kubectl apply -f -
done
# Paste the public CA cert into k8s/o11y/ca-trust-configmap.yaml (step 1), then:
kubectl apply -k k8s/overlays/aws-prod    # renders + applies the o11y namespace, Collector, policies
```

## 5. Provision dashboards + alerts

Follow `k8s/o11y-dashboards/README.md` (curl import; create the `ops-email` alert destination first). Before the first import, confirm BOTH the dashboard and alert API routes against the pinned OpenObserve version (the dashboard POST creates a NEW dashboard each call, so the import is list-then-create-or-update-by-id; the flat alert `PUT /api/{org}/alerts/{name}` route may be stream-scoped on the pinned image). **Routes confirmed against v0.14.4 (2026-07-16):** dashboards update by `PUT /api/{org}/dashboards/{id}?hash={hash}` (hash from GET-by-id; `owner` required in payload); alerts are stream-in-path `POST /api/{org}/{stream_name}/alerts?type=metrics` (flat route 404s); email destinations need the recipient as an org member and a template first; thresholds are integers; metrics are one stream per metric (dots→underscores). Full detail: `k8s/o11y-dashboards/README.md`. Executed 2026-07-16: 4 dashboards + 4 infra alerts live; `app-error-rate` + `ready-failure` pend the app deploy (stream `http_server_request_count`). Confirm `var.ready_health_check_search_string` against the LIVE `/ready` body before trusting the Route 53 alarm (RD-7). Note the Route 53 check targets the CloudFront viewer alias `squiredocs.com` (NOT the origin record `app.squiredocs.com`, whose 443 is prefix-list-scoped and would block the checkers).

## 6. Verification posture (design's post-apply acceptance, SC-008)

- **Log durability**: `kubectl delete pod <collab-app pod>`; after restart, query the killed pod's PRIOR logs in OpenObserve — they persist (the top gap closed).
- **Metrics cross-check**: `kubectl top nodes/pods` vs. the node/pod dashboards.
- **kubelet + API-server receivers reachable**: collector logs show kubeletstats scrape SUCCESS and k8s_events FLOWING (absence = the `allow-collector-to-node-kubelet-and- apiserver` egress placeholder was never filled with the real prod node IP, so those two receiver classes are silently blocked by default-deny egress).
- **Alarm trips (each → SNS email)**: force a 5xx burst (CloudFront 5xx alarm); simulate a `/ready` failure (Route 53 health check → alarm); the Requests anomaly alarm needs a training window — expect it uninformative for the first days.
- **Storage**: confirm OpenObserve writes Parquet to `squiredocs-openobserve`.
- **Ingress lockdown**: confirm 5080/5081 are unreachable from outside the prod node SG + operator CIDR. The monitoring node has a PUBLIC IP for egress only (`associate_public_ip_address = true`, RD-15) — verify it admits NOTHING inbound beyond the SG rules (public-IP-with-locked-SG, chosen over NAT on cost).
- **Cost**: after the first week, check against ~$12–24 + S3; tune `o11y_retention_days`.

## 7. Ongoing

- **Week-one memory watch**: watch the `t4g.small` (2 GB) node memory; take the pre-ratified `t4g.medium` resize (`var.o11y_instance_type`) early if tight (RD-10). The unit's `MemoryMax=1536M` makes OOM a container restart, not a wedged node.
- **Config-update path (cloud-init is first-boot only)**: OpenObserve version/config changes are immutable-style — either replace the node (`tofu taint aws_instance. monitoring && tofu apply`, which renders the CURRENT template) or edit `/etc/openobserve/*` in place via SSM and back-port the change to the committed `openobserve/` files + tftpl (mirrors compute.tf's `ignore_changes = [user_data]` posture). Never let the launched user_data and the committed template silently diverge without back-porting.
- **Follow-up (G3)**: swap the Postgres receiver's `postgres-secret` creds for a least-privilege `pg_monitor` role once a db-change vehicle exists.