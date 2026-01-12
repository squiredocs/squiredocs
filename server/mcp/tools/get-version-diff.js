/**
 * get_version_diff MCP Tool
 *
 * Get changes between two document versions.
 */

const versionHistory = require('../../version-history');
const DiffService = require('../../diff-service');

// Persistence provider - set by init function
let persistenceProvider = null;
let diffService = null;

/**
 * Initialize the tool with a persistence provider
 * @param {PostgresPersistence} persistence - PostgreSQL persistence provider
 */
function init(persistence) {
  persistenceProvider = persistence;
  if (persistence) {
    diffService = new DiffService(persistence.getPool());
  }
}

/**
 * Tool definition for MCP discovery
 */
const name = 'get_version_diff';

const description = `Get changes between two document versions.

═══════════════════════════════════════════════════════════════════════════
OVERVIEW
═══════════════════════════════════════════════════════════════════════════

Compare two versions of a document to see what changed. Shows insertions
and deletions with their positions in the document. By default, compares
a version against its predecessor. Use this to understand what edits were
made in a specific version or between any two points in history.

═══════════════════════════════════════════════════════════════════════════
PARAMETERS
═══════════════════════════════════════════════════════════════════════════

- docGuid: Document UUID (required)
- versionId: Version to show changes for (required)
  - UUID for named versions
  - "auto-{clock}" for auto-generated versions
- compareToVersionId: Version to compare against (optional)
  - Defaults to the version's predecessor (clockStart - 1)
  - Can be any version ID (UUID or "auto-{clock}")

═══════════════════════════════════════════════════════════════════════════
RETURNS
═══════════════════════════════════════════════════════════════════════════

- document: ProseMirror JSON document (current version)
- changes: Array of change objects with:
  - type: "insert" or "delete"
  - fromB: Position in current document
  - toB: End position (for insertions)
  - deletedContent: Array of ProseMirror nodes (for deletions)
- summary: Statistics with:
  - insertions: Number of insertion changes
  - deletions: Number of deletion changes
  - textIdentical: Boolean indicating if text content is identical
- currentVersion: Metadata for the current version
- previousVersion: Metadata for the comparison version

═══════════════════════════════════════════════════════════════════════════
EXAMPLES
═══════════════════════════════════════════════════════════════════════════

// Compare version against its predecessor
await get_version_diff({
  docGuid: "abc-123",
  versionId: "auto-42"
});

// Compare two specific versions
await get_version_diff({
  docGuid: "abc-123",
  versionId: "auto-50",
  compareToVersionId: "auto-42"
});

// Compare named version against auto version
await get_version_diff({
  docGuid: "abc-123",
  versionId: "550e8400-e29b-41d4-a716-446655440000",
  compareToVersionId: "auto-38"
});`;

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
      description: 'Version to show changes for (UUID or "auto-{clock}")',
    },
    compareToVersionId: {
      type: 'string',
      description: 'Version to compare against (optional, defaults to predecessor)',
    },
  },
  required: ['docGuid', 'versionId'],
};

/**
 * Resolve a version ID to its clock value
 * @param {string} versionId - Version ID (UUID or auto-{clock})
 * @returns {Promise<{clock: number, id: string, timestamp: string}>} Clock value and metadata
 */
async function resolveVersionToClock(versionId) {
  // Named version (UUID format)
  if (versionId.match(/^[0-9a-f-]{36}$/i)) {
    const namedVersion = await persistenceProvider.getVersionById(versionId);
    if (!namedVersion) {
      throw new Error(`Version not found: ${versionId}`);
    }
    return {
      clock: namedVersion.clock_end,
      id: versionId,
      timestamp: namedVersion.created_at,
    };
  }

  // Auto-generated version (auto-{clock} format)
  if (versionId.startsWith('auto-')) {
    const clock = parseInt(versionId.replace('auto-', ''), 10);
    if (isNaN(clock)) {
      throw new Error(`Invalid version ID format: ${versionId}`);
    }
    return {
      clock,
      id: versionId,
      timestamp: null, // Will be filled from updates if needed
    };
  }

  throw new Error(`Invalid version ID format: ${versionId}`);
}

/**
 * Handler function for the tool
 */
async function handler(args, agentToken) {
  if (!persistenceProvider) throw new Error('get_version_diff tool not initialized');
  if (!diffService) throw new Error('Diff service not initialized');

  const { docGuid, versionId, compareToVersionId } = args;
  const userId = agentToken.userId;
  const pool = persistenceProvider.getPool();

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

  // Resolve current version to clock value
  const currentVersion = await resolveVersionToClock(versionId);
  const currentClock = currentVersion.clock;

  // Resolve comparison version
  let previousClock;
  let previousVersionMeta;

  if (compareToVersionId) {
    // User specified comparison version
    previousVersionMeta = await resolveVersionToClock(compareToVersionId);
    previousClock = previousVersionMeta.clock;
  } else {
    // Default to predecessor: get version data to find clockStart
    const versionData = await versionHistory.getVersionContent(
      persistenceProvider,
      docGuid,
      versionId
    );

    if (versionData.version && versionData.version.clockStart > 0) {
      previousClock = versionData.version.clockStart - 1;
      previousVersionMeta = {
        clock: previousClock,
        id: `auto-${previousClock}`,
        timestamp: null,
      };
    } else {
      // Version starts at clock 0, compare against empty document
      previousClock = -1;
      previousVersionMeta = {
        clock: -1,
        id: 'empty',
        timestamp: null,
      };
    }
  }

  // Compute diff
  const diffResult = await diffService.computeDiff(docGuid, previousClock, currentClock);

  // Count insertions and deletions
  const insertions = diffResult.changes.filter((c) => c.type === 'insert').length;
  const deletions = diffResult.changes.filter((c) => c.type === 'delete').length;

  return {
    document: diffResult.document,
    changes: diffResult.changes,
    summary: {
      insertions,
      deletions,
      textIdentical: diffResult.meta.textIdentical,
    },
    currentVersion: {
      id: currentVersion.id,
      clockEnd: currentClock,
      timestamp: currentVersion.timestamp,
    },
    previousVersion: {
      id: previousVersionMeta.id,
      clockEnd: previousClock,
      timestamp: previousVersionMeta.timestamp,
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
