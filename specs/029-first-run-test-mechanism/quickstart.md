# Quickstart / Validation Guide: First-Run Test Mechanism (Plugin M1)

Runnable validation scenarios that prove M1 works end to end. All commands run **inside the
Minikube `app-dev` pod** (Linux — the pristine-rehearsal platform; macOS is out of scope,
FR-024). Endpoints assume the dev/staging overlay with `ENABLE_DEV_ENDPOINTS=1`.

Prerequisites: dev server running on stale-code-free sync (restart if in doubt), the migration
`1799300000000_add-signup-source-to-users.js` applied, Postgres reachable via `DATABASE_URL`.

References: endpoint shapes in `contracts/`, entities in `data-model.md`, mechanism choices in
`research.md`.

---

## Tier 1 — Backend integration tests (no human, in the suite) — SC-007, FR-015

```
# serial-only (constitution II); the suite is wired --runInBand
npm test -- server/__tests__/integration/first-run.test.js
```
Expected: green. Covers (a) consent returnTo round-trip with mid-flow account creation,
(b) signup-source stamping for both paths, (c) the deliberate welcome-doc skip for
consent-born accounts, (d) the null-welcome-doc client contract, and (e) the flag-off /
production-like unreachability of every synthetic endpoint (SC-004).

---

## Faucet + wipe smoke (primitives — US1)

```
# fresh JSON user
curl -sX POST $DEV/auth/dev-login -H 'content-type: application/json' -d '{"fresh":true}'
#  => { accessToken, user, email:"test+<nonce>@test.local", nonce }

# fresh browser-mode (cookies + 302 to returnTo)
curl -si -X POST $DEV/auth/dev-login -H 'content-type: application/json' \
     -d '{"fresh":true,"browser":true,"returnTo":"/mcp/auth/authorize?..."}'
#  => 302 Location: /mcp/auth/authorize?...  + Set-Cookie accessToken/refreshToken

# wipe it back to first-run
curl -sX POST $DEV/auth/dev-wipe-user -H 'content-type: application/json' \
     -d '{"email":"test+<nonce>@test.local"}'      # => ok

# refusal: real address is rejected
curl -sX POST $DEV/auth/dev-wipe-user -H 'content-type: application/json' \
     -d '{"email":"someone@gmail.com"}'            # => refused
```

Flag-off check (SC-004): with `ENABLE_DEV_ENDPOINTS` unset, every call above is unreachable.

---

## Tier 2 — Headless OAuth-chain driver (no human, scripted) — SC-002, FR-017/018

```
node test/first-run/oauth-chain-driver.mjs --server $DEV
```
Expected: walks 401 challenge → protected-resource metadata → AS metadata → dynamic client
registration → PKCE authorize → (faucet browser-mode sign-in) → (auto-approve consent) →
token exchange, and finishes by calling a real MCP tool with the resulting token. Single
command; re-runnable after any change as a regression check.

---

## Tier 3 — Unattended in-pod rehearsal (the tuning loop) — SC-001/003/008, FR-019..025

```
node test/first-run/rehearsal-harness.mjs
#  (defaults: stub bundle at test/first-run/stub-plugin, dev server, random synthetic user)
```
Expected within < 3 minutes, zero human interaction (SC-001):
1. Scratch `CLAUDE_CONFIG_DIR` created (a client that has never seen the plugin/server).
2. Stub bundle added as a local-path marketplace; plugin installed with its MCP endpoint
   pointed at the dev server via indirection (throwaway copy or env interpolation — never
   mutating the source bundle, FR-020).
3. Fresh synthetic user minted.
4. Claude Code driven non-interactively (`claude -p`); consent completed via auto-approve; the
   localhost callback naturally fails and the paste-back branch is exercised (FR-023 accept 5).
5. Full transcript captured and graded per coaching-contract checklist — explicit PASS/FAIL per
   item (SC-008). With the stub, most items FAIL by design; the planted marker PASSes, proving
   the grader detects both (RBD-8). The M1 outcome is "harness runs end to end + accurate grade
   report", NOT clean passes (those are M2).

State-bleed check (SC-003): run the harness twice; run 2 must get a genuinely new user and
pristine client state — verify no cached MCP token, no marketplace, no leftover rows from run 1.

---

## Production reset (human self-test capability) — SC-005, FR-010

```
# admin-authenticated, in production; NO target parameter exists
curl -sX POST https://squiredocs.com/auth/prod-reset-selftest-account -b "$ADMIN_COOKIE"
#  => resets ONLY selftest@example.com to first-run; idempotent no-op if already reset
```
Inspection check (SC-005): the endpoint accepts no user id / email / wildcard / list — the sole
target is the hardcoded constant. Non-admin caller ⇒ rejected.

---

## M1 exit demonstration (FR-025, SC-001)

The single command `node test/first-run/rehearsal-harness.mjs` produces a pristine first-run
environment (fresh account + pristine client state + installed plugin pointed at the dev
server) in under 3 minutes with zero human interaction, and emits a graded transcript.
Human-in-the-loop remains only where a browser inherently is — i.e. nowhere in the synthetic
tiers; the real-browser prod walk is M2's exit, on top of the reset capability shipped here.

---

## T030 verification log (implement, 2026-07-22)

All quickstart validations were run and pass. **Note on the target server:** the pod's
`:3001` dev server runs stale pre-029 code via mutagen sync, so verification used a
freshly-booted 029 server instance (`server/index.js`) on port `3051` against the per-agent
test DB `collab_test_db_029` with `ENABLE_DEV_ENDPOINTS=1`. Results:

- **Tier-1 suite green**: `first-run.test.js` (7) + `faucet-wipe.test.js` (23) +
  `auto-approve.test.js` (3) + `prod-reset.test.js` (6) all pass; full backend suite
  **214 suites / 3663 tests pass** (no regressions), client **62 files / 758 tests pass**,
  `npm run build` succeeds.
- **Faucet/wipe smoke**: fresh JSON mints distinct `test+<nonce>@test.local`; browser mode
  sets cookies + 302; wipe removes the user + all doc content; non-synthetic refused.
- **Tier-2 driver**: completed all 10 steps headlessly and authenticated a real
  `list_documents` MCP tool call with the exchanged agent token.
- **Tier-3 harness**: full `claude -p` rehearsal completed in **~8s (< 180s, SC-001)**;
  pristine scratch config + throwaway bundle (source untouched) + fresh synthetic user +
  unattended consent via auto-approve; transcript graded **1/7** (the planted marker PASSes,
  the six M2-content items FAIL — exactly as designed, RBD-8). State-bleed check passes
  (distinct users, distinct scratch dirs, zero residual synthetic rows).
- **Prod reset**: admin-only, no target parameter, resets only the hardcoded account,
  idempotent — confirmed by test + endpoint-inventory audit (T028).
