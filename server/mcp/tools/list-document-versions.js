/**
 * list_document_versions MCP Tool
 *
 * Lists version history timeline for a document with pagination support.
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
const name = 'list_document_versions';

const description = `List version history timeline for a document.

═══════════════════════════════════════════════════════════════════════════
OVERVIEW
═══════════════════════════════════════════════════════════════════════════

Get a timeline of document versions showing when edits were made and by whom.
Versions are automatically grouped by time gaps between edits, and users can
create named checkpoints. Use this to understand document evolution or find
a specific version to read or restore.

═══════════════════════════════════════════════════════════════════════════
PARAMETERS
═══════════════════════════════════════════════════════════════════════════

- docGuid: Document UUID (required)
- limit: Maximum versions to return, 1-100 (optional, default: 50)
- offset: Number of versions to skip for pagination (optional, default: 0)

═══════════════════════════════════════════════════════════════════════════
RETURNS
═══════════════════════════════════════════════════════════════════════════

- versions: Array of version objects with:
  - id: Version ID (UUID for named versions, "auto-{clock}" for auto versions)
  - name: Version name (null for auto versions)
  - clockStart: Starting clock value
  - clockEnd: Ending clock value
  - timestamp: ISO 8601 timestamp
  - formattedTimestamp: Human-readable timestamp
  - authors: Array of author objects with id, name, email, picture, color
  - isNamed: Boolean indicating if this is a named checkpoint
  - isCurrent: Boolean indicating if this is the current version
- totalEdits: Total number of meaningful edits in document history
- pagination: Pagination metadata with total, limit, offset, hasMore

═══════════════════════════════════════════════════════════════════════════
EXAMPLES
═══════════════════════════════════════════════════════════════════════════

// List all versions (first page)
await list_document_versions({ docGuid: "abc-123" });

// List with pagination
await list_document_versions({
  docGuid: "abc-123",
  limit: 10,
  offset: 0
});

// Get second page
await list_document_versions({
  docGuid: "abc-123",
  limit: 10,
  offset: 10
});`;

const inputSchema = {
  type: 'object',
  properties: {
    docGuid: {
      type: 'string',
      format: 'uuid',
      description: 'The document UUID',
    },
    limit: {
      type: 'integer',
      minimum: 1,
      maximum: 100,
      default: 50,
      description: 'Maximum number of versions to return (1-100)',
    },
    offset: {
      type: 'integer',
      minimum: 0,
      default: 0,
      description: 'Number of versions to skip for pagination',
    },
  },
  required: ['docGuid'],
};

/**
 * Handler function for the tool
 */
async function handler(args, agentToken) {
  if (!persistenceProvider) throw new Error('list_document_versions tool not initialized');

  const { docGuid, limit = 50, offset = 0 } = args;
  const userId = agentToken.userId;
  const pool = persistenceProvider.getPool();

  // Validate and clamp limit
  const effectiveLimit = Math.min(Math.max(1, limit), 100);

  // Check document access
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

  // Get full version timeline
  const timeline = await versionHistory.getVersionTimeline(persistenceProvider, docGuid);

  // Apply pagination
  const total = timeline.versions.length;
  const paginatedVersions = timeline.versions.slice(offset, offset + effectiveLimit);
  const hasMore = offset + effectiveLimit < total;

  return {
    versions: paginatedVersions,
    totalEdits: timeline.totalEdits,
    pagination: {
      total,
      limit: effectiveLimit,
      offset,
      hasMore,
    },
  };
}

module.exports = {
  init,
  name,
  description,
  inputSchema,
  handler,
};
