# Phase 0 — Research: Admin Per-User Agent Connection & Onboarding Detail (036)

Every decision below was taken against code read on 2026-07-26 (`server/api/admin.js`,
`client/src/pages/AdminPage.jsx`, `server/mcp/auth/{delegation,api-tokens}.js`,
`server/mcp/index.js`, `server/onboarding.js`, `migrations/`). Behaviour is cited, never line
numbers — both admin files are under concurrent edit by other agents and any line number in
this document would be stale before it is read.

---

## R1 — One endpoint for the whole per-user payload, not four

**Decision**: a single `GET /api/admin/users/:userId/adoption` returns
`{ delegations, tokens, onboarding, activity }`.

**Rationale**: the expanded row already has two precedents and they disagree about granularity
only superficially. `GET /users/:userId/extra-credits` returns one collection because the
credits panel *is* one collection. `GET /users/:userId/sharing` returns **two** unrelated
collections (`invites`, `shares`) in one response because they make up **one panel**, fetched
with one call, one loading flag, one `.catch()`. 036 is the sharing case, larger: four blocks,
one panel, one question ("did this account get anywhere?"). One endpoint means one fetch on
expand (FR-007), one failure mode to isolate (FR-012), and one response shape for the
secret-material assertion to cover exhaustively (FR-009) — four endpoints would mean four
places for a `SELECT *` to creep back in.

**Alternatives considered**:

- *Four endpoints* (`/delegations`, `/tokens`, `/onboarding`, `/activity`): four round trips on
  every expand, four loading flags, four catch blocks, and a partially-rendered panel as the
  default failure mode. Rejected — chattier than the precedent, no independent consumer.
- *Fold into `GET /users`*: forbidden by FR-007 (must not bulk-load) and would multiply the
  list query by per-user credential lists nobody may look at.

**Naming**: `adoption` (not `agent-access`) because the payload carries onboarding and activity
as well as credentials, and because it is the design document's own word for this surface
("Admin visibility: adoption and connection state"). The deferred deployment-wide rollups get a
clean sibling path (`/api/admin/adoption`) if they are ever picked up. Recorded as RBD-8.

---

## R2 — Explicit column lists; the existing list helpers are NOT reusable

**Decision**: the handler issues its own parameterised queries with explicit column lists. It
does **not** call `delegation.listUserDelegations()` or `apiTokens.listUserTokens()`.

**Rationale**: two independent disqualifiers each.

`listUserDelegations()` (`server/mcp/auth/delegation.js`):

1. it is `SELECT * FROM agent_delegations` — the row therefore carries `refresh_token_hash`,
   exactly the field FR-009 forbids. (Note in passing: its one existing consumer,
   `GET /mcp/auth/delegations/:userId` in `server/mcp/index.js`, hands that row straight to
   `res.json()`, so a user can already read the hash of *their own* refresh token. Pre-existing,
   self-only, strictly out of 036's scope — flagged as a follow-on in the ledger, not fixed here.)
2. it filters revoked/expired rows out by default, which is the opposite of FR-003's lifetime
   semantics.

`listUserTokens()` (`server/mcp/auth/api-tokens.js`) has a safe column list but likewise filters
to active tokens only, and omits `revoked_at` and both `minted_by_*` columns that FR-002/FR-003
require.

Widening either helper to serve the admin case would change behaviour on the user-facing MCP
routes that consume them — a bigger, riskier diff than four self-contained queries in the admin
handler, and one that pushes a `refresh_token_hash`-bearing row into more places rather than
fewer. **`SELECT *` is banned in this feature by rule, not by taste**: the tables involved carry
`token_hash`, `refresh_token_hash` and `client_secret_hash`, so an explicit column list is the
structural guarantee behind FR-009, and the response builder is a literal object with named keys
(the style `admin.js` already uses everywhere) so a later column addition cannot silently
serialise itself.

---

## R3 — Credential state is derived server-side, once

**Decision**: each delegation and token carries a single `state` field, `'active' | 'revoked' |
'expired'`, computed in the handler as: `revoked_at` set → `revoked`; else `expires_at` set and
`<= now()` → `expired`; else `active`. Raw `revokedAt` / `expiresAt` / `createdAt` /
`lastUsedAt` timestamps ship alongside it.

**Rationale**: precedent — `GET /users/:userId/extra-credits` already derives `isExpired` and
`isDepleted` server-side and the client only picks a badge class. Deriving state once, on the
server, makes it directly assertable in the backend suite (SC-006) and keeps the client a pure
renderer. Revoked wins over expired because a revoked credential is revoked whatever its expiry
says. Evaluation is against request time, which the spec's Edge Cases already accept as
boundary-tolerant.

**Alternatives considered**: shipping raw timestamps and letting the client decide — rejected,
it puts the security-relevant "is this live?" judgement in two places and makes the invariant
untestable from the backend suite.

---

## R4 — Mint path: derived label plus the two parent ids

**Decision**: each token carries `mintedBy: 'agent' | 'interactive'` plus the nullable
`mintedByDelegationId` and `mintedByApiTokenId`.

**Rationale**: FR-002 needs the label; the ids are what let the admin *tie* an agent-minted
token to the delegation shown three rows above it in the same payload, which is the whole point
of putting both lists in one panel. They are internal row ids, not credential material (the
delegation id is already visible to the user themselves on the MCP auth routes), and this
surface is admin-only. Rule: `mintedBy = (minted_by_delegation_id || minted_by_api_token_id) ?
'agent' : 'interactive'` — matching FR-003 exactly, including its accepted imprecision that a
token whose parent row was hard-deleted (`ON DELETE SET NULL`, per
`1792000000000_add-minted-by-to-mcp-api-tokens.js`) reads as interactively minted.

---

## R5 — Agent display name: registry join with self-reported fallback

**Decision**: `LEFT JOIN registered_agents ra ON ra.id = d.agent_client_id`, and
`agentName = ra.name || d.agent_name`. The response also carries the nullable `agentClientId`
so the UI can show which catalog entry (if any) backed the name.

**Rationale**: FR-004 verbatim. `agent_client_id` is nullable by design (migration 011:
"NULL for legacy delegations"), and dynamically-registered clients (RFC 7591) may have no
catalog row at all — a `LEFT JOIN` is what keeps those rows in the list instead of dropping
them. The join reads at most one row by primary key.

**Security note carried into the plan**: `agent_name` and `agent_id` are **self-reported by the
OAuth client at registration/consent time** — attacker-controlled strings, exactly like the
user-agent that feature 034 surfaced on this same page. Token `name` is user-supplied. All three
must be rendered as React text children (auto-escaped) and never through
`dangerouslySetInnerHTML`, and never interpolated into SQL. The 034 comment in `AdminPage.jsx`
already states the rule for user-agents; 036 repeats it for these fields.

---

## R6 — Activity summary: one aggregate query, honestly labelled

**Decision**: `SELECT COUNT(*)::int, MAX(created_at) FROM agent_activity_log WHERE user_id = $1`,
returned as `{ count, lastActivityAt }`. `metadata` is never selected. The UI heading names what
the number measures.

**Rationale**: index-served by `idx_agent_activity_user_time` (`(user_id, created_at)`, migration
010); one row out regardless of log size; no window parameter to invent (RBD-4).

The labelling half is not cosmetic. Verified in code (2026-07-26) and now stated in the design
document itself: `agent_activity_log.delegation_id` is `NOT NULL` and `server/mcp/index.js`
writes a log row only when the authenticated principal carries a `delegationId`, so
`sk_sqd_`-token tool calls, REST export/import traffic and claim-minted-token usage **never**
appear in this table. A user who works exclusively through API tokens shows `count: 0` while
their token `lastUsedAt` shows this morning. Presenting that zero as "agent activity" would be a
false negative on the exact question the feature exists to answer. Therefore:

- the field name is `count`, under an `activity` object documented as OAuth-delegated MCP calls;
- the UI heading is **"Agent sessions (OAuth-delegated MCP calls)"**, with the sub-note
  *"API-token and REST traffic are not logged — see each token's Last used."*;
- the token table's `Last used` column is the token-side signal and sits in the same panel.

`metadata` records `{ args }` verbatim — raw tool arguments, i.e. user content — so it is
excluded at the SQL level, not at serialisation. Nothing to filter is the only reliable filter.

---

## R7 — "Authored a real document": list-ownership, in the same query, with a stated divergence

**Decision**: a SQL `EXISTS` over `document_shares` (`role = 'owner'`, excluding
`users.welcome_doc_id` when it is set), evaluated as one more expression on the onboarding row
read — no second round trip.

**Rationale**: the spec's Assumption pins this to "the same ownership notion the admin user
list's existing doc count uses", and that notion is exactly `document_shares` with
`role = 'owner'` (the `docCount` sub-select in `GET /users`). Same definition on the same page,
so two numbers in one row cannot contradict each other.

**Known, deliberate divergence — RBD-10.** `server/onboarding.js` `isEngaged()` (exported)
answers a *stricter* question: it additionally joins `yjs_updates`, so a document with no
persisted content does not count, and that stricter predicate is what stamps `onboarded_at`.
036 therefore can show "owns a document besides the welcome doc: yes" while
`onboardedAt` is still null (an empty doc was created and never typed into). This is not a bug
and it is not hidden: **both** fields are displayed, and the row is labelled *"Owns a doc
besides the welcome doc"* rather than "engaged" or "activated". Reusing `isEngaged()` was
considered and rejected — it would contradict the spec's stated assumption, disagree with the
`Docs` column right above it, and cost an extra query for a distinction the admin can already
see by reading the two adjacent fields.

Fallback case (spec Edge Cases): when `welcome_doc_id IS NULL` (cleared, or never seeded — the
normal state for `agent_oauth` signups) the exclusion drops and any owned document counts.
Accepted imprecision at beta scale.

---

## R8 — Failure isolation and the not-found path

**Decision**: the client fetches the adoption payload with its own `.catch()` that sets an error
sentinel for this panel only; a rejected adoption fetch leaves the sharing, extra-credits,
sign-in-origin and (post-035) assistant-model sections rendered and interactive (FR-012). The
server returns `404` when no `users` row matches, and `404` (not `500`) for a syntactically
invalid `:userId`, guarded by a UUID-shape check before the query — otherwise Postgres raises
`22P02` and the admin gets an error page for a typo (RBD-11).

**Rationale**: `toggleExpand` already runs its two fetches independently, each with its own
`.catch()` falling back to an empty value; 036 adds a third in the identical shape. The one
deviation: extra-credits/sharing fall back to *empty*, which for those panels is
indistinguishable from "genuinely empty". For 036 an empty fallback would read as "this user
never connected an agent" — a wrong answer to the feature's headline question. So the adoption
panel distinguishes **loaded-and-empty** ("No agent connections or API tokens.") from
**failed-to-load** ("Couldn't load agent detail.") — RBD-12.
