# Clarifications Ledger — 008-mcp-login-bootstrap

Per Constitution Principle VI: unanswered product decisions get the best default,
recorded here as RATIFIED-BY-DEFAULT; material design gaps or tensions are flagged,
never resolved silently. Design ground truth: `design/agent-surface-mcp.md`,
section "MCP-native onboarding: the login tool (feature 008)".

All entries below: **RATIFIED-BY-DEFAULT (Sam pre-authorized, 2026-07-14)** unless
amended in the design doc.

---

## Flagged design gaps (tensions/silences in the design doc)

### G1 — Anonymous handshake reachability vs. "spec-capable clients never see a difference" *(resolved by D1 — needs Sam's eyes)*

- **Question**: The design requires an unauthenticated MCP session that can call `login`/`login_status`, and simultaneously asserts "spec-capable clients never see a difference" / "spec path byte-identical for clients that never call login." For the login tool to be reachable, the unauthenticated protocol handshake must succeed — but today an unauthenticated `POST /mcp` (including `initialize`) returns the 401 challenge that triggers client-native OAuth. Which requests may now succeed anonymously, and what does "byte-identical" mean exactly?
- **Why it matters**: MCP clients typically start OAuth only when the handshake 401s. If the handshake succeeds anonymously, a fresh `claude mcp add` may connect anonymously (two tools) instead of auto-launching browser OAuth — a visible change to the feature-005 P1 journey. If the handshake still 401s, the login tool is unreachable and the feature cannot exist.
- **Chosen default (D1)**: The unauthenticated handshake (initialize/tools listing/ping) succeeds and exposes exactly the two login tools, with anonymous server instructions stating the session is unauthenticated and describing both auth paths. Every other anonymous request — any other tool call, any data-touching surface — keeps the existing 401 challenge, and the entire transport-level OAuth surface (challenge contents, discovery metadata, registration, PKCE, consent, token, refresh) stays byte-identical. "Byte-identical for clients that never call login" is read as scoping to that surface.
- **Rationale**: This is the only reading under which the design's flagship scenario (an in-session agent calling `login`) is possible at all; the alternative (handshake 401s) contradicts the design's first sentence. The consequence — clients that auto-OAuth off a handshake 401 may now connect anonymously first — is real and is flagged here explicitly rather than hidden. Mitigation shipped with the default: anonymous instructions and tool descriptions make the unauthenticated state and both escape hatches unmissable.

### G2 — Handle lifetime tension *(resolved by D12)*

- **Question**: The design's polling bullet says the handle is "invalidated after the one-time approved response," while the credential-handling bullet says the REST claim is "authenticated by the handle" *after* that response. Both cannot be literally true.
- **Why it matters**: The claim endpoint's entire auth model is the handle; if the approved response killed the handle, the claim could never authenticate.
- **Chosen default (D12)**: The one-time approved response invalidates the handle **for polling** (subsequent `login_status` calls are indistinguishable from `expired`), while the handle remains valid **solely for the one-shot claim** until first claim or the 5-minute window lapse, whichever comes first. Inline delivery consumes everything at once.
- **Rationale**: The only consistent reading that preserves both design statements' intent: the polling channel goes dark once it has done its job, and the byte channel stays open exactly long enough to move the secret once.

### G3 — Credential mint timing is silent *(resolved by D6)*

- **Question**: The design specifies the credential's shape (sk_sqd_, delegation provenance, 30-day expiry) and its delivery (one-shot claim), but not whether the token is minted at approval or at claim.
- **Why it matters**: `sk_sqd_` tokens are hashed at rest. Minting at approval would require storing retrievable plaintext for up to 5 minutes awaiting the claim — a new secret-at-rest class the codebase deliberately avoids.
- **Chosen default (D6)**: Mint at delivery time (first claim, or inline return). Approval creates only the delegation. If the claim window lapses undelivered, the handle dies and the approval's delegation is automatically revoked, so Settings never shows a live-looking pairing that no credential can use.
- **Rationale**: Preserves hashed-at-rest with zero plaintext persistence; auto-revoke keeps the user-visible model truthful ("an active delegation is a live pairing") at the cost of one extra state transition.

---

## Ratified defaults (design silences with reasonable defaults)

### D1 — Anonymous surface shape

See G1 above. Spec: FR-001, FR-002, FR-003, FR-005.

### D2 — Login tools in authenticated sessions; toolset count

- **Question**: Are `login`/`login_status` visible/callable in authenticated sessions, and how does the design's "tool count becomes eighteen" square with anonymous sessions seeing only two tools?
- **Why it matters**: Tool registry mechanics, agents.md's stated count, and re-pairing/rotation UX.
- **Chosen default**: The two tools require no scopes and are present and callable in authenticated sessions with identical behavior (an authenticated `login` just creates a fresh pending authorization — usable for re-pairing before expiry). Standard toolset count: eighteen. Anonymous sessions list only the two.
- **Rationale**: Matches the design's "eighteen at convergence" bookkeeping, avoids special-casing, and gives credential rotation for free. Spec: FR-004.

### D3 — User-code alphabet, display, entry, and no pre-filled code

- **Question**: The design fixes "8 chars, unambiguous alphabet" and shows `WDJB-MJHT`, but not the exact alphabet, display grouping, entry normalization, or whether the verification URI may carry the code (RFC 8628's `verification_uri_complete`).
- **Why it matters**: Usability (transcription errors) vs. phishing posture (a code-bearing link makes one-click blind approval easier).
- **Chosen default**: RFC 8628 §6.1-style consonant alphabet (`BCDFGHJKLMNPQRSTVWXZ`, base-20 — no vowels, no ambiguous glyphs, no accidental words), displayed grouped `XXXX-XXXX`, entered case-insensitively with hyphens/whitespace ignored. No `verification_uri_complete`: the URI never carries the code; the user types it deliberately.
- **Rationale**: The design's own example (`WDJB-MJHT`) is this alphabet. Manual entry is the deliberate-friction anti-phishing choice consistent with the design's skeptical-consent posture. ~34.6 bits of entropy is ample under the D10 rate limits. Spec: FR-006, FR-009, FR-015.

### D4 — Exact durations for the design's approximate values

- **Question**: The design says "~10 minutes" (authorization TTL) and "~5 min" (approved-to-claim window). What ships?
- **Why it matters**: Testable numbers; tension between user convenience and secret-lifetime minimization.
- **Chosen default**: Exactly 10 minutes TTL, exactly 5 minutes approved-to-claim, both as named operational constants; 5-second minimum poll and 30-day token expiry as design-fixed.
- **Rationale**: Take the design's numbers literally; tunability preserved by making them constants, not contracts. Spec: FR-006, FR-020.

### D5 — Unknown handle indistinguishable from expired

- **Question**: What does `login_status`/claim return for a fabricated, mangled, or consumed handle?
- **Why it matters**: Any distinguishable response is an oracle for handle-guessing and state probing.
- **Chosen default**: Unknown, consumed, and genuinely expired handles produce indistinguishable responses (`expired` for polling; the uniform failure for claims).
- **Rationale**: Standard anti-enumeration posture; costs nothing. Spec: FR-010, FR-020, FR-026.

### D6 — Mint at delivery; auto-revoke unclaimed approvals

See G3 above. Spec: FR-019, FR-021.

### D7 — Active-token cap collision

- **Question**: What happens when the approving user is already at the per-user active `sk_sqd_` token cap?
- **Why it matters**: Without a decision, approval either silently over-mints past the cap or fails cryptically.
- **Chosen default**: The cap is checked at approval — approval fails with an actionable message (revoke a token in Settings, then retry) and the authorization stays pending and retriable until its TTL. Re-checked at mint time (D6 mints at delivery); a mint-time race failure fails the claim actionably.
- **Rationale**: Fail where the human is (the consent page) with a fix in hand, not where the agent is; keep the cap honest. Spec: FR-022.

### D8 — slow_down semantics

- **Question**: RFC 8628-style `slow_down` is mandated; what exactly changes per violation?
- **Why it matters**: Testable polling discipline; must not punish impatience with loss of the pairing.
- **Chosen default**: Each premature poll returns `slow_down` and increases the required interval by 5 seconds (RFC 8628's increment); the handle and state machine are unaffected. Sustained abuse falls under general rate limits.
- **Rationale**: Straight RFC 8628 semantics; throttle, don't destroy. Spec: FR-013.

### D9 — agentName validation policy

- **Question**: The design says the name is self-declared and displayed; what input policy applies?
- **Why it matters**: The name is hostile input rendered on a consent page (Constitution Principle V).
- **Chosen default**: Required; non-empty after trimming; max 100 characters; control characters rejected; stored as given otherwise and rendered exclusively as inert escaped text everywhere (consent page, Settings, logs).
- **Rationale**: Permissive enough for real client names, strict enough to kill injection and layout abuse; skeptical framing (not name policing) is the design's chosen mitigation for misleading names. Spec: FR-008, FR-016.

### D10 — Concrete caps and rate limits

- **Question**: The design mandates per-IP + global caps and rate limits on login, code entry, and claim, without numbers.
- **Why it matters**: FRs must be testable; SC-004's guessing bound depends on them.
- **Chosen default**: Outstanding pending authorizations: 5 per IP, 500 global. `login` calls: 10/minute per IP. Code entry: 5/minute per user, 20/hour per IP. Claim attempts: 10/minute per IP. All named operational constants, tunable without spec change.
- **Rationale**: Generous for legitimate use (one agent needs 1 pending authorization and ~1 claim), hostile to enumeration: ≤ ~3–4 code guesses per IP per code lifetime against a 20^8 space keeps SC-004's bound with orders of magnitude to spare. Spec: FR-024, FR-025.

### D11 — Inline fallback ships (design-named RATIFIED-BY-DEFAULT candidate)

- **Question**: The design names `login_status({ handle, inline: true })` — inline credential return for shell-less agents, do-not-echo warning prefixed — as a "RATIFIED-BY-DEFAULT candidate for the spec: the inline fallback ships unless Sam strikes it." Ship it?
- **Why it matters**: It is the only path for agents with no shell, and it is also the only path by which the credential can enter model context (opt-in, warned).
- **Chosen default**: Ships, exactly as designed: explicit opt-in only, do-not-echo warning prefix, counts as the one-time delivery (forecloses the REST claim and vice versa).
- **Rationale**: The design pre-ratified this pending Sam's veto; recording it here is the veto hook. Spec: FR-012.

### D12 — One-shot approved payload / handle lifetime interpretation

See G2 above. Spec: FR-010, FR-011.

---

## Implementation-time defaults (RATIFIED-BY-DEFAULT, Sam pre-authorized 2026-07-15)

### D13 — Inline delivery when the user is at the API-token cap

- **Question**: contracts/login-tools.md defines the inline payload and the REST
  claim's 409 `token_limit` carve-out (FR-022), but not what `login_status({ handle,
  inline: true })` returns when the mint hits the per-user token cap at delivery time.
- **Chosen default**: inline delivery surfaces its own distinct result
  `{ status: "token_limit", message: "…revoke a token in Settings → API Tokens, then
  retry — the approval stays valid until its window expires." }`, and the claim rolls
  back (the approval stays approved and claimable within the window), mirroring the REST
  409. Every other inline failure collapses to the uniform `expired`.
- **Rationale**: keeps inline symmetric with REST for the one actionable, spec-mandated
  failure (FR-022) without inventing a new oracle; reachable only with a live approved
  handle. The common case is already guarded by the D7 approval-time cap pre-check.
