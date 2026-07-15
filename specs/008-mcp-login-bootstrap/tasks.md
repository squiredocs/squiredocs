# Tasks: MCP-Native Onboarding — the login Tool

**Input**: Design documents from `/local-dev/specs/008-mcp-login-bootstrap/`
**Prerequisites**: plan.md, research.md, data-model.md, contracts/, quickstart.md

**Tests included**: YES — Constitution Principle II makes test-backed changes mandatory; the spec demands unit + route-level (supertest) coverage for every state transition and abuse limit. Backend tests run serially only (`npx jest --runInBand` — shared DB).

**Organization**: Tasks grouped by user story (US1–US5 from spec.md). US1 delivers the full agent-side journey with route-level approval (no UI); US3 adds the human browser half; US2 hardens the secret channel; US4 the abuse posture; US5 the documentation front door.

**Pipeline overrides**: stay on `main`'s assigned tree; no branches; no commits from this phase.

## Phase 1: Setup

- [X] T001 Create migration `migrations/1794000000000_create-mcp-pending-authorizations.js`: table `mcp_pending_authorizations` with all columns, CHECK constraints, and FKs per data-model.md (`delegation_id` → agent_delegations ON DELETE SET NULL; `entered_by_user_id`/`approved_by_user_id` → users ON DELETE CASCADE); indexes: UNIQUE(handle_hash), partial UNIQUE(user_code_hash) WHERE state='pending', partial (origin_ip) WHERE state='pending', partial (state, claim_expires_at) WHERE state='approved'; `exports.down` drops the table. Run `npm run migrate up` in the dev pod to verify.
- [X] T002 [P] Create `server/mcp/auth/login-constants.js` exporting every named operational constant from data-model.md §Operational constants (AUTHORIZATION_TTL_SECONDS=600, CLAIM_WINDOW_SECONDS=300, MIN_POLL_INTERVAL_SECONDS=5, SLOW_DOWN_INCREMENT_SECONDS=5, CREDENTIAL_TTL_DAYS=30, USER_CODE_LENGTH=8, USER_CODE_ALPHABET='BCDFGHJKLMNPQRSTVWXZ', AGENT_NAME_MAX_LENGTH=100, MAX_PENDING_PER_IP=5, MAX_PENDING_GLOBAL=500, LOGIN_CALLS_PER_MINUTE_PER_IP=10, CODE_ATTEMPTS_PER_MINUTE_PER_USER=5, CODE_ATTEMPTS_PER_HOUR_PER_IP=20, CLAIM_ATTEMPTS_PER_MINUTE_PER_IP=10, HANDLE_PREFIX='sqlh_').
- [X] T003 [P] Verify Express `trust proxy` configuration in `server/index.js` so `req.ip` reflects the client behind the ingress (research R7); set `app.set('trust proxy', ...)` appropriately if absent, with a comment explaining the per-IP limits depend on it.

## Phase 2: Foundational (blocking prerequisites for all stories)

- [X] T004 Create `server/mcp/auth/pending-authorizations.js` store (init(pool) singleton like delegation.js): `create({agentNameDisplay, handleHash, userCodeHash, originIp})` with partial-unique-code retry (cap 5); `findByHandleHash`; atomic transitions per research R5 as single conditional `UPDATE … RETURNING` methods — `consumeCode(userCodeHash, userId)`, `approve(id, userId, delegationId, claimWindowSeconds)` (caller-managed client/transaction), `deny(id)`, `markPayloadDelivered(handleHash)`, `claim(handleHash, channel)` (caller-managed transaction), `expireLapsedApproved()` returning `[{id, delegation_id}]`, `expireLapsedPending()`, `deleteTerminalOlderThan(hours)`; count helpers `countPendingByIp(ip)`, `countPendingGlobal()`; poll bookkeeping `recordPoll(handleHash)` returning `{prematue, requiredInterval}` semantics per D8 (update `last_polled_at` + increment `required_poll_interval_seconds` on violation in one statement).
- [X] T005 [P] Create `server/mcp/auth/rate-limit.js` per research R7: fixed-window `consume(key, limit, windowSeconds)` using `getRedisClient()` INCR+EXPIRE when `isRedisEnabled() && isRedisReady()`, in-process Map fallback otherwise; export `_reset()` for tests; no new dependencies.
- [X] T006 Create `server/mcp/auth/login-service.js` orchestration layer (init(pool)): `generateHandle()` (crypto.randomBytes(32) base64url, `sqlh_` prefix) + `hashHandle()`; `generateUserCode()` (rejection sampling over USER_CODE_ALPHABET, grouped display `XXXX-XXXX`) + `normalizeCode()` (uppercase, strip `[-\s]`) + `hashCode()`; `validateAgentName()` per D9 (trim, non-empty, ≤100 chars, reject control chars `/[\x00-\x1F\x7F]/`); `createPendingAuthorization({agentName, ip, baseUrl})` running the lazy GC sweep (research R6: expire lapsed approved rows + revokeDelegation cascade, expire lapsed pendings, delete terminal >24h) then caps then insert; `getStatus(handle, {inline})` implementing the full login_status decision table from contracts/login-tools.md (slow_down, pending, denied, uniform expired, one-shot approved payload with claim recipe, one-shot inline delivery via the same claim transition); `approveAuthorization(authorizationId, userId)` (token-cap pre-check → createDelegation with agent_id `mcp-login:<id>` → atomic approve, single pg transaction, rollback if TTL lapsed — contracts/activate-consent.md); `denyAuthorization(authorizationId, userId)`; `claimCredential(handle, channel)` (atomic claim → checkDelegation → apiTokens.createToken with name `"<agentName> (via MCP login)"`, scopes = delegation scopes, expiresAt now+30d, mintedByDelegationId — same transaction, rollback on mint failure keeping row approved; distinguish token-cap error for the 409 carve-out).
- [X] T007 Unit tests for the store in `server/mcp/__tests__/auth/pending-authorizations.test.js`: every transition's atomic predicate (approve on expired row returns 0 rows; deny on non-pending returns 0; double consumeCode fails; double markPayloadDelivered fails; concurrent `claim` via Promise.all yields exactly one winner); code-uniqueness retry; GC sweep marks + returns lapsed approvals; poll bookkeeping increments required interval. Serial DB hygiene per existing auth test suites.
- [X] T008 [P] Unit tests for service primitives in `server/mcp/__tests__/auth/login-service.test.js`: handle entropy/prefix/hash; code alphabet/rejection-sampling bounds/normalization (case, hyphen, whitespace); agentName validation matrix (empty, whitespace-only, 101 chars, control chars, valid 100-char, hostile-but-legal names accepted); timingSafeEqual digest-comparison helper.

**Checkpoint**: store + service + limiter green in isolation — user stories can begin.

## Phase 3: User Story 1 — Sandboxed agent bootstraps a credential through MCP itself (P1) 🎯 MVP

**Goal**: Anonymous MCP session exposes exactly `login`/`login_status`; full journey login → (route-level) approve → poll approved-once → REST claim → reconnect authenticated with standard toolset. UI-less: approval driven via the backend routes.

**Independent test**: quickstart.md §2 with step (d) replaced by direct `POST /mcp/login/code` + `POST /mcp/login/decision` calls under a session token; verify credential never appears in any tool result except via claim; reconnect lists 18 tools.

- [ ] T009 [P] [US1] Create `server/mcp/tools/login.js` per contracts/login-tools.md: name/description (≤2048 chars)/inputSchema/handler/init; handler validates agentName, runs abuse gates in order (login rate → per-IP cap → global cap) returning the uniform retriable `rate_limited` result, else creates the pending authorization and returns handle/userCode (grouped)/verificationUri (`<baseUrl>/activate`)/expiresInSeconds/pollIntervalSeconds/instructions; uses `agentToken.clientIp` and `agentToken.baseUrl` from the dispatch context.
- [ ] T010 [P] [US1] Create `server/mcp/tools/login-status.js` per contracts/login-tools.md: delegates to `loginService.getStatus(handle, {inline})`; returns the exact status shapes (slow_down / pending / denied / uniform expired / one-shot approved payload with claimCommand + persist-and-reconnect + never-print instructions / inline with do-not-echo warning).
- [ ] T011 [US1] Register both tools in `server/mcp/tools/index.js`: imports, `tools` map entries, NO `TOOL_SCOPES` entries (no-scope tools, FR-004); export `ANON_TOOL_NAMES = ['login', 'login_status']` (or equivalent) for the dispatch filter; wire `loginService.init` from `server/mcp/index.js` init().
- [ ] T012 [US1] Implement the anonymous dispatch in `server/mcp/index.js` per contracts/anonymous-surface.md: replace `requireAgentAuth` on `POST /mcp` (and `POST /mcp/tools/call`) with a wrapper that authenticates when a credential is present (existing branches byte-identical, including invalid/expired 401s), and when NO credential: allow `initialize`/`tools/list`/`ping`/`tools/call`∈allowlist with synthetic context `{isAnonymous: true, baseUrl, clientIp}` (skip logAgentAction — already conditional on delegationId), 401 via `buildChallenge(req, {branch:'missing'})` + `{error:'No agent token provided', code:'MISSING_TOKEN'}` for everything else; add `clientIp` to authenticated tool context too (authenticated `login` calls need it, D2); `handleInitialize`/`handleToolsList` take `isAnonymous` — anon instructions constant `ANON_SERVER_INSTRUCTIONS` (<2048 chars, per contract) and two-tool filtered list; apply the same anonymous two-tool filter to the debug convenience endpoint `POST /mcp/tools/list` (unauthenticated today — must not enumerate the full toolset anonymously).
- [ ] T013 [US1] Create `server/mcp/auth/login-router.js` with session-authenticated `POST /mcp/login/code` and `POST /mcp/login/decision` per contracts/activate-consent.md (rate limits, uniform `invalid_or_expired`, ownership check entered_by_user_id === session user, 409 token_limit keeping authorization pending, 410 expired-approve); mount at `/mcp/login` in `server/index.js` BEFORE `app.use('/mcp', mcp.router)` (Express matches `/mcp/login/...` against the `/mcp` router otherwise — same reason `/mcp/auth` is mounted first).
- [ ] T014 [US1] Create `server/api/mcp-login-claim.js` (`createLoginClaimRouter(persistence)`) implementing GET /api/mcp/login/claim per contracts/claim-endpoint.md (Bearer-handle or ?handle=, per-IP rate limit before handle inspection, uniform 404 `{"error":"invalid_or_expired"}`, 409 token_limit carve-out, 200 text/plain token+`\n` with Cache-Control: no-store); mount in `server/index.js` beside createExportRouter.
- [ ] T015 [US1] Route-level happy-path + state-machine test `server/mcp/__tests__/auth/login-flow.test.js` (supertest): anonymous initialize/tools-list shows exactly two tools; login returns code+handle; poll pending; code entry + approve via `/mcp/login/*` routes under a session; next poll returns approved payload exactly once (contains claimCommand, contains NO `sk_sqd_`), second poll → expired; REST claim returns token bytes once, second claim 404; reconnect with claimed token authenticates (tools/list length 18, list_documents succeeds) with standard delegation attribution (delegation row agent_id `mcp-login:<id>`, token minted_by_delegation_id set); deny path terminal; TTL-lapsed approve → 410 + no delegation row; authenticated caller can also call login (D2).
- [ ] T016 [P] [US1] Tool-module tests `server/mcp/__tests__/tools/login.test.js` + `server/mcp/__tests__/tools/login-status.test.js`: handler contract shapes per contracts/login-tools.md including validation failures creating no rows, rate_limited shape, inline-while-pending returns plain pending.
- [ ] T017 [US1] Update `server/mcp/__tests__/tools/tool-modules.test.js`: add `login` and `login-status` to `toolModules` smoke list and `login`/`login_status` to `expectedTools`; registry count assertion 16 → 18; assert both new descriptions ≤ 2048 chars (covered by the shared loop); assert `ANON_SERVER_INSTRUCTIONS` and `SERVER_INSTRUCTIONS` each ≤ 2048 chars (import from `server/mcp/index.js` — export them for the test).

**Checkpoint**: US1 delivers the MVP — a credential-less agent can bootstrap end-to-end without a browser UI (routes driven directly).

## Phase 4: User Story 2 — The credential never transits the conversation (P2)

**Goal**: One-shot atomic delivery on both channels; the secret only ever moves over the byte channel unless explicitly opted into inline.

**Independent test**: quickstart.md §2e–2f plus concurrency and window checks; inline opt-in forecloses REST and vice versa.

- [ ] T018 [US2] Claim-endpoint test `server/__tests__/mcp-login-claim.test.js` (supertest): first claim 200 text/plain + trailing newline + no-store header; N=8 concurrent claims via Promise.all → exactly one 200, rest 404 byte-identical; claim after 5-min window → 404 AND delegation revoked (FR-021 lazy sweep on claim); fabricated/malformed/missing handle → the same 404 body; query-param fallback works; mint-failure rollback: fill the user to 25 active tokens after approval, claim → 409 token_limit, row stays approved, revoke one token, retry claim within window → 200 (FR-022 re-check at mint time).
- [ ] T019 [US2] Inline-delivery tests in `server/mcp/__tests__/auth/login-flow.test.js` (extend): `login_status({handle, inline:true})` on approved returns credential exactly once with the do-not-echo warning prefix; subsequent inline and REST claims both fail uniformly; conversely a REST claim forecloses inline (claim_channel recorded); default (non-inline) approved payload verified to carry recipe + 0600 guidance + persist-and-reconnect + never-print instructions and no credential (FR-011 a/b/c).
- [ ] T020 [US2] Payload one-shot loss scenario test (ledger D12 edge case) in `server/mcp/__tests__/auth/login-flow.test.js`: after the approved payload is delivered, polling says expired but the retained handle still claims successfully within the window — the exact "approved response lost in transit" recovery contract.

**Checkpoint**: channel rule proven — SC-002/SC-005 hold under concurrency.

## Phase 5: User Story 3 — The user activates with skeptical consent and stays in control (P3)

**Goal**: The `/activate` browser experience: login round-trip, forgiving code entry, skeptical named+scoped consent, honest failure states, Settings revocability.

**Independent test**: quickstart.md §2d driven in a real browser against a pending authorization; Vitest component coverage for page states.

- [ ] T021 [P] [US3] Create `client/src/pages/ActivatePage.jsx` per contracts/activate-consent.md: states signed-out (login link `/login?returnTo=` with current path+search), code-entry form (client-side cosmetic normalization, submit to `POST /mcp/login/code`), consent card (skeptical line `An agent calling itself “<name>” requests access to your documents` with self-declared/unverified sub-text, agentName rendered ONLY as a React text node, exact scopes via existing SCOPE_DESCRIPTIONS copy, Approve/Deny → `POST /mcp/login/decision`, signed-in-as row, Settings revoke note), and result states (approved-confirmation pointing at Settings, denied "nothing was granted", generic invalid-or-expired, 410 expired-approve "ask your agent to log in again", 409 token-limit with Settings pointer); reuse AuthorizeShell/LoginPage.css visual language (new ActivatePage.css only if needed).
- [ ] T022 [US3] Add `/activate` to `parseRoute()` in `client/src/App.jsx` (view 'activate' → ActivatePage, reachable signed-out like /authorize) and confirm the SPA serving path delivers index.html for `/activate` in the production build (same mechanism as /authorize — add to any server-side SPA route list if one exists, research R9).
- [ ] T023 [P] [US3] Vitest component tests in `client/src/pages/__tests__/ActivatePage.test.jsx`: renders sign-in prompt with correct returnTo when unauthenticated; code input accepts `wdjb-mjht` (lowercase+hyphen) and submits normalized-enough payload; consent card shows skeptical framing + both scopes and renders a hostile agentName (`<img src=x onerror=…>`) as literal text; Approve and Deny call the decision endpoint with the right body; each error status (400/409/410/429) maps to its distinct user-facing state.
- [ ] T024 [US3] Route-level consent tests in `server/mcp/__tests__/auth/login-flow.test.js` (extend): code entry normalization matrix server-side (case/hyphen/whitespace); double submission of the same code (two tabs) → second gets generic failure (one-shot, FR-009); wrong vs expired vs used code responses byte-identical (FR-015); decision by a different user than the code-enterer → uniform failure; approve creates delegation visible via `GET /mcp/auth/delegations` (Settings shape, LEFT JOIN fallback shows agent_name, research R10); revoking the delegation via existing `DELETE /mcp/auth/delegations/:id` kills a claimed token (cascade, FR-023); unclaimed-approval lapse leaves no active delegation listed (FR-021 + US3 scenario 8).

**Checkpoint**: human half complete — full quickstart §2 runs in a real browser.

## Phase 6: User Story 4 — Abuse resistance and the untouched spec path (P4)

**Goal**: Caps, rate limits, slow_down, anti-enumeration, inert hostile input; transport OAuth surface byte-identical.

**Independent test**: quickstart.md §3 adversarial checks + unchanged OAuth suites.

- [ ] T025 [US4] Abuse tests `server/mcp/__tests__/auth/login-abuse.test.js` (supertest, `rate-limit._reset()` between cases): 11th login/min from one IP → rate_limited; 6th outstanding pending per IP → rate_limited, no row created; global cap 500 (lower the constant via test seam or insert rows directly) → rate_limited for a different IP; premature polls escalate required interval by +5s per violation without invalidating the handle (two violations → 15s), compliant poll then succeeds (D8/FR-013); code entry 6/min/user → 429 and 21/hour/IP → 429; claim 11/min/IP → 429 keyed before handle inspection (a valid handle still claims after cooldown); consumed/denied/expired/fabricated handle poll+claim responses byte-identical (D5); hostile agentName with control chars rejected, 100-char markup name accepted and stored raw (D9).
- [ ] T026 [US4] Anonymous-surface invariance tests `server/mcp/__tests__/auth/anonymous-surface.test.js` per contracts/anonymous-surface.md §Test obligations: anonymous initialize/tools-list/ping succeed (list = exactly two, instructions = anon variant); anonymous `tools/call` on EVERY other registered tool name (iterate the registry) → 401 with WWW-Authenticate string and JSON body pinned to the pre-feature literals; unknown method anonymous → 401; invalid and expired tokens keep today's 401 branches for initialize AND login tools/call; GET /mcp discovery response unchanged.
- [ ] T027 [US4] Run the untouched OAuth conformance suites and pin invariance (SC-003): `npx jest --runInBand server/mcp/__tests__/auth/` must pass with ZERO modifications to `oauth-flow.test.js`, `middleware.test.js`, `pkce.test.js`, `api-token*.test.js`, `delegation.test.js`, `jwt.test.js`, `registered-agents.test.js`; fix any regression in feature code, never in those tests.

**Checkpoint**: security posture demonstrated; spec path regression-locked.

## Phase 7: User Story 5 — agents.md steers each client to its right path (P5)

**Goal**: The front door documents the login bootstrap as the recommended in-session path; drift guard pins it.

**Independent test**: quickstart.md §4.

- [ ] T028 [US5] Update `client/public/agents.md` per research R12: new "already inside a session?" recommended path (connect anonymously → `login` → relay URL+code bare on its own line → poll `login_status` politely (5s, respect slow_down) → claim over REST → persist 0600 → user reconnects the client), including the credential-handling rule (never print/echo/paste) and `/activate` + `GET /api/mcp/login/claim` mechanics; keep the PKCE walkthrough and in-session connect caveat sections substantively unchanged for MCP-native onboarding; update the stated tool count to eighteen; marketing-honest tone (no self-deprecation).
- [ ] T029 [US5] Extend `server/__tests__/agents-md-claims.test.js` with pins (m)–(r) per research R12: names `login` and `login_status`; recommended-path framing for in-session agents (tolerant regex); mentions `/activate`; claim mechanics (`/api/mcp/login/claim`, owner-only/0600, writes to a file); credential-handling rule (never print/echo/paste — tolerant regex); tool count "eighteen"; existing pins (a)–(l) untouched and still passing (PKCE anchors).

## Phase 8: Polish & cross-cutting

- [ ] T030 [P] Verify description/instructions budgets and error-shape consistency: both tool descriptions and both instruction strings under 2048 chars (T017 asserts); login-router and claim-router error payloads match the documented contracts exactly; no `console.log` of handles, codes, or tokens anywhere in the new modules (grep the diff).
- [ ] T031 [P] Full serial backend gate + frontend suite: `npx jest --runInBand` green; `cd client && npx vitest run` green.
- [ ] T032 Execute quickstart.md §2–§4 manually in the dev pod (real browser for /activate, including signed-out Google round-trip and lowercase-code entry) and record any deviations as fixes or spec follow-ups in `specs/008-mcp-login-bootstrap/checklists/`.

## Dependencies

- Phase 1 → Phase 2 → US1 (T009–T017). T002/T003 parallel with T001.
- US2 (T018–T020) depends on US1 (claim endpoint + flow harness exist).
- US3 (T021–T024) depends on US1's routes (T013); T021/T023 (client) parallel with backend work.
- US4 (T025–T027) depends on US1 (surface exists); independent of US2/US3.
- US5 (T028–T029) independent after US1 (mechanics must be real before documenting).
- Phase 8 last.

**Story completion order**: US1 → {US2, US3, US4 in any order / parallel} → US5 → Polish.

## Parallel opportunities

- Phase 1: T002, T003 alongside T001.
- Phase 2: T005, T008 alongside T004/T006.
- US1: T009, T010, T016 in parallel (separate files); T011–T014 serialize on shared files (`tools/index.js`, `mcp/index.js`, `server/index.js`).
- After US1: US2, US3, US4 phases can proceed in parallel (distinct files except the shared `login-flow.test.js` extensions — T019/T020/T024 serialize on that file).
- US3: T021 + T023 (client) parallel with any backend phase.

## Implementation strategy

MVP = Phase 1 + Phase 2 + US1 (route-driven approval, no UI): a real agent can already onboard, which exercises the migration, store, tools, anonymous surface, and claim endpoint. Then US2 (locks the security semantics under concurrency), US3 (browser UX), US4 (adversarial + invariance), US5 (front door), Polish. Each checkpoint leaves the tree green under `npx jest --runInBand`.
