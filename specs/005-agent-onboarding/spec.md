# Feature Specification: Agent Onboarding via agents.md + MCP-Native OAuth

**Feature Branch**: `005-agent-onboarding` (feature slug; work happens on the pipeline's assigned tree — no branch created by this spec)

**Created**: 2026-07-14

**Status**: Draft

**Input**: User description: "Agent onboarding via agents.md + MCP-native OAuth (PKCE authorization-code flow, no device flow). A user signs up on the web with Google. In their agentic tool they say 'read squiredocs.com/agents.md to collaborate on docs with me.' The agent fetches agents.md, adds the MCP server, and the client's built-in OAuth bootstraps: browser opens or URL printed, user approves from their logged-in Squire account on the consent page, agent is connected — gh/aws-CLI-like UX via standard MCP OAuth. Fallback: sk_sqd_ personal access token from Settings."

**Design ground truth**: `design/agent-surface-mcp.md`, sections "Agent onboarding and discovery" (this feature's contract) and "Credentials". Per Constitution Principle VI, where this spec and that document disagree, the document wins; gaps are ledgered in `clarifications-needed.md`, never resolved silently.

## Overview

Squire's pitch is "bring your own agent," but today an agent cannot onboard itself: there is no agent-facing front door (`/agents.md` is not served in production), an unauthenticated call to the agent endpoint returns a bare 401 that standards-compliant MCP clients cannot act on, the protected-resource discovery document does not exist, and — worst — a user who is not signed in when the consent page opens is bounced through login and dead-ends on the app's document list with the authorization request lost. This feature closes those four gaps so that the sentence "read squiredocs.com/agents.md to collaborate on docs with me," typed into any MCP-native agentic tool, ends with a connected, consented, attributed agent — with no value copied by hand.

Explicitly in scope: serving an accurate `agents.md`, completing the standards-based auth discovery chain, fixing the consent login round-trip (with open-redirect defenses), a Settings "AI Agent Access" pointer, and a landing-page footer link. Explicitly out of scope: device flow (RFC 8628 — Sam, 2026-07-13), any new credential semantics, and honoring the RFC 8707 `resource` parameter (accepted gap, unchanged).

## User Scenarios & Testing *(mandatory)*

### User Story 1 - One-sentence agent onboarding for a signed-in user (Priority: P1)

Sam has a Squire account (Google sign-in) and is logged in in his browser. In his agentic tool he types: "Read squiredocs.com/agents.md and collaborate on docs with me." The agent fetches `agents.md`, learns the MCP endpoint and the exact connect command, and adds the server. On first contact the service tells the client — through standard, machine-readable discovery metadata — where and how to authorize. The client registers itself, opens the browser (or prints a URL) to the consent page, Sam clicks Approve on his logged-in account, and the agent is connected with a delegation of Sam's access. Sam never copies a client ID, token, or endpoint by hand.

**Why this priority**: This is the product story verbatim and the feature's reason to exist. Every other story either feeds it (the front door), rescues it (login round-trip), or backstops it (token fallback).

**Independent Test**: With a signed-in browser session, point a standards-compliant MCP client at the published endpoint (or at `agents.md` and follow its instructions) with zero manual configuration; verify the client discovers authorization on its own, the consent page appears, approval connects the agent, and a subsequent tool call (e.g. listing documents) succeeds as a delegated agent.

**Acceptance Scenarios**:

1. **Given** an MCP client with no credentials, **When** it calls the MCP endpoint, **Then** the response is an authentication challenge that carries a machine-readable pointer to the service's protected-resource metadata (per RFC 9728 conventions), sufficient for the client to begin authorization with no out-of-band configuration.
2. **Given** the challenge from scenario 1, **When** the client fetches the protected-resource metadata (at the path-suffix form for the MCP endpoint, or the root fallback), **Then** it learns the authorization server, and the existing chain — authorization-server metadata, dynamic client registration, authorization-code + PKCE (S256 only), consent, token — completes without any manually supplied value.
3. **Given** a signed-in user on the consent page reached via that chain, **When** they approve, **Then** a delegation is created, the client obtains tokens, and the agent's subsequent tool calls succeed and are attributed as agent-on-behalf-of-user (existing semantics, unchanged).
4. **Given** a signed-in user on the consent page, **When** they deny, **Then** the client receives the standard denial and no delegation or credential is created.
5. **Given** the connected agent, **When** its access expires, **Then** the client refreshes without user interaction (existing refresh behavior, preserved through this feature).

---

### User Story 2 - Consent survives the login round-trip (Priority: P2)

Riley installed her agentic tool on a new machine; her browser has no Squire session. Her agent starts the same authorization flow and the consent page opens — but she isn't signed in. She clicks the sign-in link, completes Google login, and lands **back on the consent page with the original authorization request fully intact**. She approves; her agent connects. Today this journey is broken: login discards the pending request and strands her on the document list, and the agent times out.

**Why this priority**: This is a known critical bug in the P1 journey's most common variant (fresh browser, new machine, incognito). P1 is demonstrable without it only for already-signed-in users; shipping P1 without P2 means the flow fails for exactly the users doing first-time setup.

**Independent Test**: In a browser with no session, open a consent URL (with valid authorization parameters), follow the sign-in link, complete Google login, and verify arrival back at the consent page with all original parameters intact and consent completable.

**Acceptance Scenarios**:

1. **Given** a signed-out browser landing on the consent page with valid authorization parameters, **When** the user follows the sign-in path and completes Google login, **Then** they return to the consent page with every original authorization parameter intact and can approve or deny.
2. **Given** a post-login return destination naming a same-origin relative path, **When** login completes, **Then** the user is sent to that path, and this takes precedence over the default signup/onboarding destination.
3. **Given** a return destination that is not a same-origin relative path — an absolute URL, a protocol-relative form (`//host/…`), a backslash variant, or otherwise malformed — **When** login completes, **Then** the value is rejected by server-side validation and the user is sent to the normal default destination; the browser is never redirected off-origin (open-redirect defense).
4. **Given** a brand-new user (no Squire account) landing on the consent page, **When** they complete Google sign-up through the same path, **Then** account creation succeeds and they still return to the pending consent request rather than the new-user onboarding destination.
5. **Given** a user logging in normally (no pending consent request), **When** login completes, **Then** the existing signup/onboarding destination behavior is unchanged (regression guard).

---

### User Story 3 - agents.md is the accurate agent front door (Priority: P3)

An agent (or a curious developer) fetches `https://squiredocs.com/agents.md` and gets everything needed to connect and be productive: the MCP endpoint, exact connect one-liners for common clients, both credential options (OAuth and `sk_sqd_` tokens), tool orientation — above all the "call `get_tool_documentation` before your first script" imperative — and the REST export/import recipe. Every claim in the file matches the live surface; per the design doc, drift between `agents.md` and the implemented surface is a bug, not a doc nit.

**Why this priority**: The front door is what the user actually points their agent at, but P1's discovery chain functions without it (a client pointed straight at the endpoint self-discovers). It lands on trunk in this feature by Sam's decision (2026-07-13). A near-complete draft exists and needs correction — notably it still claims the export default is the `squire` flavor, while the shipped default is `portable`.

**Independent Test**: Fetch `/agents.md` unauthenticated from the running app; verify it is served publicly as a static asset and that each factual claim (endpoint, connect command, credential options, export defaults, tool guidance) matches observed behavior of the live surface.

**Acceptance Scenarios**:

1. **Given** an unauthenticated HTTP client, **When** it requests `/agents.md`, **Then** the file is served publicly (no login, no token) as plain markdown.
2. **Given** the served file, **When** its content is checked against the design contract, **Then** it contains all five mandated elements: MCP endpoint, exact connect one-liner(s) (e.g. `claude mcp add --transport http squire https://squiredocs.com/mcp`), both credential options, the `get_tool_documentation` orientation imperative, and the REST export/import recipe.
3. **Given** the served file, **When** its factual claims are compared to the implemented surface, **Then** none contradict observed behavior — specifically the REST export flavor default is documented as `portable`.

---

### User Story 4 - Discoverable fallback: token access and site pointers (Priority: P4)

A user whose client can't complete browser OAuth (a headless script, a CI job, an older tool) goes to Settings, where the existing "AI Agent Access" area now also points at `agents.md` and shows the connect one-liner alongside the existing personal-access-token management; they create an `sk_sqd_` token and use it as a bearer credential, as `agents.md` documents. Separately, a visitor skimming the marketing/landing page finds one footer link to `agents.md` and learns Squire is agent-ready.

**Why this priority**: Fallback and discoverability polish. Token semantics already exist and work; this story only makes them findable and ties the site to the front door.

**Independent Test**: Open Settings and verify the AI Agent Access area links to `agents.md` and shows a copyable connect one-liner; verify the landing page footer carries one link to `agents.md`; verify `agents.md` documents bearer-token usage.

**Acceptance Scenarios**:

1. **Given** a signed-in user in Settings, **When** they view the AI Agent Access area, **Then** it references `agents.md` and presents the MCP connect one-liner, adjacent to existing token management.
2. **Given** a client presenting a valid `sk_sqd_` token as a bearer credential, **When** it calls the MCP endpoint, **Then** it authenticates without any OAuth interaction (existing behavior, unchanged and now documented).
3. **Given** a visitor on the landing page, **When** they scan the footer, **Then** exactly one link leads to `agents.md`.

---

### Edge Cases

- **Hostile return destination**: encoded traversal (`%2F%2Fevil.com`), backslash forms (`/\evil.com`), absolute URLs, javascript-scheme or data-scheme values, or an empty value — all must fail server-side validation closed (default destination, same origin, no error-page dead-end).
- **Stale or replayed consent return**: the user takes long enough logging in that the carried return context expires, or completes login in a different tab — they land on the default destination signed in; re-running the agent flow issues a fresh authorization request. No dead-end, no cross-session honoring of a pending request.
- **Challenge on every unauthenticated path**: expired token, revoked delegation, malformed credential, and missing credential must all produce the same machine-actionable challenge — a client that lost its credentials mid-session can re-bootstrap discovery without operator help.
- **Discovery metadata shape**: clients differ in whether they request the path-suffix or root well-known form of the protected-resource document — both must resolve (design mandate), and both must point at the same authorization server.
- **`resource` parameter**: a client sending the RFC 8707 `resource` parameter to the token endpoint gets it accepted and ignored (accepted gap; must not error).
- **Denied then retried consent**: a user who denies, then re-runs the agent's flow, gets a fresh consent request that can succeed (no poisoned state).
- **agents.md drift**: a future surface change (new default, renamed tool, changed endpoint) that contradicts `agents.md` is a defect by design-doc fiat — the spec requires an automated or checklist guard so drift is caught, not discovered by an agent in the wild.
- **Non-MCP fetchers of agents.md**: browsers and plain curl get readable markdown (no auth wall, no HTML shell requirement).

## Requirements *(mandatory)*

### Functional Requirements

**Front door (agents.md)**

- **FR-001**: The system MUST serve `agents.md` publicly at the site root path `/agents.md` as a static asset, with no authentication, for any HTTP client.
- **FR-002**: `agents.md` MUST contain the five design-mandated elements: (a) the MCP endpoint, (b) exact connect one-liner(s) for common agentic clients, (c) both credential options (interactive OAuth and `sk_sqd_` bearer tokens), (d) tool orientation including the imperative to call `get_tool_documentation` before writing a first script, and (e) the REST export/import recipe.
- **FR-003**: Every factual claim in `agents.md` MUST match the implemented surface at the time it ships; the known stale claim in the existing draft (export flavor default) MUST be corrected to `portable`. Drift between `agents.md` and the surface is a defect (design-doc mandate), and the feature MUST include a verification mechanism (test or release-checklist item) that checks the file's key claims against observed behavior.

**Auth discovery chain**

- **FR-004**: Every unauthenticated or invalidly-authenticated request to the MCP endpoint MUST receive an authentication challenge that includes a machine-readable pointer (per RFC 9728 / MCP authorization conventions: `WWW-Authenticate: Bearer resource_metadata="…"`) to the protected-resource metadata document. This MUST hold uniformly for missing, malformed, expired, and revoked credentials.
- **FR-005**: The system MUST publish RFC 9728 protected-resource metadata for the MCP endpoint at **both** the path-suffix well-known form (`/.well-known/oauth-protected-resource/mcp`) and the root fallback (`/.well-known/oauth-protected-resource`), each identifying the MCP endpoint as the resource and referencing the existing authorization server.
- **FR-006**: The complete discovery chain — challenge → protected-resource metadata → authorization-server metadata → dynamic client registration → authorization-code + PKCE (S256 only) → consent → token — MUST be completable by a standards-compliant MCP client with zero manually configured values. (The post-challenge links in this chain already exist and MUST be preserved unchanged.)
- **FR-007**: The system MUST NOT implement the device authorization grant (RFC 8628); it is explicitly out of scope (Sam, 2026-07-13).
- **FR-008**: The token endpoint MUST continue to accept and ignore the RFC 8707 `resource` parameter (accepted gap; no error, no echo commitment).

**Consent login round-trip**

- **FR-009**: A user who reaches the consent page without an authenticated session MUST be offered a sign-in path that, after successful Google login (including first-time account creation), returns them to the consent page with all original authorization parameters intact.
- **FR-010**: The post-login return destination MUST be validated **server-side** as a same-origin relative path only. Absolute URLs, protocol-relative forms (`//host`), backslash variants, non-HTTP-path schemes, and malformed values MUST be rejected, in which case login completes to the normal default destination. The browser MUST never be redirected off-origin by this mechanism.
- **FR-011**: A valid pending return destination MUST take precedence over the default post-login signup/onboarding destination; in its absence, existing post-login behavior MUST be unchanged (regression requirement).
- **FR-012**: The return destination MUST survive the third-party (Google) login round-trip without loss, MUST be short-lived, and MUST NOT be honorable by a different browser session than the one that initiated it.

**Consent and delegation (preserved semantics)**

- **FR-013**: Consent approval MUST create a delegation with existing semantics (1-hour access tokens, 30-day rotating refresh tokens, revocation cascade); denial MUST create nothing. This feature changes how users *reach* consent, not what consent *does*.

**In-app and site discoverability**

- **FR-014**: The Settings "AI Agent Access" area MUST reference `agents.md` and present the MCP connect one-liner, adjacent to existing personal-access-token management.
- **FR-015**: The public landing page footer MUST carry exactly one link to `agents.md` (RATIFIED-BY-DEFAULT D1).

### Key Entities

- **agents.md (agent front door)**: a public, static markdown document — the contract surface for agent onboarding; owned by the design doc; five mandated content elements; accuracy is a correctness property, not a documentation nicety.
- **Protected-resource metadata**: the machine-readable statement "this endpoint is a protected resource; authorize over there" (RFC 9728); exists in path-suffix and root forms; the link that turns a 401 into a self-service bootstrap.
- **Pending authorization return (returnTo continuation)**: a short-lived, same-origin-relative-path-only record of "where to resume after login"; security-sensitive (open-redirect defense); carried across the Google round-trip; outranks onboarding redirects; useless outside the initiating browser session.
- **Delegation** *(existing, unchanged)*: the consented grant linking an OAuth client to a user; created at consent approval; revocation cascades.
- **Personal access token (`sk_sqd_`)** *(existing, unchanged)*: the non-interactive fallback credential; scoped, expiring, managed in Settings.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: A signed-in user can go from typing the one-sentence instruction in a compliant agentic tool to a connected, working agent in under 2 minutes, copying **zero** values by hand (no client IDs, secrets, tokens, or endpoint URLs beyond the initial agents.md address).
- **SC-002**: A signed-out user completes the same journey with exactly one extra step (signing in) and **zero** dead-ends: 100% of consent-initiated logins return to the consent page with the authorization request intact (today: 0%).
- **SC-003**: 100% of a crafted battery of off-origin / malformed return destinations (absolute, protocol-relative, backslash, encoded, scheme-bearing) are rejected server-side and result in an on-origin default destination — zero open redirects.
- **SC-004**: A standards-compliant MCP client given only the MCP endpoint URL (not even agents.md) self-discovers authorization and connects with zero manual configuration.
- **SC-005**: 100% of the factual claims in the shipped `agents.md` (endpoint, connect command, credential options, export defaults, tool names) match observed behavior of the live surface, verified by the FR-003 mechanism.
- **SC-006**: Existing flows show zero regressions: normal login/signup still lands on the onboarding destination, PAT-authenticated MCP and REST calls behave identically, and existing OAuth clients with valid tokens see no behavior change.

## Assumptions

- The OAuth authorization server (authorize, token, revoke, register; PKCE S256; authorization-server metadata; consent page) already exists and works for signed-in users; this feature adds the discovery front half and the login round-trip, and does not modify grant or token semantics.
- Static assets placed in the client's public assets directory are already served in production at the site root; serving `agents.md` requires content, not new serving machinery.
- Google is the only interactive login method; "login round-trip" therefore means the Google flow (including first-time sign-up through it).
- The existing `agents.md` draft (from prior worktree exploration) is a sound content baseline; it is adopted, corrected (portable export default), and verified claim-by-claim rather than rewritten from scratch (RATIFIED-BY-DEFAULT D2).
- No database schema changes are expected; the return-destination continuation is transient state, not a persisted entity.
- No OAuth-flow tests exist today; this feature introduces the first ones, following the project's existing HTTP-level test patterns, run serially per Constitution Principle II.
- `squiredocs.com` is the canonical public origin used in agents.md examples; local/dev deployments serve the same relative paths.
- The stdio bridge and non-HTTP transports are out of scope for onboarding; the flow is specified for the streamable-HTTP MCP endpoint (the bridge simply proxies it).

## Out of Scope

- Device authorization grant (RFC 8628) — decided against (Sam, 2026-07-13); revisit only if a covered client can do neither PKCE-with-localhost-redirect nor tokens.
- Honoring/echoing the RFC 8707 `resource` parameter (accepted and ignored, unchanged).
- Any change to MCP tool behavior, scopes, delegation semantics, token formats, or the modify pipeline.
- New credential types, per-document token scoping, or changes to `sk_sqd_` semantics.
- Marketing-page redesign beyond the single footer link; Settings redesign beyond the AI Agent Access additions.
