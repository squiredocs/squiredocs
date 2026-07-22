# Contract: Production Reset, Provenance Stamping, Welcome-Doc Skip

## 1. Production single-account reset — `POST /auth/prod-reset-selftest-account` (NEW — FR-002, FR-010, FR-014, RBD-4)

The ONE endpoint from this feature reachable in production. It is admin-gated, does NOT depend
on `ENABLE_DEV_ENDPOINTS`, and its entire target surface is a hardcoded compile-time constant.

**Auth:** `requireAdmin` (existing admin gate, server/auth/middleware.js:95 — reuse, no new
auth machinery; 008/009 lesson). Non-admin ⇒ **rejected** (Acceptance 5.3).

**Gating:** NOT behind `ENABLE_DEV_ENDPOINTS`. Deliberately prod-reachable (FR-002).

**Request body:** NONE consumed for targeting. The endpoint accepts **no** user id, email
parameter, wildcard, or config-driven list (Acceptance 5.2, FR-010). Any body is ignored for
target selection.

**Target:** the compile-time constant `PROD_RESET_ACCOUNT = 'selftest@example.com'` (D6).
The endpoint means exactly "reset the self-test account."

**Behavior:**
- Hard-delete the account matching `PROD_RESET_ACCOUNT` (and ONLY that account) with the full
  reset cascade — docs, delegations, registered OAuth clients, tokens (Acceptance 5.1). Next
  sign-in for that identity is a genuine first run.
- Idempotent: if the account does not exist (already reset), **succeed as a no-op**
  (Acceptance 5.4, FR-011).
- Worst case (audited, Acceptance 5.5): deletion of one deliberately-empty account, recoverable
  from a DB backup (heavy last-resort restore, not routine undo). This is the ONLY dev-support
  endpoint reachable in production.

**Interface safety argument (SC-005):** there is no target parameter to widen — a bug in
parameter handling cannot broaden the blast radius because parameters are not consulted for
targeting.

---

## 2. Reset cascade helper — `deleteUserByEmail(email)` (NEW, server/auth/users.js)

Shared by the synthetic wipe and the prod reset. Single hard-delete of the `users` row within a
transaction, relying on `ON DELETE CASCADE` FKs, plus explicit sweep of any non-cascading
artifacts (`yjs_updates` content rows, dynamic OAuth client rows — VERIFY at implement,
research R3). Idempotent (no row ⇒ no-op). Callers enforce their own target rules (synthetic
namespace vs hardcoded constant) BEFORE calling; the helper does not widen targets.

---

## 3. Provenance stamping (FR-012, RBD-6, RBD-10) — `findOrCreateUser`

`findOrCreateUser(profile, { signupSource })` — `signupSource` defaults `'browser'`; written
ONLY on INSERT, never on `ON CONFLICT DO UPDATE SET` (stamp-once at creation).

| Creation path | `signup_source` | Welcome doc |
|---------------|-----------------|-------------|
| Browser sign-in (no valid returnTo at creation) | `browser` | seeded (existing behavior) |
| Consent returnTo round-trip (valid same-origin returnTo present at creation) | `agent_oauth` | NONE (skip) |
| Fresh faucet, browser mode WITH valid returnTo | `agent_oauth` | NONE (routes through same path, RBD-10) |
| Fresh faucet, JSON mode / no returnTo | `browser` | per shared path |
| Pre-existing rows | `browser` (default) | unchanged |

**Contract tests (FR-015):**
- Browser-path account ⇒ `signup_source = 'browser'` (Acceptance 3.1).
- Consent-round-trip account ⇒ `signup_source = 'agent_oauth'` AND no welcome doc (Acceptance 3.2).
- Existing account ⇒ reports default `browser`, no breakage (Acceptance 3.3).

---

## 4. Welcome-doc skip made load-bearing (FR-013)

The consent returnTo branch (server/auth/routes.js:223-225) `return`s before welcome-doc
seeding (routes.js:229-237). This early return is KEPT and now documented + test-covered as
deliberate: agent-first accounts get no browser welcome doc; the first synced spec is the
welcome. No redirect behavior changes — only intent + coverage.

---

## 5. Null-welcome-doc client contract (FR-014)

For any account with `welcome_doc_id = null`, no client surface may misbehave: no errors, no
broken redirects, no stuck onboarding prompts (Acceptance 3.4). Surfaces to audit: the
`welcomeDocId`/`onboarded` fields in auth responses, the `?welcome=1` / `?signup=1` redirects,
AuthContext consumers, any welcome-doc gate. Verified by test (tier-1 FR-015d + a client check).

---

## 6. returnTo length budget (FR-016, finding M4)

A real Claude Code authorize URL's `returnTo` (carrying PKCE `code_challenge`, `state`,
`redirect_uri`, client id) MUST be measured against the 512-char cap (routes.js:83). The
measured length and the decision (raise the same-origin-validated cap, OR carry OAuth params
server-side) MUST be recorded in `research.md` §R7 at implement time. Not a runtime contract —
a required measurement + recorded decision so the M2 rehearsals never silently lose the
OAuth round-trip.
