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
  the bounded synthetic namespace pattern `/^test\+[a-z0-9-]{1,32}@test\.local$/`. Any other
  session is refused. No separate flag/table — the namespace IS the boundary, identical rule to
  the wipe. Single-sourced as `SYNTHETIC` + `isSyntheticEmail()` in `server/auth/users.js`
  (I1 reconciliation — one code location; the bounded form matches contracts + tasks.md).
- **Rationale**: One boundary, two enforcers. Reusing the real approve path keeps the code
  actually exercised end to end rather than a parallel mock.
- **Implement note**: factor the approve core so the dev endpoint calls it after the namespace
  check, rather than duplicating code-mint logic. Confirm what request fields `handleApprove`
  needs (client_id, redirect_uri, state, code_challenge, scope) and that the auto-approve can
  reconstruct/carry them from the pending authorize request.

## R3 — Reset cascade: what "everything hanging off the row" means (FR-008, FR-010)

- **Decision**: Hard-delete is a transaction that (1) enumerates the user's owned/created doc
  ids, (2) explicitly sweeps the non-cascading doc-keyed content, (3) deletes those `documents`
  rows (cascading their FK dependents), then (4) `DELETE FROM users WHERE lower(email)=lower($1)`
  (cascading the user's own FK dependents). A plain single `DELETE FROM users` is NOT sufficient
  — see the verified drift below.
- **VERIFIED against the live schema 2026-07-22 (U1 reconciliation — corrects the stale claim
  that `documents.owner_id` cascades):**
  - `documents.owner_id` **no longer exists**. Migration `006_add_role_to_shares.js:28-29`
    DROPPED `owner_id`; ownership now lives in `document_shares` rows with `role='owner'`
    (`document_shares.user_id → users` CASCADE). The remaining user link on `documents` is
    `creator_id → users` **ON DELETE SET NULL** (`007_add_creator_to_documents.js:14` — "keep
    doc even if creator is deleted"). **⇒ deleting a user does NOT delete their documents; the
    doc row is orphaned (creator nulled, owner-share cascade-deleted).**
  - Because the `documents` row survives a plain user delete, everything FK'd to `documents(id)`
    with CASCADE (`document_embeddings`, `document_images`, `document_search_index`,
    `document_share_invites`, `document_shares`) ALSO survives.
  - `yjs_updates` (the CRDT **content**, keyed by `doc_guid = documents.id`) has **no FK to
    documents at all** — only `yjs_updates.user_id → users` SET NULL. ⇒ content survives both a
    user delete AND a documents delete unless swept explicitly by `doc_guid`.
  - `document_versions.doc_id` has **no FK to documents** either (only `created_by → users`
    SET NULL). ⇒ version rows survive a documents delete unless swept explicitly by `doc_id`.
  - `agent_edits.doc_guid` / `agent_activity_log.doc_guid` — the user's own rows cascade via
    `user_id → users` CASCADE; swept by `doc_guid` as belt for completeness.
- **Confirmed cascades on `DELETE FROM users` (correct, no sweep needed)**: `agent_activity_log`,
  `agent_delegations`, `agent_edits`, `ai_extra_credits.user_id`, `ai_usage_log`, `chats`,
  `document_shares.user_id`, `mcp_api_tokens`, `mcp_auth_codes`, `support_requests`.
- **Registered OAuth *client* rows are NOT user-scoped**: `registered_agents` has **no
  `user_id` column** (dynamic client registration is global/shared, e.g. one "Claude Code"
  client row shared across users). `agent_delegations.agent_client_id → registered_agents`
  SET NULL. ⇒ the user's *grants* (`agent_delegations`, `mcp_auth_codes`) cascade-die with the
  user; the global client registration correctly persists and is NOT swept.
- **Preserved-by-design (SET NULL, attribution — correct to keep)**: `yjs_updates.user_id`,
  `document_versions.created_by`, `document_images.uploader_id`,
  `document_share_invites.invited_by_user_id`, `agent_activity_log.doc_guid`. Moot for the
  user's own docs which are deleted outright.
- **`deleteUserByEmail` algorithm (drives T007)**: in one transaction —
  `docIds := SELECT id FROM documents WHERE creator_id=uid UNION SELECT doc_id FROM
  document_shares WHERE user_id=uid AND role='owner'`; then
  `DELETE FROM yjs_updates WHERE doc_guid = ANY(docIds)`,
  `DELETE FROM document_versions WHERE doc_id = ANY(docIds)`,
  `DELETE FROM agent_edits WHERE doc_guid = ANY(docIds)`,
  `DELETE FROM agent_activity_log WHERE doc_guid = ANY(docIds)`,
  `DELETE FROM documents WHERE id = ANY(docIds)` (cascades embeddings/images/search/shares/
  invites), `DELETE FROM users WHERE lower(email)=lower($1)` (cascades the rest). Idempotent.
- **Edge note (NO ACTION, not handled)**: `ai_extra_credits.granted_by → users` is NO ACTION —
  if the target user had *granted* credits to others (admin action; never true for a synthetic
  or the dataless self-test account) the user DELETE would raise. Out of scope for these targets.
- **Rationale**: FK cascades cover the user-keyed rows; the explicit doc-content sweep covers
  exactly the tables the schema does NOT cascade (`yjs_updates`, `document_versions`, orphaned
  `documents`), which is what "genuine first run, no residue" (U1, T017) actually requires.

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
- **AUDIT RESULT (T020, 2026-07-22)**: the only functional client consumers of welcome/
  onboarding state are (1) the landing gate `client/src/App.jsx:239` —
  `if (user && user.onboarded === false && user.welcomeDocId) navigateToWelcome(...) else
  navigateToDocs()` — which SHORT-CIRCUITS on `&& user.welcomeDocId`, so a null welcome doc
  falls through to the doc list (no error, no broken redirect, no stuck onboarding prompt);
  and (2) the `?welcome=1` greeting effect (`App.jsx:332`), reachable ONLY via
  `navigateToWelcome`, which is itself only called from the guarded branch — so it never sees
  a null doc. `AuthContext` does not gate on `welcomeDocId`; `/auth/me` returns it as `null`
  cleanly (server side covered by first-run.test.js). **No client surface misbehaves; no fix
  was needed.** The server-side null-welcome contract is asserted in the tier-1 suite (FR-015d).

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
- **MEASUREMENT (G1, taken 2026-07-22, BEFORE finalizing the tier-2 driver T016):** the
  `returnTo` carried through `/auth/google` is the **consent-page URL** (`/authorize?...`) built
  by `handleAuthorize`'s `consentParams` (agent_client_id, agent_instance_id, scope,
  redirect_uri, state, code_challenge S256=43 chars, code_challenge_method, existing_delegation).
  Measured against realistic Claude Code / claude.ai OAuth params (client_id `client_`+32hex,
  state 64hex, code_challenge 43-char base64url):
  - claude.ai remote callback (`https://claude.ai/api/mcp/auth_callback`): **374 chars**
  - localhost loopback callback (`http://localhost:PORT/callback`): **364 chars**
  - worst case (populated `agent_instance_id` UUID + longer loopback path w/ query): **426 chars**
- **DECISION**: **keep the 512-char cap unchanged.** Worst case (426) clears it with ~86 chars
  of headroom; typical is ~140 chars of headroom. Neither raising the cap nor carrying OAuth
  params server-side is warranted — doing either would add surface area for no benefit. The cap
  is not a silent-failure risk for the real Claude Code authorize URL. Same-origin validation on
  `isValidReturnTo` (routes.js:81-94) is retained exactly as-is.

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
- **ENDPOINT INVENTORY AUDIT (T028, 2026-07-22, SC-004/SC-005)**: grep of `server/auth/routes.js`
  confirms exactly FOUR synthetic endpoints behind `requireDevEndpoints` (positive flag + belt):
  `POST /auth/dev-login`, `POST /auth/dev-onboarding-reset`, `POST /auth/dev-wipe-user`,
  `POST /auth/dev-consent-approve` — each returns `404` when the flag is unset OR `NODE_ENV`
  is production-like (test-covered in faucet-wipe/auto-approve/first-run suites). The ONLY
  feature-029 endpoint reachable in production is `POST /auth/prod-reset-selftest-account`,
  gated by `requireAdmin` and deliberately NOT by `ENABLE_DEV_ENDPOINTS` (FR-002), with a
  hardcoded single-target and no request-body targeting (prod-reset suite, SC-005). Audit passes.

## Consolidated open verifications (carried to implement, none blocking)

1. Whether `yjs_updates` content rows and dynamic OAuth client rows cascade on user delete, or
   need explicit teardown in the reset helper (R3).
2. Exact request fields `oauth-flow.handleApprove` needs so auto-approve can reconstruct them
   from the pending-authorize record (R2).
3. Real Claude Code authorize-URL `returnTo` length vs the 512 cap → raise-cap-or-server-side
   decision, recorded here (R7 / FR-016).
4. Whether Claude Code `.mcp.json` supports env interpolation for the endpoint (R8) — fallback
   templating works regardless.
