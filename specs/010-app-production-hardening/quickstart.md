# Quickstart: Validating Application Production Hardening

Runnable validation per user story. Run inside the Minikube `app-dev` pod (shared Postgres/Redis).
Authoritative gate: `npm test` (backend Jest serial + client Vitest) and `npm run build`.

## Prerequisites

- Dependency added: `rate-limiter-flexible` (`npm install` after it lands in `package.json`).
- Backend suite runs **serially** against the shared test DB (`npm run test:server`, `--runInBand`).
- Limiter tests: set `RL_FORCE_MEMORY=1` for deterministic budgets without a live Redis;
  `rateLimit._reset()` between tests.

## US1 — Graceful shutdown never loses the edit tail (P1)

1. Automated (FR-004, SC-001): drive `runShutdown()` with a still-pending persistence promise in
   the tracker; assert exit is deferred until `pendingWrites` settles, and that a Yjs update
   accepted just before drain is present in persisted state afterward.
2. Deadline (FR-003, SC-002): wedge a resource (never-resolving flush) and assert force-exit fires
   at `SHUTDOWN_DEADLINE_MS` (mock `process.exit`).
3. Signals (FR-002): SIGINT runs the same path; a second signal mid-drain is ignored.
4. Manual: two browser editors typing; `kill -TERM <pid>`; process exits within the deadline,
   clients reconnect to the other replica and converge with no lost characters.

## US2 — Abuse limits & spoof-proof keys (P2)

1. Per-IP (FR-005, SC-003): exceed `RL_AUTH_PER_MIN` from one IP on `/auth/*` → 429 + `Retry-After`;
   a different IP is unaffected.
2. Persistence (FR-007): consume part of a budget, restart the process (or hit the other replica),
   confirm remaining budget unchanged.
3. Spoof resistance (FR-015, SC-003): supertest with forged `X-Forwarded-For: 1.2.3.4, 5.6.7.8`
   and with no header at all; assert `req.ip`/limiter key is the true trusted-hop address, 0
   successful spoof-keyed requests over budget.
4. ~~Registration caps (FR-011, SC-004): flood `POST /mcp/auth/register` from one IP → capped at the
   per-IP budget, over-budget requests 429 with **no** new `registered_agents` row; aggregate never
   exceeds the global daily cap. Repeat via the authorize auto-register path sharing the same budget.~~
   _(**Superseded 2026-07-18:** registration admission caps removed — sign-up is now unlimited; there
   is nothing to verify here. `POST /mcp/auth/register` and the auto-register paths return no 429.
   See promotion-notes §8.)_
5. Per-user (FR-006): as one user, exceed `RL_CHAT_PER_MIN` → 429 keyed on user, other users
   unaffected.
6. Degrade (FR-008): with Redis unavailable, requests still served and limited per-process; no
   crash, no reject-all.
7. Exemption (FR-012): `/health` and `/ready` never 429 under load.

## US3 — Oversized chat request can't OOM a pod (P3)

1. Attachment path (FR-016, SC-005): upload an image to `POST /api/chat/attachments`, send a chat
   message carrying the reference, assert the model receives the attachment content and the body
   carried no base64.
2. 413 (FR-017): send a chat body just over `CHAT_BODY_LIMIT` (incl. a legacy inline-base64 body)
   → fast 413 with the attachment-path guidance, no memory spike.
3. Headroom (FR-017): a long text-only conversation under the limit is accepted.
4. User-scope (FR-016): user A cannot resolve a reference to user B's attachment key.
5. Degraded S3 (FR-019): with S3 unconfigured, attachment upload → 503 clear message, no crash.

## US4 — Dead-dependency pod stops taking traffic (P4)

1. Healthy (FR-020): `GET /ready` → 200 with `{datastore:'up', cache:'up'}`.
2. Datastore down (FR-020, SC-006): make Postgres unreachable → `/ready` 503 within ~2s while
   `/health` stays 200.
3. Cache down, datastore up (FR-021, RD-4): `/ready` stays 200 with `cache:'degraded'`.
4. Lifecycle (FR-020): during startup (pre-init) and during shutdown drain, `/ready` → 503.
5. No leakage (FR-022): neither endpoint exposes versions/hostnames/connection detail.

## US5 — Bounded datastore misbehavior + Redis AUTH (P5)

1. Pool timeouts (FR-023, SC-007): saturate the pool with slow statements; an unrelated request
   fails fast at `DB_POOL_ACQUIRE_TIMEOUT_MS`; slow statements are killed at
   `DB_STATEMENT_TIMEOUT_MS` and the pool self-recovers without a restart.
2. Out-of-process unaffected (FR-023): the migration job / backups run with their own connections,
   no statement-timeout applied.
3. Redis AUTH (FR-024, SC-008): with a password-protected Redis + `REDIS_PASSWORD` set, the shared
   client and pub/sub clients authenticate and function; with it unset against an unauthenticated
   Redis, the full suite passes unchanged (byte-identical config).

## Final gate (SC-009)

- `npm test` green (backend serial + client) and `npm run build` succeeds.
- Normal interactive use (login, search, import/export, chat with attachments, collaborative
  editing) never hits a 429 or 413 at default limits.
