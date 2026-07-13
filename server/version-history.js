/**
 * Version History Business Logic
 * Handles version grouping, timeline generation, and restore operations
 */

const Y = require('yjs');
const { createOrigin } = require('./origin');
const { extractXml } = require('./yjs-utils');

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
 * Create an author object from update data or named version data
 * Shared helper to ensure consistent author representation
 * Accepts multiple input formats:
 *   - Update format: { userId, userName, userEmail, userPicture, agentName }
 *   - Named version format: { created_by, creator_name, creator_email, creator_picture }
 * @param {Object} data - Data object with user info
 * @returns {Object|null} Author object or null if no userId
 */
function createAuthor(data) {
  // Support both naming conventions
  const userId = data.userId || data.created_by;
  const userName = data.userName || data.creator_name;
  const userEmail = data.userEmail || data.creator_email;
  const userPicture = data.userPicture || data.creator_picture;
  const agentName = data.agentName;

  if (!userId) return null;

  const authorKey = getAuthorKey(userId, agentName);
  const displayName = agentName
    ? (userName ? `${agentName} (${userName})` : agentName)
    : (userName || 'Unknown');

  return {
    id: userId,
    name: displayName,
    email: userEmail,
    picture: userPicture,
    color: generateColorFromId(authorKey),
    isAgent: !!agentName,
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
        onBehalfOf: [], // sync-push provenance (feature 004, D8); plain text
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

    // Collect on-behalf-of provenance from sync-push updates in this version.
    if (update.onBehalfOf && typeof update.onBehalfOf === 'object') {
      currentVersion.onBehalfOf.push(update.onBehalfOf);
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
      id: String(v.clockEnd),
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
      createdBy: createAuthor(nv),
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
        id: String(autoVersion.clockEnd),
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
            id: String(currentEnd),
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
          id: String(currentEnd),
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
 * Extract metadata from a Y.Doc
 * @param {Y.Doc} doc - Current Yjs document
 * @param {string} previousText - Text content before this update (for delta calculation)
 * @returns {Object} Metadata object with character/word/block counts and delta
 */
function extractMetadata(doc, previousText = '') {
  const text = extractXml(doc);
  const fragment = doc.get('default', Y.XmlFragment);

  const characterCount = text.length;
  const words = text.trim().split(/\s+/).filter(w => w.length > 0);
  const wordCount = words.length;
  const blockCount = fragment.length;
  const charactersDelta = characterCount - previousText.length;

  return {
    characterCount,
    wordCount,
    blockCount,
    charactersDelta,
  };
}

/**
 * Enrich versions with metadata by reconstructing document state at each version
 * @param {Object} persistence - PostgresPersistence instance
 * @param {string} docGuid - Document GUID
 * @param {Array} versions - Array of version objects with clockStart/clockEnd (in any order)
 * @param {Array} updates - Array of meaningful updates for duration/editCount calculation
 * @param {boolean} includeDocumentMetadata - Whether to include character/word/block counts (expensive)
 * @returns {Promise<Array>} Versions enriched with metadata (in same order as input)
 */
async function enrichVersionsWithMetadata(persistence, docGuid, versions, updates, includeDocumentMetadata = true) {
  if (versions.length === 0) return versions;

  try {
    // Build a map of clock -> timestamp for duration calculation
    const updateMap = new Map(updates.map(u => [u.clock, new Date(u.createdAt).getTime()]));

    // Create a map to preserve original order
    const orderMap = new Map(versions.map((v, i) => [v, i]));

    // Sort versions by clockEnd ascending for processing (oldest first)
    const sortedVersions = [...versions].sort((a, b) => a.clockEnd - b.clockEnd);

    let previousText = '';
    const enrichedMap = new Map();

    for (const version of sortedVersions) {
      try {
        const startTime = Date.now();
        let metadata = {};
        let reconstructTime = 0;
        let metadataTime = 0;

        // Only reconstruct document if we need document metadata (expensive)
        if (includeDocumentMetadata) {
          const doc = await persistence.getYDocAtClock(docGuid, version.clockEnd);
          reconstructTime = Date.now() - startTime;

          const metadataStart = Date.now();
          metadata = extractMetadata(doc, previousText);
          metadataTime = Date.now() - metadataStart;

          // Update previousText for next iteration's delta calculation
          previousText = extractXml(doc);
        }

        // Calculate editCount - number of meaningful updates in this version's range
        const editCount = updates.filter(
          u => u.clock >= version.clockStart && u.clock <= version.clockEnd
        ).length;

        // Calculate duration - time span from first to last update in this version
        const versionUpdates = Array.from(updateMap.entries())
          .filter(([clock]) => clock >= version.clockStart && clock <= version.clockEnd)
          .map(([, time]) => time);
        const duration = versionUpdates.length > 1
          ? Math.max(...versionUpdates) - Math.min(...versionUpdates)
          : 0;

        enrichedMap.set(version, {
          ...version,
          editCount,
          duration,
          ...metadata,
        });

        const totalTime = Date.now() - startTime;
        if (totalTime > 100) {
          console.log(`[enrichVersionsWithMetadata] Version ${version.id || version.clockEnd}: reconstruct=${reconstructTime}ms, metadata=${metadataTime}ms, total=${totalTime}ms`);
        }
      } catch (error) {
        console.error(`[enrichVersionsWithMetadata] Error processing version ${version.id || version.clockEnd}:`, error);
        throw error;
      }
    }

    // Return enriched versions in original order
    return versions.map(v => enrichedMap.get(v));
  } catch (error) {
    console.error('[enrichVersionsWithMetadata] Error enriching versions:', error);
    throw new Error(`Failed to enrich versions with metadata: ${error.message}`);
  }
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
  let previousText = extractXml(baseDoc);

  for (const update of updates) {
    const updateData = updateDataMap.get(update.clock);
    if (!updateData) continue;

    // Apply the update
    Y.applyUpdate(baseDoc, updateData);

    // Get text after applying update
    const currentText = extractXml(baseDoc);

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
    // Sync-push provenance (feature 004, D8), rendered strictly as plain text.
    onBehalfOf: v.onBehalfOf || [],
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
 * @param {string} versionId - Version ID (UUID for named versions, or clock number as string)
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
  } else {
    // Parse as clock number
    clockEnd = parseInt(versionId, 10);
    if (isNaN(clockEnd)) {
      throw new Error('Invalid version ID format');
    }
  }

  // Validate that the requested clock exists
  // Get all updates to check clock range
  const updates = await persistence.getUpdatesWithUsers(docGuid);

  if (updates.length === 0) {
    throw new Error('Document has no version history');
  }

  // Find min and max clocks
  const clocks = updates.map(u => u.clock);
  const minClock = Math.min(...clocks);
  const maxClock = Math.max(...clocks);

  // Check if requested clock is out of range
  if (clockEnd < minClock || clockEnd > maxClock) {
    throw new Error(`Version not found: ${versionId} (clock ${clockEnd} out of range ${minClock}-${maxClock})`);
  }

  // Reconstruct document at the specified clock
  const ydoc = await persistence.getYDocAtClock(docGuid, clockEnd);
  const content = Y.encodeStateAsUpdate(ydoc);

  // Get version metadata if not already set
  if (!versionMeta) {
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
 * @param {string|null} agentName - Agent name for attribution (e.g., 'Chat Assistant')
 * @returns {Promise<Object>} Result with new version info
 */
async function restoreVersion(persistence, docGuid, versionId, userId, getSharedDocFn = null, agentName = null) {
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
  const newClock = await persistence.storeUpdate(docGuid, restoreUpdate, userId, agentName);
  console.log(`[Restore] Stored restore update with clock ${newClock}`);

  // Apply the restore update to the in-memory document so it broadcasts to clients
  if (getSharedDocFn) {
    try {
      const sharedDoc = getSharedDocFn(docGuid);
      if (sharedDoc) {
        // Apply the update with proper origin so it's attributed correctly
        // The update event will try to persist it again, but ON CONFLICT DO NOTHING
        // in storeUpdate will prevent duplicates
        Y.applyUpdate(sharedDoc, restoreUpdate, createOrigin(userId, agentName));
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
 * @param {number} limit - Maximum number of subversions to return (default: 10)
 * @returns {Promise<Object>} Object with subversions array and metadata
 */
async function getUpdatesForVersion(persistence, docGuid, clockStart, clockEnd, limit = 10) {
  const startTime = Date.now();
  const updates = await persistence.getUpdatesInRange(docGuid, clockStart, clockEnd);
  const fetchTime = Date.now() - startTime;

  // Group updates into sub-versions using 10-second threshold
  // No document reconstruction needed - just return metadata about update groupings
  const groupStart = Date.now();
  const subVersions = groupUpdatesIntoVersions(
    updates.map(u => ({
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
  const groupTime = Date.now() - groupStart;

  // Map to response format and reverse to show most recent first (newest first)
  const allSubversions = subVersions.map((sv, i) => ({
    id: String(sv.clockEnd),
    clockStart: sv.clockStart,
    clockEnd: sv.clockEnd,
    previousClock: i === subVersions.length - 1
      ? (clockStart > 0 ? clockStart - 1 : -1)
      : subVersions[i + 1].clockEnd,
    timestamp: sv.timestamp,
    formattedTimestamp: formatTimestamp(sv.timestamp),
    authors: sv.authors || [],
    updateCount: sv.clockEnd - sv.clockStart + 1,
  })).reverse();

  // Apply limit (most recent first)
  const total = allSubversions.length;
  const limitedSubversions = allSubversions.slice(0, limit);
  const hasMore = total > limit;

  const totalTime = Date.now() - startTime;
  console.log(`[getUpdatesForVersion] clocks ${clockStart}-${clockEnd}: fetch=${fetchTime}ms, group=${groupTime}ms, total=${totalTime}ms, updates=${updates.length}, subversions=${total}, returned=${limitedSubversions.length}`);

  return {
    subversions: limitedSubversions,
    total,
    hasMore,
  };
}

/**
 * Get authors from the current editing session
 * Uses same grouping logic as version history (5-minute inactivity threshold)
 * @param {Array} updates - Array of updates with user info (in ascending clock order)
 * @returns {Array} Authors from the most recent session (last version)
 */
function getCurrentSessionAuthors(updates) {
  if (!updates || updates.length === 0) return [];
  const versions = groupUpdatesIntoVersions(updates, DEFAULT_INACTIVITY_THRESHOLD);
  if (versions.length === 0) return [];
  return versions[versions.length - 1].authors;
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
  createAuthor,
  groupUpdatesIntoVersions,
  mergeNamedVersions,
  formatTimestamp,
  getVersionTimeline,
  getVersionContent,
  getUpdatesForVersion,
  getContentAtClock,
  getCurrentSessionAuthors,
  restoreVersion,
  DEFAULT_INACTIVITY_THRESHOLD,
  UPDATE_GROUPING_THRESHOLD,
};
