# Feature Specification: Signup/Login IP + User-Agent Capture (Abuse Signals)

**Feature Branch**: `034-auth-ip-capture`

**Created**: 2026-07-25

**Status**: Draft

**Input**: User description: "Capture the client IP address and User-Agent header on every signup and login (browser OAuth, agent OAuth, dev-login), persist them on the user record and in an append-only auth_events trail, expose them in the admin area, disclose the collection in the privacy policy, and purge event history after 180 days — so that multi-account credit-farming sprays become cheaply detectable instead of requiring content/timing forensics. Detector/report UI is a follow-on, explicitly out of scope."

**Design ground truth**: `design/authentication-and-sharing.md` — section "Abuse signals: signup/login IP + user-agent" and the amended "Data model" section (constitution Principle VI). Where this spec and that document disagree, the design doc wins; gaps found while writing this spec are flagged in `clarifications-needed.md`, never resolved silently.

## Background

On 2026-07-25 a single actor relayed five Google accounts to farm the $10 signup AI-credit grant: burn one account's credits to exhaustion, sign up the next account minutes later (4–15 minute gaps measured), carrying the same work across accounts. The application stores zero network or device metadata, so the spray was only detectable after the fact by content and timing forensics across documents and AI-usage logs. The edge WAF sees client IPs but never hands them to the app's data model.

This feature captures the metadata that makes such sprays cheaply detectable: the same actor reusing a network address and browser fingerprint across "different" accounts becomes visible directly in the admin area, and an append-only event trail supports correlation over time. A detector/report UI is explicitly a follow-on; this feature is capture + admin visibility.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Admin spots a multi-account spray from the user list (Priority: P1)

The admin opens the admin user list while investigating suspicious credit usage. Each user row now shows the network address and client software recorded at signup, and the address and client software of the most recent login. Five accounts created minutes apart from the same address with the same client software stand out immediately — no database spelunking or content forensics required.

**Why this priority**: This is the core value of the feature — turning an invisible relay spray into something an admin can see at a glance. Without the capture (US1 includes the write path), nothing else in the feature matters.

**Independent Test**: Sign up and log in through the browser flow, then view the admin user list as an admin; the signup and last-login network address and client software for that account are displayed. A second account created from the same client shows matching values.

**Acceptance Scenarios**:

1. **Given** a brand-new visitor completing browser sign-in for the first time, **When** the account is created, **Then** the account permanently records the originating network address and client user-agent as its signup values, and the same values appear as its initial last-login values.
2. **Given** an existing user, **When** they log in again from a different network address or client, **Then** the account's last-login address and user-agent are updated to the new values while the signup values remain exactly as first recorded.
3. **Given** several accounts created from the same network address, **When** the admin views the admin user list, **Then** each account's signup and last-login address and user-agent are visible, making the shared origin apparent.
4. **Given** an account created before this feature shipped, **When** the admin views the user list, **Then** the new fields display as absent/empty (no error, no fabricated values) until the user's next login fills the last-login pair.
5. **Given** a non-admin user or any public/agent-facing API surface, **When** account data is requested, **Then** none of the captured address or user-agent values are exposed.

---

### User Story 2 - Durable auth-event trail for correlation (Priority: P2)

Beyond the per-account snapshot, every signup and login appends a row to an immutable auth-event trail (who, which event, which channel, address, user-agent, when). This history is what powers spray correlation: grouping accounts by shared address over time, and spotting the exhaust-grant-then-respawn pattern (one account's last activity followed minutes later by another account's signup from the same address).

**Why this priority**: The users-table snapshot only holds the latest login; the trail preserves the sequence a future detector (follow-on feature) needs. Valuable on day one for manual queries, but the feature is already useful with US1 alone.

**Independent Test**: Perform a signup and two logins (mixing browser and agent auth paths); confirm three trail entries exist with the correct event types, channels, addresses, user-agents, and timestamps, and that a token refresh in between produced no entry.

**Acceptance Scenarios**:

1. **Given** a new account creation, **When** signup completes, **Then** exactly one `signup` event is appended with the account, channel, network address, user-agent, and timestamp.
2. **Given** an existing user authenticating via the browser flow, the agent authorization flow, or the dev-only login bypass, **When** login completes, **Then** exactly one `login` event is appended for that occurrence.
3. **Given** a signed-in session whose short-lived credentials rotate in the background (token refresh), **When** the rotation occurs, **Then** no event is appended and no captured field on the account changes.
4. **Given** an auth event older than 180 days, **When** the retention process runs, **Then** the event is removed — while the account's own signup/last-login fields are untouched for the life of the account.
5. **Given** a user account is deleted, **When** the deletion completes, **Then** all of that user's auth events are deleted with it.

---

### User Story 3 - Capture is disclosed, admin-only, and never breaks sign-in (Priority: P3)

A privacy-conscious user reads the privacy policy and finds a clear statement that the service records IP address and browser/client information at signup and sign-in for security and abuse prevention. Meanwhile, a user whose client sends no user-agent header, or whose request yields no usable address, still signs in normally — capture is best-effort and fails open.

**Why this priority**: These are correctness and trust guardrails on US1/US2 rather than standalone value; they must hold from day one but deliver no value without the capture itself.

**Independent Test**: Sign in with a client that omits the user-agent header — login succeeds and the field is recorded as absent. Review the published privacy policy — the data-collection section explicitly mentions IP/user-agent capture at signup and sign-in.

**Acceptance Scenarios**:

1. **Given** a login request with no user-agent header, **When** authentication completes, **Then** login succeeds and the user-agent is recorded as absent (not an error, not a placeholder string).
2. **Given** a login request whose user-agent header exceeds 512 characters, **When** it is recorded, **Then** the stored value is truncated to 512 characters and login succeeds.
3. **Given** any failure to record capture data (unavailable address, storage error on the event trail), **When** a user signs up or logs in, **Then** authentication still completes successfully.
4. **Given** the published privacy policy, **When** a user reads the data-collection disclosure, **Then** it states that IP address and browser/client (user-agent) information are collected at signup and sign-in for security and abuse prevention.

---

### Edge Cases

- **Missing user-agent header**: recorded as absent (null); auth proceeds.
- **User-agent longer than 512 characters**: truncated to 512 characters before storage.
- **Unavailable or unparsable client address**: recorded as absent; auth proceeds. Event rows and account fields tolerate either field being absent independently.
- **IPv6 clients**: addresses are stored in a native address type that accepts both IPv4 and IPv6.
- **Returning user through the account-upsert path**: a login that flows through the create-or-find path must never overwrite the once-set signup address/user-agent — only genuinely new accounts set them.
- **Concurrent logins (two tabs racing)**: each successful login appends its own event; last-login fields end up with one of the racers' values (either is acceptable — both are real logins).
- **Spoofing via forwarded headers**: the address is trusted only because the app resolves it through a fixed, numeric proxy hop count (feature 010 FR-014/RD-5). Changing that to blanket proxy trust would make every captured address attacker-controlled and MUST NOT happen as part of (or after) this feature.
- **Pre-existing accounts**: historical rows are not backfilled; signup fields remain permanently absent for them, last-login fields fill on their next login, and admin surfaces render absent values gracefully.
- **Retention boundary**: the purge removes only trail events past 180 days; it never touches the per-account fields and never removes newer events.
- **Failed authentication attempts**: not recorded — only completed signups and logins produce events (see Assumptions; edge/WAF is the layer for failed-attempt telemetry).

## Requirements *(mandatory)*

### Functional Requirements

**Capture — per-account snapshot**

- **FR-001**: At account creation, the system MUST record the originating client network address and user-agent on the user record as signup values (`users.signup_ip`, `users.signup_user_agent`), set exactly once and never overwritten by any later activity — including logins that pass through the same create-or-find code path.
- **FR-002**: On every successful login, the system MUST refresh the user record's last-login network address and user-agent (`users.last_login_ip`, `users.last_login_user_agent`) alongside the existing last-login timestamp.

**Capture — append-only event trail**

- **FR-003**: Every completed signup and every completed login MUST append one immutable event to an `auth_events` trail carrying: the user, the event type (`signup` or `login`), the auth channel (`signup_source` domain), the network address, the user-agent, and the creation timestamp. Application code MUST only ever insert into this trail (no updates, no per-row deletes outside retention/cascade).
- **FR-004**: Capture MUST cover all three authentication paths — browser OAuth callback, agent OAuth authorization, and the dev-only login bypass — by flowing through the same two shared user-store helpers those paths already call, with the request's address and user-agent supplied by each call site.
- **FR-005**: Token refresh MUST NOT append events or modify any captured field. It is a background credential rotation (~every 15 minutes), not a human sign-in; logging it would drown the signal in noise.

**Trustworthiness and robustness**

- **FR-006**: The captured address MUST be the proxy-resolved client address the app already derives via its fixed numeric trust-proxy hop configuration (feature 010 FR-014/RD-5). This feature MUST NOT change that configuration, and in particular MUST NOT introduce blanket proxy trust, which would make every captured address spoofable via forged forwarding headers.
- **FR-007**: User-agent values MUST be truncated to at most 512 characters before storage, in all storage locations.
- **FR-008**: All captured fields MUST be nullable, and any capture failure (missing header, unavailable address, storage error while writing the snapshot or event) MUST NOT block, fail, or delay the authentication itself.

**Retention and lifecycle**

- **FR-009**: Auth-trail events MUST be deleted automatically when their user account is deleted (cascade with the user).
- **FR-010**: Auth-trail events older than 180 days MUST be purged automatically by a recurring process (removal within roughly a day of becoming eligible; an event-time index supports the purge). The per-account signup/last-login fields are NOT subject to this purge — they persist for the lifetime of the account.

**Exposure**

- **FR-011**: The admin user list (admin API response and admin page) MUST expose all four per-account captured values (signup address/user-agent, last-login address/user-agent), rendering absent values gracefully for pre-feature accounts.
- **FR-012**: The captured values MUST NOT be exposed to non-admin users or through any public or agent-facing API surface. Admin-only is the entire exposure surface of this feature.

**Disclosure**

- **FR-013**: The privacy policy's data-collection section MUST gain an explicit disclosure that IP address and browser/client (user-agent) information are collected at signup and sign-in for security and abuse prevention, including the event-trail retention period. (The existing generic "usage and log data" paragraph does not cover purpose-specific retention of auth metadata; the policy must track what the app actually stores.)

**Scope boundaries**

- **FR-014**: The system MUST NOT backfill historical data — accounts and periods predating this feature keep absent values.
- **FR-015**: The schema change MUST land via the project's standard migration mechanism, ordered after the current latest migration (project constraint: new migration timestamps must exceed the rolled-back-008 floor; in practice, greater than the current latest, `1799300000000`).

### Key Entities

- **User (extended)**: the existing account record gains four nullable capture attributes — signup network address, signup user-agent (both written once at creation), last-login network address, last-login user-agent (both refreshed on every login). Retained for the life of the account.
- **Auth event (new)**: an append-only record of one completed signup or login — owning user (cascade-deleted with the user), event type (`signup` | `login`), auth channel (`signup_source`), network address (native inet-style type, nullable), user-agent (≤ 512 chars, nullable), and timestamp. Retained 180 days.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: A repeat of the 2026-07-25 five-account relay spray is identifiable from the admin user list alone in under one minute (shared signup origin visible across the accounts), where previously it required hours of content/timing forensics.
- **SC-002**: 100% of new signups and logins across all three auth paths record the client's address and user-agent whenever the client presents them, and 100% of them append exactly one trail event.
- **SC-003**: Authentication success rate is unchanged by this feature: zero signups or logins fail or block due to capture (verified by tests simulating missing headers and capture-path storage errors).
- **SC-004**: In steady state, no auth-trail event older than 181 days exists, while per-account signup/last-login values persist indefinitely.
- **SC-005**: Zero of the captured values are reachable through any non-admin surface (verified by inspecting non-admin API responses).
- **SC-006**: The published privacy policy explicitly discloses signup/sign-in IP and user-agent collection before or in the same deploy as the capture going live.

## Assumptions

- **Successful events only**: the trail records completed signups and logins, not failed attempts — all capture flows through the post-verification user-store helpers, and the design doc frames coverage the same way. Failed-attempt telemetry remains an edge/WAF concern. (Recorded in `clarifications-needed.md`, gap G-3.)
- **Event channel semantics**: the trail's `signup_source` column records the auth channel of that event, using the same value domain as the existing `users.signup_source` (`browser` | `agent_oauth`); dev-login (non-production only) records as `browser`, matching what its call site already passes today. (Design gap flagged — `clarifications-needed.md`, gap G-1.)
- **Purge mechanism**: no general-purpose scheduler exists in the app (`server/lifecycle.js` is only init/drain state), so the purge is expected to be a boot-time sweep plus a daily interval, in-process — mechanism chosen at plan time. (Recorded as gap G-2.)
- **Helper signature change**: the two user-store helpers (`findOrCreateUser`, `updateLastLogin` in `server/auth/users.js`) gain a `{ ip, userAgent }` argument populated by all three call sites in `server/auth/routes.js` (browser OAuth callback ~311/322, agent OAuth ~606/612, dev-login ~668/669) from the request. Verified against the current code.
- **Address source exists and is trustworthy**: `req.ip` already resolves the true client address because `server/index.js` sets a numeric trust-proxy hop count (`TRUST_PROXY_HOPS`, default 1, prod 2); `server/rate-limit.js` already keys on it. This feature reuses that, never alters it (FR-006).
- **Admin surface is additive**: the admin users query (`server/api/admin.js`, GET /users) already returns `created_at`/`last_login_at`; the four new columns extend that query and the admin page table (`client/src/pages/AdminPage.jsx`).
- **Privacy policy location**: the policy is `client/src/pages/PrivacyPage.jsx` ("Information We Collect" → "Usage and log data" is the natural anchor for the new disclosure), last updated in commit eb1ee5b; the memory note "policy must track ai-providers.js" extends naturally to tracking this feature.
- **Testing emphasis**: backend tests carry the weight (capture on all signup/login paths, once-only signup fields, refresh exclusion, 512-char truncation, null-safe capture, purge boundary, cascade); client-side tests stay minimal (admin list renders new columns and absent values).

## Out of Scope

- Detector queries, correlation views, reports, or any spray-detection UI (explicit follow-on).
- WAF/edge changes of any kind.
- Retention-period settings UI (180 days is fixed in this feature).
- Backfill of historical accounts or reconstruction of past logins (old rows stay NULL).
- Recording failed authentication attempts or token refreshes.
- Exposure of captured data anywhere other than the admin area.
