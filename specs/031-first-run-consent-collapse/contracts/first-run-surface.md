# Contract: First-Run Surface (client)

Location: the `!isAuthenticated` branch of `AuthorizePage.jsx` (currently lines ~302–336).

## C1 — Direct Google entry (FR-001)

- The "Continue with Google" action's `href` MUST be `/auth/google?returnTo=<encoded current /authorize path+search>` — NOT `/login?returnTo=…`.
  - Current: `href={\`/login?returnTo=${encodeURIComponent(window.location.pathname + window.location.search)}\`}` (AuthorizePage.jsx:330).
  - Target: `href={\`/auth/google?returnTo=${encodeURIComponent(window.location.pathname + window.location.search)}\`}`.
- This matches the path `AuthContext.login()` already uses (`/auth/google?returnTo=…`, AuthContext.jsx:215), so the server-side cookie-setting in `GET /auth/google` (routes.js:127) receives the returnTo and the round-trip binding is established.
- The generic "Welcome Back / Don't have an account?" copy MUST NOT appear in this flow (it lives on `/login`, which is now bypassed for first-run).

## C2 — Grant transparency (FR-009) — PRIMARY, visual precedence

- MUST state the grant matching the requested scopes:
  - write scope (`documents:write` present): agent can **read and create, edit, and delete documents** in the user's Squire Docs account.
  - read-only: strictly narrower — read documents only. Never broader than requested.
  - The existing `ask` derivation (AuthorizePage.jsx:305: `scopes.includes('documents:write') ? 'create and sync documents' : 'read documents'`) is the seam; extend its wording to name create/edit/delete for write scope.
- MUST include: access is **revocable anytime in Settings → AI Agent Access**.
- Copy MUST say "Squire Docs" (never bare "Squire"); honest-confident, no self-deprecation.

## C3 — Value reminder (FR-014) — SECONDARY reminder, not marketing wall

- 2–3 crisp benefit lines maximum, drawn ONLY from the verified messaging in spec §"Value-reminder source messaging":
  - humans + coding agents write the same spec together (the document is where decisions get made);
  - one spec that is both agent-workable repo markdown and team-reviewable, with two-way sync to repo markdown;
  - every edit attributed (human vs agent) and revertible;
  - PM/designer can review & refine where they can edit; the agent reads/writes it precisely.
- MUST NOT invent claims beyond these (all are product-true).
- Transparency (C2) takes visual precedence; value reminder is subordinate.

## C4 — Mobile fold (FR-014, 030 constraint)

- On common mobile viewports (first-run users arrive from the browser the agent just opened), the primary "Continue with Google" action MUST NOT be pushed below the fold. The value reminder MUST NOT crowd the action off-screen.
- This feeds the eventual tone/marketing-copy sign-off and a manual mobile-viewport visual check (owed, like prior features).

## Unchanged

- The authenticated branches (success interstitial, error, ConsentCard) are untouched — existing accounts still hit the ConsentCard (AuthorizePage.jsx:361, FR-007).
- No Deny affordance is added to the first-run surface (D4) — declining is abandoning before Google sign-in.
