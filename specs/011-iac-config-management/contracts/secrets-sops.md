# Contract — SOPS/age secrets (`.sops.yaml` + `k8s/secrets/*.enc.yaml`)

**Consumers**: ops track (decrypt-and-apply), Kustomize overlays (reference secret names). **Verification**: SOPS metadata presence + zero-plaintext review (SC-005).

## Interface

- `.sops.yaml` defines age recipient(s) (RD-13) and a creation rule matching `k8s/secrets/*.enc.yaml` with `encrypted_regex` scoped to `data`/`stringData` (keys stay readable, values encrypted).
- Documented flows (FR-019): (a) encrypt a new value; (b) decrypt-and-apply to a cluster (`sops -d … | kubectl apply -f -`); (c) placeholder pattern for secrets whose live values only the ops track holds.

## Guarantees

1. Every committed file under `k8s/secrets/` carries SOPS metadata (`sops:` block present) and exposes **no** plaintext secret value. (SC-005)
2. The secret surface is covered: `postgres-secret`, `mcp-auth-secret`, `ses-secret`, `s3-images-secret`, `auth-secret` (from `auth.production.env`), plus new `redis-auth`, plus `backup-s3cmd` — each an encrypted file or a documented encrypted placeholder.
3. The s3cmd backup credentials move from the gitignored plaintext ConfigMap (`k8s/s3cmd-configmap.yaml`, live keys) to `backup-s3cmd.enc.yaml` consumed by the backup CronJob (FR-018). Runbook §2.5/§5.4 rotates to the scoped backup-writer key and deactivates the old broadly-scoped key.
4. No new plaintext secret value is added to version control by this feature. Legacy gitignored plaintext files remain the ops track's local encryption source and are never committed.

## Non-goals
Generating real live secret values (ops track holds them); committing the age private key.
