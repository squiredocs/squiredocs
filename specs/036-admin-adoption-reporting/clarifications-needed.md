# Clarifications ledger — 036-admin-adoption-reporting (spec phase)

Per the parallel-agent rules: no user interaction; each open product decision got the best
default and is recorded here as **RATIFIED-BY-DEFAULT (Sam pre-authorized, 2026-07-26)**.
Overturn any of these by amending the spec before plan/implement consumes it.

**Scope note**: mid-spec (2026-07-26), Sam narrowed 036 to per-user detail only — the
deployment-wide rollup cards (delegations-by-agent, tokens-by-mint-path, recent-activity,
onboarding funnel) are deferred to a later feature. The spec was rewritten to
per-user-only; rollup-specific decisions were dropped rather than left as orphans. Sam is
amending the design doc's 036 section in parallel to mark the rollups deferred.

Design ground truth: `design/agent-surface-mcp.md` — "Admin visibility: adoption and
connection state (036)" (per-user bullets; rollup bullet deferred per Sam's instruction) —
plus the Admin area capabilities sentence in `design/authentication-and-sharing.md`. The
design already fixes the core semantics (read-only; never exposes secret material;
request-time aggregation with no migration; per-user detail in the expanded row); the
decisions below cover the points it leaves under-specified.

## RATIFIED-BY-DEFAULT decisions

1. **Read-only surface — no revoke/mint/edit from admin** — RATIFIED-BY-DEFAULT
   (Sam pre-authorized, 2026-07-26).
   *Question*: should the admin, while looking at a suspicious token, be able to revoke it
   in place?
   *Why it matters*: an admin revoke button is the obvious "while we're here" addition, and
   it would create a brand-new privileged mutation path over other people's credentials.
   *Rationale*: the design is explicit — "the admin surface reports, it does not revoke,
   mint, or edit"; revocation stays in the user's own Settings, so no new mutation surface
   exists to secure or audit. Spec: FR-010, US3, Out of Scope.

2. **Never expose secret material — prefix + name + scopes + timestamps only** —
   RATIFIED-BY-DEFAULT (Sam pre-authorized, 2026-07-26).
   *Question*: do token rows in admin responses carry `token_hash` (or delegation rows
   `refresh_token_hash`, or registered agents `client_secret_hash`) for identification?
   *Why it matters*: hashes are as good as passwords to an offline attacker and have zero
   diagnostic value; a `SELECT *` habit would leak them into every admin payload.
   *Rationale*: the design forbids it outright; identification uses display name plus the
   existing non-secret `token_prefix`. Backed by a test asserting absence in every new
   response shape. Spec: FR-009, SC-003.

3. **Request-time reads — no counters, no tables, no migration** — RATIFIED-BY-DEFAULT
   (Sam pre-authorized, 2026-07-26).
   *Question*: precompute per-user adoption state (triggers/cron) or compute on request?
   *Why it matters*: counters add a write path and a staleness window to what is a
   low-traffic admin surface; they can silently drift from the truth they summarize.
   *Rationale*: the design mandates live computation — "counts are computed at request time
   from the live tables; no denormalized counters, no new write path" — and the existing
   per-user indexes (tokens by user, delegations by user, activity by user+time) bound the
   cost at beta scale. Schema verified against the dev DB 2026-07-26: no migration needed.
   Spec: FR-011, SC-004, SC-006.

4. **Per-user activity summary = all-time count + last-activity timestamp; no window, no
   timeline** — RATIFIED-BY-DEFAULT (Sam pre-authorized, 2026-07-26).
   *Question*: what shape does the "recent agent activity" signal take per user — a
   windowed count, an event feed, or a summary pair?
   *Why it matters*: a timeline is explicitly out of scope (Sam), and a windowed count
   ("actions in the last N days") invents a window parameter the per-user question doesn't
   need — "when did it last do anything?" is answered by a timestamp, not a window.
   *Rationale*: a single count + max-timestamp pair per user, index-served
   (`(user_id, created_at)`), is the cheapest read that answers both "did this account's
   agents ever do anything?" (count) and "when most recently?" (timestamp). All-time, so
   zero configuration surface. Spec: FR-006, US2 scenarios 3–4.

5. **Per-user detail lazy-loads on row expand** — RATIFIED-BY-DEFAULT
   (Sam pre-authorized, 2026-07-26).
   *Question*: bulk-load every user's agent/token detail with the user list, or fetch on
   expand?
   *Why it matters*: bulk-loading multiplies the user-list query by per-user credential
   lists nobody may look at, and diverges from how the page already works.
   *Rationale*: the expanded row already lazy-loads sharing and extra-credits on expand;
   the agent-access section follows the identical established pattern. Spec: FR-007, US1.

6. **"Ever connected an agent" is answered by showing everything: revoked/expired
   credentials are listed, state-labeled — lifetime semantics** — RATIFIED-BY-DEFAULT
   (Sam pre-authorized, 2026-07-26).
   *Question*: does the per-user view show only currently-active credentials, or the full
   lifetime record? (Equivalently: is "connected an agent" defined as any non-revoked
   delegation, or ever-created?)
   *Why it matters*: the design's own framing — "did this account ever connect an agent,
   and when did it last do anything?" — is unanswerable if revoked/expired rows are hidden;
   but presenting dead credentials as live would overstate current access.
   *Rationale*: lifetime semantics — every delegation and token ever created is listed
   (note re-consent reuses the same delegation row, so "created" is the original consent
   time), with active / revoked / expired clearly distinguished so the current state is
   never misread. Both credential paths count as "connecting an agent": delegations and
   `sk_sqd_` tokens are both first-class agent access per the design's Credentials
   section. This definition also carries forward unchanged to the deferred funnel card
   ("connected an agent" = ever created either credential) whenever the rollup feature is
   picked up. Spec: FR-003, US1 scenario 1.

7. **Welcome-email status joins the onboarding fields** — RATIFIED-BY-DEFAULT
   (Sam pre-authorized, 2026-07-26).
   *Question*: the design's per-user bullet lists credentials + "where they stand in
   onboarding"; does welcome-email state belong there?
   *Why it matters*: the admin triggers welcome emails from this very table (existing
   per-row button); onboarding state without email status would send the admin looking at
   two places for one story.
   *Rationale*: included per Sam's scope instruction (signup_source, onboarded_at,
   authored-a-real-doc, welcome-email sent); it is an existing user attribute already
   surfaced to admins elsewhere on the page, so no new exposure class. Spec: FR-005.

## Plan-phase additions — RATIFIED-BY-DEFAULT (Sam pre-authorized, 2026-07-26)

8. **One endpoint for the whole per-user payload, named `/adoption`** — RATIFIED-BY-DEFAULT.
   *Question*: one `GET /api/admin/users/:userId/adoption` returning
   `{ delegations, tokens, onboarding, activity }`, or four narrow endpoints?
   *Why it matters*: it fixes how many round trips an expand costs, how many failure modes the
   panel has, and how many response shapes the secret-material assertion must cover.
   *Rationale*: the `GET /users/:userId/sharing` precedent already returns two unrelated
   collections in one response because they make up one panel — 036 is the same case, larger.
   One fetch (FR-007), one `.catch()` (FR-012), one shape to prove leak-free (FR-009). The name
   is the design document's own word for this surface, covers onboarding and activity as well as
   credentials, and leaves `/api/admin/adoption` free for the deferred rollups. Plan Summary,
   research R1.

9. **Credential state is derived server-side as one `state` field** — RATIFIED-BY-DEFAULT.
   *Question*: ship raw timestamps and let the client decide "active", or compute it once?
   *Why it matters*: "is this credential live?" is a security-relevant judgement; two
   implementations of it will eventually disagree.
   *Rationale*: `GET /users/:userId/extra-credits` already derives `isExpired`/`isDepleted`
   server-side. 036 returns `state: 'active' | 'revoked' | 'expired'` (revoked wins over
   expired) plus the raw timestamps, so the invariant is assertable from the backend suite
   (SC-006) and the client stays a renderer. Research R3.

10. **"Authored a real document" uses list-ownership, not `isEngaged()`** — RATIFIED-BY-DEFAULT.
    *Question*: reuse `server/onboarding.js` `isEngaged()` (which additionally requires persisted
    content) or the admin list's ownership notion?
    *Why it matters*: the two predicates disagree for a user who created a document and never
    typed in it — one says yes, the other no, and `onboarded_at` follows the stricter one.
    *Rationale*: the spec's Assumptions pin this to "the same ownership notion the admin user
    list's existing doc count uses" (`document_shares`, `role = 'owner'`), which keeps the field
    consistent with the `Docs` column on the same row and costs no extra query. The divergence is
    **not hidden**: `onboardedAt` is displayed beside it and the label reads *"Owns a doc besides
    the welcome doc"*, never "engaged" or "activated". Research R7.

11. **Malformed `:userId` returns 404, not 500** — RATIFIED-BY-DEFAULT.
    *Question*: let a non-UUID path parameter reach Postgres (raising `22P02` → 500), or shape-check it?
    *Why it matters*: a mistyped id should read as "no such user", not as a server fault in the logs.
    *Rationale*: a UUID-shape guard before the query, `404 { error: 'User not found' }` for both
    the malformed and the genuinely-absent case. Three lines, admin-only surface, no behaviour
    change for valid ids. Contract "Mounting and authorisation".

12. **Failed-to-load is distinguished from loaded-and-empty** — RATIFIED-BY-DEFAULT.
    *Question*: on fetch failure, fall back to empty arrays like the sharing/extra-credits panels do?
    *Why it matters*: for those panels "empty" and "failed" look the same and it does not matter.
    For 036 an empty fallback would assert *"this account never connected an agent"* — the exact
    wrong answer to the feature's headline question.
    *Rationale*: the panel renders **"Couldn't load agent detail."** on failure and
    **"No agent connections." / "No API tokens."** when genuinely empty; either way the other
    sections of the expanded row keep working (FR-012). Research R8.

## Flagged design gaps (Principle VI)

- **Design doc still describes the deployment-wide rollups as part of 036 (known,
  in-flight)**: Sam narrowed 036 to per-user-only on 2026-07-26 and is amending
  `design/agent-surface-mcp.md` in parallel to mark the rollup bullet deferred. Until the
  amended export lands via `design/sync.mjs`, the exported doc and this spec intentionally
  disagree; the controlling statement is Sam's direct instruction. Nothing to resolve here
  — recorded so the divergence is not mistaken for drift.
- **Activity-log coverage is narrower than "agent activity" reads (material — consider a
  design amendment)**: `agent_activity_log` rows are written only for
  delegation-authenticated MCP tool calls (`server/mcp/index.js` gates logging on
  `agentToken.delegationId`; writer is `logAgentAction` in
  `server/mcp/auth/delegation.js`, whose `delegation_id` column is NOT NULL).
  `sk_sqd_`-token tool calls, REST export/import traffic, and claim-minted-token usage
  never appear in the log. The design names this log as the activity source, so the spec
  follows it — but requires the per-user summary to be labeled honestly (FR-006) and leans
  on the credentials' own `last_used_at` timestamps for the token-path usage signal (which
  ARE maintained on token auth — verified in `server/mcp/auth/api-tokens.js`). Two
  follow-ups for Sam: (a) fold the coverage boundary into the design's 036 amendment;
  (b) optionally, a follow-on feature to log token-authenticated activity — explicitly out
  of scope here (it would add a write path).
- **Activity-log metadata can embed tool arguments/user content**: the logger records
  `metadata: { args }` verbatim. Not a design contradiction, but worth noting: the spec
  keeps metadata payloads out of every admin response (Key Entities, Out of Scope) — the
  per-user summary reads a count and a timestamp only.
- **"Where they stand in onboarding" is not itemized in the design**: the per-user bullet
  names the concept but not the fields; Sam's scope instruction fixes them
  (signup_source, onboarded_at, authored-a-real-doc, welcome-email sent) and decision 7
  records the welcome-email inclusion. Worth itemizing in the design's 036 amendment —
  not blocking.
- **Schema note (informational, no design change)**: the dev DB's `agent_activity_log`
  contains only 2025-era rows with retired action names (`tool:get_document`,
  `tool:update_document`) — irrelevant to the count+timestamp summary but confirmation
  that action-name vocabulary drifts across releases, should the deferred rollup feature
  later display top actions. Also `agent_delegations` carries
  `refresh_token_version`/`refresh_token_expires_at` and `registered_agents` carries
  `allowed_redirect_uris`/`updated_at` beyond the feature brief's schema sketch; none are
  needed or exposed by 036. A token whose mint-parent was deleted has its mint-parent
  reference nulled (FK `ON DELETE SET NULL`), so it would display as interactively
  minted — accepted imprecision (spec Edge Cases).

## Plan-phase addendum to the design-gap list (2026-07-26, re-checked at plan time)

- **Gap 1 — CLOSED.** The design amendment has landed in `design/agent-surface-mcp.md`: the
  rollup bullet now reads "**Deployment-wide rollups — DEFERRED (Sam, 2026-07-26)**", so the
  export and this spec no longer disagree. The spec-phase entry above is kept for history; it is
  no longer an open divergence.
- **Gap 2 — (a) CLOSED, (b) still open.** The design now carries the paragraph "What the
  activity signal actually covers (found while speccing 036)", stating the delegation-only
  coverage, the honest-labelling requirement and the token `last_used_at` fallback — exactly the
  amendment that was owed. Follow-up (b), logging token-authenticated activity, remains an
  optional follow-on feature and is still out of scope for 036.
- **Gap 4 — CLOSED.** The design's per-user bullet now itemises the onboarding fields
  (`onboarded_at`, authored-a-doc-beyond-the-welcome-doc, `signup_source`, welcome-email sent),
  matching FR-005 field for field.
- **Gaps 3 and 5** were informational and remain accurate; nothing owed.

## New follow-on ticket found at plan time (out of 036's scope)

- **`GET /mcp/auth/delegations/:userId` discloses `refresh_token_hash` to the delegation's own
  owner.** `delegation.listUserDelegations()` is `SELECT * FROM agent_delegations` and
  `server/mcp/index.js` passes the rows straight to `res.json()`. Self-only exposure (the route
  403s for any other user), so not an escalation path, but a credential-equivalent value is
  crossing a network boundary for no reason. 036 deliberately does **not** touch it: the fix
  belongs on the user-facing MCP routes, outside this feature's tight-diff constraint, and 036
  avoids the helper entirely rather than inheriting the problem (research R2). Recorded here so
  it is not lost.
