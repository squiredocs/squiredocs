# Promotion notes — 034-auth-ip-capture

What this feature leaves owed to the merge queue, the design docs, and the
deploy. Nothing here blocks the merge; everything here needs an owner.

## Owed to the Squire design docs (constitution Principle VI)

The implementation adopted the spec's flagged defaults verbatim. Three gaps in
`design/authentication-and-sharing.md` → "Abuse signals: signup/login IP +
user-agent" remain open and want one amendment pass in the Squire doc (never
hand-edit `design/`):

- **G-1 — `auth_events.signup_source` semantics for `login` rows.** Implemented
  as the auth CHANNEL of *this* event (`browser` | `agent_oauth`), not a copy of
  how the account was born; dev-login records `browser`. Asserted by
  `server/auth/__tests__/auth-events.test.js`. If the doc is amended, consider
  renaming the column to `channel` — that would be a follow-on migration.
- **G-2 — purge mechanism/cadence.** Fixed by RBD-8 as an in-process boot sweep
  plus a daily `setInterval` owned by `server/auth/auth-events.js`, `.unref()`ed,
  with `stopPurgeJob` wired into the shutdown drain. The doc should state the
  cadence (daily) so a future reader does not assume a scheduler exists.
- **G-3 — failed authentication attempts.** Explicitly NOT recorded; capture
  lives in the post-verification user-store helpers, and failed-attempt telemetry
  stays an edge/WAF concern. One clarifying sentence in the doc would close it.

## Owed to the merge-queue docs pass (Principle I)

This feature's agents may not edit `README.md`, `docs/dev.md`, or `CLAUDE.md`.
The change adds a table and four columns, so if either doc enumerates the schema
or describes auth behavior, it needs:

- `auth_events` (append-only signup/login trail, 180-day retention) added to any
  schema list;
- the four `users` columns (`signup_ip`, `signup_user_agent`, `last_login_ip`,
  `last_login_user_agent`) added to any `users` description;
- a mention that the app runs one in-process background job (the auth-event
  purge) if background work is documented anywhere.

## Deploy dependency (SC-006)

The privacy-policy disclosure (`client/src/pages/PrivacyPage.jsx`, "Usage and log
data" + "Data Retention", `LAST_UPDATED` → July 25, 2026) MUST ship **before or
in the same deploy as** the capture. It is in this same change set, so a single
deploy of this branch satisfies it — but do not cherry-pick the server half
without the client half.

`PrivacyPage.jsx`'s header comment now says the disclosure must track the 034
capture behavior; if retention or scope changes, that paragraph changes with it.

## Follow-on the data exists to serve

The detector / correlation UI is explicitly out of scope. The
`auth_events_ip_created_at_idx` index (RBD-6) and the trail itself exist for it:
shared-IP grouping across accounts and the exhaust-grant-then-respawn relay
pattern. `auth_events` currently has **no HTTP surface at all** — it is
SQL-only. The follow-on will need one, and that endpoint must stay admin-gated.

## Deviations and judgment calls made during implementation

1. **Zone-ID guard in `authContext` (beyond the contract).** The contract said
   validate with `net.isIP()`. That is *not sufficient*: Node's `net.isIP`
   returns `6` for `fe80::1%eth0`, but Postgres rejects it — `invalid input
   syntax for type inet` — which would have thrown inside the auth statement,
   exactly the FR-008 failure the validation exists to prevent. `extractIp` now
   also drops any value containing `%`. Caught by the T004 unit test before it
   could reach a real sign-in.
2. **Defensive `.catch()` on the trail write in `updateLastLogin`.** `record()`
   already swallows its own failures (contract C3). The extra `.catch()` is one
   line of belt-and-braces so a future change inside `auth-events.js` cannot
   leak a rejection into the sign-in path. Tested by mocking `record` to reject.
3. **`server/api/__tests__/admin.test.js` was left untouched.** It already mounts
   the admin router behind the real `requireAdmin`; the new exposure assertions
   live in the new `server/__tests__/admin-auth-capture.test.js` per the plan.
4. **Migration applied only to the per-agent test database.** T002 asks for the
   dev database too; this agent works in an isolated worktree and deliberately
   did not touch the shared dev DB (`collab_db`) or the shared `collab_test_db`.
   The merge queue must run `npm run migrate` against dev/prod as usual. The
   migration was verified end to end (`\d+ auth_events`, `\d users`) on
   `collab_test_db_034`, including both CHECKs, the FK `ON DELETE CASCADE`, and
   all three indexes, and `node-pg-migrate` accepted the timestamp ordering.

## Pre-existing failure the merge queue will see (NOT from this feature)

`npm run test:server` on this branch reports **220 suites, 3734 passed, 1
failed**. The one failure is
`server/__tests__/agents-md-claims.test.js › (g) tells in-session agents not to
run the connect command themselves`: the drift-guard expects
`/do not run\s+the command above yourself/i`, but `client/public/agents.md:37`
says "do not run **either** command above yourself" (the copy was widened to
cover the plugin one-liner and the raw one-liner, and the guard was not updated).

Both the test file and `client/public/agents.md` are **byte-identical to `main`**
on this branch — this feature touches neither — so the failure reproduces on
`main` and is not a 034 regression. Fixing it is a one-word change to the regex
(or the doc) and belongs to whoever owns the agents.md copy, not here.

Client suite: **64 suites, 772 passed, 0 failed**. `npm run build` (client):
clean.

## Not done here (by design)

- No backfill of historical accounts (FR-014) — pre-feature rows stay NULL and
  the admin table renders `—`.
- No change to `app.set('trust proxy', …)` (FR-006). `server/__tests__/trust-proxy-invariant.test.js`
  fails if anyone later switches it to blanket `true`, which would make every
  captured address forgeable via `X-Forwarded-For`.
- No retention-period setting, no detector queries, no WAF/edge changes.

## Manual verification still owed (Sam)

- Browser walk of the admin page: the two new columns at real table width, the
  hover title, and the `Sign-in origin` block in the expanded row, in both light
  and dark themes.
- `/privacy` renders the new paragraph and the updated "Last updated" date.
- The `quickstart.md` §3 dev-login walk against a running server (this branch was
  verified through the suites, not through a live server).
