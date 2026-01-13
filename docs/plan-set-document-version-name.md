# Plan: set_document_version_name Tool

## Overview

Create a new MCP tool that **replaces** `create_document_version` with a unified interface for all named version operations:
- **CREATE** - Name the current document version as a checkpoint
- **UPDATE** - Rename an existing named version
- **DELETE** - Remove a named version (set name to null with versionId)

This replaces 1 existing tool, keeping the total at 21 MCP tools.

## Tool Specification

**Tool Name:** `set_document_version_name`

**Parameters:**
```typescript
{
  docGuid: string;        // Document UUID (required)
  name: string | null;    // Version name (required)
                          // - string: create new or rename existing version
                          // - null: DELETE named version (requires versionId)
  versionId?: string;     // UUID of version to modify (optional)
                          // - absent: create new named version from current state
                          // - present: update or delete existing version
}
```

**Behavior:**
| versionId | name | Action |
|-----------|------|--------|
| absent | "Draft 1" | **CREATE** new named version from current state |
| present | "Final" | **UPDATE** existing version's name |
| present | null | **DELETE** named version (non-destructive) |
| absent | null | **ERROR** - Cannot create unnamed version |

**Returns:**
```typescript
{
  success: boolean;
  version?: {              // Absent when deleted
    id: string;
    name: string | null;   // null when deleted
    clockStart: number;
    clockEnd: number;
    timestamp: string;
  };
  created?: boolean;       // true for CREATE
  updated?: boolean;       // true for UPDATE
  deleted?: boolean;       // true for DELETE
  message: string;
}
```

## Error Cases

| Scenario | Error Message |
|----------|---------------|
| `name: null` with no `versionId` | `Cannot create unnamed version. Provide versionId to remove a version name, or provide a name to create a new version` |
| Empty/whitespace name | `Version name cannot be empty` |
| Name too long (>255 chars) | `Version name cannot exceed 255 characters` |
| versionId not found | `Version not found` |
| versionId is auto-version | `Cannot modify auto-generated versions. Only named versions can be renamed or deleted` |
| Document has no history (CREATE) | `Cannot create version: document has no edit history` |
| Permission denied | `Permission denied: viewers cannot manage document versions` |
| Document not found | `Document not found or you do not have access` |

## Implementation

### Backend Logic

```javascript
async function handler(args, agentToken) {
  const { docGuid, name, versionId } = args;
  const userId = agentToken.userId;

  // Check document access and role (editor/owner required)
  const access = await checkDocumentAccess(docGuid, userId);
  if (access.role === 'viewer') {
    throw new Error('Permission denied: viewers cannot manage document versions');
  }

  if (versionId) {
    // MODIFY existing version (update or delete)

    if (!isUUID(versionId)) {
      throw new Error('Cannot modify auto-generated versions. Only named versions can be renamed or deleted');
    }

    const version = await getNamedVersion(docGuid, versionId);
    if (!version) {
      throw new Error('Version not found');
    }

    if (name === null) {
      // DELETE: Remove the named version
      await deleteNamedVersion(docGuid, versionId);
      return {
        success: true,
        deleted: true,
        message: 'Named version removed from timeline'
      };
    } else {
      // UPDATE: Rename the version
      const trimmedName = name.trim();
      if (!trimmedName) throw new Error('Version name cannot be empty');
      if (trimmedName.length > 255) throw new Error('Version name cannot exceed 255 characters');

      const updated = await updateNamedVersion(docGuid, versionId, trimmedName);
      return {
        success: true,
        updated: true,
        version: updated,
        message: `Version renamed to "${trimmedName}"`
      };
    }
  } else {
    // CREATE new named version from current state

    if (name === null) {
      throw new Error('Cannot create unnamed version. Provide versionId to remove a version name, or provide a name to create a new version');
    }

    const trimmedName = name.trim();
    if (!trimmedName) throw new Error('Version name cannot be empty');
    if (trimmedName.length > 255) throw new Error('Version name cannot exceed 255 characters');

    // Get current version from timeline
    const timeline = await getVersionTimeline(persistence, docGuid);
    if (timeline.versions.length === 0) {
      throw new Error('Cannot create version: document has no edit history');
    }

    const currentVersion = timeline.versions[0]; // Most recent
    const created = await createNamedVersion(
      docGuid,
      currentVersion.clockStart,
      currentVersion.clockEnd,
      trimmedName,
      userId
    );

    return {
      success: true,
      created: true,
      version: created,
      message: `Version "${trimmedName}" created successfully`
    };
  }
}
```

### Database Operations

- **CREATE:** `INSERT INTO document_versions (doc_id, name, clock_start, clock_end, created_by, snapshot_data) VALUES (...)`
- **UPDATE:** `UPDATE document_versions SET name = $1 WHERE id = $2 AND doc_id = $3`
- **DELETE:** `DELETE FROM document_versions WHERE id = $1 AND doc_id = $2`

### Important: Non-Destructive Deletion

When deleting a named version (setting name to null):
- The database record is removed from `document_versions` table
- The underlying edits in `yjs_updates` remain intact
- The timeline will show auto-generated versions for those clock ranges
- **No document content is lost**

## Permissions

- Requires `editor` or `owner` role for all operations
- Viewers cannot create, update, or delete versions
- Users can modify any named version on documents they have edit access to

## Files

**Create:**
- `server/mcp/tools/set-document-version-name.js`

**Delete:**
- `server/mcp/tools/create-document-version.js` (being replaced)
- `server/mcp/tools/__tests__/create-document-version.test.js` (if exists)

**Modify:**
- `server/mcp/index.js` - Remove old tool registration, add new tool

## Tool Description Format

The tool's `description` field must **prominently mention deletion**:

```
═══════════════════════════════════════════════════════════════════════════
OVERVIEW
═══════════════════════════════════════════════════════════════════════════

Unified tool for managing named versions with three operations:

1. CREATE: Name the current document state as a checkpoint
2. UPDATE: Rename an existing named version
3. DELETE: Remove a named version (set name to null with versionId)

⚠️ IMPORTANT: To delete a named version, pass name: null with the versionId.
The underlying document history is preserved - only the name is removed.

═══════════════════════════════════════════════════════════════════════════
EXAMPLES
═══════════════════════════════════════════════════════════════════════════

// Create a named version
await set_document_version_name({
  docGuid: "abc-123",
  name: "Draft 1"
});

// Rename an existing version
await set_document_version_name({
  docGuid: "abc-123",
  versionId: "550e8400-...",
  name: "Final Draft"
});

// DELETE a named version (set name to null)
await set_document_version_name({
  docGuid: "abc-123",
  versionId: "550e8400-...",
  name: null
});
```

## Testing

### Unit Tests

**CREATE mode (no versionId):**
- ✅ Create new version from current state
- ✅ Empty name → error
- ✅ Whitespace-only name → error
- ✅ Name too long (>255 chars) → error
- ✅ name: null → error "Cannot create unnamed version"
- ✅ Document with no history → error
- ✅ Permission denied for viewers

**UPDATE mode (versionId + name):**
- ✅ Update existing named version
- ✅ Empty name → error
- ✅ Name too long → error
- ✅ Version not found → error
- ✅ Auto-version (not UUID) → error "Cannot modify auto-generated versions"
- ✅ Permission denied for viewers

**DELETE mode (versionId + name: null):**
- ✅ Delete named version successfully
- ✅ Version not found → error
- ✅ Auto-version (not UUID) → error
- ✅ Permission denied for viewers
- ✅ Document history preserved after delete

**General:**
- ✅ Document not found → error
- ✅ Version from different document → error

### Integration Tests

- Create named version → list versions → verify present in timeline
- Update named version → list versions → verify name changed
- Delete named version → list versions → verify removed, auto-versions fill gap
- Create version doesn't change existing versions
- Update doesn't change clock ranges or timestamp
- Delete doesn't delete document data (yjs_updates preserved)
- Cannot delete same version twice
- Cannot update deleted version

### Manual Testing

**Natural language workflows:**
- "Name the current version 'Draft 1'"
- "Rename the 'Draft' version to 'Final Draft'"
- "Change 'Test Version' to 'Checkpoint 1'"
- "Delete the 'Test' version"
- "Remove the name from that version"
- "Unname the checkpoint we just created"

## Documentation Updates

### README.md
- Tool count remains at 21 (no change)
- Update version history section
- Add examples showing unified `set_document_version_name`

### docs/mcp-integration-summary.md
- Tool count remains at 21 (no change)
- **Remove** `create_document_version` from tools list
- **Add** `set_document_version_name` to tools list
- Add migration guide (see below)

### Migration Guide

```markdown
## BREAKING CHANGE: create_document_version removed

The `create_document_version` tool has been **removed** and replaced with the more powerful
`set_document_version_name` tool.

**Migration:**
```javascript
// OLD (no longer works):
await create_document_version({ docGuid, name: "Draft 1" });

// NEW (creates a named version):
await set_document_version_name({ docGuid, name: "Draft 1" });
```

**New capabilities:**
```javascript
// Rename existing version
await set_document_version_name({
  docGuid,
  versionId: "uuid-here",
  name: "New Name"
});

// Delete named version (set name to null)
await set_document_version_name({
  docGuid,
  versionId: "uuid-here",
  name: null
});
```
```

## Implementation Checklist

- [ ] Create `server/mcp/tools/set-document-version-name.js`
- [ ] Implement three-mode handler (create/update/delete)
- [ ] Add input schema with `name: string | null`
- [ ] Write comprehensive description with **prominent deletion examples**
  - [ ] Clearly document that `name: null` deletes the version
  - [ ] Include deletion in the overview section
  - [ ] Show multiple deletion examples in the EXAMPLES section
- [ ] **Delete** `server/mcp/tools/create-document-version.js`
- [ ] **Delete** `server/mcp/tools/__tests__/create-document-version.test.js` (if exists)
- [ ] Update `server/mcp/index.js`:
  - [ ] Remove old tool registration for `create_document_version`
  - [ ] Add new tool registration for `set_document_version_name`
- [ ] Write unit tests covering all modes and edge cases
- [ ] Add integration tests for all three operations
- [ ] Update README.md with examples
- [ ] Update docs/mcp-integration-summary.md with migration guide

## Examples

```javascript
// CREATE: Name the current version
await set_document_version_name({
  docGuid: "abc-123",
  name: "Draft 1"
});
// Returns: {
//   success: true,
//   created: true,
//   version: { id: "...", name: "Draft 1", ... },
//   message: "Version 'Draft 1' created successfully"
// }

// UPDATE: Rename an existing version
await set_document_version_name({
  docGuid: "abc-123",
  versionId: "550e8400-e29b-41d4-a716-446655440000",
  name: "Draft 1 - After Review"
});
// Returns: {
//   success: true,
//   updated: true,
//   version: { id: "...", name: "Draft 1 - After Review", ... },
//   message: "Version renamed to 'Draft 1 - After Review'"
// }

// DELETE: Remove version name
await set_document_version_name({
  docGuid: "abc-123",
  versionId: "550e8400-e29b-41d4-a716-446655440000",
  name: null
});
// Returns: {
//   success: true,
//   deleted: true,
//   message: "Named version removed from timeline"
// }

// ERROR: Cannot create unnamed version
await set_document_version_name({
  docGuid: "abc-123",
  name: null
});
// Throws: "Cannot create unnamed version. Provide versionId to remove a version name,
//          or provide a name to create a new version"
```

## Estimated Time

**~2 hours** including implementation, tests, and documentation

## Security Considerations

- All operations require editor/owner role
- Version ID must match document ID (prevent cross-document access)
- Parameterized queries prevent SQL injection
- DELETE mode is non-destructive (preserves document data)
- All operations are atomic (single query)
