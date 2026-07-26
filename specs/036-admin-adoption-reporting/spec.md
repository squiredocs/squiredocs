# Feature Specification: Admin Per-User Agent Connection & Onboarding Detail

**Feature Branch**: `036-admin-adoption-reporting`

**Created**: 2026-07-26

**Status**: Draft

**Input**: User description: "Add to the admin area info about mcp connections, keys, and those kinds of onboarding counts." — scope narrowed by Sam (2026-07-26, mid-spec): 036 covers per-user detail only; the deployment-wide rollup cards are deferred to a later feature (see Out of Scope).

**Design ground truth**: `design/agent-surface-mcp.md` — section "Admin visibility: adoption and connection state (036)"; plus `design/authentication-and-sharing.md` — the Admin area capabilities sentence naming 036 (constitution Principle VI). Sam is amending the design doc in parallel to mark the deployment-wide rollups deferred; this spec converges to the per-user-only scope per his direct instruction. Where this spec and the (amended) design docs disagree, the design docs win; gaps found while writing this spec are flagged in `clarifications-needed.md`, never resolved silently.

## Background

The agent surface (OAuth delegations, `sk_sqd_` API tokens, MCP tool activity) and the onboarding flow already generate the state that answers "did this account ever connect an agent, and when did it last do anything?" — but none of it is visible outside the database. Checking whether a specific user has connected Claude Code, holds live API tokens, or ever got past the seeded welcome doc requires a psql session against production.

This feature surfaces that state per user, strictly read-only, inside the admin user list's existing expanded detail row: the user's connected agents (each delegation with name, scopes, timestamps, and state), their `sk_sqd_` API tokens (name, non-secret prefix, scopes, timestamps, state, and how each was minted), their onboarding state (signup source, onboarding completion, whether they authored a real document beyond the welcome doc, welcome-email status), and a lightweight agent-activity summary (a count and a last-activity time — no timeline). It reports; it never revokes, mints, or edits — revocation stays where it already lives, in the user's own Settings — and it never exposes secret material of any kind.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Admin inspects one user's agent connections and keys (Priority: P1)

The admin expands a user's row in the existing admin user list and sees that user's agent connections and API tokens — each delegation with agent name, scopes, created time, last-used time, and current state (active / revoked / expired); each token with display name, non-secret prefix, scopes, created, last-used, expiry, state, and whether it was minted interactively or by an agent. Enough to answer "did this account ever connect an agent, and when did it last do anything?" without a psql session.

**Why this priority**: This is the core of the feature — the agent/MCP connection state that is currently invisible outside the database. It is independently valuable with no onboarding fields at all.

**Independent Test**: For a user seeded with one active delegation, one revoked delegation, one active interactive token, one agent-minted token, and one expired token, expand their row and verify all five credentials appear with correct names, scopes, timestamps, state labels, and mint paths. Expand a user with no agent history and verify a clear empty state. A non-admin request for the same data is rejected.

**Acceptance Scenarios**:

1. **Given** a user with both active and revoked/expired credentials, **When** the admin expands their row, **Then** all of that user's delegations and tokens are listed — active ones clearly distinguished from revoked and expired ones — each with name, scopes, created, and last-used timestamps.
2. **Given** a user's API tokens, **When** displayed, **Then** each row shows the token's display name, its non-secret prefix, scopes, timestamps, expiry, and how it was minted (interactively vs by an agent) — and never any secret material.
3. **Given** a delegation for an agent present in the registered-agents catalog, **When** displayed, **Then** it carries the registered display name; **Given** a delegation with no registered-catalog link, **Then** it falls back to the delegation's self-reported agent name rather than being dropped or blank.
4. **Given** a user who has never connected an agent or minted a token, **When** the admin expands their row, **Then** the section states that plainly (empty state), not an error or an absent section.
5. **Given** a non-admin authenticated user (or an unauthenticated caller), **When** they request any per-user agent-access data, **Then** the request is denied and no data is returned.

---

### User Story 2 - Admin sees the user's onboarding state and activity at a glance (Priority: P2)

In the same expanded row, the admin sees where the user stands in onboarding — how they signed up (browser vs agent-OAuth), when they signed up, whether and when they completed onboarding, whether they have authored a real document beyond the seeded welcome doc, and whether the beta welcome email was sent — plus a lightweight agent-activity summary for that user: how many agent actions are on record and when the most recent one happened.

**Why this priority**: The onboarding half of Sam's ask. It completes the "did this account get anywhere?" picture but is useful only alongside (and less often than) the connection state in Story 1.

**Independent Test**: Seed users at assorted stages (fresh signup, onboarded-but-no-real-doc, authored-a-real-doc, agent-OAuth signup, welcome-email sent/unsent, with and without logged agent activity) and verify each expanded row reports the correct onboarding fields and activity summary, including zero-activity users.

**Acceptance Scenarios**:

1. **Given** any user, **When** the admin expands their row, **Then** the onboarding state shows: signup source, signup time, onboarding-completed time (or "not yet"), whether a non-welcome document has been authored, and welcome-email status.
2. **Given** a user whose only owned document is the seeded welcome doc, **When** the admin expands their row, **Then** "authored a real document" reads as no; **Given** they own at least one other document, **Then** it reads as yes.
3. **Given** a user with recorded agent activity, **When** the admin expands their row, **Then** the activity summary shows the total count of recorded agent actions for that user and the time of the most recent one — no per-event timeline.
4. **Given** a user with no recorded agent activity, **When** the admin expands their row, **Then** the activity summary shows zero/none rather than an error.

---

### User Story 3 - The detail surface is read-only and leaks nothing (Priority: P3)

The new surface is safe by construction: the admin cannot revoke, mint, or edit anything through it; no response contains token hashes, refresh-token hashes, client secrets, or full token values; and viewing it writes nothing to the database — everything is computed at request time from the live tables.

**Why this priority**: Invariants on Stories 1–2 rather than a separate journey, but independently testable, and each prevents a real regression (a new privileged mutation path over other people's credentials, or a credential-equivalent leak to the admin UI).

**Independent Test**: Exercise the new per-user response(s) and assert no secret-material fields appear anywhere in any payload; verify the new surface exposes no mutation operations; verify that repeatedly expanding rows causes zero writes to the underlying tables.

**Acceptance Scenarios**:

1. **Given** any per-user agent-access response, **When** inspected in full, **Then** it contains no token hash, refresh-token hash, client-secret hash, or complete token value — token identity is conveyed by display name and non-secret prefix only.
2. **Given** the new admin surface, **When** enumerated, **Then** it offers no operation that revokes, mints, creates, or modifies any credential or user attribute — read operations only.
3. **Given** repeated admin views of per-user detail, **When** the underlying tables are compared before and after, **Then** nothing was written: no counters, no view logs, no schema additions.

---

### Edge Cases

- A delegation whose agent is not in the registered-agents catalog (older or dynamically registered client): the display falls back to the delegation's self-reported agent name rather than dropping the row.
- Re-connecting after revocation reuses the same per-user-per-agent delegation record (revocation is cleared, original consent time preserved): the row shows the original consent time as "created", which is the honest lifetime answer to "when did they first connect this agent".
- A registered agent that is currently disabled deployment-wide: the user's existing delegation still displays under its registered name; client enablement is not this feature's concern.
- A user whose welcome-doc pointer was cleared (welcome doc deleted, or never seeded — possible for agent-OAuth signups): "authored a real document" falls back to "owns at least one document" for that user — acceptable imprecision, noted in Assumptions.
- Tokens minted by a delegation and tokens minted by another token both display as agent-minted; only tokens with neither mint-parent display as interactively minted. A token whose mint-parent reference was nulled by deletion of the parent displays as interactively minted — acceptable imprecision at current scale.
- A token or delegation expiring at the exact moment of the request: the active/expired state is evaluated against the request time; boundary rows may land on either side and that is acceptable.
- The activity summary counts only what the activity log records (delegation-authenticated agent tool calls — see Assumptions): a user who works exclusively via `sk_sqd_` tokens shows zero logged activity while their token last-used timestamps still show recent use. The two must not be conflated in the display.
- Concurrent additions to the same expanded row by other in-flight features (e.g. the per-user model picker): the sections are additive and independent; a failure to load agent detail must not break the other sections or the page.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: The admin user list's existing expanded detail row MUST gain a per-user agent-access section listing all of that user's agent delegations, each with: agent display name, scopes, created time, last-used time, and state (active / revoked / expired).
- **FR-002**: The same section MUST list all of that user's `sk_sqd_` API tokens, each with: display name, non-secret token prefix, scopes, created time, last-used time, expiry, state (active / revoked / expired), and mint path — interactively minted vs agent-minted.
- **FR-003**: A token is agent-minted when it was minted by a delegation or by another token; otherwise it is interactively minted. A credential is active when it is not revoked and not past its expiry; revoked and expired credentials MUST be included in the listings and clearly distinguished from active ones — the lists answer "did this account *ever* connect", not just "is it connected now".
- **FR-004**: The agent display name MUST come from the registered-agents catalog when the delegation is linked to a registered client, otherwise from the delegation's self-reported agent name.
- **FR-005**: The expanded row MUST present the user's onboarding state: signup source (browser vs agent-OAuth), signup time, onboarding-completed time (or not yet), whether the user has authored at least one document other than their seeded welcome doc, and welcome-email status.
- **FR-006**: The expanded row MUST present a lightweight per-user agent-activity summary: the total count of recorded agent actions for that user and the timestamp of the most recent one. No per-event timeline, event feed, or action breakdown. The summary MUST be labeled to reflect what the activity log actually records (OAuth-delegated agent tool calls — see Assumptions), not implied to cover all agent traffic.
- **FR-007**: Per-user detail (FR-001–FR-006) MUST be fetched lazily when the row is expanded, following the same on-expand pattern as the existing expanded-row sections (sharing, extra credits); it MUST NOT be bulk-loaded for all users with the user list.
- **FR-008**: All new reads MUST be admin-only, enforced by the same admin gate as the rest of the admin area; non-admin and unauthenticated requests MUST be denied. Test coverage MUST prove the gate non-vacuously (exercising the real admin gate, per the established exemplar).
- **FR-009**: No response may contain secret material: no token hashes, no refresh-token hashes, no client-secret hashes, no full token values, and no other credential-equivalent data. Token identity is conveyed by display name and non-secret prefix only. Test coverage MUST assert the absence of these fields in every new response shape.
- **FR-010**: The surface MUST be read-only by construction: it introduces no operation that revokes, mints, creates, or modifies credentials, users, or settings. Revocation remains exclusively in the user's own Settings.
- **FR-011**: Everything displayed MUST be computed at request time from the live tables. The feature MUST NOT add denormalized counters, caches of record, new tables, schema migrations, or any new write path — including writes triggered by viewing the detail.
- **FR-012**: The new sections MUST render meaningful empty/zero states (user with no agent history, no activity), and a failure to load agent detail MUST NOT break the other expanded-row sections or the rest of the admin page.

### Key Entities

- **Agent delegation**: an existing per-user-per-agent OAuth consent record (`agent_delegations`; unique per user+agent, reused on re-consent). Reporting reads: agent identity/name, scopes, created, last-used, revoked, expires, link to the registered client. Never read: refresh-token hash.
- **API token**: an existing `sk_sqd_` credential record (`mcp_api_tokens`). Reporting reads: name, token prefix, scopes, created, last-used, revoked, expires, and the two mint-parent references that define the mint path. Never read: token hash.
- **Registered agent**: an existing OAuth client catalog entry (`registered_agents`) supplying the preferred display name for a user's delegations. Never read: client-secret hash.
- **Agent activity record**: an existing append-only log row (`agent_activity_log`) of a delegation-authenticated agent tool call. Reporting reads per-user count and latest timestamp only; the free-form metadata payload (which can embed tool arguments/user content) is never surfaced.
- **User onboarding attributes**: existing per-user fields — signup source, created, onboarding-completed time, welcome-email-sent time, welcome-doc pointer — combined with document ownership to derive "authored a non-welcome document".

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: The admin can answer "did this account ever connect an agent, which ones, and when did it last do anything?" from the user's expanded row alone, for 100% of accounts — a question that previously required psql against production.
- **SC-002**: The admin can read a user's onboarding position (signup path, onboarded, authored a real doc, welcome email) from the same expanded row, with zero database sessions.
- **SC-003**: Zero secret material in responses: automated tests covering every new response shape find no hash or token-value field, ever.
- **SC-004**: Zero writes attributable to the feature: expanding rows any number of times changes nothing in the database.
- **SC-005**: At current production scale, expanding a user row shows their agent/onboarding detail within 1 second, and the admin user list itself loads no slower than before.
- **SC-006**: Every displayed value is exact with respect to the live tables at request time (no staleness window from counters or caches) — verified by tests seeding known state and asserting exact output.

## Assumptions

- **Activity-log coverage**: the activity log records only delegation-authenticated (OAuth) MCP tool calls; `sk_sqd_`-token tool calls, REST export/import traffic, and claim-minted-token usage never appear in it (verified in code, 2026-07-26). The design doc names this log as the activity source, so the spec follows it — with FR-006's honest-labeling requirement, and with the credentials' own last-used timestamps carrying the usage signal for the token path. Flagged in `clarifications-needed.md` as a design gap.
- **Per-user activity summary is cheap**: the activity log is indexed by user and time, so a per-user count + max-timestamp read is bounded and index-served; no window is needed because the summary is a single pair of values, not a feed.
- **"Authored a real document"** means: owns at least one document that is not the user's seeded welcome doc, using the same ownership notion the admin user list's existing doc count uses. For users whose welcome-doc pointer is unset (cleared or never seeded), any owned document counts — acceptable imprecision at current scale.
- **Scale**: current production is beta-scale (tens of users, at most hundreds of credentials per user by cap, activity log well within index reach). Request-time reads on row expand are comfortably within SC-005; no precomputation is warranted.
- **Placement**: the new content joins the existing expanded-row sections (trusted-sender, origin metadata, sharing, extra credits). Another in-flight feature (035) is concurrently adding a per-user model picker to the same expanded row; the sections are additive and independent.
- **No new data**: the feature is a pure read over existing tables; no migration is needed (schema verified against the dev database, 2026-07-26).
- **Test coverage per constitution Principle II**: per-user detail correctness against seeded state (active/revoked/expired/mint-path/name-fallback, onboarding fields, activity summary, empty states), the non-vacuous admin 403 (real admin gate mounted, per the existing exemplar), secret-material absence assertions, and admin-page rendering of the new sections.

## Out of Scope

- **Deployment-wide rollup cards — deferred, not rejected** (Sam, 2026-07-26): aggregate adoption reporting — active delegations grouped by agent, active tokens split by mint path, a recent-activity card, and the onboarding funnel (signups, onboarded, authored-a-doc, connected-an-agent, signup-source split) — remains a good idea for a later feature; 036 deliberately ships the per-user half only.
- Revoking, minting, creating, or editing anything from the admin area (credentials, delegations, registered agents, onboarding state).
- Exposing token hashes, refresh-token hashes, client secrets, full token values, or activity-log metadata payloads.
- New tables, migrations, denormalized counters, or any new write path.
- Per-user activity timelines, event feeds, or per-action breakdowns beyond the count + last-activity summary.
- Charts, graphs, or charting libraries.
- Exporting data (CSV or otherwise).
- Extending activity logging to token-authenticated or REST traffic (flagged as a possible follow-on in `clarifications-needed.md`).
- Managing the registered-agents catalog (enable/disable, scopes) from the admin area.
