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
