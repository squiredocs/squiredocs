# Contract — Share attribution (`granted_by`) and the one sharing behavior

Implements US5 / FR-032..FR-037 and FR-029 (RBD-053-5). Two things that must ship together, because the convergence is what makes the attribution complete.

---

## 1. `documents.setRole(docId, userId, role, grantedBy)` — the chokepoint

```js
async function setRole(docId, userId, role, grantedBy) {
  if (!pool) throw new Error('Documents module not initialized');
  if (!ROLES[role]) throw new Error(`Invalid role: ${role}`);
  if (!grantedBy) throw new Error('setRole requires grantedBy (D8: every share records its grantor)');

  const result = await pool.query(
    `INSERT INTO document_shares (doc_id, user_id, role, granted_by)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (doc_id, user_id) DO UPDATE SET role = $3, granted_by = $4
     RETURNING *`,
    [docId, userId, role, grantedBy]
  );
  return result.rows[0];
}
```

`grantedBy` is **required**, not defaulted (research R5): a default would silently mis-attribute a future caller; a throw fails the first test that touches the path. `ON CONFLICT` overwrites the grantor because a role change *is* a new grant by the acting user.

Callers to update:
- `documents.createDocument(docId, ownerId, title)` → `setRole(docId, ownerId, 'owner', ownerId)` (`server/documents.js:137`). The creator grants themselves.
- `server/document-service.js:551` `createSeededDocument` — no signature change needed (it already passes `userId` as the owner), but it gains an optional `spaceId` for FR-044.
- `server/onboarding.js:50` — unchanged; attribution flows through `createDocument`.
- `server/index.js:1006` and `:1067` — both move into `share-service.js` (§3).

## 2. Invite conversion (`server/auth/users.js:115-144`)

Keeps its inline SQL (the circular-require rationale at `:111-112` stands) and gains the grantor with the backfill's own fallback chain, because `document_share_invites.invited_by_user_id` is **nullable** (`ON DELETE SET NULL`) while `granted_by` is NOT NULL — **RBD-053-13**:

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

The same transaction then converts space invites (`contracts/spaces-rest-api.md` → `convertPendingSpaceInvites(client, user)`) and deletes both sets of consumed rows. The function's contract of **never throwing** (`:105-107`) is preserved: one `try` / one `ROLLBACK` / one swallow, so a space-invite problem can never cost a user their login or their document invites.

## 3. `server/share-service.js` — `shareDocumentByEmail()`

Extraction of `server/index.js:929-1032`, verbatim in behavior, called by both the REST route and the MCP tool.

```js
/**
 * @returns {Promise<{status:number, body:object}>}
 */
async function shareDocumentByEmail({ actor, docId, email, role = 'editor', baseUrl })
```

`actor` is `{ userId, email, name }` — from `req.user` for REST, from the agent token's owner for MCP.

Ordered behavior (each step keeps its current status code and message):

1. `email` missing → `400 { error: 'email is required' }`
2. `role` not in `ROLES` or `=== 'owner'` → `400 { error: 'Invalid role. Use "editor" or "viewer"' }` — the document owner role stays ungrantable (D6); only the *space* owner role is grantable.
3. `documents.getRole(docId, actor.userId)` — now **effective** (§ `access-derivation.md`), so a space editor can share a space document. Falsy → `403 { error: 'You do not have access to this document' }`
4. viewer trying to grant above viewer → `403 { error: 'Viewers can only share with viewer access' }` (D6/FR-007)
5. read `users.findById(actor.userId).email_enabled` fresh → `canEmail`
6. unknown address → `documents.createInvite(docId, email, role, actor.userId)`; if `canEmail`, `await sendShareInvite(...)` → `201 { invite: { email, role, pending: true } }`
7. self-share → `400 { error: 'Cannot share with yourself' }`
8. target is the owner → `400 { error: "Cannot change owner's role" }`
9. `documents.setRole(docId, target.id, role, actor.userId)`; if `canEmail`, `await sendShareNotification(...)` → `201 { user: {...} }`

Sends are **awaited** (the `server/index.js:975-978` rationale: an in-flight SES call is dropped if the pod is shutting down mid-deploy; `sendEmail` never throws so it cannot fail the request).

### What this does to the MCP `share_document` tool

`server/mcp/tools/share-document.js` loses lines 66-130 entirely (its own access join at `:70`, the owner-only refusal at `:80`, the "No user found with email" throw at `:90-92`, the role lookup at `:103`, the `UPDATE` at `:116`, the `INSERT` at `:123`) and calls the service. Consequences, all mandated by RBD-053-5/FR-029:

| Before | After |
|---|---|
| owner-only | viewer-can-share, at most your own role (D6) |
| unknown email → throw | pending invite created |
| never emails | emails under the `email_enabled` gate |
| no grantor | grantor = the token's owner |
| bare `INSERT`, no conflict clause | `setRole` upsert |

The tool's `description` (`:23-25`, "Only the document owner can share") and its returned message must be rewritten to match, and `get_tool_documentation` content checked for the same claim. A tool that still advertises owner-only after the behavior changed is exactly the agent-experience defect the pipeline's feedback rule targets.

## 4. Admin sharing view (FR-037)

`server/api/admin.js` `GET /users/:userId/sharing` (`:408-462`):
- Delete the caveat comment at `:410-412` ("document_shares has no 'granted_by', so shares are scoped to owned docs").
- The shares query stops being owner-scoped and becomes grantor-scoped, which is what the endpoint always wanted to say:
  ```sql
  SELECT d.id AS doc_id, d.title AS doc_title,
         mu.email, mu.name, s.role, s.created_at
    FROM document_shares s
    JOIN documents d ON d.id = s.doc_id
    JOIN users mu ON mu.id = s.user_id
   WHERE s.granted_by = $1 AND s.user_id <> $1
   ORDER BY d.title NULLS LAST, s.created_at ASC
  ```
- The invites query (`:418-425`) is unchanged.
- `client/src/pages/AdminPage.jsx:728-778`: the section heading "Shared on owned docs" (`:755`) becomes "Shares they granted", the empty state (`:757`) follows, and a **Granted by** column is unnecessary here (every row is by definition granted by the profiled user) — instead the *document* column keeps its title and the row set is now complete rather than owner-scoped. Backfilled rows are indistinguishable from exact ones by design (FR-033); no UI hedge is added.
- `server/__tests__/admin-sharing.test.js:88-101` must be updated to the new scoping.

**Counts that must NOT change** (FR-030 / RBD-053-7): `server/api/admin.js:175-180` (`doc_count`), `:563-573` (`authored_non_welcome_doc`), and `server/onboarding.js:74-85` (`isEngaged`) all keep reading `document_shares WHERE role = 'owner'`. A regression test asserts a space-owner member's counts are unaffected by passthrough — the absence of a diff is not evidence.

## 5. Grantor lifetime (FR-035, RBD-053-11) — **the design's premise is false**

`granted_by` is `ON DELETE NO ACTION` on both `document_shares` and `space_members`, as the design requires. But `design/spaces.md` asserts "There is no account-deletion path today", and there is: `server/auth/users.js:335-386` `deleteUserByEmail()`, reachable through `server/auth/routes.js:758` (synthetic wipe) and `:824` (prod single-account reset), covered by `server/__tests__/integration/faucet-wipe.test.js` and `prod-reset.test.js`.

Its final `DELETE FROM users WHERE id = $1` will raise a foreign-key violation whenever the deleted account granted a share on a document it does not own — reachable today because `REQUIRED_ROLES.share = 'viewer'` lets any collaborator share onward.

**Required change** (the design's own rule, applied to the path that exists), inserted immediately before the final user delete, inside the same transaction:

```sql
-- Reassign grants made by this account to each document's current owner, so the
-- NO ACTION grantor FK cannot block the delete and no attribution is orphaned.
UPDATE document_shares s
   SET granted_by = COALESCE(
         (SELECT o.user_id FROM document_shares o
           WHERE o.doc_id = s.doc_id AND o.role = 'owner' AND o.user_id <> $1 LIMIT 1),
         s.user_id)
 WHERE s.granted_by = $1;

UPDATE space_members m
   SET granted_by = COALESCE(
         (SELECT o.user_id FROM space_members o
           WHERE o.space_id = m.space_id AND o.role = 'owner' AND o.user_id <> $1 LIMIT 1),
         m.user_id)
 WHERE m.granted_by = $1;
```

Both run **after** the account's own documents are deleted (their shares go with them) and before `DELETE FROM users`, so only cross-owner residue is reassigned.

This conflicts with the spec's Out of Scope ("the grantor reassignment rule is stated for a future path, not built here"). It is escalated as a **HIGH** analyze finding, not resolved by quietly widening scope, and `design/spaces.md` needs a Squire-side amendment.
