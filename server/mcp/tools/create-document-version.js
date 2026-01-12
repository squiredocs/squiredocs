/**
 * create_document_version MCP Tool
 *
 * Create a named checkpoint/snapshot of the current document state.
 */

const versionHistory = require('../../version-history');

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
const name = 'create_document_version';

const description = `Create a named checkpoint/snapshot of the current document state.

═══════════════════════════════════════════════════════════════════════════
OVERVIEW
═══════════════════════════════════════════════════════════════════════════

Save the current state of a document as a named version. This creates a
permanent checkpoint that you can restore to later. Named versions appear
in the version timeline alongside auto-generated versions. Use this to mark
important milestones like "Draft 1", "Ready for Review", or "Final Version".

═══════════════════════════════════════════════════════════════════════════
PARAMETERS
═══════════════════════════════════════════════════════════════════════════

- docGuid: Document UUID (required)
- name: Version name, 1-255 characters (required)
  - Use descriptive names like "Draft 1", "After Review", "Final"
  - Cannot be empty or only whitespace

═══════════════════════════════════════════════════════════════════════════
PERMISSIONS
═══════════════════════════════════════════════════════════════════════════

Requires editor or owner role. Viewers cannot create versions.

═══════════════════════════════════════════════════════════════════════════
RETURNS
═══════════════════════════════════════════════════════════════════════════

- success: Boolean indicating success
- version: Created version object with:
  - id: UUID of the created version
  - name: Version name
  - clockStart: Starting clock value
  - clockEnd: Ending clock value
  - timestamp: ISO 8601 timestamp
- message: Human-readable success message

═══════════════════════════════════════════════════════════════════════════
EXAMPLES
═══════════════════════════════════════════════════════════════════════════

// Create a named checkpoint
await create_document_version({
  docGuid: "abc-123",
  name: "Draft 1"
});

// Mark version after review
await create_document_version({
  docGuid: "abc-123",
  name: "After technical review - 2024-01-15"
});

// Create final version
await create_document_version({
  docGuid: "abc-123",
  name: "Final Version"
});`;

const inputSchema = {
  type: 'object',
  properties: {
    docGuid: {
      type: 'string',
      format: 'uuid',
      description: 'The document UUID',
    },
    name: {
      type: 'string',
      minLength: 1,
      maxLength: 255,
      description: 'Version name (1-255 characters)',
    },
  },
  required: ['docGuid', 'name'],
};

/**
 * Handler function for the tool
 */
async function handler(args, agentToken) {
  if (!persistenceProvider) throw new Error('create_document_version tool not initialized');

  const { docGuid, name } = args;
  const userId = agentToken.userId;
  const pool = persistenceProvider.getPool();

  // Validate name
  const trimmedName = name.trim();
  if (!trimmedName || trimmedName.length === 0) {
    throw new Error('Version name cannot be empty');
  }
  if (trimmedName.length > 255) {
    throw new Error('Version name cannot exceed 255 characters');
  }

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

  // Check permissions - only editor or owner can create versions
  if (role === 'viewer') {
    throw new Error('Permission denied: viewers cannot create document versions');
  }

  // Get current version timeline to find current version bounds
  const timeline = await versionHistory.getVersionTimeline(persistenceProvider, docGuid);

  if (timeline.versions.length === 0) {
    throw new Error('Cannot create version: document has no edit history');
  }

  // Get the current version (first in array since they're sorted newest first)
  const currentVersion = timeline.versions[0];

  // Create named version
  const createdVersion = await persistenceProvider.createNamedVersion(
    docGuid,
    currentVersion.clockStart,
    currentVersion.clockEnd,
    trimmedName,
    userId
  );

  return {
    success: true,
    version: {
      id: createdVersion.id,
      name: createdVersion.name,
      clockStart: createdVersion.clock_start,
      clockEnd: createdVersion.clock_end,
      timestamp: createdVersion.created_at,
    },
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
