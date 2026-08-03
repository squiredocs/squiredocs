# Document Permissions & Sharing

## Overview

The application uses a Role-Based Access Control (RBAC) system for document permissions. Each document can be shared with multiple users, each with a specific role that determines their access level.

## Roles

### Owner
- **Full control**: Can edit, share, manage roles, and delete documents
- **Immutable**: The creator of a document is always the owner (stored in `documents.creator_id`)
- **Cannot be changed**: Owner role cannot be transferred or removed

### Editor
- **Edit access**: Can edit document content
- **Manage sharing**: Can add users, change roles, and remove access
- **Cannot delete**: Cannot delete the document

### Viewer
- **Read-only access**: Can view document but cannot edit
- **Limited sharing**: Can only add other users as viewers
- **Cannot manage**: Cannot change roles or remove access

## Database Schema

### `documents` Table
Stores document metadata:
- `id` (UUID): Document identifier
- `creator_id` (UUID): User who created the document (immutable audit trail)
- `created_at`, `updated_at`: Timestamps

### `document_shares` Table
Manages user-document access relationships:
- `doc_id` (UUID): Reference to document
- `user_id` (UUID): Reference to user
- `role` (enum): One of `'owner'`, `'editor'`, `'viewer'`

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
- **Permission**: Owner only
- **Action**: Deletes document record, all shares, and Yjs data

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

Document tests are in `server/__tests__/documents.test.js`:
- Document creation and ownership
- Share management
- Role updates
- Access removal
