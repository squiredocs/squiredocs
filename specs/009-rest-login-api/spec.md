# Feature Specification: REST Login API — the device pairing is an API, MCP is one client of it

**Feature Branch**: `009-rest-login-api` (feature slug; work happens on the pipeline's assigned tree — no branch created by this spec)

**Created**: 2026-07-15

**Status**: Draft

**Input**: User description: "009-rest-login-api — split the device-pairing login flow from MCP: first-class REST endpoints, next-step guidance in the approved payload, API discoverability, agents.md restructured as a choose-your-channel guide"

**Design ground truth**: `design/agent-surface-mcp.md`, section "Amendment — the login flow is an API, MCP is one client of it (feature 009, Sam, 2026-07-15)" (this feature's contract), with the parent section "MCP-native onboarding: the login tool (feature 008)" as binding context — its contracts (rate limits, one-shot semantics, uniform errors, no existence oracle, credential handling) are inherited by the new endpoints **unchanged**. The 008 clarifications ledger (`specs/008-mcp-login-bootstrap/clarifications-needed.md`, D1–D13) remains binding. Per Constitution Principle VI, where this spec and the design document disagree, the document wins; material gaps and tensions are ledgered in `clarifications-needed.md`, never resolved silently.

## Overview

Live onboarding tests (2026-07-15) showed that agents treat the 008 login flow as MCP-shaped: both testers first concluded `claude mcp add` was a prerequisite, and the one that succeeded via curl called its path a "manual reimplementation" and finished by recommending bare (uncredentialed) registration — causing a second auth prompt and two credential stores. The design decision is to split the concepts: the device pairing becomes a first-class REST API (`POST /api/login/start`, `GET /api/login/status`, `GET /api/login/claim`), and the MCP `login`/`login_status` tools become one client of it. All surfaces are thin wrappers over the one existing login-service state machine — no second implementation, and **no change to the state machine itself**. The approved payload additionally teaches the agent its next step (a pre-filled credentialed registration one-liner plus the top REST recipes), the `GET /mcp` discovery manifest and anonymous server instructions name the REST path, and `agents.md` is restructured as a choose-your-channel guide that leads with "have a shell? nothing to install."

**Trust boundary statement (Constitution Principle V)**: this feature extends Squire's anonymous application surface (opened by feature 008) with two new unauthenticated REST routes (`POST /api/login/start`, `GET /api/login/status`) and a rename-with-alias of a third (`GET /api/login/claim`). No new class of untrusted input is introduced: the inputs (agent name, handle) and their validation, length caps, inert rendering, constant-time comparison, per-IP and global caps, and rate limits are exactly 008's, applied through the same service. The new endpoints MUST inherit that posture identically — same limits drawn from the **same budgets** (not fresh per-route budgets), same one-shot semantics, same uniform errors, no existence oracle, credentials only ever delivered over the byte channel or the explicitly opted-in inline path. The anonymous surface still touches no documents and can mint no credential without an authenticated human approving on the consent page.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - An agent with a shell pairs entirely over plain REST (Priority: P1)

An agent that has a shell (curl) but no MCP client attachment — or one that simply prefers HTTP — completes the whole device pairing against three plain REST endpoints: it starts the pairing with a JSON POST, relays the code and `/activate` URL to its user, polls a plain-JSON status endpoint authenticated by the handle, and claims the credential with the returned one-shot recipe. No JSON-RPC envelopes, no double-encoded text blocks, no MCP client, no CLI install. The pairing is the same flow regardless of door: a pairing started over REST can be polled through the MCP tool and vice versa, and the existing `/api/mcp/login/claim` URL keeps working as an alias of the canonical claim path.

**Why this priority**: This is the amendment's reason to exist — the live-test failure was agents concluding the flow required MCP plumbing. Making the REST path first-class (not a "manual reimplementation") is the fix; everything else in this feature guides agents to it or teaches the step after it.

**Independent Test**: With no credential and no MCP client, drive the full pairing with curl alone: POST start → receive code/URI/handle as plain JSON → approve at `/activate` in a browser → GET status with the Bearer handle → receive the one-shot approved payload → run the claim command → verify the claimed credential authenticates both the REST `/api` routes and an MCP connection. Separately verify cross-channel equivalence (start via REST, poll via the MCP tool, and the reverse) and that the alias claim URL behaves byte-identically to the canonical one.

**Acceptance Scenarios**:

1. **Given** an agent with no credential, **When** it sends `POST /api/login/start` with a JSON body `{ "agentName": "..." }`, **Then** it receives a plain JSON response carrying at minimum `userCode`, `verificationUri`, `handle`, and `pollIntervalSeconds` (the design-enumerated fields), with no JSON-RPC envelope and no double-encoded text blocks.
2. **Given** a started pairing whose user has approved at `/activate` (the 008 journey, unchanged), **When** the agent sends `GET /api/login/status` with `Authorization: Bearer <handle>`, **Then** it receives — exactly once — the approved payload with the claim recipe, handling instructions, and the `nextSteps` block, as plain JSON with the same status contract as the `login_status` tool.
3. **Given** the approved payload, **When** the agent runs the claim command, **Then** `GET /api/login/claim` streams the credential bytes to an owner-only (0600) file exactly once, and the credential works as a bearer credential on both the REST `/api` routes and a fresh MCP connection.
4. **Given** a pairing started over REST, **When** its handle is polled via the MCP `login_status` tool (or a tool-started pairing is polled over REST), **Then** both channels observe the identical state machine — one pairing, shared poll-interval state, one one-shot delivery between them.
5. **Given** an agent following a pre-009 recipe, **When** it claims at `GET /api/mcp/login/claim`, **Then** the alias behaves byte-identically to the canonical path (same handler, same responses) and consumes the same one-shot.
6. **Given** any status or claim request, **When** the handle is offered anywhere other than the `Authorization: Bearer` header (e.g. a query parameter), **Then** it is not accepted as a handle carrier (the 008 review's log-safety rule holds on every login route).

---

### User Story 2 - The REST surface inherits 008's security contract unchanged (Priority: P2)

The new endpoints are the same flow wearing a different door, so an attacker gains nothing from the new door: the same rate limits drawn from the same budgets, the same outstanding-pending caps, the same one-shot semantics, the same uniform errors, and no existence oracle anywhere. Nothing about the state machine, `/activate`, delegation, or minting changes.

**Why this priority**: Constitution Principle V makes the trust boundary of an extended anonymous surface a spec-level obligation, and the design's "identical rate limits, one-shot semantics, uniform errors, no existence oracle" is the amendment's explicit security contract. P1 must not ship without it.

**Independent Test**: Re-run 008's adversarial repertoire through the REST endpoints: exceed the login rate limit split across the tool and REST start (verifying one shared budget), exceed the pending caps, poll prematurely over REST and verify the raised interval is visible from both channels, probe status and claim with fabricated / consumed / expired handles and with missing or malformed Authorization headers (verifying indistinguishable uniform responses), attempt double delivery across every channel pair, and verify the inline opt-in on the REST status route matches the tool's inline contract exactly (one-time, warned, token-limit carve-out).

**Acceptance Scenarios**:

1. **Given** an IP that has spent part of its login budget through the MCP `login` tool, **When** its combined tool + REST `start` calls exceed the single per-IP login rate limit, **Then** the next start on either channel is uniformly rate-limited (HTTP 429 with Retry-After on REST) — the budget is shared, not doubled. Likewise the canonical and alias claim URLs share one claim budget.
2. **Given** any of: a fabricated handle, a consumed handle, a genuinely expired handle, a missing Authorization header, or a malformed one, **When** `GET /api/login/status` is called, **Then** the responses are indistinguishable (the uniform expired outcome) — no oracle; and the claim endpoints keep their byte-identical uniform 404 for every such cause.
3. **Given** a handle polled faster than its required interval over REST, **When** the premature poll lands, **Then** the slow-down outcome is returned, the required interval rises exactly as it does for the tool, and the one-shot approved payload is not consumed.
4. **Given** an approved pairing delivered once through any channel (tool approved payload, REST approved payload, inline on either, canonical claim, alias claim), **When** any other channel attempts a second delivery or claim, **Then** it receives the uniform expired/invalid outcome — exactly one delivery per pairing, ever.
5. **Given** a shell-less agent polling `GET /api/login/status` with the inline opt-in, **When** the pairing is approved, **Then** the credential is returned in-band exactly once, prefixed with the do-not-echo warning, with cache-suppression on the response; a token-cap collision at mint time surfaces the same actionable token-limit outcome as the tool (008 D13), and every other failure collapses to uniform expired.
6. **Given** an invalid `agentName` (empty, over-long, control characters) on `POST /api/login/start`, **When** validation fails, **Then** the response is an actionable client error (HTTP 400) and no pending authorization is created — the same validation policy as the tool (008 D9).

---

### User Story 3 - The approved payload teaches the next step (Priority: P3)

At the moment of success the agent holds a fresh credential and a decision it has historically gotten wrong (the live tests ended in bare registration and a second auth prompt). The approved/claim delivery now carries a `nextSteps` block: the credentialed registration one-liner — `claude mcp add … --header "Authorization: Bearer $(cat <file>)"` with the file path pre-filled, never the bare form — plus the top REST recipes (list docs, create from markdown, export), so the agent can act without returning to the docs.

**Why this priority**: This closes the second live-test failure (bare registration → duplicate credential store) and delivers the amendment's "an agent can act without returning to the docs" promise. It depends on P1's payloads existing but is independently verifiable.

**Independent Test**: Complete a pairing through each consumer and inspect the delivery: the tool's approved payload, the REST status approved payload, and both inline deliveries carry a `nextSteps` block whose registration one-liner is credentialed with the pre-filled file path, whose REST recipes are runnable as-is, and which never contains credential material. Verify the raw claim response body is still exactly the credential bytes.

**Acceptance Scenarios**:

1. **Given** an approved pairing, **When** the `login_status` tool delivers the one-shot approved payload, **Then** it includes a `nextSteps` block containing the credentialed `claude mcp add … --header "Authorization: Bearer $(cat <file>)"` one-liner with the claim recipe's file path pre-filled — and the bare (uncredentialed) `claude mcp add` form appears nowhere in the payload.
2. **Given** an approved pairing polled over REST, **When** `GET /api/login/status` delivers the approved payload, **Then** the same `nextSteps` block is present — both consumers of the shared service carry it.
3. **Given** the `nextSteps` block, **When** the agent inspects its REST recipes, **Then** they cover at least listing documents, creating a document from markdown, and exporting a document as markdown, each runnable as-is using the claimed credential file.
4. **Given** any `nextSteps` block, **When** it is rendered anywhere, **Then** it contains no credential material — the one-liner references the credential only via the file (`$(cat <file>)`).
5. **Given** a claim of the raw credential (`GET /api/login/claim` or its alias), **When** the response is written to disk, **Then** the body is still exactly the credential bytes (the file stays a clean, shell-friendly credential — `nextSteps` never rides the byte channel).

---

### User Story 4 - Discovery names the API (Priority: P4)

An agent that finds the MCP endpoint first — via the `GET /mcp` manifest or by connecting anonymously — learns that a plain REST path exists. The manifest gains an additive `restApi` block (the login-start URL and the agents.md anchor); the anonymous server instructions mention the REST path. The existing contract pin that asserts the discovery response is "unchanged" is amended **deliberately**: this is an intentional, additive contract change, stated here rather than discovered in a failing test.

**Why this priority**: Discoverability converts the P1 surface from "exists" to "gets found," but the flow functions without it. It is cheap and independently testable.

**Independent Test**: Fetch `GET /mcp` and verify the additive `restApi` block (login-start URL, agents.md anchor) alongside byte-identical pre-existing fields; initialize an anonymous MCP session and verify the instructions mention the REST login path while remaining under the 2 KB client truncation budget; verify the amended contract test asserts both the new block and the unchanged pre-existing fields.

**Acceptance Scenarios**:

1. **Given** the `GET /mcp` discovery manifest, **When** it is fetched after this feature, **Then** it contains an additive `restApi` block carrying the absolute login-start URL and a link to the relevant agents.md anchor, and every pre-existing field (name, version, protocol version, capabilities, authentication block) is byte-identical to before.
2. **Given** the anonymous-surface contract test that pins the discovery response as "unchanged", **When** this feature lands, **Then** that pin is amended deliberately — it must assert the new `restApi` block AND continue to pin the pre-existing fields (the pin evolves; it is not deleted), and the change is traceable to this spec.
3. **Given** an anonymous MCP session, **When** the client receives the server instructions at initialize, **Then** they mention that the login flow is also available as plain REST (naming where to start), and both the anonymous and authenticated instruction strings remain within the 2 KB budget.

---

### User Story 5 - agents.md becomes a choose-your-channel guide (Priority: P5)

An agent reading the front door is routed by what it has, in this order: (1) "have a shell? nothing to install" — the REST login quickstart, then collaborate over REST or authenticated JSON-RPC; (2) already holding a credential — credentialed MCP registration; (3) an MCP-native client with browser access — the standard OAuth discovery chain. The bare `claude mcp add` form no longer appears as a recommended step for agents that already hold a credential. The drift-guard suite is carried through the restructure: every existing claim that remains true stays pinned (pins updated where section text moves), and the new structure gains its own pins.

**Why this priority**: The front door caused the original misconception ("`claude mcp add` is a prerequisite"); restructuring it prevents recurrence. It lands last because the surfaces it documents must exist first — but documentation drift is a defect by design-doc fiat.

**Independent Test**: Fetch `/agents.md` and verify the channel ordering (shell-first REST quickstart → credentialed MCP registration → MCP-native OAuth discovery), that the REST quickstart documents the three login endpoints with runnable examples and no JSON-RPC requirement, that no credential-holding path recommends the bare registration form, and that the full drift-guard suite passes — existing pins carried or updated, new pins covering the new structure.

**Acceptance Scenarios**:

1. **Given** the restructured `agents.md`, **When** an agent reads it top to bottom, **Then** the first recommended path is the shell-first REST login quickstart ("have a shell? nothing to install"), followed by credentialed MCP registration, followed by MCP-native OAuth discovery.
2. **Given** the REST quickstart section, **When** an agent follows it, **Then** it can complete the pairing with the three `/api/login/*` endpoints using plain curl — no JSON-RPC envelope construction, no MCP client, no CLI install — and the section states explicitly that registering an MCP server is NOT a prerequisite.
3. **Given** any path in the guide addressed to an agent that already holds a credential, **When** it shows MCP registration, **Then** it shows only the credentialed form (`--header "Authorization: Bearer $(cat <file>)"`) — the bare form survives only where OAuth discovery is the intended auth path.
4. **Given** the drift-guard suite (pins (a)–(t)), **When** the restructure lands, **Then** every pinned claim that is still true still passes (pins updated where section text moved, e.g. the claim-path pin follows the canonical URL), pins invalidated by design (and only those) are amended with a traceable reason, and new pins cover the choose-your-channel structure and the REST quickstart's factual claims.

---

### Edge Cases

- A pairing started over REST and polled prematurely through the MCP tool (or vice versa): the raised poll interval is one piece of per-handle state, visible identically from both channels.
- Both claim URLs raced concurrently for the same handle: exactly one wins (the existing atomic claim), the loser gets the uniform 404 — alias and canonical are the same handler, not two handlers.
- `POST /api/login/start` with a malformed or non-JSON body: an actionable client error; no pending authorization is created; the response reveals nothing beyond the validation failure.
- Missing vs. malformed vs. wrong-scheme Authorization header on `GET /api/login/status`: all indistinguishable from an unknown handle (uniform expired) — a missing header is not a distinguishable "you forgot the header" oracle on an anonymous route.
- The inline opt-in requested on the REST status route when the pairing is not yet approved: behaves exactly like the tool (inline changes only the approved-state delivery; pending/denied/expired outcomes are unaffected).
- An agent follows a stale (pre-009) transcript or doc that names only the alias claim URL: the alias works indefinitely; nothing in the flow breaks for in-flight sessions at deploy time.
- `nextSteps` sizing: the block must not push the approved payload past what MCP clients render reliably; recipes are the top three, not a REST reference (agents.md and `get_tool_documentation` remain the reference).
- The anonymous server instructions with the REST mention added must stay under the 2 KB truncation budget with the critical details (unauthenticated state, two tools, both escape hatches, credential rule) still leading.
- Manifest consumers that validate strictly (e.g. reject unknown fields): the `restApi` block is additive JSON; the design accepts this as a deliberate, non-breaking amendment — flagged in the amended contract pin, not silently.
- The credentialed one-liner's file path when the agent chose its own claim destination: the pre-filled path is the recipe's default; the payload wording must make clear the path follows wherever the agent actually wrote the credential.

## Requirements *(mandatory)*

### Functional Requirements

**REST login endpoints (thin wrappers, one state machine)**

- **FR-001**: The system MUST expose `POST /api/login/start` accepting a JSON body `{ agentName }`, which creates a pending authorization through the same login service the MCP `login` tool uses, and returns plain JSON carrying at minimum `userCode`, `verificationUri`, `handle`, and `pollIntervalSeconds`. Additional fields mirroring the tool's payload (TTL, agent-facing instructions phrased for the REST channel) are permitted as a superset (ledger RD-1).
- **FR-002**: `POST /api/login/start` MUST apply the identical abuse gates as the `login` tool — the per-IP login rate limit, the per-IP outstanding-pending cap, and the global pending cap (008 D10) — drawn from the **same budgets** as the tool path (one flow-wide budget per gate, not per-route budgets; ledger RD-8). Cap and rate-limit breaches return the uniform rate-limited outcome as HTTP 429 with a Retry-After header where a retry time is known.
- **FR-003**: `POST /api/login/start` MUST enforce the 008 D9 `agentName` validation policy identically to the tool; validation failures return an actionable HTTP 400 and create no pending authorization.
- **FR-004**: The system MUST expose `GET /api/login/status`, authenticated solely by the handle in the `Authorization: Bearer` header, returning the same status decision table as the `login_status` tool — pending, slow-down, approved (one-shot payload), denied, uniform expired, and the token-limit carve-out — as plain JSON with no JSON-RPC envelope and no double-encoded text blocks. Every decision-table outcome is delivered with HTTP 200 (the outcome lives in the `status` field, exactly as the tool contract; ledger RD-2).
- **FR-005**: On `GET /api/login/status`, a missing, malformed, or wrong-scheme Authorization header MUST be indistinguishable from an unknown handle (the uniform expired outcome) — no oracle distinguishing "no handle" from "bad handle" (ledger RD-6). The handle MUST NOT be accepted via query string or any carrier other than the Bearer header, on this or any login route (008 review rule, preserved).
- **FR-006**: `GET /api/login/status` MUST support the inline credential delivery as an explicit opt-in mirroring the tool's `inline: true` semantics (008 D11/I2 and D13): one-time in-band delivery on approved, do-not-echo warning prefixed, forecloses and is foreclosed by every other delivery channel, token-limit carve-out surfaced actionably, all other inline failures collapsing to uniform expired. The opt-in is carried as a query parameter (ledger RD-5). Any response carrying the credential MUST be served with cache suppression (`Cache-Control: no-store`).
- **FR-007**: The system MUST expose `GET /api/login/claim` as the canonical claim path, and MUST keep `GET /api/mcp/login/claim` as an alias served by the same handler — byte-identical request handling (Bearer-header-only handle carrier) and byte-identical responses (200 credential bytes / uniform 404 / 429 / 409 token-limit / 500), with both URLs drawing from the single claim rate-limit budget (ledger RD-8).
- **FR-008**: One-shot semantics MUST hold across all channels jointly: for a given pairing there is exactly one approved-payload delivery and exactly one credential delivery (REST claim via either URL, or inline via either consumer), and any subsequent attempt on any channel receives the uniform failure. Poll-interval (slow-down) state is likewise per-handle, shared across channels.
- **FR-009**: The MCP `login` and `login_status` tools MUST remain thin clients of the same login service — no second implementation of any flow step — and existing MCP callers MUST observe no behavior change beyond the additions specified here (the `nextSteps` block, and the canonical claim path in emitted recipes per FR-012).
- **FR-010**: The login state machine, the `/activate` page and consent journey, the delegation and credential-mint machinery, and the OAuth/PKCE transport surface MUST NOT change. (The 008 anonymous-MCP-surface shape — two tools, byte-identical 401s elsewhere — is also unchanged except the instructions amendment in FR-016.)

**Next-step guidance in the approved delivery**

- **FR-011**: The approved delivery MUST include a `nextSteps` block containing (a) the credentialed MCP registration one-liner — `claude mcp add … --header "Authorization: Bearer $(cat <file>)"` with the claim recipe's credential file path pre-filled — and (b) the top REST recipes: list documents, create a document from markdown, and export a document as markdown, each runnable as-is with the claimed credential. The bare (uncredentialed) registration form MUST NOT appear anywhere in the payload.
- **FR-012**: The `nextSteps` block MUST appear in BOTH consumers of the shared service — the `login_status` tool's approved payload and the REST status approved payload — and in both inline deliveries. The raw-byte claim response (`GET /api/login/claim` and alias) MUST remain exactly the credential bytes (ledger RD-3). All claim recipes emitted by the flow (tool and REST) MUST reference the canonical `/api/login/claim` path (ledger RD-4).
- **FR-013**: `nextSteps` MUST NOT contain credential material in any form; the credential is referenced only via the file path (command substitution). The credential-handling instructions (never print/echo/paste; handle is acceptable residue) carry over unchanged from 008.

**Discovery**

- **FR-014**: The `GET /mcp` discovery manifest MUST gain an additive `restApi` block carrying the absolute `POST /api/login/start` URL and a link to the agents.md choose-your-channel anchor (field shape per ledger RD-7). All pre-existing manifest fields MUST remain byte-identical.
- **FR-015**: The existing anonymous-surface contract pin asserting the `GET /mcp` discovery response is "unchanged" MUST be amended deliberately as part of this feature: the amended pin asserts the new `restApi` block AND continues to pin every pre-existing field. This spec states the amendment as an intentional, additive contract change (design-mandated: "amended deliberately (additive field), not silently").
- **FR-016**: The anonymous MCP server instructions MUST mention that the login flow is available as plain REST (naming the start endpoint or where to find it), while preserving the existing critical content (unauthenticated state, the two tools, both escape hatches, the credential rule) and keeping the string within the 2 KB client truncation budget.

**agents.md as a choose-your-channel guide**

- **FR-017**: `agents.md` MUST be restructured as a choose-your-channel guide ordered: (1) shell-first REST login quickstart ("have a shell? nothing to install"), leading into collaborating over REST or authenticated JSON-RPC; (2) credentialed MCP registration for agents holding a credential; (3) MCP-native OAuth discovery for clients that drive browser OAuth natively.
- **FR-018**: The REST quickstart MUST document the pairing against the three `/api/login/*` endpoints with runnable shell examples requiring no JSON-RPC envelope construction, and MUST state explicitly that registering an MCP server is not a prerequisite. The documented claim path is the canonical `/api/login/claim`.
- **FR-019**: The bare `claude mcp add` form MUST NOT appear as a recommended step for any agent that already holds a credential; where MCP registration is shown to a credential-holder it is the credentialed `--header` form. The bare form may remain only where OAuth discovery is the intended authentication path (ledger RD-9).
- **FR-020**: The agents.md drift-guard suite MUST be carried through the restructure: every existing pin (a)–(t) whose claim remains true continues to pass (updated where section text moved — e.g. the claim-endpoint pin follows the canonical path); pins invalidated by this design amendment (and only those) are amended with a traceable reason; and new pins cover the new structure — at minimum the channel ordering/framing, the three REST login endpoints, the not-a-prerequisite statement, and the credentialed-only registration rule for credential-holders.
- **FR-021**: Every factual claim in the restructured agents.md MUST match the implemented surface (design-doc fiat: drift is a bug), including the `nextSteps` and discovery additions from this feature.

### Key Entities

- **Pairing (pending authorization)**: unchanged from 008 — the one state machine (pending → approved → claimed / denied / expired) now reachable through two doors. No new states, fields, or transitions.
- **Handle**: unchanged — the high-entropy, one-shot session binding; now also the Bearer credential for `GET /api/login/status`. Carrier rule (Bearer header only) uniform across all routes.
- **nextSteps block**: new payload element on the approved/inline deliveries — the credentialed registration one-liner plus the top three REST recipes; contains no secrets; identical across both consumers.
- **restApi discovery block**: new additive element of the `GET /mcp` manifest — the login-start URL and the agents.md anchor; the first place the manifest names a non-MCP surface.
- **Channel**: the door a given interaction used — MCP tool, REST endpoint (canonical or alias), inline — recorded where 008 already records it; security-relevant state (one-shot, poll interval, budgets) is per-pairing/per-IP, never per-channel.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: An agent holding only a shell (plain HTTP client), whose user has a browser somewhere, completes the full pairing — start, user approval, status, claim — using exactly three API endpoints plus polling, with no MCP client attachment, no JSON-RPC envelope construction, and no software installation, in under 2 minutes of agent-side work once the user approves.
- **SC-002**: 100% of feature 008's adversarial acceptance behaviors (rate limits, pending caps, slow-down discipline, one-shot delivery, uniform errors, no existence oracle, header-only handle carriage) hold with identical outcomes when exercised through the REST endpoints, including split across channels — and the shared-budget checks show no gate's effective budget doubled by the new door.
- **SC-003**: After approval, an agent can take its next action — credentialed MCP registration or a first document operation (list, create-from-markdown, export) — using only the contents of the approved payload, with zero returns to documentation; every `nextSteps` command is copy-paste runnable against the claimed credential file.
- **SC-004**: Existing integrations observe no breaking change: the 008 MCP tool flow, in-flight claim URLs (alias), the OAuth/PKCE surface, and consumers of the pre-existing discovery-manifest fields all behave as before; the only observable additions are the documented ones (nextSteps, restApi block, instructions mention).
- **SC-005**: The two live-test failure modes of 2026-07-15 are closed at the documentation surface: a fresh agent reading agents.md is told, before any registration instruction, that a shell alone suffices (no prerequisite misconception), and no recommended path leads a credential-holding agent to bare registration (no second auth prompt, no duplicate credential store).
- **SC-006**: The agents.md drift-guard suite passes in full after the restructure, with coverage extended to the new structure — no factual claim in the shipped file contradicts the implemented surface.

## Assumptions

- The 008 clarifications ledger (D1–D13) remains binding in full; this feature adds interpretations only where the 009 amendment is silent, recorded in this feature's `clarifications-needed.md`.
- `sk_sqd_` bearer tokens authenticate the REST `/api` routes used by the `nextSteps` recipes (verified in the current implementation: the auth middleware accepts API tokens, and a document-list REST route exists) — so "list docs / create from markdown / export" are all runnable with the claimed credential.
- The REST endpoints derive their absolute URLs (verification URI, claim command, manifest restApi block) from the same request-derived base URL the MCP tools use today.
- The default credential file path in the claim recipe (and therefore pre-filled in the `nextSteps` one-liner) remains the 008-shipped default; agents that chose a different destination adapt the pre-filled path per the payload wording.
- The `/activate` consent journey, Settings visibility/revocation, and attribution semantics are 008's, untouched.
- Operational numbers (rate limits, caps, TTLs, poll intervals) remain named operational constants — contracts-by-value, tunable without a spec edit (008 D4/D10 posture).
- Deployment is atomic enough that no compatibility window is needed beyond the permanent claim-path alias; no other URL changes shape.

## Out of Scope

- The downloadable `squire` CLI wrapper — explicitly deferred by the design to squire-sync M5; the raw curl path must be first-class on its own.
- Any change to the login state machine (states, transitions, TTLs, mint-at-delivery, auto-revoke, GC).
- Any change to the `/activate` page, consent UX, or code-entry journey.
- Any change to the delegation/mint machinery, token shape, scopes, or revocation cascade.
- Any change to the OAuth/PKCE transport surface (discovery chain, registration, consent, token, refresh) — byte-identical per 008's promise.
- Removing or deprecating the `/api/mcp/login/claim` alias.
- Mid-session toolset upgrade after credential acquisition ("persist and reconnect" remains the honest contract).
- A full REST API reference in agents.md or the approved payload (the top-recipes block and existing `rest_api` tool documentation remain the reference surfaces).

## Flagged Design Gaps

Material silences and tensions in the design amendment, per Constitution Principle VI, are recorded in this feature's `clarifications-needed.md` with best-default resolutions (RATIFIED-BY-DEFAULT, Sam pre-authorized, 2026-07-15): the "list docs" recipe target and its promotion to a documented public surface (G1), the absence of a per-IP transport limit on the status route under the "identical rate limits" reading (G2), and the interpretation that `nextSteps` rides the approved/inline payloads while the byte-channel claim response stays credential-only (G3/RD-3). Ratified defaults RD-1 through RD-9 cover response-shape supersets, HTTP status mapping, canonical-path recipes, the inline opt-in carrier, uniform auth-failure behavior on status, the restApi field shape, shared rate-limit budgets, and the residual placement of the bare registration one-liner.
