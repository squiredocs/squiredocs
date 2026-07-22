# Phase 0 Research: First-Run Test Mechanism (Plugin M1)

All product-decision unknowns were resolved as RATIFIED-BY-DEFAULT (RBD-1..RBD-10) in
`clarifications-needed.md` during spec authoring. This file records the *technical*
research: verified code facts, mechanism choices, and the implement-time verifications the
design explicitly deferred. No open NEEDS CLARIFICATION remains.

## R1 — Fresh-user faucet on the existing dev-login (FR-003, FR-004)

- **Decision**: Extend the existing `POST /auth/dev-login` (server/auth/routes.js ~:416-461)
  rather than add a new endpoint. `fresh: true` in the body switches the minted profile from
  the fixed `dev@test.local` to `test+<nonce>@test.local` (googleId `dev-test-<nonce>`). A
  `browser: true` (or a `?returnTo=` presence) switches the response from JSON to a
  cookie-set + 302 redirect honoring a validated same-origin `returnTo`.
- **Rationale**: The design names this endpoint by contract ("Extend `POST /auth/dev-login`").
  One endpoint, three modes (fixed JSON / fresh JSON / fresh browser-redirect) keeps the
  faucet single-sourced. Reuses `isValidReturnTo` (routes.js:81-94, verified 512-char + same-
  origin) unchanged.
- **Nonce (RBD-3)**: server generates short random hex when `fresh:true` and no nonce given;
  an explicit `nonce` (validated `/^[a-z0-9-]{1,32}$/`) yields a stable identity (find-or-
  create makes a reused nonce a re-login). Response echoes the minted email/nonce.
- **Provenance path (RBD-10)**: browser mode must route through the SAME server logic the
  Google callback uses for account creation, provenance stamping, welcome-doc decision, and
  returnTo handling — it substitutes ONLY the identity leg. See R5.

## R2 — Consent auto-approve (FR-006, FR-007)

- **Decision**: A dev-only endpoint reusing `server/mcp/auth/oauth-flow.js` `handleApprove`
  logic to complete the `/authorize` Approve step and mint the authorization code for a
  synthetic session, no browser click. Verified `oauth-router.js:29` mounts
  `POST /approve` behind `requireAuth` with `oauthFlow.handleApprove`.
- **Synthetic-session recognition (RBD-1)**: the authenticated session user's email must match
  the synthetic namespace pattern `^test\+[a-z0-9-]+@test\.local$`. Any other session is
  refused. No separate flag/table — the namespace IS the boundary, identical rule to the wipe.
- **Rationale**: One boundary, two enforcers. Reusing the real approve path keeps the code
  actually exercised end to end rather than a parallel mock.
- **Implement note**: factor the approve core so the dev endpoint calls it after the namespace
  check, rather than duplicating code-mint logic. Confirm what request fields `handleApprove`
  needs (client_id, redirect_uri, state, code_challenge, scope) and that the auto-approve can
  reconstruct/carry them from the pending authorize request.

## R3 — Reset cascade: what "everything hanging off the row" means (FR-008, FR-010)

- **Decision**: Hard-delete is a single `DELETE FROM users WHERE lower(email) = lower($1)`
  relying on existing FK cascades, with explicit cleanup of any non-FK-linked artifacts.
- **Verified cascades (ON DELETE CASCADE → users(id))**: `documents.owner_id`
  (migrations/004:16-21), `chats.user_id`, `mcp_agent_delegations` (010), MCP auth tables
  (011), `mcp_api_tokens` (1773172617959), `ai_usage`, `ai_extra_credits`, `support_requests`,
  `document_shares.user_id`. So deleting the user row cascades to owned documents, and owned
  documents cascade to their own dependents.
- **Preserved-by-design (ON DELETE SET NULL)**: `yjs_updates.user_id` (009 — attribution),
  version-history author refs, `users.welcome_doc_id` (1783 — SET NULL, moot when the whole
  user row is deleted). These are attribution nullers, correct to keep.
- **Implement-time VERIFY (flagged, not blocking)**: `yjs_updates` / document *content* is keyed
  by `doc_guid`, not necessarily an FK to `documents(id)`. Confirm at implement time whether
  deleting the `documents` row cascades the CRDT content rows, or whether the reset must also
  delete `yjs_updates` for the owned doc guids. Likewise confirm registered OAuth *client*
  rows (dynamic client registration) are user-scoped and cascade. If not, the delete helper
  must enumerate and remove them in the same transaction. This is a correctness detail for
  "genuine first run," surfaced here so implement doesn't miss it.
- **Rationale**: Reusing FK cascades is the least-code, hardest-to-drift teardown; the explicit
  sweep covers only what the schema doesn't cascade.

## R4 — signup_source schema (FR-012, RBD-6, RBD-7)

- **Decision**: One node-pg-migrate migration `1799300000000_add-signup-source-to-users.js`
  adding `signup_source TEXT NOT NULL DEFAULT 'browser'` with
  `CHECK (signup_source IN ('browser','agent_oauth'))`.
- **Timestamp**: current latest migration is `1799200000000_drop-yjs-state-vectors.js`
  (verified in repo-root `migrations/`). `1799300000000` > latest, satisfying node-pg-migrate
  checkOrder and trivially clearing the stale `>1795000000000` floor (RBD-7).
- **Existing rows**: take the `browser` default — accepted imprecision (pre-feature agent-born
  accounts read `browser`; D5 acknowledges backfill is impossible).
- **Down migration**: `dropColumns('users', ['signup_source'])`.

## R5 — Provenance stamping + welcome-doc skip through the shared path (FR-012, FR-013, RBD-10)

- **Verified**: Google callback (routes.js:201) calls `findOrCreateUser(profile)`; the
  consent returnTo branch (routes.js:223-225) `return res.redirect(...)` BEFORE the
  welcome-doc seeding block (routes.js:229-237). So consent-born accounts already skip the
  welcome doc — today by accident. `rawReturnTo` is captured from the `oauth_return_to` cookie
  set on the outbound `/auth/google` leg (routes.js:116-118, 167).
- **Decision**: `findOrCreateUser` gains a `signupSource` argument (default `'browser'`) that
  is written ONLY on insert (never on the ON CONFLICT update — provenance is stamped once, at
  creation). The callback passes `agent_oauth` when a valid `returnTo` is present at account
  creation, `browser` otherwise. The browser-mode faucet passes through this exact code path,
  so the tests exercise production behavior, not the faucet (RBD-10).
- **Welcome-doc skip made load-bearing**: the existing early `return` on the returnTo branch is
  kept and now documented + test-covered as deliberate. No behavioral change to the redirect;
  the change is intent + coverage.
- **Stamp-once mechanism**: because `findOrCreateUser` is an upsert (`ON CONFLICT DO UPDATE`),
  set `signup_source` only in the INSERT column list and NOT in the `DO UPDATE SET` clause, so
  a returning user's provenance is never overwritten by a later login.

## R6 — Null-welcome-doc client contract (FR-014)

- **Decision**: Audit client surfaces that read welcome/onboarding state
  (`welcomeDocId`, `onboarded`, the `?welcome=1` / `?signup=1` redirects, AuthContext, any
  welcome-doc gate) and assert none error, break redirects, or stick on an onboarding prompt
  when `welcomeDocId` is null. Covered by a tier-1 assertion (FR-015d) plus a client-side check.
- **Rationale**: agent-first accounts legitimately have null welcome docs; the design says
  "verify at implement time that no client surface misbehaves." Making it test-covered turns
  the accidental behavior into a guaranteed contract.

## R7 — returnTo length budget measurement (FR-016, finding M4)

- **Decision**: Measure a REAL Claude Code authorize URL's `returnTo` payload (the consent-page
  path carrying PKCE `code_challenge`, `state`, `redirect_uri`, client id) against the 512-char
  cap. Record the measured length and the decision in this feature's artifacts (append to this
  research.md at implement time).
- **If near/over cap**: raise the cap (retain same-origin validation) OR carry the OAuth params
  server-side (e.g. keyed by the pending-authorize record) instead of in `returnTo`. Server-side
  carry is preferred if the measurement is marginal, because it removes the cap as a silent
  failure mode entirely.
- **Why now**: the M2 rehearsals will drive real authorize URLs; a silently-dropped cookie
  would make the agent never receive its code. FR-016 exists to catch this before M2.
- **Status**: measurement is an implement-time task; the cap is 512 today (verified routes.js:83).

## R8 — Endpoint indirection for the harness (FR-020, finding M3)

- **Decision**: The harness points the plugin's `.mcp.json` endpoint at the dev server WITHOUT
  mutating the source bundle. Preferred: env interpolation in `.mcp.json` if Claude Code
  supports it (VERIFY at implement time). Fallback: the harness copies the stub bundle to a
  throwaway temp dir and templates the endpoint there.
- **Rationale**: The design mandates "never mutate the source bundle." For the M1 stub the
  fallback (throwaway copy) is trivially safe and always works, so the harness can ship the
  fallback first and adopt env-interpolation if verified — either satisfies FR-020.

## R9 — Stub plugin bundle (FR-021, RBD-9)

- **Decision**: A minimal installable bundle under `test/first-run/stub-plugin/` (NOT
  `distribution/`): `.claude-plugin/plugin.json` (name `squire` for `/squire:*` namespacing),
  `.claude-plugin/marketplace.json` (local-path marketplace), `.mcp.json` (dev endpoint via
  indirection), `skills/squire/SKILL.md` and `commands/onboard.md` as clearly-marked
  placeholders ("SCAFFOLDING FOR TESTING — real content is M2").
- **Grader-provability (RBD-8)**: the placeholder command SHOULD include exactly one
  trivially-gradable marker (e.g. one correct coaching line) so the grader can demonstrate it
  detects a PASS as well as the expected FAILs — proving the grading mechanism, which is M1's
  deliverable. Full checklist passes are M2's exit.
- **Rationale**: scaffolding, parameterized path, ready for the real `distribution/claude-plugin`
  with zero rework when M3 creates it.

## R10 — Non-interactive Claude Code driving + pod realities (FR-022, FR-024, finding M6)

- **Decision**: Drive Claude Code with `claude -p` (non-interactive prompt mode) against a
  scratch `CLAUDE_CONFIG_DIR`. Complete consent via the auto-approve endpoint (the synthetic
  user has no real browser). Capture the full transcript for grading.
- **Pod is a feature**: in the Linux dev pod the localhost OAuth callback naturally fails,
  exercising the remote paste-back branch by default (FR-023 / acceptance).
- **macOS out of scope (M6)**: on macOS Claude Code stores OAuth creds in the Keychain, which a
  scratch config dir does not clear — so pristine rehearsals are Linux-pod-only. The harness
  DOCUMENTS this; a Keychain-purge step MUST NOT be built (FR-024).
- **State bleed (SC-003)**: each run uses a fresh scratch config dir AND a fresh synthetic user
  (random nonce); run N+1 must see zero artifacts of run N. Cleanup between runs via the
  synthetic wipe + config-dir removal.

## R11 — Gating (FR-001, FR-002, RBD-5)

- **Verified**: existing dev routes gate on
  `process.env.ENABLE_DEV_ENDPOINTS === '1' && process.env.NODE_ENV !== 'production'`
  (routes.js:416) — the 2b9d6be fix. The dev/staging overlay already sets
  `ENABLE_DEV_ENDPOINTS=1`.
- **Decision**: All synthetic endpoints (faucet fresh/browser modes, auto-approve, synthetic
  wipe) sit inside this same positive-flag-AND-negative-belt guard (RBD-5). The prod reset does
  NOT — it is admin-gated (`requireAdmin`) and deliberately prod-reachable (FR-002), with the
  hardcoded single-email target as its only safety surface (FR-010).
- **Test (SC-004)**: assert every synthetic endpoint 404s/refuses with the flag unset AND in a
  production-like `NODE_ENV` config.

## Consolidated open verifications (carried to implement, none blocking)

1. Whether `yjs_updates` content rows and dynamic OAuth client rows cascade on user delete, or
   need explicit teardown in the reset helper (R3).
2. Exact request fields `oauth-flow.handleApprove` needs so auto-approve can reconstruct them
   from the pending-authorize record (R2).
3. Real Claude Code authorize-URL `returnTo` length vs the 512 cap → raise-cap-or-server-side
   decision, recorded here (R7 / FR-016).
4. Whether Claude Code `.mcp.json` supports env interpolation for the endpoint (R8) — fallback
   templating works regardless.
