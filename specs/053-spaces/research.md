# Phase 0 Research — 053-spaces

Mechanism decisions for the plan. Everything here is subordinate to `design/spaces.md` (Ratified 2026-08-07); where the design speaks, this file only records *how* to honor it in this codebase. Product-level gaps go to `clarifications-needed.md`, not here.

All code anchors were re-located in the working tree at `main` @ `1847325f` on 2026-08-07.

---

## R1 — One SQL relation for effective role: the `document_access` view

**Decision**: create a PostgreSQL **view** `document_access(doc_id, user_id, role, direct_role, space_role)` in migration M3, and route every access predicate through it.

**Rationale**: the predicate `JOIN document_shares ds ON ds.doc_id = <x> AND ds.user_id = $1` exists thirteen times in live code — `server/documents.js:253` (list) and `:39` (getRole) and `:312` (autocomplete exclusion); `server/search.js:262, 269, 290, 323`; `server/mcp/tools/share-document.js:70`, `set-document-title.js:62`, `set-document-version-name.js:189`, `list-document-versions.js:115`, `agent-presence.js:171`. The design names the exact failure mode of patching them one by one: "A missed leg makes space documents readable but absent from search results." A view makes the four search legs a **one-identifier diff each**, which is auditable at a glance and impossible to half-apply: any leg still naming `document_shares` is visibly different from its three siblings.

It also gives three columns where the code needs three different questions answered:
- `role` — the effective union, for authorization (FR-005, FR-025).
- `direct_role` — for "owned"/"shared with me" filters and ownership counts, which must NOT be reclassified by passthrough (RBD-053-7, FR-030, FR-040).
- `space_role` — for the share dialog's read-only audience line (FR-043) and for explaining refusals.

**Alternatives considered**:
- *(a) A JS SQL-fragment builder* (`buildAccessJoin(docIdExpr, userParam)` emitting a `JOIN LATERAL`). Same single-source property, no DDL. Rejected: it must thread a parameter index through four call sites that already juggle 4–7 positional parameters and build their param arrays three different ways (`server/search.js:352, 375-377, 420-422`), and it leaves `getRole` and the six MCP checks needing a *second* mechanism. The view serves all thirteen with one shape.
- *(b) Materialized view.* Rejected: needs refresh on every share, membership, and move; trades a correctness-critical read for a cache-invalidation problem, and Principle VII forbids correctness that depends on a refresh landing.
- *(c) A `space_documents` denormalization table maintained by triggers.* Rejected outright: same invalidation problem plus trigger-hidden control flow, for a query that is already index-cheap.
- *(d) Leave `document_shares` joins in place and UNION a second space query at each site.* This is the design's literal phrasing ("Each gains the space term") and is exactly what R1 exists to avoid; the design describes the requirement, not the refactor.

---

## R2 — Effective role is computed on integer ranks, never on the `doc_role` enum

**Decision**: inside the view, map `doc_role → int` with an inline `CASE` (`owner→3, editor→2, viewer→1`), take `GREATEST` of the integers, map back with `(ARRAY['viewer','editor','owner'])[rank]::doc_role`. No `GREATEST`/`MAX`/`ORDER BY` over a `doc_role` value anywhere in the feature.

**Rationale**: `migrations/006_add_role_to_shares.js:10` declares `pgm.createType('doc_role', ['owner', 'editor', 'viewer'])`. PostgreSQL orders an enum by declaration order, so the enum collates `owner < editor < viewer` — the **exact inverse** of the privilege ladder in `server/documents.js:7-11` (`{owner: 3, editor: 2, viewer: 1}`). A literal reading of the design's `GREATEST(direct, space)` therefore returns the *weaker* role: `GREATEST('owner','viewer') = 'viewer'`. A viewer-member would silently strip a direct owner of their own document.

**Alternatives considered**: adding a `doc_role_rank(doc_role)` IMMUTABLE SQL function so the mapping is nameable and reusable. Rejected for v1 — with the view as the single computation site there is exactly one place that needs the mapping, and a bare `CASE` keeps the migration self-contained and greppable. If a second site ever needs it, promote the CASE to a function then.

**Verification owed**: `T003` asserts the inversion directly (`SELECT GREATEST('owner'::doc_role,'viewer'::doc_role) = 'viewer'`) so the hazard is documented executably and a future "cleanup" cannot quietly reintroduce it.

---

## R3 — Qual pushdown is the performance contract, and it is verified, not assumed

**Decision**: write the view as `SELECT ... FROM (two-branch UNION ALL) src GROUP BY doc_id, user_id`, projecting only the grouping columns plus aggregates. Verify with `EXPLAIN` (task `T010`) that `WHERE doc_id = ... AND user_id = ...` and the search-shaped `ds.user_id = $1` produce index scans on `document_shares_doc_user_unique` and the new `space_members (space_id, user_id)` / `(user_id)` indexes.

**Rationale**: `getRole` runs on every `/api/docs/:docId/*` request, every WebSocket upgrade (`server/index.js:1847`), and once per minute per live socket (`server/index.js:2062-2097`). Postgres pushes quals through a `GROUP BY` when they reference only grouping columns, and then into each `UNION ALL` branch (append-relation pushdown). The view is shaped to satisfy both conditions: `doc_id` and `user_id` are the only non-aggregated outputs, and neither branch uses a volatile expression. Anything that breaks this shape (e.g. adding `space_id` to the view via an aggregate over a uuid) silently converts a two-index-lookup query into a full scan of every share in the database.

**Consequence recorded**: the view deliberately does **not** carry `space_id`. Callers that need it already have `documents d` in scope and read `d.space_id` (`server/documents.js` list query, `server/search.js` outer query). This is a load-bearing omission, not an oversight.

---

## R4 — Backfill and NOT NULL in one migration, one transaction

**Decision**: M2 does `ADD COLUMN granted_by uuid NULL REFERENCES users(id)` → one `UPDATE` with the `COALESCE(owner-share, documents.creator_id, ds.user_id)` chain → `SET NOT NULL`, all in a single node-pg-migrate migration (which runs in one transaction by default).

**Rationale**: D8 as amended requires "backfilled; NOT NULL". Splitting it across two migrations creates a window where the column exists and is nullable while new code assumes it is populated. The chain cannot produce NULL: the final fallback is the row's own `user_id`, which is already `NOT NULL` (`migrations/004:57-62`). `documents.creator_id` is genuinely nullable (`migrations/007:11-15`, `ON DELETE SET NULL`), which is *why* the third fallback exists.

**Alternatives considered**: a separate backfill script under `server/scripts/` (the precedent is `backfill-meaningful-classification.js`). Rejected: that pattern exists for backfills too heavy for a migration transaction (decoding every CRDT update); this one is a single indexed UPDATE over a few thousand rows and gains nothing from being operator-triggered — while losing atomicity with the constraint.

---

## R5 — `setRole()` gains a **required** `grantedBy` argument

**Decision**: `documents.setRole(docId, userId, role, grantedBy)` throws `Error('grantedBy is required')` when the fourth argument is absent, and writes it into the INSERT and the `ON CONFLICT DO UPDATE`.

**Rationale**: FR-034 enumerates five write paths. Four of them already funnel through `setRole` (`server/documents.js:71-84`): the REST share endpoint (`server/index.js:1006, 1067`), document creation (`server/documents.js:137`), onboarding's welcome doc (`server/onboarding.js:50` → `document-service.js:551` → `createDocument` → `setRole`), and the MCP `create_document` path (same chain). Making the argument *optional with a default* would let a future caller silently attribute a grant to the wrong user; making it required converts that class of bug into an immediate, loud failure in the first test that exercises the path. `ON CONFLICT DO UPDATE SET role = $3, granted_by = $4` is correct: a role *change* is a new grant by the acting user.

**The two paths that bypass `setRole`** are handled explicitly: `convertPendingInvites` (R6) and the MCP `share_document` tool (R7).

---

## R6 — Invite conversion: grantor fallback, and space invites in the same transaction

**Decision**: `server/auth/users.js:115-144` `convertPendingInvites(user)` keeps its inline SQL (the circular-require reason at `:111-112` still holds) and gains:

```sql
INSERT INTO document_shares (doc_id, user_id, role, granted_by)
SELECT i.doc_id, $1, i.role,
       COALESCE(i.invited_by_user_id,
                (SELECT o.user_id FROM document_shares o
                  WHERE o.doc_id = i.doc_id AND o.role = 'owner' LIMIT 1),
                $1)
FROM document_share_invites i
WHERE lower(i.email) = lower($2)
ON CONFLICT (doc_id, user_id) DO NOTHING
```

and, in the **same** `BEGIN/COMMIT`, the space-invite conversion (`INSERT INTO space_members ... ON CONFLICT (space_id, user_id) DO NOTHING`, then delete the consumed rows).

**Rationale**: `document_share_invites.invited_by_user_id` is nullable with `ON DELETE SET NULL` (`migrations/1787000000000:12-51`), but `granted_by` is `NOT NULL` — so the conversion needs the same fallback chain as the backfill or a login can fail. This is a design silence (the design says "from `invited_by_user_id`, which the invite row already carries" without covering the null case): recorded as **RBD-053-13**.

Sharing the transaction is deliberate: the design specifies "a `convertPendingSpaceInvites` step ... following the same pattern"; running it inside the existing transaction means a login either converts everything or nothing, and it keeps the function's contract of **never throwing** (`:105-107`) — a space-invite failure must not cost a user their document invites, nor their login. One `try/catch`, one rollback, one swallow.

**Ordering note**: `convertPendingInvites` is called from `findOrCreateUser` (`server/auth/users.js:97`) on **every** login, not just signup, and `findOrCreateUser` is reached from all three login paths (`server/auth/routes.js:326, 626, 688`). No new call site is needed.

---

## R7 — `shareDocumentByEmail()`: one sharing behavior for humans and agents

**Decision**: extract the body of `POST /api/docs/:docId/share` (`server/index.js:929-1032`) into `server/share-service.js` as

```js
shareDocumentByEmail({ actor, docId, email, role, baseUrl }) -> { status, body }
```

and call it from both the REST route and the MCP `share_document` tool.

**Rationale**: RBD-053-5 / FR-029 mandate full convergence on all three of the tool's divergences. The tool today is owner-only (`server/mcp/tools/share-document.js:80`), refuses unknown emails (`:90-92`), sends no mail (no `require` of `../../email` anywhere under `server/mcp/`), and writes its own `INSERT` with no `ON CONFLICT` (`:122-125`). Re-implementing four behaviors inside the tool would produce a second sharing implementation that drifts on the next change; extracting the one that already exists produces exactly one. The service is where `granted_by` is stamped, where the `email_enabled` gate is read fresh (`server/index.js:958-961`), and where the viewer-can-only-grant-viewer rule lives (`:951-953`).

The extraction MUST be behavior-preserving for the REST path — same status codes (400 on missing email / invalid role / self-share / owner-target, 403 on no access / viewer-escalation, 201 on both invite and share), same response bodies, same `await`-the-send semantics (`:975-978`). `server/__tests__/api-docs.test.js` and the ShareDialog client tests are the regression net.

**Alternative considered**: leave the REST handler alone and have the MCP tool call `documents.*` primitives in the right order. Rejected — that is the second implementation, verbatim.

---

## R8 — Where the new endpoints live

**Decision**: `server/api/spaces.js` as an `{ init(pool), router }` module (the `server/api/support.js` shape), mounted `app.use('/api/spaces', express.json(), spaces.router)` next to the other `/api/*` mounts at `server/index.js:387`. `PUT /api/docs/:docId/space` stays **inline** in `server/index.js` beside its 23 sibling `/api/docs` routes, as a thin adapter over `spaces.moveDocument()`.

**Rationale**: two competing house conventions. Router modules are cleanly testable (`server/api/__tests__/admin.test.js` mounts the real router with the real middleware); inline `/api/docs` routes are not, and the existing test for them re-implements the handler body inside the test file (`server/__tests__/api-docs.test.js`) — a maintenance hazard worth not extending. New surface gets the good pattern. The one route that must live under `/api/docs` follows local consistency instead, but its *logic* is in `server/spaces.js`, so the behavior is unit-testable without HTTP and the inline adapter is ~8 lines.

**Explicitly rejected**: `app.use('/api/docs', express.json(), someRouter)`. Mounting a body parser at that prefix would run it for **every** `/api/docs*` request, including `POST /api/docs/:docId/images` which deliberately installs its own 20 MB JSON limit (`server/index.js:840`) — a prefix-level 100 KB default parser would consume the body first and break image upload. Route-level middleware only.

**Note**: `express.json()` is NOT global (only `express.urlencoded` is, at `server/index.js:256`), so every new mutating route must attach it itself.

---

## R9 — Search: what changes and what deliberately does not

**Decision**: the four permission joins swap relation name only. `buildRoleCondition(filter, alias)` (`server/search.js:87-91`) switches from `${alias}.role` to `${alias}.direct_role`. The outer query gains `d.space_id` and a `LEFT JOIN spaces`, projecting `space_id`/`space_name` through `formatResults` (`:438-460`). `share_count` (`:319`) stays a count of **direct** shares.

**Rationale**: `ds2.role` is already projected as the row's role (`:314`), so the effective role reaches the client for free once the relation changes. The filter must use `direct_role` for the same reason the list filter does (RBD-053-7): "owned" is about what is *yours*, not what you can *do*; a search filter that disagreed with the list filter and with every admin count would be incoherent. That extension of RBD-053-7 to search is recorded as **RBD-053-14**.

**No reindexing is required.** `document_search_index` and `document_embeddings` are keyed by `doc_id` and contain no permission data; access is applied at query time. Moving a document between spaces therefore changes search *visibility* instantly with zero index work — and `searchIndexer.reindexStale()` is not involved. This is worth stating because it is the one place a reviewer might expect a backfill and find none.

**Hazard**: `hybridSearch` (`:385-425`) emits joins 1, 2 **and** 3 in a single statement; each lives in its own CTE so the `ds` alias does not collide today, and it must still not collide after the change. Covered by `T031`'s hybrid-mode assertions.

---

## R10 — The move endpoint enforces a composed rule, in the service, in one transaction

**Decision**: `spaces.moveDocument(actorId, docId, targetSpaceId | null)` resolves, in one transaction with the document row locked (`SELECT ... FOR UPDATE`):
1. the actor's **direct** role on the document (`document_shares`, not the view — passthrough must not satisfy the ownership half, FR-011/US3-5);
2. the actor's membership role in the **source** space (if any);
3. the actor's membership role in the **target** space (if any);

then applies: *move-out* allowed to direct-owner **or** source-space-owner; *move-in* allowed only to direct-owner **and** target editor-or-owner member; a space→space move must satisfy **both** (RBD-053-3); the curation path (space owner, not direct owner) may only target `NULL`. Same-target moves are a no-op success (spec edge case). A target space that no longer exists fails cleanly (the FK plus an explicit existence check inside the transaction).

**Rationale**: this is the one place in the feature where the union model must be *bypassed*, and getting it wrong is the leak the spec calls out (US3 scenario 5: "even a space-owner's passthrough owner role does not satisfy it"). Reading `document_shares` directly here, with a comment saying why, is clearer than deriving `direct_role` from the view — and the view exposes `direct_role` precisely so the two agree if a later refactor prefers it.

`FOR UPDATE` closes the concurrent-move edge case (spec: "the document's home is always exactly one space or personal — never a dangling reference").

---

## R11 — Last-owner protection is one guard used by three paths

**Decision**: a single `assertNotLastOwner(client, spaceId, userId)` inside `server/spaces.js`, called (inside the mutation's transaction) by leave, remove-member, and change-role-downward. It counts owners with `SELECT count(*) ... WHERE space_id = $1 AND role = 'owner'` under the row lock taken on the affected membership.

**Rationale**: RBD-053-2 / FR-010 extend the design's leave rule to removal and demotion because all three reach the same ownerless state. Three call sites, one predicate, one error message ("promote another member to owner or delete the space") — anything else guarantees the three drift.

---

## R12 — Re-invite monotonicity needs a `GREATEST`-by-rank upsert, which the enum cannot express

**Decision**: role-raising upserts (`space_members` re-invite, `space_invites` re-invite) compute the winner in the app or with an explicit `CASE`, never `GREATEST(EXCLUDED.role, space_members.role)`.

**Rationale**: same inversion as R2. Note that the existing document analogue does **not** have this property: `documents.createInvite` (`server/documents.js:332-346`) does `ON CONFLICT ... DO UPDATE SET role = EXCLUDED.role`, i.e. a later invite **lowers** a pending document invite. RBD-053-9 requires the space behavior to be monotone (raise-only), so the space code deliberately diverges from the document code here. That divergence is intentional and must be commented at the site; the document-invite behavior is out of scope for this feature and is recorded in `promotion-notes.md`.

---

## R13 — Emails: one new template pair, existing escaping discipline, existing gate

**Decision**: add `sendSpaceInvite` / `sendSpaceNotification` to `server/email.js` as a single `sendSpaceEmail({ ..., pending })` function with two thin wrappers — structurally identical to `sendShareEmail` (`server/email.js:155-189`). The `email_enabled` gate stays at the **call site** (where it already lives, `server/index.js:958-961`), read fresh from `users.findById(inviterId)`, and membership is granted regardless (FR-021).

**Rationale**: the space *name* is user-authored text entering an email subject and body — `sanitizeHeader()` on the subject and `escapeHtml()` on every interpolation are mandatory (Principle V, and the existing template does exactly this). `sendEmail` never throws and returns `{ok:false, skipped:true}` when SES is unconfigured, so awaiting it cannot fail an invite. Only these templates are new (spec Assumptions: no rename/removal/deletion/move notifications).

---

## R14 — Test isolation: what the new tables do to the shared helpers

**Decision**: extend `cleanupTestUser` in `server/__tests__/helpers/db.js` (currently deleting from `ai_extra_credits`, `agent_activity_log`, `agent_delegations`, `document_shares`, `documents WHERE creator_id = $1`, `users`) to first delete `space_members WHERE user_id = $1 OR granted_by = $1`, `space_invites WHERE invited_by_user_id = $1`, and `spaces WHERE created_by = $1`. Order matters: `spaces` last of the three, and all three **before** `users`.

**Rationale**: `spaces.created_by` is `ON DELETE SET NULL`, so a test-created space *survives* `cleanupTestUser` and lingers in the worker's database for every later suite on that worker — the same class of cross-suite poisoning that `cleanupDocRows` exists to prevent (`helpers/db.js` docblock at `:217`). Worse, `space_members.granted_by` is `NOT NULL ... NO ACTION`: without the sweep, deleting a test user who granted a membership raises a foreign-key error and fails an unrelated suite's teardown. Constitution II's "suites must not assume they own the only database" makes this mandatory, not tidy.

Backend suites run in parallel with a database per worker; new suites follow the house pattern (`createTestUser`, inline `INSERT INTO documents/document_shares`, `afterAll` cleanup) and must not use fixed UUIDs or fixed space names shared across suites.
