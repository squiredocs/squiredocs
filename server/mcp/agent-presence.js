/**
 * Agent Presence Manager
 *
 * Handles making AI agents visible in the UI by establishing WebSocket presence.
 * When an agent uses any MCP tool, they appear as an active user for a configurable duration.
 */
const WebSocket = require('ws');
const Y = require('yjs');
const { WebsocketProvider } = require('y-websocket');

// Persistence provider - set by init function
let persistenceProvider = null;

// Track active presence sessions
const activeSessions = new Map();

// Track in-progress session creation promises to prevent race conditions
// Key: "${userId}-${docGuid}", Value: Promise
const pendingSessionCreations = new Map();

// Default presence duration (in seconds)
const DEFAULT_PRESENCE_DURATION = 60; // 1 minute

/**
 * Initialize the agent presence manager with a persistence provider
 * @param {PostgresPersistence} persistence - PostgreSQL persistence provider
 */
function init(persistence) {
  persistenceProvider = persistence;
}

/**
 * Set agent presence in a document
 * Makes the agent visible as an active user in the UI for the specified duration
 *
 * @param {string} docGuid - Document UUID
 * @param {object} agentToken - Decoded agent JWT token (must include rawToken)
 * @param {number} [durationSeconds=60] - How long to maintain presence (1-300 seconds)
 * @returns {Promise<object>} { success, sessionId, expiresIn }
 */
async function setAgentPresence(docGuid, agentToken, durationSeconds = DEFAULT_PRESENCE_DURATION) {
  if (!persistenceProvider) {
    throw new Error('Agent presence manager not initialized');
  }

  // Validate duration
  const duration = Math.max(1, Math.min(300, durationSeconds));
  const userId = agentToken.userId;
  const pool = persistenceProvider.getPool();

  // Check if user has access to the document
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

  const { name: userName, email, picture } = accessResult.rows[0];

  // Generate a color for this agent (based on user ID for consistency)
  const agentColor = generateColorFromUserId(userId);

  // Get WebSocket URL from environment or construct it
  const wsProtocol = process.env.WS_PROTOCOL || 'ws';
  const wsHost = process.env.WS_HOST || 'localhost';
  const wsPort = process.env.WS_PORT || process.env.PORT || 3001;
  const wsUrl = `${wsProtocol}://${wsHost}:${wsPort}/s`;

  // Use the raw JWT token from the agentToken for WebSocket authentication
  const accessToken = agentToken.rawToken;

  if (!accessToken) {
    throw new Error('No authentication token available for WebSocket connection');
  }

  const sessionKey = `${userId}-${docGuid}`;

  // CRITICAL: Check if there's already a session creation in progress
  // This prevents race conditions when multiple tools are called concurrently
  if (pendingSessionCreations.has(sessionKey)) {
    console.log(`[agent-presence] Session creation already in progress for ${userName} in ${docGuid}, waiting...`);

    // Wait for the pending creation to complete
    const pendingResult = await pendingSessionCreations.get(sessionKey);

    // Now extend the newly created session
    const session = activeSessions.get(pendingResult.sessionId);
    if (session) {
      if (session.timeoutId) {
        clearTimeout(session.timeoutId);
      }
      session.timeoutId = setTimeout(() => {
        session.cleanup();
      }, duration * 1000);

      console.log(`[agent-presence] Extended presence (after waiting) for ${userName} in ${docGuid} for ${duration}s`);
      return {
        success: true,
        sessionId: pendingResult.sessionId,
        expiresIn: duration,
        extended: true,
        waitedForCreation: true,
      };
    }
  }

  // Check if we already have an active session for this user/doc combination
  // If so, extend it instead of creating a new one
  for (const [sid, session] of activeSessions.entries()) {
    if (session.key === sessionKey) {
      // Extend the existing session
      if (session.timeoutId) {
        clearTimeout(session.timeoutId);
      }
      session.timeoutId = setTimeout(() => {
        session.cleanup();
      }, duration * 1000);

      console.log(`[agent-presence] Extended presence for ${userName} in ${docGuid} for ${duration}s`);
      return {
        success: true,
        sessionId: sid,
        expiresIn: duration,
        extended: true,
      };
    }
  }

  // Create a unique session ID
  const sessionId = `agent-presence-${userId}-${docGuid}-${Date.now()}`;

  // Create the promise and store it immediately to prevent race conditions
  const sessionPromise = new Promise((resolve, reject) => {
    let timeoutId = null;
    let provider = null;

    // Cleanup function
    const cleanup = () => {
      // Get session to clean up UndoManager and awareness
      const session = activeSessions.get(sessionId);
      if (session) {
        // Destroy UndoManager
        if (session.undoManager) {
          session.undoManager.destroy();
          session.undoManager = null;
        }
        // Clear awareness cursor
        if (session.provider && session.provider.awareness) {
          session.provider.awareness.setLocalStateField('cursor', null);
        }
      }

      if (timeoutId) {
        clearTimeout(timeoutId);
        timeoutId = null;
      }
      if (provider) {
        provider.destroy();
        provider = null;
      }
      activeSessions.delete(sessionId);
      // Clean up from pending creations map
      pendingSessionCreations.delete(sessionKey);
      console.log(`[agent-presence] Cleaned up presence session ${sessionId}`);
    };

    try {
      // Create Yjs document
      const ydoc = new Y.Doc();

      // Create WebSocket provider
      provider = new WebsocketProvider(wsUrl, docGuid, ydoc, {
        connect: true,
        params: { token: accessToken },
        WebSocketPolyfill: WebSocket,
      });

      // Store session info
      activeSessions.set(sessionId, {
        sessionId,
        docGuid,
        userId,
        key: sessionKey,
        provider,
        cleanup,
        timeoutId: null,
        createdAt: Date.now(),
        cursor: null,            // Will be initialized after connection
        undoManager: null,       // Will be created after connection
        clipboard: null,         // Clipboard storage for copy/paste
        lastActivityAt: Date.now(),
      });

      // Wait for document to sync before initializing cursor
      // The 'sync' event ensures document data is loaded, not just connected
      provider.on('sync', (isSynced) => {
        if (isSynced) {
          try {
            // Get awareness
            const awareness = provider.awareness;

            // Initialize cursor and UndoManager
            const xmlFragment = ydoc.get('default', Y.XmlFragment);
            const session = activeSessions.get(sessionId);
            if (session) {
              // Create UndoManager
              session.undoManager = new Y.UndoManager(xmlFragment, { captureTimeout: 500 });

              // Initialize cursor at document start
              session.cursor = initializeCursorAtStart(xmlFragment);
            }

            // Set user info to make agent visible
            // Format: "Agent Name (Human Name)", e.g., "Claude Desktop (Sam Goldstein)"
            const agentName = agentToken.agentName || 'AI Agent';
            awareness.setLocalStateField('user', {
              name: `${agentName} (${userName})`,
              email,
              picture,
              color: agentColor,
              isAgent: true,
            });

            console.log(
              `[agent-presence] Set presence for ${agentName} (${userName}) in ${docGuid} for ${duration}s`
            );

            // Set timeout to close connection after duration
            if (session) {
              session.timeoutId = setTimeout(() => {
                cleanup();
              }, duration * 1000);
            }

            // Clean up from pending creations since we're done
            pendingSessionCreations.delete(sessionKey);

            resolve({
              success: true,
              sessionId,
              expiresIn: duration,
              agent: {
                name: `${agentName} (${userName})`,
                color: agentColor,
              },
            });
          } catch (error) {
            cleanup();
            reject(new Error(`Failed to set presence: ${error.message}`));
          }
        }
      });

      // Handle connection errors
      provider.on('connection-error', (error) => {
        cleanup();
        reject(new Error(`WebSocket connection failed: ${error.message}`));
      });

      // Handle connection close
      provider.on('connection-close', () => {
        cleanup();
      });

      // Set timeout for initial connection
      setTimeout(() => {
        if (!activeSessions.has(sessionId) || provider.wsconnected === false) {
          cleanup();
          reject(new Error('Connection timeout: Could not establish WebSocket connection'));
        }
      }, 10000); // 10 second timeout for connection
    } catch (error) {
      cleanup();
      reject(new Error(`Failed to create agent presence: ${error.message}`));
    }
  });

  // Store the promise immediately to prevent concurrent creations
  pendingSessionCreations.set(sessionKey, sessionPromise);

  return sessionPromise;
}

/**
 * Convert HSL to RGB
 */
function hslToRgb(h, s, l) {
  s /= 100;
  l /= 100;
  const k = n => (n + h / 30) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = n =>
    l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
  return [
    Math.round(255 * f(0)),
    Math.round(255 * f(8)),
    Math.round(255 * f(4))
  ];
}

/**
 * Generate a consistent color for a user ID
 * Returns RGB format for compatibility with y-prosemirror cursor plugin
 * @param {string} userId - User ID
 * @returns {string} RGB color
 */
function generateColorFromUserId(userId) {
  // Generate a hash from the user ID
  let hash = 0;
  for (let i = 0; i < userId.length; i++) {
    hash = userId.charCodeAt(i) + ((hash << 5) - hash);
  }

  // Generate a color with good saturation and lightness for visibility
  const hue = Math.abs(hash) % 360;
  // Convert to RGB for y-prosemirror compatibility (it doesn't support HSL)
  const [r, g, b] = hslToRgb(hue, 70, 50);
  return `rgb(${r}, ${g}, ${b})`;
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
 * Clear all active presence sessions for a user
 * @param {string} userId - User ID
 * @returns {number} Number of sessions cleared
 */
function clearUserSessions(userId) {
  let count = 0;
  for (const [sessionId, session] of activeSessions.entries()) {
    if (session.userId === userId) {
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
async function getOrCreateSession(docGuid, agentToken, durationSeconds = DEFAULT_PRESENCE_DURATION) {
  if (!persistenceProvider) {
    throw new Error('Agent presence manager not initialized');
  }

  const duration = Math.max(1, Math.min(300, durationSeconds));
  const userId = agentToken.userId;
  const pool = persistenceProvider.getPool();

  // Check if user has access to the document
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

  const { name: userName, email, picture } = accessResult.rows[0];
  const agentColor = generateColorFromUserId(userId);
  const agentName = agentToken.agentName || 'AI Agent';

  const agentInfo = {
    name: `${agentName} (${userName})`,
    email,
    picture,
    color: agentColor,
    isAgent: true,
  };

  // Check if we already have an active session for this user/doc combination
  const existingSessionKey = `${userId}-${docGuid}`;
  for (const [sid, session] of activeSessions.entries()) {
    // Only reuse if the session is fully initialized (has cursor)
    if (session.key === existingSessionKey && session.provider && session.provider.wsconnected && session.cursor) {
      // Extend the existing session
      if (session.timeoutId) {
        clearTimeout(session.timeoutId);
      }
      session.timeoutId = setTimeout(() => {
        session.cleanup();
      }, duration * 1000);

      console.log(`[agent-presence] Reusing existing session for ${userName} in ${docGuid}`);

      // Return the session object
      return session;
    }
  }

  // No existing session, create a new one
  const accessToken = agentToken.rawToken;
  if (!accessToken) {
    throw new Error('No authentication token available for WebSocket connection');
  }

  const wsProtocol = process.env.WS_PROTOCOL || 'ws';
  const wsHost = process.env.WS_HOST || 'localhost';
  const wsPort = process.env.WS_PORT || process.env.PORT || 3001;
  const wsUrl = `${wsProtocol}://${wsHost}:${wsPort}/s`;

  const sessionId = `agent-presence-${userId}-${docGuid}-${Date.now()}`;

  return new Promise((resolve, reject) => {
    let timeoutId = null;
    let provider = null;

    // Cleanup function
    const cleanup = () => {
      // Get session to clean up UndoManager and awareness
      const session = activeSessions.get(sessionId);
      if (session) {
        // Destroy UndoManager
        if (session.undoManager) {
          session.undoManager.destroy();
          session.undoManager = null;
        }
        // Clear awareness cursor
        if (session.provider && session.provider.awareness) {
          session.provider.awareness.setLocalStateField('cursor', null);
        }
      }

      if (timeoutId) {
        clearTimeout(timeoutId);
        timeoutId = null;
      }
      if (provider) {
        provider.destroy();
        provider = null;
      }
      activeSessions.delete(sessionId);
      console.log(`[agent-presence] Cleaned up presence session ${sessionId}`);
    };

    try {
      // Create Yjs document
      const ydoc = new Y.Doc();

      // Create WebSocket provider
      provider = new WebsocketProvider(wsUrl, docGuid, ydoc, {
        connect: true,
        params: { token: accessToken },
        WebSocketPolyfill: WebSocket,
      });

      // Store session info
      activeSessions.set(sessionId, {
        sessionId,
        docGuid,
        userId,
        key: existingSessionKey,
        provider,
        cleanup,
        timeoutId: null,
        createdAt: Date.now(),
        cursor: null,            // Will be initialized after connection
        undoManager: null,       // Will be created after connection
        clipboard: null,         // Clipboard storage for copy/paste
        lastActivityAt: Date.now(),
      });

      // Wait for document to sync before initializing cursor
      // The 'sync' event ensures document data is loaded, not just connected
      provider.on('sync', (isSynced) => {
        if (isSynced) {
          try {
            const awareness = provider.awareness;

            // Initialize cursor and UndoManager
            const xmlFragment = ydoc.get('default', Y.XmlFragment);
            const session = activeSessions.get(sessionId);
            if (session) {
              // Create UndoManager
              session.undoManager = new Y.UndoManager(xmlFragment, { captureTimeout: 500 });

              // Initialize cursor at document start
              session.cursor = initializeCursorAtStart(xmlFragment);
            }

            // Set user info to make agent visible
            awareness.setLocalStateField('user', agentInfo);

            console.log(`[agent-presence] Created new session for ${agentInfo.name} in ${docGuid}`);

            // Set timeout to close connection after duration
            if (session) {
              session.timeoutId = setTimeout(() => {
                cleanup();
              }, duration * 1000);
            }

            // Return the session object
            resolve(session);
          } catch (error) {
            cleanup();
            reject(new Error(`Failed to set presence: ${error.message}`));
          }
        }
      });

      // Handle connection errors
      provider.on('connection-error', (error) => {
        cleanup();
        reject(new Error(`WebSocket connection failed: ${error.message}`));
      });

      // Handle connection close
      provider.on('connection-close', () => {
        cleanup();
      });

      // Set timeout for initial connection
      setTimeout(() => {
        if (!activeSessions.has(sessionId) || provider.wsconnected === false) {
          cleanup();
          reject(new Error('Connection timeout: Could not establish WebSocket connection'));
        }
      }, 10000);
    } catch (error) {
      cleanup();
      reject(new Error(`Failed to create agent presence: ${error.message}`));
    }
  });
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

    const firstTextNode = findFirstTextNode(blocks[0]);
    let textNode = firstTextNode;

    if (!textNode) {
      // First block has no text nodes - create one
      textNode = new Y.XmlText();
      blocks[0].insert(0, [textNode]);
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
    throw new Error(`Session not found: ${sessionId}`);
  }

  // Update session cursor state
  session.cursor = { anchor, head };
  session.lastActivityAt = Date.now();

  // Broadcast to awareness
  if (session.provider && session.provider.awareness) {
    session.provider.awareness.setLocalStateField('cursor', { anchor, head });
  }
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
  setAgentPresence,
  getOrCreateSession,
  clearSession,
  clearUserSessions,
  getActiveSessions,
  updateSessionCursor,
  getSession,
};
