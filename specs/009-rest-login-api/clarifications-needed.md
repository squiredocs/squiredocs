# Clarifications Ledger — 009-rest-login-api

Per Constitution Principle VI: unanswered product decisions get the best default,
recorded here as RATIFIED-BY-DEFAULT; material design gaps or tensions are flagged,
never resolved silently. Design ground truth: `design/agent-surface-mcp.md`, section
"Amendment — the login flow is an API, MCP is one client of it (feature 009, Sam,
2026-07-15)", inheriting the parent "MCP-native onboarding: the login tool (feature
008)" contracts unchanged. The 008 ledger (D1–D13) remains binding and is not
restated here.

All entries below: **RATIFIED-BY-DEFAULT (Sam pre-authorized, 2026-07-15)** unless
amended in the design doc.

---

## Flagged design gaps (tensions/silences in the design doc)

### G1 — The "list docs" nextSteps recipe promotes an undocumented route to a public contract *(resolved by default — needs Sam's eyes)*

- **Question**: The amendment mandates that `nextSteps` include a "list docs" REST
  recipe, but the agent-facing REST surface documented in agents.md today is only
  export and import. A `GET /api/docs` route exists and accepts `sk_sqd_` bearer
  tokens (the auth middleware handles API tokens uniformly), but it has never been a
  documented, drift-guarded, agent-facing contract. Which endpoint does the recipe
  name, and does naming it make it a pinned public surface?
- **Why it matters**: Whatever the recipe names becomes de facto public API — agents
  will script against it from the payload. If it is the session-oriented internal
  route, its response shape is now load-bearing for agents; silently breaking it
  later would violate the design's "drift is a bug" rule.
- **Chosen default**: The recipe uses `GET /api/docs` with the claimed bearer token,
  and the restructured agents.md documents it in the REST section alongside
  export/import (with a drift-guard pin), making the promotion explicit rather than
  accidental. Its response shape is not otherwise changed by this feature.
- **Rationale**: It is the only existing list route; the design's companion text
  already pairs listing with export for incremental sync. Documenting what the
  payload teaches is the honest version of the design's own "drift between agents.md
  and the implemented surface is a bug" rule. Spec: FR-011, FR-021.

### G2 — No per-IP transport limit on `GET /api/login/status` under "identical rate limits" *(resolved by default — posture note)*

- **Question**: The design requires "identical rate limits" to the tool surface. The
  `login_status` tool has no per-IP rate limit — only the per-handle slow-down
  discipline (008 D8) — so a literally identical REST status route has no per-IP
  transport gate either. Is that acceptable for an anonymous REST GET endpoint?
- **Why it matters**: An anonymous endpoint with no IP limit invites hammering; the
  counterweights are that handle probing is useless (256-bit handles, uniform
  expired, no oracle — 008 D5) and the equivalent anonymous MCP `tools/call` path is
  equally unlimited today, so the new door adds no capability an attacker lacks.
- **Chosen default**: Identical means identical: the status route ships with the
  shared per-handle slow-down discipline and no new per-IP transport limit. Any
  future per-IP ceiling would be an operational constant added to BOTH channels at
  once (the 008 D10 posture), not a REST-only divergence.
- **Rationale**: Follows the design's word ("identical"), keeps the two doors
  security-equivalent, and avoids inventing an unratified limit. Flagged so Sam can
  impose a ceiling deliberately if wanted. Spec: FR-004, FR-008; SC-002.

### G3 — Where the nextSteps block rides: "the approved/claim delivery" vs. the raw byte channel *(resolved by RD-3)*

- **Question**: The design says "the approved/claim delivery gains a nextSteps
  block." The claim response (`GET /api/login/claim`) is raw credential bytes
  streamed to a file; embedding a JSON block there would corrupt the credential file
  every recipe writes.
- **Why it matters**: The 0600-file claim recipe is the design's own channel rule in
  action; breaking the clean-bytes contract would break every shipped claim command
  and the "shell-friendly line" file format.
- **Chosen default**: See RD-3 — `nextSteps` rides the approved payload (recipe
  delivery) and the inline deliveries in both consumers; the raw-byte claim response
  body remains exactly the credential bytes.
- **Rationale**: The only reading that preserves both the new mandate and the 008
  byte-channel contract the amendment explicitly inherits unchanged.

---

## Ratified defaults (design silences with reasonable defaults)

### RD-1 — `POST /api/login/start` response is a superset of the enumerated fields

- **Question**: The design enumerates `{ userCode, verificationUri, handle,
  pollIntervalSeconds }`. The tool's payload also carries the TTL and agent-facing
  instructions. Does the REST response carry them too?
- **Why it matters**: Agents need the TTL to schedule polling sensibly; instructions
  carry the relay-and-poll choreography and the credential rule.
- **Chosen default**: The enumerated fields are the guaranteed minimum; the response
  additionally mirrors the tool's payload (status discriminator, `expiresInSeconds`,
  instructions rephrased for the REST channel — poll `GET /api/login/status` with
  the Bearer handle rather than the tool).
- **Rationale**: One service, one payload family; withholding the TTL from one door
  would be gratuitous divergence. Spec: FR-001.

### RD-2 — HTTP status mapping for the REST wrappers

- **Question**: The design fixes payloads ("same status contract, plain JSON") but
  not HTTP status codes for start/status.
- **Why it matters**: Testable contracts; and a wrong mapping (e.g. 404 for expired
  on status) would create behavioral divergence from the tool's decision table.
- **Chosen default**: `start`: 200 on success, 400 on agentName validation failure,
  429 + Retry-After on the uniform rate-limited outcome, 500 on unexpected error.
  `status`: 200 for every decision-table outcome (pending / slow_down / approved /
  denied / expired / token_limit) with the outcome in the `status` field. `claim`
  (canonical and alias): the shipped 008 mapping unchanged — 200 bytes / uniform 404
  / 429 / 409 token_limit / 500.
- **Rationale**: 200-with-status keeps the polling contract byte-comparable to the
  tool's JSON (the design's "same status contract"); 400/429 are the standard,
  non-oracle transport errors; the claim mapping is inherited, not reinvented.
  Spec: FR-002, FR-003, FR-004, FR-007.

### RD-3 — nextSteps placement across deliveries

- **Question**: See G3.
- **Chosen default**: `nextSteps` appears in the one-shot approved (recipe) payload
  and the inline delivery of BOTH consumers (login_status tool, REST status). The
  raw-byte claim response stays credential-only.
- **Rationale**: See G3. Spec: FR-011, FR-012.

### RD-4 — Emitted claim recipes switch to the canonical path

- **Question**: The shipped claim command and agents.md name `/api/mcp/login/claim`.
  With `/api/login/claim` canonical, which URL do newly emitted recipes and docs use?
- **Why it matters**: The alias exists for compatibility; if new payloads keep
  teaching the alias, the canonical path never becomes real.
- **Chosen default**: Every recipe emitted by the flow (tool and REST approved
  payloads) and every documentation surface (agents.md, discovery) references the
  canonical `/api/login/claim`. The alias is kept working indefinitely but is
  documented at most as a compatibility note. The drift-guard claim-path pin (p)
  is updated to the canonical URL.
- **Rationale**: "Canonical" means it is what the system teaches; the alias's job is
  in-flight sessions and stale transcripts, not new traffic. Spec: FR-012, FR-018,
  FR-020.

### RD-5 — Inline opt-in carrier on the REST status route

- **Question**: The tool takes `inline: true` as a parameter; a GET endpoint needs a
  carrier. (The parent design names inline only on the tool; the amendment's "same
  status contract" is read as including it — it is part of the tool's contract, and
  a shell-less REST-only agent is exactly the inline constituency.)
- **Chosen default**: A query parameter (`?inline=true`) on `GET /api/login/status`.
  The inline response mirrors the tool's inline payload (do-not-echo warning first,
  credential, expiry, and the D13 token_limit carve-out), served with
  `Cache-Control: no-store`. The handle stays in the Bearer header — nothing secret
  rides the query string.
- **Rationale**: The opt-in flag is not a secret, so a query parameter is safe and
  idiomatic; header-carried handles keep the 008 log-safety rule intact. Spec:
  FR-005, FR-006.

### RD-6 — Uniform auth-failure behavior on `GET /api/login/status`

- **Question**: What does the status route return with no Authorization header, a
  malformed one, or a non-Bearer scheme?
- **Why it matters**: A distinct "missing header" error would be a (mild) oracle and
  a second error vocabulary; 008's claim route already collapsed missing and unknown.
- **Chosen default**: All indistinguishable from an unknown handle: HTTP 200
  `{ status: "expired", … }` — the uniform expired outcome, byte-identical to a
  fabricated handle.
- **Rationale**: Extends 008 D5's no-oracle posture to the new route with the status
  route's own vocabulary (expired), matching how the tool treats unknown handles.
  Spec: FR-005.

### RD-7 — Shape of the manifest `restApi` block

- **Question**: The design says the manifest "gains an additive restApi block
  (login-start URL + agents.md anchor)" without field names.
- **Chosen default**: `restApi: { loginStart: "<abs>/api/login/start",
  documentation: "<abs>/agents.md#<choose-your-channel anchor>" }` — absolute URLs
  derived from the request's base URL like the rest of the manifest; exact field
  names are an implementation detail the contract test pins, and the anchor follows
  the restructured agents.md's actual heading.
- **Rationale**: Minimal, additive, and self-describing; the two design-mandated
  pieces of information and nothing else. Spec: FR-014, FR-015.

### RD-8 — Shared rate-limit budgets across channels

- **Question**: "Identical rate limits" — do the REST wrappers get their own buckets
  (same numbers, separate budgets) or draw from the tool path's buckets?
- **Why it matters**: Separate buckets would silently double the attacker's budget
  for every gate (20 starts/min/IP instead of 10; 20 claim attempts/min/IP across
  the two claim URLs), weakening the 008 D10 posture the amendment inherits
  "unchanged".
- **Chosen default**: One budget per gate for the whole flow: tool `login` + REST
  `start` share the per-IP login budget; canonical + alias claim share the per-IP
  claim budget; the pending caps were always flow-wide. Slow-down/poll-interval
  state is per-handle and shared (single state machine).
- **Rationale**: The design's "identical rate limits … the MCP tools delegate to the
  same service — no second implementation" reads most naturally as one flow with one
  posture; anything else is a security regression dressed as parity. Spec: FR-002,
  FR-007, FR-008; SC-002.

### RD-9 — Residual placement of the bare `claude mcp add` one-liner in agents.md

- **Question**: The design bans the bare form "as a recommended step for agents that
  already hold a credential." May it appear at all, and where? (Drift-guard pin (d)
  currently requires the exact bare one-liner somewhere in the file.)
- **Why it matters**: The bare form is still the correct connect step for the
  MCP-native OAuth discovery channel (no credential exists yet; OAuth is the point).
  Removing it entirely would break that channel's instructions; leaving it anywhere
  near the credentialed paths recreates the live-test failure.
- **Chosen default**: The bare one-liner survives only inside the MCP-native OAuth
  discovery channel (channel 3), framed as "no credential yet — your client's OAuth
  takes over," and appears in no shell-first or credential-holding path. Pin (d) is
  retained but scoped/reworded to assert the bare form appears in the OAuth-discovery
  context; a companion pin asserts the credential-holding paths show only the
  `--header` form.
- **Rationale**: Keeps every channel's instructions truthful while making the
  documented recommendation structure enforce the design's rule. Spec: FR-017,
  FR-019, FR-020.
