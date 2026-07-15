# Clarifications Ledger — 011-iac-config-management

Per Constitution Principle VI: unanswered decisions get the best default, recorded
here as RATIFIED-BY-DEFAULT; material design gaps or tensions are flagged, never
resolved silently. Design ground truth: `design/infrastructure-and-environments.md`
(commit d20917e) — "Target: dedicated hardened cluster (2026-07 migration)",
"Backups & data protection", "Migration & cutover", "Observability & account
controls".

All entries below: **RATIFIED-BY-DEFAULT (Sam pre-authorized, 2026-07-15)** unless
amended in the design doc.

---

## Flagged design gaps (tensions/silences — need Sam's eyes, resolved by default)

### G1 — CloudFront-scoped 443 vs. origin TLS certificate issuance

- **Question**: The design says 443 is "ideally scoped to the CloudFront prefix
  list", and CloudFront reaches the origin `https-only` — so Traefik on the node
  must present a certificate CloudFront will accept. If that cert is ACME-issued
  (HTTP-01/TLS-ALPN against the node), scoping 443 to the CloudFront origin-facing
  prefix list (and leaving 80 closed) can break issuance/renewal. The design does
  not state how the origin cert is issued or renewed on the new node.
- **Why it matters**: Get this wrong and the origin either serves an invalid cert
  (CloudFront 502s with `https-only`) or the security group silently blocks renewal
  and the site breaks weeks after cutover.
- **Chosen default**: The scoping is a Tofu variable (`restrict_443_to_cloudfront`,
  default `true`, using the AWS-managed origin-facing prefix list as a data source).
  The runbook's parallel-validation phase explicitly verifies origin cert issuance
  and renewal path on the new node before cutover; the documented fallback is
  flipping the variable to open 443 to the world (still TLS-only) — the design
  itself grades prefix-list scoping as "ideally", not "must".
- **Rationale**: Preserves the design's preferred posture as the default while
  making the known failure mode a one-variable, plan-visible rollback instead of an
  emergency console edit. Spec: FR-003; Edge Cases.

### G2 — The aws-prod overlay depends on feature 010 app code that does not exist yet

- **Question**: The design mandates the `/ready` probe split and Redis
  `--requirepass`, but this feature adds no app code. Today `server/redis.js` reads
  only `REDIS_HOST`/`REDIS_PORT` (no password support) and only `/health` exists.
  Feature 010 owns both. In what order do 011's config and 010's code reach
  production?
- **Why it matters**: Applying the aws-prod overlay against a pre-010 image bricks
  the deployment: `/ready` 404s (pods never Ready, rollout gate fails — correctly)
  and the app cannot authenticate to Redis (collaboration sync and rate limits die).
- **Chosen default**: The overlay is written against 010's contract (probe
  `GET /ready` :3001; env var `REDIS_PASSWORD` from the `redis-auth` SOPS secret,
  optional so dev/minikube stays passwordless). The runbook gates the first
  production apply on an ECR image containing 010. The minikube overlay keeps
  `/health` and passwordless Redis, so dev never breaks regardless of ordering.
- **Rationale**: Cross-feature handoff with an explicit ordering gate beats either
  blocking this feature on 010's merge or shipping a booby-trapped overlay. The
  env var name `REDIS_PASSWORD` follows the existing `REDIS_HOST`/`REDIS_PORT`
  convention; 010 should adopt it verbatim. Spec: FR-013, FR-016, FR-024; SC-008.

### G3 — Edge/DNS topology: "repoint DNS to the Elastic IP" vs. CloudFront fronting the app

- **Question**: The design's cutover step says "the DNS record is repointed to the
  new node's Elastic IP", but the edge section has CloudFront + WAF fronting the
  distribution. Both can't be literally true of the same `app.squiredocs.com`
  record: either viewers hit CloudFront (record aliases the distribution and the
  *origin* reference is what repoints), or viewers hit the node directly (and
  CloudFront fronts something else). The existing distribution <cloudfront-distribution-id>'s
  actual origin/alias config is not visible from the repo.
- **Why it matters**: The Tofu edge declaration and the runbook's cutover step must
  name the exact record that moves; guessing wrong either bypasses the WAF entirely
  or repoints the wrong hostname during the maintenance window.
- **Chosen default**: Target topology: viewer → `app.squiredocs.com` (Route53 alias
  to the CloudFront distribution) → CloudFront (WAF attached, `https-only`) →
  origin hostname `origin.app.squiredocs.com` (A record, TTL 60, → Elastic IP).
  Cutover "repoints DNS" by updating the origin A record to the new node's EIP;
  rollback is the same record back. If the imported distribution's real
  origin/alias layout differs, the import wins: the declaration is reconciled to
  reality at import time and the runbook names whichever record actually moves,
  with the design doc amended to match.
- **Rationale**: This is the only reading that keeps every design requirement
  simultaneously true (WAF always in path, low-TTL cutover, EIP repoint,
  distribution imported not recreated), and it makes cutover a single-record
  change. Spec: FR-006, FR-024; Edge Cases.

---

## Ratified-by-default decisions

### RD-1 — Operator CIDR for 22/6443

- **Question**: Which CIDR may reach SSH and the k3s API?
- **Default**: A required Tofu variable `operator_cidr` with **no default** and a
  validation rule rejecting `0.0.0.0/0` (and `::/0`). The ops track supplies Sam's
  real CIDR at plan/apply time (tfvars, never committed).
- **Rationale**: The agent cannot know Sam's network; a guessed default would be
  either wrong or dangerously wide. Failing at plan time until the value is
  supplied is the safe behavior the design's "never 0.0.0.0/0" demands.

### RD-2 — Instance type and volume sizes

- **Question**: What node size backs the dedicated cluster?
- **Default**: `t4g.medium` (2 vCPU / 4 GiB, arm64 Graviton), gp3 encrypted volumes:
  20 GiB root + 30 GiB data. All three are variables with these defaults.
- **Rationale**: The image pipeline already builds `linux/arm64`. Squire's steady
  state (2 app replicas at 512Mi request/1Gi limit + postgres 2Gi limit + redis
  256Mi + k3s overhead) does not fit 2 GiB comfortably; 4 GiB burstable is the
  smallest safe class for a beta whose availability trade-off is already "single
  node". Sizes are variables so a resize is a plan, not a rewrite.

### RD-3 — KMS key strategy

- **Question**: Which key(s) encrypt the EBS volumes and the backup bucket?
- **Default**: One customer-managed KMS key (alias `alias/squiredocs`), annual
  rotation enabled, declared in Tofu, used for both EBS volumes and the backup
  bucket's SSE-KMS. Account-level EBS default encryption is pointed at it.
- **Rationale**: A CMK (vs. AWS-managed keys) gives the audit/control story the
  design's enterprise-review framing wants, at $1/month; a single key keeps the
  policy surface reviewable at this scale. Splitting per-service keys is a later
  refinement, not a beta need.

### RD-4 — WAF managed rule sets and rate rule

- **Question**: Which WAF rules front the distribution?
- **Default**: `AWSManagedRulesCommonRuleSet` (with `SizeRestrictions_BODY`
  overridden to count — document import/export and chat bodies legitimately exceed
  the 8 KB inspection default), `AWSManagedRulesKnownBadInputsRuleSet`,
  `AWSManagedRulesAmazonIpReputationList`, plus one rate-based rule: 2000
  requests/5 min per IP, block. CloudWatch metrics enabled on all.
- **Rationale**: The standard three managed sets cover the design's "managed rule
  sets" with near-zero false-positive risk once the body-size rule (the one known
  collision with Squire's real traffic) is neutralized; the rate rule matches the
  design's "rate rules" as a backstop above the app's own Redis-backed limits.

### RD-5 — Backup lifecycle, retention, and Object Lock mode

- **Question**: How long do backups live, and how immutable are they?
- **Default**: Object Lock in **governance** mode, 30-day default retention;
  lifecycle: transition to Glacier Instant Retrieval at 30 days, expire (current
  and noncurrent versions) at 365 days. Versioning on (Object Lock requires it).
- **Rationale**: Governance mode gives the ransomware/oops immutability window
  while staying recoverable with elevated permissions — compliance mode would make
  a misconfigured upload a 30-day irreversible cost with no upside for a solo
  operator. 30d hot / 365d total bounds cost while comfortably covering the
  design's retention-plus-Glacier requirement.

### RD-6 — Backup failure alerting mechanism

- **Question**: The design says the backup "alerts on failure" — via what, given
  the job runs inside k3s where AWS can't see it and this feature adds no app code?
- **Default**: A freshness (dead-man) alarm declared in Tofu: S3 request metrics
  enabled on `squiredocs-db-backups`, a CloudWatch alarm firing when no `PutRequests`
  are observed in 26 hours, notifying an SNS topic with an email subscription
  (operator address supplied as a variable).
- **Rationale**: Freshness-based alerting catches every failure class (job never
  ran, ran and crashed, uploaded nothing) with zero code in the cluster; 26h gives
  the nightly schedule slack. Costs pennies; entirely declarative.

### RD-7 — OpenTofu state backend bootstrap

- **Question**: Where does Tofu state live, and who creates the bucket it can't
  create for itself?
- **Default**: Bucket `squiredocs-tofu-state` (us-east-1, versioned, SSE, public
  access blocked), backend configured with native lockfile locking
  (`use_lockfile = true`, no DynamoDB table). The bucket is created by a one-time
  documented bootstrap step in the runbook (ops track), not managed by the state
  it stores.
- **Rationale**: Matches the design's "versioned, encrypted S3 backend using
  native locking" verbatim; the manual bootstrap is the standard resolution of the
  chicken-and-egg and is a single idempotent step.

### RD-8 — Pod Security Standards levels per environment

- **Question**: The design says the namespace enforces PSS — at what level, and
  does that apply to Minikube where the `app-dev` pod (root, sleeps forever,
  mutagen-synced repo) lives?
- **Default**: aws-prod: `enforce=restricted` (+ audit/warn at restricted).
  Minikube: `warn=baseline` only, no enforcement — the app-dev workload is
  dev-only tooling and exempting dev from enforcement keeps the "dev environment
  behaviorally unchanged" requirement true.
- **Rationale**: The design's hardening posture is about the production cluster;
  enforcing `restricted` in Minikube would evict the dev pod this project runs on
  (including the agent writing this).

### RD-9 — Backup tooling image

- **Question**: What "pinned image with tooling baked in" runs the backup?
- **Default**: A dedicated `Dockerfile.backup` in the repo: `alpine` pinned by
  digest, `postgresql16-client` + `s3cmd` installed at build time, non-root user,
  the backup script copied in. Built and pushed to ECR by the ops track alongside
  the app image; referenced by digest in the CronJob.
- **Rationale**: Keeps s3cmd (the config secret already exists in s3cmd format —
  smallest credential-handling change) while eliminating runtime `apk add`, root,
  and the app-image dependency. A second small Dockerfile is cheaper than bloating
  the app image with postgres client tools.

### RD-10 — Image digest pinning mechanics for the app image

- **Question**: The design pins images by digest, but the app image changes every
  deploy — how does a moving image stay digest-pinned?
- **Default**: Third-party images (postgres, redis, backup) are digest-pinned
  statically in the aws-prod overlay. The app image is digest-pinned dynamically:
  `deploy-aws.sh` pushes the SHA-tagged image, resolves its digest from ECR
  (`aws ecr describe-images`), and sets `repo@digest` via the Kustomize image
  override; if the digest cannot be resolved the deploy fails before applying.
- **Rationale**: Gives immutable-reference semantics for every container while
  keeping the existing SHA-tag build flow; no mutable-tag fallback path exists.

### RD-11 — Legacy GKE-era artifacts

- **Question**: What happens to `k8s/ingress.yaml` (GKE ManagedCertificates,
  BackendConfig) and `script/deploy.sh` (GKE/minikube deployer)?
- **Default**: Left in place, untouched, excluded from the Kustomize tree.
  Deletion is deferred to a cleanup pass Sam ratifies explicitly.
- **Rationale**: They are dead weight, not hazards; deleting them silently inside
  an infra feature widens the blast radius for zero design-doc requirement.

### RD-12 — Redis memory bound

- **Question**: What `--maxmemory` value under `allkeys-lru`?
- **Default**: `--maxmemory 192mb` with `--maxmemory-policy allkeys-lru`, inside
  the existing 256Mi container limit.
- **Rationale**: 75% of the container limit is the standard headroom for Redis
  overhead/fragmentation so the kernel OOM-killer never races the eviction policy.
  Note: `allkeys-lru` is the design's explicit choice and can theoretically evict
  rate-limit/pub-sub bookkeeping under pressure — followed as written; flag only
  if 010's rate-limiter proves sensitive.

### RD-13 — age key management

- **Question**: Who holds which age keys for SOPS?
- **Default**: One operator age keypair generated by the ops track (private key in
  the operator's standard sops-age location, never committed); its public recipient
  in `.sops.yaml`. A second break-glass recipient may be added later by re-keying
  (`sops updatekeys`); not created by default.
- **Rationale**: Solo-operator project — a single recipient matches reality; the
  ledger records the re-key path so key loss/rotation has a documented answer.

### RD-14 — DNS TTLs

- **Question**: What is "a low TTL" concretely?
- **Default**: TTL 60 seconds on the cutover-relevant record(s) (`app.squiredocs.com`
  and, per G3's topology, the origin A record), declared in Tofu permanently (not
  just for the window).
- **Rationale**: 60s makes both cutover and rollback sub-minute-propagation events;
  the query-cost delta at Squire's traffic is negligible, so there is no reason to
  raise it again after the migration.
