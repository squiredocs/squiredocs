/**
 * restore_document_version MCP Tool
 *
 * Restore document to a previous version (non-destructive).
 */

const versionHistory = require('../../version-history');
const agentPresence = require('../agent-presence');

// Persistence provider - set by init function
let persistenceProvider = null;

/**
 * Initialize the tool with a persistence provider
 * @param {PostgresPersistence} persistence - PostgreSQL persistence provider
 */
function init(persistence) {
  persistenceProvider = persistence;
}

/**
 * Tool definition for MCP discovery
 */
const name = 'restore_document_version';

const description = `Restore document to a previous version (non-destructive).

═══════════════════════════════════════════════════════════════════════════
OVERVIEW
═══════════════════════════════════════════════════════════════════════════

Restore a document to the state it was in at a previous version. This is
non-destructive: it creates a new edit that replaces the current content
with the historical content. The restore operation itself becomes a new
version in the history, so you can undo it by restoring to a version
before the restore.

Changes are immediately broadcast to all connected clients via WebSocket.

═══════════════════════════════════════════════════════════════════════════
PARAMETERS
═══════════════════════════════════════════════════════════════════════════

- docGuid: Document UUID (required)
- versionId: Version to restore to (required)
  - UUID for named versions
  - Clock number as string for auto-generated versions

═══════════════════════════════════════════════════════════════════════════
PERMISSIONS
═══════════════════════════════════════════════════════════════════════════

Requires editor or owner role. Viewers cannot restore versions.

═══════════════════════════════════════════════════════════════════════════
RETURNS
═══════════════════════════════════════════════════════════════════════════

- success: Boolean indicating success
- newClock: Clock value of the restore operation
- message: Human-readable success message

═══════════════════════════════════════════════════════════════════════════
EXAMPLES
═══════════════════════════════════════════════════════════════════════════

// Restore to an auto-generated version
await restore_document_version({
  docGuid: "abc-123",
  versionId: "auto-42"
});

// Restore to a named version
await restore_document_version({
  docGuid: "abc-123",
  versionId: "550e8400-e29b-41d4-a716-446655440000"
});

// After restoring, you can:
// - Use read_document to see the restored content
// - Use list_document_versions to see the restore as a new version
// - Restore again to undo the restore`;

const inputSchema = {
  type: 'object',
  properties: {
    docGuid: {
      type: 'string',
      format: 'uuid',
      description: 'The document UUID',
    },
    versionId: {
      type: 'string',
      description: 'Version to restore to (UUID or clock number as string)',
    },
  },
  required: ['docGuid', 'versionId'],
};

/**
 * Handler function for the tool
 */
async function handler(args, agentToken) {
  if (!persistenceProvider) throw new Error('restore_document_version tool not initialized');

  const { docGuid, versionId } = args;
  const userId = agentToken.userId;
  const pool = persistenceProvider.getPool();

  // Check document access and role
  const accessResult = await pool.query(
    `SELECT d.id, ds.role
     FROM documents d
     JOIN document_shares ds ON d.id = ds.doc_id AND ds.user_id = $2
     WHERE d.id = $1`,
    [docGuid, userId]
  );

  if (accessResult.rows.length === 0) {
    throw new Error('Document not found or you do not have access');
  }

  const { role } = accessResult.rows[0];

  // Check permissions - only editor or owner can restore versions
  if (role === 'viewer') {
    throw new Error('Permission denied: viewers cannot restore document versions');
  }

  // Get or create agent session to get the shared document
  const session = await agentPresence.getOrCreateSession(docGuid, agentToken, 60);

  // Get function to access shared document for broadcasting
  const getSharedDocFn = (guid) => {
    if (guid === docGuid && session.provider && session.provider.doc) {
      return session.provider.doc;
    }
    return null;
  };

  // Perform restore
  const result = await versionHistory.restoreVersion(
    persistenceProvider,
    docGuid,
    versionId,
    userId,
    getSharedDocFn
  );

  return result;
}

module.exports = {
  init,
  name,
  description,
  inputSchema,
  handler,
};
