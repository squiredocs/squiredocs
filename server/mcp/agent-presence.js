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

  // Create a unique session ID
  const sessionId = `agent-presence-${userId}-${docGuid}-${Date.now()}`;

  // Check if we already have an active session for this user/doc combination
  // If so, extend it instead of creating a new one
  const existingSessionKey = `${userId}-${docGuid}`;
  for (const [sid, session] of activeSessions.entries()) {
    if (session.key === existingSessionKey) {
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

  return new Promise((resolve, reject) => {
    let timeoutId = null;
    let provider = null;

    // Cleanup function
    const cleanup = () => {
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
        docGuid,
        userId,
        key: existingSessionKey,
        provider,
        cleanup,
        timeoutId: null,
        createdAt: Date.now(),
      });

      // Wait for connection to establish
      provider.on('status', ({ status }) => {
        if (status === 'connected') {
          try {
            // Get awareness
            const awareness = provider.awareness;

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
            const session = activeSessions.get(sessionId);
            if (session) {
              session.timeoutId = setTimeout(() => {
                cleanup();
              }, duration * 1000);
            }

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
}

/**
 * Generate a consistent color for a user ID
 * @param {string} userId - User ID
 * @returns {string} Hex color
 */
function generateColorFromUserId(userId) {
  // Generate a hash from the user ID
  let hash = 0;
  for (let i = 0; i < userId.length; i++) {
    hash = userId.charCodeAt(i) + ((hash << 5) - hash);
  }

  // Generate a color with good saturation and lightness for visibility
  const hue = Math.abs(hash) % 360;
  return `hsl(${hue}, 70%, 50%)`;
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
    if (session.key === existingSessionKey && session.provider && session.provider.wsconnected) {
      // Extend the existing session
      if (session.timeoutId) {
        clearTimeout(session.timeoutId);
      }
      session.timeoutId = setTimeout(() => {
        session.cleanup();
      }, duration * 1000);

      console.log(`[agent-presence] Reusing existing session for ${userName} in ${docGuid}`);

      return {
        provider: session.provider,
        awareness: session.provider.awareness,
        sessionId: sid,
        agentInfo,
        expiresIn: duration,
        reused: true,
      };
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
        docGuid,
        userId,
        key: existingSessionKey,
        provider,
        cleanup,
        timeoutId: null,
        createdAt: Date.now(),
      });

      // Wait for connection to establish
      provider.on('status', ({ status }) => {
        if (status === 'connected') {
          try {
            const awareness = provider.awareness;

            // Set user info to make agent visible
            awareness.setLocalStateField('user', agentInfo);

            console.log(`[agent-presence] Created new session for ${agentInfo.name} in ${docGuid}`);

            // Set timeout to close connection after duration
            const session = activeSessions.get(sessionId);
            if (session) {
              session.timeoutId = setTimeout(() => {
                cleanup();
              }, duration * 1000);
            }

            resolve({
              provider,
              awareness,
              sessionId,
              agentInfo,
              expiresIn: duration,
              reused: false,
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

module.exports = {
  init,
  setAgentPresence,
  getOrCreateSession,
  clearSession,
  clearUserSessions,
  getActiveSessions,
};
