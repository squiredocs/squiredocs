# Phase 0 Research: Signup/Login IP + User-Agent Capture

**Feature**: 034-auth-ip-capture | **Date**: 2026-07-25

All findings below are verified against the working tree at commit `054bcbf` (2026-07-25). No `NEEDS CLARIFICATION` markers survived the spec phase — the open *product* decisions were fixed by design ground truth and recorded as RATIFIED-BY-DEFAULT in `clarifications-needed.md`. What follows is the *technical* decision set the plan needed.

## Verified code reality (the facts the design rests on)

| Fact | Location | Verified |
|------|----------|----------|
| `findOrCreateUser({googleId,email,name,picture}, {signupSource})` — single atomic upsert, `RETURNING *, (xmax = 0) AS is_new`, sets `user.isNew` | `server/auth/users.js:51-78` | ✅ |
| `signup_source` is written **only** in the INSERT column list, deliberately absent from `ON CONFLICT DO UPDATE SET` — the exact once-only pattern the signup pair needs | `server/auth/users.js:56-66` | ✅ |
| `updateLastLogin(userId)` — single `UPDATE users SET last_login_at = now()` | `server/auth/users.js:199-201` | ✅ |
| Exactly three `findOrCreateUser`/`updateLastLogin` call-site pairs, all post-verification | `server/auth/routes.js:311/322` (shared `completePostAuth`, covers browser OAuth **and** agent OAuth — `signupSource` is derived from a valid `returnTo`), `:606/612` (dev-login legacy fixed user), `:668/669` (dev-login fresh JSON) | ✅ |
| Dev-login "fresh browser" mode does **not** add a fourth pair — it delegates to `completePostAuth` | `server/auth/routes.js:~602` | ✅ |
| `completePostAuth(res, {profile, clientUrl, rawReturnTo})` deliberately has **no** `req` parameter — feature 031's ratified structural invariant U2/INV-3 depends on it ("NEVER reads `req.query`/`req.body`/headers — `completePostAuth` does not even receive `req`, so the auto-issue parameters cannot originate from any client-modifiable post-auth channel"). It has exactly two callers: the Google callback and dev-login fresh-browser mode | `server/auth/routes.js:220, 232-236, 307, 664` | ✅ (drove contract C4a) |
| Token refresh calls **neither** helper — FR-005 holds by construction, not by a guard | grep over `server/`: only the three pairs above | ✅ |
| `app.set('trust proxy', Number(process.env.TRUST_PROXY_HOPS ?? 1))` — numeric, prod `2` | `server/index.js:135` | ✅ |
| An IP extractor already exists but is **not** named `getClientIp` — it is `clientIp(req)`, exported from `server/rate-limit.js:213`, and it returns the string `'unknown'` when nothing resolves | `server/rate-limit.js:106-110, 208-217` | ✅ (correction to the assignment brief) |
| `GET /api/admin/users` returns `created_at`/`last_login_at` from an explicit column list, mapped field-by-field | `server/api/admin.js:134-190` | ✅ |
| `GET /auth/me` returns an explicit **whitelist** of eight fields — new `users` columns cannot leak through it | `server/auth/routes.js:492-501` | ✅ |
| `PATCH /auth/me` likewise returns a four-field whitelist | `server/auth/routes.js:532-539` | ✅ |
| Admin users table renders 9 columns with `colCount = 9` and an expandable detail row (`colSpan={colCount}`) | `client/src/pages/AdminPage.jsx:253, 357-367, 441-443` | ✅ |
| Privacy policy anchor: `<h3>Usage and log data</h3>` paragraph; `LAST_UPDATED = 'July 24, 2026'`; a separate `<h2>Data Retention</h2>` section exists | `client/src/pages/PrivacyPage.jsx:13, 67-75, 168-176` | ✅ |
| Latest migration is `1799300000000_add-signup-source-to-users.js`; `pgm.createTable` convention uses `bigserial` PK + `references: 'users', onDelete: 'CASCADE'` + `timestamptz default pgm.func('now()')` | `migrations/`, `migrations/1796000000000_create-agent-edits.js:24-52` | ✅ |
| Backend Jest runs `--runInBand` against the shared test DB; pools come from `server/__tests__/helpers/db.js` (`createPool`, honors `DATABASE_URL`) | `package.json:14`, `server/__tests__/helpers/db.js` | ✅ |
| No general scheduler: `server/lifecycle.js` is init/drain flags only; existing `setInterval`s are feature-local and cleared by their owners | `server/lifecycle.js`, `server/index.js:2022/2081` | ✅ |
| Graceful shutdown is `createShutdown(deps)` with injected, individually-guarded dependencies | `server/shutdown.js:36-60`, `server/index.js:2286-2298` | ✅ |

---

## R1 — Where does the `auth_events` row get written?

**Decision**: `updateLastLogin(userId, { ip, userAgent, signupSource, isNew })` writes **the** event for that authentication, choosing `event = isNew ? 'signup' : 'login'`. `findOrCreateUser` writes only the `users` signup columns and appends nothing.

**Rationale**: The spec's own independent test for US2 is decisive — "perform a signup and two logins … confirm **three** trail entries exist". Every auth path calls `findOrCreateUser` *and then* `updateLastLogin` on the same request, so if each helper appended its own row, a signup would produce two rows (`signup` + `login`) and the count would be four, not three. Concentrating the append in the second helper — which is called exactly once per completed authentication, on every path, and never by token refresh — makes "exactly one event per completed auth" true by construction rather than by coordination. `isNew` is already computed by `findOrCreateUser` (`xmax = 0`) and is free to forward.

**Alternatives considered**:
- *Split: `findOrCreateUser` appends `signup` when `isNew`, `updateLastLogin` appends `login` when not new.* Rejected: `updateLastLogin` has no way to know `isNew` without being told, so the parameter is needed anyway — and the invariant then lives in two places that must agree.
- *Append at the three call sites in `routes.js`.* Rejected: violates FR-004's "flow through the same two shared user-store helpers", and triples the number of places a future fourth auth path could forget.

**Cost**: the function name `updateLastLogin` now also emits a `signup` event. Documented in its JSDoc; renaming it is a refactor the assignment explicitly excludes. Recorded as **RBD-7**.

## R2 — How is the address validated before it reaches an `inet` column?

**Decision**: `authContext(req)` derives the address as `req.ip || req.socket?.remoteAddress || null`, strips nothing, and returns it **only if `require('node:net').isIP(value) !== 0`** — otherwise `null`.

**Rationale**: This is the one place where capture could actually break authentication. The `users` snapshot write shares the auth path's `INSERT`/`UPDATE`; if a non-address string reached an `inet` parameter, Postgres would raise `invalid input syntax for type inet` and take the whole statement — i.e. the signup — with it. FR-008 forbids that. `net.isIP()` is Node core, exact, and accepts precisely what Postgres `inet` accepts for the shapes Express produces, including the dual-stack `::ffff:127.0.0.1` form (returns `6`). It rejects the empty string, `'unknown'`, and zone-suffixed link-local forms like `fe80::1%eth0` — all of which become `NULL`, which is the specified behavior for "unavailable or unparsable client address".

**Alternatives considered**:
- *Reuse `clientIp(req)` from `server/rate-limit.js` directly.* Rejected as the sole source: it returns the literal string `'unknown'` as a rate-limit bucket key, which is correct there and a poisoned `inet` value here. The extractor may share the `req.ip || req.socket?.remoteAddress` derivation, but the `'unknown'` fallback must not survive into storage.
- *Let Postgres validate and rely on the try/catch.* Rejected for the `users` snapshot specifically: it is inside the auth statement, so "catch it" means "the signup already failed".
- *Cast defensively in SQL.* Rejected: no clean total `text → inet` cast exists without an exception handler; JS-side validation is simpler and testable without a database.

## R3 — How is the per-account snapshot written?

**Decision**: fold the two capture columns into the statements that already run.

- `findOrCreateUser`: extend the INSERT column list with `signup_ip, signup_user_agent`; **do not** add them to `ON CONFLICT DO UPDATE SET`.
- `updateLastLogin`: extend the existing statement to `UPDATE users SET last_login_at = now(), last_login_ip = $2, last_login_user_agent = $3 WHERE id = $1`.

**Rationale**: Zero extra round trips, and the once-only guarantee for the signup pair is enforced by the *same* SQL mechanism that already guarantees it for `signup_source` (feature 029, RBD-10) — a mechanism this repo has already reviewed and shipped. FR-001's "including logins that pass through the same create-or-find code path" is then a property of the query, not of a code branch that could be reordered later.

**Note on acceptance scenario US1-1** ("the same values appear as its initial last-login values"): satisfied without special-casing, because every path calls `updateLastLogin` immediately after `findOrCreateUser` on the same request with the same context.

**Alternatives considered**: a separate `UPDATE` after the upsert (extra round trip, extra failure mode); a `COALESCE(signup_ip, $n)` in the conflict branch (would backfill pre-feature rows on next login, contradicting FR-014's "signup fields remain permanently absent").

## R4 — Purge mechanism (design gap G-2)

**Decision**: in-process, owned by `server/auth/auth-events.js`:

- `purgeOlderThan(days = 180)` → one `DELETE FROM auth_events WHERE created_at < now() - ($1 || ' days')::interval`, returning the row count, supported by the `created_at` index.
- `startPurgeJob({ intervalMs = 24h, days = 180 })` → runs one sweep on boot (non-blocking, errors logged not thrown) and schedules the daily interval; the timer is `.unref()`ed so it can never hold the process open during a drain.
- `stopPurgeJob()` → `clearInterval`, exported both for tests and for the shutdown path.

`server/index.js` calls `startPurgeJob()` once after the pool/users init, and passes `stopBackgroundJobs: stopPurgeJob` into `createShutdown(...)`. `server/shutdown.js` gains an **optional** dep invoked inside the existing guarded-step style, so every current call site (and every existing shutdown test) is unaffected when it is absent.

**Rationale**: FR-010 asks for "removal within roughly a day of becoming eligible" — a boot sweep plus a daily tick satisfies it with two `setInterval`-shaped lines and no new dependency, no cron, no k8s CronJob, no leader election. The repo has no scheduler to hook into and Principle III explicitly rejects adding ceremony without a concrete failure it prevents. Multiple replicas each running the purge is harmless: the `DELETE` is idempotent and set-based, and duplicate work costs one indexed no-op query per replica per day.

**Alternatives considered**: a Kubernetes `CronJob` (new infra artifact, new image entrypoint, new secret plumbing, for one `DELETE`); `pg_cron` (not installed; a database extension for a 180-day sweep is disproportionate); purge-on-write (turns every login into a delete scan). All rejected as heavier than the requirement. Recorded as **RBD-8**; G-2 stays flagged for the Squire doc.

## R5 — Admin surface shape

**Decision**: two new **columns** in the main row — `Signup IP` and `Login IP` (`colCount` 9 → 11) — plus a `Sign-in origin` block in the existing expandable detail row carrying all four values, with the full, untruncated user-agent strings. Absent values render as the table's existing `—` placeholder.

**Rationale**: SC-001 requires a spray to be recognizable "from the admin user list alone in under one minute", which requires the addresses to be *visible without interaction* — hence real columns. User-agents are 100–300-character strings; putting them in table cells would destroy a 9-column layout for the one signal that is only useful once you are already looking at a specific pair of accounts. The expandable row already exists and is already the place per-user detail lives (trusted toggle, sharing activity, extra credits), so the UA lands there at zero structural cost. The IP cells additionally carry the matching UA as a `title` tooltip so hover gives the fingerprint without expanding.

**Alternatives considered**: all four as columns (13 columns, unreadable); everything in the detail row only (fails SC-001's at-a-glance requirement); a dedicated abuse-signals page (that is the explicitly out-of-scope follow-on detector).

## R6 — Guarding the trust-proxy invariant (FR-006)

**Decision**: add a cheap, dependency-free assertion test (`server/__tests__/trust-proxy-invariant.test.js`) that reads `server/index.js` and asserts the `trust proxy` setting is a `Number(...)` expression and that the literal `trust proxy', true` / `trust proxy", true` form is absent.

**Rationale**: FR-006 is the requirement that makes every other requirement in this feature meaningful — if `trust proxy` ever becomes `true`, `req.ip` becomes the first entry of an attacker-supplied `X-Forwarded-For` chain and all four columns plus the whole trail become forged-on-demand. The assignment says "add a test or assertion only if cheap", and this one is: a source-level assertion needs no server boot, no socket, no DB, and runs in milliseconds. A behavioral test (booting Express behind two fake proxies and forging headers) would be the stronger check but needs real listeners and is disproportionate for a value set on one line.

**Alternatives considered**: a runtime boot-time `console.warn` (does not fail anything, so it does not prevent the regression); a full supertest behavioral test (correct but not cheap); nothing at all (the invariant is the feature's foundation — worth one file).

---

## Open items carried forward (not resolved here)

- **G-1** (`auth_events.signup_source` semantics for `login` rows) — spec default kept: it records the channel of *this* event, same value domain as `users.signup_source`, dev-login records `browser` (matching what its call site already passes). Squire-doc amendment owed.
- **G-2** (purge cadence) — resolved at plan level by R4; Squire-doc amendment owed to state the mechanism.
- **G-3** (failed authentication attempts) — spec default kept: not recorded. Squire-doc amendment owed.
- **Owed docs pass** — `README.md` / `docs/dev.md` schema or auth descriptions may need a touch; out of this feature's agent scope (assignment override), flagged for the merge-queue docs pass.
