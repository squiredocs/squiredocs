# Implementation Plan: Agent Onboarding via agents.md + MCP-Native OAuth

**Branch**: `main` (solo pipeline; feature slug `005-agent-onboarding` — no branch created)
| **Date**: 2026-07-14 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `/specs/005-agent-onboarding/spec.md`

## Summary

Close the four gaps that prevent an MCP-native agent from onboarding itself against Squire from the sentence "read squiredocs.com/agents.md and collaborate on docs with me":

1. **Serve `agents.md`** as a public static asset (`client/public/agents.md`), based on the existing worktree draft — corrected (export flavor default is `portable`, not `squire`; add explicit `claude mcp add …` one-liner) and re-verified claim-by-claim.
2. **Publish RFC 9728 protected-resource metadata** at both `/.well-known/oauth-protected-resource/mcp` (path-suffix) and `/.well-known/oauth-protected-resource` (root fallback), each pointing to the MCP endpoint as the resource and the existing authorization server (already at `/.well-known/oauth-authorization-server`).
3. **Emit a machine-actionable `WWW-Authenticate` challenge on every 401** from the MCP auth layer — with `realm`, `resource_metadata` URL, and RFC 6750-conformant `error=` attributes — so a client that lost its credentials mid-session can re-bootstrap discovery. Extend the same pointer to the `authentication` block returned by `GET /mcp`.
4. **Fix the consent login round-trip**: `AuthorizePage` → `LoginPage` → `GET /auth/google` propagates a `returnTo` same-origin relative path, validated server-side (open-redirect defense), carried through Google via a short-lived httpOnly cookie (mirroring the existing `oauth_redirect` mechanism), and honored by the callback in precedence over the onboarding redirect. Dev-login bypass honors it too.

Round it out with a Settings "AI Agent Access" pointer to `agents.md`, a single landing-page footer link, and the first HTTP-level tests for the OAuth-adjacent surface (there are none today). No database migrations; no changes to token/delegation semantics or MCP tool behavior.

## Technical Context

**Language/Version**: Node.js 22+ (Express) backend; React 18 client (JSX in `.jsx`).

**Primary Dependencies**: express, cookie-parser, jsonwebtoken (existing OAuth stack under `server/mcp/auth/`, `server/auth/`); Vite dev + `express.static(clientBuildPath)` for static asset serving; supertest for HTTP-level tests.

**Storage**: no schema changes. Return-destination continuation lives in a short-lived httpOnly cookie (5–15 min band per D5) — no DB row, no Redis key. Existing OAuth code/delegation storage unchanged.

**Testing**: Jest + supertest under `server/__tests__/` (backend suite runs serially per Constitution Principle II; see `server/__tests__/api-docs-export.test.js` for the pattern this feature copies). The `LoginPage`/`AuthorizePage` diffs are one-line query-param plumbing, so no client-side test changes are required. The drift-guard mechanism (see FR-003 resolution in R6) lives in the backend suite for cheap CI coverage.

**Target Platform**: Linux server (Kubernetes `app-dev` pod for local dev; production `squiredocs.com`).

**Project Type**: Web application (React client under `client/`, Express server under `server/`, shared code under `shared/`).

**Performance Goals**: N/A beyond existing endpoints — the well-known documents and the `WWW-Authenticate` header are microseconds of overhead per unauthenticated 401.

**Constraints**:
- Standards conformance is a hard contract, not an internal choice — the feature exists so third-party MCP clients can complete discovery unaided. RFC 9728 (protected-resource metadata), RFC 8414 (authorization-server metadata, already served), RFC 7591 (dynamic client registration, already implemented under `/mcp/auth/register`), PKCE S256 (already enforced), and RFC 6750 (`WWW-Authenticate`) are external contracts.
- Return-destination validation is fail-closed (D4): invalid values are silently discarded and login completes to the default destination — never dead-ended on an error page.
- Trunk-based solo workflow (Constitution III): no branch created; work commits to `main` under this feature slug.

**Scale/Scope**: single-tenant per-user OAuth surface; agent traffic dominated by tool calls, not discovery — the discovery documents are cacheable and hit at most once per client bootstrap.

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

- **I. Documentation Reflects Reality** — `README.md` mentions `/mcp` and the agent surface generally; nothing here changes what the app *is* at a level `README.md` describes (it does not name `agents.md` today). Post-implementation this plan does **not** modify `README.md` or `docs/dev.md` — the design doc `design/agent-surface-mcp.md` is the ground-truth surface, and its content matches what ships (Principle VI). If a `README.md` or `docs/dev.md` claim is falsified during implementation, it MUST be corrected in the same commit. **PASS (with implementation-time watch)**.

- **II. Test-Backed Changes** — Every behavioral change lands with tests: two new supertest files (`oauth-discovery.test.js`, `auth-return-to.test.js`) exercise the new well-known routes, the challenge shape, and the returnTo round-trip. The `agents.md` drift-guard question flagged in the spec is resolved here (see Phase 0 §R6). Backend suite runs serially. **PASS**.

- **III. Trunk-Based Solo Workflow** — No branch created; the pipeline orchestrator commits to `main`. No PR ceremony. **PASS**.

- **IV. Collaboration-Safe Document Operations** — Feature does not touch document mutation code, Yjs, or the format registry. **N/A (PASS)**.

- **V. Secure by Default for Agent & User Content** — The one new trust boundary is the `returnTo` value read from the URL query. It is validated server-side as a same-origin relative path (must start with `/`, must not start with `//`, must not contain `\`, must not parse as a URL with a host); malformed values are silently dropped (D4). The continuation is httpOnly, `SameSite=Lax`, secure in production, and short-lived (5–15 min). **PASS**.

- **VI. Design Docs Are Ground Truth** — This plan is a direct read of `design/agent-surface-mcp.md`'s "Agent onboarding and discovery" section (the feature's contract) and its "Credentials" section (unchanged semantics). All defaults are recorded as **RATIFIED-BY-DEFAULT** in `clarifications-needed.md`. No silent resolution of gaps. **PASS**.

No violations; no Complexity Tracking entries.

## Project Structure

### Documentation (this feature)

```text
specs/005-agent-onboarding/
├── plan.md                 # This file (/speckit-plan output)
├── research.md             # Phase 0 output
├── data-model.md           # Phase 1 output
├── quickstart.md           # Phase 1 output
├── contracts/              # Phase 1 output
│   ├── protected-resource-metadata.md
│   ├── www-authenticate-challenge.md
│   ├── returnto-continuation.md
│   └── agents-md.md
├── tasks.md                # Phase 2 output (/speckit-tasks)
├── spec.md                 # (existing)
├── clarifications-needed.md
├── promotion-notes.md
└── checklists/
    └── requirements.md
```

### Source Code (repository root)

```text
client/
├── public/
│   ├── agents.md                              # NEW (static asset served at /agents.md; Vite copies public/ → dist/)
│   └── landing.html                           # MODIFIED (add one footer link to /agents.md)
└── src/
    ├── contexts/
    │   └── AuthContext.jsx                    # MODIFIED (login accepts returnTo; propagates as ?returnTo=<encoded>; dev-login honors it)
    ├── components/
    │   └── LoginPage.jsx                      # MODIFIED (read returnTo from URL query, pass to login())
    ├── pages/
    │   ├── AuthorizePage.jsx                  # MODIFIED (~L224: relative /login?returnTo=<path+query>, not absolute URL)
    │   └── SettingsPage.jsx                   # MODIFIED (~L291: AI Agent Access blurb links to /agents.md; keep MCP URL row)

server/
├── index.js                                   # MODIFIED (~L324: add both /.well-known/oauth-protected-resource routes;
│                                              #  refactor existing well-known handler to reuse buildBaseUrl)
├── url.js                                     # (existing; buildBaseUrl reused)
├── auth/
│   └── routes.js                              # MODIFIED (GET /auth/google validates returnTo → oauth_return_to cookie;
│                                              #  callback redirects to returnTo when present, takes precedence over onboarding)
├── mcp/
│   ├── index.js                               # MODIFIED (L101-106: add resource_metadata URL to authentication block in GET /mcp)
│   └── auth/
│       └── middleware.js                      # MODIFIED (requireAgentAuth: every 401 sets WWW-Authenticate; error attr per branch;
│                                              #  requireScope: 403 sets WWW-Authenticate with error="insufficient_scope")
└── __tests__/
    ├── oauth-discovery.test.js                # NEW (both well-known docs; 401 challenge shape; 200 → no challenge)
    ├── auth-return-to.test.js                 # NEW (valid returnTo cookie set; hostile forms rejected; callback honors it)
    └── agents-md-claims.test.js               # NEW (cheap drift-guard: grep-level claim checks against agents.md — R6)
```

**Structure Decision**: Web application layout. Backend changes concentrated in `server/mcp/auth/middleware.js`, `server/auth/routes.js`, and `server/index.js` (well-known routes). Frontend changes are one-line query-param plumbing in `AuthContext.jsx`, `LoginPage.jsx`, `AuthorizePage.jsx`, plus a Settings blurb and a landing-page footer link. No new server modules; no shared/-directory changes; no schema migrations.

## Phase 0: Research

See [research.md](./research.md). Summary of decisions:

- **R1** Continuation cookie mechanism: reuse the existing `oauth_redirect` pattern in `server/auth/routes.js` (httpOnly, `SameSite=Lax`, `secure` in production, 5-minute `maxAge`). Name: `oauth_return_to`. **TTL = 10 minutes** (upper mid of D5's 5–15 min band — covers slow Google logins and password managers without materially extending the replay window; recorded here so D5's "fix at plan time" is discharged).
- **R2** Server-side returnTo validation: value must (a) be a string ≤ 512 chars, (b) start with exactly one `/`, (c) NOT start with `//` (protocol-relative), (d) NOT contain `\` (backslash open-redirect variants), (e) when parsed with `new URL(value, 'http://placeholder')` must produce host === 'placeholder' (i.e. host-parseable but with no embedded authority). Failure → drop silently (D4), do not set the cookie.
- **R3** WWW-Authenticate shape per branch (RFC 6750 §3 + RFC 9728 §5.3):
  - Missing credentials: `WWW-Authenticate: Bearer realm="mcp", resource_metadata="https://<origin>/.well-known/oauth-protected-resource/mcp"` (no `error=` per RFC 6750 §3 when credentials absent).
  - Malformed / invalid signature / decode error: `Bearer realm="mcp", error="invalid_token", error_description="…", resource_metadata="…"`.
  - Expired token: `Bearer realm="mcp", error="invalid_token", error_description="The access token expired", resource_metadata="…"`.
  - Insufficient scope (`requireScope` 403): `Bearer realm="mcp", error="insufficient_scope", scope="documents:read documents:write", resource_metadata="…"`.
  JSON body shape stays exactly as today (the challenge is a header add, not a body change).
- **R4** Both protected-resource documents (path-suffix and root fallback) describe the MCP endpoint as the resource and reference the origin's issuer as the authorization server (D6):
  ```json
  {
    "resource": "https://<origin>/mcp",
    "authorization_servers": ["https://<origin>"],
    "scopes_supported": ["documents:read", "documents:write"],
    "bearer_methods_supported": ["header"],
    "resource_name": "Squire Docs MCP"
  }
  ```
  Both documents are byte-identical; both use `buildBaseUrl(req)` from `server/url.js`.
- **R5** returnTo callback precedence: the `google/callback` handler, after minting session cookies, checks `req.cookies.oauth_return_to`. If present, clear the cookie unconditionally, re-validate the value (defense in depth), and if valid redirect to `${clientUrl}${returnTo}`. If absent or invalid, fall through to the existing `onboarding.resolveOnboarding` branch. Return cookie is *always* cleared on this request regardless of whether it was honored.
- **R6** agents.md drift-guard mechanism: prefer a cheap automated test over a checklist entry. `server/__tests__/agents-md-claims.test.js` reads `client/public/agents.md` from disk and asserts (a) it contains `flavor=squire|portable` and the substring "default `portable`" and does NOT contain the exact stale phrase `default \`squire\``, (b) it contains the `claude mcp add --transport http squire https://squiredocs.com/mcp` one-liner, (c) it names at least `get_tool_documentation`, `modify`, and `create_access_token`, and (d) it references both the `sk_sqd_` and legacy `sqd_` prefixes. Cheap, deterministic, catches the exact drift class FR-003 flagged. **Choice recorded.**
- **R7** dev-login returnTo behavior: `AuthContext.devLogin` posts to `/auth/dev-login` and receives JSON; there is no server redirect. The client, after a successful dev-login, uses the returnTo query param if present (client-side redirect) rather than relying on cookies — matches the existing dev-login UX (no round-trip) while still honoring the consent flow in local development.

**All NEEDS CLARIFICATION items resolved.**

## Phase 1: Design & Contracts

Details in [data-model.md](./data-model.md), [contracts/](./contracts/), [quickstart.md](./quickstart.md).

**Contracts to publish**:

- `contracts/protected-resource-metadata.md` — the JSON shape returned by both `/.well-known/oauth-protected-resource` and `/.well-known/oauth-protected-resource/mcp`. Fields: `resource`, `authorization_servers`, `scopes_supported`, `bearer_methods_supported`, `resource_name`.
- `contracts/www-authenticate-challenge.md` — the `WWW-Authenticate` header shape for each 401/403 branch (missing / invalid / expired / insufficient scope), including the RFC 6750 rule that `error` is omitted when credentials are absent.
- `contracts/returnto-continuation.md` — the returnTo continuation contract: URL query param (`?returnTo=<encoded>`), validation rules (R2), cookie shape (`oauth_return_to`, httpOnly, Lax, 10-min TTL), single-use consume-on-callback semantics, fail-closed to default destination.
- `contracts/agents-md.md` — the shipped `agents.md` content contract: the five FR-002 mandated elements, the flavor default correction (`portable`), and the connect one-liner shape.

**Data model** (`data-model.md`): the only new *entity* is the returnTo continuation, and it is transient (cookie value). See spec's Key Entities and the `returnto-continuation` contract. No new persisted entities, no schema.

**Quickstart** (`quickstart.md`): end-to-end validation — start the dev pod, curl `/.well-known/oauth-protected-resource`, curl the MCP endpoint unauthenticated to observe the challenge, open `/authorize?...` in an incognito browser, complete Google sign-in, verify landing back on the consent page with parameters intact, curl `/agents.md`. Also: how to run the two new supertest files serially.

**Post-design Constitution Check re-evaluation**: no new violations introduced by the design; still PASS on I–VI.

## Complexity Tracking

None. No violations to justify.

## Implementation notes carried into tasks

**Bug/security fix specifics (as agreed with Sam, verified against the tree)**:

- **B1 (returnTo login round-trip)**: `client/src/contexts/AuthContext.jsx:136` — `login(returnTo)` builds `/auth/google?returnTo=<encodeURIComponent(returnTo)>` when `returnTo` is a truthy same-origin relative path; the `BYPASS_AUTH` branch delegates to `devLogin(returnTo)`. `client/src/components/LoginPage.jsx:12` reads `returnTo` from `new URLSearchParams(window.location.search)` and passes it to `login()`. `client/src/pages/AuthorizePage.jsx:224` — change the `href` from `` /login?returnTo=${encodeURIComponent(window.location.href)} `` to `` /login?returnTo=${encodeURIComponent(window.location.pathname + window.location.search)} `` (relative path+query, not absolute URL — the whole point of R2). `server/auth/routes.js` — in `GET /auth/google`, read `req.query.returnTo`, run the R2 validator, and on success set `res.cookie('oauth_return_to', returnTo, { httpOnly: true, maxAge: 10 * 60 * 1000, sameSite: 'lax', secure: isProduction })` next to the existing `oauth_redirect` cookie. In `GET /auth/google/callback`, after minting session cookies, read `req.cookies.oauth_return_to`, always `res.clearCookie('oauth_return_to')`, re-validate, and if valid `res.redirect(${clientUrl}${returnTo})` — taking precedence over the onboarding branch.

- **B2 (RFC 9728 well-known)**: `server/index.js:324` — next to the existing `/.well-known/oauth-authorization-server`, register `GET /.well-known/oauth-protected-resource/mcp` and `GET /.well-known/oauth-protected-resource`, both returning the R4 JSON, both using `buildBaseUrl(req)`. **Refactor** the existing authorization-server handler in the same commit to use `buildBaseUrl` — the manual `host.includes('squiredocs.com') ? 'https' : req.protocol` block is exactly what `buildBaseUrl` centralizes.

- **B3 (WWW-Authenticate)**: `server/mcp/auth/middleware.js` — the challenge builder is a small helper that composes the `Bearer …` string from `buildBaseUrl(req)`. Every existing `res.status(401).json(…)` in `requireAgentAuth` gets `res.set('WWW-Authenticate', challenge(…))` first (missing token → no `error=`; expired → `error="invalid_token"`, `error_description="Agent token expired"`; invalid → `error="invalid_token"`, `error_description="Invalid agent token"`). `requireScope`'s 403 gets `error="insufficient_scope"` and the scope list. `server/mcp/index.js:101-106` — add `resource_metadata: \`${baseUrl}/.well-known/oauth-protected-resource/mcp\`` to the `authentication` block.

- **B4 (agents.md on trunk)**: `client/public/agents.md` — copy the draft from `.claude/worktrees/agent-afbf7ebe180bd7de3/client/public/agents.md`, apply the following diffs before commit:
  - Add a top-level **Connect** section with the exact one-liner `claude mcp add --transport http squire https://squiredocs.com/mcp`, one paragraph of generic MCP client guidance (endpoint + OAuth discovery), and the `sk_sqd_` PAT fallback.
  - In "REST endpoints", change `default squire` → `default portable`; drop the sentence claiming bundle defaults to portable specifically (all formats default to portable now, per `server/api/docs-export.js:185`).
  - Verify the tool list against `server/mcp/tools/` (the design doc says sixteen).
  - Keep the "legacy `sqd_` tokens remain valid" clause — matches `apiTokens.isApiToken` behavior.

- **B5 (Settings + landing footer)**: `client/src/pages/SettingsPage.jsx:291` — the "AI Agent Access" `<section>` already exists; add one line of copy referencing `/agents.md` (link) and keep the MCP URL row. `client/public/landing.html` — under `landing-footer-column` "Product", add `<li><a href="/agents.md">Agents</a></li>` (single link, FR-015).

- **B6 (tests)**: two new supertest files described above; the drift-guard is a third cheap grep-level test file. Follow the serial-only pattern from `server/__tests__/api-docs-export.test.js`. Mock `../auth/google` for the returnTo tests so no external network is touched; `verifyIdToken`/`exchangeCodeForTokens` return a fixture.

**No DB migration is needed.** If any implementation task discovers one is required (e.g., a persisted returnTo record), STOP and escalate — it violates the "no schema changes" assumption in this plan and in the spec.
