/**
 * Version History Business Logic
 * Handles version grouping, timeline generation, and restore operations
 */

const Y = require('yjs');
const { ORIGIN_RESTORE } = require('./origin');
const { extractXml } = require('./yjs-utils');
const editRecords = require('./undo/edit-records');
const { applyLiveUpdate } = require('./live-apply');

/**
 * Thrown when a requested version cannot be resolved: an unknown/foreign named
 * version id, an unparseable version id, or a clock outside the document's
 * range. Callers map `instanceof VersionNotFoundError` to HTTP 404 (F6) — the
 * previous `error.message === 'Version not found'` string checks never matched
 * the descriptive out-of-range message, so those turned into 500s. The message
 * stays descriptive for MCP callers that surface it to the model.
 */
class VersionNotFoundError extends Error {
  constructor(message = 'Version not found') {
    super(message);
    this.name = 'VersionNotFoundError';
  }
}

/**
 * Thrown when a restore would build its stored artifacts (the restore update row
 * + the agent_edits record) from a read that is still gapped after the shared
 * retry budget (feature 023 FR-009, D-2). Restore is the one stored-artifact path
 * that must fail CLOSED on a torn log — the same fail-closed posture undo uses —
 * rather than persist content derived from a non-contiguous read. REST maps this
 * to HTTP 503; the MCP surface surfaces the message as a teaching error so the
 * model retries. Never raised on serving-only reads (previews/diffs serve as-is).
 */
class DocumentSyncingError extends Error {
  constructor(message = 'The document is still syncing — retry in a moment.') {
    super(message);
    this.name = 'DocumentSyncingError';
  }
}

// Default inactivity threshold for grouping updates into versions (5 minutes)
const DEFAULT_INACTIVITY_THRESHOLD = 5 * 60 * 1000;

// Inactivity threshold for grouping individual updates within a version (10 seconds)
const UPDATE_GROUPING_THRESHOLD = 10 * 1000;

// Max distinct on-behalf-of identities surfaced per version before overflowing
// into a "+N more" count (feature 004, D8; review note #5 — keeps a
// high-frequency CI pusher from accreting an unbounded array in the timeline).
const MAX_ONBEHALFOF_IDENTITIES = 10;

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
 * The synthetic contributor shown for update rows that carry no user
 * attribution (feature 040, FR-008, D4).
 *
 * Such rows are real history — most often edits by a user who has since
 * deleted their account, since `yjs_updates.user_id` is `ON DELETE SET NULL`
 * precisely so a document's history survives its contributors (see the
 * FK-policy note in server/undo/edit-records.js). Before this feature those
 * rows were simply skipped, so a version built entirely from them rendered an
 * EMPTY contributor list — which reads as "nobody edited this", a silent lie
 * about a version that demonstrably exists.
 *
 * `color` is the stable neutral, matching the client's no-id fallback, so the
 * entry looks identical on any day (FR-010).
 */
const UNKNOWN_AUTHOR = Object.freeze({
  id: null,
  name: 'Unknown author',
  email: null,
  picture: null,
  color: '#888888',
  isAgent: false,
});

/** Fixed map key for UNKNOWN_AUTHOR, so repeated unattributed rows COLLAPSE
 * into exactly one entry per version instead of one entry per row. */
const UNKNOWN_AUTHOR_KEY = 'unknown';

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
 * Dedupe a version's raw on-behalf-of push provenance by identity (name+email),
 * aggregating a push count and the most-recent commit/url per identity, then cap
 * the number of distinct identities with an overflow count.
 *
 * Input entries are the field-whitelisted, length-capped push objects
 * ({ name?, email?, commit?, url? }) collected in chronological
 * (ascending-clock) order, so "latest" == last seen. Output entries are
 * { name?, email?, commitCount, latestCommit?, latestUrl? } — still strictly
 * plain-text, untrusted values that the client renders inertly (the XSS posture
 * from the 004 review is load-bearing; nothing here makes them safe as markup).
 *
 * @param {Array} rawPushes - Per-version push provenance objects, chronological
 * @returns {{ identities: Array, moreIdentities: number }}
 */
function dedupeOnBehalfOf(rawPushes) {
  const byIdentity = new Map(); // identityKey -> aggregated entry (insertion order = first-seen)

  for (const p of rawPushes) {
    if (!p || typeof p !== 'object') continue;
    const name = typeof p.name === 'string' && p.name.length > 0 ? p.name : undefined;
    const email = typeof p.email === 'string' && p.email.length > 0 ? p.email : undefined;

    // Identity is the (name, email) pair; entries with neither collapse into a
    // single anonymous identity (still bounded).
    const key = `${name || ''}\u0000${email || ''}`;

    let entry = byIdentity.get(key);
    if (!entry) {
      entry = { name, email, commitCount: 0 };
      byIdentity.set(key, entry);
    }

    entry.commitCount += 1;
    // Chronological order => last write wins == most recent.
    if (typeof p.commit === 'string' && p.commit.length > 0) {
      entry.latestCommit = p.commit;
    }
    if (typeof p.url === 'string' && p.url.length > 0) {
      entry.latestUrl = p.url;
    }
  }

  const all = Array.from(byIdentity.values());
  return {
    identities: all.slice(0, MAX_ONBEHALFOF_IDENTITIES),
    moreIdentities: Math.max(0, all.length - MAX_ONBEHALFOF_IDENTITIES),
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
    } else if (!update.userId && !currentVersion.authors.has(UNKNOWN_AUTHOR_KEY)) {
      // Feature 040 (FR-008): a row with no user attribution still gets a
      // contributor entry, so a version whose rows all lost their user (a
      // deleted account — `yjs_updates.user_id` is ON DELETE SET NULL) shows
      // "Unknown author" instead of an empty list. The FIXED key collapses
      // any number of unattributed rows into exactly one entry, and lets it
      // coexist with the version's real authors.
      //
      // NOTE: `getUpdatesForVersion` (the sub-version drill-down) calls THIS
      // SAME function, so this one change satisfies FR-008's "both paths"
      // requirement. Do not duplicate it there.
      currentVersion.authors.set(UNKNOWN_AUTHOR_KEY, UNKNOWN_AUTHOR);
    }

    // Collect on-behalf-of provenance from sync-push updates in this version.
    if (update.onBehalfOf && typeof update.onBehalfOf === 'object') {
      currentVersion.onBehalfOf.push(update.onBehalfOf);
    }
  }

  // Convert author maps to arrays and dedupe+cap on-behalf-of provenance.
  return versions.map(v => {
    const { identities, moreIdentities } = dedupeOnBehalfOf(v.onBehalfOf);
    return {
      ...v,
      authors: Array.from(v.authors.values()),
      onBehalfOf: identities,
      onBehalfOfMore: moreIdentities,
    };
  });
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

  // Feature 023 US4: filter on the persisted meaningful flag instead of
  // replaying the whole log. O(rows), independent of document content size
  // (FR-016). NULL (unknown — pre-023 rows, or written by an old pod during a
  // deploy) is KEPT as meaningful (fail-visible, D-3); only an explicit `false`
  // (classified noise) is dropped.
  const updates = allUpdates.filter(u => u.meaningful !== false);

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
    // Sync-push provenance (feature 004, D8), deduped by identity and capped
    // (review note #5); rendered strictly as plain text by the client.
    onBehalfOf: v.onBehalfOf || [],
    onBehalfOfMore: v.onBehalfOfMore || 0,
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
 * @param {object} [opts]
 * @param {boolean} [opts.withGap=false] - when true, additively return `gapped`
 *   (from the gap-tolerant content read) so a stored-artifact caller (restore,
 *   023 FR-009/D-2) can fail closed on a torn log. Serving-only callers (version
 *   preview, compare) omit it and keep serving as-is.
 * @returns {Promise<Object>} Version content and metadata
 */
async function getVersionContent(persistence, docGuid, versionId, { withGap = false } = {}) {
  let clockEnd;
  let versionMeta = null;

  // Check if it's a named version (UUID format)
  if (versionId.match(/^[0-9a-f-]{36}$/i)) {
    // getVersionById is doc-scoped at the SQL layer (F7), so a foreign version
    // id resolves to null here — the cross-doc leak is impossible below the
    // call. The JS-level doc_id equality check is kept as belt-and-suspenders
    // (and still guards mock persistences in tests). Indistinguishable
    // "not found" wording so a foreign id leaks nothing.
    const namedVersion = await persistence.getVersionById(versionId, docGuid);
    if (!namedVersion || namedVersion.doc_id !== docGuid) {
      throw new VersionNotFoundError('Version not found');
    }
    clockEnd = namedVersion.clock_end;
    versionMeta = {
      id: namedVersion.id,
      name: namedVersion.name,
      clockStart: namedVersion.clock_start,
      clockEnd: namedVersion.clock_end,
      timestamp: namedVersion.created_at,
    };

    // Feature 023 US3 (FR-012): named-version content is ALWAYS produced by
    // replaying the log to clock_end under the gap-tolerant read path — never
    // from a stored blob. The old cached-snapshot fast-path is removed; a pre-023
    // diverged blob heals silently to the replayed truth (D-6).
  } else {
    // Parse as clock number
    clockEnd = parseInt(versionId, 10);
    if (isNaN(clockEnd)) {
      throw new VersionNotFoundError('Invalid version ID format');
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
    throw new VersionNotFoundError(`Version not found: ${versionId} (clock ${clockEnd} out of range ${minClock}-${maxClock})`);
  }

  // Reconstruct document at the specified clock. Read WITH the gap indicator so
  // a stored-artifact caller (restore) can refuse a torn read (023 FR-009/D-2);
  // a plain Y.Doc from a mock/serving path unwraps to gapped=false.
  const atClockRead = await persistence.getYDocAtClock(docGuid, clockEnd, { withGap: true });
  const ydoc = atClockRead instanceof Y.Doc ? atClockRead : atClockRead.ydoc;
  const contentGapped = atClockRead instanceof Y.Doc ? false : !!atClockRead.gapped;
  const content = Y.encodeStateAsUpdate(ydoc);

  // Get version metadata if not already set
  if (!versionMeta) {
    // Group the meaningful-filtered set for parity with getVersionTimeline
    // (feature 023 US4): NULL kept, explicit noise dropped — so a clock that is
    // a version boundary in the timeline resolves to the same auto-version here.
    const meaningfulUpdates = updates.filter(u => u.meaningful !== false);
    const autoVersions = groupUpdatesIntoVersions(meaningfulUpdates);
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

  const result = {
    content: Array.from(content),
    version: versionMeta,
  };
  if (withGap) result.gapped = contentGapped;
  return result;
}

/**
 * Restore document to a previous version (non-destructive) — the ONE shared core
 * behind both restore surfaces (REST route and MCP tool), feature 023 US5.
 * Creates the restore as a single new update, records an undo-invertible edit
 * record for it, and broadcasts it live on every instance (no silent skip).
 * @param {Object} persistence - PostgresPersistence instance
 * @param {string} docGuid - Document GUID
 * @param {string} versionId - Version ID to restore
 * @param {string} userId - User performing the restore
 * @param {object} [deps]
 * @param {Function|null} [deps.getSharedDoc] - docGuid -> Y.Doc|null (in-memory doc)
 * @param {object|null} [deps.redisPubSub] - cross-instance fan-out when not loaded
 * @param {string|null} [deps.agentName] - Acting agent name, or `null` for a
 *   human web-UI restore. An MCP restore passes the agent token's own name and
 *   is recorded as that agent's undoable edit; a human restore is attributed to
 *   the human in the update log and is NOT an undo target (see below).
 * @returns {Promise<Object>} Result with new version info
 */
async function restoreVersion(persistence, docGuid, versionId, userId, {
  getSharedDoc = null,
  redisPubSub = null,
  agentName = null,
} = {}) {
  console.log(`[Restore] Starting restore of ${docGuid} to version ${versionId}`);

  // Get the target version content, WITH the gap indicator (023 FR-009/D-2).
  const { content, gapped: targetGapped } = await getVersionContent(persistence, docGuid, versionId, { withGap: true });
  console.log(`[Restore] Target version content size: ${content.length} bytes`);

  // Get current document state, WITH the gap indicator (a plain Y.Doc from a
  // mock/serving path unwraps to gapped=false).
  const currentRead = await persistence.getYDoc(docGuid, { withGap: true });
  const currentYdoc = currentRead instanceof Y.Doc ? currentRead : currentRead.ydoc;
  const currentGapped = currentRead instanceof Y.Doc ? false : !!currentRead.gapped;

  // F3 (FR-009, D-2): restore is the one stored-artifact path (the restore update
  // row + its agent_edits record). If EITHER read is still gapped after the shared
  // retry budget, refuse — the same fail-closed posture undo uses — rather than
  // persist content derived from a torn log. No row is stored, no record written.
  if (targetGapped || currentGapped) {
    console.warn(`[Restore] aborting restore of ${docGuid}: update log still gapped after retry budget`);
    throw new DocumentSyncingError('Restore aborted: the document is still syncing — retry in a moment.');
  }

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

  // Store as a single new update (the restore operation). Classified meaningful
  // by construction (feature 023 US4) — a restore always changes visible content.
  const newClock = await persistence.storeUpdate(docGuid, restoreUpdate, userId, agentName, null, null, { meaningful: true });
  console.log(`[Restore] Stored restore update with clock ${newClock}`);

  // Record the restore as an edit record so log-derived undo can invert it
  // (feature 023 FR-020, D-4) — but ONLY for an agent restore.
  //
  // A human web-UI restore (`agentName === null`) is deliberately NOT recorded.
  // The restore itself still lands in `yjs_updates` attributed to the human, so
  // history shows who did it and the restore is reverted the ordinary way, by
  // restoring again. It is simply not an undo target.
  //
  // Why not: the only edits recorded under the chat-assistant identity are chat
  // `modify` calls, which is exactly what the chat "Undo edit" button sits on.
  // Because the LIFO undo target and the card the button lives on are always
  // the same record, mislabelling is structurally impossible. Putting restores
  // into that same queue (feature 040, since cut) broke that invariant and
  // needed a guard apparatus to contain the divergence — for a capability with
  // no UI to invoke it, at the cost of attributing a human's restore to the
  // assistant. See specs/040-restore-undo-attribution/ (US1/US6 CUT).
  //
  // An MCP restore passes its own `agentName` and is recorded as that agent's
  // edit, undoable by that agent, exactly as it has been since 023.
  //
  // Non-fatal (modify parity, D6): a recording failure logs and the restore
  // still succeeds — undo simply finds nothing to invert. The user's content
  // change is never lost to a bookkeeping failure.
  if (agentName) {
    try {
      await editRecords.recordEdit(persistence, {
        docGuid,
        userId,
        agentName,
        clockStart: newClock,
        clockEnd: newClock,
        clocks: [newClock],
      });
    } catch (recordErr) {
      console.error(`[Restore] Failed to record edit for ${docGuid} (restore still succeeds):`, recordErr.message);
    }
  }

  // Broadcast the restore live on every instance without a silent skip
  // (feature 023 FR-023, D-5). ORIGIN_RESTORE makes the bindState persistence
  // listener skip re-storing (storeUpdate allocates a fresh clock per call and
  // never dedupes by content, so a parseable origin here would double-persist).
  applyLiveUpdate({ getSharedDoc, redisPubSub }, docGuid, restoreUpdate, ORIGIN_RESTORE, 'Restore');

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

  // Map to response format and reverse to show most recent first (newest first).
  // subVersions is ASCENDING (oldest first); the .reverse() happens after this
  // map. A sub-version's diff baseline is the END of the PREVIOUS (older)
  // sub-version — subVersions[i - 1].clockEnd — and the oldest sub-version
  // (i === 0) diffs against the clock just before the range (clockStart - 1).
  const allSubversions = subVersions.map((sv, i) => ({
    id: String(sv.clockEnd),
    clockStart: sv.clockStart,
    clockEnd: sv.clockEnd,
    previousClock: i === 0
      ? (clockStart > 0 ? clockStart - 1 : -1)
      : subVersions[i - 1].clockEnd,
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
  // Range-check FIRST (same contract as getVersionContent): getYDocAtClock is a
  // clock <= N read, so an out-of-range clock silently returns current content
  // (clock > max) or an empty doc (clock < min) mislabeled as that clock. Reject
  // so the route can 404 instead of serving a mislabeled snapshot.
  const allUpdates = await persistence.getUpdatesWithUsers(docGuid);
  if (allUpdates.length === 0) {
    throw new VersionNotFoundError('Document has no version history');
  }
  const clocks = allUpdates.map(u => u.clock);
  const minClock = Math.min(...clocks);
  const maxClock = Math.max(...clocks);
  if (clock < minClock || clock > maxClock) {
    throw new VersionNotFoundError(`Version not found: clock ${clock} out of range ${minClock}-${maxClock}`);
  }

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
    // Feature 040 (FR-008): a row that genuinely EXISTS but yields no author
    // (its user was deleted) resolves to the synthetic unknown contributor
    // rather than a bare null. `null` here is reserved for "there is no row
    // at this clock at all", which is a different statement.
    author: update ? (createAuthor(update) || UNKNOWN_AUTHOR) : null,
  };
}

module.exports = {
  generateColorFromId,
  createAuthor,
  // Feature 040 (FR-008): the synthetic contributor for unattributed rows.
  UNKNOWN_AUTHOR,
  groupUpdatesIntoVersions,
  mergeNamedVersions,
  formatTimestamp,
  getVersionTimeline,
  getVersionContent,
  getUpdatesForVersion,
  getContentAtClock,
  getCurrentSessionAuthors,
  restoreVersion,
  VersionNotFoundError,
  DocumentSyncingError,
  DEFAULT_INACTIVITY_THRESHOLD,
  UPDATE_GROUPING_THRESHOLD,
};
