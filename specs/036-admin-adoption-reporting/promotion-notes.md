# Promotion notes — 036-admin-adoption-reporting

**Branch**: `036-admin-adoption-reporting` (worktree `agent-af1acd6890e59bbe4`, based on `main` @ `439a2be`)
**Status**: implementation complete, 19/20 tasks. T020's browser walk is owed (see below).

## What landed

One read-only endpoint and two panels in an expanded row that already existed.
No migration, no new module, no new dependency, no write path.

| File | Change |
|---|---|
| `server/api/admin.js` | NEW `GET /users/:userId/adoption` beside `GET /users/:userId/sharing` |
| `server/__tests__/admin-agent-adoption.test.js` | NEW — 31 tests |
| `client/src/pages/AdminPage.jsx` | third lazy fetch in `toggleExpand` + `Agent access` and `Onboarding` sections |
| `client/src/pages/AdminPage.css` | ONE additive rule: `.admin-status-revoked` |
| `client/src/pages/__tests__/AdminPage.test.jsx` | extended with a 10-test `describe` block |

## Gate results

- **Backend**: full suite green — see the final report for the exact suite/test counts from the
  run that gated this branch. New suite alone: **31 passed**.
- **Client**: `npm run test:client` (LLM reporter, per the constitution) — **64 suites, 794 passed**.
- **Build**: `npm run build` — green.

Backend runs used a dedicated `collab_test_db_036` (`DATABASE_URL` override) so nothing raced the
shared `collab_test_db`.

## The planning artifacts arrived late — and what that cost

`plan.md`, `research.md`, `data-model.md`, `contracts/` and `quickstart.md` were not committed
when implementation began; the branch was built from `spec.md`, `clarifications-needed.md` and the
design doc, against a reconstructed task list. When the real artifacts landed (`439a2be`) the
reconstruction was dropped and the implementation was reconciled to the contract in commit
`14eec2d`. **Everything below was found by that diff and is now contract-conformant** — but a
reviewer should read `14eec2d` closely, because it is the commit where divergence was corrected
rather than avoided.

| Contract says | Was built as | Resolution |
|---|---|---|
| `delegations[].agentClientId` (null = no catalog link) | `agentId` (self-reported) + derived `isRegistered` | Contract. `agentId` dropped entirely |
| `tokens[].mintedBy` | `mintPath` | Contract |
| `tokens[].mintedByDelegationId` / `mintedByApiTokenId` | omitted | Added |
| `onboarding.createdAt` | `signupAt` | Contract |
| `onboarding.authoredNonWelcomeDoc` | `authoredRealDocument` | Contract |
| UUID shape check *before* any query (RBD-11) | caught Postgres `22P02` after the fact | Contract. Same 404, but by construction |
| One `users` query with the `EXISTS` riding along | two queries | Collapsed into one |
| `500 "Failed to fetch agent adoption detail"` | `"…adoption detail"` | Contract |
| Two `.admin-detail-section` blocks **after** the existing sections | three blocks, before `Sharing activity` | Contract. Activity folded into `Onboarding` |
| `No agent connections.` / `No API tokens.` / `Couldn't load agent detail.` / the activity note | longer prose of my own | Contract, verbatim |
| `Owns a doc besides the welcome doc` | `Authored a real document` | Contract (RBD-10 — the label must not oversell the predicate) |
| `.admin-status-revoked` (one new rule) | revoked reused `.admin-status-expired` | Contract |
| Test file `admin-agent-adoption.test.js` | `admin-adoption.test.js` | Renamed |

**One change was reverted rather than kept.** While the sections were mis-placed I also added a
mobile override, two extra CSS rules, and a monospace token-prefix style. The plan allows exactly
one additive rule, so all of it was reverted — see the open observation below, which is the part
worth keeping.

## Owed work

1. **`README.md` line 33 (T018, merge-blocking for Principle I).** The Admin Area capability
   sentence enumerates "viewing user stats …, reviewing a user's sharing activity …, setting the
   shared assistant's default AI model, pinning a per-user model override …" and must gain the
   per-user agent connection / onboarding detail. `README.md` was off-limits to this agent.
   `docs/dev.md` was checked and owes nothing; `design/agent-surface-mcp.md` is already amended.
2. **T020 browser walk (Sam).** `quickstart.md` §3–§6 against the dev app: both user stories in a
   browser, SC-005 expand latency, visual density of the two credential tables in the expanded
   row, and dark-mode legibility of the new `.admin-status-revoked` badge. Not performed — this
   worktree has no running app and no browser. The automated half (leak scan, repeated-request
   write check, untrusted `agent_name` render) *is* covered by the suites.

## Observations for the merge queue

- **Pre-existing mobile cascade (NOT fixed here — deliberately).** In `AdminPage.css`'s
  `@media (max-width: 768px)` block, the card rules are written as `.admin-table tr` /
  `.admin-table td`, which also match the **nested** `.admin-credits-table` rows and cells. Each
  sub-row becomes its own card with its cells stacked — the opposite of the intent stated in that
  file's own comment ("The nested credit/sharing tables keep their tabular shape … so they scroll
  inside their own box"). This affects the existing sharing and extra-credit tables today; 036 adds
  two more tables to the same container, so it gets more visible without being caused by 036. A fix
  was written and then reverted, because the plan permits exactly one additive CSS rule and the fix
  changes the rendering of an already-merged feature. **Worth its own small ticket.**
- **Pre-existing, recorded in the plan's risk table**: `GET /mcp/auth/delegations/:userId` returns
  `SELECT *` rows including `refresh_token_hash` to the user themselves. Out of scope here and
  explicitly not copied into the admin payload. (Note `main` @ `83d1651` appears to address this —
  worth confirming the ledger entry is now closed.)
- **The activity number is a coverage boundary, not a bug.** `agent_activity_log` only records
  delegation-authenticated MCP calls, so a token-only user reads zero. The heading and note wording
  is what stops that being misread, and both are pinned by a test — a future copy tidy-up that
  drops them is a silent correctness regression, not a style change.
- `.admin-detail-note` comes from 035 and is reused, not redeclared, as the plan requires.

## Security posture

- No `SELECT *` anywhere in the feature; every query names its columns and every response field is
  an explicit literal. `refresh_token_hash`, `token_hash`, `client_secret_hash`,
  `agent_activity_log.metadata` and `agent_delegations.agent_metadata` are excluded **in SQL**.
- Leak assertions run three ways: by seeded literal value, by field name, and by shape (no
  64-character hex string, no `sk_sqd_` value longer than the stored 12-char prefix).
- The 403/401 tests mount the real `requireAdmin` exactly as `server/index.js` does, and a
  same-URL admin request asserts `200` so the 403 cannot be coming from a missing route.
- `SELECT`-only: a before/after snapshot across repeated requests asserts row counts and both
  `last_used_at` columns are unchanged, and `POST`/`PUT`/`PATCH`/`DELETE` on the path all 404.
