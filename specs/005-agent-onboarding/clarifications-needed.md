# Clarifications Ledger: 005-agent-onboarding

Decisions for this feature, per pipeline rules. Section 1 records decisions **Sam
made explicitly** (they are his, dated, not defaults). Section 2 records defaults
chosen without user interaction, each as
**RATIFIED-BY-DEFAULT (Sam pre-authorized, 2026-07-14)**; any of these can be
overturned by amending the design doc (Constitution VI) and this spec together.

---

## 1. Decisions made by Sam (2026-07-13) — recorded, not defaults

### S1 — PKCE only; no device flow

- **Decision (Sam, 2026-07-13)**: Authorization is authorization-code + PKCE
  (S256) only. The RFC 8628 device authorization grant is explicitly out of
  scope.
- **Why it matters**: Device flow would add a second consent surface and a
  polling endpoint. Every target client either drives a localhost-redirect PKCE
  flow natively or can use an `sk_sqd_` API token.
- **Recorded in**: design/agent-surface-mcp.md ("Decision — PKCE only, no device
  flow"); spec FR-007, Out of Scope. Revisit only if a covered client appears
  that can do neither.

### S2 — This feature owns landing agents.md on trunk

- **Decision (Sam, 2026-07-13)**: Getting `agents.md` served from trunk is this
  feature's responsibility (not a follow-up). The existing worktree draft
  (`.claude/worktrees/agent-afbf7ebe180bd7de3/client/public/agents.md`) is input,
  not a deliverable — it never landed and is stale.
- **Recorded in**: spec User Story 3, FR-001–FR-003.

### S3 — Full pipeline process

- **Decision (Sam, 2026-07-13)**: This feature runs the full /the-pipeline
  process (spec → plan → tasks → implement → merge queue → adversarial review),
  not the lightweight commit-to-main path.
- **Recorded in**: this artifact set's existence.

---

## 2. RATIFIED-BY-DEFAULT decisions (Sam pre-authorized, 2026-07-14)

### D1 — Landing page footer links to agents.md

**RATIFIED-BY-DEFAULT (Sam pre-authorized, 2026-07-14)**

- **Question**: Should the public landing page link to `agents.md`, and how
  prominently?
- **Why it matters**: Discoverability for humans evaluating whether Squire is
  agent-ready, versus cluttering marketing copy with a machine-facing document.
- **Default chosen**: **Yes — exactly one link, in the footer** (spec FR-015).
  No hero placement, no additional copy changes.
- **Rationale**: This was pre-identified as the expected default in planning
  ("default yes, one link"). A footer link is the established convention for
  agent/developer front doors (cf. llms.txt/agents.md practice), costs nothing
  visually, and matches the marketing-copy tone rule (confident, not gimmicky).
  Overturn by removing FR-015 — nothing else depends on it.

### D2 — agents.md content baseline: adopt the existing draft, corrected and verified

**RATIFIED-BY-DEFAULT (Sam pre-authorized, 2026-07-14)**

- **Question**: Write the shipped `agents.md` from scratch against the design
  contract, or adopt the stale worktree draft as the baseline?
- **Why it matters**: FR-003 makes agents.md accuracy a correctness property;
  the starting point determines where verification effort goes.
- **Default chosen**: **Adopt the draft as baseline**, correct the known stale
  claim (REST export flavor default is now `portable` on all formats — the draft
  says `squire`), and verify every remaining factual claim (endpoint, connect
  one-liners, credential text including the "legacy `sqd_` tokens remain valid"
  claim, tool list, import modes/limits) against the implemented surface before
  ship. The design doc's five mandated elements are the completeness checklist;
  the draft already covers them except it lacks an explicit
  `claude mcp add --transport http …` style one-liner, which MUST be added
  (FR-002(b)).
- **Rationale**: The draft is well-structured and mostly accurate; rewriting
  from scratch re-risks every claim instead of just the flagged one. Verification
  claim-by-claim is required either way by FR-003.

### D3 — WWW-Authenticate challenge scope: every 401 from the MCP auth layer

**RATIFIED-BY-DEFAULT (Sam pre-authorized, 2026-07-14)**

- **Question**: The design doc specifies the challenge for "unauthenticated
  `POST /mcp`". Do 401s for *invalid* credentials (expired/revoked token,
  malformed header) and other MCP-endpoint methods also carry
  `WWW-Authenticate: Bearer resource_metadata="…"`?
- **Why it matters**: A client whose token expired or was revoked mid-session
  needs the same machine-actionable pointer to re-bootstrap authorization; an
  inconsistent challenge means some failure modes dead-end while others recover.
- **Default chosen**: **Uniform challenge — every 401 emitted by the MCP
  endpoint's auth layer carries the header**, regardless of whether the
  credential was missing, malformed, expired, or revoked (spec FR-004, edge case
  "Challenge on every unauthenticated path").
- **Rationale**: RFC 9728 §5 and the MCP authorization spec expect the challenge
  on 401 responses generally, not only on credential-absent ones; uniformity is
  strictly more standard-conformant than the design doc's minimal phrasing, and
  the design doc's chain description ("unauthenticated POST /mcp → 401 …") reads
  as the happy-path illustration, not an exhaustive enumeration.

### D4 — Invalid returnTo failure mode: drop silently to the default destination

**RATIFIED-BY-DEFAULT (Sam pre-authorized, 2026-07-14)**

- **Question**: When the post-login return destination fails validation (or has
  expired, or belongs to a different browser session), does login fail, show an
  error page, or proceed?
- **Why it matters**: This is the security/usability trade-off at the heart of
  the open-redirect defense: fail-closed must not create a new dead-end.
- **Default chosen**: **Login itself always succeeds; an invalid/expired/foreign
  return destination is discarded and the user lands on the normal default
  post-login destination, on-origin.** No error page, no aborted login (spec
  FR-010, FR-012, SC-003, edge cases).
- **Rationale**: The hostile input is the redirect target, not the login; the
  correct fail-closed posture is "ignore the tainted value," which keeps the
  user signed in and one agent-retry away from a fresh, valid consent request.
  An error page would convert an attack probe (or a slow login) into a support
  case.

### D5 — returnTo continuation is single-session and short-lived

**RATIFIED-BY-DEFAULT (Sam pre-authorized, 2026-07-14)**

- **Question**: The design doc mandates the return path be "carried in a
  short-lived cookie through the Google redirect" but does not fix a lifetime or
  cross-session posture. What are they?
- **Why it matters**: A long-lived or session-portable continuation could let a
  planted value redirect an unrelated later login (login-CSRF-adjacent), and an
  over-short one breaks slow logins.
- **Default chosen**: **Short-lived on the order of the login round-trip
  (minutes, not days — concrete TTL fixed at plan time within a 5–15 minute
  band), scoped to the initiating browser session, consumed on first use.**
  Expiry/foreign-session handling follows D4 (drop to default destination).
  Spec FR-012.
- **Rationale**: The continuation only needs to outlive one Google login; the
  narrowest lifetime that does the job is the secure default. Single-use +
  session-scoped closes replay and cross-tab confusion without any persistence.

### D6 — Root-fallback protected-resource document shape

**RATIFIED-BY-DEFAULT (Sam pre-authorized, 2026-07-14)**

- **Question**: The design mandates serving both the path-suffix form
  (`/.well-known/oauth-protected-resource/mcp`) and a root fallback
  (`/.well-known/oauth-protected-resource`). What does the root document
  describe, given the origin also hosts the non-MCP web app?
- **Default chosen**: **Both documents describe the MCP endpoint as the
  resource and reference the same authorization server** (the root form exists
  purely for clients that don't implement RFC 9728 path-insertion). Identical
  semantic content, two addresses (spec FR-005, edge case "Discovery metadata
  shape").
- **Rationale**: The MCP endpoint is the origin's only OAuth-protected resource;
  serving a different or empty root document would break exactly the
  less-conformant clients the fallback exists for.

---

## Flagged (not resolved here) — for the design doc / later features

- **agents.md drift guard mechanism**: FR-003 requires *a* verification
  mechanism (test or release-checklist item) but deliberately leaves
  test-vs-checklist and its exact assertions to plan phase. If the plan lands an
  automated drift test, consider amending the design doc's "drift is a bug"
  bullet to name it.
- **Design-doc example one-liner naming**: the design doc's example connect
  command names the server `squire` (`claude mcp add --transport http squire
  https://squiredocs.com/mcp`); the shipped agents.md should keep example and
  file in agreement — if a different alias is preferred at implementation time,
  amend the Squire doc first (Constitution VI).
