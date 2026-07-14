# Promotion Notes: 005-agent-onboarding

Populated during implementation. Items the merge queue / reviewer / maintainer
should know. Nothing here blocks merge; all decisions have a documented default.

## RATIFIED-BY-DEFAULT decisions to surface to Sam

- S1–S3 (Sam's own, 2026-07-13) and D1–D6 in `clarifications-needed.md`
  (pre-authorized defaults). No schema changes are expected in this feature.

## Spec-phase notes

- (none yet — spec phase raised no deviations; deviations, if any, get appended
  by plan/implement phases)

## Plan-phase notes (2026-07-14)

- **D5 TTL fixed at 10 minutes.** Cookie `oauth_return_to`, upper mid of D5's
  5–15 min band — covers slow Google logins and password-manager prompts
  without meaningfully extending the replay window; documented in
  `research.md` §R1 and `contracts/returnto-continuation.md`. This closes the
  D5 "fix at plan time" open item.
- **FR-003 drift-guard mechanism: automated test** (choice recorded in
  `research.md` §R6). Implementation is
  `server/__tests__/agents-md-claims.test.js` (task T020), grep-level
  assertions on the shipped `agents.md` — cheap, deterministic, catches the
  exact drift class flagged. Considered a checklist entry (rejected as easy
  to forget in solo workflow). The design doc's "drift is a bug" bullet
  could optionally name this test file in a future amendment; not required.
- **Analyze findings (2026-07-14, all LOW/MEDIUM, none blocking)**:
  - C1 (MEDIUM): FR-008 (`resource=` accepted+ignored on token endpoint) has
    no automated test. Optional add: a one-line supertest case in
    `oauth-discovery.test.js`. Not blocking.
  - C2, C3, C4, C5, C6, C7, C8 (LOW): informational — see analyze report in
    session log. No follow-up required for merge; C8 (loosen the
    `default portable` regex to survive markdown emphasis changes) is worth
    a two-line tweak at implement time.
- **No DB migration required.** If implementation discovers one is needed,
  STOP and escalate.

## Post-merge review dispositions (2026-07-14, verdict: ship, 0 CRIT/HIGH/MED)

- **LOW-1 — FIXED same-day** (`server/auth/routes.js`): `oauth_return_to`
  capture+clear hoisted above the state/error/no_code exits so an abandoned
  OAuth attempt can't leave a stale continuation that hijacks the next
  login's landing destination within the 10-min TTL. Same-origin only; was a
  UX wart, not a redirect vector.
- **LOW-2 — FIXED same-day** (contract doc): `www-authenticate-challenge.md`
  said `realm="mcp"`; implementation and tests use `realm="Squire Docs MCP"`.
  Contract aligned to implementation (realm is ignored by clients).
- **LOW-3 — ACCEPTED, owed at promotion**: `oauth-discovery.test.js` (a)/(b)
  re-declare the well-known handlers inline instead of exercising the real
  routes, because `server/index.js` calls `app.listen` unconditionally on
  require and does not export `app`. Owed: extract app creation from
  `server/index.js` (or export `app` behind a listen guard) so metadata
  routes can be supertest-mounted; then rewrite tests (a)/(b) against the
  real handlers. Challenge-header tests (c)–(g) already exercise the real
  middleware, so exposure is metadata-JSON drift only.
- Analyze C1 (MEDIUM) closed by implementation: RFC 8707 `resource=`
  accepted-and-ignored is asserted in `oauth-discovery.test.js`.
- Reviewer verified all agents.md claims against code (lens 4) — no drift at
  merge time.

## Post-merge amendments (2026-07-14, onboarding feedback rounds)

- **Amendment: in-session connect caveat + OAuth walkthrough guidance +
  authorize-link shortener** (design: agent-surface-mcp, three bullets dated
  2026-07-14). agents.md gained user-facing connect/restart steps and the
  shorten-then-present auth flow; server gained `POST /mcp/auth/shorten` +
  `GET /mcp/auth/a/:code` (`server/mcp/auth/short-links.js`).
- **ACCEPTED, owed at promotion — no rate limit on `/mcp/auth/shorten`**:
  unauthenticated endpoint writes ~600-byte TTL'd redis values. Abuse value
  is low (same-origin-only redirects, 10-min expiry) but a flood could
  churn redis; add the app's standard rate limiting if/when one exists, or
  a per-IP cap. `oauth-shorten.test.js` mounts the handler wiring inline
  (same LOW-3 root cause: `server/index.js` doesn't export `app`).
