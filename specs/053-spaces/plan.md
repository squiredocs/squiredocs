# Implementation Plan: Spaces (Shared Team Workspaces)

**Branch**: `053-spaces` (parallel-pipeline feature; planning happens on `main` per the pipeline overrides) | **Date**: 2026-08-07 | **Spec**: `specs/053-spaces/spec.md`

**Input**: Feature specification from `/specs/053-spaces/spec.md`

**Design ground truth**: `design/spaces.md` — "Squire Spaces (Shared Team Workspaces)", Ratified 2026-08-07 (Sam), D1–D8 all decided. Constitution Principle VI: the doc wins over code, spec, and this plan. Material silences are flagged in `clarifications-needed.md` (RBD-053-1..10 from the spec phase; RBD-053-11..15 added by this plan), never resolved silently.

**Planned against**: `main` @ `1847325f` ("Promote Spaces from proposal to ratified design doc"). Every anchor below was re-located by symbol/line in the working tree on 2026-08-07; nothing is quoted from memory.

**Migration slot**: this feature TAKES the in-flight migration slot (3 files). Per the pipeline's collision rule, no other feature may add `node-pg-migrate` files until 053 merges.

## Summary

Add a **space**: a named container with a member list, so a team gets access to a set of documents by joining one space instead of receiving N×M per-document shares. Three new tables (`spaces`, `space_members`, `space_invites`) plus one nullable column (`documents.space_id`) express "one home per document" (D1). A user's effective role on a document becomes the **stronger of** their direct `document_shares` role and their `space_members` role via the document's home (D3), with the space role passing through **uncapped** (D5).

The correctness core is that this union must be computed in exactly ONE place. Today the permission predicate `JOIN document_shares ds ON ds.doc_id = X AND ds.user_id = $1` is copy-pasted across **thirteen** live SQL sites (3 in `server/documents.js`, 4 in `server/search.js`, 6 across `server/mcp/`). Teaching each one about spaces is how the design's stated failure mode happens — "space documents readable but absent from search results". So this plan introduces **one database view, `document_access(doc_id, user_id, role, direct_role, space_role)`**, which computes the union once. Every one of the four search joins then changes by exactly one identifier (`document_shares` → `document_access`); `documents.getRole()` becomes a one-line select against it; and the six MCP inline checks are deleted outright and rerouted through `documents.getRole`/`hasRole` (FR-028).

Riding along: `document_shares.granted_by`, NOT NULL after a backfill (D8). The write side is tractable because `documents.setRole()` is already the single INSERT chokepoint for every human path — it gains a **required** `grantedBy` argument so no path can forget. The one path that bypasses it (`convertPendingInvites`, inlined to dodge a circular require) and the one MCP path that bypasses it (`share_document`'s hand-rolled INSERT/UPDATE) are both converged: the MCP tool is rewritten onto a new shared `shareDocumentByEmail()` service that also closes its three divergences from the REST endpoint (RBD-053-5 / FR-029).

### LOUD FLAG 1 — `GREATEST()` on `doc_role` is **inverted**. Never write it.

The design's permission model is stated as `GREATEST(direct role, space role)`. Taken literally in SQL this is a **privilege-escalation-in-reverse bug**. `doc_role` was created as `pgm.createType('doc_role', ['owner', 'editor', 'viewer'])` (`migrations/006_add_role_to_shares.js:10`), and PostgreSQL orders an enum by **declaration order**, so:

```
'owner'::doc_role  <  'editor'::doc_role  <  'viewer'::doc_role
GREATEST('owner'::doc_role, 'viewer'::doc_role)  =  'viewer'      -- WRONG
```

The ladder that matters is `documents.ROLES = { owner: 3, editor: 2, viewer: 1 }` (`server/documents.js:7-11`), which is the **reverse** of the enum's collation. Every effective-role computation in SQL MUST map to those integer ranks, take the numeric `GREATEST`, and map back — which is exactly what the `document_access` view does, once, so no other site ever has to. Any raw `GREATEST(...)`/`MAX(...)`/`ORDER BY` over a `doc_role` value anywhere in this feature is a defect. `T003` asserts the inversion in a test so it can never be "fixed" back.

### LOUD FLAG 2 — the design's "there is no account-deletion path today" is FALSE, and the naive `granted_by` breaks the one that exists

`design/spaces.md` (granted_by section) and spec FR-035 / Out-of-Scope both rest on "there is no account-deletion path today; if one is added, it must first reassign rows the account granted to the document's current owner". There **is** one: `deleteUserByEmail()` at `server/auth/users.js:335-386` (feature 029), reachable in production through `server/auth/routes.js:758` (synthetic-namespace wipe) and `:824` (the prod single-account reset, `PROD_RESET_ACCOUNT`), and exercised by `server/__tests__/integration/faucet-wipe.test.js` and `prod-reset.test.js`.

With `granted_by uuid NOT NULL REFERENCES users(id)` and `ON DELETE NO ACTION` (which the design mandates), that helper's final `DELETE FROM users WHERE id = $1` raises a foreign-key violation whenever the deleted account granted a share on a document it does **not** own — which is reachable today, because `REQUIRED_ROLES.share = 'viewer'` (`server/permissions.js:17`) lets any collaborator share onward. The transaction rolls back and the wipe/reset fails.

The design already supplies the remedy ("reassign rows the account granted to the document's current owner, the same rule as the backfill"), so this plan applies that rule inside the existing helper rather than inventing anything: **RBD-053-11**. But the spec's Out of Scope explicitly says the opposite ("the grantor reassignment rule is stated for a future path, **not built here**"), so this is a genuine spec-vs-reality conflict, reported as a **HIGH** finding by the analyze pass and escalated rather than papered over. `design/spaces.md` needs a one-sentence amendment in Squire (orchestrator/Sam, not this agent, and not a hand-edit of the export).

## Technical Context

**Language/Version**: Node.js 22+ (CommonJS backend, `server/index.js` entry), React 18 + Vite frontend (`client/`)

**Primary Dependencies**: Express 4, `pg` + `node-pg-migrate`, y-websocket/Yjs (untouched), nodemailer via `server/email.js`, axios on the client. **No new dependency.**

**Storage**: PostgreSQL. NEW: tables `spaces`, `space_members`, `space_invites`; columns `documents.space_id`, `document_shares.granted_by`; view `document_access`. Existing `doc_role` enum reused (D2). Redis and S3 untouched.

**Testing**: Jest for the backend (`server/__tests__/`, `server/api/__tests__/`, `server/mcp/__tests__/`, `__tests__/integration/`), **parallel with per-worker database isolation** — `DATABASE_URL` is a BASE from which `<base>_template` and `<base>_w1..wN` are derived (`server/__tests__/helpers/db.js`, constitution v1.3.0 Principle II). Vitest + jsdom for the client (`client/vitest.config.js`, tests in `__tests__/` beside their source).

**Target Platform**: Linux server (k3s pods, ≥2 replicas), evergreen browsers

**Project Type**: Web application — Express backend + React frontend in one repository

**Performance Goals**: `getRole()` stays a single indexed round-trip per call (it is called on every `/api/docs/:docId/*` request, on every WS upgrade, and once per minute per live socket). The four search permission joins must not regress their plans: the `document_access` view is written so that quals on `doc_id`/`user_id` — its only grouping columns — push down through the aggregate into both `UNION ALL` branches and reach the existing `document_shares` unique index and the new `space_members` unique index. `EXPLAIN` verification is task `T010`, not an assumption.

**Constraints**: additive schema only; new migration timestamps `> 1799700000000` (current head `1799700000000_add-via-sync-to-yjs-updates.js`; the historical `> 1795000000000` floor from the retired feature-008 phantom row is subsumed). Realtime, presence, awareness, undo/redo, diff and version history are **not touched** (FR-031). No new bearer-token grant (join links are a non-goal). No numeric caps (RBD-053-6).

**Scale/Scope**: 47 FRs, 8 SCs, 5 user stories. ~9 new files (3 migrations, 2 server modules, 1 REST router, 3 client components/pages), ~20 existing files edited, ~10 new/extended test suites.

## Constitution Check

*GATE: evaluated against constitution v1.3.0 before Phase 0; re-checked after Phase 1 design.*

| Principle | Gate | Status |
|---|---|---|
| I. Documentation Reflects Reality | Behavior-changing work updates the docs in the same effort | **PASS with handoff.** `docs/permissions.md` is squarely falsified by this feature (it states access is `document_shares` and "Owner role cannot be transferred") and IS in the implementer's remit — task `T072`. `README.md` and `docs/dev.md` are off-limits to parallel agents, so the required README edits are itemised under "Merge-queue notes" below and are the queue's responsibility. |
| II. Test-Backed Changes | Every behavioral change ships tests; per-worker DB isolation; suites don't assume they own the DB | **PASS.** Every FR maps to a named test in `quickstart.md`'s matrix. New suites create their own users/spaces/docs and clean up in `afterAll`; `server/__tests__/helpers/db.js`'s `cleanupTestUser` is extended to sweep `spaces`/`space_members`/`space_invites` (`T012`) precisely because fixed-key rows must stay scoped to the suite that creates them. No format/serialization change ⇒ the round-trip registry suite is untouched. |
| III. Trunk-Based Solo Workflow | No ceremony without a concrete failure it prevents | **PASS.** The one structural addition — the `document_access` view — exists to prevent a *named, already-observed* failure class (thirteen copies of one predicate; the design itself calls out "a missed leg makes space documents readable but absent from search results"). Rejected alternatives are recorded in `research.md` R1. No caps, no quotas, no new services (RBD-053-6). |
| IV. Collaboration-Safe Document Operations | Targeted Yjs ops; structural targeting; single format registry; provenance is invariant | **PASS, vacuously and deliberately.** Nothing in this feature touches a Y.Doc, the schema, the format registry, or an update payload. A move is `UPDATE documents SET space_id = $1`. Provenance is *strengthened*: `granted_by` makes every grant attributable (spec Assumptions: "spaces alter reachability, never authorship"). |
| V. Secure by Default for Agent & User Content | Auth + document ACLs on every new endpoint; untrusted content stays inert; scoped tokens | **PASS, and this is the principle most at risk.** Every new route is `requireAuth` + an explicit space-role check; non-members get a refusal indistinguishable from non-existence (RBD-053-10). Space names are user-authored text that reaches (a) invite emails — escaped with the existing `escapeHtml`/`sanitizeHeader` helpers in `server/email.js`, and (b) the React UI, which escapes by default. No new ingestion surface, no bearer grant, no token-side change (FR-046). The single largest security surface is the *widening* of access derivation, which is why it happens in one reviewable place and is covered by an explicit non-member leakage suite (SC-004). |
| VI. Design Docs Are Ground Truth | `design/` wins; gaps flagged in the ledger, never resolved ad hoc | **PASS with one escalation.** D1–D8 are implemented verbatim. Five new gaps are recorded as RBD-053-11..15. One of them (RBD-053-11) is a *falsified* design statement, not a silence — per Principle VI ("when implementation falsifies a documented mechanism, the doc MUST be amended with the reason"), `design/spaces.md` needs a Squire-side amendment; that is flagged upward, not hand-edited. |
| VII. Horizontally Scalable App Pods | No correctness in process-local memory | **PASS.** All new state is in PostgreSQL. The one cache-shaped thing in scope (`checkEmbeddingsExist`, `server/search.js:210-221`) is untouched. Access is re-derived per request; the 60-second live recheck (`server/index.js:2062-2097`) picks up space changes with no cross-pod coordination, exactly as it does for direct shares today. No new in-memory registry, no sticky routing requirement. |

**Post-Phase-1 re-check**: **PASS.** The Phase 1 artifacts add one view, three tables, two columns, one new REST router, one new service module, and no dependency, no in-memory state, no Yjs touch, no registry bypass. **Complexity Tracking is empty** (no violations to justify).

## Project Structure

### Documentation (this feature)

```text
specs/053-spaces/
├── spec.md                              # committed input (5 stories, FR-001..047, SC-001..008)
├── clarifications-needed.md             # RBD-053-1..10 (spec) + 11..15 (this plan)
├── promotion-notes.md                   # appended by this plan
├── checklists/requirements.md           # from /speckit-specify
├── plan.md                              # This file
├── research.md                          # Phase 0: mechanism decisions R1–R14
├── data-model.md                        # Phase 1: tables, view, invariants, state transitions
├── contracts/
│   ├── access-derivation.md             # the document_access view + the 13 call sites
│   ├── spaces-rest-api.md               # 9 space endpoints + the move endpoint + GET /api/docs?space=
│   ├── share-attribution.md             # granted_by write paths, backfill, shareDocumentByEmail()
│   └── agent-surface.md                 # MCP reroute + list_documents space name/filter
├── quickstart.md                        # Phase 1: validation guide + FR/SC → test matrix
└── tasks.md                             # Phase 2 (/speckit-tasks)
```

### Source Code (repository root)

```text
migrations/
├── 1799800000000_create-spaces.js                 # NEW  spaces, space_members, space_invites, documents.space_id
├── 1799810000000_add-granted-by-to-document-shares.js  # NEW  add nullable → backfill → SET NOT NULL (one transaction)
└── 1799820000000_create-document-access-view.js   # NEW  the union view (depends on space_members)

server/
├── spaces.js                       # NEW  data layer: spaces CRUD, membership, invites, conversion, move
├── share-service.js                # NEW  shareDocumentByEmail() — one sharing behavior for REST + MCP (FR-029)
├── api/spaces.js                   # NEW  Express router mounted at /api/spaces
├── documents.js                    # getRole → document_access; getAccessibleDocuments gains space leg+filter;
│                                   #   setRole/createDocument/ensureDocument gain grantedBy / spaceId
├── search.js                       # 4 permission joins → document_access; buildRoleCondition → direct_role;
│                                   #   space name projected; space filter param
├── permissions.js                  # unchanged REQUIRED_ROLES (D6); doc comment on effective role
├── index.js                        # mount /api/spaces; PUT /api/docs/:docId/space; POST /api/docs spaceId;
│                                   #   GET /api/docs space filter; share handler → share-service
├── email.js                        # NEW space-invite/space-added templates (same escaping discipline)
├── auth/users.js                   # convertPendingInvites: granted_by + convertPendingSpaceInvites (one txn);
│                                   #   deleteUserByEmail: grantor reassignment (RBD-053-11)
├── onboarding.js                   # unchanged logic; owner row gains grantedBy via createDocument
├── document-service.js             # createSeededDocument threads grantedBy (+ optional spaceId)
├── api/admin.js                    # sharing detail shows grantor; caveat comment removed
└── mcp/
    ├── agent-presence.js           # _verifyDocumentAccess → documents.getRole (keeps the users lookup)
    └── tools/
        ├── share-document.js       # rewritten onto share-service (viewer-can-share, invites, email, grantor)
        ├── set-document-title.js   # inline SQL → documents.getRole
        ├── set-document-version-name.js
        ├── list-document-versions.js
        ├── list-documents.js       # space name in results + space filter param (RBD-053-8)
        └── index.js                # (no registry change beyond schema edits)

client/src/
├── App.jsx                         # parseRoute: /space/:id; navigateToSpace
├── components/
│   ├── DocList.jsx                 # space scope list, space chip, Move-to-space, empty-space CTAs
│   ├── ShareDialog.jsx             # read-only space-grant line (FR-043)
│   ├── EditorView.jsx              # space chip in header + Move-to-space action
│   └── MoveToSpaceDialog.jsx       # NEW
└── pages/
    └── SpaceSettingsPage.jsx       # NEW  rename, members, invites, leave, delete

docs/permissions.md                 # updated (Principle I; README is the merge queue's job)
```

**Structure Decision**: the existing web-app layout is kept as-is. Space *data* logic lands in `server/spaces.js` mirroring `server/documents.js` (same `init(pool)` shape, same JSDoc discipline), and space *HTTP* logic in `server/api/spaces.js` mirroring `server/api/support.js`'s `{ init, router }` module shape — deliberately NOT inline in `server/index.js`, because inline routes force the copy-the-handler-into-the-test antipattern visible in `server/__tests__/api-docs.test.js`. The single exception is `PUT /api/docs/:docId/space`, which stays inline next to its 23 sibling `/api/docs` routes (house consistency) as a thin adapter over `spaces.moveDocument()`, so the authorization logic is still unit-testable without HTTP. See `research.md` R8.

## Key integration points (verified 2026-08-07, cite these)

| # | Anchor | Today | After |
|---|---|---|---|
| 1 | `server/documents.js:35-44` `getRole()` | `SELECT role FROM document_shares WHERE doc_id=$1 AND user_id=$2` | `SELECT role FROM document_access ...`. Covers **all ~35 direct callers**, `permissions.checkPermission` (`server/permissions.js:109`), the WS upgrade (`server/index.js:1847`) and the 60 s recheck (`server/index.js:2066`). |
| 2 | `server/documents.js:253` list join | `JOIN document_shares ds ON d.id=ds.doc_id AND ds.user_id=$1` | `JOIN document_access ds ...` + `LEFT JOIN spaces s ON s.id=d.space_id`; `roleCondition` (`:227-233`) switches to `ds.direct_role` (RBD-053-7); new `space` filter param. |
| 3 | `server/search.js:262` `kw_doc` | `JOIN document_shares ds ...` | `JOIN document_access ds ...` |
| 4 | `server/search.js:269` `kw_chunk` | ditto | ditto |
| 5 | `server/search.js:290` `top_chunks` (vector) | ditto | ditto |
| 6 | `server/search.js:323` outer query `ds2` | ditto | ditto; `ds2.role` (projected at `:314`) becomes the effective role for free; `buildRoleCondition` (`:87-91`) switches to `direct_role`. |
| 7 | `server/mcp/tools/share-document.js:70,103,116,123` | own SQL, **owner-only** (`:80`), no invites, no email, no grantor | deleted; calls `shareDocumentByEmail()` (FR-029) |
| 8 | `server/mcp/tools/set-document-title.js:62` | inline join, editor-or-owner | `documents.getRole` + `documents.ROLES` compare |
| 9 | `server/mcp/tools/set-document-version-name.js:189` | inline join, viewer+ | `documents.hasAccess` |
| 10 | `server/mcp/tools/list-document-versions.js:115` | inline join, viewer+ | `documents.hasAccess` |
| 11 | `server/mcp/agent-presence.js:166-183` `_verifyDocumentAccess` | inline join returning role + user identity | `documents.getRole` for the role, keep the `users` lookup. **Highest leverage**: it is the de-facto gate for `get_collaborators`, `create_document`, `modify`, `read_document`, `restore_document_version`. |
| 12 | `server/api/admin.js:410-437` sharing detail | comment "document_shares has no granted_by, so shares are scoped to owned docs" | join `users` on `granted_by`; the query stops being owner-scoped; caveat deleted (FR-037) |
| 13 | `server/api/admin.js:175-180`, `:563-573`, `server/onboarding.js:74-85` owned counts | `document_shares WHERE role='owner'` | **unchanged** (FR-030 / RBD-053-7) — asserted by a regression test, not by absence of a diff |
| 14 | `server/auth/users.js:115-144` `convertPendingInvites` | inline INSERT, no grantor | grantor from `i.invited_by_user_id` with the COALESCE fallback (RBD-053-13); same transaction also converts space invites |
| 15 | `server/index.js:929-1032` share handler | inline: role check, invite path, `email_enabled` gate (`:958-961`), `setRole` | thin adapter over `shareDocumentByEmail()` — byte-equivalent behavior, one implementation |
| 16 | `server/documents.js:71-84` `setRole` | `INSERT ... ON CONFLICT DO UPDATE SET role=$3` | required 4th arg `grantedBy`; throws if absent |

## Migration sequence (three files, strictly ordered)

Head is `1799700000000`. New timestamps: **1799800000000 → 1799810000000 → 1799820000000**.

**M1 `1799800000000_create-spaces.js`** — purely additive, no data touched.
1. `spaces` (id uuid pk default `uuid_generate_v4()`, `name varchar(100) NOT NULL`, `created_by uuid NULL REFERENCES users(id) ON DELETE SET NULL`, `created_at`/`updated_at` timestamptz) + the existing `update_updated_at_column()` trigger (same shape as `migrations/004:36-42`).
2. `space_members` (`space_id` → `spaces(id)` ON DELETE CASCADE, `user_id` → `users(id)` ON DELETE CASCADE, `role doc_role NOT NULL`, `granted_by uuid NOT NULL REFERENCES users(id)` **ON DELETE NO ACTION**, `created_at`) + `UNIQUE (space_id, user_id)` + index on `user_id` (Postgres does not auto-index FKs, and `user_id` is the hot lookup for both the view and "my spaces").
3. `space_invites` (`space_id` cascade, `email text NOT NULL`, `role doc_role NOT NULL`, `invited_by_user_id uuid NULL ... ON DELETE SET NULL`, `created_at`) + `CREATE UNIQUE INDEX ... (space_id, lower(email))` and `CREATE INDEX ... (lower(email))` — byte-for-byte the `document_share_invites` pattern (`migrations/1787000000000:45-51`), because login-time conversion looks up by `lower(email)` across all spaces.
4. `ALTER TABLE documents ADD COLUMN space_id uuid NULL REFERENCES spaces(id) ON DELETE SET NULL` + index on `space_id`. The `SET NULL` **is** the space-deletion semantic (FR-024): documents revert to personal, never deleted.

**M2 `1799810000000_add-granted-by-to-document-shares.js`** — the only data-touching migration. All three steps in ONE migration ⇒ one transaction ⇒ the column is never observably NULL and never observably absent-but-required.
1. `ADD COLUMN granted_by uuid NULL REFERENCES users(id)` (implicitly `NO ACTION`). Nullable at this instant only; instant on a live table, no rewrite, and the FK has nothing to validate.
2. Backfill in one statement, exactly the design's chain (owner share → `documents.creator_id` → the share's own `user_id`), which cannot yield NULL because the last term is the row's own NOT NULL column:
   ```sql
   UPDATE document_shares ds
   SET granted_by = COALESCE(
     (SELECT o.user_id FROM document_shares o
       WHERE o.doc_id = ds.doc_id AND o.role = 'owner' LIMIT 1),
     (SELECT d.creator_id FROM documents d WHERE d.id = ds.doc_id),
     ds.user_id)
   WHERE ds.granted_by IS NULL;
   ```
3. `ALTER COLUMN granted_by SET NOT NULL`.
   `down` drops the column. Corpus is small (single-digit thousands of rows in prod); no batching, no `NOT VALID`/`VALIDATE` dance.

**M3 `1799820000000_create-document-access-view.js`** — `CREATE VIEW document_access` (full text in `contracts/access-derivation.md`). Must follow M1 (`space_members` must exist). `down` drops the view. Nothing else may be added to this migration: it is the one artifact a reviewer reads to audit the whole permission model.

**Deploy note for the queue**: M2 is forward-only in practice (rolling it back loses attribution but breaks nothing). The three migrations must be applied **before** the new image serves traffic — `document_access` does not exist for the old code, but the old code never references it, so the ordering is the ordinary `npm run migrate` → deploy.

## File touch list

**New (9)**: `migrations/1799800000000_create-spaces.js`, `migrations/1799810000000_add-granted-by-to-document-shares.js`, `migrations/1799820000000_create-document-access-view.js`, `server/spaces.js`, `server/share-service.js`, `server/api/spaces.js`, `client/src/components/MoveToSpaceDialog.jsx`, `client/src/pages/SpaceSettingsPage.jsx` (+ its `.css`).

**Edited — server (16)**: `server/documents.js`, `server/search.js`, `server/index.js`, `server/email.js`, `server/auth/users.js`, `server/document-service.js`, `server/api/admin.js`, `server/onboarding.js` (comment/threading only), `server/mcp/agent-presence.js`, `server/mcp/tools/share-document.js`, `server/mcp/tools/set-document-title.js`, `server/mcp/tools/set-document-version-name.js`, `server/mcp/tools/list-document-versions.js`, `server/mcp/tools/list-documents.js`, `server/permissions.js` (doc comment only), `server/__tests__/helpers/db.js`.

**Edited — client (4)**: `client/src/App.jsx`, `client/src/components/DocList.jsx`, `client/src/components/ShareDialog.jsx`, `client/src/components/EditorView.jsx`.

**Edited — docs (1)**: `docs/permissions.md`.

**Test suites — new (9)**: `server/__tests__/spaces-model.test.js`, `spaces-api.test.js`, `spaces-membership.test.js`, `spaces-move.test.js`, `spaces-effective-role.test.js`, `spaces-search.test.js`, `share-attribution.test.js`, `server/mcp/__tests__/tools/share-document.test.js`, `client/src/pages/__tests__/SpaceSettingsPage.test.jsx`.
**Test suites — extended (6)**: `server/__tests__/invite-conversion.test.js`, `admin-sharing.test.js`, `permissions.test.js`, `documents.test.js`, `server/__tests__/integration/faucet-wipe.test.js`, `client/src/components/__tests__/` (DocList / ShareDialog / MoveToSpaceDialog).

## Merge-queue notes (not this agent's edits)

1. **`README.md`** must gain a Spaces section and corrections in the same merge: `## Usage` step 3 (sharing) and `### Document Roles` (`README.md:437-443`) now have a second access channel; the `### API Endpoints` table (`:542`) omits the nine `/api/spaces` routes and `PUT /api/docs/:docId/space`; the MCP `### Available Tools` block (`:695`) must record that `share_document` is no longer owner-only and that `list_documents` returns/accepts a space.
2. **`design/spaces.md` amendment (Squire-side, Sam/orchestrator)**: strike "There is no account-deletion path today" — `deleteUserByEmail` exists (LOUD FLAG 2). Never hand-edit the export; amend the source doc at `https://squiredocs.com/d/03bac6c7-78e3-449d-ab94-806580fa5a52` and re-run `node design/sync.mjs`.
3. **`design/authentication-and-sharing.md` coherence**: its "Document roles and enforcement" section states `document_shares` is where roles live and that `documents.getRole` is the single source of truth. The second half stays true (and gets truer); the first half needs a sentence pointing at spaces. Squire-side amendment, same rule.
4. Verification in the main tree is the usual `npm run migrate` → `npm test` → `npm run build`; the migrate step now applies three new files, so a queue run that skips it will fail with `relation "document_access" does not exist` rather than anything subtle.

## Complexity Tracking

*No Constitution Check violations. Table intentionally empty.*
