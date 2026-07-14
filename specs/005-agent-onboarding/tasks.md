---
description: "Task list for feature 005-agent-onboarding"
---

# Tasks: Agent Onboarding via agents.md + MCP-Native OAuth

**Input**: Design documents from `/local-dev/specs/005-agent-onboarding/`

**Prerequisites**: plan.md, spec.md, research.md, data-model.md, contracts/,
quickstart.md — all present.

**Tests**: Tests are IN SCOPE for this feature. FR-003 mandates a drift-guard
mechanism (chosen: automated test in R6). The spec explicitly notes "no OAuth
flow tests exist today; this feature introduces the first ones." Tests belong
to the user story whose behavior they cover.

**Organization**: Tasks are grouped by user story from spec.md
(US1 P1 = one-sentence onboarding; US2 P2 = consent login round-trip;
US3 P3 = agents.md front door; US4 P4 = fallback + discoverability). Because
several backend files are touched by more than one story, the order below is
sequenced so per-file edits happen once and later stories only extend earlier
work — annotated where relevant.

## Format: `[ID] [P?] [Story?] Description`

- **[P]**: Can run in parallel (different files, no ordering dependency).
- **[Story]**: US1 / US2 / US3 / US4 for tasks that serve a specific story.

---

## Phase 1: Setup

**Purpose**: verify workspace and prerequisites; no new project scaffolding
required for this feature.

- [X] T001 Verify Node/Express server tree and `client/public/` exist and
      that `express.static(clientBuildPath)` is mounted in
      `/local-dev/server/index.js` (~L1392) so `client/public/agents.md` will
      serve at `/agents.md` when the client is built. No file changes.
- [X] T002 Verify `buildBaseUrl` in `/local-dev/server/url.js` matches the
      hardcoded logic at `/local-dev/server/index.js:328` (both force `https`
      for the `squiredocs.com` host). No file changes.

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: shared code that later story tasks depend on. Complete before any
US1/US2/US3/US4 task.

- [X] T003 Refactor the existing `GET /.well-known/oauth-authorization-server`
      handler in `/local-dev/server/index.js` (~L324) to compute its `baseUrl`
      via `buildBaseUrl(req)` from `/local-dev/server/url.js` instead of the
      inline `host.includes('squiredocs.com') ? 'https' : req.protocol`
      logic. Response body must be byte-identical to today.
- [X] T004 Add a shared returnTo validator to `/local-dev/server/auth/routes.js`
      (private module-level helper `isValidReturnTo(value)`), implementing
      the six R2 checks from `research.md`. Export it from the module
      (`module.exports.isValidReturnTo`) so the tests in US2 can import it
      directly. No route changes yet.
- [X] T005 Add a WWW-Authenticate challenge builder to
      `/local-dev/server/mcp/auth/middleware.js` (private module-level
      helper `buildChallenge(req, opts)` returning a header value string per
      `contracts/www-authenticate-challenge.md`). Not yet wired to any 401.

**Checkpoint**: Foundation ready. US1, US2, US3, US4 tasks may proceed.

---

## Phase 3: User Story 1 - One-sentence agent onboarding (P1) 🎯 MVP

**Goal**: Serve RFC 9728 protected-resource metadata (both forms) and emit
the machine-actionable `WWW-Authenticate` challenge on every MCP 401/403, so
an MCP-native client with zero configuration self-discovers authorization.

**Independent Test**: `curl` the two `.well-known` documents (byte-identical
JSON, both point at `/mcp` and the origin as authorization server); `curl -X
POST /mcp` unauthenticated and verify the 401 carries `WWW-Authenticate:
Bearer realm="mcp", resource_metadata="…"`. Any standards-compliant MCP
client pointed at the endpoint completes discovery with no manual input.

### Implementation

- [X] T006 [US1] Add `GET /.well-known/oauth-protected-resource/mcp` route to
      `/local-dev/server/index.js` next to the existing well-known handler
      (~L324), returning the R4 JSON body per
      `contracts/protected-resource-metadata.md`, using `buildBaseUrl(req)`.
- [X] T007 [US1] Add `GET /.well-known/oauth-protected-resource` (root fallback)
      route to `/local-dev/server/index.js` immediately after T006, returning
      the same body via the same helper. Extract the body-builder into a small
      local `buildProtectedResourceDoc(req)` closure so both routes share it.
- [X] T008 [US1] Wire `buildChallenge` from T005 into `requireAgentAuth` in
      `/local-dev/server/mcp/auth/middleware.js`. Before each of the three
      existing `res.status(401).json(...)` calls (missing / expired /
      invalid), set `res.set('WWW-Authenticate', buildChallenge(req, {
      branch }))` per `contracts/www-authenticate-challenge.md`. JSON body
      shape and error codes MUST stay identical.
- [X] T009 [US1] Wire `buildChallenge` into the `requireScope` 403 branch in
      the same file — set `WWW-Authenticate` with `error="insufficient_scope"`
      and `scope="<space-separated required scopes>"`. JSON body unchanged.
- [X] T010 [US1] Add `resource_metadata` field to the `authentication` object
      returned by `GET /mcp` in `/local-dev/server/mcp/index.js:101-106`
      (value: `` `${baseUrl}/.well-known/oauth-protected-resource/mcp` ``).

### Tests for User Story 1

- [X] T011 [P] [US1] Create
      `/local-dev/server/__tests__/oauth-discovery.test.js` (supertest, mirrors
      the pattern in `/local-dev/server/__tests__/api-docs-export.test.js`).
      Cases (all serial-only): (a) `GET /.well-known/oauth-protected-resource/mcp`
      → 200 with expected JSON shape and `resource` = `<base>/mcp`;
      (b) `GET /.well-known/oauth-protected-resource` → byte-identical to (a);
      (c) `POST /mcp` no Authorization → 401, `WWW-Authenticate` header
      present, no `error=` attribute, `resource_metadata` points at path-suffix
      well-known;
      (d) `POST /mcp` with malformed token → 401, header has
      `error="invalid_token"` and `error_description`;
      (e) `POST /mcp` with a valid-shape-but-expired JWT (mint one with
      `expiresIn: '-1h'`) → 401, header has `error="invalid_token"`,
      `error_description="The access token expired"`;
      (f) `POST /mcp` with valid token missing scope → 403, header has
      `error="insufficient_scope"` and `scope="…"`;
      (g) `POST /mcp` with valid in-scope token → 200 and NO `WWW-Authenticate`
      header;
      (h) `GET /mcp` → 200 and `authentication.resource_metadata` present.

**Checkpoint**: US1 fully functional. An MCP-native client at
`http://localhost:5173/mcp` completes discovery unaided.

---

## Phase 4: User Story 2 - Consent survives login round-trip (P2)

**Goal**: A signed-out user reaching the consent page can sign in with Google
and land back on the consent page with all authorization parameters intact;
open-redirect defense drops hostile returnTo values silently to the default
destination.

**Independent Test**: In an incognito browser, visit `/authorize?...` (any
valid parameters), click "Sign in", complete Google login (dev-login in dev
mode), and verify the browser returns to `/authorize?...` — not to `/docs` or
the welcome doc. Separately, visit `/login?returnTo=//evil.com` and verify
the browser lands on the default destination on-origin.

### Implementation — server

- [X] T012 [US2] In `/local-dev/server/auth/routes.js` `GET /auth/google`
      (~L70), read `req.query.returnTo`, run `isValidReturnTo` from T004, and
      on success set the httpOnly cookie:
      `res.cookie('oauth_return_to', returnTo, { httpOnly: true, maxAge: 10
      * 60 * 1000, sameSite: 'lax', secure: isProduction })`. Place alongside
      the existing `oauth_redirect` and `oauth_state` cookies. Invalid values
      are ignored silently (no cookie, no error).
- [X] T013 [US2] In `/local-dev/server/auth/routes.js` `GET
      /auth/google/callback` (~L106), after minting session cookies and
      before the current `onboarding.resolveOnboarding` branch: read
      `req.cookies.oauth_return_to`, always `res.clearCookie('oauth_return_to')`,
      re-validate with `isValidReturnTo`. If valid,
      `res.redirect(\`${clientUrl}${returnTo}\`)` and return. If missing or
      invalid, fall through to the existing onboarding branch (unchanged).

### Implementation — client

- [X] T014 [P] [US2] In `/local-dev/client/src/contexts/AuthContext.jsx:136`,
      change `login` from `useCallback(async () => { ... })` to
      `useCallback(async (returnTo) => { ... })`. When `BYPASS_AUTH`,
      delegate to `devLogin(returnTo)`. Otherwise, if `returnTo` is a string
      that passes a client-side mirror of the R2 validator (same six
      predicates as the server), set `window.location.href =
      \`/auth/google?returnTo=${encodeURIComponent(returnTo)}\``; else fall
      through to `window.location.href = '/auth/google'`.
- [X] T015 [P] [US2] In `/local-dev/client/src/contexts/AuthContext.jsx`
      `devLogin` (~L107), accept an optional `returnTo` argument and, after
      the JSON response succeeds, if `returnTo` is a validated same-origin
      relative path do `window.location.href = returnTo` (mirroring the
      cookie behavior for the dev bypass); else leave the existing behavior.
- [X] T016 [P] [US2] In `/local-dev/client/src/components/LoginPage.jsx`,
      read `returnTo` from `new URLSearchParams(window.location.search)`. In
      the Google button's `onClick`, call `login(returnTo)` instead of
      `login()`.
- [X] T017 [US2] In `/local-dev/client/src/pages/AuthorizePage.jsx:224`,
      change the sign-in link's `href` from
      `` `/login?returnTo=${encodeURIComponent(window.location.href)}` ``
      to `` `/login?returnTo=${encodeURIComponent(window.location.pathname + window.location.search)}` ``.

### Tests for User Story 2

- [X] T018 [P] [US2] Create `/local-dev/server/__tests__/auth-return-to.test.js`
      (supertest; mock `../auth/google` so `exchangeCodeForTokens` and
      `verifyIdToken` return fixtures — no external network). Cases (serial):
      (a) `GET /auth/google?returnTo=/authorize?foo=bar` → 302 to Google;
      `oauth_return_to` cookie set with `HttpOnly` and `SameSite=Lax`;
      (b) hostile `returnTo` values (list from
      `contracts/returnto-continuation.md` "Reject cases") → cookie NOT set;
      (c) callback with valid `oauth_return_to` cookie → 302 to
      `${clientUrl}${returnTo}`; cookie cleared in response;
      (d) callback with planted hostile cookie value → cookie cleared, 302
      falls through to onboarding default destination (still on-origin);
      (e) callback with no cookie → 302 to onboarding destination (existing
      behavior regression guard — SC-006).

**Checkpoint**: US2 fully functional. Consent login round-trip works; open
redirects rejected.

---

## Phase 5: User Story 3 - agents.md is the accurate front door (P3)

**Goal**: `agents.md` is served publicly at `/agents.md`, content matches the
five FR-002 mandated elements and the corrected flavor default; automated
drift-guard test asserts key claims.

**Independent Test**: `curl -s http://localhost:5173/agents.md` returns the
file with `200`; grep confirms the connect one-liner, the `default portable`
claim, and the mandated tool names. The drift-guard test suite is green.

### Implementation

- [X] T019 [US3] Create `/local-dev/client/public/agents.md` by copying
      `.claude/worktrees/agent-afbf7ebe180bd7de3/client/public/agents.md`
      into place, then applying the corrections listed in
      `contracts/agents-md.md`:
      (a) add a top-level **Connect** section with the exact one-liner
      `claude mcp add --transport http squire https://squiredocs.com/mcp`,
      one paragraph of generic MCP-client guidance (endpoint URL +
      OAuth discovery from the well-known documents), and the `sk_sqd_` PAT
      fallback;
      (b) in "REST endpoints", change `default squire` → `default portable`
      and simplify the bundle-defaults sentence to note bundle is also
      `portable` (with frontmatter on);
      (c) verify the tool list against `/local-dev/server/mcp/tools/` (16
      tools per design doc).

### Tests for User Story 3

- [X] T020 [P] [US3] Create `/local-dev/server/__tests__/agents-md-claims.test.js`
      (drift-guard, per FR-003 and research.md R6). Reads
      `/local-dev/client/public/agents.md` with `fs.readFileSync`. Cases (all
      grep-level string checks): (a) contains `flavor=squire|portable`;
      (b) contains `` `portable` `` (as literal fenced-code prose, the
      `default \`portable\`` claim); (c) does NOT contain `default \`squire\``;
      (d) contains the exact string
      `claude mcp add --transport http squire https://squiredocs.com/mcp`;
      (e) mentions each of `get_tool_documentation`, `modify`,
      `create_access_token`, `read_document`, `list_documents`;
      (f) references both `sk_sqd_` and legacy `sqd_` prefixes.

**Checkpoint**: US3 fully functional. Front door served; drift-guard green.

---

## Phase 6: User Story 4 - Fallback token access and site pointers (P4)

**Goal**: Settings "AI Agent Access" links to `agents.md` alongside existing
PAT management; landing page footer carries exactly one `agents.md` link.

**Independent Test**: Sign in and open `/settings` — the "AI Agent Access"
section shows a link to `/agents.md`. `curl -s http://localhost:5173/ | grep
-c '/agents.md'` returns exactly `1`.

### Implementation

- [X] T021 [P] [US4] In `/local-dev/client/src/pages/SettingsPage.jsx:291`,
      inside the existing `<section>` with heading "AI Agent Access", add a
      one-line paragraph or link element referencing `/agents.md`
      (e.g. `<p className="settings-description">See <a
      href="/agents.md">agents.md</a> for the full connect guide.</p>`), while
      keeping the existing MCP URL row, `AgentDelegationList`, and
      `ApiTokenList` intact. Copy tone matches the existing description.
- [X] T022 [P] [US4] In `/local-dev/client/public/landing.html`, add exactly
      one `<li><a href="/agents.md">Agents</a></li>` to the `Product` footer
      column (~L318-326). No other copy changes.

**Checkpoint**: US4 fully functional. FR-014 and FR-015 satisfied.

---

## Phase 7: Polish & Cross-Cutting Concerns

- [X] T023 [P] Run the three new suites serially:
      `npx jest server/__tests__/oauth-discovery.test.js
              server/__tests__/auth-return-to.test.js
              server/__tests__/agents-md-claims.test.js --runInBand`.
      All three must be green.
- [X] T024 [P] Manual walkthrough of `quickstart.md` sections §1-§9 against
      the dev server. Sections §5 and §6 require an incognito browser.
- [X] T025 Confirm no regression in the existing backend suite: run
      `npx jest --runInBand server/__tests__/` and verify all pre-existing
      suites remain green (Constitution II).
- [X] T026 Sanity re-check `README.md` and `docs/dev.md` for claims about
      the agent surface. If any is falsified by this feature (specifically:
      a claim about the flavor default, or a claim that `/agents.md` is not
      served), correct it in the same commit (Constitution I). No changes
      expected — but check before commit.

---

## Dependencies & Execution Order

### Phase dependencies

- **Phase 1 (Setup)**: no dependencies.
- **Phase 2 (Foundational)**: depends on Phase 1. Blocks Phase 3, 4, 5, 6.
- **Phase 3 (US1)**: depends on Phase 2. Independent of US2/US3/US4 at
  runtime; overlapping-file edits with US2 handled by task ordering below.
- **Phase 4 (US2)**: depends on Phase 2 (specifically T004). Independent of
  US1/US3/US4 at runtime.
- **Phase 5 (US3)**: depends on Phase 2 in name only (no code overlap).
  Independent of all other stories.
- **Phase 6 (US4)**: depends on Phase 5 (references `agents.md` — the file
  must exist for the Settings blurb to point at something real; the
  landing-footer link can technically ship earlier but pointing at a
  nonexistent file is confusing).
- **Phase 7 (Polish)**: depends on all user stories.

### File overlap notes

- `/local-dev/server/auth/routes.js`: T004 (foundational validator) → T012 →
  T013. Sequential (same file).
- `/local-dev/server/mcp/auth/middleware.js`: T005 (foundational challenge
  builder) → T008 → T009. Sequential (same file).
- `/local-dev/server/index.js`: T003 → T006 → T007. Sequential (same file).
- `/local-dev/client/src/contexts/AuthContext.jsx`: T014 and T015 both touch
  this file; do them sequentially (or in a single edit).
- All other US4/US3 tasks are in distinct files and marked [P].

### Within each story

- Foundational (Phase 2) must complete before any story tasks.
- Implementation before tests in a story is acceptable here (tests are HTTP-
  level supertest and don't drive TDD; the underlying pattern in
  `api-docs-export.test.js` is code-first). If a task fails, fix and rerun
  serially.
- Story complete before moving to the next priority (US1 → US2 → US3 → US4).

### Parallel opportunities

- Within US1: T011 [P] can be authored while T006-T010 are landing.
- Within US2: T014, T015, T016 are [P] across client files; T018 is [P] with
  server tasks.
- Within US4: T021 and T022 are [P] (different files).
- Polish: T023 and T024 are [P] (independent activities).

---

## Parallel Example: User Story 2

```
# In parallel while T012/T013 land server-side, the client work can start:
Task: Update login() in /local-dev/client/src/contexts/AuthContext.jsx (T014)
Task: Update LoginPage in /local-dev/client/src/components/LoginPage.jsx (T016)
Task: Update AuthorizePage sign-in link in /local-dev/client/src/pages/AuthorizePage.jsx (T017)

# The test file is authored independently:
Task: Create /local-dev/server/__tests__/auth-return-to.test.js (T018)
```

---

## Implementation Strategy

### MVP scope (User Story 1)

US1 is the design contract's happy path: RFC 9728 discovery + WWW-Authenticate
challenges. Shipping US1 alone would let an MCP client with a signed-in
browser session onboard end-to-end today. It is a defensible MVP if the
pipeline needs to stage.

- Complete Phase 1 (T001-T002).
- Complete Phase 2 (T003-T005).
- Complete Phase 3 (T006-T011).
- Verify US1 quickstart §1-§4 and §8 pass.

### Incremental delivery order

1. Phase 1 + 2 → Foundation ready.
2. Phase 3 (US1) → discovery + challenges → MVP.
3. Phase 4 (US2) → login round-trip → covers the fresh-browser failure mode
   that turns MVP into a shippable product.
4. Phase 5 (US3) → agents.md served with drift-guard → the human-facing
   front door promised by the design doc.
5. Phase 6 (US4) → Settings + landing footer polish.
6. Phase 7 → Polish/regression sweep.

### Solo strategy

This is a solo pipeline (Constitution III); tasks execute sequentially by
default. [P] markers indicate independence for the pipeline's future parallel
worktree execution and for cognitive load management (e.g. do all frontend
[P] tasks in one editor pass), not concurrent implementers.

---

## Notes

- **No DB migration expected**. If any task discovers a schema change is
  required, STOP and escalate — this contradicts a documented spec/plan
  assumption.
- **Backend tests are serial-only** (Constitution II; MEMORY:
  backend-test-db-serial-only). Every test task must be run with `--runInBand`
  or an equivalent single-process runner.
- **No `README.md` or `docs/dev.md` edits are expected** by this feature.
  T026 verifies that claim; if a specific line is falsified, fix in the same
  commit (Constitution I).
- **No changes to token / delegation semantics.** The only auth-header change
  is the `WWW-Authenticate` challenge shape; the JSON body of every 401/403
  is byte-identical to today.

**Total tasks**: 26 (T001-T026).

- Setup: 2 (T001-T002)
- Foundational: 3 (T003-T005)
- US1 (P1): 6 (T006-T011)
- US2 (P2): 7 (T012-T018)
- US3 (P3): 2 (T019-T020)
- US4 (P4): 2 (T021-T022)
- Polish: 4 (T023-T026)
