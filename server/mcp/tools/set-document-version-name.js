/**
 * set_document_version_name MCP Tool
 * Unified tool for managing named versions: create, update, or delete.
 */

const versionHistory = require('../../version-history');

let persistenceProvider = null;

function init(persistence) {
  persistenceProvider = persistence;
}

function isUUID(str) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(str);
}

function validateName(name) {
  const trimmed = name.trim();
  if (!trimmed) throw new Error('Version name cannot be empty');
  if (trimmed.length > 255) throw new Error('Version name cannot exceed 255 characters');
  return trimmed;
}

function formatVersion(v) {
  return {
    id: v.id,
    name: v.name,
    clockStart: v.clock_start,
    clockEnd: v.clock_end,
    timestamp: v.created_at,
  };
}

const name = 'set_document_version_name';

const description = `Manage named document versions with three operations:
- CREATE: Name current state (no versionId)
- UPDATE: Rename existing (versionId + name)
- DELETE: Remove name (versionId + name: null)

⚠️ To delete a named version, pass name: null with versionId.

Examples:

// Create
await set_document_version_name({ docGuid: "abc-123", name: "Draft 1" });

// Update
await set_document_version_name({ docGuid: "abc-123", versionId: "uuid", name: "Final" });

// Delete (set name to null)
await set_document_version_name({ docGuid: "abc-123", versionId: "uuid", name: null });

Requires editor or owner role. Document history is always preserved.`;

const inputSchema = {
  type: 'object',
  properties: {
    docGuid: {
      type: 'string',
      format: 'uuid',
      description: 'The document UUID',
    },
    name: {
      type: ['string', 'null'],
      minLength: 1,
      maxLength: 255,
      description: 'Version name (1-255 characters) or null to delete',
    },
    versionId: {
      type: 'string',
      format: 'uuid',
      description: 'UUID of version to modify (optional)',
    },
  },
  required: ['docGuid', 'name'],
};

async function handler(args, agentToken) {
  if (!persistenceProvider) throw new Error('set_document_version_name tool not initialized');

  const { docGuid, name, versionId } = args;
  const userId = agentToken.userId;
  const pool = persistenceProvider.getPool();

  // Check document access and role
  const accessResult = await pool.query(
    `SELECT ds.role FROM documents d
     JOIN document_shares ds ON d.id = ds.doc_id AND ds.user_id = $2
     WHERE d.id = $1`,
    [docGuid, userId]
  );

  if (accessResult.rows.length === 0) {
    throw new Error('Document not found or you do not have access');
  }

  if (accessResult.rows[0].role === 'viewer') {
    throw new Error('Permission denied: viewers cannot manage document versions');
  }

  // MODIFY existing version (update or delete)
  if (versionId) {
    if (!isUUID(versionId)) {
      throw new Error('Cannot modify auto-generated versions. Only named versions can be renamed or deleted');
    }

    const version = await persistenceProvider.getVersionById(versionId);
    if (!version || version.doc_id !== docGuid) {
      throw new Error('Version not found');
    }

    if (name === null) {
      await persistenceProvider.deleteNamedVersion(versionId);
      return { success: true, deleted: true, message: 'Named version removed from timeline' };
    }

    const trimmedName = validateName(name);
    const updated = await persistenceProvider.updateVersionName(versionId, trimmedName);
    return {
      success: true,
      updated: true,
      version: formatVersion(updated),
      message: `Version renamed to "${trimmedName}"`,
    };
  }

  // CREATE new named version from current state
  if (name === null) {
    throw new Error('Cannot create unnamed version. Provide versionId to remove a version name, or provide a name to create a new version');
  }

  const trimmedName = validateName(name);
  const timeline = await versionHistory.getVersionTimeline(persistenceProvider, docGuid);

  if (timeline.versions.length === 0) {
    throw new Error('Cannot create version: document has no edit history');
  }

  const currentVersion = timeline.versions[0];
  const created = await persistenceProvider.createNamedVersion(
    docGuid,
    currentVersion.clockStart,
    currentVersion.clockEnd,
    trimmedName,
    userId
  );

  return {
    success: true,
    created: true,
    version: formatVersion(created),
    message: `Version "${trimmedName}" created successfully`,
  };
}

module.exports = {
  init,
  name,
  description,
  inputSchema,
  handler,
};
