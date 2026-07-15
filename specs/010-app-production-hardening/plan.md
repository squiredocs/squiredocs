# Implementation Plan: Application Production Hardening

**Branch**: `010-app-production-hardening` (pipeline tree; no branch created here — worktree on `main`, HEAD `881aa9f`) | **Date**: 2026-07-15 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `/specs/010-app-production-hardening/spec.md`

## Summary

Harden the single Node process (`server/index.js`) for multi-tenant public exposure, per
`design/infrastructure-and-environments.md` → "Application hardening posture". Five
independent slices, prioritized P1→P5, all **server/app code only — no k8s manifests, no
node-pg-migrate migrations**:

1. **Graceful shutdown (P1, US1).** Replace the ad-hoc 5s SIGINT handler with one shared
   ordered drain (SIGTERM + SIGINT): flip a process-wide `draining` flag (readiness → 503),
   refuse new WebSocket upgrades, close live WS sessions, **await all in-flight Yjs
   persistence**, then `redisPubSub.cleanup()` → `persistenceProvider.destroy()` →
   `closeRedis()` → `server.close()` → `exit 0`, with a `SHUTDOWN_DEADLINE_MS` (default
   20000, RD-8) force-exit backstop under the orchestrator's 30s grace period. FR-004 (no
   acknowledged edit lost) is the crux and drives a small **pending-persistence tracker**.

2. **Rate limiting (P2, US2).** New `server/rate-limit.js` over `rate-limiter-flexible`
   (`RateLimiterRedis` on the existing ioredis client, `RateLimiterMemory` as the insurance
   fallback so Redis-down degrades to per-process, RD-3). Per-IP middleware on `/auth/*`,
   `/mcp/auth/token`, and the dynamic-registration surface (`POST /mcp/auth/register` **and**
   the auto-registration path in `handleAuthorize`/`handleApprove`); per-user middleware on
   content search, import, export, chat. Budgets from env (RD-1); 429 + `Retry-After` +
   neutral body (FR-009); `/health` + `/ready` exempt (FR-012). Anonymous registration gets a
   per-IP budget **plus** a global daily cap (RD-2) that admits before any row is written.
   `trust proxy` changes from blanket `true` to numeric `TRUST_PROXY_HOPS` (default 1, RD-5)
   so the limiter key can't be spoofed via `X-Forwarded-For`.

3. **Chat request bounds (P3, US3).** Shrink the `/api/chat` inline JSON limit 150MB →
   `CHAT_BODY_LIMIT` (default 10MB, RD-6) with an actionable 413. Move attachment bytes off
   the inline JSON path onto S3: a new user-scoped `POST /api/chat/attachments` upload, the
   chat body carries references, and `chat.js` resolves references (user-scope enforced) when
   assembling model messages + `messageImages`. Degrade gracefully when S3 is unconfigured
   (FR-019). No schema: ownership is encoded in the S3 key and re-verified on resolve.

4. **Readiness endpoint (P4, US4).** New unauthenticated `GET /ready`: 200 only when
   initialized, not draining, and Postgres answers `SELECT 1` within a short timeout; 503
   otherwise. Body reports datastore + cache/pub-sub state; **Postgres gates, Redis is
   reported-not-gating** (RD-4). `/health` stays a pure liveness signal. No secrets (FR-022).

5. **Datastore limits (P5, US5).** Give the pg `Pool` an explicit `max` (20),
   `connectionTimeoutMillis` (5000), and per-session `statement_timeout` (30000), all env
   (RD-7), app pool only. Make `server/redis.js` honor `REDIS_PASSWORD` when set, uniformly
   across the shared client and every pub/sub client (shared `REDIS_CONFIG`); **byte-identical
   when unset**.

**Cross-feature handoffs (belong to feature 011, NOT planned here — external dependencies):**
- The k8s `readinessProbe` repoint to `/ready` is 011's; 010 only ships the endpoint.
- Provisioning `REDIS_PASSWORD` + running Redis with `--requirepass` is 011's; 010 only makes
  the app *capable* (honor the var when set).

**Worktree reality (verified 2026-07-15, HEAD `881aa9f`):** this tree contains **no** 008/009
login-flow code — no `server/rate-limit.js`, no login-service, no `/api/login/*`. So FR-013 /
RD-9 (don't double-limit login budgets) is **vacuous in this worktree**; the plan still
namespaces limiter keys (`rl:auth:ip:`, `rl:chat:user:` …) so a later merge with 008/009
budgets composes without collision, and the merge/converge step owns the actual de-dup if
those routes ever coexist. `rate-limiter-flexible` is **not yet installed**; ioredis 5.10.1 is.

## Technical Context

**Language/Version**: Node.js 22+ (CommonJS), Express 4, ws / y-websocket, ioredis 5.10.1, pg.

**Primary Dependencies**: Express, `ws` + `y-websocket`, `yjs`, `ioredis`, `pg`, plus one
**new** dependency `rate-limiter-flexible` (works over the existing ioredis client, with a
`RateLimiterMemory` insurance fallback). Not a markdown/serialization dependency — Constitution's
single-registry rule (Principle IV / Tech Constraints) is not implicated. Reuses existing
`server/s3-images.js`, `server/redis.js`, `server/postgres-persistence.js`, `server/url.js`.

**Storage**: PostgreSQL (Yjs updates, agents, delegations — unchanged, **no migration**); Redis
(rate-limit budgets with TTL — new keyspace, no schema); S3 (chat attachment bytes via the
existing images bucket, new key prefix). Rate budgets and registration caps are Redis/admission
checks, not tables. Chat attachment identity reuses S3 object identity — no DB row.

**Testing**: Jest + `supertest`, backend, **serial** (`--runInBand`, Constitution II; shared
test DB). New/extended suites: shutdown flush (FR-004), budget-persists-across-restart + Redis-down
degrade (FR-007/008), XFF spoof resistance (FR-015), chat 413 + attachment reference resolution
(FR-017/016), `/ready` state transitions (FR-020/021), pool acquisition/statement timeout (FR-023),
Redis password/no-password (FR-024). Client: Vitest for the chat attachment-upload change. Verify
gate: `npm test` + `npm run build`.

**Target Platform**: Linux server, Minikube `app-dev` pod; 2 replicas behind a Service in prod.

**Project Type**: Web service (Express backend serving API + WS + MCP + built client) with a
small client-side change for chat attachment upload.

**Performance Goals**: `/ready` check is a single trivial query on a short timeout, must not hold
a pool connection past the check (Edge Cases). Shutdown flush is sub-second for realistic open-doc
counts; 20s deadline is a ceiling. Rate-limit middleware adds one Redis round trip per limited
request (INCR/EXPIRE), amortized by the library.

**Constraints**: shutdown deadline < 30s grace period (RD-8); limiter storage bounded by TTL
(FR-007, Edge Cases); `/ready` and `/health` reveal no secrets/versions/hostnames (FR-022);
`REDIS_PASSWORD` unset ⇒ byte-identical Redis behavior (FR-024); chat body limit generous over
text-only history (RD-6); statement timeout scopes to the app pool only, never the migration/backup
processes (FR-023, RD-7).

**Scale/Scope**: ~7 server modules touched (`index.js`, `redis.js`, `postgres-persistence.js`,
`api/chat.js`, `mcp/auth/oauth-flow.js`, plus new `rate-limit.js` and a shutdown/readiness seam)
+ 1 client attachment-upload change + ~8 test files. One new npm dependency. ~22-26 tasks.

## Constitution Check

*GATE: evaluated pre-Phase 0 and re-checked post-Phase 1. Result: PASS, no violations.*

- **I. Documentation Reflects Reality** — PASS with a converge note. This feature adds an
  endpoint (`/ready`), a new route (`POST /api/chat/attachments`), and ~10 env vars
  (`TRUST_PROXY_HOPS`, `SHUTDOWN_DEADLINE_MS`, the `RL_*` budgets, `CHAT_BODY_LIMIT`,
  `DB_POOL_MAX`/`DB_POOL_ACQUIRE_TIMEOUT_MS`/`DB_STATEMENT_TIMEOUT_MS`, `REDIS_PASSWORD`).
  `README.md`/`docs/dev.md` are **out of this agent's edit scope** (pipeline override); the new
  surface + env vars are flagged for the merge/converge step to fold into the docs, not silently
  edited here. No governed doc's described behavior is invalidated (endpoints are added, existing
  ones unchanged in contract).
- **II. Test-Backed Changes** — PASS. Every behavioral change carries a test (FR-025 enumerates
  them). Backend runs serially against the shared DB. No format/serialization registry change ⇒
  `format-roundtrip.test.js` untouched. The new dependency is a limiter, not a serializer.
- **III. Trunk-Based Solo Workflow** — PASS. Pipeline overrides govern: stay on the `main`
  worktree, create no branch, this agent commits nothing. No new ceremony.
- **IV. Collaboration-Safe Document Operations** — PASS. The shutdown flush **awaits existing
  in-flight `storeUpdate` writes**; it introduces no wholesale delete/recreate, no positional
  targeting, and preserves provenance (the same `userId`/`agentName` attribution already carried
  by each pending write). CRDT identity is untouched.
- **V. Secure by Default for Agent & User Content** — PASS, and net-tightening. Two new surfaces:
  `GET /ready` (unauthenticated — trust boundary stated in spec §"Trust boundary statement":
  no input, coarse reachability only) and `POST /api/chat/attachments` (**requireAuth**, bytes
  user-scoped, a reference is only resolvable by its uploader — ingestion trust boundary stated
  in spec FR-016/FR-019). Every other change tightens: per-IP/per-user limits, registration caps,
  numeric trust-proxy kills XFF spoofing, bounded chat body closes the OOM window before quota
  checks. `sk_sqd_`/auth model unchanged.
- **VI. Design Docs Are Ground Truth** — PASS. Design doc drives; all open numbers are
  RATIFIED-BY-DEFAULT in `clarifications-needed.md` (RD-1..RD-9, Sam pre-authorized 2026-07-15).
  No documented mechanism is falsified by this plan; if implementation falsifies the "existing S3
  path is reusable for chat attachments" assumption, that goes to the ledger, not ad-hoc scope
  growth.

No entries required in Complexity Tracking (no violations to justify).

## Project Structure

### Documentation (this feature)

```text
specs/010-app-production-hardening/
├── plan.md              # This file
├── research.md          # Phase 0 — decisions per hardening slice
├── data-model.md        # Phase 1 — rate budget, registration caps, attachment ref, shutdown/ready state
├── quickstart.md        # Phase 1 — runnable validation per user story
├── contracts/
│   ├── ready-endpoint.md         # GET /ready + GET /health contract
│   ├── rate-limiting.md          # limited routes, budgets, 429 shape, exemptions
│   └── chat-attachments.md       # POST /api/chat/attachments + reference resolution + 413
├── clarifications-needed.md      # RD-1..RD-9 (pre-existing, ledger)
└── checklists/requirements.md    # pre-existing spec-quality checklist
```

### Source Code (repository root)

```text
server/
├── index.js                    # trust proxy → numeric; mount rate-limit middleware; /ready;
│                               #   shrink /api/chat body limit; shared graceful-shutdown seam;
│                               #   refuse WS upgrades while draining; wire pending-persistence flush
├── rate-limit.js               # NEW — limiter factory (Redis + memory insurance), key builders,
│                               #   per-IP / per-user middleware, registration admission, 429 responder
├── shutdown.js                 # NEW (or inline seam in index.js) — ordered drain + deadline + flags
├── redis.js                    # honor REDIS_PASSWORD when set (shared client + pub/sub)
├── postgres-persistence.js     # pool max / acquire timeout / statement_timeout; expose pending-flush;
│                               #   trivial reachability query for /ready
├── api/
│   ├── chat.js                 # resolve attachment references → file parts + messageImages (user-scoped)
│   └── chat-attachments.js     # NEW — POST /api/chat/attachments (requireAuth, S3, user-scoped key)
└── mcp/auth/oauth-flow.js      # apply registration admission caps on register + auto-register paths

client/
└── src/contexts/AiChatContext.jsx (+ input component)  # upload files to S3, send references not base64

server/__tests__/  &  __tests__/integration/            # new + extended suites (see Testing)
```

**Structure Decision**: Single Express web-service repo (existing layout). New server modules
`rate-limit.js`, `chat-attachments.js`, and a `shutdown.js`/inline seam. The graceful-shutdown
seam and the pending-persistence flush live where the persistence update listener already is
(`index.js` `setPersistence` + `postgres-persistence.js`), so the flush observes exactly the
writes the listener fires. The client change is confined to the chat send path.

## Complexity Tracking

> No Constitution violations — table intentionally empty.

| Violation | Why Needed | Simpler Alternative Rejected Because |
|-----------|------------|-------------------------------------|
| (none)    | —          | —                                    |
