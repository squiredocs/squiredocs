# Quickstart / Validation Guide: 009-rest-login-api

End-to-end validation that the device pairing works as a first-class REST API, that MCP is one
client of the same state machine, and that the security posture is unchanged. Run backend tests
serially in the `app-dev` pod. Contracts: [contracts/](./contracts/). Details live in the specs and
tasks, not here.

## Prerequisites

- Backend test stack (pg + pgvector + redis) up; env per `docs/dev.md` / MEMORY local-backend-test-stack.
- Deterministic rate-limit counter: `LOGIN_RATE_LIMIT_FORCE_MEMORY=1` and `rateLimit._reset()` between
  cases (see `server/__tests__/mcp-login-claim.test.js`).
- Backend tests are serial-only (Constitution II; MEMORY backend-test-db-serial-only).

## Automated validation (the gate)

```bash
# In the app-dev pod, serially:
npx jest server/__tests__/rest-login-endpoints.test.js
npx jest server/__tests__/login-next-steps.test.js
npx jest server/__tests__/mcp-login-claim.test.js
npx jest server/__tests__/agents-md-claims.test.js
npx jest server/mcp/__tests__/auth/anonymous-surface.test.js
# then the full backend suite before merge
```

Expected: all green, never red between tasks (agents.md restructure + its pins land together).

## Scenario 1 — Full pairing over plain REST (US1, SC-001)

1. `POST /api/login/start` with `{"agentName":"Demo"}` → HTTP 200 plain JSON with `userCode`,
   `verificationUri` (`/activate`), `handle`, `pollIntervalSeconds` (+ superset fields). No JSON-RPC
   envelope, no double-encoded text.
2. Approve at `/activate` in a browser (008 journey, unchanged).
3. `GET /api/login/status` with `Authorization: Bearer <handle>` → HTTP 200 `status:"approved"` ONCE,
   with `claimCommand` (canonical `/api/login/claim`), `instructions`, and **`nextSteps`**.
4. Run the claim command → `GET /api/login/claim` streams credential bytes to a 0600 file, once.
5. Verify the claimed `sk_sqd_` credential authenticates BOTH a REST `/api` call (e.g. `GET /api/docs`)
   and a fresh MCP connection.

Pass: full pairing with three endpoints + polling, no MCP client, no JSON-RPC, no install.

## Scenario 2 — Cross-channel equivalence (US1 AC4, AC5)

- Start over REST → poll via the `login_status` tool (and the reverse): both observe the identical
  state machine — one pairing, shared poll interval, one one-shot delivery between them.
- Claim at the alias `GET /api/mcp/login/claim` behaves byte-identically to canonical
  `GET /api/login/claim` (same handler) and consumes the same one-shot.

## Scenario 3 — Security posture inherited (US2, SC-002)

- **Shared budget**: spend part of `login:ip:<ip>` via the tool, then REST `start` on the same IP is
  429 (not a fresh 10) — budget shared, not doubled. Same for canonical+alias claim.
- Exceed pending caps → uniform rate-limited.
- Premature REST poll → `slow_down`, raised interval visible from both channels, one-shot NOT consumed.
- Fabricated / consumed / expired handle, and missing / malformed / wrong-scheme Authorization header
  → indistinguishable uniform `expired` (status) / `404` (claim) — no oracle (RD-6).
- Double delivery across every channel pair → uniform failure (exactly one delivery ever).
- REST inline opt-in (`?inline=true`) matches the tool's inline contract exactly (one-time, warned,
  `no-store`, token-limit carve-out); all other inline failures → uniform expired.
- Invalid `agentName` on start → HTTP 400, no pending created.

## Scenario 4 — nextSteps teaches the next step (US3, SC-003)

- Tool approved, REST approved, and both inline deliveries carry `nextSteps` whose registration
  one-liner is the credentialed `--header "Authorization: Bearer $(cat <file>)"` form (pre-filled path)
  and whose three REST recipes (list `GET /api/docs`, create-from-markdown, export) run as-is.
- The bare `claude mcp add` form appears in NO payload. No credential material in any `nextSteps`.
- The raw claim response body is still exactly the credential bytes.

## Scenario 5 — Discovery names the API (US4, SC-004)

- `GET /mcp` carries `restApi.{loginStart,documentation}` (absolute) with all pre-existing fields
  byte-identical; the amended `anonymous-surface.test.js` asserts both.
- Anonymous MCP `initialize` instructions mention the REST login path and stay < 2 KB.

## Scenario 6 — agents.md choose-your-channel (US5, SC-005, SC-006)

- `/agents.md` ordering: shell-first REST quickstart ("have a shell? nothing to install") →
  credentialed MCP registration → MCP-native OAuth discovery.
- REST quickstart documents the three `/api/login/*` endpoints with runnable curl, states MCP
  registration is NOT a prerequisite, and names the canonical `/api/login/claim`.
- No credential-holding path recommends the bare registration form (bare survives only in the OAuth
  discovery channel, RD-9).
- Drift-guard pins (a)–(t) pass (carried/updated; e.g. claim-path pin → canonical URL); new pins cover
  channel ordering, the three REST endpoints, not-a-prerequisite, credentialed-only registration, and
  the documented `GET /api/docs` list recipe.
