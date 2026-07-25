---
description: "Task list: Signup/Login IP + User-Agent Capture (Abuse Signals)"
---

# Tasks: Signup/Login IP + User-Agent Capture (Abuse Signals)

**Input**: Design documents from `/specs/034-auth-ip-capture/`

**Prerequisites**: [plan.md](./plan.md), [spec.md](./spec.md), [research.md](./research.md), [data-model.md](./data-model.md), [contracts/](./contracts/), [quickstart.md](./quickstart.md) — all present.

**Tests**: **Mandatory, not optional.** The spec makes tests the acceptance mechanism for three requirements — SC-003 ("verified by tests simulating missing headers and capture-path storage errors"), SC-004 (purge boundary), SC-005 (non-admin surfaces) — and Constitution Principle II requires every behavioral change to be test-backed. Backend tests are Jest and MUST run serially (`--runInBand`) against the shared `collab_test_db`; the client test is Vitest.

**Organization**: grouped by user story in priority order. US1 (P1) is the MVP — capture written and visible to an admin. US2 (P2) adds the durable trail plus retention. US3 (P3) adds the robustness and disclosure guardrails.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: parallelizable — different file, no incomplete dependency.
- **[Story]**: US1..US3; Setup / Foundational / Polish carry no story label.

## Overrides in force (from the assignment)

- Stay on `main`; **never** branch, **never** commit. No user interaction — open decisions are RATIFIED-BY-DEFAULT in [clarifications-needed.md](./clarifications-needed.md) (Sam pre-authorized, 2026-07-25).
- **Never** edit `CLAUDE.md`, `README.md`, `docs/dev.md`, or anything under `design/`. Editing `migrations/`, `server/`, and `client/src/pages/{AdminPage,PrivacyPage}.jsx` **is** in scope.
- **Never** change `app.set('trust proxy', …)` in `server/index.js` (FR-006). It stays a numeric hop count; T018 asserts it.
- Keep the diff tight: no refactor of the auth module beyond the two parameter additions and the `req`/context plumbing into `completePostAuth`.
- Every new argument is optional — omitting it must not break an existing caller or an existing test.

---

## Phase 1: Setup (Schema)

**Purpose**: land the only schema change; everything else depends on it.

- [X] T001 Create `migrations/1799400000000_add-auth-ip-capture.js` per [data-model.md](./data-model.md) E1/E2. `up`: `pgm.addColumns('users', { signup_ip: {type:'inet'}, signup_user_agent: {type:'text'}, last_login_ip: {type:'inet'}, last_login_user_agent: {type:'text'} })` — all nullable, **no** default, **no** `NOT NULL`, **no** length `CHECK` (a constraint would throw inside the auth path, violating FR-008); then `pgm.createTable('auth_events', { id: {type:'bigserial', primaryKey:true}, user_id: {type:'uuid', notNull:true, references:'users', onDelete:'CASCADE'}, event: {type:'text', notNull:true, check:"event IN ('signup','login')"}, signup_source: {type:'text', notNull:true, default:'browser', check:"signup_source IN ('browser','agent_oauth')"}, ip: {type:'inet'}, user_agent: {type:'text'}, created_at: {type:'timestamptz', notNull:true, default: pgm.func('now()')} })`; then three indexes — `(created_at)` (FR-010), `(user_id)` (FK cascade is not auto-indexed), `(ip, created_at)` (RBD-6). `down`: drop the table, then drop the four columns. Header comment must record why the timestamp is `1799400000000` (> latest `1799300000000`, > the `1795000000000` rolled-back-008 floor) and why the columns are nullable.
- [X] T002 Apply the migration to the dev database and to `collab_test_db`, then verify the shape with `\d+ auth_events` and `\d users` (four new columns present, `auth_events` FK shows `ON DELETE CASCADE`, both `CHECK`s and all three indexes exist). Confirm `node-pg-migrate` `checkOrder` accepts the new timestamp.

**Checkpoint**: schema present in both databases; the suites can now touch the new columns.

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: the extraction helper, the event writer, the two helper signature extensions, and the three call sites. **⚠️ BLOCKS US1, US2, and US3** — no story can be verified until capture actually flows.

- [X] T003 [P] Create `server/auth/auth-context.js` per [contracts/user-store-and-capture.md](./contracts/user-store-and-capture.md) C1: export `authContext(req) → { ip, userAgent }` and `MAX_USER_AGENT_LENGTH = 512`. Derive the address as `req.ip || req.socket?.remoteAddress || null` and return it **only** when `require('node:net').isIP(value) !== 0`, else `null` (research R2 — this is what keeps an unparsable value from raising `invalid input syntax for type inet` inside the auth statement). Trim the `user-agent` header, return `null` when empty/absent, truncate to exactly 512 chars when longer. Pure, synchronous, no I/O, never throws (a `null`/malformed `req` yields `{ ip: null, userAgent: null }`). Comment explicitly: MUST NOT read `X-Forwarded-For` directly (FR-006), and MUST NOT return `rate-limit.js`'s `'unknown'` sentinel.
- [X] T004 [P] Create `server/auth/__tests__/auth-context.test.js` — pure unit, **no database**. Cover: IPv4, IPv6, `::ffff:127.0.0.1`, `req.socket.remoteAddress` fallback, `undefined`/`''`/`'unknown'`/`fe80::1%eth0` → `null`, missing UA → `null`, whitespace-only UA → `null`, 600-char UA → exactly 512 chars, `authContext(null)` and `authContext({})` do not throw.
- [X] T005 Create `server/auth/auth-events.js` per contract C3 — the **append-only writer** (the retention half is T013): `init(pool)`, and `async record({ userId, event, signupSource, ip, userAgent }) → Promise<boolean>` executing a single parameterized `INSERT INTO auth_events (user_id, event, signup_source, ip, user_agent) VALUES ($1,$2,$3,$4,$5)`. Guard `event` to `'signup' | 'login'` and `signupSource` to `'browser' | 'agent_oauth'` before binding (mirroring how `findOrCreateUser` guards `signup_source` today) so a bad value becomes the safe default rather than a `CHECK` violation. Wrap the whole body in `try/catch`: on any failure log `console.error('[AuthEvents] …')` and return `false` — it MUST NOT throw or reject (FR-008, SC-003). Export `RETENTION_DAYS = 180`. No update path and no per-row delete in this module.
- [X] T006 Edit `server/auth/users.js` per contract C2 — the two signature extensions, nothing else. (a) `findOrCreateUser(profile, { signupSource = 'browser', ip = null, userAgent = null } = {})`: add `signup_ip, signup_user_agent` to the INSERT column list **only**, leaving `ON CONFLICT DO UPDATE SET` untouched so a returning user's signup pair is never overwritten (FR-001, same mechanism as feature 029's `signup_source`); append no event. (b) `updateLastLogin(userId, { ip = null, userAgent = null, signupSource = 'browser', isNew = false } = {})`: extend the existing statement to `UPDATE users SET last_login_at = now(), last_login_ip = $2, last_login_user_agent = $3 WHERE id = $1` (FR-002, no extra round trip), then `await authEvents.record({ userId, event: isNew ? 'signup' : 'login', signupSource, ip, userAgent })` — exactly one row per completed authentication (FR-003, RBD-7). (c) `init(pool)` also calls `authEvents.init(pool)` so every existing init path (boot and every test calling `users.init(pool)`) wires the trail with no new call site. JSDoc must state that `updateLastLogin` also emits the `signup` event and why the name was not changed.
- [X] T007 Edit `server/auth/routes.js` — the three call-site pairs, per contract C4/C4a. Import `authContext`; at each site compute `const ctx = authContext(req)` once and pass `{ signupSource, ...ctx }` to `findOrCreateUser` and `{ ...ctx, signupSource, isNew: user.isNew }` to `updateLastLogin`. Sites: `:311`/`:322` inside `completePostAuth` (covers browser OAuth **and** agent OAuth — `signupSource` is already in scope there), `:606`/`:612` (dev-login legacy fixed user, `signupSource: 'browser'`), `:668`/`:669` (dev-login fresh JSON, already explicit). **`completePostAuth` MUST NOT be given `req`** — `server/auth/routes.js:232-236` documents feature 031's ratified structural invariant U2/INV-3 ("`completePostAuth` does not even receive `req`, so the auto-issue parameters cannot originate from any client-modifiable post-auth channel"). Instead add a `ctx` property to its existing options object (`{ profile, clientUrl, rawReturnTo, ctx = { ip: null, userAgent: null } }`) and have its two callers — the Google callback (`:220`) and dev-login fresh-browser mode (`:664`) — call `authContext(req)` in their own scope and pass the two extracted scalars. That is the **only** structural change permitted in this file. Do **not** touch the token-refresh route, JWT issuance, cookie options, or the OAuth handshake (FR-005 holds by construction — refresh calls neither helper).

**Checkpoint**: capture flows end-to-end on all three auth paths. Run `npx jest --runInBand server/auth/__tests__/` to confirm the pre-existing auth suites are still green before layering stories.

---

## Phase 3: User Story 1 — Admin spots a multi-account spray from the user list (Priority: P1) 🎯 MVP

**Goal**: the per-account snapshot is written correctly (once for signup, refreshed on every login) and all four values are visible to an admin — and to nobody else.

**Independent test**: sign up and log in through the browser flow, then open the admin user list as an admin; the signup and last-login address and user-agent for that account are displayed, a second account created from the same client shows matching values, and a pre-feature account renders `—` without error.

- [X] T008 [US1] Extend `server/auth/__tests__/users.test.js` with the snapshot semantics (follow the existing file's `createPool()` + synthetic-email cleanup patterns): signup pair written at creation; a **second** `findOrCreateUser` for the same `googleId` with a *different* context leaves `signup_ip`/`signup_user_agent` unchanged (FR-001, the once-only guarantee); `updateLastLogin` refreshes `last_login_ip`/`last_login_user_agent` alongside `last_login_at` (FR-002); after the create+update pair the signup and last-login values are identical (US1 acceptance 1); `findOrCreateUser(profile)` and `updateLastLogin(id)` **without** the new argument still succeed and store `NULL` (backward compatibility).
- [X] T009 [P] [US1] Edit `server/api/admin.js` `GET /users` per [contracts/admin-users-api.md](./contracts/admin-users-api.md): add `u.signup_ip, u.signup_user_agent, u.last_login_ip, u.last_login_user_agent` to the explicit `SELECT` list and `signupIp, signupUserAgent, lastLoginIp, lastLoginUserAgent` to the row→object mapping, passing values through verbatim (no masking, truncation, or reformatting — the admin is the investigator). Leave the joins and `ORDER BY` untouched; add no query parameters.
- [X] T010 [P] [US1] Edit `client/src/pages/AdminPage.jsx`: add `<th>Signup IP</th>` and `<th>Login IP</th>` immediately after `Last Login`; bump `colCount` from `9` to `11` (line 253 — it drives the detail row's `colSpan`); render each IP cell as the value or the existing `—` placeholder, with `title={u.signupUserAgent || 'No user-agent recorded'}` (resp. `lastLoginUserAgent`) so the fingerprint is available on hover; add a `Sign-in origin` `admin-detail-section` to the expanded detail row listing all four values with labels and **full untruncated** user-agent strings, `—` for absent. Render values as React text children only — never `dangerouslySetInnerHTML` (the user-agent is attacker-controlled). Add any needed styling to `client/src/pages/AdminPage.css`.
- [X] T011 [US1] Create `server/__tests__/admin-auth-capture.test.js` (follow `server/__tests__/admin-sharing.test.js` for the supertest + `createPool()` harness): an admin `GET /api/admin/users` returns the four new keys with the stored values for a seeded user and `null` for a user created without capture (FR-011, US1 acceptance 4); a non-admin caller receives `403` with no capture data (FR-012) — for that assertion mount the router **behind the real `requireAdmin` middleware**, exactly as `server/index.js:503` does (`app.use('/api/admin', requireAdmin, admin.router)`), since mounting `admin.router` bare (as `admin-sharing.test.js` does) bypasses the gate and would make the 403 assertion vacuous; and the `GET /auth/me` payload keys are exactly the documented eight-field whitelist, proving the new columns cannot leak through it (SC-005).
- [X] T012 [P] [US1] Create `client/src/pages/__tests__/AdminPage.test.jsx` (Vitest, mirroring the mocking style of `client/src/pages/__tests__/SettingsPage.test.jsx`): mock `../contexts/AuthContext`'s `useAuth` to return a stub `api` yielding two users — one with all four capture values, one with all four `null` — and assert the two new column headers render, the populated row shows both IPs, and the empty row shows the `—` placeholder without error.

**Checkpoint**: US1 is independently shippable — capture is written, never overwritten, admin-visible, and provably not exposed anywhere else.

---

## Phase 4: User Story 2 — Durable auth-event trail for correlation (Priority: P2)

**Goal**: every completed signup and login appends exactly one immutable trail row; rows expire at 180 days and vanish with their user.

**Independent test**: perform a signup and two logins (mixing browser and agent auth paths); confirm three trail entries with the correct event types, channels, addresses, user-agents, and timestamps, and that a token refresh in between produced no entry.

- [X] T013 [US2] Extend `server/auth/auth-events.js` with the retention half (contract C3): `async purgeOlderThan(days = RETENTION_DAYS)` → `DELETE FROM auth_events WHERE created_at < now() - ($1 || ' days')::interval` returning `rowCount`, touching **only** `auth_events` (FR-010 exempts the `users` columns); `startPurgeJob({ intervalMs = 86_400_000, days = RETENTION_DAYS })` → one immediate fire-and-forget sweep (errors logged, never thrown) plus `setInterval(...).unref()`, idempotent so a second call creates no second timer; `stopPurgeJob()` → `clearInterval`, safe when never started.
- [X] T014 [US2] Wire the job for boot and drain (contract C5): in `server/index.js`, call `authEvents.startPurgeJob()` once after the pool/users init, and add `stopBackgroundJobs: authEvents.stopPurgeJob` to the existing `createShutdown({ … })` call (~line 2286). In `server/shutdown.js`, accept an **optional** `stopBackgroundJobs` dep and invoke it inside the existing guarded-step style before the async drain steps — absent → no-op, so every current call site and every existing shutdown test is unaffected. Do not change any other shutdown step or its ordering.
- [X] T015 [US2] Create `server/auth/__tests__/auth-events.test.js` covering the trail contract: a `findOrCreateUser` + `updateLastLogin` pair for a **new** user appends exactly one row with `event='signup'` (US2 acceptance 1); a second pair for the same user appends exactly one row with `event='login'` (acceptance 2); `signup_source` records the channel of the event (`browser` and `agent_oauth` both asserted — design gap G-1's adopted default); a signup followed by two logins yields exactly three rows (the spec's independent test); `purgeOlderThan(180)` deletes a row aged 181 days, keeps one aged 179 days, and leaves every `users` capture column untouched (acceptance 4, SC-004); deleting the user removes all of that user's rows via FK cascade (acceptance 5, FR-009); and **token refresh appends nothing** — hit the refresh endpoint (or assert structurally that the refresh route calls neither `findOrCreateUser` nor `updateLastLogin`) and confirm the `auth_events` count and every `users` capture column are unchanged (FR-005, US2 acceptance 3, the spec's own independent test). Also assert no code path in `server/` updates or per-row deletes `auth_events` outside `purgeOlderThan` (grep-style assertion or explicit reviewer note in the file header).

**Checkpoint**: the trail is durable, bounded, and correlated to the account lifecycle.

---

## Phase 5: User Story 3 — Capture is disclosed, admin-only, and never breaks sign-in (Priority: P3)

**Goal**: authentication is provably unaffected by any capture failure, and the collection is disclosed.

**Independent test**: sign in with a client that omits the user-agent header — login succeeds and the field is recorded as absent; read the published privacy policy — the data-collection section explicitly mentions IP/user-agent capture at signup and sign-in.

- [X] T016 [US3] Add the fail-open coverage to `server/auth/__tests__/auth-events.test.js` and `server/auth/__tests__/users.test.js` (SC-003, FR-008): `record()` returns `false` and does **not** throw when the pool rejects (inject a stub pool whose `query` rejects) and when `init` was never called; `updateLastLogin` still updates `last_login_at` and resolves normally when the event insert fails; a sign-in with **no** user-agent stores `NULL` and succeeds (US3 acceptance 1); a 600-char user-agent stores exactly 512 chars and succeeds (acceptance 2); an unparsable address stores `NULL` and succeeds (acceptance 3). Assert `event` values outside the domain are coerced rather than raising a `CHECK` violation.
- [X] T017 [P] [US3] Edit `client/src/pages/PrivacyPage.jsx` (FR-013, SC-006): under `<h3>Usage and log data</h3>`, add an explicit sentence/paragraph stating that **when you create an account and each time you sign in, we record the IP address and browser/client (user-agent) information of the request, and use it for security and abuse prevention**, and that this sign-in history is retained for **180 days** while the most recent values stay associated with the account. Keep it consistent with the `<h2>Data Retention</h2>` section (add the 180-day auth-history line there if that reads better than repeating it). Bump `LAST_UPDATED` to `'July 25, 2026'`. Marketing-copy tone: honest and plain, no hedging, no self-deprecation. Extend the file's header comment (which already says the provider list must track `ai-providers.js`) to note that this disclosure must track the 034 capture behavior.
- [X] T018 [P] [US3] Create `server/__tests__/trust-proxy-invariant.test.js` (FR-006, research R6) — cheap and dependency-free: read `server/index.js` and assert the `trust proxy` setting is still a `Number(...)` expression over `TRUST_PROXY_HOPS` and that no `trust proxy'`/`trust proxy"` followed by `true` form exists. Header comment: this is the invariant that makes every captured address meaningful — blanket proxy trust would make all four columns and the whole trail forgeable via `X-Forwarded-For`.

**Checkpoint**: capture is fail-open, disclosed, and its trust foundation is guarded against future regression.

---

## Phase 6: Polish & Cross-Cutting Concerns

- [X] T019 Run the full gate: `npm run test:server` (Jest, `--runInBand`, **serial only** — never a second concurrent backend run against the same DB) and `npm run test:client` (Vitest). Both must be green. If `reindexStale`-style shared-DB flakiness appears, heal per the existing per-suite pattern rather than loosening an assertion.
- [X] T020 Non-exposure sweep: grep `server/` and `client/src/` for `signup_ip`, `signup_user_agent`, `last_login_ip`, `last_login_user_agent`, `signupIp`, `lastLoginIp` and confirm the only read surfaces are `server/api/admin.js` and `client/src/pages/AdminPage.jsx` (FR-012). Confirm no MCP tool, share/collaborator payload, or public endpoint selects them, and that no `SELECT *` from `users` reaches a non-admin response body.
- [X] T021 Write `specs/034-auth-ip-capture/promotion-notes.md` recording what this feature leaves owed: the Squire design-doc amendments for gaps **G-1** (`auth_events.signup_source` semantics for `login` rows — possibly rename to `channel`), **G-2** (purge mechanism/cadence now fixed by RBD-8), and **G-3** (failed attempts explicitly excluded); the `README.md`/`docs/dev.md` schema/auth touch owed to the merge-queue docs pass (Constitution Principle I — this feature's agents may not edit them); the deploy dependency in SC-006 (the privacy policy must ship **before or with** the capture); and the follow-on detector/report feature that the `(ip, created_at)` index and the trail exist to serve.

---

## Dependencies & Execution Order

```text
Phase 1 (T001→T002)                 schema
        ↓
Phase 2 (T003‖T004, T005, T006, T007)   BLOCKS everything
        ↓
   ┌────────────────┬─────────────────┬──────────────────┐
Phase 3 US1 (P1)   Phase 4 US2 (P2)  Phase 5 US3 (P3)
T008, T009‖T010,   T013 → T014,      T016, T017‖T018
T011, T012‖        T015
   └────────────────┴─────────────────┴──────────────────┘
        ↓
Phase 6 (T019 → T020 → T021)
```

- **Hard order inside Phase 2**: T003 → T006 (users needs `authContext`'s bound values… strictly it needs only the shape, but the contract lives there), T005 → T006 (`updateLastLogin` calls `authEvents.record`), T006 → T007 (call sites need the new signatures). T004 is independent of all of them.
- **Story independence**: after Phase 2, US1, US2, and US3 touch disjoint files and can proceed in any order or in parallel. US1 alone is a shippable increment.
- **T013 → T014**: the boot/shutdown wiring needs `startPurgeJob`/`stopPurgeJob` to exist.
- **T016 depends on T005/T006** (the fail-open behavior it asserts) and edits the same two test files as T008/T015 — sequence it after them to avoid edit collisions.

## Parallel Execution Examples

- **Phase 2**: T003 and T004 together (implementation + its pure unit test, different files, and the test is written against the contract).
- **Phase 3**: T009 (server) ‖ T010 (client) ‖ T012 (client test) — three different files, no shared state; T011 after T009.
- **Phase 5**: T017 (privacy page) ‖ T018 (invariant test) — unrelated files.

## Implementation Strategy

1. **MVP = Phase 1 + Phase 2 + Phase 3 (US1) + T017**. US1 alone delivers the feature's headline value — a repeat of the 2026-07-25 relay spray becomes visible in the admin user list (SC-001), with capture written correctly and exposed nowhere else — **but SC-006 makes the privacy disclosure a deploy-blocking dependency**: the policy must be published *before or in the same deploy as* the capture going live. T017 is therefore pulled into the MVP bundle despite being a P3 task. Shipping US1 without T017 would put undisclosed personal-data collection into production and is **not** a permitted increment.
2. **Increment 2 = Phase 4 (US2)** — the durable trail and its 180-day bound, which the follow-on detector needs.
3. **Increment 3 = the rest of Phase 5 (US3)** — fail-open proof (T016) and the trust-proxy guard (T018).

**Task count**: 21 (Setup 2, Foundational 5, US1 5, US2 3, US3 3, Polish 3).
