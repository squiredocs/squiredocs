# Contract — Agent surface

Implements FR-028, FR-029, FR-046, FR-047 (RBD-053-8). The theme: agents see exactly their owner's spaces, through the same derivation, with no credential change.

## 1. No credential changes (FR-046)

`sk_sqd_` API tokens and OAuth delegations are user-scoped and resolve to a `userId` in `permissions.extractUser` (`server/permissions.js:30-90`), which every MCP request already passes through. Access is re-derived per request from that user's effective roles, so a space grant reaches an agent the moment it is made and disappears the moment it is revoked. **Nothing** in `server/mcp/auth/` is touched. Space-scoped tokens are a stated non-goal.

Scope enforcement is unchanged: `TOOL_SCOPES` in `server/mcp/tools/index.js:121-146` maps each tool to `documents:read`/`documents:write` and `executeTool` enforces it at `:208-214`.

## 2. Rerouting the six inline permission checks (FR-028)

| File | Today | After |
|---|---|---|
| `server/mcp/agent-presence.js:166-183` `_verifyDocumentAccess` | one query joining `documents`, `document_shares`, `users` | `documents.getRole(docGuid, userId)` for the role + a separate `users` lookup for `name/email/picture`. `null` role → the existing `throw new Error('Document not found or you do not have access')`. The `options.requiredRole` gate at `:751-756` and the `ROLES` import at `:10` are unchanged. |
| `server/mcp/tools/set-document-title.js:58-74` | inline join, `role !== 'owner' && role !== 'editor'` | `documents.getRole` + `documents.ROLES[role] >= documents.ROLES.editor` |
| `server/mcp/tools/set-document-version-name.js:186-202` | inline join, role read but unused (viewer+, Sam-ratified 2026-07-19 F9) | `documents.hasAccess(docGuid, userId)`; keep the explanatory comment |
| `server/mcp/tools/list-document-versions.js:111-122` | inline join, viewer+ | `documents.hasAccess` |
| `server/mcp/tools/share-document.js:70,103,116,123` | own access join, owner-only, own INSERT/UPDATE | deleted; `shareDocumentByEmail()` (see `contracts/share-attribution.md` §3) |
| *(implicit)* `server/mcp/tools/list-documents.js` | `documents.getAccessibleDocuments` / `search.searchDocuments` | inherits the space leg automatically |

**Error strings must be preserved byte-for-byte** where the behavior is unchanged (`'Document not found or you do not have access'`, `'You do not have edit permission for this document'`). Agents are trained on these strings; changing them is a silent behavior change for every client.

`_verifyDocumentAccess` is the highest-leverage single edit in this list: it is the de-facto permission gate for `get_collaborators` (`agent-presence.js:63`), `create_document` (`:231-232`), `modify` (`:283`), `read_document` (`:110`) and `restore_document_version` (`:85`, which passes `{ requiredRole: 'editor' }`) — none of which has SQL of its own.

Already on the shared layer and untouched: `compare-document-versions.js:123`, `read-helpers.js:75`, `undo-redo-handler.js:29-32`, `modify.js:428`, `image-validate.js:97`.

## 3. `list_documents`: space name + space filter (FR-047 / RBD-053-8)

`server/mcp/tools/list-documents.js`:

- **Input schema** (`:49-119`) gains:
  ```js
  space: {
    type: 'string',
    description: "Scope results to a space: a space id, 'personal' for documents not in any space, or 'all' (default).",
  }
  ```
  This declaration is **mandatory**, not cosmetic: `validateToolArgs` (`server/mcp/tools/index.js:156-189`) rejects unknown parameters outright, so an undeclared `space` argument fails the call with "unknown parameter".
- **Handler** (`:121-203`) forwards `space` to `documents.getAccessibleDocuments` (`:175-182`) and to `search.searchDocuments` for the content-search branch, so both branches honor the filter.
- **Result mapping** (`:185-195` list branch, `:153-161` search branch) gains `space: { id, name } | null`.
- The `description` template literal (`:24-47`) contains worked EXAMPLES and must be updated in the same edit, or the tool documents a surface it no longer has.
- `filter: 'owned'` continues to mean a **direct** owner share (RBD-053-7): an agent whose owner is a space-owner member does not see every space document reported as "owned".

## 4. `get_tool_documentation`

Any prose that says `share_document` is owner-only, or that documents live only in a personal area, must be corrected in the same change — the tool descriptions and `get_tool_documentation` content are the agent-facing docs, and Principle I applies to them as much as to `README.md`.

## 5. What agents do NOT get in v1

- No space-management tools (create/invite/move are human surfaces in v1; the design's REST list is the whole surface and no MCP equivalents are specified).
- No space-scoped tokens (explicit non-goal).
- No change to presence identity, awareness dedup, or the agent-name attribution path (FR-031).
