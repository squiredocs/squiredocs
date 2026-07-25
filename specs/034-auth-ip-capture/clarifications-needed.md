# Clarifications ledger — 034-auth-ip-capture (spec phase)

Per the parallel-agent rules: no user interaction; each open product decision got the best
default and is recorded here as **RATIFIED-BY-DEFAULT (Sam pre-authorized, 2026-07-25)**.
Overturn any of these by amending the spec before plan/implement consumes it.

Design ground truth: `design/authentication-and-sharing.md` — "Abuse signals: signup/login
IP + user-agent" + amended "Data model". Decisions 1–5 below restate what that section
already fixes (pre-authorized by Sam as the orchestrator's defaults); the Flagged design
gaps section lists the points the design leaves under-specified, with the default this spec
adopted for each.

## RATIFIED-BY-DEFAULT decisions

1. **Event log covers signup + login only; token refresh excluded** — RATIFIED-BY-DEFAULT
   (Sam pre-authorized, 2026-07-25).
   *Question*: which auth activities produce `auth_events` rows and last-login updates?
   *Why it matters*: refresh fires ~every 15 minutes per active session; logging it would
   multiply row volume by orders of magnitude and bury the human sign-in signal the feature
   exists to surface.
   *Rationale*: refresh is a background credential rotation, not a human sign-in; the design
   doc says explicitly it is "deliberately NOT logged". Spec: FR-003/FR-005.

2. **180-day `auth_events` retention; users columns kept for account lifetime** —
   RATIFIED-BY-DEFAULT (Sam pre-authorized, 2026-07-25).
   *Question*: how long is auth metadata kept?
   *Why it matters*: privacy exposure and table growth vs. correlation window for spray
   detection.
   *Rationale*: 180 days comfortably covers relay-spray correlation (the observed spray ran
   over minutes-to-days) while bounding PII retention; the denormalized per-account
   signup/last-login snapshot stays for the life of the account because it is the admin-list
   at-a-glance signal and is one row per user. Matches design. Spec: FR-010.

3. **User-agent truncated to 512 chars** — RATIFIED-BY-DEFAULT (Sam pre-authorized,
   2026-07-25).
   *Question*: bound on stored UA length?
   *Why it matters*: UA is attacker-supplied header data; unbounded storage invites bloat
   and abuse, over-tight truncation destroys the fingerprint value.
   *Rationale*: real-world UAs are < 300 chars; 512 keeps the full fingerprint with headroom
   and matches the design doc verbatim. Spec: FR-007.

4. **Admin-only exposure** — RATIFIED-BY-DEFAULT (Sam pre-authorized, 2026-07-25).
   *Question*: who can see captured IP/UA?
   *Why it matters*: IP + UA is personal data; any non-admin exposure is a privacy leak and
   tips off abusers that they are being fingerprinted.
   *Rationale*: the consumer is the admin investigating abuse — nobody else has a use for
   it. Never in public or agent-facing APIs. Matches design. Spec: FR-011/FR-012.

5. **No historical backfill** — RATIFIED-BY-DEFAULT (Sam pre-authorized, 2026-07-25).
   *Question*: do pre-existing accounts get values reconstructed?
   *Why it matters*: scope control; the only possible sources (edge logs) are outside the
   app and unreliable to join.
   *Rationale*: the data simply was not captured; fabricating it would be worse than NULL.
   Old rows stay NULL, last-login pairs fill organically on next login, admin UI renders
   absent values gracefully. Spec: FR-014.

## RATIFIED-BY-DEFAULT decisions added at plan time (2026-07-25)

6. **`auth_events` carries an `(ip, created_at)` index from day one** — RATIFIED-BY-DEFAULT
   (Sam pre-authorized, 2026-07-25).
   *Question*: does the correlation index ship with this feature or with the follow-on
   detector?
   *Why it matters*: adding it later costs a second migration; adding it now costs one line
   on a table that will hold thousands of rows.
   *Rationale*: the design names shared-IP grouping as the trail's entire purpose, and the
   spec calls day-one manual queries part of US2's value — this is exactly that query shape.
   Two other indexes are non-optional: `(created_at)` is mandated by FR-010, and `(user_id)`
   is required because Postgres does not auto-index FK columns, so without it every user
   delete sequentially scans the trail to cascade. Plan: `data-model.md` E2.

7. **The single `auth_events` row per authentication is written by `updateLastLogin`, not by
   `findOrCreateUser`** — RATIFIED-BY-DEFAULT (Sam pre-authorized, 2026-07-25).
   *Question*: which of the two shared helpers appends the trail row?
   *Why it matters*: every auth path calls both helpers on the same request. If each helper
   appended its own row, a signup would produce two rows (`signup` + `login`) and the spec's
   own US2 independent test — "a signup and two logins ⇒ three entries" — would fail.
   *Rationale*: `updateLastLogin` is called exactly once per completed authentication on
   every path and never by token refresh, so "exactly one event per completed auth" becomes
   true by construction. It receives `isNew` (already computed by `findOrCreateUser` via
   `xmax = 0`) and picks `event = isNew ? 'signup' : 'login'`. Cost: the function name now
   also emits `signup` events — documented in its JSDoc; renaming it is a refactor the
   assignment excludes. Plan: `research.md` R1, `contracts/user-store-and-capture.md` C2.

8. **Purge runs in-process: boot sweep + daily `setInterval`, `.unref()`ed, with an optional
   shutdown hook** — RATIFIED-BY-DEFAULT (Sam pre-authorized, 2026-07-25). Resolves design
   gap G-2 at plan level.
   *Question*: what actually runs the 180-day purge, given the repo has no scheduler?
   *Why it matters*: FR-010 requires automatic removal within roughly a day of eligibility;
   the alternatives (k8s CronJob, `pg_cron`) are new infrastructure for one `DELETE`.
   *Rationale*: `server/lifecycle.js` is init/drain flags only and existing `setInterval`s
   are feature-local, so the smallest thing that satisfies the requirement is one sweep at
   boot plus a daily tick owned by `server/auth/auth-events.js`. The timer is `.unref()`ed
   so it can never hold the process open during a drain, and `stopPurgeJob` is passed to
   `createShutdown` as a new **optional** `stopBackgroundJobs` dep (guarded no-op when
   absent, so existing shutdown call sites and tests are unaffected). Multiple replicas are
   harmless — the `DELETE` is set-based and idempotent. Plan: `research.md` R4,
   `contracts/user-store-and-capture.md` C3/C5.

## Flagged design gaps (constitution Principle VI — defaults adopted, doc amendment suggested)

- **G-1 — `auth_events.signup_source` semantics for `login` events.** The design lists the
  column but only names it after signup provenance; for a `login` row it is ambiguous whether
  it copies `users.signup_source` (how the account was born) or records the channel of *this*
  event. **Default adopted**: it records the auth channel of the event itself, same value
  domain as `users.signup_source` (`browser` | `agent_oauth`); the dev-only login bypass
  records `browser`, matching what its call site already passes to `findOrCreateUser` today.
  This keeps the column useful for correlation ("agent-driven logins from this IP") and
  needs no new value domain. Suggest the Squire doc name the intended semantics (and
  possibly rename the column, e.g. `channel`) when amended.

- **G-2 — Purge mechanism/cadence unspecified.** The design fixes *what* (180-day purge of
  `auth_events` only) but not *how often* or *by what*. The repo has no general scheduler
  (`server/lifecycle.js` is init/drain state only; existing `setInterval`s are
  feature-local). **Default adopted**: an in-process boot-time sweep plus daily interval
  (spec FR-010 phrases it behaviorally: removal within roughly a day of eligibility);
  concrete wiring is a plan-time choice.

- **G-3 — Failed authentication attempts.** The design says "every signup and login records
  ..." — implicitly *completed* ones, since capture lives in the post-verification
  user-store helpers, but it never says failures are excluded. **Default adopted**: only
  completed signups/logins are recorded; failed-attempt telemetry stays an edge/WAF
  concern. Suggest one clarifying sentence in the Squire doc.
