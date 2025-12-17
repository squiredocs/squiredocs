/**
 * set_agent_selection MCP Tool
 *
 * Allows AI agents to set a text selection in a document that is visible to all users.
 * The selection is displayed with the agent's color and name, just like human user selections.
 */
const WebSocket = require('ws');
const Y = require('yjs');
const { WebsocketProvider } = require('y-websocket');
const { verifyAgentToken } = require('../auth/jwt');

// Persistence provider - set by init function
let persistenceProvider = null;

// Track active agent selection sessions
const activeSessions = new Map();

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
const name = 'set_agent_selection';

const description = `Set a text selection in a document that is visible to all users.

This tool allows the AI agent to highlight a specific range of text in the document,
making it visible to all connected users in real-time, just like when a human user
selects text. The selection appears with the agent's name (e.g. "Claude (AI Agent)")
and a unique color.

USE CASES:
- Draw attention to specific parts of the document during analysis
- Highlight text being analyzed or referenced in explanations
- Show which section is being edited or reviewed
- Indicate focus areas during collaborative work
- Visual feedback during document processing

PARAMETERS:
- docGuid: The document UUID (get from list_documents)
- anchor: Start position of the selection (Yjs relative position object)
- head: End position of the selection (Yjs relative position object)
- durationSeconds: (Optional) How long to keep the selection visible (1-300 seconds, default: 60)

POSITION FORMAT:
Positions must be Yjs relative position objects. These are JSON objects that
represent stable positions in the document that remain valid even as other users
edit the document.

DO NOT try to create relative position objects manually. Instead, use the
create_selection_position helper tool which handles this for you.

COMPLETE WORKFLOW:
Step 1: Understand the document structure
  get_document({ docGuid: "abc-123", format: "structured" })
  This shows you elements and their indices

Step 2: Create anchor position (start of selection)
  create_selection_position({
    docGuid: "abc-123",
    elementIndex: 0,
    textOffset: 0
  })
  Save the returned "position" object

Step 3: Create head position (end of selection)
  create_selection_position({
    docGuid: "abc-123",
    elementIndex: 2,
    textOffset: 100
  })
  Save the returned "position" object

Step 4: Set the selection
  set_agent_selection({
    docGuid: "abc-123",
    anchor: anchorPositionFromStep2.position,
    head: headPositionFromStep3.position,
    durationSeconds: 60
  })

EXAMPLE - Highlighting the first two paragraphs:
// Step 1: Get document structure
const doc = get_document({ docGuid: "abc-123", format: "structured" });
// Shows: [{ type: "paragraph", content: "First..." }, { type: "paragraph", content: "Second..." }]

// Step 2: Create anchor at start of element 0
const anchor = create_selection_position({ docGuid: "abc-123", elementIndex: 0 });

// Step 3: Create head at end of element 1
const head = create_selection_position({ docGuid: "abc-123", elementIndex: 1 });

// Step 4: Set selection
set_agent_selection({
  docGuid: "abc-123",
  anchor: anchor.position,
  head: head.position,
  durationSeconds: 45
});

RETURNS:
- success: true if selection was set
- message: Confirmation message
- sessionId: Unique ID for this selection session
- expiresIn: Seconds until selection disappears
- selection: The anchor and head positions used
- agent: Object with name and color of the agent

IMPORTANT NOTES:
- The selection is visible to ALL users viewing the document
- Selections automatically disappear after the specified duration
- Multiple agents can have selections active simultaneously
- If the WebSocket connection drops, the selection will disappear
- Requires at least viewer access to the document
- The agent's name will be shown as "Your Name (AI Agent)"

VISIBILITY:
When you set a selection, users will see:
- Highlighted text in the document with the agent's color
- A cursor/label showing the agent's name
- The selection updates in real-time for all connected users`;

const inputSchema = {
  type: 'object',
  properties: {
    docGuid: {
      type: 'string',
      format: 'uuid',
      description: 'The document UUID',
    },
    anchor: {
      type: 'object',
      description: 'Anchor position as a Yjs relative position JSON object',
    },
    head: {
      type: 'object',
      description: 'Head position as a Yjs relative position JSON object',
    },
    durationSeconds: {
      type: 'integer',
      minimum: 1,
      maximum: 300,
      description: 'How long to keep the selection visible (1-300 seconds, default: 60)',
    },
  },
  required: ['docGuid', 'anchor', 'head'],
};

/**
 * Handler function for the tool
 * @param {object} args - Tool arguments
 * @param {string} args.docGuid - Document UUID
 * @param {object} args.anchor - Anchor position (Yjs relative position object)
 * @param {object} args.head - Head position (Yjs relative position object)
 * @param {number} [args.durationSeconds=60] - Duration to keep selection visible
 * @param {object} agentToken - Decoded agent JWT token
 * @returns {Promise<object>} { success, message, sessionId, expiresIn }
 */
async function handler(args, agentToken) {
  if (!persistenceProvider) throw new Error('set_agent_selection tool not initialized');

  const { docGuid, anchor, head, durationSeconds = 60 } = args;
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
  // The agentToken parameter is already validated by MCP middleware
  const accessToken = agentToken.rawToken;

  if (!accessToken) {
    throw new Error('No authentication token available for WebSocket connection');
  }

  return new Promise((resolve, reject) => {
    const sessionId = `agent-selection-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
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
    };

    try {
      // Create Yjs document
      const ydoc = new Y.Doc();

      // Create WebSocket provider
      provider = new WebsocketProvider(
        wsUrl,
        docGuid,
        ydoc,
        {
          connect: true,
          params: { token: accessToken },
          WebSocketPolyfill: WebSocket,
        }
      );

      // Store session info
      activeSessions.set(sessionId, {
        docGuid,
        userId,
        provider,
        cleanup,
        createdAt: Date.now(),
      });

      // Wait for connection to establish
      provider.on('status', ({ status }) => {
        if (status === 'connected') {
          try {
            // Get awareness
            const awareness = provider.awareness;

            // Set user info
            awareness.setLocalStateField('user', {
              name: `${userName} (AI Agent)`,
              email,
              picture,
              color: agentColor,
            });

            // Set cursor/selection with the provided relative positions
            console.log('[set-agent-selection] Setting cursor field:', JSON.stringify({ anchor, head }, null, 2));
            awareness.setLocalStateField('cursor', {
              anchor,
              head,
            });

            // Log the full awareness state after setting
            console.log('[set-agent-selection] Full local awareness state:', JSON.stringify(awareness.getLocalState(), null, 2));

            // Set timeout to close connection after duration
            timeoutId = setTimeout(() => {
              cleanup();
            }, durationSeconds * 1000);

            resolve({
              success: true,
              message: `Agent selection set`,
              sessionId,
              expiresIn: durationSeconds,
              selection: { anchor, head },
              agent: {
                name: userName,
                color: agentColor,
              },
            });
          } catch (error) {
            cleanup();
            reject(new Error(`Failed to set selection: ${error.message}`));
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
      reject(new Error(`Failed to create agent selection: ${error.message}`));
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
 * Generate a WebSocket token from agent token
 * @param {object} agentToken - Decoded agent JWT token
 * @returns {string} Token for WebSocket connection
 */
function generateWebSocketToken(agentToken) {
  // The agent token already contains the necessary auth info
  // We can reuse it for WebSocket connection
  const jwt = require('jsonwebtoken');
  const secret = process.env.MCP_JWT_SECRET;

  if (!secret) {
    throw new Error('MCP_JWT_SECRET not configured');
  }

  // Generate a short-lived token for WebSocket connection
  return jwt.sign(
    {
      userId: agentToken.userId,
      email: agentToken.email,
      type: 'agent-ws',
    },
    secret,
    { expiresIn: '5m' } // Short-lived for security
  );
}

/**
 * Clear a specific agent selection session
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
 * Clear all active agent selection sessions for a user
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
 * Get active sessions (for testing/debugging)
 * @returns {Map} Active sessions
 */
function getActiveSessions() {
  return activeSessions;
}

module.exports = {
  init,
  name,
  description,
  inputSchema,
  handler,
  clearSession,
  clearUserSessions,
  getActiveSessions,
};
