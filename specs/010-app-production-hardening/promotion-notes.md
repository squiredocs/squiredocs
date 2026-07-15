# Promotion / Converge Hand-off Notes — 010-app-production-hardening

Implementation is **server/app code only** (no k8s manifests, no migrations), on branch
`010-app-production-hardening`. This file is the hand-off for the merge/converge/deploy owner.
Doc convergence is deliberately **not** done in this worktree (finding C1 / pipeline override):
`README.md`, `CLAUDE.md`, and `docs/dev.md` were not edited here.

---

## 1. New HTTP surface to document (README.md + docs/dev.md)

- **`GET /ready`** — unauthenticated, rate-limit-exempt readiness probe. 200 iff the process
  finished startup, is not draining, and Postgres answers `SELECT 1` within a short timeout;
  503 otherwise. Body `{status, datastore, cache}`; Redis/cache is reported but never gates
  (RD-4). No secrets/versions/hostnames. (`GET /health` is unchanged — pure liveness.)
- **`POST /api/chat/attachments`** — `requireAuth`. Uploads one image to S3 under
  `chat-attachments/<userId>/<uuid>` and returns `{ reference, mediaType, filename }`. The chat
  body now carries the `attachment:<key>` reference instead of inline base64; `chat.js` resolves
  it (user-scoped) when assembling model messages. 503 when S3 is unconfigured.

## 2. Env-var catalog to document (all overridable; defaults are the shipped behavior)

| Var | Default | Purpose |
|-----|---------|---------|
| `TRUST_PROXY_HOPS` | `1` | numeric trusted-proxy hop count (**prod: set 2** — CloudFront+Traefik) |
| `SHUTDOWN_DEADLINE_MS` | `20000` | graceful-drain force-exit backstop (must stay < the 30s grace period) |
| `CHAT_BODY_LIMIT` | `10mb` | `/api/chat` inline JSON body cap |
| `CHAT_ATTACHMENT_LIMIT` | `25mb` | `POST /api/chat/attachments` body cap (single ~15MB image as base64) |
| `DB_POOL_MAX` | `20` | pg app-pool max connections |
| `DB_POOL_ACQUIRE_TIMEOUT_MS` | `5000` | pg connection acquisition timeout |
| `DB_STATEMENT_TIMEOUT_MS` | `30000` | pg per-session server-side statement timeout (app pool only) |
| `REDIS_PASSWORD` | (unset) | Redis AUTH; **unset ⇒ byte-identical** to prior behavior |
| `RL_AUTH_PER_MIN` | `30` | per-IP `/auth/*` budget |
| `RL_TOKEN_PER_MIN` | `30` | per-IP `POST /mcp/auth/token` budget |
| `RL_REGISTER_PER_HOUR` | `5` | per-IP registration budget (shared w/ auto-register) |
| `RL_REGISTER_GLOBAL_PER_DAY` | `200` | global daily anonymous-registration cap |
| `RL_SEARCH_PER_MIN` | `30` | per-user content-search budget |
| `RL_IMPORT_PER_MIN` | `10` | per-user markdown-import budget |
| `RL_EXPORT_PER_MIN` | `20` | per-user document-export budget |
| `RL_CHAT_PER_MIN` | `30` | per-user chat budget |
| `RL_FORCE_MEMORY` | (unset) | set `1` to force the per-process limiter (dev/tests) |
| `RL_TEST_ENABLE` | (unset) | test-only: set `1` to activate limiting under `NODE_ENV=test` |

Also catalogued in a comment block at the top of `server/index.js` for the converge step.

## 3. Feature-011 hand-offs (NOT done here — cross-feature, 011 owns)

1. **Repoint the k8s `readinessProbe` to `GET /ready`.** 010 only ships the endpoint.
2. **Provision `REDIS_PASSWORD` and run Redis with `--requirepass`.** 010 only made
   `server/redis.js` *honor* the var when set (unset ⇒ byte-identical). No Redis is password-
   protected by this feature.

## 4. Secondary deploy-config alignments for the merge/deploy owner

- Set **`TRUST_PROXY_HOPS=2`** in the production environment (client → CloudFront → Traefik → app).
  Default 1 is correct for dev/Minikube.
- Ensure the orchestrator's **`terminationGracePeriodSeconds` > `SHUTDOWN_DEADLINE_MS`** (default
  20s deadline needs the 30s default grace, RD-8) so the graceful drain isn't SIGKILLed early.

## 5. I1 decision-point outcome (reference-based attachments held — NO migration)

The plan's I1 flagged that IF chat attachments turned out to need a DB metadata row / schema
change, that would be a migration = **out of scope**, to be ledgered rather than added.
**Implementation confirmed the reference-based approach is sufficient**: attachment identity is
the S3 object at `chat-attachments/<userId>/<uuid>`, ownership is encoded in the key and
re-verified at resolve time (user-scope check in `chat.js`). **No DB row, no schema change, no
migration was added.** I1 is honored as-designed; nothing further is required of the migration
owner for this feature. (Recorded in `clarifications-needed.md` as well.)

## 6. Verification note for the merge tree (environmental)

The repo's Jest config excludes `/.claude/worktrees/` via `testPathIgnorePatterns` +
`modulePathIgnorePatterns` (so the main tree skips worktrees). Consequently a bare `npm test`
run **from inside this worktree** discovers zero backend tests. To verify here, the backend suite
was run with those two ignore patterns overridden (`--testPathIgnorePatterns '/node_modules/'
'/client/' --modulePathIgnorePatterns '/node_modules/'`). In the **main tree** after merge,
`npm test` picks up the suite normally — no override needed. Also note: the shared dev Redis is
currently in a MISCONF (RDB-snapshot-failing) state that rejects writes, so the Redis-backed
limiter path exercises its memory-insurance degrade fallback; the shared-store persistence
assertion in `rate-limit-degrade.test.js` self-skips with a logged note when Redis is not
writable, and runs for real against a healthy Redis.
