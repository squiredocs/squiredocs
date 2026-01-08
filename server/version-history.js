/**
 * Version History Business Logic
 * Handles version grouping, timeline generation, and restore operations
 */

const Y = require('yjs');

// Default inactivity threshold for grouping updates into versions (5 minutes)
const DEFAULT_INACTIVITY_THRESHOLD = 5 * 60 * 1000;

// Inactivity threshold for grouping individual updates within a version (10 seconds)
const UPDATE_GROUPING_THRESHOLD = 10 * 1000;

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
 * Merge named versions with auto-generated versions
 * Named versions take precedence and can split auto versions
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

  // Create named version objects with metadata
  const namedVersionObjects = namedVersions.map(nv => {
    // Find the auto version that contains this named version for timestamp/authors
    const matchingAutoVersion = autoVersions.find(av =>
      av.clockStart <= nv.clock_end && av.clockEnd >= nv.clock_end
    );

    // Prefer original_timestamp (from yjs_updates), then matching auto version, then created_at
    const timestamp = nv.original_timestamp || matchingAutoVersion?.timestamp || nv.created_at;

    return {
      id: nv.id,
      name: nv.name,
      clockStart: nv.clock_start,
      clockEnd: nv.clock_end,
      timestamp,
      isNamed: true,
      createdBy: nv.creator_name ? {
        id: nv.created_by,
        name: nv.creator_name,
        email: nv.creator_email,
        picture: nv.creator_picture,
        color: generateColorFromId(nv.created_by),
      } : null,
      authors: matchingAutoVersion?.authors || [],
    };
  });

  // Process auto versions, splitting them around named versions
  const result = [];
  let maxClock = 0;

  for (const autoVersion of autoVersions) {
    // Find all named versions that overlap with this auto version
    const overlappingNamed = namedVersionObjects.filter(
      nv => nv.clockStart <= autoVersion.clockEnd && nv.clockEnd >= autoVersion.clockStart
    );

    console.log(`[MergeVersions] Auto version ${autoVersion.clockStart}-${autoVersion.clockEnd}, overlapping named:`,
      overlappingNamed.map(nv => `${nv.name}(${nv.clockStart}-${nv.clockEnd})`));

    if (overlappingNamed.length === 0) {
      // No overlap - keep the auto version as-is
      result.push({
        ...autoVersion,
        id: `auto-${autoVersion.clockEnd}`,
        isNamed: false,
      });
    } else {
      // Split the auto version around named versions
      // Named versions end at their clockEnd, so we need to create fragments
      // for clocks that come AFTER named versions
      // Sort overlapping named versions by clockEnd descending to process from end
      overlappingNamed.sort((a, b) => b.clockEnd - a.clockEnd);

      let currentEnd = autoVersion.clockEnd;

      for (const nv of overlappingNamed) {
        // Add auto version fragment after this named version (if any)
        if (nv.clockEnd < currentEnd) {
          console.log(`[MergeVersions] Creating fragment ${nv.clockEnd + 1}-${currentEnd} after ${nv.name}`);
          result.push({
            ...autoVersion,
            clockStart: nv.clockEnd + 1,
            clockEnd: currentEnd,
            id: `auto-${currentEnd}`,
            isNamed: false,
          });
        }

        // Move back past the named version's range
        currentEnd = nv.clockStart - 1;
      }

      // Add any remaining fragment before the first named version
      if (autoVersion.clockStart <= currentEnd) {
        console.log(`[MergeVersions] Creating fragment ${autoVersion.clockStart}-${currentEnd} before named versions`);
        result.push({
          ...autoVersion,
          clockStart: autoVersion.clockStart,
          clockEnd: currentEnd,
          id: `auto-${currentEnd}`,
          isNamed: false,
        });
      }
    }

    maxClock = Math.max(maxClock, autoVersion.clockEnd);
  }

  // Add named versions
  for (const nv of namedVersionObjects) {
    result.push(nv);
  }

  // Sort by clockEnd descending (most recent first)
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
 * Extract plain text from a Y.Doc's default XmlFragment
 * @param {Y.Doc} doc - Yjs document
 * @returns {string} Plain text content
 */
function extractTextFromDoc(doc) {
  const fragment = doc.get('default', Y.XmlFragment);
  let text = '';
  fragment.forEach(node => {
    if (node.toString) {
      // For XmlElement nodes, get text content
      const nodeStr = node.toString();
      // Strip XML tags to get plain text
      text += nodeStr.replace(/<[^>]*>/g, '') + '\n';
    }
  });
  return text.trim();
}

/**
 * Filter out redundant updates that don't change the document text content
 * This filters out CRDT sync updates that add new client IDs but don't change visible text
 * @param {Object} persistence - PostgresPersistence instance
 * @param {string} docGuid - Document GUID
 * @param {Array} updates - Array of updates with clock values
 * @returns {Promise<Array>} Filtered updates that actually change text content
 */
async function filterMeaningfulUpdates(persistence, docGuid, updates) {
  if (updates.length === 0) return [];

  // Get all update data for this document
  const minClock = updates[0].clock;
  const maxClock = updates[updates.length - 1].clock;
  const updatesWithData = await persistence.getUpdatesInRange(docGuid, minClock, maxClock);

  // Create a map of clock -> update data for quick lookup
  const updateDataMap = new Map();
  for (const u of updatesWithData) {
    updateDataMap.set(u.clock, u.updateData);
  }

  // Build document state just before the first update
  const baseDoc = minClock > 0
    ? await persistence.getYDocAtClock(docGuid, minClock - 1)
    : new Y.Doc();

  // Filter to only include updates that actually change text content
  // (not just CRDT state like new client IDs from sync)
  const meaningfulUpdates = [];
  let previousText = extractTextFromDoc(baseDoc);

  for (const update of updates) {
    const updateData = updateDataMap.get(update.clock);
    if (!updateData) continue;

    // Apply the update
    Y.applyUpdate(baseDoc, updateData);

    // Get text after applying update
    const currentText = extractTextFromDoc(baseDoc);

    // Only include if text content actually changed
    if (currentText !== previousText) {
      meaningfulUpdates.push(update);
      previousText = currentText;
    }
  }

  return meaningfulUpdates;
}

/**
 * Get version history timeline for a document
 * @param {Object} persistence - PostgresPersistence instance
 * @param {string} docGuid - Document GUID
 * @returns {Promise<Object>} Version timeline data
 */
async function getVersionTimeline(persistence, docGuid) {
  // Get all updates with user info
  const allUpdates = await persistence.getUpdatesWithUsers(docGuid);

  if (allUpdates.length === 0) {
    return {
      versions: [],
      totalEdits: 0,
    };
  }

  // Filter out redundant updates that don't change document state
  const updates = await filterMeaningfulUpdates(persistence, docGuid, allUpdates);

  if (updates.length === 0) {
    return {
      versions: [],
      totalEdits: 0,
    };
  }

  // Get named versions
  const namedVersions = await persistence.getNamedVersions(docGuid);

  // Group updates into auto versions
  const autoVersions = groupUpdatesIntoVersions(updates);

  // Merge with named versions
  const versions = mergeNamedVersions(autoVersions, namedVersions);

  // DEBUG: Log final merged versions
  console.log('[GetVersionTimeline] Final merged versions:',
    versions.map(v => `${v.name || 'auto'}(${v.clockStart}-${v.clockEnd})`));

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

  // Client handles grouping by month for proper local timezone handling
  return {
    versions: formattedVersions,
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
      // Use applyDelta to properly preserve marks (bold, italic, links, etc.)
      // This handles mark boundaries correctly, unlike manual insert() calls
      // which can cause marks to "bleed" into adjacent text
      clone.applyDelta(sourceElement.toDelta());
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
 * Get updates within a clock range, grouped into sub-versions (for drill-down)
 * Groups updates with less than 10 seconds between them into sub-versions
 * Filters out redundant/duplicate updates that don't change the document state
 * @param {Object} persistence - PostgresPersistence instance
 * @param {string} docGuid - Document GUID
 * @param {number} clockStart - Starting clock value (inclusive)
 * @param {number} clockEnd - Ending clock value (inclusive)
 * @returns {Promise<Array>} Array of grouped sub-versions with metadata
 */
async function getUpdatesForVersion(persistence, docGuid, clockStart, clockEnd) {
  const updates = await persistence.getUpdatesInRange(docGuid, clockStart, clockEnd);

  // Build document state just before the range to detect which updates actually change text
  const baseDoc = clockStart > 0
    ? await persistence.getYDocAtClock(docGuid, clockStart - 1)
    : new Y.Doc();

  // Filter to only include updates that actually change text content
  // (not just CRDT state like new client IDs from sync)
  const meaningfulUpdates = [];
  let previousText = extractTextFromDoc(baseDoc);

  for (const update of updates) {
    // Apply the update
    Y.applyUpdate(baseDoc, update.updateData);

    // Get text after applying update
    const currentText = extractTextFromDoc(baseDoc);

    // Only include if text content actually changed
    if (currentText !== previousText) {
      meaningfulUpdates.push(update);
      previousText = currentText;
    }
  }

  // Group updates into sub-versions using 10-second threshold
  const subVersions = groupUpdatesIntoVersions(
    meaningfulUpdates.map(u => ({
      clock: u.clock,
      createdAt: u.createdAt,
      userId: u.userId,
      userName: u.userName,
      userEmail: u.userEmail,
      userPicture: u.userPicture,
      agentName: u.agentName,
    })),
    UPDATE_GROUPING_THRESHOLD
  );

  // Map to response format and reverse to show most recent first
  return subVersions.map(sv => ({
    id: `subversion-${sv.clockEnd}`,
    clockStart: sv.clockStart,
    clockEnd: sv.clockEnd,
    timestamp: sv.timestamp,
    formattedTimestamp: formatTimestamp(sv.timestamp),
    authors: sv.authors || [],
    updateCount: sv.clockEnd - sv.clockStart + 1,
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
  mergeNamedVersions,
  formatTimestamp,
  getVersionTimeline,
  getVersionContent,
  getUpdatesForVersion,
  getContentAtClock,
  restoreVersion,
  DEFAULT_INACTIVITY_THRESHOLD,
  UPDATE_GROUPING_THRESHOLD,
};
