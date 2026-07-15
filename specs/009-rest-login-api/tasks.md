---
description: "Task list for feature 009-rest-login-api"
---

# Tasks: REST Login API — the device pairing is an API, MCP is one client of it

**Input**: Design documents from `/specs/009-rest-login-api/`

**Prerequisites**: plan.md, spec.md, research.md, data-model.md, contracts/ (all present)

**Tests**: Test tasks ARE included — Constitution II (test-backed changes; the suite is the only
reviewer) and the spec's Independent Tests / SC-002 adversarial reruns make them mandatory here.

**Organization**: Grouped by user story (P1..P5). Backend tests run SERIALLY (Constitution II;
MEMORY backend-test-db-serial-only). Reuse `LOGIN_RATE_LIMIT_FORCE_MEMORY=1` + `rateLimit._reset()`.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: parallelizable (different files, no dependency on incomplete tasks)
- Absolute-ish repo paths given for every task.

---

## Phase 1: Setup

- [X] T001 Confirm no new dependencies (Express + supertest + existing login-service stack only) and that the `LOGIN_RATE_LIMIT_FORCE_MEMORY=1` / `rateLimit._reset()` deterministic seam is used by any new suite; verify the backend test stack is up in the `app-dev` pod per `docs/dev.md`. No code change.

---

## Phase 2: Foundational (blocking prerequisites for the REST wrappers)

**Purpose**: The two changes inside `login-service` that BOTH the MCP tools and the REST routes
depend on — so no consumer can drift (RD-8, RD-3/FR-012). Must land before US1.

- [X] T002 Add a single shared per-IP login rate-limit gate `checkLoginRateLimit(ip)` to `server/mcp/auth/login-service.js` (the ONLY place the `login:ip:<ip>` key string + `LOGIN_CALLS_PER_MINUTE_PER_IP` live), returning `{ allowed, retryAfterSeconds }` via `rateLimit.consume`; export it. Refactor `server/mcp/tools/login.js` to call it instead of its inline `rateLimit.consume('login:ip:'+ip, ...)` — behavior and the uniform `rate_limited` result unchanged (RD-8). Keep green any test pinning the tool gate: `server/mcp/__tests__/tools/login.test.js`, `server/mcp/__tests__/auth/login-abuse.test.js`.
- [X] T003 Add a pure `buildNextSteps(baseUrl, credentialFilePath)` helper to `server/mcp/auth/login-service.js` and attach its result as `nextSteps` on BOTH delivery payloads built in `getStatus` (the default approved payload AND the inline approved payload). Do NOT add it to `POST /api/login/start` or the byte-channel claim (RD-3). Switch `buildClaimCommand` to emit the canonical `/api/login/claim` URL (RD-4). Contains no credential material; registration one-liner is the credentialed `--header "Authorization: Bearer $(cat <file>)"` form only (never bare). **Reconcile the credential file path**: `buildClaimCommand` uses `~/.squire/credential` while today's `client/public/agents.md` uses `~/.squire-credential` — pick ONE canonical path and pre-fill `nextSteps` with it, so the claim recipe, `nextSteps`, and the agents.md examples (T016) all agree (FR-011 "the claim recipe's file path pre-filled"; FR-021 drift-is-a-bug). **In this same phase, update the payload-shape pins that will otherwise go red** — the approved payload now carries `nextSteps` and the canonical claim URL: `server/mcp/__tests__/tools/login-status.test.js`, `server/mcp/__tests__/auth/login-flow.test.js`, `server/mcp/__tests__/auth/login-service.test.js` (any assertion on `claimCommand` containing `/api/mcp/login/claim` → `/api/login/claim`). Contracts: contracts/next-steps-block.md.

**Checkpoint**: `login_status` tool now returns `nextSteps` and canonical claim recipes; existing 008
tool/claim suites still green (adjust the tool approved-payload expectation for the added field +
canonical URL in this same phase so nothing is red).

---

## Phase 3: User Story 1 — Pair entirely over plain REST (P1) 🎯 MVP

**Goal**: Full device pairing over `POST /api/login/start`, `GET /api/login/status`,
`GET /api/login/claim` (+ alias), all thin wrappers over the one state machine; cross-channel
equivalence with the MCP tools.

**Independent test**: quickstart Scenario 1 + 2 — drive start→approve→status→claim with curl only;
start-via-REST/poll-via-tool and the reverse observe one state machine; alias byte-identical to canonical.

- [ ] T004 [US1] Make the claim alias the SAME handler mounted twice in `server/api/mcp-login-claim.js`: register the existing handler at both `/api/login/claim` (canonical) and `/api/mcp/login/claim` (alias) — one function, one `claim:ip:<ip>` budget, byte-identical responses (FR-007, RD-4). Mount is already `app.use(createLoginClaimRouter(...))` in `server/index.js` (no mount change needed).
- [ ] T005 [US1] Create `server/api/login.js` exporting `createLoginRouter(persistence)` with `POST /api/login/start`: parse JSON `{ agentName }`; `loginService.validateAgentName` → 400 on failure (no pending created); `loginService.checkLoginRateLimit(req.ip)` → 429 + `Retry-After` on breach; else `loginService.createPendingAuthorization({ agentName, ip: req.ip, baseUrl: buildBaseUrl(req) })` → 429+Retry-After on `rate_limited`, else 200 superset JSON (RD-1/RD-2). No `requireAuth`. Contracts: contracts/rest-login-endpoints.md.
- [ ] T006 [US1] Add `GET /api/login/status` to `server/api/login.js`: extract handle from `Authorization: Bearer` ONLY (missing/malformed/wrong-scheme → 200 uniform `{status:'expired'}`, RD-6); read `?inline=true` (RD-5); call `loginService.getStatus(handle, { inline, baseUrl: buildBaseUrl(req) })`; return HTTP 200 for every decision-table outcome with the outcome in `status` (RD-2); set `Cache-Control: no-store` on any credential-bearing (inline) response (FR-006).
- [ ] T007 [US1] Mount `createLoginRouter(persistenceProvider)` in `server/index.js` beside the export/import/claim routers (before the SPA static catch-all). Verify no path collision with existing `requireAuth`-protected `/api/...` routes.
- [ ] T008 [P] [US1] New suite `server/__tests__/rest-login-endpoints.test.js` (supertest): start happy-path 200 + enumerated/superset fields + no JSON-RPC envelope; agentName invalid → 400, no pending; status pending/slow_down/denied/approved/expired outcomes all HTTP 200; approved payload carries canonical `claimCommand` + `nextSteps`; RD-6 missing/malformed/wrong-scheme header → uniform expired; `?inline=true` one-time credential + `no-store` + do-not-echo warning. Use the memory rate-limit seam.
- [ ] T009 [P] [US1] Extend `server/__tests__/mcp-login-claim.test.js`: assert canonical `/api/login/claim` behaves byte-identically to the alias `/api/mcp/login/claim` (same handler) — first-claim 200 bytes, uniform 404, 429, 409 token_limit; and that a claim on one URL consumes the one-shot for the other.
- [ ] T010 [US1] New suite `server/__tests__/rest-login-crosschannel.test.js` (supertest + direct `loginService`/tool-handler calls): start over REST → poll via `login_status` tool and the reverse observe one pairing, shared poll interval, exactly ONE approved-payload delivery between the channels; claim via canonical vs alias consumes the same one-shot; premature REST poll raises the interval visible from both channels without consuming the one-shot.

**Checkpoint**: US1 independently shippable — a shell-only agent completes the whole pairing; the
state machine is provably one machine behind two doors.

---

## Phase 4: User Story 2 — REST surface inherits 008's security contract (P2)

**Goal**: Same budgets (not doubled), same caps, one-shot across all channels, uniform errors, no
oracle, inline contract parity. Mostly adversarial tests over the wrappers built in US1.

**Independent test**: quickstart Scenario 3 — rerun 008's adversarial repertoire through REST.

- [ ] T011 [P] [US2] Add shared-budget tests to `server/__tests__/rest-login-endpoints.test.js` (or a `rest-login-security.test.js`): spend part of `login:ip:<ip>` via the `login` tool handler, then assert REST `start` on the same IP is 429 (budget shared, not a fresh 10) — RD-8; and canonical + alias claim share one `claim:ip:` budget (10 across both URLs, 11th → 429). Exceed per-IP/global pending caps → uniform rate-limited.
- [ ] T012 [P] [US2] Add no-oracle / one-shot cross-channel tests: fabricated / consumed / expired handle and missing / malformed / wrong-scheme header all indistinguishable (status uniform `expired`, claim uniform 404); double delivery across every channel pair (tool approved, REST approved, inline either, canonical claim, alias claim) → uniform failure, exactly one delivery ever; REST inline token-limit carve-out surfaces the actionable outcome (008 D13) and all other inline failures collapse to uniform expired.

**Checkpoint**: SC-002 — 100% of 008's adversarial behaviors hold through REST; no gate's budget doubled.

---

## Phase 5: User Story 3 — The approved payload teaches the next step (P3)

**Goal**: Verify the `nextSteps` block (built in T003) is correct and complete in all four delivery
sites and carries no secrets.

**Independent test**: quickstart Scenario 4.

- [ ] T013 [P] [US3] New suite `server/__tests__/login-next-steps.test.js`: complete a pairing and inspect the tool approved payload, the REST approved payload, and BOTH inline deliveries — each has `nextSteps` with the credentialed `--header "Authorization: Bearer $(cat <file>)"` one-liner (pre-filled path) and the three runnable REST recipes (list `GET /api/docs`, create-from-markdown `POST /api/docs/import`, export `GET /api/docs/:docId/export?format=markdown`); the bare `claude mcp add … /mcp` form (no `--header`) appears in NO payload; no `sk_sqd_`/credential material in any `nextSteps`; the raw claim response body is exactly the credential bytes + `\n` (no `nextSteps`). Contracts: contracts/next-steps-block.md.

**Checkpoint**: SC-003 — an agent can register or run a first doc op from the payload alone.

---

## Phase 6: User Story 4 — Discovery names the API (P4)

**Goal**: `GET /mcp` gains an additive `restApi` block; anon instructions mention REST; the
"unchanged" discovery pin is amended deliberately.

**Independent test**: quickstart Scenario 5.

- [ ] T014 [US4] In `server/mcp/index.js` `GET /mcp` handler, add `restApi: { loginStart: `${baseUrl}/api/login/start`, documentation: `${baseUrl}/agents.md#<choose-your-channel anchor>` }` from `buildBaseUrl(req)`; keep every pre-existing field byte-identical (RD-7, FR-014). Add one sentence to `ANON_SERVER_INSTRUCTIONS` naming the REST login path, keeping the existing critical content leading and the string < 2 KB (FR-016); leave `SERVER_INSTRUCTIONS` unchanged. Contracts: contracts/discovery-and-instructions.md.
- [ ] T015 [US4] Amend `server/mcp/__tests__/auth/anonymous-surface.test.js`: rewrite the "GET /mcp discovery response is unchanged" pin to assert the new `restApi.{loginStart,documentation}` (absolute) AND continue pinning every pre-existing field (FR-015 — deliberate, traceable); assert `ANON_SERVER_INSTRUCTIONS` contains the REST mention and is `< 2048` bytes and the anon `initialize` still returns exactly `ANON_SERVER_INSTRUCTIONS`. Keep the instruction-budget guard green (T017 in 008 lineage).

**Checkpoint**: SC-004 — additive discovery; pre-existing manifest consumers unaffected.

---

## Phase 7: User Story 5 — agents.md becomes a choose-your-channel guide (P5)

**Goal**: Restructure `agents.md`; carry/​update the drift-guard suite in the SAME task so it is
never red between tasks.

**Independent test**: quickstart Scenario 6.

- [ ] T016 [US5] Restructure `client/public/agents.md` into the choose-your-channel ordering (FR-017): (1) shell-first REST login quickstart — "have a shell? nothing to install", documenting the three `/api/login/*` endpoints with runnable curl, canonical `/api/login/claim`, explicit "registering an MCP server is NOT a prerequisite", then collaborate over REST (document `GET /api/docs` list alongside export/import — G1) or authenticated JSON-RPC; (2) credentialed MCP registration (`--header` form only, using the SAME canonical credential file path chosen in T003) for credential-holders; (3) MCP-native OAuth discovery (the bare `claude mcp add` form survives ONLY here, framed "no credential yet — your client's OAuth takes over", RD-9). No credential-holding path shows the bare form (FR-019). Every factual claim matches the implemented surface (FR-021). **In the same task**, update `server/__tests__/agents-md-claims.test.js`: carry pins (a)–(t) that stay true (update where text moved — e.g. pin (p) claim path → canonical `/api/login/claim`; scope/reword pin (d) so the bare one-liner is asserted in the OAuth-discovery context), and ADD new pins for the channel ordering/framing, the three REST login endpoints, the not-a-prerequisite statement, the credentialed-only rule for credential-holders, and the documented `GET /api/docs` list recipe (FR-020). Suite stays green.

**Checkpoint**: SC-005 + SC-006 — front door leads with shell-first; no path leads a credential-holder
to bare registration; drift-guard passes in full.

---

## Phase 8: Polish & Cross-Cutting

- [ ] T017 [P] Run the FULL backend suite serially in the `app-dev` pod; confirm green including the 008 login-tools, claim, anonymous-surface, and agents-md suites. Confirm no login state-machine / `/activate` / delegation / mint / OAuth-PKCE file was touched (FR-010) and no migration was added.
- [ ] T018 Walk quickstart.md Scenarios 1–6 as an end-to-end smoke (curl against a running dev server): full REST pairing, cross-channel, shared budget, nextSteps, discovery, agents.md ordering. Note: README.md / docs/dev.md edits are OUT of this agent's scope (pipeline override) — if the surface list there drifts, flag it to the maintainer for the merge/converge step rather than editing here.

---

## Dependencies & Execution Order

- **Setup (T001)** → **Foundational (T002, T003)** → everything else.
- **US1 (T004–T010)** depends on T002 (start gate) + T003 (nextSteps/canonical recipe). MVP.
- **US2 (T011–T012)** depends on US1 (exercises the built wrappers).
- **US3 (T013)** depends on T003 (builder) + US1 (REST delivery sites).
- **US4 (T014–T015)** depends only on T005 existing (loginStart URL) — otherwise independent; can run alongside US2/US3.
- **US5 (T016)** lands last (documents surfaces that must exist first) but is otherwise self-contained.
- **Polish (T017–T018)** after all stories.

### Parallel opportunities

- After Foundational: T008 ∥ T009 (different test files) once T004–T007 code exists.
- T011 ∥ T012 (US2); T013 (US3); T014→T015 (US4) can proceed in parallel with US2/US3 since they touch
  different files (`server/mcp/index.js`, `anonymous-surface.test.js`).
- T016 (US5) is a single atomic task (restructure + pins together) — not split, by design.

## Implementation Strategy

- **MVP = US1** (T001–T010): the shell-only REST pairing over one state machine. Ships value alone.
- Then US2 (security parity, the P1-can't-ship-without-it obligation), US3 (nextSteps), US4
  (discovery), US5 (agents.md) — each an independently testable increment.
- Never leave the suite red between tasks: T002/T003 update the 008 tool/claim expectations in-phase;
  T016 restructures agents.md and its pins together.
