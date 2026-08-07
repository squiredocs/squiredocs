---

description: "Task list for 053-spaces"
---

# Tasks: Spaces (Shared Team Workspaces)

**Input**: Design documents from `/specs/053-spaces/`

**Prerequisites**: `plan.md`, `spec.md`, `research.md` (R1–R14), `data-model.md`, `contracts/` (4), `quickstart.md`

**Tests**: **REQUIRED.** Constitution Principle II — every behavioral change ships tests and the affected suites must pass before commit. Backend suites run **in parallel with a database per Jest worker**; `DATABASE_URL` is a BASE from which `<base>_template` and `<base>_wN` are derived. From a worktree use a per-agent base (`createdb collab_test_db_053`). Suites must not assume they own the database and must clean up in `afterAll`.

**Baseline**: `main` @ `1847325f`. No branches, no commits outside the implement flow's convention. This feature **holds the migration slot** — three files, timestamps `1799800000000 / 1799810000000 / 1799820000000` (head is `1799700000000`).

**Two rules that override intuition — read `plan.md`'s LOUD FLAGS before writing SQL:**
1. **Never `GREATEST()` a `doc_role`.** The enum collates `owner < editor < viewer`, the inverse of the ladder. Rank arithmetic only, and only inside the view (RBD-053-12).
2. **`granted_by` breaks `deleteUserByEmail`** unless the reassignment lands with it (RBD-053-11). T086 is not optional.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: can run in parallel — different files, no dependency on an incomplete task
- **[Story]**: US1–US5 from `spec.md`

---

## Phase 1: Setup

**Purpose**: confirm the substrate the plan assumes, and encode the enum hazard before any code can trip on it.

- [X] T001 Verify every anchor in `plan.md`'s "Key integration points" table still exists at the cited symbol: `getRole`/`getAccessibleDocuments`/`setRole`/`createDocument` in `server/documents.js`; the four `document_shares` joins and `buildRoleCondition` in `server/search.js`; the five inline permission queries under `server/mcp/`; `convertPendingInvites` and `deleteUserByEmail` in `server/auth/users.js`; the WS upgrade and 60 s recheck in `server/index.js`; the sharing-detail query in `server/api/admin.js`. Record ANY drift in `specs/053-spaces/clarifications-needed.md` before proceeding — merged code wins over the plan.
- [X] T002 Confirm the per-worker test database is reachable and the suites this feature will touch are GREEN before any edit, so later failures are attributable: `npx jest server/__tests__/permissions.test.js server/__tests__/documents.test.js server/__tests__/search.test.js server/__tests__/admin-sharing.test.js server/__tests__/invite-conversion.test.js`.
- [X] T003 Create `server/__tests__/spaces-model.test.js` containing ONLY the enum-inversion assertion for now: `SELECT GREATEST('owner'::doc_role,'viewer'::doc_role)` returns `'viewer'`, with a comment naming RBD-053-12 and pointing at `contracts/access-derivation.md`. This test exists so the hazard is executable documentation and cannot be "cleaned up" away.
- [X] T004 Confirm `migrations/` head is `1799700000000_add-via-sync-to-yjs-updates.js` and that no other in-flight feature has added migration files; if the head moved, renumber this feature's three timestamps upward and note it in `specs/053-spaces/plan.md`'s migration section.

---

## Phase 2: Foundational (blocking prerequisites for ALL user stories)

**Purpose**: the schema, the one access relation, and the write chokepoints. Nothing user-visible changes in this phase, but every story depends on all of it.

**⚠️ No user story work may begin until T023's checkpoint is green.**

- [X] T005 Create `migrations/1799800000000_create-spaces.js` per `data-model.md` §1–§2: `spaces` (+ the `update_updated_at_column()` trigger, same shape as `migrations/004:36-42`), `space_members` (`UNIQUE (space_id, user_id)`, index on `user_id`, `granted_by uuid NOT NULL REFERENCES users(id)` with **NO ACTION**), `space_invites` (unique expression index on `(space_id, lower(email))` plus an index on `lower(email)`, mirroring `migrations/1787000000000:45-51`), and `documents.space_id uuid NULL REFERENCES spaces(id) ON DELETE SET NULL` + its index. Full `exports.down`. JSDoc header explaining why `SET NULL` on `space_id` IS the space-deletion semantic.
- [X] T006 Create `migrations/1799810000000_add-granted-by-to-document-shares.js` — one migration, one transaction, three steps: add `granted_by uuid NULL REFERENCES users(id)`, run the `COALESCE(owner-share, documents.creator_id, ds.user_id)` backfill from `data-model.md` §5, then `SET NOT NULL`. JSDoc must state why the chain cannot yield NULL (`documents.creator_id` is nullable — `migrations/007:11-15`; the third term is the row's own NOT NULL column) and why it is not a separate backfill script (research R4).
- [X] T007 Create `migrations/1799820000000_create-document-access-view.js` with the view exactly as written in `contracts/access-derivation.md` §1, comment included. Nothing else may go in this file — it is the single artifact a reviewer reads to audit the permission model. `exports.down` drops the view.
- [X] T008 Run `npm run migrate` (`script/migrate.js`) against the dev database and against a fresh template; confirm all three apply cleanly, that `SELECT count(*) FROM document_shares WHERE granted_by IS NULL` is 0, and that `exports.down` for each reverses cleanly (`npm run migrate:down` ×3, then up again).
- [X] T009 Extend `server/__tests__/spaces-model.test.js` with `document_access` semantics at the SQL level: direct-only, space-only, both (stronger wins in each direction), `direct_role`/`space_role` populated independently, personal documents unchanged, and absence-means-no-access. Include the case that motivated RBD-053-12 (direct `owner` + space `viewer` ⇒ effective `owner`).
- [X] T010 **Gate**: run the two `EXPLAIN` shapes from `contracts/access-derivation.md` §1 against a seeded database and confirm index scans on `document_shares_doc_user_unique` and the `space_members` indexes with **no sequential scan** of `document_shares`. If pushdown does not materialize, stop, switch to research R1 alternative (a) — a JS-emitted `JOIN LATERAL` fragment — and record the reversal in `specs/053-spaces/clarifications-needed.md`.
- [ ] T011 Rewrite `getRole` in `server/documents.js:35-44` to `SELECT role FROM document_access WHERE doc_id = $1 AND user_id = $2`, keeping the signature, the `'owner'|'editor'|'viewer'|null` return, and every caller untouched. Update the JSDoc to say the role is now the effective union (D3/D5) and to point at `design/spaces.md`.
- [ ] T012 Extend `cleanupTestUser` in `server/__tests__/helpers/db.js` to delete, BEFORE the `users` delete: `space_members WHERE user_id = $1 OR granted_by = $1`, `space_invites WHERE invited_by_user_id = $1`, then `spaces WHERE created_by = $1`. Extend the docblock at `:217`. Rationale to include: `spaces.created_by` is `ON DELETE SET NULL`, so test spaces otherwise survive teardown and poison later suites on the same worker, and `space_members.granted_by` is NOT NULL/NO ACTION, so an unswept grant makes an unrelated suite's teardown throw.
- [ ] T013 Change `documents.setRole` (`server/documents.js:71-84`) to `setRole(docId, userId, role, grantedBy)` per `contracts/share-attribution.md` §1 — **required** 4th argument that throws when absent, written into both the INSERT and the `ON CONFLICT DO UPDATE`.
- [ ] T014 Update `documents.createDocument` (`server/documents.js:130-148`) to pass `ownerId` as `grantedBy`, and give `createDocument`/`ensureDocument` an optional `spaceId` so a document can be created directly into a space (FR-044).
- [ ] T015 [P] Thread the optional `spaceId` through `createSeededDocument` in `server/document-service.js:548-568` (grantor already flows via `createDocument`).
- [ ] T016 Create `server/spaces.js` with the `init(pool)` shape of `server/documents.js` and the core reads/writes: `createSpace`, `getSpace`, `getSpacesForUser`, `getSpaceDetail`, `getMemberRole`, `getMembers`, `countDocuments`, `renameSpace`, `deleteSpace`. Name validation (trim, non-empty, ≤100) lives here so create and rename cannot diverge (FR-004).
- [ ] T017 Add `assertNotLastOwner(client, spaceId, userId)` to `server/spaces.js` per research R11 — takes an existing pg client so it runs inside the caller's transaction under the row lock; one error message shared by leave, remove and demote.
- [ ] T018 Add `moveDocument(actorId, docId, targetSpaceId)` to `server/spaces.js` implementing the full D7 rule set from `contracts/spaces-rest-api.md`: one transaction, `SELECT ... FOR UPDATE` on the document row, ownership half read from **`document_shares` directly, not `document_access`** (a passthrough owner must not satisfy it — US3 scenario 5), move-out by direct owner or source-space owner, move-in requiring direct ownership AND editor-or-owner target membership, space→space requiring both, curation path restricted to `NULL`, same-target no-op success, missing target a clean failure, and never a write to `document_shares`.
- [ ] T019 Create `server/share-service.js` by extracting `server/index.js:929-1032` verbatim in behavior into `shareDocumentByEmail({ actor, docId, email, role, baseUrl })` returning `{ status, body }`, per `contracts/share-attribution.md` §3 — same status codes, same messages, same awaited sends, `granted_by` now stamped.
- [ ] T020 Replace the body of `POST /api/docs/:docId/share` in `server/index.js:929-1032` with a thin adapter over `shareDocumentByEmail`, and pass `req.user.userId` as `grantedBy` at the role-change route `server/index.js:1067`.
- [ ] T021 [P] Update the JSDoc in `server/permissions.js` (above `REQUIRED_ROLES`, `:11-20`) to record that thresholds are unchanged in v1 (D6) while the role reaching them is now the effective union. No behavior change.
- [ ] T022 Fix every existing suite broken by the `setRole` signature and the new columns — at minimum `server/__tests__/documents.test.js`, `admin-sharing.test.js`, `permissions.test.js`, `api-docs.test.js`, and the `server/mcp/__tests__/` suites that insert shares inline. Inline `INSERT INTO document_shares` statements in tests must now supply `granted_by`.
- [ ] T023 **Checkpoint**: `npm test` (root `package.json` scripts) fully green on the migrated schema with no story work started. A red suite here is a foundation defect, not a story defect.

---

## Phase 3: User Story 1 — A team shares documents by sharing a space (Priority: P1) 🎯 MVP

**Goal**: a space exists, teammates with accounts become members, documents move in, and every member sees and opens them — with zero per-document shares.

**Independent test**: create a space, invite an existing account at editor, move a document in; the invitee can list, open, search for and edit it with **no `document_shares` row**, while a non-member sees nothing anywhere.

### Tests for User Story 1

- [ ] T024 [P] [US1] Create `server/__tests__/spaces-api.test.js` (supertest against the real router, the `server/api/__tests__/admin.test.js` pattern): create with valid/blank/whitespace/101-char/duplicate names; creator is sole owner member; `GET /api/spaces` is membership-scoped; `GET /api/spaces/:id` returns detail for a member and **404** for a non-member (RBD-053-10).
- [ ] T025 [P] [US1] Create `server/__tests__/spaces-membership.test.js` with the US1 slice only: inviting an existing account adds the membership immediately with `granted_by` set, and re-inviting at a higher role raises while a lower role is a no-op (FR-019).
- [ ] T026 [P] [US1] Add the SC-001 assertion to `server/__tests__/spaces-api.test.js`: after 1 space + M invites + N moves, `SELECT count(*) FROM document_shares WHERE user_id = ANY(members)` is exactly the pre-existing count — access with zero new share rows.

### Implementation for User Story 1

- [ ] T027 [US1] Add `inviteMember(spaceId, email, role, actorId)` to `server/spaces.js` — the existing-account branch only for this story: role capped at the actor's own (FR-008/FR-009), rank-comparing raise-only upsert on `(space_id, user_id)` (never `GREATEST` on the enum — research R12), `granted_by = actorId`.
- [ ] T028 [US1] Add `sendSpaceEmail({ ..., pending })` plus the `sendSpaceNotification` wrapper to `server/email.js`, structurally mirroring `sendShareEmail` (`server/email.js:155-189`): `sanitizeHeader` on the subject, `escapeHtml` on every interpolation — the space name is user-authored text (Principle V).
- [ ] T029 [US1] Create `server/api/spaces.js` as `{ init(pool), router }` (the `server/api/support.js` shape) with `POST /`, `GET /`, `GET /:id`, `PATCH /:id`, `DELETE /:id` per `contracts/spaces-rest-api.md`, including the universal non-member-404 rule and the `notifyException(error, { req, source: 'api' })` catch pattern.
- [ ] T030 [US1] Add `POST /:id/members` to `server/api/spaces.js` for the existing-account path, gating outbound mail on a fresh `users.findById(actor).email_enabled` read exactly as `server/index.js:958-961` does; the membership is granted whether or not mail is sent (FR-021).
- [ ] T031 [US1] Mount the router in `server/index.js` beside the other `/api/*` mounts (`:387`) as `app.use('/api/spaces', express.json(), spaces.router)` and call `spaces.init(pool)` in the init block near `:359-367`. Do **not** mount a body parser at the `/api/docs` prefix (research R8 — it would break the 20 MB image route at `:840`).
- [ ] T032 [US1] Add the inline `PUT /api/docs/:docId/space` route to `server/index.js` beside its sibling `/api/docs` routes, with its own `express.json()`, as a ~8-line adapter over `spaces.moveDocument` mapping outcomes to the status table in `contracts/spaces-rest-api.md`.
- [ ] T033 [US1] Extend `getAccessibleDocuments` in `server/documents.js:193-275`: `JOIN document_access ds`, `LEFT JOIN spaces s ON s.id = d.space_id`, project `d.space_id` and `s.name AS space_name`, switch `roleCondition` (`:227-233`) to `direct_role` with `shared_with_me` becoming `(ds.direct_role IS NULL OR ds.direct_role <> 'owner')`, and add the `space` option (`all` | `personal` | uuid) that defaults to today's behavior.
- [ ] T034 [US1] Pass `req.query.space` through `GET /api/docs` (`server/index.js:628`) with validation, and add `spaceId`/`spaceName` to the response rows.
- [ ] T035 [US1] Accept an optional `spaceId` on `POST /api/docs` (`server/index.js:724`), authorized by the same move-in rule (editor-or-owner membership of the target); the creator still gets a direct owner share so their access never depends on membership (FR-044).
- [ ] T036 [P] [US1] Add a `/space/:id` branch to `parseRoute()` in `client/src/App.jsx:26-96`, a `navigateToSpace` helper alongside `navigateToDocs` (`:153-215`), and the corresponding case in the authenticated view switch.
- [ ] T037 [US1] Add the space scope selector to `client/src/components/DocList.jsx` — "My Docs" first, then one entry per space from `GET /api/spaces`; the existing all/owned/shared_with_me `<select>` (`:334-340`) keeps applying **within** the selected scope (FR-040); `fetchDocs` (`:95-107`) sends `space`.
- [ ] T038 [US1] Show each row's space as a chip in `client/src/components/DocList.jsx`, and add a "Move to space" entry to the 3-dot menu shown only to direct owners (FR-041).
- [ ] T039 [P] [US1] Create `client/src/components/MoveToSpaceDialog.jsx` (+ CSS): lists spaces where the user is editor-or-owner plus "My Docs (personal)", calls `PUT /api/docs/:docId/space`, surfaces the server's refusal text rather than a generic error.
- [ ] T040 [US1] Add the empty-space state to `client/src/components/DocList.jsx`: "Move documents here" and "New document" (FR-045); creating from a space scope posts `spaceId`.
- [ ] T041 [P] [US1] Add `client/src/components/__tests__/MoveToSpaceDialog.test.jsx` and extend the DocList client tests for the scope selector, the space chip and the empty state (render + axios mocking pattern from `client/src/pages/__tests__/AdminPage.test.jsx`, since `DocList.test.jsx` currently tests only a helper).

**Checkpoint**: US1 is independently demonstrable — the smoke sequence steps 1–5 in `quickstart.md` pass.

---

## Phase 4: User Story 2 — Direct shares and space access combine; the stronger wins (Priority: P1)

**Goal**: every access surface reports the identical effective role, and no surface leaks to non-members.

**Independent test**: build the direct-role × space-role matrix on one document and assert the effective role through the list, direct open, keyword search, semantic search, realtime gate and an MCP tool — plus owner-via-passthrough being able to delete.

### Tests for User Story 2

- [ ] T042 [P] [US2] Create `server/__tests__/spaces-effective-role.test.js`: one expected-role table for the full `{none,viewer,editor,owner} × {none,viewer,editor,owner}` matrix, asserted through `documents.getRole`, `getAccessibleDocuments`, and `permissions.can.*` — including passthrough-owner delete allowed (US2-3) and non-space-owner delete refused (US2-4), and the SC-007 all-personal regression (`role === direct_role`, results unchanged).
- [ ] T043 [P] [US2] Create `server/__tests__/spaces-search.test.js`: a space document is found by a member and invisible to a non-member in **all three** modes — `fulltext`, `semantic`, `hybrid` — with the provider mocks used by `server/__tests__/search.test.js`; plus `filter=owned` excluding passthrough-owned documents (RBD-053-14).
- [ ] T044 [P] [US2] Create `server/mcp/__tests__/tools/share-document.test.js` asserting the converged behavior: an editor (not owner) may share; a viewer may share at viewer only; an unknown email creates a pending invite; email is sent only when `email_enabled`; `granted_by` is the token's owner.

### Implementation for User Story 2

- [ ] T045 [US2] Change all four permission joins in `server/search.js` (`:262`, `:269`, `:290`, `:323`) from `document_shares` to `document_access` — relation name only. Verify `hybridSearch` (`:385-425`), which emits three of them in one statement, still has non-colliding CTE-scoped `ds` aliases.
- [ ] T046 [US2] Switch `buildRoleCondition` (`server/search.js:87-91`) to `${alias}.direct_role`, with `shared_with_me` becoming the `IS NULL OR <> 'owner'` form so space-only documents are not dropped.
- [ ] T047 [US2] Project `d.space_id` and a `LEFT JOIN spaces` name through `runSearchQuery` (`server/search.js:302-332`) and `formatResults` (`:438-460`), and add a `space` option to `searchDocuments` applied inside each candidate CTE the same way `buildRecencyJoin` is. Leave `share_count` (`:319`) counting **direct** shares (RBD-053-15).
- [ ] T048 [P] [US2] Replace the inline permission query in `server/mcp/tools/set-document-title.js:58-74` with `documents.getRole` + a `documents.ROLES` comparison, preserving both error strings byte-for-byte.
- [ ] T049 [P] [US2] Replace the inline query in `server/mcp/tools/set-document-version-name.js:186-202` with `documents.hasAccess`, keeping the Sam-ratified viewer+ comment.
- [ ] T050 [P] [US2] Replace the inline query in `server/mcp/tools/list-document-versions.js:111-122` with `documents.hasAccess`.
- [ ] T051 [US2] Rewrite `_verifyDocumentAccess` in `server/mcp/agent-presence.js:166-183` to take the role from `documents.getRole` and the identity fields from a separate `users` lookup, leaving the `options.requiredRole` gate at `:751-756` untouched. This is the gate for `get_collaborators`, `create_document`, `modify`, `read_document` and `restore_document_version`.
- [ ] T052 [US2] Rewrite `server/mcp/tools/share-document.js` onto `shareDocumentByEmail` — delete `:66-130` (its access join, the owner-only refusal at `:80`, the unknown-email throw, the role lookup, the UPDATE and the INSERT) — and rewrite the tool `description` (`:23-25`) and its returned message, which currently advertise owner-only.
- [ ] T053 [US2] Add the `space` parameter to `list_documents` (`server/mcp/tools/list-documents.js:49-119` input schema — mandatory, or `validateToolArgs` rejects it as an unknown parameter), forward it to both the list and search branches (`:175-182`, `:153-161`), add `space: {id, name}|null` to both result mappings, and update the EXAMPLES in the description literal (`:24-47`).
- [ ] T054 [P] [US2] Add per-tool space-access tests under `server/mcp/__tests__/tools/` proving a space member (no direct share) can read a title, list versions, name a version and appear in presence — and that a non-member still gets the unchanged error string.
- [ ] T055 [US2] Extend `server/__tests__/permissions.test.js` for effective-role resolution through `checkPermission`/`can.*`, including a space-owner passing `can.delete` with no direct share.
- [ ] T056 [US2] Add a read-only `spaceGrant: { id, name, role, memberCount } | null` to the `GET /api/docs/:docId/shares` response (`server/index.js:1143-1166`), leaving `users`/`invites`/`currentUserRole` exactly as they are (RBD-053-15).
- [ ] T057 [P] [US2] Render the space grant as a read-only line in `client/src/components/ShareDialog.jsx` ("Everyone in Platform can edit (12 members)"), above the unchanged direct-share list (FR-043).
- [ ] T058 [P] [US2] Add the space-grant-line test to `client/src/components/__tests__/ShareDialog.test.jsx` (present with a space, absent for personal documents, never editable).

**Checkpoint**: SC-002 and SC-004 hold — one effective role across six surfaces, zero leakage in three search modes.

---

## Phase 5: User Story 3 — Documents move in and out; access follows, shares survive (Priority: P2)

**Goal**: the D7 rule set is exactly right in both directions, and losing space access revokes like losing a direct share.

**Independent test**: move a document out while a space-only member has it open; their live connection degrades or disconnects within ~60 s and later requests are refused, while a direct-share holder is unaffected.

### Tests for User Story 3

- [ ] T059 [P] [US3] Create `server/__tests__/spaces-move.test.js` covering the full matrix: move-in refused for a direct owner who is only a viewer member (US3-4); move-in refused for an editor member who is not the direct owner, **including one holding passthrough owner** (US3-5, FR-011); move-out by direct owner; move-out by a space owner who is not the direct owner (curation, US3-3); one-step A→B when both rules are satisfied and refusal when only the curation path applies (US3-6, RBD-053-3); same-target no-op; deleted-target clean failure.
- [ ] T060 [P] [US3] Add the share-preservation assertions to `server/__tests__/spaces-move.test.js`: `document_shares` rows are byte-identical before and after every move, and a direct-share holder's access is unchanged after move-out (FR-014, US3-2).
- [ ] T061 [US3] Add the revocation-timing assertion: after move-out (and after space deletion), `documents.getRole` returns `null` for a space-only member on the very next call, and the 60-second recheck path in `server/index.js:2062-2097` closes the socket with `4403` — asserted by driving the recheck function/interval rather than sleeping 60 s (SC-003).

### Implementation for User Story 3

- [ ] T062 [US3] Harden `spaces.moveDocument` against the concurrency edge cases the tests expose: verify the `FOR UPDATE` lock actually serializes two simultaneous moves, and that a target space deleted between the check and the update fails cleanly rather than leaving a dangling `space_id` (spec edge case "Concurrent moves / stale move targets").
- [ ] T063 [P] [US3] Make the refusal messages in the move route distinguish the three failure reasons (not the document's owner / not an editor of the target / curation path may only target personal) so the client can show them verbatim — `contracts/spaces-rest-api.md` status table.
- [ ] T064 [P] [US3] Add the "Move to space" action to the editor: a space chip in the `EditorView.jsx` header (`client/src/components/EditorView.jsx:510`) and a menu entry opening `MoveToSpaceDialog`, shown to direct owners (FR-041).
- [ ] T065 [US3] Verify the editor's existing lost-access handling in `client/src/components/EditorView.jsx` covers a revoked SPACE grant identically to a revoked direct share — no new mechanism; the `4403` close must surface an honest message, never an empty document.

**Checkpoint**: SC-003 holds; the revocation half of movement is proven, not assumed.

---

## Phase 6: User Story 4 — Running a space: invites, roles, leaving, deletion (Priority: P2)

**Goal**: the full membership lifecycle, including pre-account invites and the last-owner invariant.

**Independent test**: invite an unknown email → sign that person up → they are a member at the invited role; re-invite higher; promote to owner; leave; delete the space.

### Tests for User Story 4

- [ ] T066 [P] [US4] Extend `server/__tests__/spaces-membership.test.js` to the full lifecycle: invite unknown email creates a pending row; re-invite raises the pending role and never lowers it (RBD-053-9); one pending invite per space per address, case-insensitive (FR-020); invite above your own role refused (US4-3); non-owner refused rename/delete/role-change/removal/revoke (US4-5).
- [ ] T067 [P] [US4] Add last-owner tests to `server/__tests__/spaces-membership.test.js`: the last owner cannot leave, be removed, or be demoted, each returning the same guidance (FR-010, US4-6) — and can do all three once a second owner exists (ownership transfer, spec edge case).
- [ ] T068 [P] [US4] Extend `server/__tests__/invite-conversion.test.js`: a pending **space** invite converts at first login at the invited role; conversion never downgrades a membership acquired meanwhile; document and space invites convert in the same transaction; a NULL `invited_by_user_id` still produces a NOT NULL `granted_by` via the fallback chain (RBD-053-13); the function still never throws.
- [ ] T069 [P] [US4] Add space-deletion tests to `spaces-api.test.js`: documents revert to personal and are **not** deleted, memberships and pending invites are gone, content/history/direct shares untouched, and the reported document count matches what the confirm dialog would state (FR-024).

### Implementation for User Story 4

- [ ] T070 [US4] Extend `spaces.inviteMember` with the unknown-address branch: rank-comparing raise-only upsert on `space_invites (space_id, lower(email))`, `invited_by_user_id = actor`, and the `sendSpaceInvite` mail under the `email_enabled` gate (FR-018/FR-021).
- [ ] T071 [US4] Add `sendSpaceInvite` to `server/email.js` as the `pending: true` wrapper over `sendSpaceEmail`, with the sign-in hint the document invite uses (`server/email.js:181`).
- [ ] T072 [US4] Add `convertPendingSpaceInvites(client, user)` to `server/spaces.js` — takes the caller's pg client, `INSERT ... SELECT ... ON CONFLICT (space_id, user_id) DO NOTHING`, then deletes the consumed rows.
- [ ] T073 [US4] Extend `convertPendingInvites` in `server/auth/users.js:115-144`: add `granted_by` with the `COALESCE(invited_by_user_id, doc owner, invitee)` chain from `contracts/share-attribution.md` §2, and call `convertPendingSpaceInvites` inside the SAME `BEGIN/COMMIT`. Preserve the never-throw contract (`:105-107`) — one try, one rollback, one swallow.
- [ ] T074 [US4] Add `setMemberRole`, `removeMember`, `getInvites` and `revokeInvite` to `server/spaces.js`, each calling `assertNotLastOwner` inside its own transaction where applicable.
- [ ] T075 [US4] Add `PUT /:id/members/:userId`, `DELETE /:id/members/:userId` (self ⇒ leaving) and `DELETE /:id/invites` to `server/api/spaces.js` with the owner-only gates and the 409 last-owner response from `contracts/spaces-rest-api.md`; revoking a pending invite is **owner-only** (RBD-053-4).
- [ ] T076 [US4] Create `client/src/pages/SpaceSettingsPage.jsx` (+ CSS): rename, member list with roles, invite box with a role picker reusing `GET /api/users/search` (the `ShareDialog.jsx:80` debounce pattern), pending invites with revoke, leave and delete — every control shown per the operations matrix (FR-042).
- [ ] T077 [US4] Make the delete confirmation state the document count from `GET /api/spaces/:id` before confirming, and say plainly that documents revert to personal and are not deleted (FR-024).
- [ ] T078 [P] [US4] Add `client/src/pages/__tests__/SpaceSettingsPage.test.jsx`: owner sees management controls, a viewer member does not, the last owner's leave is refused with the server's guidance, and the delete confirmation shows the count.

**Checkpoint**: SC-006 holds; a space is operable day to day without touching the database.

---

## Phase 7: User Story 5 — Every share says who granted it (Priority: P3)

**Goal**: attribution is complete, visible in the admin view, and the account-deletion path survives the NOT NULL constraint.

**Independent test**: after migration no share lacks a grantor; each write path records the acting user; the admin sharing detail shows grantors with the caveat gone.

### Tests for User Story 5

- [ ] T079 [P] [US5] Create `server/__tests__/share-attribution.test.js`: post-migration `count(*) WHERE granted_by IS NULL` is 0; one assertion per write path (REST share, role change, MCP share tool, invite conversion, document creation, onboarding welcome doc) that the grantor is the acting user; and `setRole` throws without `grantedBy`.
- [ ] T080 [P] [US5] Add the FR-030 / RBD-053-7 regression to `share-attribution.test.js`: a space-owner member's passthrough does **not** change `server/api/admin.js:175-180`'s `doc_count`, `:563-573`'s `authored_non_welcome_doc`, or `server/onboarding.js:74-85`'s `isEngaged`. The absence of a diff is not evidence — assert the numbers.
- [ ] T081 [P] [US5] Extend `server/__tests__/admin-sharing.test.js:88-101` for the grantor-scoped query: shares the profiled user granted on documents they do **not** own now appear, and each row carries its grantor.
- [ ] T082 [US5] Extend `server/__tests__/integration/faucet-wipe.test.js` with the case that proves RBD-053-11: user A grants a share on user B's document, then A is wiped — the wipe succeeds and B's share row survives with `granted_by` reassigned to B (the document's owner).

### Implementation for User Story 5

- [ ] T083 [US5] Rewrite the shares query in `GET /users/:userId/sharing` (`server/api/admin.js:427-437`) to be grantor-scoped per `contracts/share-attribution.md` §4, and **delete** the caveat comment at `:410-412`.
- [ ] T084 [US5] Update the response mapping (`server/api/admin.js:439-457`) to carry the grantor, and rename the section in `client/src/pages/AdminPage.jsx:755` from "Shared on owned docs" to "Shares they granted", with the matching empty state at `:757` (FR-037).
- [ ] T085 [P] [US5] Add `granted_by` to space-membership creation everywhere it is written in `server/spaces.js` (`createSpace`'s owner row, `inviteMember`, `setMemberRole`, `convertPendingSpaceInvites`) — FR-036 — and assert it in `server/__tests__/spaces-membership.test.js`.
- [ ] T086 [US5] **Required, not optional (RBD-053-11 / LOUD FLAG 2)**: add the two grantor-reassignment `UPDATE`s from `contracts/share-attribution.md` §5 to `deleteUserByEmail` (`server/auth/users.js:335-386`), inside the existing transaction, after the account's own documents are deleted and before `DELETE FROM users`. Without this, the synthetic wipe (`server/auth/routes.js:758`) and the prod reset (`:824`) fail with a foreign-key violation whenever the account granted a share on someone else's document.

**Checkpoint**: SC-005 holds and no pre-existing capability is broken by the new constraint.

---

## Phase 8: Polish & Cross-Cutting Concerns

- [ ] T087 [P] Rewrite `docs/permissions.md` for spaces: the roles section (owner is now transferable **at the space level**, `:9-12` is currently wrong even before this feature), a new "Spaces" section covering the union model and the operations matrix, the `document_access` view in the schema section (`:24-37`), `granted_by` on `document_shares`, and the new endpoints in the API section (`:98-127`). Principle I — `README.md` and `docs/dev.md` are the merge queue's job (see `plan.md` "Merge-queue notes").
- [ ] T088 [P] Sweep agent-facing prose for the now-false "only the document owner can share": tool descriptions under `server/mcp/tools/` and the `get_tool_documentation` content.
- [ ] T089 [P] Add JSDoc to `server/spaces.js` and `server/share-service.js` matching the density of `server/documents.js`, and a header comment on `server/spaces.js` naming `design/spaces.md` as ground truth and D1–D8 as the decisions it implements.
- [ ] T090 Re-run `T010`'s `EXPLAIN` checks after all search changes have landed, with representative row counts, and record the plans in `specs/053-spaces/promotion-notes.md` so a future regression has a baseline.
- [ ] T091 Run the full authoritative gate in one pass: `npm run migrate && npm test && npm run build`. Backend suites run parallel by default; use `--runInBand` only to bisect a failure.
- [ ] T092 Walk `quickstart.md`'s smoke sequence end to end against the dev server and record any divergence between documented and actual behavior in `specs/053-spaces/promotion-notes.md`.
- [ ] T093 [P] Append the implementation-phase dispositions to `specs/053-spaces/promotion-notes.md`: manual checks owed to Sam (SC-008 two-minute walk, dark mode, mobile widths, a rendered invite email), plus anything relaxed during the build.
- [ ] T094 Verify `.specify/feature.json` is unchanged and that no `README.md`, `CLAUDE.md`, or `docs/dev.md` edit slipped in (pipeline overrides).

---

## Dependencies & Execution Order

```
Phase 1 Setup (T001-T004)
  └─> Phase 2 Foundational (T005-T023)                  # BLOCKS every story
        │   T005→T006→T007→T008 (migrations, strictly ordered)
        │   T008→T009, T008→T010 (T010 is a GATE on the search work)
        │   T011 needs T007;  T013→T014→T015;  T019→T020
        ├─> Phase 3 US1 (T024-T041)   P1  🎯 MVP
        ├─> Phase 4 US2 (T042-T058)   P1   — needs T010 green; T045-T047 are the search legs
        ├─> Phase 5 US3 (T059-T065)   P2   — uses US1's move route (T032); rules already in T018
        ├─> Phase 6 US4 (T066-T078)   P2   — extends US1's invite path (T027) and email (T028)
        └─> Phase 7 US5 (T079-T086)   P3   — independent of US1-US4 except the T013 chokepoint
              └─> Phase 8 Polish (T087-T094)
```

- **T018 (`moveDocument`) is foundational on purpose**: US1 needs move-in and US3 needs move-out, so the rule set lives in one function written once; US3 owns the exhaustive matrix and the revocation half.
- **T010 is a stop-the-line gate.** Do not land T045–T047 (the four search joins) before the access-query plans are verified; a sequential scan there is a production incident, not a slow test.
- **US5 is nearly free-standing** — only `setRole`'s signature (T013) ties it to the rest. It can be built first if the migration slot ever needs to ship alone.
- **T086 must land in the same change as T006.** The NOT NULL column and the deletion-path reassignment are one behavioral unit; splitting them ships a broken wipe.

## Parallel Opportunities

- **Phase 2**: T015 and T021 are independent single-file edits. Everything else is sequenced by the migration chain and the `documents.js` edits (T011/T013/T014 are the same file — one pass).
- **Phase 3**: T024/T025/T026 (tests) run together; T036, T039 and T041 (client) run alongside the server work T027–T035.
- **Phase 4**: T048, T049, T050 are three independent MCP files; T054, T057, T058 are independent of the search work. T045/T046/T047 are all `server/search.js` — one pass, not parallel.
- **Phase 5**: T063 and T064 are independent (server message text vs. editor UI).
- **Phase 6**: T066–T069 (tests) in parallel; T076/T078 (client) alongside T070–T075.
- **Phase 7**: T079, T080, T081 in parallel; T085 is independent of the admin work.
- **Phase 8**: T087, T088, T089, T093 are four independent documentation edits.

## Implementation Strategy

- **MVP = Phase 2 + Phase 3 + Phase 4** (US1 + US2, both P1). That is the ratified core: a space grants access, and every surface agrees on what it granted. Shippable on its own; without US2 the feature is *actively unsafe to ship*, because the list would show documents that search cannot find and MCP would refuse.
- **Increment 2 = Phase 5** (US3): the revocation half of movement.
- **Increment 3 = Phase 6** (US4): the lifecycle that makes it operable.
- **Increment 4 = Phase 7** (US5): attribution, which can also be pulled forward.

**Stop-the-line rules**

1. Any `GREATEST`/`MAX`/`ORDER BY` over a `doc_role` value outside the view — STOP, re-read RBD-053-12.
2. `EXPLAIN` shows a sequential scan on `document_shares` (T010) — STOP, take research R1 alternative (a).
3. A task appears to require a fourth migration, a new dependency, a Yjs/format-registry change, or a join-link/bearer grant — STOP; those are the migration slot, Principle IV, and an explicit non-goal respectively.
4. `granted_by` work looks like it can ship without T086 — it cannot; see LOUD FLAG 2.

## Task Count

**94 tasks**: Setup 4 · Foundational 19 · US1 18 · US2 17 · US3 7 · US4 13 · US5 8 · Polish 8.
