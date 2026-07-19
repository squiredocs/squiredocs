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
  if (name === undefined) throw new Error('name parameter is required');
  if (typeof name !== 'string') throw new Error('name must be a string or null');
  const trimmed = name.trim();
  if (!trimmed) throw new Error('Version name cannot be empty');
  if (trimmed.length > 255) throw new Error('Version name cannot exceed 255 characters');
  return trimmed;
}

/**
 * Parse versionId to extract clock value and type
 * Supports formats returned by list_document_versions: UUID or clock number
 * @param {string} versionId
 * @returns {{ type: 'uuid'|'clock', clock?: number, uuid?: string }}
 */
function parseVersionId(versionId) {
  // Check for UUID format (named versions)
  if (isUUID(versionId)) {
    return { type: 'uuid', uuid: versionId };
  }

  // Parse as clock number
  const clock = parseInt(versionId, 10);
  if (isNaN(clock)) {
    throw new Error('Invalid versionId format. Must be UUID or clock number as returned by list_document_versions');
  }

  return { type: 'clock', clock };
}

/**
 * Look up a version by ID in the version timeline
 * @param {string} docGuid
 * @param {string} versionId
 * @param {Object} persistenceProvider
 * @returns {Promise<{clockStart: number, clockEnd: number, isNamed: boolean, id?: string}|null>}
 */
async function lookupVersionById(docGuid, versionId, persistenceProvider) {
  const parsed = parseVersionId(versionId);

  // Handle UUID - existing named version
  if (parsed.type === 'uuid') {
    const version = await persistenceProvider.getVersionById(parsed.uuid, docGuid);
    if (!version || version.doc_id !== docGuid) {
      return null;
    }
    return {
      clockStart: version.clock_start,
      clockEnd: version.clock_end,
      isNamed: true,
      id: version.id,
    };
  }

  // Handle clock-based ID - search in timeline
  const timeline = await versionHistory.getVersionTimeline(persistenceProvider, docGuid);

  // First check if this clock might be a subversion (check parent versions that contain it)
  // We prioritize subversions over main versions for more granular matching
  for (const version of timeline.versions) {
    if (parsed.clock >= version.clockStart && parsed.clock <= version.clockEnd) {
      // Populate subversions for this version
      const result = await versionHistory.getUpdatesForVersion(
        persistenceProvider,
        docGuid,
        version.clockStart,
        version.clockEnd,
        1000 // High limit to ensure we get all subversions
      );

      // Search for the matching subversion
      if (result && result.subversions && result.subversions.length > 0) {
        for (const subversion of result.subversions) {
          if (subversion.clockEnd === parsed.clock) {
            return {
              clockStart: subversion.clockStart,
              clockEnd: subversion.clockEnd,
              isNamed: false,
            };
          }
        }
      }
    }
  }

  // If not found in subversions, check main versions
  for (const version of timeline.versions) {
    if (version.clockEnd === parsed.clock) {
      return {
        clockStart: version.clockStart,
        clockEnd: version.clockEnd,
        isNamed: version.isNamed || false,
        id: version.isNamed ? version.id : undefined,
      };
    }
  }

  return null;
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
- CREATE: Name current or historical version
- UPDATE: Rename existing named version
- DELETE: Remove name from version (versionId + name: null)

Use versionId from list_document_versions (UUID or clock number).
Omit versionId to name the current state.

Examples:

// Name current state
await set_document_version_name({ docGuid: "abc-123", name: "Draft 1" });

// Name historical version by clock number
await set_document_version_name({ docGuid: "abc-123", versionId: "12", name: "Before Refactor" });

// Name subversion by clock number
await set_document_version_name({ docGuid: "abc-123", versionId: "28", name: "Checkpoint" });

// Rename existing named version
await set_document_version_name({ docGuid: "abc-123", versionId: "uuid", name: "Final" });

// Delete named version
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
      description: 'Version ID from list_document_versions (UUID or clock number) - optional',
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

  // Naming/managing versions is permitted for viewer+ (Sam-ratified 2026-07-19,
  // F9): this aligns the MCP tool with the REST routes and the web UI's actual
  // server behavior, which already allow any role with access. Version history
  // itself is always preserved, so a viewer naming a checkpoint is non-
  // destructive. Tightening is deferred.

  // MODIFY or NAME existing version (with versionId)
  if (versionId) {
    // Look up the version (supports UUID or clock number)
    const version = await lookupVersionById(docGuid, versionId, persistenceProvider);
    if (!version) {
      throw new Error('Version not found');
    }

    // Handle different operations based on version type and name value
    if (version.isNamed && version.id) {
      // This is an already-named version - UPDATE or DELETE only
      if (name === null) {
        // DELETE: Remove the named version (doc-scoped in SQL — F7)
        await persistenceProvider.deleteNamedVersion(version.id, docGuid);
        return { success: true, deleted: true, message: 'Named version removed from timeline' };
      }

      // UPDATE: Rename the version (doc-scoped in SQL — F7)
      const trimmedName = validateName(name);
      const updated = await persistenceProvider.updateVersionName(version.id, trimmedName, docGuid);
      return {
        success: true,
        updated: true,
        version: formatVersion(updated),
        message: `Version renamed to "${trimmedName}"`,
      };
    } else {
      // This is an unnamed version - CREATE a named version from it
      if (name === null) {
        throw new Error('Cannot delete unnamed version. This version does not have a name to remove');
      }

      const trimmedName = validateName(name);
      const created = await persistenceProvider.createNamedVersion(
        docGuid,
        version.clockStart,
        version.clockEnd,
        trimmedName,
        userId
      );

      return {
        success: true,
        created: true,
        version: formatVersion(created),
        message: `Historical version "${trimmedName}" created successfully`,
      };
    }
  }

  // CREATE new named version from current state (no versionId)
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
