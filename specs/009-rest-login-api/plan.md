# Implementation Plan: REST Login API — the device pairing is an API, MCP is one client of it

**Branch**: `009-rest-login-api` (pipeline tree; no branch created here) | **Date**: 2026-07-15 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `/specs/009-rest-login-api/spec.md`

## Summary

Split the device-pairing login flow from MCP: expose it as three first-class plain-REST
endpoints (`POST /api/login/start`, `GET /api/login/status`, `GET /api/login/claim`) that
are **thin wrappers over the one existing login-service state machine**, with the MCP
`login`/`login_status` tools kept as sibling clients of the same service. The approved
delivery gains a `nextSteps` block (credentialed registration one-liner + top REST recipes),
the `GET /mcp` manifest gains an additive `restApi` block, the anonymous server instructions
name the REST path, and `agents.md` is restructured as a choose-your-channel guide.

**Hard boundaries (design-mandated, spec Out of Scope):** NO migration, NO login state-machine
change, NO `/activate`/consent/delegation/mint change, NO OAuth/PKCE transport change, NO client
UI change. Everything is additive wrappers, one payload builder change, discovery-string
additions, and documentation.

Technical approach, verified against code reality (2026-07-15):

- **One budget per gate (RD-8).** The tool `login` handler gates on `rateLimit.consume(`login:ip:${ip}`, LOGIN_CALLS_PER_MINUTE_PER_IP, 60)`; REST `start` MUST call the **same key string** so the per-IP login budget is shared, not doubled. To make drift impossible, the per-IP login rate-limit gate is hoisted into a single shared helper (`loginService.checkLoginRateLimit(ip)` or a small shared module) that BOTH the tool handler and the REST start handler call — the key string lives in exactly one place. The pending caps are already Postgres `COUNT`s inside `createPendingAuthorization` (inherently flow-wide). The claim budget key `claim:ip:${ip}` is already one key; the alias sharing it falls out for free because the alias is the **same handler mounted at two paths**, not a copy.
- **`nextSteps` lives in `login-service`'s delivery builder.** The approved payload and inline payload are both constructed inside `loginService.getStatus` (approved branch ~L304-316; inline branch ~L291-298). Adding `nextSteps` there means the `login_status` tool AND the REST status route (both call `getStatus`) receive it by construction — they cannot drift. `getStatus` already receives `baseUrl`, which is all that is needed to build the credentialed one-liner (pre-filled `~/.squire/credential` path) and the three REST recipes. The raw-byte claim response is untouched (RD-3): `nextSteps` never rides the byte channel.
- **Canonical claim path + alias = same handler (FR-007, RD-4).** `createLoginClaimRouter` today registers `router.get('/api/mcp/login/claim', handler)`. Change to register the single handler at BOTH `/api/login/claim` (canonical) and `/api/mcp/login/claim` (alias) — one function, one `claim:ip:` budget, byte-identical everything. `buildClaimCommand` switches its emitted URL from `/api/mcp/login/claim` to the canonical `/api/login/claim`.
- **New start/status router.** A new `server/api/login.js` exporting `createLoginRouter(persistence)` with `POST /api/login/start` and `GET /api/login/status`. Both are anonymous (no `requireAuth`), Bearer-header-only handle carriage on status, `?inline=true` query opt-in (RD-5), HTTP mapping per RD-2, uniform-expired on any auth-header defect (RD-6). Mounted in `server/index.js` beside the existing claim/export/import routers (before the SPA catch-all).
- **Discovery.** `GET /mcp` gains `restApi: { loginStart, documentation }` (RD-7) built from `buildBaseUrl(req)`; pre-existing fields byte-identical. `ANON_SERVER_INSTRUCTIONS` gains a REST-path mention under the 2 KB budget (FR-016).
- **Docs + drift guard in one task.** `agents.md` restructured; `agents-md-claims.test.js` pins (a)–(t) updated in the SAME task so the suite is never red mid-flight; the anonymous-surface discovery pin is amended deliberately (FR-015).

**G1 verified:** `GET /api/docs` uses `requireAuth` → `permissions.extractUser` → `apiTokens.isApiToken`/`verifyToken`, so a claimed `sk_sqd_` credential authenticates it. The "list docs" recipe (`GET /api/docs`) is runnable as-is; documenting it in agents.md's REST section (with a drift pin) makes the promotion explicit.

## Technical Context

**Language/Version**: Node.js 22+ (CommonJS), Express; existing backend Jest suite.

**Primary Dependencies**: Express, `supertest` (route-level tests), the existing login-service
stack (`pending-authorizations`, `delegation`, `api-tokens`, `rate-limit`), `buildBaseUrl`.

**Storage**: PostgreSQL via the existing `mcp_pending_authorizations` table and delegation/token
tables. **No migration** — no schema change (spec Out of Scope; Constitution: node-pg-migrate only,
and there is nothing to migrate).

**Testing**: Jest + supertest, backend, serial (Constitution II). New route-level suites for
start/status + cross-channel equivalence; the claim suite extended for the canonical/alias pair;
`agents-md-claims` and `anonymous-surface` pins amended. `LOGIN_RATE_LIMIT_FORCE_MEMORY=1` +
`rateLimit._reset()` deterministic-counter seam reused.

**Target Platform**: Linux server (Minikube `app-dev` pod).

**Project Type**: Web service (existing Express backend + static `client/public/agents.md`).

**Performance Goals**: No new hot path; wrappers add one function call over existing service.
SC-001: full pairing in < 2 min of agent-side work post-approval (dominated by human approval).

**Constraints**: `ANON_SERVER_INSTRUCTIONS` < 2 KB (FR-016); `nextSteps` sized so the approved
payload still renders in MCP clients (~2 KB rule of thumb — top three recipes, not a reference);
Bearer-header-only handle carriage on every login route; `Cache-Control: no-store` on any
credential-bearing response.

**Scale/Scope**: 3 REST endpoints (1 new router file + 1 edited claim router), 1 payload-builder
change in login-service, 1 shared rate-limit helper, 2 discovery-string edits, agents.md
restructure, ~4 test files touched. Single feature, ~11-13 tasks.

## Constitution Check

*GATE: evaluated pre-Phase 0 and re-checked post-Phase 1.*

- **I. Documentation Reflects Reality** — PASS. agents.md is a first-class deliverable (FR-017–021)
  restructured and re-pinned in this feature. README.md/docs/dev.md are OUT of this agent's edit
  scope (pipeline override); if the surface list there drifts, that is flagged to the maintainer,
  not silently edited here. No behavior in README/dev.md changes (the flow is the same; a new door
  is added) — note for the merge/converge step, not a plan blocker.
- **II. Test-Backed Changes** — PASS. Every new route and the cross-channel equivalence is covered
  by route-level supertest suites; the agents.md restructure and its pins land in one task so the
  suite is never red between tasks. Backend runs serially. No format-registry change (no round-trip
  suite impact).
- **III. Trunk-Based Solo Workflow** — PASS. Pipeline overrides govern: stay on main, no branch,
  no commit by this agent. No new ceremony introduced.
- **IV. Collaboration-Safe Document Operations** — N/A. This feature touches no Yjs/CRDT/document
  mutation path and no format registry.
- **V. Secure by Default (trust boundary)** — PASS with obligation. Two new anonymous REST routes
  extend the 008 anonymous surface. Spec §"Trust boundary statement" states it: no new untrusted
  input class; identical validation, caps, one-shot semantics, uniform errors, no oracle, drawn
  from the **same budgets** (RD-8), credentials only over the byte channel or opted-in inline with
  `no-store`. US2 + SC-002 make this a testable obligation. G2 (no per-IP transport limit on
  `GET /api/login/status`) is a ratified posture note: identical-to-tool means the status route has
  only the per-handle slow-down, matching the equally-unlimited anonymous `tools/call` path — no new
  capability for an attacker; a future ceiling would be added to both channels at once.
- **VI. Design Docs Are Ground Truth** — PASS. Design ground truth is the feature-009 amendment in
  `design/agent-surface-mcp.md`; all silences resolved as RATIFIED-BY-DEFAULT (RD-1..RD-9, G1..G3)
  in `clarifications-needed.md`. No design doc is hand-edited by this plan.

**No violations → Complexity Tracking empty.**

## Project Structure

### Documentation (this feature)

```text
specs/009-rest-login-api/
├── plan.md              # This file
├── research.md          # Phase 0 output
├── data-model.md        # Phase 1 output (nextSteps + restApi payload shapes; no DB entities)
├── quickstart.md        # Phase 1 output (end-to-end validation guide)
├── contracts/           # Phase 1 output
│   ├── rest-login-endpoints.md    # start / status / claim(+alias) HTTP contract
│   ├── next-steps-block.md        # nextSteps payload element (shared by both consumers)
│   └── discovery-and-instructions.md  # restApi manifest block + anon instructions amendment
└── tasks.md             # Phase 2 output (/speckit-tasks)
```

### Source Code (repository root)

```text
server/
├── api/
│   ├── login.js               # NEW — createLoginRouter: POST /api/login/start, GET /api/login/status
│   └── mcp-login-claim.js     # EDIT — register handler at BOTH /api/login/claim (canonical) + /api/mcp/login/claim (alias)
├── mcp/
│   ├── auth/
│   │   ├── login-service.js   # EDIT — nextSteps in approved+inline delivery; buildClaimCommand→canonical path; shared login rate-limit helper
│   │   ├── rate-limit.js      # UNCHANGED (reused)
│   │   └── login-constants.js # UNCHANGED (reused; may add a shared login-rate-limit key constant if helper lives here)
│   ├── tools/
│   │   ├── login.js           # EDIT — call the shared rate-limit helper instead of an inline key string
│   │   └── login-status.js    # UNCHANGED (delegates to getStatus, gets nextSteps for free)
│   └── index.js               # EDIT — restApi block in GET /mcp; REST mention in ANON_SERVER_INSTRUCTIONS
├── index.js                   # EDIT — mount createLoginRouter beside claim/export/import routers
└── __tests__/
    ├── mcp-login-claim.test.js         # EDIT — assert canonical + alias byte-identical, shared claim budget
    ├── rest-login-endpoints.test.js    # NEW — start/status route-level + cross-channel equivalence + inline + RD-6
    ├── login-next-steps.test.js        # NEW — nextSteps present in both consumers + both inline; absent from byte claim; no secrets
    ├── agents-md-claims.test.js        # EDIT — pins (a)-(t) carried/updated; new choose-your-channel pins
    └── mcp/__tests__/auth/anonymous-surface.test.js  # EDIT — discovery pin amended (restApi + pre-existing fields); anon-instructions REST mention

client/public/agents.md         # EDIT — choose-your-channel restructure (FR-017-021)
```

**Structure Decision**: Existing Express web-service layout. New start/status endpoints get their
own router file (`server/api/login.js`), mirroring `mcp-login-claim.js`; the canonical/alias claim
lives in the existing claim router. No new top-level directories, no `shared/` change, no migration.

## Complexity Tracking

> No Constitution violations. Table intentionally empty.
