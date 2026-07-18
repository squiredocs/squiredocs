# Phase 0 Research: Application Production Hardening

All open product numbers are already resolved as RATIFIED-BY-DEFAULT in
`clarifications-needed.md` (RD-1..RD-9). This file records the **technical** decisions —
library choice, mechanism, and where each change lands in the real code (verified against
HEAD `881aa9f`, 2026-07-15) — with alternatives considered. No `NEEDS CLARIFICATION` remains.

---

## R1 — Graceful shutdown & the in-flight persistence flush (US1, FR-001..004)

**Decision.** One shared `shutdown(signal)` bound to both `SIGTERM` and `SIGINT`, replacing the
current `process.on('SIGINT', …)` (index.js ~L1896). Ordered steps:
1. If already draining, return (ignore repeat signals — FR-002).
2. Set process-wide `draining = true` (a tiny shared state module or exported flag) — `/ready`
   reads it and returns 503 (FR-001), and the WS `server.on('upgrade')` handler reads it and
   refuses new upgrades with `503`/socket destroy so clients fail over (FR-001, US1 scenario 2).
3. Close live WS sessions (`for (const c of wss.clients) c.close(1001)`), triggering client
   reconnect to a healthy replica.
4. **Await the pending-persistence tracker to drain** (the crux, below).
5. `await redisPubSub.cleanup()` → `await persistenceProvider.destroy()` (pool end) →
   `await closeRedis()` → `server.close(cb)` → `process.exit(0)`.
6. A `setTimeout(() => process.exit(0), SHUTDOWN_DEADLINE_MS).unref()` backstop (default 20000,
   RD-8) guarantees force-exit under the 30s grace period (FR-003).

**The pending-persistence tracker (FR-004).** Today the `ydoc.on('update')` listener in
`index.js setPersistence.bindState` fires `retryWithBackoff(() => storeUpdate(...))` as a
**detached promise** — nothing awaits it, so a fast `process.exit` can drop the tail. Add a
module-level `Set<Promise>` (a `pendingWrites` tracker, exported alongside the persistence wiring):
each persist promise is added on start and removed on settle. `shutdown()` awaits
`Promise.allSettled([...pendingWrites])` (bounded by the deadline). This captures every
acknowledged-but-unpersisted Yjs update. This is the minimal change that makes SC-001 (100% edit
survival) testable: type through a SIGTERM, assert the last update's clock is present after restart.

**Alternatives considered.**
- *y-websocket `writeState` on disconnect* — rejected: `writeState` is intentionally a no-op here
  (persist-on-every-update is the design), and disconnect-flush wouldn't cover updates already
  queued but not yet written.
- *Awaiting only `server.close()`* — rejected: `server.close()` waits on HTTP sockets, not the
  detached DB-write promises; the tail loss is exactly those promises.
- *A global `await`-per-write in the listener* — rejected: serializing every update on the hot
  path would regress live-edit latency; tracking + draining only at shutdown keeps the hot path
  async.

**Test seam.** Export the tracker + `shutdown` (or an injectable `runShutdown({ deadlineMs })`)
so a Jest test can drive it without sending a real signal; assert order + that a still-pending
write is awaited before exit is called (mock `process.exit`).

---

## R2 — Rate limiting library & degrade-to-memory (US2, FR-005..013)

**Decision.** Add `rate-limiter-flexible`. Build limiters in a new `server/rate-limit.js`:
- `RateLimiterRedis({ storeClient: getRedisClient(), keyPrefix, points, duration })` per route
  class, with `insuranceLimiter: new RateLimiterMemory({ points, duration })` — the library
  automatically falls back to the in-memory limiter when the Redis op errors/times out (RD-3,
  FR-008): never crashes, never fail-closed, never fully unlimited.
- When `isRedisEnabled()` is false (dev without Redis), construct memory-only limiters so behavior
  is identical to "Redis down" — one code path.
- Budgets read from env at module load with RD-1 defaults; keys namespaced by class:
  `rl:auth:ip:`, `rl:token:ip:`, `rl:register:ip:`, `rl:search:user:`, `rl:import:user:`,
  `rl:export:user:`, `rl:chat:user:`. Namespacing is what lets a future 008/009 login budget
  coexist (RD-9) without collision.

**Middleware.** Two factories:
- `perIp(routeClass)` — key = `req.ip` (now correct because of R4's numeric trust proxy).
- `perUser(routeClass)` — key = `req.user.userId` (mounted **after** `requireAuth`).
On limit hit: `429`, `Retry-After: <secs>` from `rejRes.msBeforeNext` (FR-009), neutral body
`{ error: 'Rate limit exceeded. Retry later.' }` — no budget internals. `/health` + `/ready` are
never wrapped (FR-012). Consume errors that are *not* rate-limit rejections (i.e. the memory
fallback also failed) must `next()` (fail-open only in the truly-degraded case, still bounded by
the memory limiter first).

**Mount points (verified line refs).**
- `/auth/*`: wrap `app.use('/auth', perIp('auth'), authRouter)` (index.js L314).
- `/mcp/auth/token`: the token endpoint is inside `mcp.oauthRouter` (mounted L369). Apply
  `perIp('token')` narrowly to the token path (either mount on the sub-path or guard inside the
  router) so only `/mcp/auth/token` is limited, not all `/mcp/auth/*`.
- Expensive per-user routes: content search is `GET /api/docs?searchMode=content` (index.js
  L496 branch) — limit only when `searchMode === 'content'`; import/export are the routers at
  L1123/L1127; chat is `POST /api/chat` (L319 / chat.js router). `perUser` sits after `requireAuth`.

**Alternatives considered.**
- *`express-rate-limit` + `rate-limit-redis`* — viable, but `rate-limiter-flexible` has
  first-class Redis+memory insurance fallback and per-key control matching RD-3/RD-2 with less
  glue; the spec Assumptions already name it as acceptable.
- *Hand-rolled INCR/EXPIRE* — rejected: reinvents atomic windowing + fallback the library gives.

---

## R3 — Anonymous registration admission caps (US2, FR-011, RD-2)

> **Amended 2026-07-18:** the registration admission caps designed and built below were **removed**
> from `server/rate-limit.js` (both the per-IP `register` budget and the global `rl:register:global`
> counter, plus the `checkRegistrationAdmission` helper). Sign-up is now intentionally unlimited —
> the single shared global counter meant one abuser or organic growth could lock out all new sign-ups
> for a UTC day. See `promotion-notes.md` §8 disposition 1. The original research is preserved below.

**Decision.** The registered-agents store grows from three code paths in `oauth-flow.js`:
`handleRegister` (L602, `POST /mcp/auth/register`) and the two auto-register calls in
`handleAuthorize` (L114) and `handleApprove` (L215). All three funnel through `registerAgent(...)`.
Add an **admission check before any `registerAgent` that would create a new row**:
- Per-IP budget (`rl:register:ip:`, 5/hour, shared with the auto-register path per RD-2) — the
  same key for `/register` and the authorize/approve auto-register so a client can't multiply its
  budget across paths.
- Global daily cap (`rl:register:global`, default 200/day) — a single Redis counter with a 24h TTL;
  admit-then-increment only when a new row is actually about to be created (existing-agent lookups
  and idempotent re-registrations don't consume it).
Over either bound → uniform 429, **no row written** (FR-011, SC-004). Because `getRegisteredAgent`
runs first, the cap only bites genuinely new anonymous registrations.

**Placement.** A small `checkRegistrationAdmission(ip)` in `rate-limit.js` called from the three
sites (or wrap `/mcp/auth/register` with `perIp('register')` middleware **and** gate the two
auto-register branches inline, since those aren't their own routes). Auto-register happens
mid-authorize, so it can't be pure middleware — an inline guard returning the OAuth-style
error/limit is required there.

**Alternatives considered.**
- *Require auth to register* — explicitly rejected by RD-2 (breaks the standard MCP onboarding
  funnel).
- *DB `COUNT` per day for the global cap* — rejected: a Redis counter with TTL is cheaper and
  matches the "budgets live in Redis" model; losing it on a Redis flush is acceptable (spec
  Assumptions / Edge Cases).

---

## R4 — Trust proxy hop count (US2, FR-014/015, RD-5)

**Decision.** Replace `app.set('trust proxy', true)` (index.js L64) with
`app.set('trust proxy', Number(process.env.TRUST_PROXY_HOPS ?? 1))`. Numeric hop count is
Express's spoof-proof form: `req.ip` is taken at the trusted depth of `X-Forwarded-For`, so
client-appended entries are ignored. Default 1 (immediate ingress only); prod sets 2 (CloudFront +
Traefik) via 011 deploy config.

**Consumers to keep working (FR-015).** `buildBaseUrl`/`server/url.js` and the helmet/HTTPS-redirect
and old-domain redirect logic read `req.protocol`/`req.get('host')`, which derive from the trusted
`X-Forwarded-Proto`. Verify these still resolve correctly at hop count 1 (dev/direct) and under a
simulated 2-hop chain. The CORS + discovery metadata (`buildProtectedResourceDoc`, OAuth metadata)
also call `buildBaseUrl` — same verification.

**Test (FR-015, SC-003).** supertest with `X-Forwarded-For: 1.2.3.4, 5.6.7.8` forged entries and
no header at all; assert `req.ip` (and thus the limiter key + logged IP) is the true socket/
trusted-hop address, and that forged entries yield 0 successful spoof-keyed requests over a budget.

**Alternatives considered.**
- *`trust proxy: 'loopback'` or a subnet list* — rejected: RD-5 mandates a numeric env hop count
  so one binary is correct across dev (1) and prod (2) by config, not code.

---

## R5 — Chat body bound + attachments over S3 (US3, FR-016..019, RD-6)

**Decision — body limit.** Change `express.json({ limit: '150mb' })` on `/api/chat` (index.js
L319) to `express.json({ limit: process.env.CHAT_BODY_LIMIT || '10mb' })`. Oversized bodies
already surface as `entity.too.large` → 413 via the existing error middleware (index.js L1466);
extend that branch (or a chat-specific guard) so the 413 body is **actionable**: tells the client
to use the attachment upload path (FR-017, Edge Cases: legacy inline-base64 tabs get this message).

**Decision — attachments.** New `POST /api/chat/attachments` (`requireAuth`) in
`server/api/chat-attachments.js`:
- Reuses `s3-images.putObject` with a **user-scoped key**: `chat-attachments/${userId}/${uuid}`.
  Returns a reference the client puts in the chat message in place of the base64 data URL.
- When `!s3Images.isEnabled()` → 503 with a clear message (FR-019, mirrors the doc-image path at
  index.js L688).
- Per-file constraints (mime allow-list, per-file size) mirror `document-images.storeImage`
  validation so limits are preserved (FR-018).
**Resolution (chat.js).** `extractMessageImages` (chat.js L400) and `inlineDataUrls` (L381) today
read base64 data URLs from message file parts. Extend the send path so a part carrying an
attachment **reference** is resolved by fetching bytes via `s3-images.getObject(key)` **after
verifying the key's `${userId}` segment equals `req.user.userId`** (user-scope enforcement,
FR-016). Resolved bytes feed both the model file parts and the `messageImages` array the
`insert_image` tool references — so model behavior is unchanged (FR-016 scenario 1, SC-005).
**Client.** In `AiChatContext.jsx` send path (`sendMessage(text, files)`, L595), upload each file
to `/api/chat/attachments` first, then send references instead of letting the AI SDK inline them as
data URLs. Keep drafts/retry working (files already tracked in `lastSentFilesRef`).

**No schema.** Ownership lives in the S3 key + resolve-time check; no DB row, honoring the "no new
schema" assumption. If implementation shows the S3 path can't carry attachment identity cleanly
(e.g. lifecycle/GC concerns), that gap goes to the ledger, not ad-hoc scope growth.

**Alternatives considered.**
- *Presigned direct-to-S3 PUT from the browser* — deferred: `s3-images` exposes `putObject`
  (server-proxied) and no presigned-PUT helper; server-proxied upload reuses existing validated
  code and keeps bytes off the chat JSON path all the same. A presigned helper can be added later
  if upload latency warrants.
- *Keep base64 but just lower the limit* — rejected: FR-016 mandates bytes leave the inline path;
  merely lowering the limit would break attachments instead of relocating them.

---

## R6 — Readiness endpoint (US4, FR-020..022, RD-4)

**Decision.** New `GET /ready` (unauthenticated, unwrapped by the limiter). Returns 200 iff:
`initialized === true` AND `draining === false` AND Postgres answers a trivial reachability query
within a short timeout. Else 503. Body: `{ status: 'ready'|'not_ready', datastore: 'up'|'down',
cache: 'up'|'down'|'degraded' }` — **no** versions/hostnames/connection detail (FR-022).
- **`initialized` flag**: set true at the end of the `server.listen` callback (index.js L1483)
  after `redisPubSub.init()` resolves; before that, `/ready` returns 503 (US4 scenario 4 — startup).
- **Reachability query**: a new `persistenceProvider.ping()` doing `SELECT 1` with a short
  `statement_timeout`/`Promise.race` timeout, releasing the connection immediately — must not hold
  a pool connection past the check (Edge Cases). Datastore query fail/timeout → `datastore: 'down'`
  → 503 within ~2s (SC-006).
- **Redis reported, not gating** (RD-4): `cache` reflects `isRedisReady()` / pubsub state but never
  changes the 200/503 decision — a cache outage must not pull every replica at once. Cache-down
  with datastore-up ⇒ 200 + `cache:'degraded'` (US4 scenario 3, FR-021).
- **`/health`** (index.js L472) stays exactly a liveness `200 {status:'ok'}`.

**Alternatives considered.**
- *Gate readiness on Redis too* — rejected by RD-4 (contradicts the design's stronger "Redis
  degrades gracefully, never removes the process" statement; would convert a cache blip into a
  full outage across both replicas).
- *Reuse `/health` with a query* — rejected: FR-022 requires `/health` to stay dependency-free so
  liveness and readiness signals stay separable (011 points only readiness at `/ready`).

---

## R7 — Postgres pool limits (US5, FR-023, RD-7)

**Decision.** In `postgres-persistence.js` constructor (L13, `new Pool(poolConfig)`), merge:
- `max: Number(process.env.DB_POOL_MAX) || 20`
- `connectionTimeoutMillis: Number(process.env.DB_POOL_ACQUIRE_TIMEOUT_MS) || 5000`
- `statement_timeout: Number(process.env.DB_STATEMENT_TIMEOUT_MS) || 30000` (node-pg applies this
  per pooled connection, server-side — pool sessions only).
2 replicas × 20 = 40 conns, under stock `max_connections` 100 with headroom for migrations/ops.
The migration job (`script/migrate.js`) and backup tooling are **separate processes** that build
their own connections and never touch this pool config, so they're unaffected (FR-023, RD-7 scenario 4).

**Test (SC-007).** Saturate the pool with `pg_sleep`/slow statements; assert an unrelated query
fails fast with the acquisition timeout (not minutes), and that the slow statements are killed at
`statement_timeout` so the pool self-recovers without a restart.

**Alternatives considered.**
- *`query_timeout` (client-side) instead of `statement_timeout`* — rejected: client-side timeout
  abandons the query but leaves it running server-side, so the pool doesn't recover. Server-side
  `statement_timeout` actually kills the offender (the property SC-007 asserts).

---

## R8 — Redis AUTH (US5, FR-024)

**Decision.** In `server/redis.js`, add the password to the shared `REDIS_CONFIG` (L4) **only when
set**, so it applies uniformly to `getRedisClient()` and `createPubSubClient()` (both read
`REDIS_CONFIG`):
```
...(process.env.REDIS_PASSWORD ? { password: process.env.REDIS_PASSWORD } : {})
```
Conditional spread means the config object is **byte-identical** when the var is unset (FR-024,
SC-008) — no `password: undefined` key introduced. Setting the password and enabling
`--requirepass` is 011's job; this change only makes the app capable.

**Test (SC-008).** With a password-protected Redis + `REDIS_PASSWORD` set, both the shared client
and a pub/sub client connect and function; with it unset against an unauthenticated Redis, the full
suite passes unchanged.

**Alternatives considered.**
- *Always include `password` (possibly undefined)* — rejected: FR-024 demands byte-identical
  behavior when unset; the conditional spread guarantees it.

---

## Cross-cutting decisions

- **Env var catalog** (all with documented defaults): `TRUST_PROXY_HOPS`=1, `SHUTDOWN_DEADLINE_MS`
  =20000, `CHAT_BODY_LIMIT`=10mb, `DB_POOL_MAX`=20, `DB_POOL_ACQUIRE_TIMEOUT_MS`=5000,
  `DB_STATEMENT_TIMEOUT_MS`=30000, `REDIS_PASSWORD`=(unset), and the `RL_*` budget vars per RD-1.
  Exact `RL_*` names are fixed in `contracts/rate-limiting.md`. These need to reach README/docs at
  converge (out of this agent's edit scope).
- **Test determinism for the limiter.** Provide a `_reset()` seam and a force-memory mode
  (e.g. `RL_FORCE_MEMORY=1`) so budget tests run deterministically without a live Redis, mirroring
  the pattern the pipeline used for 008/009 login budgets.
- **Ordering / independence.** The five slices are independently testable and independently
  valuable (matching the spec's priority framing); tasks.md groups by user story so P1 can ship
  and be verified before P2..P5.
