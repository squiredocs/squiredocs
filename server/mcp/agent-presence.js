/**
 * Agent Presence Manager
 *
 * Handles making AI agents visible in the UI by establishing WebSocket presence.
 * When an agent uses any MCP tool, they appear as an active user for a configurable duration.
 */
const WebSocket = require('ws');
const Y = require('yjs');
const { WebsocketProvider } = require('y-websocket');
const { ROLES } = require('../documents');

// Persistence provider - set by init function
let persistenceProvider = null;

// Track active presence sessions by sessionId
const activeSessions = new Map();

// Secondary index: sessionKey -> sessionId for O(1) lookup by user/doc
const sessionsByKey = new Map();

// Secondary index: userId -> Set<sessionId> for O(1) lookup by user
const sessionsByUserId = new Map();

// Track in-progress session creation promises to prevent race conditions
// Key: "${userId}-${docGuid}", Value: Promise
const pendingSessionCreations = new Map();

// Default presence duration (in seconds)
const DEFAULT_PRESENCE_DURATION = 60; // 1 minute

// Default temporary selection duration (in milliseconds)
const DEFAULT_SELECTION_DURATION_MS = 10000; // 10 seconds

// Maximum number of highlights to queue (uses reservoir sampling to prevent unbounded growth)
const MAX_HIGHLIGHT_QUEUE_SIZE = 50;

/**
 * Reservoir sampling to select k items from an array while preserving first and last
 * @param {Array} items - Full array of items
 * @param {number} k - Number of items to select
 * @returns {Array} Sampled array of k items (or fewer if items.length < k)
 */
function reservoirSample(items, k) {
  if (items.length <= k) {
    return items;
  }

  // Always keep first and last for proper visual feedback
  const first = items[0];
  const last = items[items.length - 1];
  const middle = items.slice(1, -1);
  const middleK = k - 2; // Reserve 2 slots for first and last

  if (middleK <= 0) {
    return [first, last];
  }

  // Reservoir sampling on middle items, tracking indices for sorted output
  const reservoirIndices = [];
  for (let i = 0; i < Math.min(middleK, middle.length); i++) {
    reservoirIndices.push(i);
  }
  for (let i = middleK; i < middle.length; i++) {
    const j = Math.floor(Math.random() * (i + 1));
    if (j < middleK) {
      reservoirIndices[j] = i;
    }
  }

  // Sort by index to maintain document order and extract items
  reservoirIndices.sort((a, b) => a - b);
  const sampledMiddle = reservoirIndices.map(idx => middle[idx]);

  return [first, ...sampledMiddle, last];
}

/**
 * Initialize the agent presence manager with a persistence provider
 * @param {PostgresPersistence} persistence - PostgreSQL persistence provider
 */
function init(persistence) {
  persistenceProvider = persistence;
}

/**
 * Verify user has access to a document and return user info
 * @private
 * @param {string} docGuid - Document UUID
 * @param {string} userId - User ID
 * @returns {Promise<{userName: string, email: string, picture: string}>}
 * @throws {Error} If document not found or user lacks access
 */
async function _verifyDocumentAccess(docGuid, userId) {
  const pool = persistenceProvider.getPool();
  const accessResult = await pool.query(
    `SELECT d.id, ds.role, u.name, u.email, u.picture
     FROM documents d
     JOIN document_shares ds ON d.id = ds.doc_id AND ds.user_id = $2
     JOIN users u ON u.id = $2
     WHERE d.id = $1`,
    [docGuid, userId]
  );

  if (accessResult.rows.length === 0) {
    throw new Error('Document not found or you do not have access');
  }

  const { role, name: userName, email, picture } = accessResult.rows[0];
  return { role, userName, email, picture };
}

/**
 * Build agent info object for awareness
 * @private
 * @param {object} agentToken - Agent token with agentName
 * @param {string} userName - User's display name
 * @param {string} email - User's email
 * @param {string} picture - User's picture URL
 * @param {string} userId - User ID for color generation
 * @returns {{name: string, email: string, picture: string, color: string, isAgent: boolean}}
 */
function _buildAgentInfo(agentToken, userName, email, picture, userId) {
  const agentName = agentToken.agentName || 'AI Agent';
  const agentColor = generateColorFromUserId(`${userId}-agent-${agentName}`);
  return {
    name: `${agentName} (${userName})`,
    email,
    picture,
    color: agentColor,
    isAgent: true,
  };
}

/**
 * Update session cursor and broadcast to awareness
 * @private
 * @param {object} session - Session object
 * @param {object} anchor - Anchor RelativePosition (JSON)
 * @param {object} head - Head RelativePosition (JSON)
 */
function _broadcastCursor(session, anchor, head) {
  session.cursor = { anchor, head };
  session.lastActivityAt = Date.now();
  if (session.provider && session.provider.awareness) {
    session.provider.awareness.setLocalStateField('cursor', { anchor, head });
  }
}

/**
 * Get or initialize the highlight queue for a session
 * @private
 * @param {object} session - Session object
 * @param {number} minIntervalMs - Minimum interval between highlights (ms)
 * @param {number} maxIntervalMs - Maximum interval between highlights (ms)
 * @returns {object} The highlight queue
 */
function _getOrInitHighlightQueue(session, minIntervalMs, maxIntervalMs) {
  if (!session.highlightQueue) {
    session.highlightQueue = {
      positions: [],
      currentIndex: 0,
      minIntervalMs,
      maxIntervalMs,
      timeoutId: null,
      isProcessing: false,
    };
  } else {
    // Update intervals if queue already exists
    session.highlightQueue.minIntervalMs = minIntervalMs;
    session.highlightQueue.maxIntervalMs = maxIntervalMs;
  }
  return session.highlightQueue;
}

/**
 * Set or extend session timeout
 * @private
 * @param {object} session - Session object
 * @param {number} duration - Duration in seconds
 */
function _setSessionTimeout(session, duration) {
  if (session.timeoutId) {
    clearTimeout(session.timeoutId);
  }
  session.timeoutId = setTimeout(() => {
    session.cleanup();
  }, duration * 1000);
}

/**
 * Wait for document content to arrive after y-websocket sync.
 *
 * y-websocket does NOT await bindState, so the first sync event may fire
 * before the server has finished loading content from PostgreSQL. This
 * function decides whether to wait (content still loading) or resolve
 * immediately (truly empty document) by checking the database.
 *
 * @private
 * @param {Y.Doc} ydoc - The Yjs document to watch for updates
 * @param {string} docGuid - Document UUID (for logging / DB lookup)
 * @returns {Promise<void>} Resolves when content has arrived or the document
 *   is confirmed empty.
 */
function _waitForDocumentContent(ydoc, docGuid) {
  return new Promise((resolve) => {
    let timeoutId = null;
    let settled = false;

    const onUpdate = () => {
      settle(`Content arrived for ${docGuid}`);
    };

    const settle = (reason) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutId);
      ydoc.off('update', onUpdate);
      console.log(`[agent-presence] ${reason}`);
      resolve();
    };

    // Listen for the first content update immediately (before async DB
    // check) so we don't miss updates that arrive while the query runs.
    ydoc.once('update', onUpdate);

    persistenceProvider.getUpdateCount(docGuid).then((updateCount) => {
      if (settled) return; // content arrived while we were checking

      if (updateCount === 0) {
        settle(`Document ${docGuid} confirmed empty (0 updates in DB)`);
      } else {
        // Content exists but hasn't arrived yet — wait for bindState to finish
        console.log(`[agent-presence] Document ${docGuid} has ${updateCount} updates in DB, waiting up to 10s...`);
        timeoutId = setTimeout(() => {
          settle(`Timeout waiting for ${updateCount} persisted updates to sync for ${docGuid}`);
        }, 10000);
      }
    }).catch((err) => {
      if (settled) return;
      console.warn(`[agent-presence] Could not check update count for ${docGuid}:`, err.message);
      // Fall back to original 2s timeout on DB error
      timeoutId = setTimeout(() => {
        settle(`Fallback timeout for ${docGuid} (DB check failed)`);
      }, 2000);
    });
  });
}

/**
 * Internal core function for creating/reusing WebSocket sessions
 * Handles race conditions, session reuse, and WebSocket setup
 * @private
 *
 * @param {string} docGuid - Document UUID
 * @param {object} agentToken - Decoded agent JWT token (must include rawToken)
 * @param {number} duration - Presence duration in seconds (already validated)
 * @param {string} userId - User ID
 * @param {string} sessionKey - Session key for tracking
 * @param {string} userName - User name for logging
 * @returns {Promise<object>} Session object with provider, awareness, sessionId, etc.
 */
async function _createSessionCore(docGuid, agentToken, duration, userId, sessionKey, userName) {
  // CRITICAL: Check if there's already a session creation in progress
  // This prevents race conditions when multiple tools are called concurrently
  if (pendingSessionCreations.has(sessionKey)) {
    console.log(`[agent-presence] Session creation already in progress for ${userName} in ${docGuid}, waiting...`);

    // Wait for the pending creation to complete - returns the session object directly
    const session = await pendingSessionCreations.get(sessionKey);

    if (session) {
      // Verify session is fully initialized before extending
      if (!session.provider || !session.cleanup) {
        throw new Error('Session creation in progress but not fully initialized');
      }

      _setSessionTimeout(session, duration);
      console.log(`[agent-presence] Extended presence (after waiting) for ${userName} in ${docGuid} for ${duration}s`);
      return session;
    }
  }

  // Check if we already have an active session for this user/doc combination
  // If so, extend it instead of creating a new one (O(1) lookup via secondary index)
  const existingSessionId = sessionsByKey.get(sessionKey);
  if (existingSessionId) {
    const session = activeSessions.get(existingSessionId);
    if (session && session.provider && session.provider.wsconnected && session.initialized) {
      _setSessionTimeout(session, duration);

      // Ensure cursor is broadcast to awareness (in case it was cleared)
      if (session.provider.awareness && session.cursor) {
        session.provider.awareness.setLocalStateField('cursor', session.cursor);
      }

      console.log(`[agent-presence] Reusing existing session for ${userName} in ${docGuid}`);
      return session;
    }
  }

  // No existing session, create a new one
  const accessToken = agentToken.rawToken;
  if (!accessToken) {
    throw new Error('No authentication token available for WebSocket connection');
  }

  // Get WebSocket URL from environment or construct it
  const wsProtocol = process.env.WS_PROTOCOL || 'ws';
  const wsHost = process.env.WS_HOST || 'localhost';
  const wsPort = process.env.WS_PORT || process.env.PORT || 3001;
  const wsUrl = `${wsProtocol}://${wsHost}:${wsPort}/s`;

  // Create a unique session ID
  const sessionId = `agent-presence-${userId}-${docGuid}-${Date.now()}`;

  // Create the promise and store it immediately to prevent race conditions
  const sessionPromise = new Promise((resolve, reject) => {
    let provider = null;
    let connectionTimeoutId = null;
    let setupComplete = false; // Track whether setup phase is complete

    // Cleanup function (idempotent - safe to call multiple times)
    const cleanup = (() => {
      let cleaned = false;
      return () => {
        if (cleaned) return;
        cleaned = true;

        // Get session to clean up UndoManager and awareness
        const session = activeSessions.get(sessionId);
        if (session) {
          // Destroy UndoManager
          if (session.undoManager) {
            session.undoManager.destroy();
            session.undoManager = null;
          }
          // Clear temporary selection timeout
          if (session.tempSelectionTimeoutId) {
            clearTimeout(session.tempSelectionTimeoutId);
            session.tempSelectionTimeoutId = null;
          }
          // Clear highlight queue timeout
          if (session.highlightQueue && session.highlightQueue.timeoutId) {
            clearTimeout(session.highlightQueue.timeoutId);
            session.highlightQueue = null;
          }
          // Clear awareness cursor
          if (session.provider && session.provider.awareness) {
            session.provider.awareness.setLocalStateField('cursor', null);
          }
        }

        if (connectionTimeoutId) {
          clearTimeout(connectionTimeoutId);
          connectionTimeoutId = null;
        }
        if (provider) {
          provider.destroy();
          provider = null;
        }
        activeSessions.delete(sessionId);
        sessionsByKey.delete(sessionKey);
        // Remove from userId index
        const userSessions = sessionsByUserId.get(userId);
        if (userSessions) {
          userSessions.delete(sessionId);
          if (userSessions.size === 0) {
            sessionsByUserId.delete(userId);
          }
        }
        pendingSessionCreations.delete(sessionKey);
        console.log(`[agent-presence] Cleaned up presence session ${sessionId}`);
      };
    })();

    try {
      // Create Yjs document
      const ydoc = new Y.Doc();

      // Create WebSocket provider
      provider = new WebsocketProvider(wsUrl, docGuid, ydoc, {
        connect: true,
        params: { token: accessToken },
        WebSocketPolyfill: WebSocket,
      });

      // Store session info in all indexes
      activeSessions.set(sessionId, {
        sessionId,
        docGuid,
        userId,
        key: sessionKey,
        provider,
        cleanup,
        timeoutId: null,
        createdAt: Date.now(),
        cursor: null,            // Will be initialized after connection (can be null for empty docs)
        initialized: false,      // Set to true after sync completes - used for session reuse check
        undoManager: null,       // Will be created after connection
        clipboard: null,         // Clipboard storage for copy/paste
        lastActivityAt: Date.now(),
      });
      sessionsByKey.set(sessionKey, sessionId);
      // Add to userId index
      if (!sessionsByUserId.has(userId)) {
        sessionsByUserId.set(userId, new Set());
      }
      sessionsByUserId.get(userId).add(sessionId);

      // Shared failure path: clean up resources, remove pending entry, reject
      const failSetup = (msg) => {
        cleanup();
        pendingSessionCreations.delete(sessionKey);
        reject(new Error(msg));
      };

      // Wait for document to sync before initializing cursor
      // IMPORTANT: y-websocket does NOT await bindState, so the first sync event
      // may fire before the server has finished loading from PostgreSQL.
      // If empty, wait for the first update event (which fires when bindState applies content).
      provider.on('sync', (isSynced) => {
        if (isSynced) {
          const xmlFragment = ydoc.get('default', Y.XmlFragment);

          if (xmlFragment.toArray().length > 0) {
            // Document has content - proceed immediately
            finalizeSession();
          } else {
            // Document appears empty — wait for content or confirm truly empty
            console.log(`[agent-presence] Document ${docGuid} appears empty, checking database...`);
            _waitForDocumentContent(ydoc, docGuid).then(finalizeSession);
          }

          function finalizeSession() {
            // Guard: if the provider was already destroyed by cleanup (e.g.,
            // connection error during the content wait), skip finalization.
            if (!provider) return;

            // Clear connection timeout since we connected successfully
            if (connectionTimeoutId) {
              clearTimeout(connectionTimeoutId);
              connectionTimeoutId = null;
            }

            try {
              const awareness = provider.awareness;
              const session = activeSessions.get(sessionId);
              if (session) {
                session.undoManager = new Y.UndoManager(xmlFragment, { captureTimeout: 500 });
                session.cursor = initializeCursorAtStart(xmlFragment);
                session.initialized = true;

                if (session.cursor) {
                  awareness.setLocalStateField('cursor', session.cursor);
                }
              }

              console.log(`[agent-presence] Created new session for ${userName} in ${docGuid}`);

              if (session) {
                _setSessionTimeout(session, duration);
              }

              pendingSessionCreations.delete(sessionKey);
              setupComplete = true; // Mark setup as complete before resolving

              resolve(session);
            } catch (error) {
              failSetup(`Failed to set presence: ${error.message}`);
            }
          }
        }
      });

      // Handle connection errors (only during setup phase)
      provider.on('connection-error', (error) => {
        if (setupComplete) return; // Ignore errors after setup - let y-websocket handle reconnection
        failSetup(`WebSocket connection failed: ${error.message}`);
      });

      // Handle connection close (only during setup phase)
      provider.on('connection-close', () => {
        if (setupComplete) return; // Ignore close after setup - let y-websocket handle reconnection
        failSetup('WebSocket connection closed unexpectedly');
      });

      // Set timeout for initial connection
      connectionTimeoutId = setTimeout(() => {
        if (setupComplete) return; // Setup already completed successfully
        if (!provider.wsconnected) {
          failSetup('Connection timeout: Could not establish WebSocket connection');
        }
      }, 10000); // 10 second timeout for connection
    } catch (error) {
      failSetup(`Failed to create agent presence: ${error.message}`);
    }
  });

  // Store the promise immediately to prevent concurrent creations
  pendingSessionCreations.set(sessionKey, sessionPromise);

  return sessionPromise;
}

// Kelly's 22 colors of maximum contrast (1965), minus white, black, and
// 3 colors too light for avatar borders. Every pair is visually distinct.
// Source: https://gist.github.com/ollieglass/f6ddd781eeae1d24e391265432297538
const PALETTE = [
  '#875692', // Strong Purple
  '#F38400', // Vivid Orange
  '#BE0032', // Vivid Red
  '#C2B280', // Grayish Yellow
  '#848482', // Medium Gray
  '#008856', // Vivid Green
  '#E68FAC', // Strong Purplish Pink
  '#0067A5', // Strong Blue
  '#F99379', // Strong Yellowish Pink
  '#604E97', // Strong Violet
  '#F6A600', // Vivid Orange Yellow
  '#B3446C', // Strong Purplish Red
  '#882D17', // Strong Reddish Brown
  '#8DB600', // Vivid Yellowish Green
  '#654522', // Deep Yellowish Brown
  '#E25822', // Vivid Reddish Orange
  '#2B3D26', // Dark Olive Green
];

/**
 * Generate a consistent color for a user ID
 * Returns hex format for compatibility with y-prosemirror cursor plugin
 * @param {string} userId - User ID
 * @returns {string} Hex color (e.g. #rrggbb)
 */
function generateColorFromUserId(userId) {
  // Include today's date so each agent gets a fresh color daily
  const key = userId + new Date().toISOString().slice(0, 10);
  let hash = 0;
  for (let i = 0; i < key.length; i++) {
    hash = key.charCodeAt(i) + ((hash << 5) - hash);
  }
  return PALETTE[Math.abs(hash) % PALETTE.length];
}

/**
 * Clear a specific agent presence session
 * @param {string} sessionId - Session ID to clear
 * @returns {boolean} True if session was found and cleared
 */
function clearSession(sessionId) {
  const session = activeSessions.get(sessionId);
  if (session) {
    session.cleanup();
    return true;
  }
  return false;
}

/**
 * Clear all active presence sessions for a user (O(k) where k = user's sessions)
 * @param {string} userId - User ID
 * @returns {number} Number of sessions cleared
 */
function clearUserSessions(userId) {
  const userSessionIds = sessionsByUserId.get(userId);
  if (!userSessionIds || userSessionIds.size === 0) {
    return 0;
  }

  let count = 0;
  // Copy to array since cleanup() modifies sessionsByUserId
  for (const sessionId of [...userSessionIds]) {
    const session = activeSessions.get(sessionId);
    if (session) {
      session.cleanup();
      count++;
    }
  }
  return count;
}

/**
 * Get or create a presence session for an agent
 * Returns the provider and awareness object so the caller can add additional awareness fields
 *
 * @param {string} docGuid - Document UUID
 * @param {object} agentToken - Decoded agent JWT token (must include rawToken)
 * @param {number} [durationSeconds=60] - How long to maintain presence (1-300 seconds)
 * @returns {Promise<object>} { provider, awareness, sessionId, agentInfo, expiresIn }
 */
async function getOrCreateSession(docGuid, agentToken, durationSeconds = DEFAULT_PRESENCE_DURATION, options = {}) {
  if (!persistenceProvider) {
    throw new Error('Agent presence manager not initialized');
  }

  const duration = Math.max(1, Math.min(300, durationSeconds));
  const userId = agentToken.userId;
  const agentId = agentToken.agentId || 'default';
  const sessionKey = `${userId}-${agentId}-${docGuid}`;

  const { role, userName, email, picture } = await _verifyDocumentAccess(docGuid, userId);

  // Check role if a minimum role is required
  if (options.requiredRole) {
    if ((ROLES[role] || 0) < (ROLES[options.requiredRole] || 0)) {
      throw new Error(`Requires ${options.requiredRole} role, you have ${role}`);
    }
  }
  const agentInfo = _buildAgentInfo(agentToken, userName, email, picture, userId);

  const session = await _createSessionCore(docGuid, agentToken, duration, userId, sessionKey, userName);

  // Store agentInfo on session for later access
  session.agentInfo = agentInfo;

  if (session.provider && session.provider.awareness) {
    session.provider.awareness.setLocalStateField('user', agentInfo);
  }

  return session;
}

/**
 * Get active sessions (for testing/debugging)
 * @returns {Map} Active sessions
 */
function getActiveSessions() {
  return activeSessions;
}

/**
 * Initialize cursor at the start of a document
 * @param {Y.XmlFragment} xmlFragment - The document fragment
 * @returns {object|null} Cursor state with anchor and head, or null if document is empty
 */
function initializeCursorAtStart(xmlFragment) {
  try {
    // Check if document has any blocks
    const blocks = xmlFragment.toArray();
    if (blocks.length === 0) {
      // Empty document - return null cursor (will be set when content is added)
      return null;
    }

    // Find first text node in the document
    function findFirstTextNode(node) {
      if (node instanceof Y.XmlText) {
        return node;
      } else if (node instanceof Y.XmlElement) {
        const children = node.toArray();
        for (const child of children) {
          const textNode = findFirstTextNode(child);
          if (textNode) return textNode;
        }
      }
      return null;
    }

    const textNode = findFirstTextNode(blocks[0]);

    if (!textNode) {
      // First block has no text nodes - return null cursor
      // (don't modify the document during cursor initialization)
      return null;
    }

    // Create RelativePosition at position 0
    const relPos = Y.createRelativePositionFromTypeIndex(textNode, 0);
    const posJson = Y.relativePositionToJSON(relPos);

    return {
      anchor: posJson,
      head: posJson,  // Collapsed cursor
    };
  } catch (error) {
    console.error('[agent-presence] Error initializing cursor:', error);
    return null;
  }
}

/**
 * Update session cursor position and broadcast to awareness
 * @param {string} sessionId - Session ID
 * @param {object} anchor - Anchor RelativePosition (JSON)
 * @param {object} head - Head RelativePosition (JSON)
 */
function updateSessionCursor(sessionId, anchor, head) {
  const session = activeSessions.get(sessionId);
  if (!session) {
    return false;
  }

  _broadcastCursor(session, anchor, head);
  return true;
}

/**
 * Clear any pending highlights in the queue
 * Used to cancel queued highlights when new mutations should take priority
 * @param {string} sessionId - Session ID
 * @returns {number} Number of pending highlights that were cleared (0 if none or session not found)
 */
function clearHighlightQueue(sessionId) {
  const session = activeSessions.get(sessionId);
  if (!session || !session.highlightQueue) {
    return 0;
  }

  const queue = session.highlightQueue;
  const pendingCount = queue.positions.length - queue.currentIndex;

  // Cancel any pending timeout
  if (queue.timeoutId) {
    clearTimeout(queue.timeoutId);
  }

  session.highlightQueue = null;
  return pendingCount;
}

/**
 * Queue a sequence of highlights to show XPath query results
 * Each highlight is shown with a random delay before moving to the next.
 * Uses reservoir sampling to limit queue size while maintaining document order coverage.
 * @param {string} sessionId - Session ID
 * @param {Array<{anchor: object, head: object}>} positions - Array of cursor positions to highlight
 * @param {number} [minIntervalMs=80] - Minimum interval between highlights (ms)
 * @param {number} [maxIntervalMs=240] - Maximum interval between highlights (ms)
 * @returns {boolean} True if queue was started
 */
function queueHighlightSequence(sessionId, positions, minIntervalMs = 80, maxIntervalMs = 240) {
  const session = activeSessions.get(sessionId);
  if (!session || !positions || positions.length === 0) {
    return false;
  }

  // Apply reservoir sampling if too many positions
  const sampledPositions = reservoirSample(positions, MAX_HIGHLIGHT_QUEUE_SIZE);

  const queue = _getOrInitHighlightQueue(session, minIntervalMs, maxIntervalMs);
  queue.positions.push(...sampledPositions);

  // Start processing if not already running
  if (!queue.isProcessing) {
    processHighlightQueue(sessionId);
  }

  return true;
}

/**
 * Process the highlight queue - shows highlights with random delays
 * @private
 * @param {string} sessionId - Session ID
 */
function processHighlightQueue(sessionId) {
  const session = activeSessions.get(sessionId);
  if (!session || !session.highlightQueue) {
    return;
  }

  const queue = session.highlightQueue;
  queue.isProcessing = true;

  const showNextHighlight = () => {
    if (!session.highlightQueue || queue.currentIndex >= queue.positions.length) {
      // Queue exhausted - clean up
      if (session.highlightQueue) {
        session.highlightQueue = null;
      }
      return;
    }

    const pos = queue.positions[queue.currentIndex];
    const isLastHighlight = queue.currentIndex === queue.positions.length - 1;
    queue.currentIndex++;

    if (isLastHighlight) {
      // Final highlight - use setTemporarySelection for consistent timeout behavior
      // This will show the selection, then collapse to cursor at end after DEFAULT_SELECTION_DURATION_MS
      session.highlightQueue = null;
      setTemporarySelection(sessionId, pos.anchor, pos.head);
    } else {
      // Intermediate highlight - update cursor directly
      _broadcastCursor(session, pos.anchor, pos.head);

      // Schedule next highlight with random delay
      const randomDelay = queue.minIntervalMs + Math.random() * (queue.maxIntervalMs - queue.minIntervalMs);
      queue.timeoutId = setTimeout(showNextHighlight, randomDelay);
    }
  };

  // Start the sequence
  showNextHighlight();
}

/**
 * Set the agent's cursor/selection position temporarily.
 * Used to highlight content the agent is reading or modifying.
 * The selection auto-clears after the specified duration.
 * @param {string} sessionId - Session ID
 * @param {object} anchor - Anchor RelativePosition (JSON)
 * @param {object} head - Head RelativePosition (JSON)
 * @param {number} [durationMs] - How long to show selection before collapsing (ms), defaults to DEFAULT_SELECTION_DURATION_MS
 * @returns {boolean} True if selection was set
 */
function setTemporarySelection(sessionId, anchor, head, durationMs = DEFAULT_SELECTION_DURATION_MS) {
  const session = activeSessions.get(sessionId);
  if (!session) {
    return false;
  }

  // Clear any existing temporary selection timeout
  if (session.tempSelectionTimeoutId) {
    clearTimeout(session.tempSelectionTimeoutId);
    session.tempSelectionTimeoutId = null;
  }

  _broadcastCursor(session, anchor, head);

  // Set timeout to collapse the selection to a cursor at the end position
  session.tempSelectionTimeoutId = setTimeout(() => {
    session.tempSelectionTimeoutId = null;
    _broadcastCursor(session, head, head);
  }, durationMs);

  return true;
}

/**
 * Get a session by ID
 * @param {string} sessionId - Session ID
 * @returns {object|null} Session object or null if not found
 */
function getSession(sessionId) {
  return activeSessions.get(sessionId) || null;
}

module.exports = {
  init,
  getOrCreateSession,
  clearSession,
  clearUserSessions,
  getActiveSessions,
  updateSessionCursor,
  setTemporarySelection,
  clearHighlightQueue,
  queueHighlightSequence,
  getSession,
  // Internal indexes exposed for testing only
  _sessionsByKey: sessionsByKey,
  _sessionsByUserId: sessionsByUserId,
};
