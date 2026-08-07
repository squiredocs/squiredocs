# Promotion notes — 053-spaces

Stub. Records any prototype relaxations consciously introduced during this feature's
pipeline that must be revisited before (or at) promotion to production quality.

- (spec phase, 2026-08-07) None. The spec introduces no relaxations: it encodes the
  ratified design (`design/spaces.md`, D1–D8) plus the RATIFIED-BY-DEFAULT decisions in
  `clarifications-needed.md`. Later phases append here.

- (plan phase, 2026-08-07) **Design-doc amendments owed in Squire** (never hand-edit the
  exports; amend the source doc, then `node design/sync.mjs`):
  1. `design/spaces.md` — "There is no account-deletion path today" is false;
     `deleteUserByEmail` exists (`server/auth/users.js:335`). See RBD-053-11.
  2. `design/authentication-and-sharing.md` — its "Document roles and enforcement" section
     states roles live on `document_shares`. Still true for *direct* roles, but a sentence
     pointing at spaces is owed once 053 lands. `documents.getRole` remains the single
     source of truth, which the change strengthens.

- (plan phase, 2026-08-07) **Pre-existing defects found while planning, deliberately NOT
  fixed by this feature** (each would widen scope; none blocks 053):
  1. `server/mcp/tools/set-document-version-name.js:155` — the tool description still says
     "Requires editor or owner role" while the implementation is viewer+ (deliberately,
     Sam-ratified 2026-07-19 F9). A live doc/behavior mismatch in agent-facing text.
  2. `documents.createInvite` (`server/documents.js:332-346`) does
     `ON CONFLICT ... DO UPDATE SET role = EXCLUDED.role`, so a second, lower invite
     **downgrades** a pending *document* invite. Space invites are monotone by decision
     (RBD-053-9), so the two surfaces will deliberately differ until someone decides which
     is right for documents.
  3. `server/__tests__/api-docs.test.js` re-implements the inline `/api/docs` handler
     bodies inside the test file rather than exercising the real routes. New surface in
     053 uses a real router module to avoid extending the pattern, but the existing debt
     remains.

- (plan phase, 2026-08-07) **Deliberate v1 scope edges, for the record**: no numeric caps
  (RBD-053-6); no space-management MCP tools; no notifications beyond the invite email; the
  admin page gains grantors but no space-centric view; D7's move rules are Sam's declared
  starting point and are expected to be revisited once spaces are in use.
