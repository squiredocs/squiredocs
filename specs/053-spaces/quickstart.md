# Quickstart — validating 053-spaces

How to prove the feature works end to end, and the FR/SC → test map the implementer must satisfy. No implementation code here; mechanisms live in `contracts/`.

## Prerequisites

Inside the `app-dev` pod (`docs/dev.md`), from the repo root:

```bash
npm ci && (cd client && npm ci)          # worktrees do not inherit node_modules
npm run migrate                          # applies the three new migrations
```

Backend suites run **in parallel with a database per Jest worker** (constitution v1.3.0 Principle II). From a worktree, point `DATABASE_URL` at a per-agent BASE — the helpers derive `<base>_template` and `<base>_wN` from it:

```bash
createdb collab_test_db_053
DATABASE_URL=postgres://…/collab_test_db_053 npx jest server/__tests__/spaces-*.test.js
```

The base database itself stays empty after a run — the rows are in the `_wN` copies.

## Smoke sequence (the P1 story, by hand)

```bash
npm run dev                              # or the pod's running dev server
```
1. Sign in as A. Create a space "Platform" (`POST /api/spaces`). It appears in the document list's scope selector.
2. Invite B (an existing account) at editor, C (no account) at viewer.
3. As A, move an owned document in (row menu → Move to space → Platform).
4. As B: the document is listed under Platform, opens editable, is found by search, and shows the Platform chip in the editor header. No `document_shares` row exists for B — verify: `SELECT * FROM document_shares WHERE doc_id = '<id>';`
5. As D (no membership, no share): the document is absent from the list and from search, `GET /api/docs/<id>` 403s, `GET /api/spaces/<spaceId>` **404s** (not 403).
6. Sign C up for the first time → C is a viewer member of Platform on first login; the pending invite is gone.
7. As A, move the document out. B's open tab degrades or disconnects within ~60 s; B's next request is refused.
8. Delete the space. The document still exists, now personal.

## Validation checks worth running explicitly

```sql
-- The enum inversion this feature must never fall into (LOUD FLAG 1)
SELECT GREATEST('owner'::doc_role, 'viewer'::doc_role);   -- => 'viewer'  (WRONG role, right answer for the test)

-- After migration: no share lacks a grantor
SELECT count(*) FROM document_shares WHERE granted_by IS NULL;   -- => 0

-- Effective role matrix for one doc/user
SELECT role, direct_role, space_role FROM document_access WHERE doc_id = $1 AND user_id = $2;

-- Access-query plans must be index scans, not seq scans (task T010)
EXPLAIN SELECT role FROM document_access WHERE doc_id = $1 AND user_id = $2;
```

## Test commands

```bash
npx jest server/__tests__/spaces-effective-role.test.js server/__tests__/spaces-search.test.js
npx jest server/__tests__/spaces-api.test.js server/__tests__/spaces-membership.test.js server/__tests__/spaces-move.test.js
npx jest server/__tests__/share-attribution.test.js server/__tests__/admin-sharing.test.js server/__tests__/invite-conversion.test.js
npx jest server/mcp/__tests__/tools/share-document.test.js
npm run test:client
npm test && npm run build          # the authoritative gate (merge queue)
```

## FR → test matrix

| FR | Covered by |
|---|---|
| FR-001, FR-004 | `spaces-api.test.js` (create, name trim/length/duplicate) |
| FR-002 | `spaces-model.test.js` (one home; space delete reverts, deletes nothing) |
| FR-003 | `spaces-effective-role.test.js` (doc_role reuse) |
| FR-005, FR-006 | `spaces-effective-role.test.js` — the full 4×4 direct×space matrix incl. passthrough-owner delete |
| FR-007 | `spaces-api.test.js` + `share-attribution.test.js` (viewer shares onward at viewer) |
| FR-008, FR-009 | `spaces-membership.test.js` (ops matrix; role ≤ own; only owner grants owner) |
| FR-010 | `spaces-membership.test.js` (last owner cannot leave, be removed, or be demoted) |
| FR-011, FR-012, FR-013 | `spaces-move.test.js` (incl. passthrough-owner move-in refused; curation path may only target personal) |
| FR-014 | `spaces-move.test.js` (share rows byte-identical across a move) |
| FR-015 | `spaces-effective-role.test.js` (getRole after move) + an integration assertion on the 60 s recheck path |
| FR-016..FR-021 | `spaces-membership.test.js`, `invite-conversion.test.js` (conversion, raise-only, one pending per email, email gate) |
| FR-022, FR-023, FR-024 | `spaces-membership.test.js`, `spaces-api.test.js` |
| FR-025 | `spaces-effective-role.test.js` + `permissions.test.js` extension |
| FR-026, FR-040 | `spaces-api.test.js` (list space leg, filter, `owned` still = direct) |
| FR-027 | `spaces-search.test.js` — **all three modes** (`fulltext`, `semantic`, `hybrid`), member sees, non-member does not |
| FR-028, FR-029 | `server/mcp/__tests__/tools/share-document.test.js`, plus per-tool access tests for title/versions/presence |
| FR-030 | `share-attribution.test.js` (admin + onboarding counts unaffected by passthrough) |
| FR-031 | existing realtime/presence/version-history suites stay green, unmodified |
| FR-032..FR-035 | `share-attribution.test.js`; deletion-path reassignment in `integration/faucet-wipe.test.js` |
| FR-036 | `spaces-membership.test.js` (`granted_by` on every membership) |
| FR-037 | `admin-sharing.test.js` |
| FR-038, FR-039 | `spaces-api.test.js` (all 9 routes + the move route; non-member 404 everywhere) |
| FR-041..FR-045 | client suites: `DocList`, `MoveToSpaceDialog`, `ShareDialog`, `SpaceSettingsPage` |
| FR-046, FR-047 | MCP tool suites (token-owner role parity; `space` filter + space name in `list_documents`) |

## SC → evidence

| SC | Evidence |
|---|---|
| SC-001 | `spaces-api.test.js`: M invites + N moves ⇒ every member lists/opens/searches/edits with **zero** `document_shares` rows created for them (asserted by row count) |
| SC-002 | `spaces-effective-role.test.js`: the same 4×4 matrix asserted through `getRole`, the list, keyword search, semantic search, and an MCP tool — one expected-role table, five surfaces |
| SC-003 | `spaces-move.test.js` + the recheck assertion: refusal on the next request; live socket closes `4403` within one recheck interval; direct-share holders unaffected |
| SC-004 | `spaces-search.test.js`: non-member result sets empty in all three modes, and `GET /api/spaces/:id` returns 404 |
| SC-005 | `share-attribution.test.js`: `count(*) WHERE granted_by IS NULL = 0` post-migration; one assertion per write path; admin view shows a grantor |
| SC-006 | `invite-conversion.test.js`: conversion at the invited role; never downgrades a membership acquired meanwhile |
| SC-007 | **regression guarantee** — the whole pre-existing suite must pass unmodified except where a signature genuinely changed; plus explicit all-personal assertions in `spaces-effective-role.test.js` that `role === direct_role` and list/search results are unchanged |
| SC-008 | manual, owed to Sam (browser walk); not automatable here |

## Manual checks owed to Sam (record in `promotion-notes.md`)

- Two-minute first-use walk (SC-008), light and dark theme.
- Space chip and scope selector at mobile width.
- An invite email rendered in a real client (space name escaping, subject line).
