# Quickstart — Verification Gate for 013-o11y-platform

This feature's "tests pass" is **NOT `npm test`** (no app code changes; the app
suites simply stay untouched and green). Verification is the authoring gate below.
End-to-end signal-path proof (SC-008) is **ops-track acceptance after apply** —
sequenced by the FR-029 docs, not part of this gate.

## Prerequisites (authoring pod)

- `tofu` and `kustomize` are present (`/usr/local/bin`). `terraform`, `kubectl`,
  `yamllint` are **absent** — use the fallback ladder for anything needing them and
  **record the degradation** in `promotion-notes.md` (inherited from feature 011).
- Work happens on `main` in the worktree; nothing is applied to AWS.

## Gate 1 — Terraform (SC-001)

```bash
cd /local-dev/infra/terraform
tofu fmt -check          # expect: 0 files need formatting
tofu validate            # expect: success, all new monitoring/alarm resources valid
```

Assert (structured review if `tofu validate` cannot fully resolve providers offline):
- monitoring node, SG, IAM, OO bucket, 3 alarms all declared;
- node ingress 100% scoped to prod SG / operator CIDR (0 world-open) — `monitoring_sg.tf`;
- node role S3 access resolves to exactly one bucket — `monitoring_iam.tf`;
- all 3 alarms' `alarm_actions` = `aws_sns_topic.backup_alarms.arn`, 0 references to
  the node/OpenObserve/Collector.

## Gate 2 — Kustomize renders (SC-002)

```bash
cd /local-dev
kustomize build k8s/overlays/aws-prod > /tmp/aws-prod.yaml   # expect: success
kustomize build k8s/overlays/minikube > /tmp/minikube.yaml   # expect: success
```

Assert:
- **aws-prod** renders the Collector DaemonSet with all **7 receiver classes**
  (`filelog`, `k8s_events`, `hostmetrics`, `kubeletstats`, `postgresql`, `redis`,
  `prometheus`) and a **TLS `otlp` exporter**; the `otel-collector` Service exposes
  4317+4318; the `o11y` namespace is `enforce=privileged`; the collab-side + o11y-side
  NetworkPolicy allowances (5 paths) are present.
- **minikube** contains **0** Collector/monitoring references and is **byte-identical**
  to its pre-feature render:

```bash
# capture a pre-feature baseline BEFORE editing minikube-adjacent files, then diff:
git stash && kustomize build k8s/overlays/minikube > /tmp/minikube-base.yaml && git stash pop
diff /tmp/minikube-base.yaml /tmp/minikube.yaml    # expect: no differences
grep -c -iE 'collector|openobserve|o11y|5081|monitoring' /tmp/minikube.yaml  # expect: 0
```

## Gate 3 — Structured config review + privacy grep

- **Config-file review** against FR-005..009 (OO unit/env/cloud-init: pinned image,
  committed unit+config, S3 backend, TLS paths, memory bound, retention ≤ lifecycle),
  FR-015..023 (Collector: receivers, offset checkpointing, exporter retry/queue, RBAC,
  intake Service, resources, PSS namespace), FR-020 (exactly 5 NetworkPolicy paths).
- **Privacy grep (SC-007, FR-027)** — 0 content-bearing telemetry fields across all
  authored config:

```bash
grep -rniE 'title|document.?text|body|content|search.?quer|chat|prompt|message.?text' \
  k8s/o11y k8s/o11y-dashboards infra/terraform/openobserve \
  | grep -viE 'contentType|# |comment|no document content|privacy'   # expect: 0 real hits
```

- **Secrets (SC-004)** — 0 plaintext secret values; every new
  `k8s/secrets/*.enc.yaml` carries SOPS metadata or is a clearly-marked scaffold:

```bash
grep -rL 'sops' k8s/secrets/openobserve-root.enc.yaml k8s/secrets/o11y-tls.enc.yaml
# any file listed must be a documented .example scaffold with NO real values
```

## Gate 4 — Dashboards/alerts accounted (SC-006)

Each of the 6 in-stack alert classes (app error rate, `/ready` failure, node
CPU/mem/disk, Postgres health, Redis health, cert expiry) and each dashboard family
(golden signals + node/PG/Redis) maps to a committed JSON in `k8s/o11y-dashboards/`
or an explicit numbered step in its `README.md` — 0 unaccounted.

## Not in this gate (ops-track acceptance, SC-008)

Killed-pod log durability, `kubectl top` vs. node dashboard, synthetic alarm trips +
email, OpenObserve Parquet writes to the bucket, OTLP-port unreachability from outside
the allowed sources, and the ~$12–24 + S3 cost check are executed by the ops track
**after apply**, sequenced by the FR-029 documentation. Record any degraded authoring
validation (tools absent) in `promotion-notes.md` so the ops track re-runs real
validators before the first apply.
