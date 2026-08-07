# Contract — Spaces REST API

Implements FR-038, FR-039, FR-008..FR-013, FR-016..FR-024. Surface is exactly `design/spaces.md` § REST API; nothing is added.

**Module**: `server/api/spaces.js`, shape `{ init(pool), router }` (the `server/api/support.js` pattern), mounted at `server/index.js` next to the other `/api/*` mounts:

```js
app.use('/api/spaces', express.json(), spaces.router);
```

`express.json()` is **not** global in this app (only `express.urlencoded`, `server/index.js:256`), so it is attached at the mount. The one route that cannot live here — `PUT /api/docs/:docId/space` — is declared inline in `server/index.js` with its own `express.json()` (research R8) and is a thin adapter over `spaces.moveDocument()`.

Every route: `requireAuth` (`server/auth/middleware.js:52`) → resolve the caller's membership → act. `requireAuth` already accepts user JWTs, agent OAuth JWTs and `sk_sqd_` API tokens and enforces `documents:read`/`documents:write` scopes for scoped principals, so agent credentials reach these routes with their owner's identity and no token-side change (FR-046).

## Universal rules

| Rule | Behavior |
|---|---|
| **Non-member refusal** | Every `/api/spaces/:id*` route returns **404 `{ error: 'Space not found' }`** when the caller is not a member — identical to the response for a non-existent id. No 403, no timing tell, no membership oracle (RBD-053-10, FR-039, I11). |
| **Insufficient role** | A *member* attempting an owner-only operation gets **403** with a reason. Membership is already established, so distinguishing here leaks nothing. |
| **Role validation** | `role ∈ {owner, editor, viewer}`; anything else → 400. Unlike document sharing, `owner` **is** grantable (D5/FR-009) — but only by an owner, via the "at most your own role" rule. |
| **Name validation** | trimmed, non-empty, ≤100 chars → else 400 `{ error: 'Space name is required' }` / `{ error: 'Space name must be 100 characters or fewer' }`. Duplicates allowed (RBD-053-1/FR-004). |
| **Errors** | `catch` → `console.error` + `notifyException(error, { req, source: 'api' })` + 500, matching every existing route. |
| **No caps** | No limit on spaces per user, members per space, or pending invites (RBD-053-6). |

---

## Endpoints

### `POST /api/spaces` — create
Body `{ name }`. Any authenticated user. Creates the space and, in the same transaction, a `space_members` row `{ role: 'owner', granted_by: self }`.
→ **201** `{ space: { id, name, role: 'owner', memberCount: 1, createdAt } }`

### `GET /api/spaces` — my spaces
Membership-scoped by construction. → **200** `{ spaces: [{ id, name, role, memberCount, createdAt }] }`, ordered by `name`. Empty array for a user in no spaces. Member count and my role are exactly what the design specifies for this endpoint; the **document count lives on the detail endpoint only**, so the list stays one cheap query.

### `GET /api/spaces/:id` — detail
Any member. → **200**
```json
{ "space": { "id": "...", "name": "...", "role": "editor", "documentCount": 12 },
  "members": [{ "userId": "...", "email": "...", "name": "...", "picture": "...",
                "role": "owner", "grantedBy": "...", "createdAt": "..." }],
  "invites": [{ "email": "...", "role": "viewer", "createdAt": "..." }] }
```
Non-member → 404. (Pending-invite addresses are visible to all members; that follows the design's "members, pending invites, document count" detail definition.)

### `PATCH /api/spaces/:id` — rename
Owner only. Body `{ name }`. → **200** `{ space: { id, name } }` · member-not-owner **403** · non-member **404**.

### `DELETE /api/spaces/:id` — delete
Owner only. Cascades `space_members` and `space_invites`; `documents.space_id` reverts to NULL through the FK — **no document is deleted** (FR-024). → **200** `{ deleted: true, documentsReverted: n }` (the count the confirm dialog states; the client fetches it from `GET /api/spaces/:id` *before* confirming).

### `POST /api/spaces/:id/members` — invite by email
Any member; `role` must be ≤ the caller's own role (FR-008/FR-009 — so only an owner can grant `owner`), else **403**.
- Existing account → upsert `space_members`, **raise-only** (FR-019 / I6 / research R12), `granted_by = caller`. Notification email if the caller's `users.email_enabled` is set (FR-021). → **201** `{ member: {...} }`
- Unknown address → upsert `space_invites`, **raise-only** on `(space_id, lower(email))` (RBD-053-9 / I5). Invite email under the same gate. → **201** `{ invite: { email, role, pending: true } }`
- Inviting yourself or an existing member: treated as a re-invite (raise or no-op), never an error (spec edge case).
- Membership/invite is granted **regardless** of whether mail is sent.

### `PUT /api/spaces/:id/members/:userId` — change role
Owner only. Body `{ role }`. Demoting the last owner → **409** `{ error: 'A space must have at least one owner. Make another member an owner first, or delete the space.' }` (FR-010/I3). → **200** `{ member: {...} }`

### `DELETE /api/spaces/:id/members/:userId` — remove / leave
`:userId === caller` is **leaving** (any member); otherwise owner only. Removing the last owner → **409**, same message. Deletes only the `space_members` row; the member's direct shares on space documents survive (FR-022). → **200** `{ removed: true }`

### `DELETE /api/spaces/:id/invites` — revoke a pending invite
Owner only (RBD-053-4 / FR-023). Body `{ email }`, matched case-insensitively. Idempotent. → **200** `{ revoked: true }`

### `PUT /api/docs/:docId/space` — move *(inline in `server/index.js`)*
Body `{ spaceId: "<uuid>" | null }`. Delegates to `spaces.moveDocument(userId, docId, spaceId)`.

| Outcome | Status |
|---|---|
| moved (or already there — no-op success) | **200** `{ docId, spaceId, spaceName }` |
| caller has no access to the document | **404** `{ error: 'Document not found' }` |
| move-in without a **direct** owner share | **403** `{ error: 'Only the document owner can move it into a space' }` |
| move-in without editor-or-owner membership in the target | **403** `{ error: 'You must be an editor or owner of the target space' }` |
| move-out by neither direct owner nor space owner | **403** |
| curation path (space owner, not doc owner) targeting another space | **403** `{ error: 'You can only move this document out to your personal area' }` (RBD-053-3/FR-013) |
| target space missing/deleted | **404** `{ error: 'Space not found' }` |

Authorization detail (FR-011/FR-012, research R10): the **ownership half reads `document_shares` directly, not `document_access`** — a passthrough owner must not be able to move a document into a space (US3 scenario 5). Runs in one transaction with `SELECT ... FOR UPDATE` on the document row. Never writes `document_shares` (I9/FR-014).

### `GET /api/docs?space=` — list filter (FR-026/FR-040)
`space` ∈ `all` (default, unchanged behavior) | `personal` | `<uuid>`. Composes with the existing `filter=all|owned|shared_with_me` (which continues to mean **direct** ownership) and with `search`, `sortBy`, `limit`, `offset`, `updatedSince`. Rows gain `spaceId` and `spaceName`.

---

## Service layer (`server/spaces.js`)

Mirrors `server/documents.js`: `init(pool)`, JSDoc on every export, no Express types.

```
createSpace(name, creatorId)                    getSpacesForUser(userId)
getSpace(spaceId)                               getSpaceDetail(spaceId, viewerId)
renameSpace(spaceId, name)                      deleteSpace(spaceId)
getMemberRole(spaceId, userId)                  getMembers(spaceId)
inviteMember(spaceId, email, role, actorId)     setMemberRole(spaceId, userId, role, actorId)
removeMember(spaceId, userId)                   getInvites(spaceId)  revokeInvite(spaceId, email)
convertPendingSpaceInvites(client, user)        countDocuments(spaceId)
moveDocument(actorId, docId, targetSpaceId)     assertNotLastOwner(client, spaceId, userId)
```

`convertPendingSpaceInvites` takes an existing pg **client** so it runs inside `convertPendingInvites`' transaction (research R6). `assertNotLastOwner` likewise takes a client — the guard must be inside the mutation's transaction, under the row lock, or two concurrent leaves can both pass it.
