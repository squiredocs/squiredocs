# Document Permissions & Sharing

## Overview

The application uses a Role-Based Access Control (RBAC) system for document permissions. Each document can be shared with multiple users, each with a specific role that determines their access level.

A user reaches a document by one of two routes, and holds whichever role is
stronger: a **direct share** (`document_shares`), or membership of the **space**
the document lives in (`space_members`, via `documents.space_id`). Both use the
same three roles. See "Spaces" below.

## Roles

### Owner
- **Full control**: Can edit, share, manage roles, and delete documents
- The creator of a document is always its first owner (also recorded immutably
  in `documents.creator_id` as an audit trail)
- **Not transferable at the document level**: there is no way to hand ownership
  of one document to someone else. Ownership of a *space* IS transferable —
  promote another member to owner, and every document in that space is owned by
  both of you

### Editor
- **Edit access**: Can edit document content
- **Manage sharing**: Can add users, change roles, and remove access
- **Cannot delete**: Cannot delete the document

### Viewer
- **Read-only access**: Can view document but cannot edit
- **Limited sharing**: Can only add other users as viewers
- **Cannot manage**: Cannot change roles or remove access

## Spaces

A **space** is a named container with a member list. Every document has exactly
one home: a space, or the owner's personal area (`documents.space_id IS NULL`,
the state of every document that predates spaces).

### The union rule

A user's effective role on a document is the **stronger of** their direct role
and their role in the document's space. The space role passes through
**uncapped**: a space owner is an owner of every document in that space,
including delete, share management and move-out.

This is computed in exactly ONE place — the `document_access` view — and every
authorization site reads it, directly or through `documents.getRole()`. A new
access site uses that relation, never another `document_shares` join. The
failure this prevents is specific: a missed site makes space documents readable
but absent from search results.

WARNING: never `GREATEST()` a `doc_role`. The enum is declared
`['owner','editor','viewer']`, so PostgreSQL collates `owner < editor < viewer`
— the exact inverse of the privilege ladder, and `GREATEST('owner','viewer')`
returns `'viewer'`. Role comparison is integer-rank arithmetic, and it happens
only inside the view. `server/__tests__/spaces-model.test.js` asserts the
inversion so it cannot be "cleaned up" back into the code.

### "Owned" still means a direct owner share

Everything that counts or filters on ownership — the list's `owned` filter, the
search `owned` filter, the admin document count, the onboarding engagement check
— reads `document_access.direct_role` or `document_shares` directly. Being an
owner of a space does not make its documents *yours*; it makes them ones you can
*act on*.

### Operations

| Operation | Who |
|---|---|
| Create a space | Any authenticated user |
| Invite by email | Any member, at most at their own role — so only an owner can grant `owner` |
| Change a member's role | Owner |
| Remove a member | Owner (a member may always remove themselves — "leave") |
| Revoke a pending invite | Owner |
| Rename or delete the space | Owner |
| Move a document IN | The document's **direct** owner, who is also an editor or owner of the target |
| Move a document OUT | The document's direct owner, **or** an owner of the space (curation — may only move it to personal) |

A space always has at least one owner: the last owner cannot leave, be removed,
or be demoted. The refusal names the fix.

Deleting a space deletes **no document**. Its documents revert to personal
through `documents.space_id`'s `ON DELETE SET NULL`; content, history and direct
shares are untouched.

Non-members cannot distinguish a space they are not in from one that does not
exist: every `/api/spaces/:id*` route answers a non-member with 404.

## Database Schema

### `documents` Table
Stores document metadata:
- `id` (UUID): Document identifier
- `creator_id` (UUID): User who created the document (immutable audit trail)
- `space_id` (UUID, nullable): the document's home. NULL means personal.
  `ON DELETE SET NULL`, which IS the space-deletion semantic
- `created_at`, `updated_at`: Timestamps

### `document_shares` Table
Manages user-document access relationships:
- `doc_id` (UUID): Reference to document
- `user_id` (UUID): Reference to user
- `role` (enum): One of `'owner'`, `'editor'`, `'viewer'`
- `granted_by` (UUID, NOT NULL): who made this grant. `ON DELETE NO ACTION`, so
  a grantor cannot vanish under a live grant — `deleteUserByEmail` reassigns
  grants to the document's current owner before deleting an account. Rows that
  predate the column were backfilled to the most likely grantor (the document's
  owner, then its creator, then the share's own holder), so a backfilled value
  is a good guess rather than a record

### `spaces`, `space_members`, `space_invites` Tables
- `spaces`: `id`, `name` (100 chars max, duplicates allowed), `created_by`
  (audit only — the *owner* is a `space_members` row), timestamps
- `space_members`: `(space_id, user_id)` unique, `role` (the same `doc_role`
  enum), `granted_by` NOT NULL
- `space_invites`: pending invites for addresses with no account yet, unique per
  `(space_id, lower(email))`, converted to memberships at first login in the
  same transaction as document invites

### `document_access` View
The single derivation of effective access. Columns:
- `doc_id`, `user_id`: the only non-aggregated columns, deliberately — quals on
  them push down through the aggregate into both legs and reach the underlying
  indexes. **Do not add `space_id` to this view**; the callers that need it
  already have `documents` in scope
- `role`: the effective role, the stronger of the two legs
- `direct_role`: the `document_shares` role, or NULL. This is what "owned" means
- `space_role`: the membership role via `documents.space_id`, or NULL

A `(doc_id, user_id)` row exists **iff** the user has at least viewer access by
some route. Absence means no access, exactly as a missing `document_shares` row
did before spaces existed.

## Permission Enforcement

### Server-Side

All permission checks go through `server/permissions.js`:

```javascript
const permissions = require('./permissions');

// Check if user can perform an action
const canEdit = await permissions.can.edit(userId, docId);
if (!canEdit.allowed) {
  return res.status(403).json({ error: canEdit.reason });
}
```

**Available permission checks:**
- `permissions.can.view(userId, docId)` - Check view access
- `permissions.can.edit(userId, docId)` - Check edit access
- `permissions.can.share(userId, docId)` - Check share access
- `permissions.can.manage(userId, docId)` - Check manage access (change roles, remove users)
- `permissions.can.delete(userId, docId)` - Check delete access

**WebSocket Enforcement:**
- Viewers' edit frames are intercepted and dropped at the WebSocket level, before y-websocket sees them
- `server/ws-edit-gate.js` owns both the classification (`classifyFrame`) and the interceptor that installs it (`installGate`). Production and the tests import the same module, so the gate that ships is the gate that is tested
- **An edit is any frame that can reach `Y.applyUpdate`** — that means sync *update* frames **and** sync *step2* frames. Step2 was previously misclassified as read-only, which let a viewer write by framing content as a step2 reply (fixed in feature 038). Any new sync message type must be classified in that module before it ships
- Blocked frames are dropped silently: the connection stays open, the client is not notified, and a `WS_EDIT_BLOCKED` / `WS_STEP2_BLOCKED` event is logged. Note that ordinary viewer clients answer the server's step1 with a step2, so `WS_STEP2_BLOCKED` is a normal-traffic signal, not an attack signal
- **Exception — a DEGRADED connection is closed, not silently dropped.** The 60-second role re-check fails closed, so a transient database error blocks edits from someone who may in fact edit. Dropping those frames silently would desynchronize that editor permanently: y-websocket re-sends only on reconnect, so every later frame would reference structs the server never received and would sit unintegrated and unpersisted. When an edit frame is refused because the re-check *errored* rather than because the role actually changed, the socket is closed with 1013 and the client reconnects and re-supplies. A genuine editor→viewer downgrade keeps the drop-and-stay-open behavior above
- Downward sync is unaffected — viewers still receive all document updates

### Client-Side

- **Read-only mode**: Viewers see a "View only" banner and cannot interact with the editor
- **UI restrictions**: Share dialog shows appropriate controls based on user role
- **Menu options**: Delete option is disabled for non-owners

## Sharing Workflow

### Adding Users

1. Click "Share" button (available to all users with access)
2. Enter user's email address
3. Select role (restricted by current user's role):
   - **Viewers**: Can only add other viewers
   - **Editors/Owners**: Can add editors or viewers
4. User receives access immediately

### Changing Roles

- **Editors and Owners** can change roles of other users
- Users **cannot change their own role**
- Owner role **cannot be changed** (immutable)

### Removing Access

- **Editors and Owners** can remove access for other users
- Users **cannot remove their own access**
- Owner access **cannot be removed**

## API Endpoints

### `GET /api/docs`
Returns all documents the user has access to, including:
- Document metadata (title, updatedAt)
- User's role for each document
- Share count (for badge display)

### `POST /api/docs/:docId/share`
Share document with a user by email:
- **Body**: `{ email: string, role: 'editor' | 'viewer' }`
- **Permission**: Requires access to document
- **Restriction**: Viewers can only add viewers

### `PUT /api/docs/:docId/share/:targetUserId`
Update a user's role:
- **Body**: `{ role: 'editor' | 'viewer' }`
- **Permission**: Requires `manage` permission (editor or owner)
- **Restrictions**: Cannot change own role, cannot change owner role

### `DELETE /api/docs/:docId/share/:targetUserId`
Remove a user's access:
- **Permission**: Requires `manage` permission (editor or owner)
- **Restrictions**: Cannot remove own access, cannot remove owner access

### `DELETE /api/docs/:docId`
Delete a document:
- **Permission**: Owner only (effective, so an owner of the document's space
  qualifies)
- **Action**: Deletes document record, all shares, and Yjs data

### `GET /api/docs?space=`
Scope the list to `all` (default, unchanged behavior), `personal`, or a space
id. Composes with `filter=all|owned|shared_with_me`, which continues to mean
**direct** ownership. Rows gain `spaceId` and `spaceName`.

### `PUT /api/docs/:docId/space`
Move a document. **Body**: `{ spaceId: "<uuid>" | null }`.
- **200** moved (or already there — a same-target move is a no-op success)
- **404** `Document not found` — no access, or the document does not exist
- **404** `Space not found` — the target does not exist, or the caller is not a
  member of it
- **403** with the specific reason: not the document's owner, not an editor of
  the target, or the curation path may only target personal

Never writes `document_shares`: a move changes reachability, not grants.

### Spaces

| Route | Permission |
|---|---|
| `POST /api/spaces` | Any authenticated user. Body `{ name }` |
| `GET /api/spaces` | Membership-scoped by construction |
| `GET /api/spaces/:id` | Any member. Returns members, pending invites and the document count |
| `PATCH /api/spaces/:id` | Owner. Body `{ name }` |
| `DELETE /api/spaces/:id` | Owner. Returns `{ deleted, documentsReverted }` |
| `POST /api/spaces/:id/members` | Any member, role at most their own. Body `{ email, role }` |
| `PUT /api/spaces/:id/members/:userId` | Owner. Body `{ role }`. 409 for the last owner |
| `DELETE /api/spaces/:id/members/:userId` | Owner, or the member themselves (leaving). 409 for the last owner |
| `DELETE /api/spaces/:id/invites` | Owner. Body `{ email }`. Idempotent |

Every `:id` route answers a non-member with **404 `Space not found`**.

## UI Features

### Share Badges
- **Green badge**: Document shared with you by someone else
- **Purple badge**: Document you own that's shared with others
- Hover tooltips: "Shared with me" or "Shared"

### Share Dialog
- Shows document title in header: "Share '[Title]'"
- Lists all users with access
- Role selector for users you can manage
- Remove access button for users you can manage
- Current user's role is read-only (cannot change own role)

### Document List
- Shows "Opened [date time]" for all documents
- Share badge indicates sharing status
- 3-dot menu with Share and Delete options
- Delete option disabled for non-owners

## Testing

Permission tests are in `server/__tests__/permissions.test.js`:
- Role hierarchy checks
- Permission enforcement
- WebSocket edit message detection
- Effective-role resolution through a space membership

Document tests are in `server/__tests__/documents.test.js`:
- Document creation and ownership
- Share management
- Role updates
- Access removal

Spaces:
- `spaces-model.test.js` — the `doc_role` enum inversion, and the
  `document_access` view's semantics at the SQL level
- `spaces-effective-role.test.js` — the full 4x4 direct-by-space matrix through
  `getRole`, the list, and `permissions.can.*`
- `spaces-search.test.js` — visibility in all three search modes, for a member
  and a non-member
- `spaces-move.test.js` — the move rule set, share preservation, revocation
- `spaces-api.test.js` and `spaces-membership.test.js` — the REST surface and
  the membership lifecycle
- `share-attribution.test.js` — `granted_by` on every write path, and the counts
  that must NOT change
- `server/mcp/__tests__/tools/space-access.test.js` — the MCP tools reach space
  members through the same derivation
