# Contract — `GET /api/admin/users/:userId/adoption`

Feature 036. **The only** interface this feature adds. Read-only; no companion write endpoint
exists or may be added (FR-010).

## Mounting and authorisation

Handler lives in `server/api/admin.js` on the module's existing router, beside
`GET /users/:userId/sharing` and `GET /users/:userId/extra-credits` whose shape it follows.
`server/index.js` mounts that router as `app.use('/api/admin', requireAdmin, admin.router)`, so
the gate is **mount-level and not restated in the handler** — the same arrangement every other
admin route relies on.

**Test consequence (FR-008, non-negotiable)**: any test asserting the 403 MUST mount the router
the way `server/index.js` does — `app.use('/api/admin', requireAdmin, admin.router)` — exactly as
`server/__tests__/admin-auth-capture.test.js` documents. Mounting `admin.router` bare (as
`admin-sharing.test.js` does) makes the 403 assertion vacuous: a bare router answers `200` to a
non-admin and the test still passes.

| Caller | Status |
|---|---|
| admin session/bearer | `200` |
| authenticated non-admin | `403` (from `requireAdmin`), empty of any adoption data |
| unauthenticated | `401` (from `requireAdmin`) |
| admin, unknown or malformed `:userId` | `404 { "error": "User not found" }` |
| admin, query failure | `500 { "error": "Failed to fetch agent adoption detail" }`, logged `[Admin] …` |

`:userId` is checked against a UUID shape before any query so a mistyped id yields `404` rather
than a Postgres `22P02` surfacing as `500` (RBD-11). The id is always passed as a bound
parameter — never interpolated.

## Response `200`

```jsonc
{
  "delegations": [
    {
      "id": "b0e1…",                         // agent_delegations.id
      "agentName": "Claude Code",             // registry name, else self-reported (FR-004)
      "agentClientId": "claude-code",         // nullable — null = no catalog link
      "scopes": ["documents:read", "documents:write"],
      "createdAt": "2026-07-01T09:12:00.000Z",  // ORIGINAL consent time (reused on re-consent)
      "lastUsedAt": "2026-07-25T18:03:11.000Z", // nullable
      "revokedAt": null,                        // nullable
      "expiresAt": null,                        // nullable
      "state": "active"                         // "active" | "revoked" | "expired"
    }
  ],
  "tokens": [
    {
      "id": "9c22…",
      "name": "sync laptop",                  // user-supplied, untrusted string
      "tokenPrefix": "sk_sqd_ab",             // non-secret prefix — the ONLY token identity
      "scopes": ["documents:read"],
      "createdAt": "2026-07-20T11:00:00.000Z",
      "lastUsedAt": null,
      "revokedAt": null,
      "expiresAt": "2026-08-20T11:00:00.000Z",
      "state": "active",
      "mintedBy": "agent",                    // "agent" | "interactive"
      "mintedByDelegationId": "b0e1…",        // nullable; correlates with delegations[]
      "mintedByApiTokenId": null              // nullable; correlates with tokens[]
    }
  ],
  "onboarding": {
    "signupSource": "browser",                // "browser" | "agent_oauth" | null (pre-029)
    "createdAt": "2026-06-30T08:00:00.000Z",
    "onboardedAt": null,                      // nullable — null = not yet
    "authoredNonWelcomeDoc": false,           // owns a doc other than the welcome doc
    "welcomeEmailSentAt": null                // nullable
  },
  "activity": {
    "count": 42,                              // ALL-TIME count of OAuth-delegated MCP calls
    "lastActivityAt": "2026-07-25T18:03:11.000Z"  // nullable when count === 0
  }
}
```

Both arrays are `[]` when the user has no such rows — never `null`, never an omitted key, never
an error (FR-012). `onboarding` and `activity` are always present for an existing user.

### Field-level rules

- **Every timestamp** is serialised as the driver's `Date` (JSON ISO-8601) or `null`. No
  formatting, no relative times — the client formats.
- **`state`** is derived server-side per research R3; the raw `revokedAt`/`expiresAt` ship too so
  the client can explain the badge without recomputing it.
- **`scopes`** passes through as the stored `text[]`; no reordering, no filtering.
- **Ordering**: `delegations` and `tokens` both newest-first by `createdAt`.
- **`activity.count`** is `::int` cast in SQL, so it is a JSON number, not a string.

## Forbidden by construction

The following MUST NOT appear anywhere in the response, in any casing, at any nesting depth —
and MUST NOT appear in any `SELECT` list that feeds it:

`token_hash` / `tokenHash` · `refresh_token_hash` / `refreshTokenHash` ·
`client_secret_hash` / `clientSecretHash` · any full `sk_sqd_…` value ·
`agent_activity_log.metadata` · `agent_delegations.agent_metadata`

Enforcement is structural, in this order:

1. explicit column lists in every query — **no `SELECT *`** (see research R2 for why the two
   existing list helpers cannot be reused);
2. explicit object literals in the serialiser — no spread of a database row;
3. a test that stringifies the whole `200` body and asserts none of the names above occur, that
   no seeded hash value occurs, and that no 64-character hex-shaped string occurs.

## Read-only guarantee

The handler executes `SELECT` statements only: no `UPDATE`, `INSERT`, `DELETE`, no view counter,
no `last_viewed_at` stamp, no audit row for the admin's own read. Repeating the request any
number of times leaves every table byte-identical (FR-011, SC-004), which the suite asserts by
comparing row counts and the delegations' own `last_used_at` before and after repeated calls.

## Client contract (`client/src/pages/AdminPage.jsx`)

- Fetched **only** on row expand, as a third independent call inside the existing
  `toggleExpand`, alongside the extra-credits and sharing fetches; cleared on collapse. Never
  requested from the list load (FR-007).
- Its own loading flag and its own `.catch()`. A rejection sets a *failed* sentinel — distinct
  from *loaded and empty* (RBD-12) — and must not disturb the other sections of the expanded
  row or the page (FR-012).
- Rendered inside the existing `.admin-detail` container as two new `.admin-detail-section`
  blocks, after the existing sections; the tables reuse `.admin-credits-table` and the badges
  reuse `.admin-status-badge` + `.admin-status-active` / `.admin-status-expired`, with one new
  additive `.admin-status-revoked` rule in `AdminPage.css`.
- **Required copy** (FR-006's honest labelling — the wording is part of the contract, not
  decoration):
  - section heading: `Agent access`
  - sub-headings: `Connected agents` · `API tokens`
  - activity heading: `Agent sessions (OAuth-delegated MCP calls)`
  - activity note: `API-token and REST traffic are not logged — see each token's Last used.`
  - empty states: `No agent connections.` · `No API tokens.`
  - failed state: `Couldn't load agent detail.`
  - onboarding row label: `Owns a doc besides the welcome doc` (**not** "engaged"/"activated" —
    it is a weaker predicate than `onboardedAt`; research R7)
- `agentName`, `agentClientId` and token `name` are attacker- or user-supplied strings and MUST
  be rendered as React text children only — never `dangerouslySetInnerHTML`, never a `title`
  built by string concatenation into markup. Same rule the 034 user-agent cells already carry.

## Non-goals restated here so a future editor cannot miss them

No revoke button, no mint button, no edit control, no CSV export, no charts, no per-event
timeline, no deployment-wide rollups, no pagination, no `?window=` parameter.
