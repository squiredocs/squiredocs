# Phase 1 Data Model: Application Production Hardening

This feature adds **no database schema** (no node-pg-migrate migration). The "entities" below
are runtime/state objects: Redis keys with TTL, in-process flags, and an S3 object identity. They
mirror the spec's "Key Entities" section.

---

## 1. Rate budget (Redis key, TTL-bounded)

Represents remaining request allowance for a (route-class, principal) pair.

| Field | Value | Notes |
|-------|-------|-------|
| key | `rl:<class>:<scope>:<principal>` | e.g. `rl:auth:ip:1.2.3.4`, `rl:chat:user:<uuid>` |
| class | `auth` \| `token` \| `register` \| `search` \| `import` \| `export` \| `chat` | one per limited route class |
| scope | `ip` \| `user` | unauth routes key on IP; expensive routes on user id |
| principal | `req.ip` (at trusted hop) \| `req.user.userId` | IP is spoof-resistant after the numeric trust-proxy change |
| points | env budget (RD-1 defaults) | consumed per request |
| duration | window seconds (per class) | `/auth/*` 60s, `token` 60s, `register` 3600s, per-user classes 60s |
| ttl | = duration (auto-expire) | bounds limiter storage (FR-007, Edge Cases) |

- **Consumed** once per matching request. When points are exhausted within the window → 429.
- **Shared** across replicas (Redis) and **survives restart** (FR-007). On Redis outage the same
  budget is enforced per-process via the memory insurance limiter (FR-008, RD-3).
- **Readable/consistent** from either replica because it lives in the shared tier.

Defaults (RD-1, all env-overridable — env names fixed in `contracts/rate-limiting.md`):
`auth` 30/min · `token` 30/min · `register` 5/hour · `search` 30/min · `import` 10/min ·
`export` 20/min · `chat` 30/min (on top of the existing concurrent-stream cap + AI quota).

---

## 2. Anonymous registration admission (Redis counters)

Bounds growth of the existing `registered_agents` store from anonymous traffic (FR-011, RD-2).
No schema change to `registered_agents`; these are admission gates in front of `registerAgent(...)`.

| Field | Value | Notes |
|-------|-------|-------|
| per-IP key | `rl:register:ip:<ip>` | 5/hour, **shared** with the authorize/approve auto-register path |
| global key | `rl:register:global` | default 200/**day**, 24h TTL — backstop against distributed floods |
| consumed when | a **new** row is about to be created | existing-agent lookups / idempotent re-registration don't consume |
| over budget | uniform 429, **no row written** | SC-004 |

Applies at all three creation sites: `handleRegister` (`POST /mcp/auth/register`), and the
auto-register branches in `handleAuthorize` and `handleApprove`.

---

## 3. Chat attachment reference (S3 object identity, no DB row)

An identifier for bytes previously uploaded, carried in the chat body in place of inline base64
(FR-016). Scoped to the uploading user.

| Field | Value | Notes |
|-------|-------|-------|
| s3 key | `chat-attachments/<userId>/<uuid>` | ownership encoded in the key path |
| reference (in chat body) | opaque handle mapping to the key | replaces the `data:` URL in the message file part |
| mediaType / filename | carried alongside the reference | preserved for the model + `insert_image` |
| resolve rule | fetch via `s3-images.getObject(key)` **only if** key's `<userId>` == `req.user.userId` | user-scope enforcement (FR-016) |
| unconfigured S3 | upload → 503 clear message | degrade gracefully (FR-019) |

- No new table: identity is the S3 object; the user-scope check is the resolve-time guard.
- Preserves existing multi-file, per-file-size, quota, stream-cap, compaction behavior (FR-018).

---

## 4. Shutdown / readiness process state (in-process flags)

Process-wide flags consulted across the shutdown, upgrade, and readiness paths.

| Field | Type | Set when | Read by |
|-------|------|----------|---------|
| `initialized` | bool | end of `server.listen` cb after `redisPubSub.init()` resolves | `/ready` (false ⇒ 503) |
| `draining` | bool | first SIGTERM/SIGINT received | `/ready` (true ⇒ 503); WS `upgrade` handler (true ⇒ refuse) |
| `pendingWrites` | `Set<Promise>` | each persistence `storeUpdate` promise added on start, removed on settle | `shutdown()` awaits `allSettled` before exit (FR-004) |
| shutdown deadline | number (ms) | `SHUTDOWN_DEADLINE_MS` env, default 20000 (RD-8) | force-exit `setTimeout` backstop (FR-003) |

**Readiness truth table (RD-4):**

| initialized | draining | datastore | cache | HTTP | body.cache |
|-------------|----------|-----------|-------|------|-----------|
| false | — | — | — | 503 | (startup) |
| true | true | — | — | 503 | (draining) |
| true | false | down | any | 503 | reported |
| true | false | up | up | 200 | `up` |
| true | false | up | down | 200 | `degraded` |

---

## Datastore / cache configuration (not entities — recorded for completeness)

- **pg Pool** (app process only): `max` 20, `connectionTimeoutMillis` 5000, `statement_timeout`
  30000 (RD-7). Migration/backup processes unaffected.
- **Redis config**: `password` from `REDIS_PASSWORD` included only when set; byte-identical when
  unset (FR-024). Shared by the main client and every pub/sub client.
