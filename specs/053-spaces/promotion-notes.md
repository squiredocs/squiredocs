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

---

## Implementation phase (2026-08-07)

### T010 / T090 — the access-query plans, verified twice

The `document_access` view's qual pushdown was verified before the four search
joins landed (T010, the stop-the-line gate) and again after (T090), against a
seeded database (60,303 `document_shares`, 20,257 `documents`, 5,000
`space_members`). Both times, all three shapes reach an index and **no shape
sequentially scans `document_shares`**:

| Shape | Direct leg | Space leg |
|---|---|---|
| `SELECT role FROM document_access WHERE doc_id = $1 AND user_id = $2` | Index Scan `document_shares_doc_user_unique` | Index Scan `idx_space_members_user_id` |
| `JOIN document_access ds ON ds.doc_id = si.doc_id AND ds.user_id = $1` (the search legs) | Index / Bitmap Index Scan `idx_document_shares_user_id` | Index Scan `idx_space_members_user_id` → `idx_documents_space_id` |
| `JOIN document_access ds2 ON ds2.doc_id = d.id AND ds2.user_id = $1` + `LEFT JOIN spaces` (the outer query) | Index Scan `idx_document_shares_user_id` | Index Scan `idx_space_members_user_id` |

Quals push through the `GROUP BY` into both `UNION ALL` branches, which is the
property the view's shape exists to preserve. **This is the baseline a future
regression is measured against.** The shape is fragile in one specific way: the
view must expose no non-aggregated column other than `doc_id` and `user_id`.
Adding `space_id` to it — the obvious-looking convenience — converts every
permission check into a full scan of every share in the database.

### Implementation choices worth a reviewer's attention

1. **`documents.evaluateAccessRecheck` is new** (`server/documents.js`). The
   60-second live-connection re-check in `server/index.js` was an inline
   closure, so SC-003's "the socket closes within one interval" could only have
   been asserted by sleeping a minute or by copying the logic into a test. The
   DECISION moved into a named, exported function; the side effects (the 4403
   close, the degraded-capability bookkeeping) stayed in the interval. Not in
   the plan's file list, but it is one function in an existing module and it is
   what makes the claim testable rather than assumed.

2. **`GET /api/docs/:docId` gained `directRole`, `doc.spaceId`, `doc.spaceName`.**
   The editor needs all three: the chip needs the space, and "Move to space"
   must be shown only to a DIRECT owner (FR-041) — the effective role would
   show it to a passthrough owner, who `moveDocument` then refuses.

3. **The share dialog's space line says "everyone in X can reach it", not
   "everyone in X can edit".** The contract sketched the latter, but a space has
   no single role — members hold different ones — so a sentence naming one role
   would be false for most spaces. The line states the audience and its size,
   which is the fact the dialog exists to surface. Wording is Sam's to confirm.

4. **Two frozen response shapes were extended, deliberately.** `search.js`'s
   `formatResults` rows gain `space_id` / `space_name`, and `list_documents`
   results gain `space`. Feature 018's SC-004 freeze test and feature 017's
   FR-022 shape tests were updated with a comment naming FR-047 as the sanctioned
   reason, so the freeze still catches accidental drift.

5. **`tool-modules.test.js`'s "share_document description carries the owner-only
   sentence" was inverted, not deleted.** It now asserts the description does
   NOT claim owner-only and DOES state the real rule. A deleted test would have
   left nothing guarding the agent-facing prose against drifting back.

### Manual checks owed to Sam

- The SC-008 two-minute first-use walk in a browser: create a space, invite,
  move a document in, confirm a teammate sees it. Light and dark theme.
- The space scope selector, the per-row chip and the editor-header chip at
  mobile width. The editor chip is hidden below the mobile breakpoint by
  design — confirm that is the right call rather than a truncated chip.
- A rendered space-invite email in a real client: the space name is
  user-authored text and reaches both the subject line and the body. The
  escaping is the same `sanitizeHeader` / `escapeHtml` the document-share email
  uses, but nobody has looked at the result.
- The delete-confirmation wording. It states the document count and says
  plainly that no document is deleted; that sentence is the one thing standing
  between an owner and a moment of real fear.

### T092 — the quickstart smoke sequence, run for real

Steps 1-8 of `quickstart.md` were executed against a REAL running server
(`node server/index.js` on a clone of the dev database, four `dev-login`
identities), not simulated in a test harness. **31/31 checks passed**, with no
divergence between documented and actual behavior. What it covered, in order:

- A creates "Platform"; it appears in A's scope list
- B (existing account) is added at editor; C (unknown address) becomes a
  pending invite
- A moves an owned document in
- B lists it under Platform with the space name on the row, opens it as editor,
  holds `directRole: null`, has **no `document_shares` row**, and the share
  dialog names the space grant
- D (no membership, no share) lists nothing, is 403'd on the document, and gets
  a 404 from `GET /api/spaces/:id` that is **byte-identical** to the 404 for a
  space id that does not exist
- C signs up and becomes a viewer member; the unrelated pending invite is still
  listed and A revokes it
- A moves the document out; B's very next request is refused and it leaves
  B's list
- A deletes the space; `documentsReverted` matches what the detail endpoint
  reported before confirming, the document still exists and is personal, and
  the space is gone
- Refusal shapes: moving into a space you are not in is `404 Space not found`
  (no membership oracle), a blank name is `400 Space name is required`, and a
  malformed `?space=` is a 400 rather than a silently unfiltered list

The BROWSER walk (SC-008, dark mode, mobile widths) is still owed to Sam — this
exercised the server surface the UI calls, not the UI.

## Post-merge review fixes (2026-08-07, same day)

The adversarial review of the merged feature raised 3 MEDIUM and 1 LOW, all
confirmed with file:line. All four are fixed on `main`, each with a test that
fails on the pre-fix code.

### M1 — the target-owner guards read the EFFECTIVE role

**Finding.** `share-service.js`, and the role-change and unshare routes in
`index.js`, each asked `documents.getRole` for the TARGET's role and refused
when it was `owner`. Since 053 that is the effective role, so a space-owner
MEMBER of the document's space — owner by D5 passthrough, with no direct share
— could not be shared to, re-roled, or removed. Direct-share management on
space documents was frozen with `400 Cannot change owner's role`.

**Fix.** Commit `5f5daecf`. New `documents.getDirectRole` reads
`document_access.direct_role`, and all three guards use it; the ACTING user's
permission check stays on the effective role. The two `index.js` route bodies
moved into `share-service.js` beside `shareDocumentByEmail`, unchanged in
behavior, so the guard exists once instead of in three copies — and so it is
reachable from a test at all (`server/index.js` listens at require time).

**Test.** `spaces-effective-role.test.js` → "review M1 — the target-owner
guards read the DIRECT role": 6 cases. Sharing to a space-owner member with no
direct row, and changing or removing a stale direct viewer row on one, all
succeed (these three fail pre-fix with 400); the real direct owner is still
refused at all three sites.

### M2 — account deletion orphaned last-owner spaces

**Finding.** `space_members` CASCADEs with the user row, so
`deleteUserByEmail` on the SOLE owner of a space left that space with members
and zero owners. `requireOwner` then refused rename, delete, member management
and owner-level invites forever, with no path back.

**Fix.** Commit `19ba6cf0`, ratified as RBD-053-17 (design amended in
`11f61a5b`, Edge Cases). Inside the existing deletion transaction, before the
user DELETE, every space where the account is an owner and no other owner
exists is deleted. Application-level; no migration. Documents revert to
personal via `documents.space_id ON DELETE SET NULL`, direct shares survive,
and nobody is promoted — under D5 passthrough a silent promotion would hand a
member owner over every document in the space.

**Test.** `integration/faucet-wipe.test.js` → "RBD-053-17 — spaces the account
is the LAST owner of": 3 cases. The sole-owner wipe (fails pre-fix: the space
survives ownerless), a co-owned space surviving with the other owner intact,
and a member-only wipe leaving the space alone.

### M3 — the search-eval seeder violated NOT NULL granted_by

**Finding.** `server/search/eval/seed-eval-corpus.js` wrote a bare
`INSERT INTO document_shares (doc_id, user_id, role)`, a 23502 since migration
`1799810000000`. A tree-wide grep found the same omission in
`script/test-subversions-performance.js`. Nothing else outside `migrations/`
(006 predates the column) omits it.

**Fix.** Commit `b3792055`. Both self-grant, matching the owner row
`createDocument` writes.

**Test.** `share-attribution.test.js` → "M3: no source file writes
document_shares without granted_by" — a static sweep of the tree, since these
paths are scripts no suite runs. Fails pre-fix, naming the seeder line.

### L1 — malformed `:id` on `/api/spaces/*` returned 500

**Finding.** A non-uuid id reached a uuid column, Postgres raised 22P02, and
the caller got a 500 plus an exception notification, where contract invariant
I11 promises 404.

**Fix.** Commit `b06a88ab`. `requireMembership` shape-checks the id first and
answers the same `404 Space not found` a non-member gets. The uuid pattern
moved out of `normalizeSpaceScope` into `documents.isUuid` rather than being
written twice.

**Test.** `spaces-api.test.js` → "a malformed :id is the same 404, with no
exception notification", across all seven `/:id` routes, asserting the
notifier was never called. Fails pre-fix with 500.
