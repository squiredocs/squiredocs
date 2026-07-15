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

## Secret-name contract (T006 — shared by base/overlays and `k8s/secrets/`)

The following Secret object names are fixed and referenced identically by the
Kustomize manifests (`valueFrom.secretKeyRef.name`, CronJob volume) and by the
`k8s/secrets/*.enc.yaml` files. Changing a name requires changing both sides.

| Secret name (`metadata.name`) | File | Consumed by | Keys |
|-------------------------------|------|-------------|------|
| `postgres-secret` | `postgres-secret.enc.yaml` | app, migrate Job, postgres, backup CronJob | `username`, `password` |
| `mcp-auth-secret` | `mcp-auth-secret.enc.yaml` | app | `MCP_JWT_SECRET`, `MCP_REFRESH_SECRET`, `MCP_AUTH_CODE_SECRET` |
| `ses-secret` | `ses-secret.enc.yaml` | app, app-dev | `SES_SMTP_USER`, `SES_SMTP_PASS`, `SES_FROM_EMAIL`, `ADMIN_EMAIL` |
| `s3-images-secret` | `s3-images-secret.enc.yaml` | app, app-dev (optional refs) | `S3_IMAGE_BUCKET`, `S3_IMAGE_REGION`, `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY` |
| `auth-secret` | `auth-secret.enc.yaml` | app | `GOOGLE_CLIENT_ID/SECRET/REDIRECT_URI`, `ACCESS_TOKEN_SECRET`, `REFRESH_TOKEN_SECRET`, `CLIENT_URL`, `GOOGLE_GENERATIVE_AI_API_KEY`, `ANTHROPIC_API_KEY`, `API_KEY_ENCRYPTION_KEY` |
| `redis-auth` (NEW) | `redis-auth.enc.yaml` | redis (`--requirepass`), app (`REDIS_PASSWORD`, optional) | `REDIS_PASSWORD` |
| `backup-s3cmd` (NEW) | `backup-s3cmd.enc.yaml` | backup CronJob (s3cmd config mount) | `s3cfg` |

## Operator flows (FR-019)

All commands run from the repo root so `.sops.yaml` (creation rule +
`encrypted_regex`) is picked up automatically. The operator's age private key
lives at the standard location (`$SOPS_AGE_KEY_FILE` or
`~/.config/sops/age/keys.txt`).

**(0) One-time key setup (runbook §0.2)** — the committed files ship encrypted to
a THROWAWAY placeholder recipient (authoring), so the ops track must re-key first:

```
age-keygen -o ~/.config/sops/age/keys.txt         # generate the real operator key
#   put its "# public key: age1..." into .sops.yaml (replace the placeholder)
```

**(a) Encrypt a new value / (re)create a secret from a gitignored source
(runbook §0.4)**:

```
# author the plaintext Secret (real values) at k8s/secrets/<name>.enc.yaml, then:
sops -e -i k8s/secrets/<name>.enc.yaml            # encrypts in place (values only)
git add k8s/secrets/<name>.enc.yaml               # commit ciphertext
```

**(b) Decrypt-and-apply to a cluster (runbook §3.2)**:

```
sops -d k8s/secrets/<name>.enc.yaml | kubectl apply -n collab -f -
```

**(c) Encrypted-placeholder pattern** — for secrets whose live values only the
ops track holds, commit a `.enc.yaml` with PLACEHOLDER values (still SOPS-
encrypted, so it carries a `sops:` block and leaks nothing). The ops track
replaces the values in §0.4. This is exactly how every file in `k8s/secrets/`
ships from this feature.

**Edit in place** (change one key): `sops k8s/secrets/<name>.enc.yaml` opens the
decrypted buffer in `$EDITOR` and re-encrypts on save.

**Re-key (break-glass, RD-13)**: add/rotate recipients in `.sops.yaml`, then
`sops updatekeys k8s/secrets/*.enc.yaml`.

## Non-goals
Generating real live secret values (ops track holds them); committing the age private key.
