# Feature Specification: Application Production Hardening

**Feature Branch**: `010-app-production-hardening`

**Created**: 2026-07-15

**Status**: Draft

**Input**: User description: "010-app-production-hardening: Application production hardening — graceful SIGTERM shutdown with WebSocket drain and Yjs flush, Redis-backed rate limiting, correct trust proxy hop count, /api/chat body bounds, /ready readiness endpoint, Redis AUTH client support, Postgres pool limits"

**Design ground truth**: `design/infrastructure-and-environments.md`, section "Application hardening posture" (committed at d20917e), with "Node & cluster hardening" and "Target: dedicated hardened cluster (2026-07 migration)" as binding context. Per Constitution Principle VI, where this spec and the design document disagree, the document wins; material gaps are ledgered in `clarifications-needed.md`, never resolved silently.

**Scope boundary**: This feature changes application code only (Node/Express server, plus the minimal client change required to move chat attachments off the inline JSON path). It adds **no Kubernetes manifests and no database migrations**. Two items terminate at an explicit cross-feature handoff to feature 011 (see "Cross-Feature Handoffs").

**Trust boundary statement (Constitution Principle V)**: This feature introduces one new unauthenticated endpoint, `GET /ready`. It accepts no input, reads no request body, and reveals only coarse dependency reachability (primary datastore reachable yes/no, cache/pub-sub state) — no versions, hostnames, credentials, or query results. Every other change *tightens* an existing trust boundary: unauthenticated routes gain per-IP limits, the anonymous dynamic-registration surface gains caps, client-supplied forwarding headers lose the ability to influence the derived client identity, and the largest unauthenticated-adjacent memory sink (the chat request body) is bounded before any parsing-dependent check runs.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - A rolling deploy never loses the tail of a document's edits (Priority: P1)

Sam deploys a new version while collaborators are actively typing. Kubernetes sends the old pods SIGTERM. Today there is no SIGTERM handler at all: the process dies immediately, in-flight Yjs updates that have not yet been persisted are lost, and connected editors lose the last seconds of their work — on **every single deploy**. After this feature, the process catches SIGTERM, stops taking new work, closes WebSocket sessions so clients reconnect to a healthy replica, flushes all in-flight document persistence, and only then exits.

**Why this priority**: This is active, recurring data loss in the product's core promise (real-time collaborative editing with full history). Every deploy is a small data-loss event today. Nothing else in this feature protects against harm that is already happening on a schedule.

**Independent Test**: With two clients editing a document, send the server process SIGTERM mid-typing. Verify the process exits cleanly within its deadline, the last edits made before the signal are present in the persisted document state after restart, and the clients reconnect and converge with no lost characters.

**Acceptance Scenarios**:

1. **Given** a document with active WebSocket editors and unpersisted in-flight Yjs updates, **When** the process receives SIGTERM, **Then** all pending document persistence is flushed to the primary datastore before the process exits, and no acknowledged edit is lost across the restart.
2. **Given** a shutdown in progress, **When** a new WebSocket upgrade or HTTP request arrives, **Then** new WebSocket upgrades are refused (so clients fail over to another replica) and the readiness signal reports not-ready, while in-flight requests are allowed to complete.
3. **Given** a shutdown where some resource hangs (a stuck connection, a wedged flush), **When** the configured shutdown deadline elapses, **Then** the process force-exits rather than hanging past the orchestrator's grace period — and the deadline is configured below that grace period.
4. **Given** the process receives SIGINT (dev workflow) instead of SIGTERM, **Then** the same drain-and-flush path runs — the two signals share one shutdown implementation.
5. **Given** a second SIGTERM/SIGINT arrives while shutdown is already in progress, **Then** it is ignored (no double-shutdown, no error).

---

### User Story 2 - Abusive or runaway clients cannot exhaust the service, and cannot dodge limits by lying about their address (Priority: P2)

An anonymous scanner hammers the login/OAuth endpoints; a buggy agent loops on dynamic client registration, creating a new registered-agent row per attempt; a single authenticated user script-loops content search or import. Today none of these are limited at all, and even if they were, `trust proxy` is blanket-true, so any client can set `X-Forwarded-For` and become a fresh "IP" at will. After this feature, unauthenticated routes carry per-IP limits and authenticated expensive routes carry per-user limits — enforced through shared state that survives restarts and spans both replicas — and the client IP used as the limit key is derived from the real, configured proxy hop count so it cannot be spoofed.

**Why this priority**: The app is multi-tenant and publicly exposed; unlimited anonymous endpoints (including one that writes unbounded rows) are the widest open abuse surface. It is P2 only because, unlike US1, the harm is potential rather than occurring on every deploy.

**Independent Test**: From one source address, exceed the per-IP budget on an unauthenticated route and verify uniform rate-limited responses with retry guidance; restart the server mid-budget and verify the budget did **not** reset; repeat the excess with a forged `X-Forwarded-For` and verify the limiter still attributes the requests to the true source; as a single authenticated user, exceed an expensive-route budget and verify limiting keyed on the user, not the IP.

**Acceptance Scenarios**:

1. **Given** an unauthenticated client, **When** its requests to the authentication routes (`/auth/*`), the OAuth token endpoint (`/mcp/auth/token`), or the dynamic registration surface exceed the per-IP budget, **Then** further requests receive HTTP 429 with a `Retry-After` header, and requests from other addresses are unaffected.
2. **Given** a rate budget partially consumed, **When** the application restarts or the request lands on the other replica, **Then** the remaining budget is unchanged — limits are backed by shared state, not per-process memory.
3. **Given** a client that sends a forged `X-Forwarded-For` chain, **When** the limiter derives its key, **Then** the derived client IP is the one at the configured trusted hop depth — the forged entries have no effect — and this is covered by an automated test.
4. **Given** the anonymous dynamic-registration surface (both `POST /mcp/auth/register` and the auto-registration path taken on an unknown `client_id` during authorization), **When** one address registers repeatedly or aggregate registrations exceed the global cap, **Then** registration is refused with the uniform rate-limited response and **no** new registered-agent row is created — the store cannot grow without bound from anonymous traffic.
5. **Given** an authenticated user, **When** their calls to content search, markdown import, document export, or chat exceed the per-user budget, **Then** they receive HTTP 429 with `Retry-After`, other users are unaffected, and the budget is keyed on user identity (shared across that user's IPs and connections).
6. **Given** the shared limit store (Redis) is unavailable, **When** requests arrive, **Then** the service keeps working and limiting degrades to per-process enforcement — it neither crashes nor rejects all traffic (consistent with the design's "Redis unavailability degrades gracefully, never crashes the process").
7. **Given** the liveness and readiness endpoints, **Then** they are exempt from rate limiting (orchestrator probes must never be throttled).

---

### User Story 3 - An oversized chat request cannot take down a pod (Priority: P3)

Today `/api/chat` accepts request bodies up to 150MB because image attachments travel inline as base64 JSON. A single large request (malicious or accidental) is buffered into pod memory *before* any quota or stream-cap check runs — a one-request OOM primitive against a pod serving live collaboration sessions. After this feature, attachment bytes travel the existing S3 upload path (the body references uploaded attachments instead of embedding them), and the inline JSON limit shrinks to a size that covers conversation text with headroom but cannot exhaust pod memory.

**Why this priority**: Real memory-exhaustion vector, but it requires an authenticated user and deliberate (or unlucky) large payloads, so it ranks below the always-on deploy data loss and the fully anonymous abuse surface.

**Independent Test**: Send a chat request with an attachment via the upload path and verify the model receives it correctly; send a chat body just over the new limit and verify a clear, fast 413 rejection with no memory spike; verify a text-only conversation of realistic maximum length still fits.

**Acceptance Scenarios**:

1. **Given** a user attaches images to a chat message, **When** the message is sent, **Then** the attachment bytes are uploaded through the existing S3 upload path and the chat request body carries references, not embedded base64 bytes — and the model receives the attachment content exactly as before.
2. **Given** a request body over the new inline limit (including a legacy-style body with embedded base64 attachments), **When** it arrives, **Then** it is rejected with HTTP 413 and a clear error message before significant memory is consumed, and the error tells the client the attachment path to use.
3. **Given** a long text-only conversation within realistic use, **When** it is sent, **Then** it is accepted — the new limit is set with generous headroom over conversation text.
4. **Given** the S3 image store is not configured (degraded dev mode), **When** a user tries to attach an image to chat, **Then** the failure is explicit and graceful (attachment refused with a clear message), not a crash or silent drop.

---

### User Story 4 - A pod with a dead dependency stops taking traffic instead of serving errors (Priority: P4)

Today `/health` returns 200 unconditionally and serves as both liveness and readiness probe, so a pod whose database connection is gone stays in rotation and serves errors. After this feature, a separate `GET /ready` endpoint verifies primary-datastore reachability (a trivial query) and reports cache/pub-sub state, while `/health` stays a pure liveness signal ("process is up"). Pointing the orchestrator's readinessProbe at `/ready` is **feature 011's job** — this feature only ships the endpoint.

**Why this priority**: Improves failure behavior during dependency outages, but until 011 repoints the probe it changes no production routing on its own.

**Independent Test**: Call `/ready` with all dependencies healthy and verify a ready response including dependency detail; make the database unreachable and verify `/ready` reports not-ready while `/health` still reports the process alive; verify `/ready` reports not-ready during startup (before initialization completes) and during shutdown drain.

**Acceptance Scenarios**:

1. **Given** all dependencies healthy, **When** `GET /ready` is called, **Then** it returns HTTP 200 with a small JSON body reporting datastore reachability and cache/pub-sub state.
2. **Given** the primary datastore is unreachable (the trivial reachability query fails or times out quickly), **When** `GET /ready` is called, **Then** it returns HTTP 503, while `GET /health` continues to return 200 as long as the process is alive.
3. **Given** the cache/pub-sub tier is down but the datastore is healthy, **When** `GET /ready` is called, **Then** the pod still reports ready (200) with the degraded cache state visible in the body — a shared-cache outage must degrade the service, not remove every replica from rotation at once (see ledger RD-4).
4. **Given** the process is starting up (initialization incomplete) or draining for shutdown, **When** `GET /ready` is called, **Then** it returns 503.
5. **Given** either endpoint, **Then** the response contains no secrets, versions, hostnames, or connection details, and both endpoints remain unauthenticated and rate-limit-exempt.

---

### User Story 5 - Datastore misbehavior is bounded: a heavy query cannot starve auth, and the cache tier can require a password (Priority: P5)

Today the database pool is created with all defaults: no explicit connection cap tuned to the deployment, no bound on how long a request waits for a connection, and no server-side statement timeout — so one pathological query pattern can pin every connection and make even login time out. Separately, the Redis client has no authentication support, blocking the hardened cluster's `--requirepass` posture. After this feature, the pool has an explicit maximum, a connection-acquisition timeout, and a server-side statement timeout (all configurable), and every Redis connection the app makes (shared client and pub/sub clients alike) authenticates with `REDIS_PASSWORD` when it is set. Actually setting the password and enabling `--requirepass` on the Redis server is **feature 011's job**.

**Why this priority**: Important resilience floor, but the failure it prevents is rarer than the ones above, and the Redis AUTH half is inert until 011 wires the password.

**Independent Test**: Saturate the pool with slow statements and verify waiting requests fail fast with the acquisition timeout rather than hanging, and that the slow statements themselves are killed at the statement timeout; start Redis with a password, set `REDIS_PASSWORD`, and verify all app Redis connections (shared client and pub/sub) authenticate and function; unset it against an unauthenticated Redis and verify behavior is unchanged.

**Acceptance Scenarios**:

1. **Given** the database pool, **Then** it is created with an explicit maximum size, an explicit connection-acquisition timeout, and a server-side statement timeout, each overridable by environment configuration with documented defaults (ledger RD-7).
2. **Given** every pool connection is pinned by slow statements, **When** a new request needs a connection, **Then** it fails with a timely error (acquisition timeout) instead of waiting indefinitely, and the slow statements are terminated at the statement timeout so the pool recovers without a restart.
3. **Given** `REDIS_PASSWORD` is set in the environment, **When** the app creates any Redis connection (the shared client or a dedicated pub/sub client), **Then** the connection authenticates with that password; **Given** it is unset, **Then** connections behave exactly as today.
4. **Given** the statement timeout, **Then** it applies to the application's pool sessions only — the migration job and backup tooling run in separate processes and are unaffected.

---

### Edge Cases

- SIGTERM arrives while a large import/export or chat stream is mid-flight: in-flight HTTP work gets the remainder of the shutdown deadline to complete; the deadline force-exit is the backstop.
- SIGTERM arrives before initialization finishes (crash-loop scenario): shutdown must not throw on half-initialized resources.
- Redis restarts mid-window: in-flight budgets in shared state may be lost (Redis is not backed up, per design); this is accepted — limits re-arm immediately and per-process fallback covers the gap.
- A user behind a shared NAT/corporate egress trips per-IP limits for their neighbors on unauthenticated routes: accepted trade-off; limits are set with headroom and are environment-tunable (ledger RD-1).
- The forged-`X-Forwarded-For` test must cover both "extra entries appended by the client" and "no forwarding header at all" (direct connection in dev).
- Legacy chat clients (open browser tabs from before the deploy) still sending inline base64: they receive the clear 413 with guidance; the client fix ships in the same release so a refresh resolves it.
- Statement timeout hits a legitimately slow query (huge export, cold search): the request fails with a clear error rather than degrading the whole service; the default is set generously above observed legitimate latencies (ledger RD-7).
- `/ready` is polled at probe frequency: the reachability check must be trivially cheap (single trivial query, short timeout) and must not hold a pool connection longer than the check.
- Rate-limit key cardinality: per-IP keys from scanners could bloat shared state; budget entries must expire (TTL) so the limiter's own storage is bounded.
- Two replicas share one Redis: budgets are shared by design — a distributed attacker spreading across replicas gains nothing.

## Requirements *(mandatory)*

### Functional Requirements

**Graceful shutdown**

- **FR-001**: The application MUST handle SIGTERM by executing an ordered graceful shutdown: mark not-ready (readiness reports 503), stop accepting new WebSocket upgrades, close existing WebSocket sessions (triggering client failover), flush all in-flight/pending Yjs document persistence, release pub/sub and datastore resources, then exit 0.
- **FR-002**: SIGINT MUST run the same shutdown implementation as SIGTERM (one shared path; today's SIGINT handler is subsumed). Repeated signals during shutdown MUST be ignored.
- **FR-003**: Shutdown MUST complete or force-exit within a configurable deadline whose default (ledger RD-8) is safely below the orchestrator's termination grace period (currently 30s). A hung resource MUST NOT cause the process to be SIGKILLed with unflushed state that the deadline could have flushed.
- **FR-004**: No acknowledged edit may be lost across a SIGTERM restart: any Yjs update accepted from a client before shutdown began MUST be present in persisted state after the process exits. This MUST be covered by an automated test.

**Rate limiting**

- **FR-005**: The application MUST enforce per-IP rate limits on unauthenticated routes: the authentication routes (`/auth/*`), the OAuth token endpoint (`/mcp/auth/token`), and the dynamic client registration surface (`POST /mcp/auth/register` **and** the auto-registration path taken during authorization when an unknown `client_id` is presented).
- **FR-006**: The application MUST enforce per-user rate limits on expensive authenticated routes: content search, markdown import, document export, and chat requests. The limit key MUST be the authenticated user identity, not the IP.
- **FR-007**: Rate-limit state MUST live in the shared Redis tier (using the existing client infrastructure) so budgets survive process restarts and are shared across replicas. Budget entries MUST expire so limiter storage is bounded.
- **FR-008**: When the shared limit store is unavailable, limiting MUST degrade to per-process in-memory enforcement of the same budgets — never crash, never fail-closed for all traffic, never silently disable limiting entirely (ledger RD-3).
- **FR-009**: Rate-limited requests MUST receive HTTP 429 with a `Retry-After` header where a retry time is known, and a neutral error body that does not reveal budget internals beyond the retry hint.
- **FR-010**: All limit values MUST be environment-configurable with the documented defaults in ledger RD-1. Defaults MUST allow legitimate interactive and agent use with generous headroom.
- **FR-011**: Unauthenticated dynamic client registration MUST additionally be bounded so anonymous traffic cannot grow the registered-agents store without bound: a per-IP registration budget plus a global cap on new anonymous registrations per day (ledger RD-2). A request over either bound MUST be refused with the uniform 429 and MUST NOT create a row.
- **FR-012**: `/health` and `/ready` MUST be exempt from all rate limiting.
- **FR-013**: If the login-flow budgets introduced by features 008/009 are present in the codebase at merge time, this feature's limiter MUST NOT double-limit those routes — the flow-specific shared budgets remain authoritative for the login pairing surface; this feature's per-IP limits cover the routes named in FR-005 (see ledger RD-9).

**Trust proxy**

- **FR-014**: The Express `trust proxy` setting MUST change from blanket `true` to a numeric trusted hop count sourced from environment configuration (default per ledger RD-5), so the derived client IP is taken at the trusted depth of the forwarding chain and a client-supplied `X-Forwarded-For` cannot influence it.
- **FR-015**: The spoof-resistance property (forged forwarding headers do not change the limiter key or logged client IP) MUST be covered by an automated test. Existing consumers of the derived protocol/IP (HTTPS redirect handling, base-URL construction) MUST continue to work at the configured hop count.

**Chat request bounds**

- **FR-016**: Chat attachment bytes MUST travel the existing S3 upload path: the client uploads attachments and the chat request body carries references to them; the server resolves references when assembling the model request. Attachment access MUST enforce the same user-scoping as the rest of the image path (a user can only reference attachments they uploaded).
- **FR-017**: The inline JSON body limit for chat MUST shrink from 150MB to the ledgered default (RD-6), environment-configurable. Oversized bodies MUST be rejected with HTTP 413 and an actionable error message before the body is buffered into memory beyond the limit.
- **FR-018**: Existing chat functionality (multi-file attachments, per-file size limits, quota checks, concurrent-stream caps, conversation compaction) MUST be preserved under the new transport; quota and stream-cap checks now run without a large-body OOM window preceding them.
- **FR-019**: When the S3 image store is not configured, chat attachment upload MUST fail explicitly and gracefully with a clear client-visible message (matching the existing degrade-gracefully posture for image uploads).

**Readiness endpoint**

- **FR-020**: The application MUST expose `GET /ready`: HTTP 200 when the process is initialized, not shutting down, and the primary datastore answers a trivial reachability query within a short timeout; HTTP 503 otherwise. The JSON body MUST report datastore reachability and cache/pub-sub state.
- **FR-021**: Cache/pub-sub (Redis) state MUST be reported in the `/ready` body but MUST NOT gate readiness (ledger RD-4): datastore-down means not-ready; cache-down means ready-but-degraded.
- **FR-022**: `GET /health` MUST remain a pure liveness signal (200 while the process is up) with no dependency checks. Neither endpoint may expose versions, hostnames, connection strings, or other environment detail.

**Datastore limits**

- **FR-023**: The database pool MUST be created with an explicit maximum size, an explicit connection-acquisition timeout, and a server-side statement timeout applied to the application's pool sessions, each environment-configurable with ledgered defaults (RD-7). Out-of-process database users (migration job, backups) are unaffected.
- **FR-024**: The Redis connection configuration MUST include the password from `REDIS_PASSWORD` when that variable is set, applied uniformly to every connection the app creates (the shared client and all dedicated pub/sub clients, which share one config source). When unset, behavior is byte-identical to today.

**Cross-cutting**

- **FR-025**: Every behavioral change above MUST be covered by tests in the affected suites (Constitution Principle II), including: shutdown flush, budget persistence across restart, XFF spoof resistance, 413 on oversized chat bodies, attachment reference resolution, `/ready` state transitions, pool timeout behavior, and password/no-password Redis connection.

### Key Entities

- **Rate budget**: a counter with a window/TTL in shared state, keyed by (route-class, client IP) for unauthenticated routes or (route-class, user ID) for expensive routes; consumed per request, expires automatically; readable consistently from either replica.
- **Registered agent record**: the existing store row created by dynamic/auto registration; this feature adds admission bounds (per-IP and global-daily) on its anonymous creation path, not a schema change.
- **Chat attachment reference**: an identifier for bytes previously uploaded via the S3 path, carried in the chat body in place of inline base64; scoped to the uploading user.
- **Shutdown state**: a process-wide "draining" flag consulted by the readiness endpoint and the WebSocket upgrade path.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: Zero acknowledged-edit loss across deploys: in a test that types continuously through a SIGTERM restart, 100% of edits acknowledged before the signal are present after restart (today: the un-flushed tail is lost on every deploy).
- **SC-002**: Shutdown always terminates: the process exits within the configured deadline in 100% of shutdown tests, including with wedged dependencies.
- **SC-003**: An unauthenticated source exceeding any per-IP budget is limited within 1 request of the budget boundary, and remains limited after a process restart and from either replica; forging forwarding headers changes nothing (0 successful spoof-keyed requests in the adversarial test).
- **SC-004**: Anonymous traffic can no longer grow the registered-agents store without bound: a registration flood from one address creates at most the per-IP budget of rows, and aggregate anonymous registrations per day never exceed the global cap.
- **SC-005**: The maximum memory a single chat request can force the server to buffer drops from 150MB to the ledgered inline limit (~15x reduction), and a just-over-limit request is rejected in under 1 second with 413.
- **SC-006**: With the primary datastore unreachable, `/ready` reports 503 within 2 seconds while `/health` stays 200; with only the cache tier down, `/ready` stays 200 with degraded state visible.
- **SC-007**: With every pool connection pinned by pathological statements, an unrelated request fails fast (within the acquisition timeout, not minutes) and the pool self-recovers once the statement timeout kills the offenders — no restart required.
- **SC-008**: With `REDIS_PASSWORD` set against a password-protected Redis, 100% of the app's Redis connections authenticate successfully; with it unset, the full existing suite passes unchanged.
- **SC-009**: The full backend, client, and integration suites pass; normal interactive use (login, search, import/export, chat with attachments, collaborative editing) never encounters a 429 or 413 at the default limits.

## Assumptions

- Production topology at cutover is client → CloudFront → Traefik → app (per the design's edge posture); the trusted hop count is environment-configured so dev (direct/NodePort) and prod differ by configuration, not code (ledger RD-5).
- The orchestrator's termination grace period remains at the Kubernetes default (30s); the shutdown deadline default is chosen under it. If 011 tunes the grace period, the deadline is env-adjustable.
- `rate-limiter-flexible` (or an equivalent library working over the existing ioredis client, with an in-memory insurance fallback) is an acceptable new dependency; it does not touch the markdown/serialization pipeline, so Constitution's single-registry rule is not implicated.
- The existing S3 image upload path (user-scoped, presigned, degrade-gracefully) is reusable for chat attachments without a schema migration; attachment references reuse its object identity. If implementation falsifies this, the gap goes to the ledger, not ad-hoc scope growth.
- This worktree (d20917e) does not contain the 008/009 login-flow budget code; FR-013 states the composition rule for whichever merge order occurs.
- Redis remains un-backed-up and flushable: losing limiter state resets budgets, which is accepted (attackers gain at most one fresh window; legitimate users are unaffected).
- No new schema: rate budgets live in Redis; registration caps are admission checks; chat attachments reuse the existing image storage identity.

## Cross-Feature Handoffs (feature 011 — deployment hardening)

This feature deliberately stops at the application boundary in two places. Feature 011 MUST pick these up; they are restated here so neither side assumes the other did it:

1. **readinessProbe target**: This feature ships `GET /ready` but does **not** touch `k8s/app-deployment.yaml` (whose readinessProbe and livenessProbe both point at `/health` today, lines ~170-181). Feature 011 repoints the readinessProbe to `/ready` (livenessProbe stays on `/health`). Until then, `/ready` is live but unused by the orchestrator.
2. **Redis password wiring**: This feature makes the app *capable* of authenticating to Redis (`REDIS_PASSWORD` honored across all clients) but sets no password anywhere. Feature 011 provisions the secret, passes it to the app, and runs Redis with `--requirepass` (plus the design's `--maxmemory`/`allkeys-lru` posture). Until then, `REDIS_PASSWORD` is simply unset and behavior is unchanged.

Secondary alignment (not blocking): 011's deployment configuration should set the production `TRUST_PROXY_HOPS` value to match the real edge chain (RD-5) and keep `terminationGracePeriodSeconds` above the shutdown deadline (RD-8).
