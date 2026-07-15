# Phase 0 Research: 009-rest-login-api

All product-level silences were resolved as RATIFIED-BY-DEFAULT in
[`clarifications-needed.md`](./clarifications-needed.md) (RD-1..RD-9, G1..G3). This file records
the **technical** decisions verified against code reality (2026-07-15), so no NEEDS CLARIFICATION
remains for implementation. Baseline contracts are 008's (unchanged inheritance).

## R1 — Shared per-IP login rate-limit budget across tool + REST start (RD-8)

- **Code reality**: `server/mcp/tools/login.js` gates with
  `rateLimit.consume(`login:ip:${ip}`, LOGIN_CALLS_PER_MINUTE_PER_IP, 60)` BEFORE calling
  `loginService.createPendingAuthorization`. The pending caps (per-IP 5, global 500) live inside
  `createPendingAuthorization` as Postgres `COUNT`s and are already flow-wide.
- **Decision**: Hoist the per-IP login rate-limit gate into ONE shared helper both callers invoke,
  so the key string `login:ip:${ip}` and the limit constant live in exactly one place. Options:
  `loginService.checkLoginRateLimit(ip)` (returns `{ allowed, retryAfterSeconds }`), or a tiny
  `server/mcp/auth/login-rate-limit.js`. Preferred: add it to `login-service.js` (already the
  orchestration seam that owns caps) and have `login.js` + `server/api/login.js` both call it.
- **Rationale**: Two hand-written copies of the key string is exactly how budgets silently double.
  A single helper makes RD-8 structural, not a review promise. `createPendingAuthorization` already
  runs the cap gates, so the pending-cap half of RD-8 needs no change.
- **Alternatives rejected**: (a) Duplicate the `rateLimit.consume('login:ip:'+ip, ...)` line in the
  REST handler — works today, drifts tomorrow. (b) Move the rate limit *inside*
  `createPendingAuthorization` — cleaner but changes the tool's current "gate then create" ordering
  and its uniform `rate_limited` result shape; out of scope (no state-machine change), so keep the
  gate in the wrappers via the shared helper.

## R2 — nextSteps belongs in the login-service delivery builder (RD-3, G3, FR-011/012)

- **Code reality**: Both the approved payload (`login-service.js` approved branch) and the inline
  payload (inline branch) are built inside `getStatus`, which both `login_status` (tool) and the
  future REST status route call. `getStatus` already takes `baseUrl`.
- **Decision**: Construct `nextSteps` once in `getStatus` and attach it to the approved payload and
  the inline payload. Do NOT add it to `POST /api/login/start` (not a delivery), and NEVER to the
  raw-byte claim response (RD-3 — would corrupt the credential file). A small pure builder
  `buildNextSteps(baseUrl, credentialFilePath)` keeps it testable and secret-free.
- **Rationale**: One builder, two consumers → they cannot drift (FR-012). Byte channel stays clean
  (G3/RD-3).
- **Alternatives rejected**: Building nextSteps in each route/tool handler — reintroduces the drift
  the spec explicitly forbids.

## R3 — Canonical claim path + alias as one handler (FR-007, RD-4)

- **Code reality**: `createLoginClaimRouter` registers `router.get('/api/mcp/login/claim', handler)`;
  handler is Bearer-only, keyed `claim:ip:${req.ip}`, uniform 404/429/409/500/200-bytes.
  `buildClaimCommand(baseUrl, handle)` emits the `/api/mcp/login/claim` URL.
- **Decision**: Register the SAME handler function at `['/api/login/claim', '/api/mcp/login/claim']`
  (Express array-path, or extract the handler and `router.get` it twice). Switch `buildClaimCommand`
  to emit `/api/login/claim`. One `claim:ip:` budget covers both URLs automatically (shared handler).
- **Rationale**: "Same handler mounted twice, not a copy" — byte-identical by construction and one
  budget for free (RD-8 claim half). Canonical becomes what the system teaches (RD-4); alias kept
  indefinitely for in-flight/stale transcripts (spec Out of Scope: no alias removal).
- **Alternatives rejected**: Copy the handler / second router — two code paths to keep byte-identical
  forever; also risks two budgets.

## R4 — REST status HTTP + auth mapping (RD-2, RD-5, RD-6)

- **Decision**: `GET /api/login/status`: HTTP 200 for every decision-table outcome
  (`pending`/`slow_down`/`approved`/`denied`/`expired`/`token_limit`), outcome in the `status` field,
  matching the tool's JSON so polling is byte-comparable. Handle from `Authorization: Bearer` ONLY;
  missing/malformed/wrong-scheme → the uniform `{ status: 'expired', ... }` (RD-6), byte-identical to
  a fabricated handle — no "you forgot the header" oracle. `?inline=true` query opt-in mirrors the
  tool's `inline:true` (RD-5): one-time in-band credential on approved, do-not-echo warning first,
  `token_limit` carve-out surfaced, all other inline failures → uniform expired. Any response
  carrying the credential (inline) → `Cache-Control: no-store` (FR-006).
- **`POST /api/login/start`**: 200 success, 400 on agentName validation failure (no pending created),
  429 + `Retry-After` on the uniform rate-limited outcome, 500 on unexpected error. Body is a
  superset of `{ userCode, verificationUri, handle, pollIntervalSeconds }` mirroring the tool payload
  (adds `status`, `expiresInSeconds`, REST-phrased `instructions`) — RD-1.
- **Rationale**: 200-with-status keeps the "same status contract" the design mandates; 400/429 are
  standard non-oracle transport errors; claim mapping is inherited unchanged.
- **Note (G2)**: The status route ships with NO per-IP transport limit (identical to the tool, which
  has only the per-handle slow-down). Ratified posture; a future ceiling is a both-channels-at-once
  operational constant, not a REST-only divergence.

## R5 — restApi discovery block + anonymous instructions (RD-7, FR-014/015/016)

- **Code reality**: `GET /mcp` handler in `server/mcp/index.js` returns
  `{ name, version, protocolVersion, capabilities, authentication }` from `buildBaseUrl(req)`.
  `ANON_SERVER_INSTRUCTIONS` is a ~700-char string well under 2 KB.
- **Decision**: Add `restApi: { loginStart: `${baseUrl}/api/login/start`, documentation:
  `${baseUrl}/agents.md#<choose-your-channel anchor>` }` (RD-7); all pre-existing fields
  byte-identical. Add one sentence to `ANON_SERVER_INSTRUCTIONS` naming the REST login path, keeping
  the existing critical content (unauthenticated state, two tools, both escape hatches, credential
  rule) leading and the string < 2 KB. The anchor must match the restructured agents.md heading slug.
- **Amend the pin deliberately (FR-015)**: `anonymous-surface.test.js` "GET /mcp discovery response
  is unchanged" is rewritten to assert the new `restApi` block AND continue pinning the pre-existing
  fields — evolved, not deleted; traceable to this spec.
- **Rationale**: Additive, minimal, self-describing; the design accepts strict-consumer breakage as
  a deliberate additive amendment (spec edge case), flagged in the pin not silently.

## R6 — "list docs" recipe target is GET /api/docs (G1)

- **Code reality verified**: `server/index.js` `app.get('/api/docs', requireAuth, ...)`;
  `requireAuth` → `permissions.extractUser` → `apiTokens.isApiToken`/`verifyToken`, so an
  `sk_sqd_` bearer token authenticates it. It is the only existing list route.
- **Decision**: The nextSteps "list docs" recipe uses `GET /api/docs` with the claimed bearer token;
  the restructured agents.md documents it in the REST section alongside export/import with a
  drift-guard pin (making the promotion explicit, not accidental). This feature does not change its
  response shape.
- **Rationale**: Honest application of the design's own "drift is a bug" rule — document what the
  payload teaches. Spec FR-011, FR-021; ledger G1.

## R7 — Testing strategy

- Reuse the `LOGIN_RATE_LIMIT_FORCE_MEMORY=1` + `rateLimit._reset()` deterministic-counter seam
  (see `mcp-login-claim.test.js`).
- **Cross-channel equivalence** is the signature new coverage: start via REST → poll via the
  `login_status` tool (call `loginService.getStatus`/tool handler directly) and the reverse; claim
  via canonical vs. alias byte-identical; one one-shot delivery across every channel pair; poll
  interval shared. This is what proves "one state machine, two doors."
- **Shared-budget tests**: spend part of the `login:ip:` budget via the tool handler, then assert the
  REST `start` on the same IP is 429 (not a fresh 10) — proves RD-8. Same for canonical+alias claim.
- **agents.md drift + restructure land in ONE task** so the suite is never red between tasks.

## Baseline (unchanged inheritance from 008)

`design/agent-surface-mcp.md` §"MCP-native onboarding (feature 008)" and 008 contracts
(`contracts/login-tools.md`, `claim-endpoint.md`, `anonymous-surface.md`) are the baseline; 008
ledger D1–D13 binding. Rate limits/caps/TTLs remain named operational constants in
`login-constants.js` (contracts-by-value). Handle carriage is Bearer-header-only on every login
route (008 review rule). No login state-machine, `/activate`, delegation, mint, or OAuth/PKCE change.
