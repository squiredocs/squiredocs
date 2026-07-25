# Implementation Plan: Signup/Login IP + User-Agent Capture (Abuse Signals)

**Branch**: `034-auth-ip-capture` (feature id only — work stays on `main` per the parallel-agent overrides) | **Date**: 2026-07-25 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `/specs/034-auth-ip-capture/spec.md`

**Design ground truth**: `design/authentication-and-sharing.md` — section "Abuse signals: signup/login IP + user-agent" plus the amended "Data model" line (`auth_events` listed as an app table; `users` listed as carrying "signup/last-login IP + user-agent"). Constitution Principle VI: where this plan and that document disagree, the document wins. Open decisions are RATIFIED-BY-DEFAULT in [clarifications-needed.md](./clarifications-needed.md) (Sam pre-authorized, 2026-07-25); design gaps G-1..G-3 stay flagged, never silently resolved.

## Summary

Capture the proxy-resolved client IP and the `User-Agent` header on every **completed** signup and login, on all three auth paths, and make the result visible to an admin at a glance.

Mechanically this is a small, additive slice:

1. **One migration** (`1799400000000_add-auth-ip-capture.js`): four nullable columns on `users` (`signup_ip inet`, `signup_user_agent text`, `last_login_ip inet`, `last_login_user_agent text`) and one new append-only table `auth_events` (`user_id` FK `ON DELETE CASCADE`, `event`, `signup_source`, `ip inet`, `user_agent text`, `created_at`) with three indexes.
2. **One extraction helper** (`server/auth/auth-context.js`): `authContext(req) → { ip, userAgent }`. Exactly one place derives the pair from a request; `ip` is validated with Node's `net.isIP()` so an unparsable value becomes `null` instead of a malformed `inet` literal that could throw inside the auth path; `userAgent` is trimmed and truncated to 512 chars, or `null`.
3. **Two helper signature extensions** (`server/auth/users.js`): `findOrCreateUser(profile, { signupSource, ip, userAgent })` writes the signup pair **only in the INSERT column list** (never in `ON CONFLICT DO UPDATE`), exactly mirroring how feature 029 stamps `signup_source` once; `updateLastLogin(userId, { ip, userAgent, signupSource, isNew })` refreshes the last-login pair **and** appends the single `auth_events` row for that authentication (`signup` when `isNew`, else `login`). Both context arguments are optional — omitting them reproduces today's behavior with `NULL` capture, so no existing caller or test breaks.
4. **Three call sites** (`server/auth/routes.js:311/322`, `:606/612`, `:668/669`) pass `authContext(req)`. Nothing else in the auth module is refactored. One constraint discovered during analysis and honored by the design: `completePostAuth` **must not** be handed `req` — feature 031's ratified structural invariant U2/INV-3 (`server/auth/routes.js:232-236`) depends on it never receiving one — so it takes the pre-extracted `{ ip, userAgent }` pair instead (contract C4a).
5. **A non-blocking event writer** (`server/auth/auth-events.js`): `record()` is fully `try/catch`-wrapped and never throws into auth; `purgeOlderThan(180)` plus a boot-time sweep + daily `setInterval` (`.unref()`ed, stoppable) implements the 180-day retention.
6. **Exposure + disclosure**: `server/api/admin.js` `GET /users` returns the four values; `client/src/pages/AdminPage.jsx` shows the two IPs as columns and all four values (full user-agent strings) in the existing expandable detail row; `client/src/pages/PrivacyPage.jsx` gains the explicit signup/sign-in IP + UA disclosure with the 180-day event retention.

The load-bearing invariants: capture **never** blocks or fails authentication (FR-008); the numeric `trust proxy` hop count stays exactly as it is (FR-006 — blanket trust would make every captured address attacker-controlled); token refresh appends nothing (FR-005); nothing leaks outside the admin surface (FR-012).

## Technical Context

**Language/Version**: Node.js 22+ (CommonJS server), React 18 (client). No new language, no new runtime.

**Primary Dependencies**: Existing only — `express` (`req.ip`, resolved through the numeric `trust proxy` hop count set at `server/index.js:135`), `pg` (parameterized queries via the shared pool), `node-pg-migrate` (schema), Node core `net` (`net.isIP` for address validation). **No new production dependency.** No user-agent parsing library — the raw string is the fingerprint; parsing it is not in scope.

**Storage**: PostgreSQL. Four nullable columns added to `users`; one new table `auth_events`. `inet` is the native address type (accepts IPv4, IPv6, and the `::ffff:` IPv4-mapped form Express produces on dual-stack sockets). No Redis, no S3, no pgvector involvement.

**Testing**: Backend Jest (`server/auth/__tests__/`, `server/__tests__/`), run serially (`npm run test:server` → `jest --runInBand`) against the shared `collab_test_db` — Constitution Principle II. Test DB access goes through `server/__tests__/helpers/db.js` (`createPool()`, respects `DATABASE_URL`). New/extended suites: `users.test.js` (capture semantics), `auth-context.test.js` (pure unit, no DB), `auth-events.test.js` (append/purge/cascade/failure-tolerance), `admin-auth-capture.test.js` (admin exposure + non-admin non-exposure). Client: one minimal Vitest render test for the admin table (`client/src/pages/__tests__/AdminPage.test.jsx`).

**Target Platform**: Linux server (Minikube `app-dev` pod for dev; the hardened k3s cluster in prod, where `TRUST_PROXY_HOPS=2` for CloudFront + Traefik).

**Project Type**: Web application — Express backend (`server/`) + React frontend (`client/`), with schema in `migrations/`.

**Performance Goals**: Auth latency must not regress measurably. Each completed auth adds exactly one small `INSERT` into `auth_events` and reuses the already-executing `UPDATE users … last_login_at` (columns folded into the same statement — no extra round trip for the snapshot). The purge is a single indexed `DELETE` once per day.

**Constraints**:

- Capture is best-effort and **fails open**: a `NULL` address, a missing header, or a failed `auth_events` insert MUST still yield a successful sign-in (FR-008). The only capture write that shares a transaction with auth is the `users` snapshot, and it is made throw-proof by validating the address in JS before it ever reaches `inet` (research R2).
- `app.set('trust proxy', Number(...))` at `server/index.js:135` MUST remain numeric (FR-006 / feature 010 FR-014/RD-5).
- User-agent stored at ≤ 512 characters **everywhere** (FR-007) — truncation happens once, in `authContext`, so both storage locations receive the already-bounded value.
- New migration timestamp MUST exceed `1799300000000` (current latest) and the `1795000000000` rolled-back-008 floor. This is the only migration-adding feature in flight, so `1799400000000` is uncontested.
- No refactor of the auth module beyond the two parameter additions; no change to token refresh, JWT, cookies, or the OAuth flows themselves.

**Scale/Scope**: Beta-scale (low hundreds of accounts). `auth_events` grows at roughly one row per human sign-in; at 180-day retention the steady-state table is small (thousands of rows). Footprint: 1 migration, 2 new server modules, 4 edited server files, 2 edited client files, 5 test files.

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-checked after Phase 1 design (below).*

- **I. Documentation Reflects Reality** — `README.md` / `docs/dev.md` are off-limits to this feature's agents (assignment override). This feature adds a table and four columns; if `README.md` or `docs/dev.md` enumerate schema or auth behavior, that touch is **owed to the merge-queue docs pass** (orchestrator), flagged here rather than resolved ad hoc. The user-facing document that *must* change in the same change set is the privacy policy (FR-013), and it is in scope (T017). **PASS (with flagged owed doc pass).**
- **II. Test-Backed Changes** — every behavioral change is test-backed and the suites are backend Jest + client Vitest, run serially for the backend: capture-on-create and never-overwrite, last-login refresh, exactly-one-event-per-auth, refresh-appends-nothing, 512-truncation, null-safety, insert-failure tolerance, purge boundary, FK cascade, admin exposure, non-admin non-exposure. No format-registry / round-trip surface is touched, so `format-roundtrip.test.js` is untouched by construction. **PASS.**
- **III. Trunk-Based Solo Workflow** — stay on `main`, never branch, never commit (assignment override); no new ceremony, no new CI job, no new script. The purge is the smallest mechanism that satisfies FR-010 (boot sweep + one interval) rather than a scheduler framework — YAGNI honored, and the choice is recorded as a flagged design gap (G-2), not invented silently. **PASS.**
- **IV. Collaboration-Safe Document Operations** — not applicable: no Yjs, no document mutation, no format registry, no attribution surface. **PASS (N/A).**
- **V. Secure by Default for Agent & User Content** — this feature *is* a security feature and its own biggest risk is trust: the captured address is only meaningful because `trust proxy` is a fixed numeric hop count. FR-006 forbids changing it and the plan adds an explicit regression assertion (T007) so a later "fix" that switches to `trust proxy true` fails a test rather than silently turning every column into attacker-controlled text. Second: the `User-Agent` header is untrusted input — it is stored, never interpreted, never rendered as HTML (React escapes by default), and bounded at 512 chars. Third: the data is personal — exposure is admin-only (`GET /api/admin/users` already sits behind `requireAdmin`), the `/auth/me` payload is a field whitelist (verified — new columns cannot leak through it), and retention is bounded at 180 days for the trail. No new ingestion surface, no new endpoint, no new auth path. **PASS — with the trust-proxy invariant as the highest-risk area.**
- **VI. Design Docs Are Ground Truth** — the plan implements the design section verbatim: column names, table name and shape, `inet`, 512-char truncation, nullable, `req.ip`, the three covered paths, refresh excluded, admin-only exposure, 180-day purge, FK cascade. The three points the design leaves under-specified (G-1 event-`signup_source` semantics, G-2 purge mechanism, G-3 failed attempts) keep the spec's adopted defaults and remain flagged for a Squire-doc amendment; this plan adds no new divergence and one new plan-level default (exactly-one-event placement, RBD-7) recorded in the ledger. **PASS (with flagged design amendments owed).**

**Initial gate: PASS.** No violations requiring Complexity Tracking.

**Post-Phase-1 re-check: PASS.** The Phase 1 design introduced no new dependency, no new endpoint, no new trust boundary, and no constitutional exception. The three plan-level decisions taken during design (event placement in `updateLastLogin`, `net.isIP()` address validation, `.unref()`ed purge timer with an optional shutdown hook) are all inside existing conventions and are recorded as RBD-6..RBD-8 in `clarifications-needed.md`. Complexity Tracking stays empty.

## Project Structure

### Documentation (this feature)

```text
specs/034-auth-ip-capture/
├── plan.md                     # This file
├── research.md                 # Phase 0 — the six decisions that shaped the design
├── data-model.md               # Phase 1 — users delta + auth_events, indexes, lifecycle
├── contracts/
│   ├── user-store-and-capture.md   # authContext / findOrCreateUser / updateLastLogin / authEvents
│   └── admin-users-api.md          # GET /api/admin/users response delta + exposure boundary
├── quickstart.md               # Phase 1 — runnable validation walk
├── analysis.md                 # /speckit-analyze report (post-tasks)
├── clarifications-needed.md    # RBD ledger (exists; extended with RBD-6..RBD-8)
├── checklists/requirements.md  # (exists)
├── spec.md                     # (exists)
└── tasks.md                    # /speckit-tasks output
```

### Source Code (repository root)

```text
migrations/
└── 1799400000000_add-auth-ip-capture.js     # NEW — users columns + auth_events + indexes

server/
├── auth/
│   ├── auth-context.js                      # NEW — authContext(req) → { ip, userAgent } (the ONE extractor)
│   ├── auth-events.js                       # NEW — record(), purgeOlderThan(), startPurgeJob()/stopPurgeJob()
│   ├── users.js                             # EDIT — findOrCreateUser + updateLastLogin gain context; init wires auth-events
│   ├── routes.js                            # EDIT — 3 call-site pairs pass authContext(req)
│   └── __tests__/
│       ├── auth-context.test.js             # NEW — pure unit (no DB)
│       ├── auth-events.test.js              # NEW — append / purge / cascade / failure tolerance
│       └── users.test.js                    # EDIT — capture semantics on the two helpers
├── api/
│   └── admin.js                             # EDIT — GET /users SELECT + response mapping
├── index.js                                 # EDIT — start the purge job at boot; pass stop hook to shutdown
├── shutdown.js                              # EDIT — optional stopBackgroundJobs dep (guarded no-op when absent)
└── __tests__/
    ├── admin-auth-capture.test.js           # NEW — admin exposure + non-admin non-exposure
    └── trust-proxy-invariant.test.js        # NEW (cheap) — asserts numeric trust proxy (FR-006)

client/src/pages/
├── AdminPage.jsx                            # EDIT — two IP columns + capture block in the detail row
├── PrivacyPage.jsx                          # EDIT — FR-013 disclosure + retention, LAST_UPDATED bump
└── __tests__/AdminPage.test.jsx             # NEW — minimal render: values + absent-value placeholder
```

**Structure Decision**: The existing web-app layout is used as-is. The two new server modules live in `server/auth/` because both are auth-lifecycle concerns and both are consumed only from there; `auth-events.js` is a peer of `users.js` (not a function inside it) so the retention job and the non-blocking write policy have one obvious home and one obvious test file. No `shared/` code is involved (nothing is needed on both client and server).

## Phase Overview

- **Phase 0 — Research** (`research.md`): six decisions — event placement, address validation, snapshot write strategy, purge mechanism, admin UI shape, and the trust-proxy no-regression guard.
- **Phase 1 — Design & Contracts** (`data-model.md`, `contracts/`, `quickstart.md`): schema, module contracts, API delta, and the runnable validation walk.
- **Phase 2 — Tasks** (`tasks.md`, produced by `/speckit-tasks`): setup → foundational (migration + the two new modules) → US1 (snapshot + admin visibility, MVP) → US2 (trail + retention) → US3 (robustness + disclosure) → polish.

## Complexity Tracking

> No Constitution Check violations. Table intentionally empty.

| Violation | Why Needed | Simpler Alternative Rejected Because |
|-----------|------------|-------------------------------------|
| _(none)_  | —          | —                                    |
