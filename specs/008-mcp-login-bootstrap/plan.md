# Implementation Plan: MCP-Native Onboarding — the login Tool

**Branch**: `008-mcp-login-bootstrap` (feature slug; work happens on the pipeline's assigned tree — no branch created by this plan) | **Date**: 2026-07-14 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `/local-dev/specs/008-mcp-login-bootstrap/spec.md`

## Summary

Add an app-level, device-authorization-style onboarding path exposed *through* the MCP server itself, alongside (never replacing) the byte-identical transport-level OAuth. An MCP client with no credential completes the protocol handshake anonymously and sees exactly two tools — `login` and `login_status`. `login({ agentName })` creates a **pending authorization** (high-entropy handle + one-shot 8-char user code + `/activate` URL + 10-min TTL). The user opens `/activate` in any browser, signs in with Google, enters the code, and approves a deliberately skeptical consent page; approval mints a **standard `agent_delegations` row** via the existing machinery. The agent polls `login_status({ handle })`; on `approved` it receives — once — a one-shot REST claim recipe for `GET /api/mcp/login/claim` (not the credential). The claim atomically mints an `sk_sqd_` token against the delegation and streams the bytes to disk, so the secret never transits model context. An `inline: true` opt-in returns the credential in-band (warned) for shell-less agents. `agents.md` gains this as the recommended in-session path and the tool count becomes eighteen.

Technical approach: reuse `agent_delegations`, `mcp_api_tokens` (`minted_by_delegation_id` provenance + revocation cascade), the consent login round-trip (`/login?returnTo=` + same-origin relative guard), and `buildChallenge()` for the untouched 401. The only new persistent concept is one table, `mcp_pending_authorizations`. The anonymous allowlist lives at the exact JSON-RPC dispatch point in `server/mcp/index.js` where the 401 is issued today; every non-login anonymous request stays byte-identical.

## Technical Context

**Language/Version**: Node.js 22+ (CommonJS backend), React 18 (client)

**Primary Dependencies**: Express, `pg` (node-pg-migrate for schema), `ioredis` (rate-limit/cap counters), `crypto` (handle/code generation, SHA-256 hashing, `timingSafeEqual`); React SPA hand-rolled router (`client/src/App.jsx`)

**Storage**: PostgreSQL — one new table `mcp_pending_authorizations`; reuses `agent_delegations` and `mcp_api_tokens`. Redis for ephemeral rate-limit/poll-interval counters (INCR + EXPIRE); Redis-optional fallback documented in research.md.

**Testing**: Jest backend (`server/__tests__/`, `server/mcp/__tests__/`), `--runInBand` (serial, one shared DB); supertest for route-level state-transition + abuse tests; extend `server/__tests__/agents-md-claims.test.js` drift guard and `server/mcp/__tests__/tools/tool-modules.test.js` tool inventory.

**Target Platform**: Linux server (Minikube `app-dev` pod); streamable-HTTP MCP endpoint at `/mcp`; stdio bridge proxies unchanged.

**Project Type**: Web application (Express backend + React SPA frontend).

**Performance Goals**: Poll loop ≤ 12 req/min per pending authorization (SC-007); handle/code comparison constant-time; no new N+1 or hot-path regression on the untouched OAuth surface.

**Constraints**: Anonymous surface reveals no account-existence oracle (timing included); secret never enters model context in the default path; one-shot semantics enforced by atomic SQL (`UPDATE … WHERE state=… RETURNING`), never read-then-write; codes/handles hashed at rest; 2KB server-instructions budget; ≤2048-char tool descriptions.

**Scale/Scope**: Single-developer product; caps default 5 pending/IP, 500 global; low absolute volume. Scope: 2 MCP tools, 1 REST claim endpoint, 1 `/activate` client page + consent, 1 migration, `agents.md` update, drift + abuse tests.

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

- **I. Documentation Reflects Reality**: `agents.md` (FR-028/029) is updated in-feature with the login bootstrap + eighteen-tool count, pinned by the extended drift guard. README/docs/dev.md are not behavior-changed by this feature (per pipeline override, not edited by this plan agent; the post-merge step owns README). PASS.
- **II. Test-Backed Changes**: Every state transition (`pending`→`approved`/`denied`/`expired`, payload-delivered, claimed/lapsed, auto-revoke) and every abuse limit gets unit + supertest coverage; backend serial (`--runInBand`); drift + tool-inventory guards extended. No format-registry marks/nodes touched (no round-trip suite impact). PASS.
- **III. Trunk-Based Solo Workflow**: No new ceremony; work rides the existing pipeline. PASS.
- **IV. Collaboration-Safe Document Operations**: Feature touches no document mutation, Yjs tree, or format registry — attribution of login-born tokens is delegated to the *existing* delegation/token path (FR-027), which already carries `agent_name` provenance. No new write path. PASS.
- **V. Secure by Default for Agent & User Content**: This is Squire's first anonymous application surface; the spec states the trust boundary (spec §Trust boundary statement, FR-024/025/026). All caller input (agentName, handle, code) is length-capped, validated, rendered inert-escaped, compared constant-time where secret, and rate-limited per-IP + globally. New endpoint (`GET /api/mcp/login/claim`) enforces its own auth (the handle) and touches no documents/ACLs. `sk_sqd_` tokens stay scoped + expiring (30 days) and hashed-at-rest (minted at delivery, D6 — zero plaintext-at-rest). PASS.
- **VI. Design Docs Are Ground Truth**: Plan targets the design doc's "MCP-native onboarding: the login tool (feature 008)" section verbatim; every silence/tension is already ledgered (D1–D12, G1–G3) in `clarifications-needed.md`, none resolved here. PASS.

No violations → Complexity Tracking table empty.

## Project Structure

### Documentation (this feature)

```text
specs/008-mcp-login-bootstrap/
├── plan.md              # This file
├── research.md          # Phase 0 output
├── data-model.md        # Phase 1 output
├── quickstart.md        # Phase 1 output
├── contracts/           # Phase 1 output
│   ├── login-tools.md            # login / login_status MCP tool contracts
│   ├── claim-endpoint.md         # GET /api/mcp/login/claim REST contract
│   ├── activate-consent.md       # /activate page + approve/deny contract
│   └── anonymous-surface.md      # anonymous handshake / allowlist / 401 invariance
├── clarifications-needed.md      # D1–D12, G1–G3 (already ratified)
├── checklists/
└── spec.md
```

### Source Code (repository root)

```text
server/
├── mcp/
│   ├── index.js                        # [EDIT] anonymous-aware JSON-RPC dispatch:
│   │                                   #   initialize/tools/list/ping allowed anon;
│   │                                   #   tools/call allowlist = {login,login_status};
│   │                                   #   anon SERVER_INSTRUCTIONS variant; 401 byte-identical
│   ├── auth/
│   │   ├── pending-authorizations.js   # [NEW] store: create/getByCode/getByHandle,
│   │   │                               #   approve/deny/expire, atomic claim, caps, GC
│   │   ├── login-service.js            # [NEW] orchestration: code/handle gen (hashed),
│   │   │                               #   mint-at-delivery, auto-revoke, slow_down calc
│   │   ├── login-constants.js          # [NEW] named operational constants (D4/D10)
│   │   ├── login-router.js             # [NEW] POST /mcp/login/code + /decision (session auth)
│   │   ├── rate-limit.js               # [NEW] Redis INCR+EXPIRE limiter + per-IP/global caps
│   │   ├── delegation.js               # [reuse] createDelegation, revokeDelegation
│   │   ├── api-tokens.js               # [reuse] createToken(mintedByDelegationId), MAX_TOKENS_PER_USER
│   │   ├── middleware.js               # [reuse] buildChallenge (untouched 401), optionalAgentAuth
│   │   └── oauth-router.js             # [reuse pattern] returnTo round-trip, Settings listing
│   ├── tools/
│   │   ├── index.js                    # [EDIT] register login+login_status; anon tool-list filter;
│   │   │                               #   exclude login tools from scope gate (no-scope tools)
│   │   ├── login.js                    # [NEW] login({ agentName }) tool
│   │   └── login-status.js             # [NEW] login_status({ handle, inline? }) tool
│   └── __tests__/
│       ├── auth/
│       │   ├── pending-authorizations.test.js   # [NEW] store + atomic claim + caps + GC
│       │   ├── login-service.test.js            # [NEW] handle/code gen, normalization, validation
│       │   ├── login-flow.test.js               # [NEW] end-to-end state machine (supertest)
│       │   ├── login-abuse.test.js              # [NEW] caps, rate limits, slow_down, oracles
│       │   └── anonymous-surface.test.js        # [NEW] handshake allowlist + 401 invariance
│       └── tools/
│           ├── tool-modules.test.js             # [EDIT] add login/login_status; registry count → 18
│           ├── login.test.js                    # [NEW]
│           └── login-status.test.js             # [NEW]
├── api/
│   └── mcp-login-claim.js              # [NEW] createLoginClaimRouter(): GET /api/mcp/login/claim
├── index.js                            # [EDIT] mount createLoginClaimRouter(persistenceProvider)
└── __tests__/
    ├── agents-md-claims.test.js        # [EDIT] pin login bootstrap + eighteen-tool claims
    └── mcp-login-claim.test.js         # [NEW] one-shot atomic claim, window, rate limit, oracle

migrations/
└── 1794000000000_create-mcp-pending-authorizations.js   # [NEW] the one in-flight slot

client/
├── src/
│   ├── App.jsx                         # [EDIT] parseRoute(): add `/activate` → view 'activate'
│   └── pages/
│       ├── ActivatePage.jsx            # [NEW] code entry + skeptical consent + result states
│       ├── ActivatePage.css            # [NEW] (or reuse LoginPage.css / AuthorizePage styles)
│       └── __tests__/
│           └── ActivatePage.test.jsx   # [NEW] Vitest: states, normalization, inert name
└── public/
    └── agents.md                       # [EDIT] login bootstrap recommended path; tool count 18
```

**Structure Decision**: Web application. Backend changes concentrate in `server/mcp/` (the anonymous surface + tools + pending-auth store) and one `server/api/` claim router; frontend adds one client route + page mirroring `AuthorizePage.jsx`'s consent + returnTo pattern. Storage is one migration in the sole in-flight slot.

Tool-count bookkeeping: the user-facing "eighteen tools" is 16 existing + 2 login. `server/mcp/tools/index.js` registers all 18; the anonymous tool-list is filtered to the two login tools at dispatch. `tool-modules.test.js` currently asserts a registry count of 16 in "Tool Registry Integration"; that becomes 18, and its `toolModules` smoke-list and `expectedTools` list both gain `login` and `login_status`.

## Complexity Tracking

> No Constitution Check violations. Table intentionally empty.

| Violation | Why Needed | Simpler Alternative Rejected Because |
|-----------|------------|-------------------------------------|
| — | — | — |
