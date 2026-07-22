# Promotion notes — 031-first-run-consent-collapse

Relaxations, surfaced sharp edges, and review carry-forwards owed at promotion.
This feature adds an inline OAuth auto-issue that skips the explicit consent card
for genuine first-run accounts, so the adversarial security review pass (per the
design amendment) is a hard gate before this ships.

## RESOLVED — adversarial security review (2026-07-22, Fable)

Verdict: the auto-issue gate is sound and fails closed everywhere (no pre-existing
account can hit `isNew`; no `req`-controlled params reach the code; every miss
falls closed to the consent card; delegation parity holds). ONE material finding:

- **HIGH → FIXED + RATIFIED (Sam, 2026-07-22).** The redirect breadth below was
  escalated from "accepted" to a real remote login-CSRF token-theft vector (an
  attacker's HTTPS redirect on a first-run victim's account-creating sign-in would
  auto-issue a code delivered server-side to the attacker). Fix applied: the
  auto-issue path is now **localhost-only** — a non-localhost `redirect_uri` fails
  closed to the explicit consent card. Lands the code on the victim's own machine
  (remote blast radius ≈ 0); breaks no legitimate first-run client (localhost
  loopback). Explicit-consent path unchanged (D5). Test updated:
  first-run-auto-issue.test.js T010 now asserts an HTTPS attacker redirect fails
  closed even for a fresh account, plus a localhost-still-issues case. Design
  amendment + auth contract updated to record the ratified tightening.
- **LOW** — value-copy/mobile-fold: owed human checks (below), not a code defect.

## (Historical) originally owned by the review pass — now resolved above

- **Redirect breadth on the auto-issue path (S1 / research R9 / spec Flagged gap 5 / D5)** —
  `checkRedirectUri` (server/mcp/auth/oauth-flow.js:13) accepts ANY localhost OR
  HTTPS redirect_uri for an auto-registered client (empty allow-list). On the
  explicit consent card a human sees and judges that redirect URL; on the new
  auto-issue path **no human eyeball reviews it**. Validation is UNCHANGED per D5,
  and this does NOT widen the blast radius beyond FR-008's ceiling (a token bound
  to the just-created, zero-document account this flow itself created — never an
  existing account's data). The exposure is documented in-code at the auto-issue
  call site (server/auth/routes.js, in the `if (user.isNew === true)` branch of
  `completePostAuth`).
  - **Proposed tightening for ratification (NOT applied)**: restrict the
    auto-issue path specifically to **localhost-only** redirect URIs (i.e. reject
    the HTTPS-any case when minting inline without a human review), falling closed
    to the explicit consent card for any non-localhost redirect. A first-run agent
    connect almost always uses a localhost loopback callback, so this would cost
    little in practice while removing the no-human-eyeball HTTPS-any case from the
    unattended mint. The review pass owns this decision.

## LOW / accepted — noted, not fixed

- **E1 — 512-char returnTo cap vs long redirect_uri (routes.js `isValidReturnTo`)**:
  the server-bound `oauth_return_to` cookie is only set when the returnTo is
  ≤ 512 chars. A pathological authorize request with a very long `redirect_uri`
  (or extra params) could exceed the cap, drop the cookie, and thus silently
  prevent auto-issue — the user falls to standard browser onboarding. No
  regression vs today (029 measured 364–426 chars worst-case, comfortably under
  the cap); the collapse does not change the cap. Re-measure if a future client
  inflates authorize URLs. Not fixed.

## Structural / design invariants held (for the reviewer's checklist)

- Auto-issue reads OAuth parameters EXCLUSIVELY from the cookie-derived returnTo
  via `tryParseAuthorizeReturnTo(rawReturnTo)`; `completePostAuth` never receives
  `req`, so params cannot originate from `req.query`/`req.body`/headers after auth
  (INV-3, structurally guaranteed; tested in first-run-auto-issue.test.js case d).
- Gate fires only on `user.isNew === true` (the `xmax=0` INSERT outcome) — never
  account age/emptiness/session (INV-1). Every miss FAILS CLOSED to the existing
  consent redirect; a thrown `approveAuthorization` is caught and also falls
  closed (INV-4), never a 500 dead-end.
- Minting reuses the shared `approveAuthorization` core — no parallel mint path
  (INV-2/INV-6); PKCE + redirect validation are the byte-for-byte same validators
  the explicit Approve click and dev-consent-approve drive.

## Human acceptance still owed

- Sam's production self-test (real Google leg): reset the self-test account, walk
  a genuine first-run agent connect in a real browser, confirm ONE Squire screen
  and a completed connection with no consent card; then connect a second agent on
  the now-existing account and confirm the explicit consent card returns.
- Manual mobile-viewport visual check of the enriched first-run surface (SC-007):
  transparency copy primary, value reminder subordinate, "Continue with Google"
  above the fold on common mobile viewports.
- Tone/marketing-copy sign-off on the first-run grant + value-reminder copy.
