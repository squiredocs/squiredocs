/**
 * list_document_versions MCP Tool
 *
 * Lists version history timeline for a document with pagination support.
 */

const versionHistory = require('../../version-history');
const documents = require('../../documents');

// Persistence provider - set by init function
let persistenceProvider = null;

/**
 * Initialize the tool with a persistence provider
 * @param {PostgresPersistence} persistence - PostgreSQL persistence provider
 */
function init(persistence) {
  persistenceProvider = persistence;
  // Access derivation now runs through the shared documents module (feature
  // 053), so it must be wired to the same pool — the list_documents tool has
  // done this since it was written.
  if (persistence && persistence.getPool) {
    documents.init(persistence.getPool());
  }
}

/**
 * Tool definition for MCP discovery
 */
const name = 'list_document_versions';

const description = `List the version history timeline for a document, with optional nested
subversions and time-based filtering.

Versions are grouped automatically by time gaps between edits (5-minute
threshold); users can also create named checkpoints. Subversions drill down
to individual edit groups (10-second threshold).

PARAMETERS:
- docGuid: Document UUID (required)
- limit: Max versions to return, 1-100 (optional, default 50)
- offset: Versions to skip for pagination (optional, default 0)
- includeSubversions: Include nested subversions array (optional, default false)
- since / until: Filter by time range (optional, ISO 8601). Timestamps are
  stored and returned in UTC; always give an explicit timezone
  (e.g. "2024-01-15T10:30:00Z", or "2024-01-15T10:30:00-05:00" for EST).

RETURNS:
- versions: Array of { id (UUID for named versions, clock number as string
  for auto versions), name (null for auto versions), clockStart, clockEnd,
  timestamp (UTC), formattedTimestamp, authors [{ id, name, email, picture,
  color, isAgent }], isNamed, isCurrent }. With includeSubversions, each
  version also has subversions (the 10 most recent edit groups: same fields
  plus updateCount and previousClock, the baseline clock for diffing),
  subversionCount, and hasMoreSubversions (true when more than 10 exist).
- totalEdits: Total number of meaningful edits in document history
- pagination: { total, limit, offset, hasMore }

EXAMPLE:
await list_document_versions({
  docGuid: "abc-123",
  since: "2024-01-01T00:00:00Z",
  includeSubversions: true,
  limit: 10
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

  // Check document access (feature 053: one derivation, documents.hasAccess →
  // the document_access view, so space members reach this tool too).
  if (!(await documents.hasAccess(docGuid, userId))) {
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
      // Compare against null, not truthiness: an epoch bound (getTime() === 0)
      // is falsy but a real filter, so `if (untilTime && …)` would skip it.
      if (sinceTime !== null && versionTime < sinceTime) return false;
      if (untilTime !== null && versionTime > untilTime) return false;
      return true;
    });
  }

  // Apply pagination
  const total = filteredVersions.length;
  const paginatedVersions = filteredVersions.slice(offset, offset + effectiveLimit);
  const hasMore = offset + effectiveLimit < total;

  // If includeSubversions, fetch subversions for each paginated version (limited to 10 most recent)
  if (includeSubversions) {
    try {
      for (const version of paginatedVersions) {
        console.log(`[list_document_versions] Fetching subversions for version ${version.id} (clocks ${version.clockStart}-${version.clockEnd})`);
        const result = await versionHistory.getUpdatesForVersion(
          persistenceProvider,
          docGuid,
          version.clockStart,
          version.clockEnd,
          10 // Limit to 10 most recent subversions
        );
        version.subversions = result.subversions;
        version.subversionCount = result.total;
        version.hasMoreSubversions = result.hasMore;
        console.log(`[list_document_versions] Got ${result.subversions.length}/${result.total} subversions for version ${version.id}`);
      }
    } catch (error) {
      console.error('[list_document_versions] Error fetching subversions:', error);
      throw new Error(`Failed to fetch subversions: ${error.message}`);
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
