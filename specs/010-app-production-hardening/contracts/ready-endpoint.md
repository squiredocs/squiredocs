# Contract: Readiness & Liveness Endpoints

## `GET /ready`  (new, unauthenticated, rate-limit-exempt)

Reports whether this replica should receive traffic. Feature 011 later points the k8s
`readinessProbe` here (010 only ships the endpoint).

**Preconditions checked** (all must hold for 200):
1. `initialized === true` (startup finished: `server.listen` cb ran and `redisPubSub.init()` resolved)
2. `draining === false` (not shutting down)
3. Postgres answers a trivial reachability query (`SELECT 1`) within a short timeout

**Responses**

| Situation | Status | Body |
|-----------|--------|------|
| all preconditions hold | 200 | `{ "status": "ready", "datastore": "up", "cache": "up" }` |
| datastore up, cache/pub-sub down (RD-4) | 200 | `{ "status": "ready", "datastore": "up", "cache": "degraded" }` |
| datastore query fails/times out | 503 | `{ "status": "not_ready", "datastore": "down", "cache": "up"\|"degraded" }` |
| still initializing | 503 | `{ "status": "not_ready", ... }` |
| draining (shutdown) | 503 | `{ "status": "not_ready", ... }` |

**Invariants**
- Redis/cache state is **reported but never gates** the 200/503 decision (RD-4, FR-021).
- Body contains **no** secrets, versions, hostnames, or connection strings (FR-022).
- The reachability check must not hold a pool connection past the check (Edge Cases): acquire,
  `SELECT 1` with timeout, release immediately.
- Datastore-down ⇒ 503 within ~2s (SC-006).
- Endpoint is exempt from all rate limiting (FR-012).

## `GET /health`  (existing, unchanged — pure liveness)

| Situation | Status | Body |
|-----------|--------|------|
| process is up | 200 | `{ "status": "ok" }` |

- **No dependency checks** — stays 200 as long as the process is alive, even when the datastore
  is unreachable (US4 scenario 2, FR-022).
- Rate-limit-exempt (FR-012). No secrets/versions/hostnames.
