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

const description = `List version history timeline for a document with optional nested subversions,
rich metadata, and time-based filtering.

═══════════════════════════════════════════════════════════════════════════
OVERVIEW
═══════════════════════════════════════════════════════════════════════════

Get a timeline of document versions showing when edits were made, by whom, and
with detailed metadata about size and changes. Versions are automatically grouped
by time gaps between edits (5-minute threshold), and users can create named
checkpoints.

NEW FEATURES:
- Nested subversions: Drill down to see individual edit groups (10-second threshold)
- Rich metadata: Document size, edit counts, character deltas, and duration
- Time filtering: Filter versions by date/time range

═══════════════════════════════════════════════════════════════════════════
PARAMETERS
═══════════════════════════════════════════════════════════════════════════

- docGuid: Document UUID (required)
- limit: Maximum versions to return, 1-100 (optional, default: 50)
- offset: Number of versions to skip for pagination (optional, default: 0)
- includeSubversions: Include nested subversions array (optional, default: false)
- since: Filter versions since this time (optional, ISO 8601)
- until: Filter versions until this time (optional, ISO 8601)

TIMEZONE HANDLING:
- All version timestamps are stored and returned in UTC
- For time filtering, use ISO 8601 format with explicit timezone:
  - "2024-01-15T10:30:00Z" - 10:30 AM UTC (recommended)
  - "2024-01-15T10:30:00-05:00" - 10:30 AM EST
  - "2024-01-15" - Midnight on Jan 15 in server's local timezone (avoid)
- BEST PRACTICE: Always specify timezone explicitly (use "Z" suffix for UTC)

═══════════════════════════════════════════════════════════════════════════
RETURNS
═══════════════════════════════════════════════════════════════════════════

- versions: Array of version objects with:
  - id: Version ID (UUID for named versions, "auto-{clock}" for auto versions)
  - name: Version name (null for auto versions)
  - clockStart: Starting clock value
  - clockEnd: Ending clock value
  - timestamp: ISO 8601 timestamp (UTC)
  - formattedTimestamp: Human-readable timestamp
  - authors: Array of author objects with id, name, email, picture, color, isAgent
  - isNamed: Boolean indicating if this is a named checkpoint
  - isCurrent: Boolean indicating if this is the current version
  - editCount: Number of meaningful edits (text changes)
  - duration: Time span of editing session in milliseconds
  - characterCount: Total characters at this version
  - wordCount: Total words at this version
  - blockCount: Total blocks (paragraphs, headings, lists)
  - charactersDelta: Characters added/removed since previous version
  - subversions: (if includeSubversions: true) Array of edit groups with same metadata

- totalEdits: Total number of meaningful edits in document history
- pagination: Pagination metadata with total, limit, offset, hasMore

═══════════════════════════════════════════════════════════════════════════
EXAMPLES
═══════════════════════════════════════════════════════════════════════════

// List all versions (default, backward compatible)
await list_document_versions({ docGuid: "abc-123" });

// List versions with nested subversions
await list_document_versions({
  docGuid: "abc-123",
  includeSubversions: true
});

// List versions from a specific date (UTC midnight)
await list_document_versions({
  docGuid: "abc-123",
  since: "2024-01-15T00:00:00Z"
});

// List versions between two dates (UTC)
await list_document_versions({
  docGuid: "abc-123",
  since: "2024-01-01T00:00:00Z",
  until: "2024-01-15T23:59:59Z"
});

// List versions with subversions and time filtering
await list_document_versions({
  docGuid: "abc-123",
  since: "2024-01-01T00:00:00Z",
  includeSubversions: true,
  limit: 10
});

// Pagination with time filtering
await list_document_versions({
  docGuid: "abc-123",
  since: "2024-01-01T00:00:00Z",
  limit: 10,
  offset: 0
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
    includeSubversions: {
      type: 'boolean',
      default: false,
      description: 'Include nested subversions array in each version',
    },
    since: {
      type: 'string',
      description: 'Filter versions since this time (ISO 8601 format, e.g., "2024-01-15T10:30:00Z")',
    },
    until: {
      type: 'string',
      description: 'Filter versions until this time (ISO 8601 format, e.g., "2024-01-15T10:30:00Z")',
    },
  },
  required: ['docGuid'],
};

/**
 * Handler function for the tool
 */
async function handler(args, agentToken) {
  if (!persistenceProvider) throw new Error('list_document_versions tool not initialized');

  const { docGuid, limit = 50, offset = 0, includeSubversions = false, since, until } = args;
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

  // Get full version timeline (now includes metadata)
  const timeline = await versionHistory.getVersionTimeline(persistenceProvider, docGuid);

  // Apply time-based filtering if provided
  let filteredVersions = timeline.versions;
  if (since || until) {
    let sinceTime = null;
    let untilTime = null;

    if (since) {
      sinceTime = new Date(since).getTime();
      if (isNaN(sinceTime)) {
        throw new Error(`Invalid 'since' time format: "${since}". Use ISO 8601 format.`);
      }
    }

    if (until) {
      untilTime = new Date(until).getTime();
      if (isNaN(untilTime)) {
        throw new Error(`Invalid 'until' time format: "${until}". Use ISO 8601 format.`);
      }
    }

    if (sinceTime && untilTime && sinceTime > untilTime) {
      throw new Error("'since' time must be before 'until' time");
    }

    filteredVersions = timeline.versions.filter(v => {
      const versionTime = new Date(v.timestamp).getTime();
      if (sinceTime && versionTime < sinceTime) return false;
      if (untilTime && versionTime > untilTime) return false;
      return true;
    });
  }

  // Apply pagination
  const total = filteredVersions.length;
  const paginatedVersions = filteredVersions.slice(offset, offset + effectiveLimit);
  const hasMore = offset + effectiveLimit < total;

  // If includeSubversions, fetch subversions for each paginated version
  if (includeSubversions) {
    for (const version of paginatedVersions) {
      const subversions = await versionHistory.getUpdatesForVersion(
        persistenceProvider,
        docGuid,
        version.clockStart,
        version.clockEnd
      );
      version.subversions = subversions; // Already includes metadata
    }
  }

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
