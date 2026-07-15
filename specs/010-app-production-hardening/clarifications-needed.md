# Clarifications Ledger — 010-app-production-hardening

Decisions the design document (`design/infrastructure-and-environments.md`, "Application hardening posture") leaves open, resolved with best defaults per Constitution Principle VI. Sam pre-authorized default ratification for this pipeline run (2026-07-15); nothing here was decided silently. Each entry can be overturned by amending the answer and re-converging.

---

## RD-1 — Rate-limit default values **RATIFIED-BY-DEFAULT (Sam pre-authorized, 2026-07-15)**

- **Question**: The design mandates per-IP limits on unauthenticated routes and per-user limits on expensive routes, but gives no numbers. What are the defaults?
- **Why it needs an answer**: Limits too tight break legitimate agents and shared-NAT users; too loose and the feature is theater. Implementers need concrete values to test against.
- **Default chosen** (all env-overridable, all sized with generous headroom over legitimate use):
  - Per-IP, unauthenticated: `/auth/*` 30/min; `/mcp/auth/token` 30/min; dynamic registration (`/mcp/auth/register` + auto-registration on unknown `client_id`, one shared budget) 5/hour.
  - Per-user, authenticated: content search 30/min; markdown import 10/min; document export 20/min; chat 30/min (on top of the existing concurrent-stream cap and AI quota).
- **Rationale**: An interactive user or a well-behaved agent stays far under these; a scanner or a tight loop trips them within seconds. Env overrides mean tuning is an ops action, not a code change. Real traffic data (once observed) should recalibrate; the spec requires configurability precisely so this ratification is cheap to revisit.

## RD-2 — Dynamic client registration stays open but bounded **RATIFIED-BY-DEFAULT (Sam pre-authorized, 2026-07-15)**

- **Question**: Should unbounded anonymous registration be fixed by (a) requiring authentication to register, or (b) keeping RFC 7591 open registration but bounding it?
- **Why it needs an answer**: Requiring auth would break the standard MCP client onboarding chain (discovery → dynamic registration → authorize), which is a product-critical flow ("bring your own agent").
- **Default chosen**: (b) — keep registration anonymous, add a per-IP budget (5/hour, shared with the auto-registration path) plus a global cap on new anonymous registrations per day (default 200). Over-budget requests get the uniform 429 and create no row.
- **Rationale**: Preserves the standards-compliant onboarding funnel while capping worst-case store growth at a known daily ceiling. The global cap is a backstop against distributed registration floods that per-IP budgets can't see.

## RD-3 — Limiter behavior when Redis is unavailable **RATIFIED-BY-DEFAULT (Sam pre-authorized, 2026-07-15)**

- **Question**: When the shared limit store is down, does limiting fail open (no limits), fail closed (reject everything), or degrade?
- **Why it needs an answer**: Fail-closed turns a cache outage into a total outage; fail-open silently removes protection exactly when the system is already stressed.
- **Default chosen**: Degrade to per-process in-memory enforcement of the same budgets (e.g. the library's insurance limiter). Never crash; never reject all traffic; never run fully unlimited.
- **Rationale**: Matches the design's explicit "Redis unavailability degrades gracefully… never crashes the process." Per-process budgets across 2 replicas at most double the effective limit during the outage — an acceptable, bounded weakening.

## RD-4 — `/ready` gates on Postgres only; Redis is reported, not gating **RATIFIED-BY-DEFAULT (Sam pre-authorized, 2026-07-15)**

- **Question**: The design says `/ready` "reports Postgres reachability and Redis state, so a pod with a dead dependency stops taking traffic." Does a dead Redis make a pod not-ready?
- **Why it needs an answer**: Redis is shared by both replicas. If Redis-down means not-ready, a cache outage removes *every* pod from rotation simultaneously — converting a degraded-mode outage (the app already feature-gates Redis) into a total one.
- **Default chosen**: Postgres unreachable → 503 not-ready. Redis state is included in the response body for observability but does not gate readiness.
- **Rationale**: The design elsewhere mandates that Redis unavailability "degrades gracefully… never crashes the process"; gating readiness on it would contradict that stronger, more specific statement. The reported-not-gating reading satisfies both sentences.

## RD-5 — Trusted proxy hop count: env-configured numeric, default 1; production value 2 **RATIFIED-BY-DEFAULT (Sam pre-authorized, 2026-07-15)**

- **Question**: The design says "the real hop count, not blanket-true." What is the real hop count, and how is it configured?
- **Why it needs an answer**: The count differs by environment: production at cutover is client → CloudFront → Traefik → app (2 trusted hops appending to `X-Forwarded-For`); Minikube dev is effectively direct or single-hop. A wrong count either re-enables spoofing (too high) or rate-limits the edge's IP as if it were every client (too low).
- **Default chosen**: `TRUST_PROXY_HOPS` environment variable parsed as a number; default `1` when unset (safe for single-ingress and dev tunnels — never blanket-true). Production deployment (feature 011 / deploy config) sets `2` for the CloudFront + Traefik chain, and must revisit if the edge chain changes.
- **Rationale**: A numeric hop count is Express's supported spoof-proof form; making it env-sourced keeps one binary correct across dev/prod topologies. Default 1 is the conservative floor: it trusts only the immediate ingress.

## RD-6 — Chat inline body limit default: 10MB **RATIFIED-BY-DEFAULT (Sam pre-authorized, 2026-07-15)**

- **Question**: The design says the chat body limit is "small" once attachments move to the S3 path. How small?
- **Why it needs an answer**: The body still carries full conversation history (text, tool outputs, compaction summaries); too small breaks long conversations, too large keeps a memory-exhaustion window open.
- **Default chosen**: 10MB (env-overridable). Attachments over the S3 path; bodies over the limit get 413 with guidance.
- **Rationale**: 15x reduction from 150MB while leaving enormous headroom over realistic text-only conversation history (megabytes of text is hundreds of thousands of tokens — the model's context compacts long before that). Env override covers surprises without a deploy-blocking code change.

## RD-7 — Postgres pool defaults: max 20, acquisition timeout 5s, statement timeout 30s **RATIFIED-BY-DEFAULT (Sam pre-authorized, 2026-07-15)**

- **Question**: The design mandates "an explicit max, a connection timeout, and a server-side statement timeout" with no numbers.
- **Why it needs an answer**: Too-low max throttles the app; too-high overwhelms the single in-cluster Postgres (2 replicas share it). Too-short statement timeout kills legitimate heavy operations (large exports, cold hybrid search).
- **Default chosen** (each env-overridable): pool `max` 20 per process, connection-acquisition timeout 5000ms, server-side `statement_timeout` 30000ms applied to the app's pool sessions. Migration job and backup tooling (separate processes) unaffected.
- **Rationale**: 2 replicas × 20 = 40 connections, comfortably under stock Postgres `max_connections` (100) with room for migrations/ops. 5s acquisition failure beats an unbounded queue during pool starvation. 30s per-statement is far above any observed legitimate query while guaranteeing pool self-recovery. If a legitimate operation is found to exceed 30s, raise the env value and record it.

## RD-8 — Shutdown deadline default: 20s, env-overridable **RATIFIED-BY-DEFAULT (Sam pre-authorized, 2026-07-15)**

- **Question**: How long may graceful shutdown take before force-exit?
- **Why it needs an answer**: It must fit under the orchestrator's `terminationGracePeriodSeconds` (currently the 30s default) or Kubernetes SIGKILLs the process mid-flush — recreating the exact data loss this feature exists to prevent.
- **Default chosen**: 20000ms overall deadline (env-overridable), force `process.exit` at the deadline. SIGINT shares the same path and deadline.
- **Rationale**: 10s of margin under the 30s grace period absorbs orchestrator jitter. Flushing pending Yjs writes for realistically-many open documents is sub-second work; 20s is a generous ceiling, and the force-exit guarantees deploys never hang.

## RD-9 — Composition with the 008/009 login-flow budgets **RATIFIED-BY-DEFAULT (Sam pre-authorized, 2026-07-15)**

- **Question**: Features 008/009 (merged on another line; not present in this worktree at d20917e) introduced their own shared rate budgets for the login pairing flow (`login` tool, `/api/login/*`, claim URLs). Does feature 010's limiter also cover those routes?
- **Why it needs an answer**: Double-limiting the same requests from two systems produces confusing, order-dependent 429s and breaks 009's "same budgets, not fresh per-route budgets" contract.
- **Default chosen**: No overlap. The flow-specific budgets from 008/009 remain authoritative for the login pairing surface wherever that code exists at merge time. Feature 010 limits exactly the routes named in FR-005/FR-006 (`/auth/*`, `/mcp/auth/token`, dynamic registration, and the expensive authenticated routes). If the merge queue surfaces a route claimed by both, the flow-specific budget wins and 010's middleware skips it.
- **Rationale**: 009's design contract ("identical limits drawn from the same budgets") is more specific ground truth for that surface; 010 is the general backstop for everything that had nothing.

## I1 — Chat-attachment identity: reference-based S3 key, NO DB row (implementation-confirmed, 2026-07-15)

- **Decision point (from analyze)**: The plan reuses the raw S3 put with ownership encoded in the S3 key and **no** DB metadata row. If implementation revealed that a metadata row / schema change was actually required, that would be a migration = **out of scope**; it was to be ledgered here (not added), keeping the reference-based approach.
- **Outcome**: The reference-based approach held. `POST /api/chat/attachments` stores bytes at `chat-attachments/<userId>/<uuid>`; the chat body carries an opaque `attachment:<key>` reference; `chat.js` resolves it only when the key's `<userId>` segment equals `req.user.userId` (user-scope enforcement). Identity is the S3 object; the resolve-time key check is the ownership guard. **No `document_images`-style metadata table, no schema change, and no node-pg-migrate migration were introduced.**
- **Consequence**: No action for the migration owner. I1 is closed as designed.
