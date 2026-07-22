# Clarifications Ledger: 029-first-run-test-mechanism

Design ground truth: `design/plugin-marketplace-publishing.md` (ratified 2026-07-21).
Per constitution VI, unanswered product decisions get the best default, recorded here —
never decided silently, never blocking.

## RATIFIED-BY-DEFAULT decisions (Sam pre-authorized, 2026-07-21)

### RBD-1 — How auto-approve recognizes a "synthetic session"

- **Question**: The design says consent auto-approve is "synthetic-session-only" but does not define how the server tells a synthetic session from a real one.
- **Why it matters**: This is the security boundary keeping a session-forgery primitive away from real accounts, even in dev/staging where real-ish data may exist.
- **Default chosen**: The session's authenticated user's email must match the faucet namespace pattern (`test+<nonce>@test.local`). Anything else is refused. No separate "synthetic" flag or table — the namespace IS the boundary, same rule as the synthetic wipe.
- **Rationale**: One boundary, two enforcers (wipe + auto-approve) is simpler and harder to drift than parallel mechanisms; the namespace is already the design's own framing for the wipe.

### RBD-2 — Synthetic wipe targeting interface

- **Question**: Does the wipe take a user id, an email, or a pattern?
- **Why it matters**: Free-form ids widen the blast radius of a mass-delete primitive.
- **Default chosen**: The wipe accepts an email that must match the strict synthetic pattern (`test+<nonce>@test.local`, validated server-side); optionally a "wipe all synthetic users" convenience for harness cleanup that deletes only rows matching the pattern. No numeric user ids, no wildcards outside the namespace.
- **Rationale**: Mirrors the design's hardcoded-constant philosophy for the prod reset: the target grammar itself is the guard.

### RBD-3 — Nonce generation and format

- **Question**: Who generates the faucet nonce and in what format?
- **Why it matters**: Determines repeatability semantics (re-login vs new user) and collision behavior.
- **Default chosen**: Server generates a random nonce (short hex) when `fresh: true` and no nonce is supplied; callers may pass an explicit nonce (validated `[a-z0-9-]+`, bounded length) to get a stable identity across a scripted scenario (find-or-create makes a reused nonce a re-login, not an error). The response includes the minted email/nonce.
- **Rationale**: Random-by-default gives the harness zero-config fresh users; explicit nonces let multi-step scripts (mint → consent → wipe) address the same identity deterministically.

### RBD-4 — Production reset interface and auth

- **Question**: The design fixes the target (hardcoded constant) and "admin auth" but not the interface or which admin mechanism.
- **Why it matters**: Prod-reachable endpoint; interface shape is the safety argument.
- **Default chosen**: The endpoint takes NO target parameter at all — the target is the compile-time constant; invoking it means "reset the self-test account". Auth is the existing admin gate (admin-flagged user session / `requireAdmin`), no new auth machinery. Idempotent no-op when the account doesn't exist.
- **Rationale**: An endpoint with no target parameter cannot be widened by a bug in parameter handling; reusing existing admin auth honors the 008/009 lesson (no bespoke auth).

### RBD-5 — Retaining the NODE_ENV secondary guard on synthetic endpoints

- **Question**: The design's invariant says gating must "never be a `NODE_ENV !== 'production'` negative"; the existing 2b9d6be gate uses the positive flag AND the negative check as belt-and-suspenders. Keep the belt?
- **Why it matters**: Strict reading could be taken as "remove the NODE_ENV check".
- **Default chosen**: Keep both: the positive flag is the required, primary, fail-closed gate; the `NODE_ENV !== 'production'` check remains as an *additional* guard on all synthetic endpoints (it can only make things stricter). The invariant is read as forbidding the negative check *as the sole gate*.
- **Rationale**: The 2026-07-21 incident was caused by negative-only gating; the fix (2b9d6be) deliberately added the positive flag while keeping the belt. Removing a defense to satisfy a stylistic reading would be backwards.

### RBD-6 — signup_source schema shape

- **Question**: D5 fixes the column and values but not constraints.
- **Why it matters**: Un-constrained provenance columns rot.
- **Default chosen**: `signup_source` TEXT NOT NULL DEFAULT 'browser' with a CHECK constraint limiting values to `('browser','agent_oauth')`; existing rows take the default (accepted imprecision — pre-feature agent-born accounts read as 'browser', which D5 acknowledges by saying backfill is impossible).
- **Rationale**: Cheapest schema that makes invalid states unrepresentable; extending the CHECK later is a trivial migration if new sources appear.

### RBD-7 — Migration timestamp floor

- **Question**: Standing guidance (rolled-back-008 cleanup) says new migrations must be timestamped > 1795000000000; the actual latest migration is now `1799200000000_drop-yjs-state-vectors.js`.
- **Why it matters**: node-pg-migrate checkOrder fails on out-of-order timestamps.
- **Default chosen**: The new migration is timestamped greater than the current latest (i.e., ≥ 1799300000000), which trivially satisfies the 1795000000000 floor.
- **Rationale**: The floor is a minimum, not a target; ordering against the real latest is what checkOrder enforces.

### RBD-8 — M1 grading expectations against stub content

- **Question**: The transcript grading checklist references coaching behaviors (signup line, bare URL, loop taught) whose content is M2 work. What does "grading works" mean in M1?
- **Why it matters**: M1's exit could otherwise be misread as requiring passing transcripts, which would smuggle M2 content into M1.
- **Default chosen**: M1 delivers the grading *mechanism*: every rehearsal emits a per-item pass/fail against the full checklist. With the stub plugin, most coaching items are expected to FAIL — the demonstrable M1 outcome is that the harness runs end to end unattended and the grade report is produced and accurate. Clean passes across the matrix are M2's exit, exactly as the design's milestone text states.
- **Rationale**: Keeps the milestone gate honest; the stub's placeholder skill/command may include one trivially-gradable marker to prove the grader can detect a pass as well as a fail.

### RBD-9 — Stub plugin bundle location

- **Question**: The design reserves `distribution/` for the real M3 tree; where does the M1 stub live?
- **Why it matters**: Putting the stub at `distribution/claude-plugin` risks it being mistaken for (or colliding with) the real M3 bundle.
- **Default chosen**: The stub lives under the test/harness tree (alongside the rehearsal harness, e.g. a `stub-plugin/` fixture directory), NOT at `distribution/claude-plugin`; the harness's marketplace-add step points at wherever the bundle lives via a parameter, defaulting to the stub and switching to `distribution/claude-plugin` when M3 creates it. Exact path is a plan-phase detail.
- **Rationale**: The design's harness description references `distribution/claude-plugin` as it will exist post-M3; in M1 a clearly-marked fixture avoids seeding the real tree with throwaway content, while the parameterized path keeps the harness ready for the real bundle with zero rework.

### RBD-10 — Browser-mode faucet must traverse the real consent round-trip path

- **Question**: Should the browser-mode faucet shortcut straight to "session + redirect", or route through the same server logic as the Google callback (provenance stamping, welcome-doc skip)?
- **Why it matters**: If the faucet stamps `agent_oauth` itself (or skips the welcome doc itself), the tier-1 tests would be testing the faucet, not the production code path.
- **Default chosen**: The browser-mode faucet substitutes ONLY the identity-provider leg (who the user is); account creation, provenance stamping, welcome-doc decisions, and returnTo handling all flow through the same shared server logic the real Google callback uses, so the tests exercise production behavior.
- **Rationale**: The faucet's whole purpose is "prod-shaped first-runs"; a shortcut would make every downstream assertion vacuous.

## Flagged gaps / discrepancies (design vs code)

- **None material.** All design claims marked "verified 2026-07-21" were re-verified during spec authoring and match the code:
  - `server/auth/routes.js:81-94` — returnTo validator, 512-char cap, same-origin checks (design M4 finding accurate).
  - `server/auth/routes.js:201` — Google callback is `findOrCreateUser` (account created mid-flow).
  - `server/auth/routes.js:223-225` — consent returnTo branch returns before welcome-doc seeding (the accidental skip the design makes load-bearing).
  - `server/auth/routes.js:416-461` — dev-login is fixed-user-only, JSON-only, positively gated by `ENABLE_DEV_ENDPOINTS === '1'` (plus NODE_ENV belt); no `fresh` support, no browser mode.
  - `client/src/contexts/AuthContext.jsx:134-149` — `devLogin` posts no body, exactly as the design says; client change correctly scoped into M1.
  - `server/mcp/auth/oauth-router.js:23,29` — `/authorize` (optionalAuth) and `/approve` (requireAuth) exist as the design assumes.
- **Minor note (stale guidance, not a design discrepancy)**: the standing ">1795000000000" migration floor from the rolled-back-008 cleanup is now well behind the actual latest migration (1799200000000). Handled by RBD-7.
