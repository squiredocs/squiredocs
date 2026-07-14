# Feature Specification: MCP-Native Onboarding — the login Tool

**Feature Branch**: `008-mcp-login-bootstrap` (feature slug; work happens on the pipeline's assigned tree — no branch created by this spec)

**Created**: 2026-07-14

**Status**: Draft

**Input**: User description: "MCP-native onboarding — the login tool (device-authorization-style bootstrap through MCP itself, with a no-inference credential claim). An agent with no credential connects anonymously, calls a login tool, relays a short user code to its user ('go to /activate, enter WDJB-MJHT'), and polls until approval yields a persistable credential — claimed over REST so the secret never transits the conversation."

**Design ground truth**: `design/agent-surface-mcp.md`, section "MCP-native onboarding: the login tool (feature 008)" (this feature's contract), with the amended "Decision — PKCE only, no device flow (superseded in part)" bullet and the "Agent onboarding and discovery" section as binding context. Per Constitution Principle VI, where this spec and that document disagree, the document wins; material gaps and tensions are ledgered in `clarifications-needed.md`, never resolved silently.

## Overview

Feature 005 made agent onboarding a one-sentence affair for MCP-native clients that drive browser OAuth. But the most common real-world agent — one already running *inside* a session, sandboxed, over SSH, or in a container — completes PKCE only via the failed-localhost-callback paste-back ritual, and the documented fallback moves a long-lived `sk_sqd_` secret through the chat transcript. Sam's 2026-07-14 amendment partially superseded the PKCE-only decision: transport-level auth stays PKCE-only (no RFC 8628 at the token endpoint), and an **app-level**, device-authorization-style onboarding path is added through MCP itself.

The shape: an agent with no credential connects to the MCP endpoint anonymously and finds exactly two tools, `login` and `login_status`. Calling `login({ agentName })` yields a high-entropy handle (the session binding, returned only in the tool result), a short one-shot user code, and a verification URL; the agent relays URL and code to its user ("go to /activate, enter WDJB-MJHT") and polls. The user activates from any browser — sign in with Google, enter the code, review a deliberately skeptical consent page — and approval creates a **standard delegation** through the existing machinery. The credential — an `sk_sqd_` token minted against that delegation — is then delivered by **the channel rule applied to secrets**: the approved `login_status` response carries not the credential but a one-shot REST claim recipe (an exact, handle-authenticated command that lands the credential bytes directly on disk) plus persist-and-reconnect instructions. The secret travels server→agent without ever transiting model context or the conversation transcript. An explicit inline opt-in exists for agents with no shell. No environment detection, no localhost callback: the flow works identically in a sandbox, over SSH, or locally — the only requirement is that the user has a browser somewhere.

Explicitly in scope: the two anonymous MCP tools, the pending-authorization lifecycle, the `/activate` browser flow and consent page, the REST claim endpoint and credential-handling contract, credential minting against the existing delegation machinery, the abuse/phishing posture of the new anonymous surface, and the `agents.md` update making this the recommended path for in-session agents. Explicitly out of scope: any change to the transport-level OAuth surface (discovery chain, PKCE, consent, token endpoints — byte-identical for clients that never call `login`), RFC 8628 at the token endpoint, mid-session toolset upgrade after approval, and any new credential semantics beyond minting through the existing provenance machinery.

**Trust boundary statement (Constitution Principle V)**: this feature opens Squire's first *anonymous* application surface — unauthenticated callers may create pending authorizations via `login`, poll via `login_status`, and claim an approved credential over REST; users submit codes at `/activate` (code entry itself is behind login; the code value is attacker-suppliable input). Everything a caller supplies (agent name, handle, user code) is untrusted: validated, length-capped, rendered only as inert escaped text, compared in constant time where secret, and rate-limited per-IP and globally. The anonymous surface touches no documents, reveals nothing about accounts, and can mint no credential without an authenticated human approving on the consent page.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Sandboxed agent bootstraps a credential through MCP itself (Priority: P1)

Sam is working with an agent running inside a live session in a container. The agent has no Squire credential. It connects to the Squire MCP endpoint anonymously and sees two tools. It calls `login` with its self-declared name, receives a verification URL and a short user code, and tells Sam: "Open https://squiredocs.com/activate and enter code WDJB-MJHT." While Sam does that, the agent polls `login_status` at the instructed interval. Sam approves in his browser; the agent's next poll returns — exactly once — `approved`, with a ready-to-run claim command and plain instructions: run this to land the credential in a file, write it into your MCP client configuration, and reconnect. The agent claims, persists, the session reconnects, and the full toolset is available. Nothing secret ever appeared in the conversation transcript, and no localhost callback was involved.

**Why this priority**: This is the feature's reason to exist — the onboarding path that works identically in a sandbox, over SSH, or locally, requiring only that the user has a browser somewhere. Every other story channels the secret (P2), gives the human half (P3), hardens the surface (P4), or documents it (P5).

**Independent Test**: With no credential configured, point an MCP client at the endpoint; verify the anonymous session exposes exactly `login` and `login_status`; call `login`, complete activation in a separate browser, poll to `approved`, execute the claim, and verify the claimed credential — presented as a bearer credential on a fresh connection — grants the standard delegated toolset with standard attribution. Verify the credential string never travels through any user-visible chat channel.

**Acceptance Scenarios**:

1. **Given** an MCP client with no credential, **When** it connects and completes the protocol handshake anonymously, **Then** the session lists exactly two tools — `login` and `login_status` — and any attempt to invoke any other tool fails with the standard authentication challenge (the untouched 401 + discovery-chain pointer).
2. **Given** an anonymous session, **When** the agent calls `login({ agentName })`, **Then** the result contains: a high-entropy handle (returned only in this tool result — it is the session binding), a one-shot 8-character user code drawn from an unambiguous alphabet, the verification URI, the authorization's remaining lifetime (~10 minutes), and the minimum polling interval — plus instructions to relay the URI and code to the user and poll `login_status`.
3. **Given** a pending authorization, **When** the agent polls `login_status({ handle })` before the user acts, **Then** the result is `pending` and the handle remains valid.
4. **Given** the user approved on the consent page, **When** the agent next polls with the handle, **Then** the result is `approved` and carries — this one time only — the one-shot claim recipe, persist-and-reconnect instructions, and credential-handling rules, and NOT the credential itself; **and When** the agent polls the same handle again, **Then** the response is indistinguishable from `expired` (the one approved response was consumed), while the handle remains valid solely for the claim.
5. **Given** the claim recipe, **When** the agent executes it within the claim window, **Then** the credential bytes (an `sk_sqd_` token, 30-day expiry) land directly in a file and the handle is consumed.
6. **Given** the freshly claimed credential, **When** the client reconnects presenting it as a bearer credential, **Then** the session authenticates as the delegated agent with the standard scopes (`documents:read`, `documents:write`) and its tool calls are attributed agent-on-behalf-of-user exactly like any other delegation — nothing downstream distinguishes how the credential was born.
7. **Given** an approved authorization, **When** the original (still-anonymous) session continues, **Then** no mid-session toolset upgrade is attempted — the honest contract is "persist the credential and reconnect."
8. **Given** the user denies, or the authorization's lifetime elapses with no action, **When** the agent polls, **Then** the result is `denied` or `expired` respectively, both terminal — the agent must start over with a fresh `login` call to retry.

---

### User Story 2 - The credential never transits the conversation (Priority: P2)

Riley's agent completes the approval dance. The `login_status` approved response hands it a pre-filled, one-shot claim command — `GET /api/mcp/login/claim`, authenticated by the handle — that writes the credential straight to disk with owner-only (0600) permissions. The secret is never generated into, echoed through, or pasted into model context: it moves over the byte channel, exactly like the REST export/import rule for document content, because the channel rule applies to secrets. The response also carries handling instructions the agent must follow: never print, echo, or paste the credential; write it into the MCP client config or an env file directly; the handle left in the transcript is acceptable residue because it is short-lived, one-shot, and dead after the claim. Riley's other agent runs in an environment with no shell at all — it opts in explicitly with `login_status({ handle, inline: true })` and receives the credential inline, prefixed with a do-not-echo warning.

**Why this priority**: the no-inference claim is the design's core security posture for this feature and the specific improvement over the API-token fallback (which moves a long-lived secret through chat). P1 is demonstrable without it only in a degraded form that recreates the problem the feature exists to fix.

**Independent Test**: Complete an approval; verify the approved response contains a runnable claim command and handling instructions but no credential; execute the claim and verify one-shot atomic semantics (a second or concurrent attempt fails), the ~5-minute approved-to-claim window, and rate limiting; separately verify the `inline: true` opt-in returns the credential exactly once with the warning prefix and forecloses the REST claim.

**Acceptance Scenarios**:

1. **Given** an approved authorization polled without `inline`, **When** the approved response is returned, **Then** it contains the exact claim command with the handle pre-filled, guidance that the credential file be owner-only (0600), persist-and-reconnect instructions, and the never-print/never-echo/never-paste handling instructions — and does not contain the credential.
2. **Given** the claim endpoint, **When** the first claim with a valid handle arrives within the approved-to-claim window (~5 minutes), **Then** the credential bytes are returned in a form suitable for writing directly to a file, and the handle is atomically consumed.
3. **Given** a consumed handle, **When** any subsequent claim (or a concurrent duplicate) arrives, **Then** exactly one claim ever succeeds and the rest fail without revealing whether the handle ever existed.
4. **Given** an approval that is never claimed, **When** the claim window lapses, **Then** the claim fails identically, the handle is permanently dead, and no live pairing remains (see US3 scenario 8).
5. **Given** an agent with no shell, **When** it calls `login_status({ handle, inline: true })` on an approved authorization, **Then** the credential is returned inline exactly once, prefixed with a do-not-echo warning, and the REST claim for that handle is thereafter unusable — one delivery, one channel, either way.
6. **Given** either delivery channel, **When** delivery has happened once, **Then** no path exists to obtain the credential bytes again with that handle — recovery is a fresh `login`.

---

### User Story 3 - The user activates with skeptical consent, and stays in control afterward (Priority: P3)

Riley's agent gives her a URL and a code. She opens `/activate` on her phone. She isn't signed in, so she signs in with Google first and lands back on the activation page. She types the code (lowercase, with the hyphen — it's accepted anyway). The page shows her a deliberately skeptical consent prompt: "An agent calling itself **Riley's research assistant** requests access to your documents" — making clear the name is self-declared and unverified — with the exact scopes it will receive (read and write documents) and two buttons: Approve and Deny. She approves; the page confirms the agent can now connect, and tells her the pairing appears in Settings. A week later she revokes it from Settings → AI Agent Access, and the agent's credential stops working immediately.

**Why this priority**: The human half of the P1 journey — without a working, honest consent surface there is no approval to poll for. Separated from P1 because it is independently testable (drive the page directly against a pending authorization) and carries the feature's phishing posture.

**Independent Test**: Create a pending authorization (by calling `login`), then drive `/activate` in a browser: verify the login round-trip preserves the destination, code entry normalizes case/hyphens, the consent page names the agent skeptically and shows exact scopes, Approve creates a revocable delegation visible in Settings, and Deny creates nothing.

**Acceptance Scenarios**:

1. **Given** a signed-out browser, **When** the user opens the verification URI, **Then** they are taken through Google sign-in (including first-time account creation) and return to the activation flow with nothing lost — the consent login round-trip guarantee applies to this page.
2. **Given** a signed-in user on `/activate`, **When** they enter a valid outstanding code — in any letter case, with or without the grouping hyphen — **Then** the code is accepted and the consent page for that pending authorization is shown.
3. **Given** the consent page, **When** it renders, **Then** it names the agent with explicit skepticism ("An agent calling itself <name>…" — self-declared, unverified), displays the exact scopes to be granted (`documents:read`, `documents:write` — never any admin capability), and offers Approve and Deny; the agent-declared name renders as inert text (hostile names cannot execute or mislead via markup).
4. **Given** the consent page, **When** the user clicks Approve, **Then** a standard delegation is created (same store, same revocation cascade, same attribution as OAuth-born delegations), the authorization becomes claimable by the agent, and the page confirms activation and points at Settings for later management.
5. **Given** the consent page, **When** the user clicks Deny, **Then** no delegation and no credential are created, the authorization becomes terminally `denied`, and the page confirms nothing was granted.
6. **Given** an approved and claimed pairing, **When** the user revokes the delegation (or the token) from Settings, **Then** the credential stops authenticating — the existing revocation cascade applies because this is an ordinary delegation-minted token.
7. **Given** a code whose authorization expired (or was already used), **When** the user submits it, **Then** entry fails with a generic invalid-or-expired message that does not reveal which, and nothing is granted; **and Given** a user who entered a valid code but waited past the authorization's lifetime before clicking Approve, **When** they click Approve, **Then** approval fails with an actionable "expired — ask your agent to log in again" message and nothing is created.
8. **Given** an approval whose claim window lapses with the credential never delivered, **When** the lapse occurs, **Then** the delegation created at approval is automatically revoked, so Settings never shows a live pairing that no credential can use.

---

### User Story 4 - The anonymous surface resists abuse and phishing; the spec path is untouched (Priority: P4)

An attacker scripts anonymous connections to mass-create pending authorizations, brute-force user codes, hammer the claim endpoint with guessed handles, probe for account existence, or relay a code to a victim hoping they'll approve blind. Each attempt hits a wall: pending authorizations are capped per-IP and globally; `login` calls, `/activate` code submissions, and claim attempts are rate-limited; codes and handles are unguessable, one-shot, short-lived, and compared in constant time; the anonymous surface answers nothing about whether any account, user, or agent exists; polling faster than allowed earns a slow-down; and the consent page requires a signed-in human who is shown a skeptical, named, scoped prompt before anything is granted. Meanwhile a standards-compliant MCP client that never calls `login` — Claude Code driving browser OAuth, or any PKCE-native tool — onboards exactly as it did after feature 005: the 401 challenge, discovery chain, dynamic registration, PKCE, consent, and token endpoints are byte-identical.

**Why this priority**: Constitution Principle V makes the trust boundary of a new ingestion surface a spec-level obligation, and this is Squire's first anonymous application surface; the byte-identical spec path is the design's compatibility promise. Both ship with P1 — but they are separately testable and reviewable as the feature's security and regression posture.

**Independent Test**: Exercise the anonymous surface adversarially: exceed the per-IP pending cap, hammer `login`, code entry, and the claim endpoint past the rate limits, submit garbage and near-miss codes, poll faster than the minimum interval, replay consumed handles, and probe with crafted agent names — verifying caps, limits, slow-down, one-shot semantics, uniform errors, and inert rendering throughout. Run the existing OAuth/discovery conformance tests unchanged and verify byte-identical behavior for non-login clients.

**Acceptance Scenarios**:

1. **Given** an IP at its cap of outstanding pending authorizations, **When** it calls `login` again, **Then** the call fails with a retriable rate-limit result and no authorization is created; **and Given** the global outstanding cap is reached, **Then** `login` fails the same way for any caller.
2. **Given** an agent polling `login_status` faster than the minimum interval (5 s), **When** the violation occurs, **Then** the result is a `slow_down` (RFC 8628-style: the required interval increases), and the handle itself remains valid — impatience is throttled, not punished with loss of the pairing.
3. **Given** repeated wrong-code submissions at `/activate`, **When** the rate limit is hit, **Then** further attempts are rejected for a cooldown period, and every failure — wrong code, expired code, used code — returns the same generic message.
4. **Given** any input to the anonymous surface (tool calls, code entry, claims), **When** responses are compared across "account exists" and "account does not exist" conditions, **Then** they are indistinguishable — no account-existence oracle; the anonymous surface touches no documents and no user data.
5. **Given** a stolen or guessed handle for an authorization already consumed, denied, or expired, **When** it is polled or claimed, **Then** the response is terminal and credential-free; **and Given** a fabricated handle that never existed, **Then** the response is indistinguishable from an expired one.
6. **Given** a hostile agent name (markup, control characters, absurd length), **When** `login` is called, **Then** the name is rejected per the validation policy or accepted and rendered as inert text on the consent page — never interpreted.
7. **Given** an attacker relays a valid code to a victim (the classic device-flow phishing shape), **When** the victim opens `/activate`, **Then** every mitigation is in their path: they must sign in, the page names the agent identity with explicit skepticism, the exact scopes are shown, approval can grant only the standard document scopes (never admin), and the code is short-lived and rate-limited — approval remains an informed human decision.
8. **Given** a client that never calls `login`, **When** it exercises the authentication surface — unauthenticated non-login tool access, discovery metadata, registration, authorize, consent, token, refresh — **Then** every response is byte-identical to pre-feature behavior (the login tools are purely additive).

---

### User Story 5 - agents.md steers each client to its right path (Priority: P5)

An agent already inside a live session fetches `agents.md` and finds the login-tool bootstrap documented as **the recommended path for its situation** — connect anonymously, call `login`, relay the URL and code clearly, poll politely, claim over REST, persist, reconnect — superseding most of the failed-localhost-callback coaching choreography for that case. The PKCE walkthrough guidance remains for MCP-native client onboarding (fresh `claude mcp add`). The tool count reads eighteen. Every claim matches the live surface, and the drift-guard test suite grows to pin the new claims.

**Why this priority**: The front door is how the flow gets discovered, but the flow functions without the doc; it lands last and is cheap. Documentation drift is nonetheless a defect by design-doc fiat.

**Independent Test**: Fetch `/agents.md` and verify it recommends the login bootstrap for in-session agents with accurate mechanics (tool names, `/activate`, polling discipline, claim command shape, credential-handling rule), retains the PKCE walkthrough for MCP-native clients, and states eighteen tools; run the extended drift-guard suite.

**Acceptance Scenarios**:

1. **Given** `agents.md`, **When** an in-session agent reads it, **Then** the recommended path for its situation is the login-tool bootstrap (connect anonymously → `login` → relay code → poll → claim over REST → persist credential → reconnect), stated with the same care the OAuth walkthrough got — including the credential-handling rule (never print, echo, or paste the credential).
2. **Given** `agents.md`, **When** an MCP-native client's user reads it, **Then** the PKCE onboarding path and its walkthrough guidance remain present and unchanged in substance.
3. **Given** the served `agents.md`, **When** its factual claims are checked, **Then** the tool count reads eighteen and the drift-guard test suite pins the new claims (login bootstrap present, recommended-path framing, claim mechanics, tool count).

---

### Edge Cases

- Agent calls `login` while already authenticated: permitted and behaves identically (creates a fresh pending authorization) — useful for re-pairing or credential rotation; the two login tools are part of the standard toolset (ledger D2).
- The one-time `approved` response is lost in transit (network failure between server and agent): subsequent polls are indistinguishable from `expired`, but the claim remains possible if the agent retained the handle and the window is open; otherwise recovery is a fresh `login` (ledger D12).
- Concurrent claims race: two claims with the same handle arrive simultaneously — exactly one receives the credential; atomic consumption is required, not best-effort.
- Approved but never claimed within the window: the handle dies, the auto-revoke of the approval's delegation fires (ledger D6), and Settings shows no zombie pairing.
- User enters the code correctly but approves after TTL expiry: approval fails actionably; nothing is created (US3 scenario 7).
- User already has the maximum number of active API tokens: approval fails with an actionable message telling them to revoke a token in Settings; the authorization stays pending (retriable until TTL) — ledger D7.
- Two pending authorizations from different agents at once: codes are unique among outstanding authorizations; each code resolves to exactly one consent page.
- Agent polls a handle it mangled or invented: indistinguishable from expired (ledger D5).
- User with no Squire account opens `/activate`: Google sign-in creates the account and returns them to activation — same round-trip guarantee as the OAuth consent page.
- The same code submitted twice (double-click, two tabs): one-shot semantics — the second submission fails with the generic invalid-or-expired message.
- `login` called with no `agentName`, an empty name, or a whitespace-only name: rejected with a validation error; a pending authorization is never created with an unusable display name.
- `inline: true` passed while the authorization is still `pending`: the result is simply `pending`; the flag matters only at approved-delivery time.
- Hostile `agentName` like "Squire Support ✅ (verified)": accepted if it passes validation, but the consent page's skeptical framing ("calling itself… not verified") is the mitigation — names are never endorsed, only quoted.

## Requirements *(mandatory)*

### Functional Requirements

**Anonymous MCP surface**

- **FR-001**: An MCP client with no credential MUST be able to complete the MCP protocol handshake and receive a functioning anonymous session whose toolset is exactly two tools: `login` and `login_status`. (Scope of the "byte-identical" guarantee versus this anonymous handshake: ledger D1 / Flagged Design Gaps G1.)
- **FR-002**: In an anonymous session, invoking any tool other than `login`/`login_status` — and accessing any other authenticated surface — MUST fail with the untouched standard authentication challenge (401 + `WWW-Authenticate` with the discovery-chain pointer, existing branch semantics preserved).
- **FR-003**: The transport-level OAuth surface — the 401 challenge contents, protected-resource and authorization-server metadata, dynamic client registration, authorization-code + PKCE, consent, token, and refresh endpoints — MUST be byte-identical to pre-feature behavior for clients that never call `login`. The login tools are additive; no RFC 8628 grant is added to the token endpoint.
- **FR-004**: The two login tools MUST require no scopes and MUST also be present and callable in authenticated sessions with identical behavior, bringing the standard toolset to eighteen; anonymous sessions list only the two. (Ledger D2.)
- **FR-005**: The instructions served to an anonymous session at handshake MUST direct the agent to the login flow (call `login`, relay code and URL, poll `login_status`, never move the credential through the conversation), within the same size discipline as the existing server instructions.

**The login tool**

- **FR-006**: `login({ agentName })` MUST create a pending authorization comprising: a server-generated high-entropy handle (at least 128 bits from a cryptographically secure source, returned only in the tool result — it is the sole session binding; no cookies, no IP binding); a one-shot 8-character user code drawn from an unambiguous alphabet (ledger D3); the verification URI (the `/activate` page's absolute URL); a 10-minute lifetime (ledger D4); and the agent-declared name.
- **FR-007**: The `login` result MUST instruct the agent to relay the verification URI and user code to its user (code displayed grouped for human transcription, `XXXX-XXXX`) and to poll `login_status` with the handle, and MUST state the minimum polling interval (5 seconds) and the authorization lifetime.
- **FR-008**: `agentName` MUST be validated: required, non-empty after trimming, at most 100 characters, control characters rejected; the accepted value is stored for display and MUST render as inert escaped text wherever shown. (Ledger D9.)
- **FR-009**: User codes MUST be unpredictable, unique among outstanding pending authorizations, one-shot (consumed by first successful entry), and dead after the authorization leaves the pending state or expires; the verification URI MUST NOT carry a pre-filled code (no code in URL path or query — the user types it deliberately; ledger D3).

**The login_status tool and polling discipline**

- **FR-010**: `login_status({ handle })` MUST return exactly one of `pending`, `approved`, `denied`, or `expired`. `denied` and `expired` are terminal; a handle that never existed, or whose approved payload was already delivered, MUST be indistinguishable from an expired one (ledger D5, D12).
- **FR-011**: The `approved` payload MUST be delivered at most once. By default it MUST NOT contain the credential; it MUST contain: (a) the one-shot REST claim recipe — the exact, ready-to-run command for `GET /api/mcp/login/claim`, handle pre-filled, writing the response directly to a file with owner-only (0600) permission guidance; (b) persist-and-reconnect instructions (write the credential into the MCP client config or an env file, then reconnect — no mid-session toolset upgrade is attempted or promised); and (c) handling instructions: never print, echo, or paste the credential; the handle in the transcript is acceptable residue (short-lived, one-shot, dead after claim). After this response, the handle remains valid solely for the claim (ledger D12 / Flagged Design Gaps G2).
- **FR-012**: `login_status({ handle, inline: true })` MUST return the credential inline on approval as an explicit opt-in for agents with no shell, prefixed with a do-not-echo warning. Inline delivery counts as the one-time delivery: it consumes the credential path entirely (the REST claim for that handle becomes unusable, and vice versa). This fallback ships by default (ledger D11 — the design's named RATIFIED-BY-DEFAULT candidate; ships unless Sam strikes it).
- **FR-013**: Polls arriving faster than the minimum interval MUST receive an RFC 8628-style `slow_down` result that increases the required interval (by 5 seconds per violation), without invalidating the handle or advancing the state machine. (Ledger D8.)

**Activation and consent (/activate)**

- **FR-014**: The verification URI MUST be a browser page at `/activate` requiring an authenticated user; unauthenticated visitors MUST complete Google sign-in (including first-time account creation) and return to the activation flow with nothing lost — the existing consent login round-trip guarantee (same-origin relative `returnTo` only, open-redirect defenses included) extends to this page.
- **FR-015**: Code entry MUST normalize user input (case-insensitive, grouping hyphens/whitespace ignored), compare codes in constant time, be rate-limited, and answer every failure — wrong, expired, or already used — with the same generic invalid-or-expired message.
- **FR-016**: The consent page MUST name the agent with explicit skepticism as a self-declared, unverified identity ("An agent calling itself <name> requests access to your documents"), display the exact scopes to be granted — `documents:read` and `documents:write`, never any admin capability — and offer Approve and Deny actions; the agent-declared name MUST render as inert text.
- **FR-017**: Approval MUST create a standard delegation through the existing delegation machinery — same store, same revocation cascade, same attribution semantics, same Settings visibility — scoped to exactly `documents:read` and `documents:write`, such that nothing downstream can distinguish this delegation from an OAuth-born one.
- **FR-018**: Denial MUST create nothing, move the authorization to terminal `denied`, and confirm to the user that nothing was granted. Approval attempted after the authorization's lifetime MUST fail actionably and create nothing.

**Credential minting and claim (the channel rule for secrets)**

- **FR-019**: The credential MUST be an `sk_sqd_` API token minted against the new delegation with the existing minting provenance (`minted_by_delegation_id` — the existing cascade machinery), a 30-day expiry matching the OAuth refresh-token lifetime, scopes equal to the delegation's, and a name recognizably derived from the agent-declared name so the user can identify it in Settings. The token MUST be minted at delivery time — first claim, or inline return — never stored in plaintext awaiting pickup (ledger D6; preserves hashed-at-rest).
- **FR-020**: The claim endpoint (`GET /api/mcp/login/claim`) MUST be authenticated solely by the handle, MUST be one-shot with atomic consumption (under concurrent claims exactly one succeeds), MUST be available only within a 5-minute approved-to-claim window (ledger D4), MUST be rate-limited, and MUST return the credential bytes in a form suitable for writing directly to disk. Failures MUST NOT reveal whether the handle ever existed.
- **FR-021**: If the claim window lapses with the credential undelivered, the handle MUST become permanently unusable and the approval's delegation MUST be automatically revoked, so no live-looking pairing without a credential lingers in Settings. (Ledger D6.)
- **FR-022**: If minting would exceed the user's active-token cap, approval MUST fail with an actionable message (revoke a token in Settings, then retry) and the authorization MUST remain pending until its TTL; the cap MUST be re-checked at mint time, and a mint-time failure fails the claim with an actionable error. (Ledger D7.)
- **FR-023**: Revoking the delegation or the token from Settings MUST kill the pairing — the credential stops authenticating via the existing revocation cascade; the delegation and token MUST be visible in Settings exactly like their OAuth-born counterparts. The agent JWT path is unchanged by this feature.

**Abuse posture**

- **FR-024**: Outstanding pending authorizations MUST be capped per-IP (default 5) and globally (default 500); `login` beyond a cap MUST fail with a retriable rate-limit result and create nothing. (Ledger D10 for the concrete numbers.)
- **FR-025**: `login` calls MUST be rate-limited per IP (default 10/minute); `/activate` code submissions MUST be rate-limited per user and per IP (default 5/minute per user, 20/hour per IP); claim attempts MUST be rate-limited per IP (default 10/minute). (Ledger D10.)
- **FR-026**: The anonymous surface MUST reveal nothing about accounts, users, or agents (no existence oracle in any response, timing included for code and handle comparison), and MUST touch no documents or user data.

**Attribution and downstream invariance**

- **FR-027**: Tool calls made with a login-born credential MUST be attributed agent-on-behalf-of-user with the same presence sessions, provenance, activity logging, and version-history attribution as any delegated agent — the credential's origin creates no downstream behavioral difference.

**Documentation and drift guards**

- **FR-028**: `agents.md` MUST present the login-tool bootstrap as the recommended path for agents already inside a session — connect anonymously, call `login`, relay the URL and code clearly to the user, poll politely, claim over REST, persist the credential, reconnect — superseding most of the localhost-callback coaching choreography for that case, while the PKCE walkthrough guidance remains for MCP-native client onboarding; its stated tool count MUST become eighteen; and it MUST carry the credential-handling rule (never print, echo, or paste the credential).
- **FR-029**: The `agents.md` drift-guard test suite MUST be extended to pin the new claims (login bootstrap presence and recommended-path framing, claim mechanics, tool count, unchanged PKCE walkthrough anchors), so drift between `agents.md` and the implemented surface stays a test failure.

### Key Entities

- **Pending Authorization**: the short-lived record binding one `login` call to one eventual human decision. Attributes: high-entropy handle (secret, agent-held), one-shot user code (human-relayed), agent-declared name, state (`pending` → `approved` | `denied` | `expired`; `approved` further progresses through payload-delivered and claimed/lapsed), creation/expiry times, originating-IP accounting for caps, and — once approved — the identity of the approving user. Never touches documents; bound to a user only at approval.
- **User Code**: 8 characters from an unambiguous alphabet, displayed grouped (`XXXX-XXXX`), entered case-insensitively with separators ignored; unique among outstanding authorizations; one-shot; compared in constant time.
- **Handle**: the agent-side secret naming a pending authorization; high-entropy; returned only in the `login` tool result; the sole session binding; after the one-time approved payload it survives solely to authenticate the one-shot claim; acceptable transcript residue by design.
- **Claim Recipe**: the agent-facing payload of the approved response — exact claim command with handle pre-filled, file-permission guidance, persist-and-reconnect instructions, and the credential-handling rules; contains no secret beyond the already-known handle.
- **Delegation** *(existing)*: the standard agent-on-behalf-of-user grant; approval creates one through the existing machinery with scopes `documents:read`, `documents:write`; revocation cascades to minted tokens; auto-revoked if the claim window lapses unclaimed.
- **API Token (`sk_sqd_`)** *(existing)*: the credential shape delivered at claim; minted with delegation provenance at delivery time; 30-day expiry; hashed at rest; revocable and listed in Settings.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: An agent inside a sandboxed session with no credential reaches working, authenticated document access with exactly four user actions — open the URL, sign in, enter the 8-character code, click Approve — in under 2 minutes of user effort, with zero environment detection and zero localhost callbacks.
- **SC-002**: In the default flow, 100% of onboardings leave zero credential bytes in the conversation transcript or model context: the transcript contains at most the verification URL, the user code, and the handle (all worthless after expiry or one use), and the credential travels only server→agent over the byte channel.
- **SC-003**: The pre-existing OAuth conformance and onboarding test suites pass unchanged: for clients that never call `login`, the authentication surface is byte-identical.
- **SC-004**: With the caps and rate limits in force, an attacker's probability of hitting any valid outstanding code within its lifetime is below 1 in 10,000 (comfortably exceeding RFC 8628 §5.1's minimum posture), and no anonymous request pattern distinguishes existing from non-existing accounts.
- **SC-005**: 100% of terminal states hold: denied and expired authorizations can never be approved or claimed; consumed handles and codes can never be reused; a second or concurrent claim never returns a credential.
- **SC-006**: A user can find and revoke a login-born pairing in Settings as easily as any other agent grant, and revocation cuts the credential off on its next use; an unclaimed approval leaves no live-looking pairing behind.
- **SC-007**: A poll-until-approved loop at the instructed interval imposes no more than 12 requests per minute per pending authorization on the service, and misbehaving pollers converge to compliance via slow-down rather than losing their pairing.

## Assumptions

- The consent login round-trip machinery from feature 005 (same-origin relative `returnTo`, short-lived cookie through the Google redirect, precedence over signup/onboarding redirects, open-redirect defenses) is reusable for `/activate` and behaves as specified there.
- The existing delegation and API-token machinery (delegation store, revocation cascade, `minted_by_delegation_id` provenance, token hashing, per-user active-token cap, Settings listing and revocation UI) is reused as-is; this feature adds no new credential semantics — a new way to *reach* consent and a new way to *deliver* a credential.
- Google is the only interactive login method; "the user logs in" on `/activate` means the Google flow, including first-time sign-up.
- Whichever authenticated user enters the code and approves becomes the delegating user — the design's phishing mitigations (login required, skeptical naming, shown scopes, short TTL, rate limits, standard scopes only) are the accepted defense for the relayed-code risk; no additional binding between the agent's network identity and the approving user is required.
- The user has a browser *somewhere* — that is the flow's only environmental requirement.
- The flow is specified for the streamable-HTTP MCP endpoint; the stdio bridge simply proxies it. Anonymous and authenticated sessions are distinguished solely by the presence/validity of credentials on the request.
- File permissions (0600) on the claimed credential are agent-side guidance carried in the recipe — the server cannot enforce a remote filesystem's permissions; the requirement is that the instructions mandate it and the recipe's default command implements it.
- Storage/GC of pending authorizations (database vs. cache, cleanup cadence) is an implementation choice for the plan phase, provided one-shot, TTL, atomic-claim, and cap semantics hold.
- Concrete cap/rate-limit numbers are tunable operational constants; the defaults in FR-024/FR-025 are ratified starting values (ledger D10), not contractual ceilings.
- The design doc's "tool count becomes eighteen at convergence" is bookkeeping for `agents.md` and the design doc itself; the code-facing consequence is only that two new tools exist and the documented count stays accurate.
- All RATIFIED-BY-DEFAULT decisions and flagged design gaps for this feature are recorded in `specs/008-mcp-login-bootstrap/clarifications-needed.md` (D1–D12, G1–G3).

## Out of Scope

- RFC 8628 at the transport level: no device-authorization grant at the token endpoint; transport auth stays PKCE-only (design decision, reaffirmed 2026-07-14). This feature is an *app-level* path through MCP tools.
- Mid-session toolset upgrade after approval (listChanged support varies by client); "persist the credential and reconnect" is the honest contract.
- Any change to the PKCE flow, OAuth consent semantics, agent JWT path, delegation semantics, token formats, scopes model, or the modify pipeline.
- Environment detection of any kind (the flow's value is that it needs none).
- Agent identity verification (the consent page's skepticism is the mitigation; verified agent identity is a different feature).
- Reviving the authorize-link shortener (rolled back 2026-07-14; this feature is the designated successor for remote-terminal onboarding friction).
- Administrative or elevated scopes via this path (standard delegation scopes only, by design).

## Flagged Design Gaps

Per Constitution Principle VI, material design silences and tensions are ledgered, never resolved silently. Full entries with chosen defaults live in `clarifications-needed.md`; the three that materially shape this spec:

- **G1 — Anonymous reachability vs. "spec-capable clients never see a difference"**: the design requires an unauthenticated session that can call two tools *and* asserts spec-capable clients never see a difference — but for the login tool to be reachable at all, an unauthenticated protocol handshake must succeed, which is observable by any client that triggers OAuth off an initial 401. Resolved by ledger D1: "byte-identical" is scoped to the transport-level OAuth surface and all non-login requests (FR-001–FR-003), with the consequence explicitly flagged for Sam: clients that auto-start OAuth only on a handshake 401 may now connect anonymously first and need their user to authenticate via the login tool or the client's explicit authenticate action.
- **G2 — Handle lifetime tension**: the design says the handle is "invalidated after the one-time approved response" *and* that the REST claim is "authenticated by the handle" after that response. Resolved by ledger D12: invalidated for polling, valid solely for the one-shot claim until claimed or the window lapses (FR-010, FR-011).
- **G3 — Credential mint timing is silent**: the design specifies the credential's shape and delivery but not when it is minted. Resolved by ledger D6: minted at delivery time (claim or inline return), never stored in plaintext awaiting pickup — approval creates the delegation only; an unclaimed approval auto-revokes its delegation at window lapse (FR-019, FR-021).
