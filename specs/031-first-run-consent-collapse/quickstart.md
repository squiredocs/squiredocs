# Quickstart / Validation Guide: First-Run Consent Collapse

Run inside the app-dev pod (see docs/dev.md). Backend Jest suite is serial against the shared DB — never run concurrent backend runs. Dev endpoints require `ENABLE_DEV_ENDPOINTS=1`.

## Prerequisites

- Dev server on `http://localhost:3001` with `ENABLE_DEV_ENDPOINTS=1` (faucet + dev-consent-approve reachable).
- PostgreSQL migrations current (no new migration for this feature; latest is `1799300000000`).

## Scenario 1 — First-run collapse, end to end (SC-001, SC-005, FR-003)

Headless proof that a freshly-created account's authorize round-trip yields a code and a working token WITHOUT any consent-approval call:

```
node test/first-run/oauth-chain-driver.mjs --server http://localhost:3001 --first-run
```

Expected: the driver drives the faucet **browser** mode with `returnTo` = the `/authorize?…` URL, receives a **302 to the agent callback carrying `code` + `state`**, completes token exchange, and authenticates a real MCP `list_documents` call — with **no call to `/mcp/auth/approve` or `/auth/dev-consent-approve`**. Exit 0.

## Scenario 2 — Existing account still requires explicit approve (SC-002, SC-003, FR-004/FR-007)

Counter-assertion (tier-1 Jest is the deterministic home; the chain driver's companion mode also asserts it):

- Re-sign-in a stable-nonce faucet identity so `isNew=false`, with the same valid authorize returnTo.
- Expected: **302 to the returnTo (consent page), NO `code`**, no row in `mcp_auth_codes`. The explicit approve is still required.

```
# backend integration
npm test --prefix server -- auto-issue        # or the path the tests land in
```

## Scenario 3 — Fail-closed matrix (FR-005, FR-010)

Backend integration cases, each asserting NO code minted + redirect to the returnTo:

- fresh account, returnTo path is a plain in-app path (not `/authorize`) → normal redirect, no code.
- fresh account, `/authorize` returnTo with malformed `code_challenge` → consent fallback, no code.
- fresh account, `/authorize` returnTo with a `redirect_uri` `checkRedirectUri` rejects → consent fallback, no code.
- fresh account, divergent `req.query` vs cookie params → minted code (if any) reflects COOKIE params only (FR-005 INV-3); tampered query ignored.

## Scenario 4 — Phishing blast-radius ceiling (FR-008, SC-003)

Explicit test: an attacker-controlled `client_id` + attacker `redirect_uri`, victim has a **pre-existing** account, signs in during the flow → `isNew=false` → **no code**, ConsentCard shown naming the attacker's client. Assert zero delegations minted for the victim without an explicit approve. This is a required automated test.

## Scenario 5 — Provenance + welcome-doc guards stay green (FR-011)

Run the existing 029/030 provenance + welcome-doc-skip tests unchanged; assert the auto-issue path still stamps `signup_source='agent_oauth'` and seeds no welcome doc.

## Scenario 6 — Rehearsal matrix (FR-013, D6)

```
node test/first-run/matrix-runner.mjs        # or the suite's matrix entrypoint
```

Expected: connect cells assert first-run connect = **1 Squire screen**; the declined-consent cell is retargeted (first-run decline = abandon-before-sign-in; explicit Deny remains with the existing-account/card cells). Any coaching-contract checklist lines referencing the old three-screen shape are updated.

## Scenario 7 — Copy + mobile fold (FR-009, FR-014, SC-006, SC-007) — manual

- Load the unauthenticated `/authorize?…` surface for a write-scoped request and a read-only request.
- Assert: grant statement matches scopes (write = read + create/edit/delete; read-only narrower), revocation line present, "Squire Docs" naming, 2–3 value lines from the verified messaging only, transparency visually first.
- On a common mobile viewport, assert "Continue with Google" is above the fold. Feeds the tone sign-off (owed).

## Human acceptance (owed, per ratified testing design)

Sam's production self-test: reset `selftest@example.com` (or the configured self-test account) → real browser walk of the agent connect → confirm exactly one Squire screen for first-run and the agent connects. This is the acceptance gate for the real Google leg.
