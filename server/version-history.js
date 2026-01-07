/**
 * Version History Business Logic
 * Handles version grouping, timeline generation, and restore operations
 */

const Y = require('yjs');

// Default inactivity threshold for grouping updates into versions (5 minutes)
const DEFAULT_INACTIVITY_THRESHOLD = 5 * 60 * 1000;

// Session inactivity threshold (30 minutes gap or day boundary)
const SESSION_INACTIVITY_THRESHOLD = 30 * 60 * 1000;

/**
 * Generate a deterministic color from a user ID
 * @param {string} id - User ID
 * @returns {string} HSL color string
 */
function generateColorFromId(id) {
  if (!id) return '#888888';
  let hash = 0;
  for (let i = 0; i < id.length; i++) {
    const char = id.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash = hash & hash;
  }
  const hue = Math.abs(hash) % 360;
  return `hsl(${hue}, 70%, 45%)`;
}

/**
 * Create a consistent author key for color generation
 * Agents get a distinct key from their user to have different colors
 * @param {string} userId - User ID
 * @param {string|null} agentName - Agent name if this is an agent edit
 * @returns {string} Author key for color generation
 */
function getAuthorKey(userId, agentName) {
  return agentName ? `${userId}-agent-${agentName}` : userId;
}

/**
 * Create an author object from update data
 * Shared helper to ensure consistent author representation
 * @param {Object} update - Update object with userId, userName, agentName, etc.
 * @returns {Object|null} Author object or null if no userId
 */
function createAuthor(update) {
  if (!update.userId) return null;

  const authorKey = getAuthorKey(update.userId, update.agentName);
  const displayName = update.agentName || update.userName || 'Unknown';

  return {
    id: update.userId,
    name: displayName,
    email: update.userEmail,
    picture: update.userPicture,
    color: generateColorFromId(authorKey),
    isAgent: !!update.agentName,
  };
}

/**
 * Group updates into logical versions based on time gaps
 * @param {Array} updates - Array of updates with clock, createdAt, and user info
 * @param {number} inactivityThreshold - Time gap to create new version (ms)
 * @returns {Array} Array of version objects
 */
function groupUpdatesIntoVersions(updates, inactivityThreshold = DEFAULT_INACTIVITY_THRESHOLD) {
  if (!updates || updates.length === 0) {
    return [];
  }

  const versions = [];
  let currentVersion = null;

  for (const update of updates) {
    const updateTime = new Date(update.createdAt).getTime();

    if (!currentVersion ||
        (updateTime - currentVersion.lastUpdateTime > inactivityThreshold)) {
      // Start a new version
      currentVersion = {
        clockStart: update.clock,
        clockEnd: update.clock,
        timestamp: update.createdAt,
        lastUpdateTime: updateTime,
        authors: new Map(), // userId -> user info
      };
      versions.push(currentVersion);
    } else {
      // Extend current version
      currentVersion.clockEnd = update.clock;
      currentVersion.timestamp = update.createdAt; // Update to latest timestamp
      currentVersion.lastUpdateTime = updateTime;
    }

    // Track unique authors using composite key to distinguish agent edits
    const authorKey = getAuthorKey(update.userId, update.agentName);

    if (update.userId && !currentVersion.authors.has(authorKey)) {
      currentVersion.authors.set(authorKey, createAuthor(update));
    }
  }

  // Convert author maps to arrays
  return versions.map(v => ({
    ...v,
    authors: Array.from(v.authors.values()),
  }));
}

/**
 * Group versions by month for display (January 2025, December 2024, etc.)
 * @param {Array} versions - Array of version objects
 * @returns {Object} Grouped versions by month
 */
function groupVersionsByPeriod(versions) {
  const monthGroups = new Map();

  for (const version of versions) {
    const versionDate = new Date(version.timestamp);
    const monthKey = `${versionDate.getFullYear()}-${String(versionDate.getMonth() + 1).padStart(2, '0')}`;
    const monthLabel = versionDate.toLocaleDateString('en-US', { month: 'long', year: 'numeric' });

    if (!monthGroups.has(monthKey)) {
      monthGroups.set(monthKey, { key: monthKey, label: monthLabel, versions: [] });
    }
    monthGroups.get(monthKey).versions.push(version);
  }

  // Sort versions within each month by timestamp descending (most recent first)
  const sortByRecent = (versions) =>
    versions.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));

  // Convert to array and sort months descending (most recent first)
  const result = Array.from(monthGroups.values())
    .sort((a, b) => b.key.localeCompare(a.key))
    .map(group => ({
      label: group.label,
      versions: sortByRecent(group.versions),
    }));

  return result;
}

/**
 * Group versions into sessions based on 30+ min gaps or day boundaries
 * Sessions represent editing sessions (e.g., "Morning session", "Afternoon")
 * @param {Array} versions - Array of version objects with timestamp
 * @returns {Array} Array of session objects with nested versions
 */
function groupVersionsIntoSessions(versions) {
  if (!versions || versions.length === 0) return [];

  // Sort by timestamp descending (most recent first)
  const sortedVersions = [...versions].sort(
    (a, b) => new Date(b.timestamp) - new Date(a.timestamp)
  );

  const sessions = [];
  let currentSession = null;

  for (const version of sortedVersions) {
    const versionTime = new Date(version.timestamp);
    const versionDay = new Date(versionTime.getFullYear(), versionTime.getMonth(), versionTime.getDate());

    // Check if we need to start a new session
    const shouldStartNewSession = !currentSession ||
      // Day boundary - different day
      currentSession.day.getTime() !== versionDay.getTime() ||
      // Time gap - more than 30 minutes since last version in session
      (currentSession.lastTime - versionTime.getTime() > SESSION_INACTIVITY_THRESHOLD);

    if (shouldStartNewSession) {
      // Generate session label based on time of day
      const hour = versionTime.getHours();
      let sessionLabel;
      if (hour < 12) {
        sessionLabel = 'Morning';
      } else if (hour < 17) {
        sessionLabel = 'Afternoon';
      } else {
        sessionLabel = 'Evening';
      }

      // Format the session time
      const timeStr = versionTime.toLocaleTimeString('en-US', {
        hour: 'numeric',
        minute: '2-digit',
        hour12: true,
      });

      currentSession = {
        id: `session-${version.clockEnd}`,
        label: `${sessionLabel} session`,
        startTime: versionTime.toISOString(),
        endTime: versionTime.toISOString(),
        formattedTime: timeStr,
        day: versionDay,
        lastTime: versionTime.getTime(),
        versions: [],
        editCount: 0,
      };
      sessions.push(currentSession);
    }

    currentSession.versions.push(version);
    currentSession.editCount += (version.clockEnd - version.clockStart + 1);
    currentSession.lastTime = versionTime.getTime();
    // Update endTime to be the earliest version in session (since we're iterating most recent first)
    currentSession.endTime = version.timestamp;
  }

  return sessions;
}

/**
 * Merge named versions with auto-generated versions
 * Named versions take precedence and replace overlapping auto versions
 * @param {Array} autoVersions - Auto-generated versions from time grouping
 * @param {Array} namedVersions - User-created named versions
 * @returns {Array} Merged version list
 */
function mergeNamedVersions(autoVersions, namedVersions) {
  if (!namedVersions || namedVersions.length === 0) {
    return autoVersions.map((v, i) => ({
      ...v,
      id: `auto-${v.clockEnd}`,
      isNamed: false,
      isCurrent: i === autoVersions.length - 1,
    }));
  }

  // Create a map of auto versions by clockEnd for lookup
  const autoVersionMap = new Map();
  for (const autoVersion of autoVersions) {
    autoVersionMap.set(autoVersion.clockEnd, autoVersion);
  }

  // Create a map of clock ranges covered by named versions
  const namedRanges = namedVersions.map(nv => {
    // Find the matching auto version to get the original timestamp and authors
    const matchingAutoVersion = autoVersionMap.get(nv.clock_end);

    console.log(`[NamedVersion] Named version "${nv.name}" clock_end=${nv.clock_end}, found matching auto version:`, !!matchingAutoVersion);
    if (matchingAutoVersion) {
      console.log(`  Auto version timestamp: ${matchingAutoVersion.timestamp}`);
    } else {
      console.log(`  Using created_at: ${nv.created_at}`);
      console.log(`  Available auto version clockEnds:`, Array.from(autoVersionMap.keys()));
    }

    return {
      start: nv.clock_start,
      end: nv.clock_end,
      version: {
        id: nv.id,
        name: nv.name,
        clockStart: nv.clock_start,
        clockEnd: nv.clock_end,
        // Use the original version's timestamp, not the named version creation time
        timestamp: matchingAutoVersion?.timestamp || nv.created_at,
        isNamed: true,
        createdBy: nv.creator_name ? {
          id: nv.created_by,
          name: nv.creator_name,
          email: nv.creator_email,
          picture: nv.creator_picture,
          color: generateColorFromId(nv.created_by),
        } : null,
        // Use the original version's authors
        authors: matchingAutoVersion?.authors || [],
      },
    };
  });

  // Filter out auto versions that are fully covered by named versions
  const result = [];
  let maxClock = 0;

  for (const autoVersion of autoVersions) {
    // Check if this auto version overlaps with any named version
    const overlapping = namedRanges.find(
      nr => autoVersion.clockStart <= nr.end && autoVersion.clockEnd >= nr.start
    );

    if (!overlapping) {
      result.push({
        ...autoVersion,
        id: `auto-${autoVersion.clockEnd}`,
        isNamed: false,
      });
    }
    maxClock = Math.max(maxClock, autoVersion.clockEnd);
  }

  // Add named versions
  for (const nr of namedRanges) {
    result.push(nr.version);
  }

  // Sort by clock_end descending (most recent first)
  result.sort((a, b) => b.clockEnd - a.clockEnd);

  // Mark current version
  if (result.length > 0) {
    result[0].isCurrent = true;
  }

  return result;
}

/**
 * Format timestamp for display
 * @param {Date|string} timestamp - Timestamp to format
 * @returns {string} Formatted timestamp (e.g., "December 10, 4:44 PM")
 */
function formatTimestamp(timestamp) {
  const date = new Date(timestamp);
  const options = {
    month: 'long',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  };
  return date.toLocaleString('en-US', options);
}

/**
 * Get version history timeline for a document
 * @param {Object} persistence - PostgresPersistence instance
 * @param {string} docGuid - Document GUID
 * @returns {Promise<Object>} Version timeline data
 */
async function getVersionTimeline(persistence, docGuid) {
  // Get all updates with user info
  const updates = await persistence.getUpdatesWithUsers(docGuid);

  if (updates.length === 0) {
    return {
      versions: [],
      groupedVersions: [],
      totalEdits: 0,
    };
  }

  // Get named versions
  const namedVersions = await persistence.getNamedVersions(docGuid);

  // Group updates into auto versions
  const autoVersions = groupUpdatesIntoVersions(updates);

  // Merge with named versions
  const versions = mergeNamedVersions(autoVersions, namedVersions);

  // Format versions for API response
  const formattedVersions = versions.map(v => ({
    id: v.id,
    name: v.name || null,
    clockStart: v.clockStart,
    clockEnd: v.clockEnd,
    timestamp: v.timestamp,
    formattedTimestamp: formatTimestamp(v.timestamp),
    authors: v.authors || [],
    isNamed: v.isNamed || false,
    isCurrent: v.isCurrent || false,
  }));

  // Group by time period (month-level grouping)
  const groupedVersions = groupVersionsByPeriod(formattedVersions);

  // For hierarchical view, use the same month grouping (versions grouped by month)
  const hierarchicalVersions = groupedVersions;

  return {
    versions: formattedVersions,
    groupedVersions,
    hierarchicalVersions, // Versions grouped by month for drill-down UI
    totalEdits: updates.length,
  };
}

/**
 * Get document content at a specific version
 * @param {Object} persistence - PostgresPersistence instance
 * @param {string} docGuid - Document GUID
 * @param {string} versionId - Version ID (can be named version UUID or auto-{clock})
 * @returns {Promise<Object>} Version content and metadata
 */
async function getVersionContent(persistence, docGuid, versionId) {
  let clockEnd;
  let versionMeta = null;

  // Check if it's a named version (UUID format)
  if (versionId.match(/^[0-9a-f-]{36}$/i)) {
    const namedVersion = await persistence.getVersionById(versionId);
    if (!namedVersion) {
      throw new Error('Version not found');
    }
    clockEnd = namedVersion.clock_end;
    versionMeta = {
      id: namedVersion.id,
      name: namedVersion.name,
      clockStart: namedVersion.clock_start,
      clockEnd: namedVersion.clock_end,
      timestamp: namedVersion.created_at,
    };

    // If we have cached snapshot data, use it
    if (namedVersion.snapshot_data) {
      const ydoc = new Y.Doc();
      Y.applyUpdate(ydoc, new Uint8Array(namedVersion.snapshot_data));
      return {
        content: Array.from(Y.encodeStateAsUpdate(ydoc)),
        version: versionMeta,
      };
    }
  } else if (versionId.startsWith('auto-')) {
    // Auto-generated version ID format: auto-{clockEnd}
    clockEnd = parseInt(versionId.replace('auto-', ''), 10);
    if (isNaN(clockEnd)) {
      throw new Error('Invalid version ID');
    }
  } else if (versionId.startsWith('clock-')) {
    // Single clock update format: clock-{clock}
    clockEnd = parseInt(versionId.replace('clock-', ''), 10);
    if (isNaN(clockEnd)) {
      throw new Error('Invalid version ID');
    }
  } else {
    throw new Error('Invalid version ID format');
  }

  // Reconstruct document at the specified clock
  const ydoc = await persistence.getYDocAtClock(docGuid, clockEnd);
  const content = Y.encodeStateAsUpdate(ydoc);

  // Get version metadata if not already set
  if (!versionMeta) {
    const updates = await persistence.getUpdatesWithUsers(docGuid);
    const autoVersions = groupUpdatesIntoVersions(updates);
    const version = autoVersions.find(v => v.clockEnd === clockEnd);

    if (version) {
      versionMeta = {
        id: versionId,
        name: null,
        clockStart: version.clockStart,
        clockEnd: version.clockEnd,
        timestamp: version.timestamp,
        authors: version.authors,
      };
    }
  }

  return {
    content: Array.from(content),
    version: versionMeta,
  };
}

/**
 * Restore document to a previous version (non-destructive)
 * Creates the restore as a new update applied to the current document
 * @param {Object} persistence - PostgresPersistence instance
 * @param {string} docGuid - Document GUID
 * @param {string} versionId - Version ID to restore
 * @param {string} userId - User performing the restore
 * @param {Function|null} getSharedDocFn - Optional function to get the in-memory shared document
 * @returns {Promise<Object>} Result with new version info
 */
async function restoreVersion(persistence, docGuid, versionId, userId, getSharedDocFn = null) {
  console.log(`[Restore] Starting restore of ${docGuid} to version ${versionId}`);

  // Get the target version content
  const { content } = await getVersionContent(persistence, docGuid, versionId);
  console.log(`[Restore] Target version content size: ${content.length} bytes`);

  // Get current document state
  const currentYdoc = await persistence.getYDoc(docGuid);
  const currentFragment = currentYdoc.getXmlFragment('default');
  console.log(`[Restore] Current document has ${currentFragment.length} elements`);

  // Create a new temporary document to build the restore operation
  const tempDoc = new Y.Doc();

  // Apply the current state to the temp document
  Y.applyUpdate(tempDoc, Y.encodeStateAsUpdate(currentYdoc));

  // Get the state vector before we make changes
  const stateVectorBeforeRestore = Y.encodeStateVector(tempDoc);

  // Create target document from version to get the content we want
  const targetYdoc = new Y.Doc();
  Y.applyUpdate(targetYdoc, new Uint8Array(content));

  // Helper function to recursively clone Yjs XML content
  const cloneXmlElement = (sourceElement) => {
    if (sourceElement instanceof Y.XmlText) {
      const clone = new Y.XmlText();
      // Use toDelta() to preserve marks (bold, italic, strike, etc.)
      const delta = sourceElement.toDelta();
      let offset = 0;
      for (const op of delta) {
        if (typeof op.insert === 'string') {
          // Insert text with its formatting attributes
          clone.insert(offset, op.insert, op.attributes);
          offset += op.insert.length;
        }
      }
      return clone;
    } else if (sourceElement instanceof Y.XmlElement) {
      const clone = new Y.XmlElement(sourceElement.nodeName);
      // Clone attributes
      const attrs = sourceElement.getAttributes();
      for (const [key, value] of Object.entries(attrs)) {
        clone.setAttribute(key, value);
      }
      // Clone children
      const children = [];
      for (let i = 0; i < sourceElement.length; i++) {
        children.push(cloneXmlElement(sourceElement.get(i)));
      }
      if (children.length > 0) {
        clone.insert(0, children);
      }
      return clone;
    }
    return null;
  };

  // Replace the content in temp document with target content
  tempDoc.transact(() => {
    const tempFragment = tempDoc.getXmlFragment('default');
    const targetFragment = targetYdoc.getXmlFragment('default');

    console.log(`[Restore] Target has ${targetFragment.length} elements`);

    // Delete all current content
    while (tempFragment.length > 0) {
      tempFragment.delete(0, tempFragment.length);
    }

    // Clone and insert target content
    const clonedElements = [];
    for (let i = 0; i < targetFragment.length; i++) {
      const cloned = cloneXmlElement(targetFragment.get(i));
      if (cloned) {
        clonedElements.push(cloned);
      }
    }

    console.log(`[Restore] Cloned ${clonedElements.length} elements`);

    if (clonedElements.length > 0) {
      tempFragment.insert(0, clonedElements);
    }

    console.log(`[Restore] After restore, temp doc has ${tempFragment.length} elements`);
  });

  // Get only the diff created by the restore transaction
  const restoreUpdate = Y.encodeStateAsUpdate(tempDoc, stateVectorBeforeRestore);
  console.log(`[Restore] Restore update size: ${restoreUpdate.length} bytes`);

  // Store as a new update (this is the restore operation)
  const newClock = await persistence.storeUpdate(docGuid, restoreUpdate, userId);
  console.log(`[Restore] Stored restore update with clock ${newClock}`);

  // Apply the restore update to the in-memory document so it broadcasts to clients
  if (getSharedDocFn) {
    try {
      const sharedDoc = getSharedDocFn(docGuid);
      if (sharedDoc) {
        // Apply the update with userId as origin so it's attributed correctly
        // The update event will try to persist it again, but ON CONFLICT DO NOTHING
        // in storeUpdate will prevent duplicates
        Y.applyUpdate(sharedDoc, restoreUpdate, userId);
        console.log(`[Restore] Applied restore update to in-memory document`);
      } else {
        console.warn(`[Restore] Could not get shared document for ${docGuid} - update not broadcast`);
      }
    } catch (error) {
      console.error(`[Restore] Error applying restore update to in-memory document:`, error);
      // Don't fail the restore if we can't update the in-memory doc
      // The update is already persisted, so it will be loaded on next connection
    }
  } else {
    console.warn(`[Restore] No getSharedDocFn provided - restore update not applied to in-memory document`);
  }

  return {
    success: true,
    newClock,
    message: 'Document restored successfully',
  };
}

/**
 * Get individual updates within a clock range (for drill-down)
 * @param {Object} persistence - PostgresPersistence instance
 * @param {string} docGuid - Document GUID
 * @param {number} clockStart - Starting clock value (inclusive)
 * @param {number} clockEnd - Ending clock value (inclusive)
 * @returns {Promise<Array>} Array of individual updates with metadata
 */
async function getUpdatesForVersion(persistence, docGuid, clockStart, clockEnd) {
  const updates = await persistence.getUpdatesInRange(docGuid, clockStart, clockEnd);

  // Map to response format and reverse to show most recent first
  return updates.map(update => ({
    clock: update.clock,
    timestamp: update.createdAt,
    formattedTimestamp: formatTimestamp(update.createdAt),
    author: createAuthor(update),
  })).reverse();
}

/**
 * Get document content at a specific clock value
 * @param {Object} persistence - PostgresPersistence instance
 * @param {string} docGuid - Document GUID
 * @param {number} clock - Clock value
 * @returns {Promise<Object>} Document content and metadata
 */
async function getContentAtClock(persistence, docGuid, clock) {
  const ydoc = await persistence.getYDocAtClock(docGuid, clock);
  const content = Y.encodeStateAsUpdate(ydoc);

  // Get metadata for this clock
  const updates = await persistence.getUpdatesInRange(docGuid, clock, clock);
  const update = updates[0];

  return {
    content: Array.from(content),
    clock,
    timestamp: update?.createdAt || null,
    formattedTimestamp: update ? formatTimestamp(update.createdAt) : null,
    author: update ? createAuthor(update) : null,
  };
}

module.exports = {
  generateColorFromId,
  groupUpdatesIntoVersions,
  groupVersionsByPeriod,
  groupVersionsIntoSessions,
  mergeNamedVersions,
  formatTimestamp,
  getVersionTimeline,
  getVersionContent,
  getUpdatesForVersion,
  getContentAtClock,
  restoreVersion,
  DEFAULT_INACTIVITY_THRESHOLD,
  SESSION_INACTIVITY_THRESHOLD,
};
