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

const description = `Restore a document to a previous version (non-destructive). Creates a new
edit that replaces the current content with the historical content; the
restore itself becomes a new version in the history, so you can undo it by
restoring to a version from before the restore. Changes broadcast immediately
to all connected clients.

Requires editor or owner role. Viewers cannot restore versions.

PARAMETERS:
- docGuid: Document UUID (required)
- versionId: Version to restore to (required) - UUID for named versions, or
  the clock number as a string (e.g. "42") for auto-generated versions

RETURNS:
- success: Boolean indicating success
- newClock: Clock value of the restore operation
- message: Human-readable success message

EXAMPLE:
await restore_document_version({ docGuid: "abc-123", versionId: "42" });
// Afterwards: read_document shows the restored content, and
// list_document_versions shows the restore as a new version.`;

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

  // Get or create agent session (verifies access and editor role internally)
  const session = await agentPresence.getOrCreateSession(docGuid, agentToken, 60, { requiredRole: 'editor' });

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
    getSharedDocFn,
    agentToken.agentName
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
