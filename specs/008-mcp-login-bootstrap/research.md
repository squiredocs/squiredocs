# Research — 008-mcp-login-bootstrap

Phase 0 output. Each entry resolves a technical unknown or records a grounded decision
against code reality (files verified 2026-07-14 on `main`). Product-level decisions are
NOT re-decided here — D1–D12 in `clarifications-needed.md` are ratified; this document
covers implementation mechanics only.

---

## R1 — Where the anonymous allowlist lives

**Decision**: Replace `requireAgentAuth` on `POST /mcp` (`server/mcp/index.js:116`) with a
thin wrapper that (a) runs the existing token extraction/verification via
`optionalAgentAuth` semantics, and (b) if unauthenticated, inspects the parsed JSON-RPC
body: `initialize`, `tools/list`, and `ping` proceed anonymously; `tools/call` proceeds
only when `params.name ∈ {login, login_status}`; **everything else** falls through to the
exact same `buildChallenge(req, { branch })` + 401 JSON body that `requireAgentAuth`
produces today (same header string, same `{ error, code }` payload, byte-identical).
The convenience endpoint `POST /mcp/tools/call` gets the same allowlist treatment.

**Rationale**: `requireAgentAuth` is the single enforcement point where anonymous
requests 401 today (spec FR-001/D1 requires the allowlist "at the exact enforcement
point"). The middleware itself is shared (`requireAgentAuth` is also used elsewhere), so
the branch lives in the MCP router, not inside `middleware.js` — the challenge builder
(`buildChallenge`) is reused, not duplicated, keeping the 401 bytes identical by
construction. `optionalAgentAuth` already exists and already implements
"set `req.agentToken` if valid, else continue" — including the API-token fallback.

**One subtlety**: today an *invalid* (not missing) token 401s with `branch: 'invalid'`
even for `initialize`. That behavior is preserved: the anonymous allowlist applies only
to the **missing-credential** branch. A client presenting a broken/expired token still
gets the exact existing 401 (invalid/expired branches unchanged) — anonymous means *no*
credential, so "everything else byte-identical" holds for all today-reachable branches.

**Alternatives considered**: (1) A separate anonymous router mounted before the auth
middleware — rejected: duplicates JSON-RPC parsing and risks divergent error bytes.
(2) Making the login tools available through a dedicated endpoint — rejected: the design
requires them inside the standard MCP handshake/toolset.

## R2 — Anonymous tool listing and server instructions

**Decision**: `handleInitialize` and `handleToolsList` take an `isAnonymous` flag.
Anonymous `tools/list` returns `toolRegistry.getToolList().filter(t => ANON_TOOLS.has(t.name))`
(exactly `login`, `login_status`). Anonymous `initialize` returns a distinct
`ANON_SERVER_INSTRUCTIONS` string (< 2048 chars, same budget discipline as
`SERVER_INSTRUCTIONS`) stating: session is unauthenticated; two auth paths (call `login`
and relay code/URL to the user, or the client's native OAuth); poll `login_status`;
never move the credential through the conversation. Authenticated sessions get the
existing instructions (extended by ≤ 1 sentence only if needed; the 2KB budget is
already at ~1.5KB) and the full 18-tool list.

**Rationale**: FR-004/FR-005 and D2. Filtering at the handler keeps `tools/index.js` a
single registry (no parallel anonymous registry to drift).

## R3 — Pending-authorization storage: PostgreSQL, not Redis

**Decision**: A `mcp_pending_authorizations` table via node-pg-migrate (the feature's
single in-flight migration slot). Redis is used only for rate-limit counters (R7).

**Rationale**: One-shot and atomic-claim semantics are the heart of the feature and the
spec mandates SQL atomicity (`UPDATE … RETURNING`, FR-020, edge case "Concurrent claims
race"). Postgres gives: atomic conditional state transitions, FK to `agent_delegations`
+ the approving user, durable audit trail, and one consistent store for the state
machine. Redis in this codebase (`server/redis.js`) is optional-by-config
(`isRedisEnabled()`), so it cannot hold correctness-critical state. TTLs are enforced by
`expires_at`/`claim_expires_at` predicates in queries plus an opportunistic GC delete
(no background job needed at this scale; GC runs on each `login` call, bounded).

**Alternatives considered**: Redis-only store (rejected: optional dependency, no atomic
multi-column conditional update with FKs); in-memory map (rejected: multi-process and
restart-losing, and caps must be global).

## R4 — Handle and code generation, hashing, and lookup design

**Decision**:
- **Handle**: `crypto.randomBytes(32).toString('base64url')` (256 bits ≥ FR-006's 128-bit
  floor), prefixed `sqlh_` for recognizability in transcripts. Stored as
  `handle_hash = SHA-256(handle)` (hex); never stored plaintext. Lookup is by exact
  `handle_hash` index — hashing the presented handle server-side and querying by hash is
  both constant-time in the comparison sense (the DB compares digests of attacker input,
  not secrets; SHA-256 preimage resistance makes the index lookup non-oracular) and
  satisfies "codes hashed at rest if reasonable with lookup design". This is the exact
  pattern `mcp_auth_codes.code_hash` and `mcp_api_tokens.token_hash` already use.
- **User code**: 8 chars from the RFC 8628 §6.1 consonant alphabet
  `BCDFGHJKLMNPQRSTVWXZ` (D3), generated with rejection sampling from
  `crypto.randomBytes` (no modulo bias). Stored as `user_code_hash = SHA-256(normalized)`
  where normalization = uppercase, strip `[-\s]`. Uniqueness among *outstanding* pending
  authorizations is enforced by a partial unique index on `user_code_hash WHERE state =
  'pending'` with retry-on-conflict at insert (collision probability 20^-8 per pair;
  retry loop capped at 5).
- **Constant-time comparison**: for code entry, the submitted code is normalized, hashed,
  and looked up by hash; where a direct comparison is ever needed (defense in depth in
  the service layer), `crypto.timingSafeEqual` on the two digests. Comparing digests via
  hash-then-timingSafeEqual is the standard way to get constant-time behavior on
  variable-length attacker input.

**Rationale**: Matches existing at-rest posture (nothing secret in plaintext), reuses
proven lookup shapes, and satisfies FR-006/FR-009/FR-015/FR-026 (timing included).

## R5 — One-shot semantics in SQL

**Decision**: Every consuming transition is a single conditional `UPDATE … RETURNING`:

- **Code entry** (consume code, show consent): binds the row to the entering user but
  keeps state `pending` — code consumption is recorded via `code_entered_at` +
  `entered_by_user_id` with `WHERE user_code_hash = $1 AND state = 'pending' AND
  code_entered_at IS NULL AND expires_at > NOW()`. Second submission of the same code
  fails the predicate → generic invalid-or-expired.
- **Approve**: `UPDATE … SET state='approved', approved_by_user_id=$u, delegation_id=$d,
  approved_at=NOW(), claim_expires_at=NOW()+interval '5 minutes' WHERE id=$1 AND
  state='pending' AND expires_at > NOW() RETURNING *` — run *after* creating the
  delegation in the same pg transaction (single client, BEGIN/COMMIT), so a TTL-expired
  approve creates nothing (FR-018) and the token cap is checked inside the transaction
  (D7).
- **Approved-payload delivery** (one-shot `login_status` approved response):
  `UPDATE … SET payload_delivered_at=NOW() WHERE handle_hash=$1 AND state='approved' AND
  payload_delivered_at IS NULL AND claim_expires_at > NOW() RETURNING *`.
- **Claim** (REST or inline): `UPDATE … SET state='claimed', claimed_at=NOW(),
  claim_channel=$c WHERE handle_hash=$1 AND state='approved' AND claim_expires_at > NOW()
  RETURNING *` — exactly one concurrent claim wins; the winner then mints the token
  (D6). If minting fails (token cap race, FR-022), the claim transaction rolls back so
  the authorization stays claimable until the window lapses.
- **Deny**: `UPDATE … SET state='denied' WHERE id=$1 AND state='pending' RETURNING id`.

**Rationale**: Spec constraint — "one-shot semantics enforced in SQL (atomic UPDATE …
RETURNING), not read-then-write". Postgres row-level locking under READ COMMITTED makes
concurrent conditional updates serialize with exactly one winner.

## R6 — Mint-at-delivery and auto-revoke of unclaimed approvals (D6/FR-021)

**Decision**: Approval creates only the delegation (delegation `agent_id` =
`mcp-login:<authorization uuid>` — unique per pairing, so `createDelegation`'s
`ON CONFLICT (user_id, agent_id)` upsert can never collide with an OAuth-born row).
The `sk_sqd_` token is minted inside the claim transaction via
`apiTokens.createToken(userId, name, { scopes, expiresAt: +30d, mintedByDelegationId })`
with `name = "<agentName> (via MCP login)".slice(0,255)` (FR-019: recognizably derived).
Auto-revoke of a lapsed approval is **lazy**: any observation of an `approved` row whose
`claim_expires_at <= NOW()` (a poll, a claim attempt, or the opportunistic GC pass on
`login`) executes `UPDATE … SET state='expired' WHERE id=$1 AND state='approved' AND
claim_expires_at <= NOW() RETURNING delegation_id`, and on success calls
`delegation.revokeDelegation(delegation_id)` (which already cascades to minted tokens).
GC on `login` sweeps all lapsed approvals, so Settings shows no zombie pairing for
longer than the gap to the next anonymous login call — plus the same sweep runs in
`handleListDelegations`-adjacent paths? **No** — keep it to the three trigger points
(poll, claim, login-GC); Settings reads are left untouched to avoid touching the OAuth
surface. The claim-window lapse bound is minutes and self-corrects on the next flow.

**Rationale**: Zero plaintext secret at rest (G3/D6); reuses the existing cascade;
no new background scheduler (constitution III — no ceremony/processes without a
concrete failure).

## R7 — Rate limiting: no existing middleware; build a small Redis-backed limiter

**Decision**: There is **no** rate-limit middleware in the codebase today (verified:
no `express-rate-limit` dependency, no `rateLimit` pattern under `server/`). Add
`server/mcp/auth/rate-limit.js`: a fixed-window counter — `INCR key` + `EXPIRE key
window` on first increment — keyed per concern (`login:ip:<ip>`, `code:user:<id>`,
`code:ip:<ip>`, `claim:ip:<ip>`), using `getRedisClient()` from `server/redis.js`. When
Redis is disabled/unavailable (`isRedisEnabled()`/`isRedisReady()` false — e.g. the test
environment), fall back to an in-process `Map` with periodic pruning; the module exposes
`_reset()` for tests. Pending-authorization **caps** (5/IP, 500 global, D10) are NOT
counters — they are `SELECT COUNT(*)` against `mcp_pending_authorizations WHERE state =
'pending' AND expires_at > NOW() [AND origin_ip = $ip]`, checked in the `login` handler
(caps must reflect true outstanding rows, and rows expire without an explicit event).
Poll-interval enforcement (5s minimum, slow_down +5s/violation, D8) is per-handle
state on the row itself: `last_polled_at` + `required_poll_interval_seconds` columns,
updated in the same query that reads status (no extra round trip, works without Redis).

**Client IP**: use `req.ip` with Express `trust proxy` as configured for the app (the
app already runs behind an ingress; verify `trust proxy` setting at implementation and
set it if absent — otherwise per-IP limits would key on the ingress IP; note this in
tasks).

**Rationale**: Smallest thing that satisfies FR-024/025 with named tunable constants;
fixed-window is sufficient at these thresholds; correctness-critical caps live in
Postgres, ephemeral abuse counters in Redis (mirrors R3's split). No new dependency.

## R8 — Claim endpoint shape

**Decision**: `GET /api/mcp/login/claim` in a new `server/api/mcp-login-claim.js`
(`createLoginClaimRouter(persistence)` mounted in `server/index.js` beside
`createExportRouter`). Auth is **only** the handle, presented as
`Authorization: Bearer <handle>` (recipe default) with `?handle=` accepted as a
fallback for curl-challenged environments. NOT behind `requireAuth` (the caller has no
user credential; the handle is the credential). Success: `200`,
`Content-Type: text/plain; charset=utf-8`, body = the `sk_sqd_` token + trailing
newline, `Cache-Control: no-store`. Every failure (unknown/consumed/expired handle,
malformed request) after rate-limit check: uniform `404 { "error":
"invalid_or_expired" }` — indistinguishable across causes (FR-020, D5). Rate limit 429
(10/min/IP) is the only distinct failure and leaks nothing per-handle. The one
actionable exception mandated by FR-022: a mint-time token-cap failure returns `409
{ "error": "token_limit", "message": "…revoke a token in Settings, then retry…" }` —
distinct by spec requirement, and reachable only with a live approved handle (no
enumeration value).

**Claim recipe** (in the approved `login_status` payload):
```
umask 077 && curl -fsS -H "Authorization: Bearer <handle>" \
  "<baseUrl>/api/mcp/login/claim" -o ~/.squire/credential && chmod 600 ~/.squire/credential
```
plus persist-and-reconnect and never-print/echo/paste instructions (FR-011).

**Rationale**: Bearer-header keeps the handle out of server access logs' query strings;
text/plain body writes straight to disk (`-o file`) with zero parsing; the 409 carve-out
is spec-mandated (FR-022) and safe.

## R9 — /activate page: client-rendered SPA route mirroring AuthorizePage

**Decision**: The existing consent page (`/authorize`) is a **client-side React route**
(`client/src/App.jsx` `parseRoute()` → `client/src/pages/AuthorizePage.jsx`), not
server-rendered. Mirror it exactly: add `/activate` to `parseRoute()`, new
`ActivatePage.jsx` reusing the `AuthorizeShell`/`LoginPage.css` visual language and the
identical login round-trip
(`/login?returnTo=${encodeURIComponent(pathname + search)}` — same-origin relative path,
existing open-redirect defenses from feature 005 apply). Page states: (1) signed-out →
sign-in prompt; (2) code entry form (normalizes case/hyphens/whitespace client-side for
UX; server re-normalizes authoritatively); (3) consent card — skeptical framing
("An agent calling itself **<name>** …", name rendered as React text node = inert by
construction, never `dangerouslySetInnerHTML`), exact scopes, Approve/Deny; (4) result
states (approved → "agent can now connect; manage in Settings", denied, expired with
"ask your agent to log in again", token-cap failure with Settings pointer).

Backend routes for the page (session-authenticated via existing `requireAuth`,
mounted on the oauth router or a sibling `login-router.js` under `/mcp/login`):
- `POST /mcp/login/code` — body `{ code }`; consumes the code (R5), returns
  `{ authorizationId, agentName, scopes, expiresAt }` or generic failure.
- `POST /mcp/login/decision` — body `{ authorizationId, approved }`; approve/deny (R5).
Both rate-limited per D10 (5/min/user, 20/hr/IP for code entry).

**Rationale**: "Mirror the existing consent page approach" (plan constraint). React
text rendering gives inert-by-default agentName display (FR-008/FR-016). Server-side
authoritative normalization + hashing keeps the client cosmetic-only. The two POST
routes carry no OAuth semantics, so the transport OAuth surface is untouched.

**SPA-serving check**: `/activate` must be added wherever the server decides which paths
serve `index.html` (same mechanism that serves `/authorize`); verified `client/dist`
fallback covers unknown paths via the SPA catch-all — implementation task confirms
`/activate` reaches the SPA in prod build (the documentation site and legal pages
already use this pattern).

## R10 — Consent-page agent identity: no `registered_agents` row

**Decision**: The `/activate` consent card renders from the pending-authorization row
(`agent_name_display`), NOT from `GET /mcp/auth/agents/:clientId` (which serves OAuth
clients from `registered_agents`). Login-flow agents are never inserted into
`registered_agents`; the delegation's `agent_name` is the self-declared name and
`agent_id` is `mcp-login:<authorization uuid>` (R6), keeping Settings display working
via the existing `LEFT JOIN registered_agents` (join misses → falls back to
`d.agent_name`, verified in `handleListDelegations`).

**Rationale**: `registered_agents` models OAuth clients (redirect URIs, allowed scopes)
— none of which exist here; a synthetic row would pollute the OAuth surface the spec
freezes. The LEFT JOIN fallback already handles delegation-only agents.

## R11 — Tool registry integration for no-scope tools

**Decision**: Register `login`/`login_status` in `server/mcp/tools/index.js` with **no
entry** in `TOOL_SCOPES` (the scope gate in `executeTool` only fires when
`TOOL_SCOPES[name]` is truthy — verified; absent key ⇒ no scope required, FR-004).
Tool handlers receive `agentToken = null` for anonymous callers (today's
`handleToolCall` assumes `agentToken` exists — it reads `.delegationId` and sets
`.baseUrl`; the dispatch wrapper passes a minimal `{ isAnonymous: true, baseUrl }`
synthetic context instead of null to avoid crashing the shared code path, and skips
`logAgentAction`, which is already conditional on `delegationId`). The tools also work
identically for authenticated callers (D2). The `login` tool needs the request IP for
caps: the wrapper adds `clientIp` to the synthetic/augmented token context the same way
`baseUrl` is added today.

**Rationale**: Minimal diff to the registry; no special-case registry forks; the
existing conditionality (`if (agentToken.delegationId)`) already tolerates
non-delegation principals.

## R12 — agents.md + drift guard extension

**Decision**: Rewrite the in-session section of `client/public/agents.md`: the login
bootstrap becomes the recommended path for agents already inside a session (connect
anonymously → `login` → relay URL + code bare on its own line → poll politely → claim
over REST → persist 0600 → user restarts/reconnects), keeping the existing
`claude mcp add` + `--continue`/`--resume` guidance for the *reconnect* step and keeping
the full PKCE walkthrough for MCP-native onboarding (FR-028: "superseding **most** of
the localhost-callback coaching **for that case**" — the PKCE anchors pinned by tests
(g)–(l) remain present). Tool count phrase updated to eighteen. Extend
`server/__tests__/agents-md-claims.test.js` with pins: (m) names both `login` and
`login_status`; (n) recommended-path framing for in-session agents (tolerant regex);
(o) mentions `/activate`; (p) claim mechanics (`/api/mcp/login/claim`, writes to a
file, 0600/owner-only); (q) credential-handling rule (never print/echo/paste); (r) tool
count "eighteen"; (s) PKCE walkthrough anchors still present (reuses (j)–(l) as-is —
they already pin this; add an explicit count-claim guard only).

**Rationale**: FR-028/FR-029; tolerant regexes per the C8 precedent already noted in
that test file.

## R13 — Testing strategy and DB hygiene

**Decision**: Backend tests are Jest + supertest, run serially (`--runInBand`, shared
`collab_test_db`). New tables are cleaned per-suite via the existing pattern
(TRUNCATE-style cleanup in `beforeEach`/`afterAll` — mirror
`server/mcp/__tests__/auth/api-token-routes.test.js`). Concurrency test for the atomic
claim: fire N parallel claims via `Promise.all` against supertest and assert exactly one
200 (row-lock serialization makes this deterministic). Timing-oracle tests assert
*response-shape* indistinguishability (identical status + body across exists/not-exists),
not wall-clock timing (flaky); constant-time primitives are asserted by construction
(hash-lookup + `timingSafeEqual` unit tests). OAuth invariance: run existing
`server/mcp/__tests__/auth/` suites unchanged (SC-003) plus an explicit
`anonymous-surface.test.js` asserting the 401 challenge header/body for a non-login
anonymous `tools/call` matches `buildChallenge` output pre-feature.

**Rationale**: Constitution II; memory note "backend test DB is serial-only".

## R14 — Migration slot and shape

**Decision**: Single migration `1794000000000_create-mcp-pending-authorizations.js`
(next slot after `1793000000000_add-on-behalf-of-to-updates.js`; feature 008 owns the
only in-flight slot). Table + partial indexes per data-model.md; `delegation_id` FK
`ON DELETE SET NULL` (soft-revocation is the real mechanism — mirrors the
minted-by-columns precedent), `approved_by_user_id`/`entered_by_user_id` FK to users
`ON DELETE CASCADE`.

**Rationale**: node-pg-migrate is constitutionally mandated; SET NULL precedent from
`1792000000000_add-minted-by-to-mcp-api-tokens.js`.
