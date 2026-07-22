# Contract: Synthetic Dev-Support Endpoints

All endpoints below are **fail-closed** behind
`ENABLE_DEV_ENDPOINTS === '1' && NODE_ENV !== 'production'` (FR-001, RBD-5). With the flag
unset they MUST be unreachable (404 / not mounted), independent of `NODE_ENV` (SC-004). The
production single-account reset is the ONE exception — see `reset-and-provenance.md`.

Namespace predicate (shared boundary, RBD-1/RBD-2):
`SYNTHETIC = /^test\+[a-z0-9-]{1,32}@test\.local$/`.

---

## 1. Fresh-user faucet — `POST /auth/dev-login` (EXTENDED — FR-003, FR-004, FR-005)

Extends the existing endpoint. Backward compatible: an empty body still mints the fixed
`dev@test.local` user with a JSON response (existing behavior unchanged).

**Request body (all optional):**
```jsonc
{
  "fresh":    true,        // mint test+<nonce>@test.local instead of the fixed dev user
  "nonce":    "abc123",    // optional; /^[a-z0-9-]{1,32}$/. Absent + fresh => server random hex
  "browser":  true,        // browser mode: set cookies + 302 redirect instead of JSON
  "returnTo": "/mcp/..."   // same-origin path; required-ish for browser mode; validated by isValidReturnTo
}
```

**Modes:**
- **Fixed JSON** (`{}`): unchanged — `dev@test.local`, JSON `{ accessToken, user }`.
- **Fresh JSON** (`{fresh:true}`): mints `test+<nonce>@test.local`, JSON `{ accessToken, user, email, nonce }`.
- **Fresh browser** (`{fresh:true, browser:true, returnTo}`): sets `accessToken`/`refreshToken`
  httpOnly cookies and responds `302` to the validated `returnTo` — standing in for Google on
  the consent page's sign-in leg.

**Invariants:**
- Repeated `fresh` calls with distinct/absent nonces produce distinct users (Acceptance 1.1).
- Reused explicit nonce ⇒ re-login of the same identity (find-or-create), not an error.
- Browser mode MUST route through the SAME server logic as the Google callback for account
  creation, provenance stamping, welcome-doc decision, returnTo handling (RBD-10). It
  substitutes only the identity leg. ⇒ a `fresh` browser account created with a valid
  `returnTo` is stamped `agent_oauth` and receives NO welcome doc, exactly as a real
  consent-born account.
- `returnTo` failing `isValidReturnTo` (routes.js:81-94, 512-char + same-origin) ⇒ no redirect
  (JSON or safe default), never an open redirect.

**Gating:** synthetic flag guard. Unreachable when flag unset (Acceptance 1.6, SC-004).

**Client change (FR-005):** `AuthContext.devLogin` (client/src/contexts/AuthContext.jsx
~:134-149) — today posts no body — is extended to forward `{ fresh, nonce, returnTo }` and use
browser mode so the React consent path (AuthorizePage → /login → devLogin) composes with the
faucet.

---

## 2. Consent auto-approve — `POST /auth/dev-consent-approve` (NEW — FR-006, FR-007)

Completes the `/authorize` Approve step for a **synthetic** session and mints the agent's
authorization code with no browser click. Reuses `server/mcp/auth/oauth-flow.js` approve core.

**Auth:** `requireAuth` (a faucet-minted session). **Gating:** synthetic flag guard.

**Request body:** the pending-authorize parameters needed to mint the code (client_id,
redirect_uri, state, code_challenge, scope) — reconstructed from / consistent with the pending
authorize request. (Exact fields confirmed against `handleApprove` at implement — research R2.)

**Behavior:**
- If `req.user.email` matches `SYNTHETIC` ⇒ complete Approve, return the authorization code /
  redirect target exactly as a browser Approve click would (Acceptance 2.2).
- If `req.user.email` does NOT match `SYNTHETIC` (a real user's session) ⇒ **403 refuse**
  (Acceptance 2.3, RBD-1). Auto-approve is synthetic-session-only.

---

## 3. Synthetic wipe — `POST /auth/dev-wipe-user` (NEW — FR-008, FR-009)

Hard-deletes a synthetic user and everything hanging off the row so the identity is first-run
again. **Gating:** synthetic flag guard (dev/staging only; NEVER in production).

**Request body:**
```jsonc
{ "email": "test+abc123@test.local" }   // MUST match SYNTHETIC
// OR
{ "all": true }                          // convenience: wipe ALL rows matching SYNTHETIC (RBD-2)
```

**Behavior:**
- `email` matching `SYNTHETIC` ⇒ hard-delete that user + reset cascade (docs, delegations,
  registered OAuth clients, tokens, chats, usage). Next sign-in for that identity is a genuine
  first run (Acceptance 1.4).
- `email` NOT matching `SYNTHETIC` (e.g. a real user's address) ⇒ **refuse** (Acceptance 1.5,
  FR-009). No numeric user ids, no wildcards outside the namespace (RBD-2).
- Non-existent synthetic account ⇒ **idempotent no-op success** (FR-011).
- `all:true` deletes only rows matching `SYNTHETIC`.
