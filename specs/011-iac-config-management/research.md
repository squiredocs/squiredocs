# Phase 0 Research — 011-iac-config-management

All open decisions were pre-resolved in `clarifications-needed.md` (RD-1..RD-14, gaps G1–G3, per Constitution Principle VI). This file consolidates them in Decision / Rationale / Alternatives form and records the **one new finding** produced by reconciling the flagged gaps against import reality. There are **zero remaining NEEDS CLARIFICATION** markers.

## New finding — Edge topology reconciled against live import reality (G3)

- **Decision**: Manage exactly one Route53 record — `app.squiredocs.com` (origin A record, TTL 60) → the new Elastic IP. Do **not** introduce a new `origin.app.squiredocs.com` hostname. Import distribution `<cloudfront-distribution-id>` as-is (alias `squiredocs.com`, origin `app.squiredocs.com`). Cutover repoints `app.squiredocs.com`.
- **Rationale**: The live distribution already uses `app.squiredocs.com` as its origin A-record (→ `<old-node-ip>`, current EC2 IP). This makes the design doc's literal cutover wording correct and makes cutover a single-record change with the WAF permanently in path. Introducing `origin.*` would add a hostname import does not require.
- **Alternatives considered**: (a) G3's ledger default (`origin.app.squiredocs.com` as a distinct origin record) — rejected: import reality does not need it; it adds a needless record and diverges from the design doc's own wording. (b) Viewers hitting the node directly (CloudFront fronting something else) — rejected: bypasses the WAF, contradicts the design's edge section.
- **Ledger consequence (flagged, not silently fixed)**: G3's RATIFIED-BY-DEFAULT default should be reconciled to `app.squiredocs.com`. Surfaced as a **MEDIUM** in speckit-analyze for Sam to amend the ledger (and confirm no design-doc change is needed). G3's own "the import wins" escape hatch already authorizes this reconciliation.

## Consolidated ratified decisions (from the ledger)

| ID | Decision | Rationale (short) | Alternatives rejected |
|----|----------|-------------------|-----------------------|
| RD-1 | `operator_cidr` required var, no default, validation rejects `0.0.0.0/0` and `::/0` | Agent can't know Sam's network; fail-at-plan is the safe behavior the design's "never 0.0.0.0/0" demands | A guessed default (wrong or dangerously wide) |
| RD-2 | `t4g.medium` (arm64), gp3 encrypted 20 GiB root + 30 GiB data; all variables | Steady state doesn't fit 2 GiB; 4 GiB burstable is smallest safe class; sizes are variables | Smaller class (OOM risk); hard-coded sizes (resize = rewrite) |
| RD-3 | One CMK `alias/squiredocs`, annual rotation, for EBS + backup SSE-KMS | Audit/control story at $1/mo; single key keeps policy reviewable | AWS-managed keys (weaker audit); per-service keys (premature) |
| RD-4 | WAF: Common (SizeRestrictions_BODY→count), KnownBadInputs, IpReputation + rate rule 2000/5min/IP block | Standard sets, body-size override removes the one known collision with import/export/chat bodies | Default body-size (false positives); no rate rule (weaker backstop) |
| RD-5 | Object Lock **governance** mode, 30-day retention; lifecycle Glacier IR@30d, expire@365d | Ransomware/oops window but recoverable with elevated perms; bounds cost | Compliance mode (irreversible mistakes); no lock (no immutability) |
| RD-6 | Freshness (dead-man) CloudWatch alarm on `PutRequests` > 26h → SNS email | Catches every failure class with zero in-cluster code | In-cluster alerting (AWS can't see k3s job; needs app code) |
| RD-7 | State bucket `squiredocs-tofu-state`, `use_lockfile=true` (no DynamoDB), created by one-time runbook bootstrap | Matches design's "native locking" verbatim; standard chicken-and-egg resolution | DynamoDB lock table (extra resource, not native); Tofu-managing its own state bucket (impossible) |
| RD-8 | aws-prod PSS `enforce=restricted`; minikube `warn=baseline` only | Hardening targets prod; enforcing restricted in minikube evicts the dev pod | Enforce restricted everywhere (breaks dev) |
| RD-9 | Dedicated `Dockerfile.backup`: alpine@digest + pg16-client + s3cmd, non-root, script baked | Eliminates runtime `apk add`/root; keeps s3cmd (smallest credential change) | Bloat app image with pg tools; keep runtime apk add (root, slow) |
| RD-10 | Third-party images digest-pinned statically; app image digest resolved from ECR at deploy, fail if unresolvable | Immutable references for every container; keeps SHA-tag build flow; no mutable-tag fallback | Mutable tag fallback (defeats pinning) |
| RD-11 | Legacy `k8s/ingress.yaml` (GKE) + `script/deploy.sh` left untouched, excluded from Kustomize tree | Dead weight not hazards; deleting inside an infra feature widens blast radius | Delete now (no design requirement; risk) |
| RD-12 | Redis `--maxmemory 192mb --maxmemory-policy allkeys-lru` inside 256Mi limit | 75% of limit is standard headroom so OOM-killer never races eviction | Higher maxmemory (OOM race); different policy (design mandates allkeys-lru) |
| RD-13 | One operator age keypair; public recipient in `.sops.yaml`; break-glass via later `sops updatekeys` | Solo project → single recipient matches reality; re-key path documented | Multiple recipients now (premature); no documented re-key (key-loss dead end) |
| RD-14 | TTL 60s on cutover records, declared permanently | Sub-minute cutover + rollback; negligible query-cost delta | Higher TTL (slow cutover); temporary lowering (extra step) |

## Flagged gaps carried into analyze (no blockers)

- **G1 (ACME vs CloudFront-scoped 443)**: kept as recorded default — `restrict_443_to_cloudfront` variable (default `true`), documented fallback to open 443 (still TLS-only), validated pre-cutover in runbook §3.4. **MEDIUM** at most; design grades scoping "ideally", not "must".
- **G2 (feature-010 ordering)**: overlay written to 010's contract (`/ready` :3001; `REDIS_PASSWORD` from `redis-auth` SOPS secret, optional so minikube stays passwordless); runbook §3.1 gates first prod apply on a 010-containing image. External dependency, verified absent in current app code (`server/redis.js` reads only host/port; only `/health` in `server/index.js`). Not a blocker for authoring.
- **G3 (edge/DNS topology)**: reconciled to import reality (above). **MEDIUM** ledger-wording fix for Sam.

## Verification approach (Phase 0 conclusion)

Real validators (`tofu`, `kustomize`, `kubectl`, `sops`, `age`) are absent in the dev pod (confirmed 2026-07-15). This feature's tasks therefore verify via the plan's Toolchain Fallback Ladder — structured manual review — and explicitly record the degradation so the ops track re-runs `tofu validate` / `kustomize build` / `sops -d` round-trips before any apply (runbook Phase 2.1, 3.2). This is a deliberate, spec-sanctioned substitution for `npm test`, not a gap.
