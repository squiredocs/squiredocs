# Clarifications — 031-first-run-consent-collapse

No user interaction was available during specification. Each decision below was
taken with the best default and is marked **RATIFIED-BY-DEFAULT (Sam
pre-authorized, 2026-07-22)**. Overturn any of them by amending the spec before
planning/implementation.

## D1 — Post-auto-issue landing surface

**Question**: After the inline auto-issue, should the browser show a Squire
"Authorized — this window will close" interstitial before/instead of landing on
the agent's callback URL?

**Decision**: No interstitial. The server redirect chain lands the browser
directly on the agent's callback (which typically tells the user to return to
the terminal). An interstitial would be a second Squire screen, defeating the
amendment's "first-run = 1 screen" goal.

**RATIFIED-BY-DEFAULT (Sam pre-authorized, 2026-07-22)**

## D2 — Enforceable meaning of "validated and matched"

**Question**: The amendment requires the return to carry "the OAuth parameters
of THIS authorize request… validated and matched." There is no server-side
pending-authorize record to match against. What is the binding?

**Decision**: The server-bound round-trip state — the httpOnly, same-origin-
validated, bounded-TTL return-destination cookie set when the flow enters
Google sign-in — is the sole accepted source of the OAuth parameters for
auto-issue, and those parameters are re-validated with the standard authorize
validation on return (FR-005). No new pending-request ledger is invented by
this feature; if planning or the adversarial review finds cookie binding
insufficient, a pending-request record is the escalation path (spec Flagged
gaps note 1).

**RATIFIED-BY-DEFAULT (Sam pre-authorized, 2026-07-22)**

## D3 — Matched parameter set includes the PKCE challenge method

**Question**: The amendment's security-floor list names client_id,
redirect_uri, code_challenge, state — omitting code_challenge_method, which
the request carries (default S256) and the flow stores/validates today.

**Decision**: Include code_challenge_method in the matched/validated set —
the stricter reading; the amendment's list is shorthand, and the task's
parameter list includes it.

**RATIFIED-BY-DEFAULT (Sam pre-authorized, 2026-07-22)**

## D4 — No Deny affordance on the collapsed first-run screen

**Question**: The consent card had Approve/Deny. The single first-run screen
has only "Continue with Google." Should a Deny/decline control be added?

**Decision**: No. Declining first-run is abandoning before Google sign-in —
no account is created, nothing is granted, the agent's normal timeout applies.
The enriched grant copy (FR-009) is the informed-consent compensator. Existing
accounts keep the explicit Approve/Deny card.

**RATIFIED-BY-DEFAULT (Sam pre-authorized, 2026-07-22)**

## D5 — Redirect-target rules for auto-registered clients stay unchanged

**Question**: Auto-registered clients accept any localhost or HTTPS redirect
target; the consent card let a human eyeball the URL, but the auto-issue path
has no human. Tighten redirect rules for the auto-issue path?

**Decision**: Keep validation unchanged, exactly as the amendment states
("PKCE and redirect_uri validation are unchanged"). The isNew gate already
caps blast radius at a token on a just-created empty account (FR-008). The
mandated adversarial security review pass owns any tightening proposal (spec
Flagged gaps note 5).

**RATIFIED-BY-DEFAULT (Sam pre-authorized, 2026-07-22)**

## D6 — Rehearsal-matrix "declined consent" cell retarget

**Question**: The matrix's declined-consent cell clicks Deny on the consent
card, which a first-run user no longer sees. How should the cell evolve?

**Decision**: First-run decline becomes abandon-before-sign-in; the explicit
Deny exercise moves to (or remains in) the existing-account flow, which keeps
the card. Folded into FR-013 alongside the connect-cell screen-count update.

**RATIFIED-BY-DEFAULT (Sam pre-authorized, 2026-07-22)**
