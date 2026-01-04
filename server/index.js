// Load environment variables from .env file
require('dotenv').config();

const express = require('express');
const WebSocket = require('ws');
const { setupWSConnection, setPersistence, getYDoc } = require('y-websocket/bin/utils');
const path = require('path');
const fs = require('fs');
const cookieParser = require('cookie-parser');
const { PostgresPersistence } = require('./postgres-persistence');
const { redisPersistence } = require('./redis-persistence');
const redisPubSub = require('./redis-pubsub');
const Y = require('yjs');
const awarenessProtocol = require('y-protocols/dist/awareness.cjs');
const { router: authRouter, initUsers, requireAuth } = require('./auth');
const documents = require('./documents');
const permissions = require('./permissions');
const waitlist = require('./waitlist');
const versionHistory = require('./version-history');
const mcp = require('./mcp');
const documentService = require('./document-service');
const wsSimulator = require('./websocket-simulator');

// Profiling utilities
const PROFILING_ENABLED = true;
let messageCounter = 0;
const logPerf = (label, data = {}) => {
  if (!PROFILING_ENABLED) return;
  const timestamp = Date.now();
  console.log(`[PERF ${timestamp}] ${label}`, JSON.stringify(data));
};

const app = express();
const PORT = process.env.PORT || 3001;

// Trust proxy to get correct protocol (https) from X-Forwarded-Proto header
// This is needed when behind a reverse proxy/load balancer that terminates SSL
app.set('trust proxy', true);

// Client URL for CORS (configurable via env)
const CLIENT_URL = process.env.CLIENT_URL || 'http://localhost:5173';

// CORS configuration - allow credentials for cookies
app.use((req, res, next) => {
  const origin = req.headers.origin;
  // Allow requests from configured client URL
  if (origin === CLIENT_URL || process.env.NODE_ENV !== 'production') {
    res.setHeader('Access-Control-Allow-Origin', origin || CLIENT_URL);
  }
  res.setHeader('Access-Control-Allow-Credentials', 'true');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  
  // Handle preflight requests
  if (req.method === 'OPTIONS') {
    return res.sendStatus(200);
  }
  next();
});

// Parse JSON bodies
app.use(express.json());

// Parse form-encoded bodies (required for OAuth token requests)
app.use(express.urlencoded({ extended: true }));

// Parse cookies for refresh token
app.use(cookieParser());

// PostgreSQL connection configuration
// Supports connection string or individual config values
const POSTGRES_CONFIG = process.env.DATABASE_URL || {
  host: process.env.DB_HOST || 'localhost',
  port: process.env.DB_PORT || 5432,
  database: process.env.DB_NAME || 'collab_db',
  user: process.env.DB_USER || process.env.USER || 'postgres',
  password: process.env.DB_PASSWORD || ''
};

// Initialize PostgreSQL persistence
const persistenceProvider = new PostgresPersistence(POSTGRES_CONFIG);

// Helper to extract clean UUID from y-websocket doc name
// y-websocket extracts doc name from URL path like /s/uuid, giving us "s/uuid"
// We need to strip the "s/" prefix to get the clean UUID
const extractDocGuid = (docName) => {
  if (docName.startsWith('s/')) {
    return docName.slice(2);
  }
  return docName;
};

// Set up persistence layer for y-websocket
// y-websocket expects a persistence object with bindState and writeState methods
// bindState is async but not awaited by y-websocket - it applies persisted state when it completes
// Note: y-websocket calls it "docName" but we use it as a UUID (docGuid)
const ORIGIN_DB_LOAD = 'db-load'; // Origin marker for updates from loading persisted state
const ORIGIN_REDIS = 'redis'; // Origin marker for updates from Redis pub/sub (cross-instance sync)

// Track active users per document for version history attribution
// Maps docGuid -> Map<clientId, userId>
const documentUserMap = new Map();

// Track active agents per document for version history attribution
// Maps docGuid -> Map<clientId, agentName>
const documentAgentMap = new Map();

/**
 * Register a user connection for a document
 * @param {string} docGuid - Document GUID
 * @param {number} clientId - Client connection ID
 * @param {string} userId - User ID
 * @param {string|null} agentName - Agent name if this is an agent connection
 */
function registerDocumentUser(docGuid, clientId, userId, agentName = null) {
  if (!documentUserMap.has(docGuid)) {
    documentUserMap.set(docGuid, new Map());
  }
  documentUserMap.get(docGuid).set(clientId, userId);

  // Track agent name if this is an agent
  if (agentName) {
    if (!documentAgentMap.has(docGuid)) {
      documentAgentMap.set(docGuid, new Map());
    }
    documentAgentMap.get(docGuid).set(clientId, agentName);
  }
}

/**
 * Unregister a user connection from a document
 */
function unregisterDocumentUser(docGuid, clientId) {
  if (documentUserMap.has(docGuid)) {
    documentUserMap.get(docGuid).delete(clientId);
    if (documentUserMap.get(docGuid).size === 0) {
      documentUserMap.delete(docGuid);
    }
  }

  // Also clean up agent tracking
  if (documentAgentMap.has(docGuid)) {
    documentAgentMap.get(docGuid).delete(clientId);
    if (documentAgentMap.get(docGuid).size === 0) {
      documentAgentMap.delete(docGuid);
    }
  }
}

/**
 * Get any active user ID for a document (for attribution)
 * In concurrent editing scenarios, we pick one - this is a reasonable approximation
 */
function getDocumentUserId(docGuid) {
  const users = documentUserMap.get(docGuid);
  if (users && users.size > 0) {
    // Return the first user (most recently registered tends to be last)
    return Array.from(users.values())[0];
  }
  return null;
}

/**
 * Get any active agent name for a document (for attribution)
 */
function getDocumentAgentName(docGuid) {
  const agents = documentAgentMap.get(docGuid);
  if (agents && agents.size > 0) {
    // Return the first agent name
    return Array.from(agents.values())[0];
  }
  return null;
}

setPersistence({
  bindState: async (docName, ydoc) => {
    // docName from y-websocket includes the URL path prefix (e.g., "s/uuid")
    // Extract the clean UUID
    const docGuid = extractDocGuid(docName);
    const startTime = Date.now();
    const redisEnabled = redisPersistence.isEnabled();
    console.log(`[bindState] START for ${docGuid}, redisEnabled=${redisEnabled}`);

    // IMPORTANT: Set up update listener FIRST, before any async operations!
    // y-websocket does NOT await bindState, so client updates can arrive
    // while we're still loading from DB. We must capture ALL updates.
    ydoc.on('update', (update, origin) => {
      // Skip persisting updates that come from loading persisted state
      // (they're already in the DB, no need to save again)
      if (origin === ORIGIN_DB_LOAD) {
        return;
      }

      // Get the user ID for version history attribution
      // If origin is a string (userId passed from MCP tools), use it
      // Otherwise, get from active WebSocket connections
      const userId = (typeof origin === 'string') ? origin : getDocumentUserId(docGuid);

      // Get agent name if this update is from an agent
      const agentName = getDocumentAgentName(docGuid);

      const persistStart = Date.now();

      // Persist to PostgreSQL (source of truth)
      persistenceProvider.storeUpdate(docGuid, update, userId, agentName)
        .then(async () => {
          logPerf('DB_PERSIST', { docGuid, duration: Date.now() - persistStart, size: update.byteLength, userId, agentName });

          // Sync the title to the documents table for fast list queries
          // Extract current title from Yjs meta map
          const meta = ydoc.getMap('meta');
          const title = meta.get('title') || null;

          // Update documents table with current title (denormalized for performance)
          await persistenceProvider.updateDocumentTitle(docGuid, title).catch(err => {
            // Log but don't fail if title update fails
            console.warn(`Failed to sync title for ${docGuid}:`, err.message);
          });
        })
        .catch(err => {
          console.error(`Error persisting update for ${docGuid}:`, err);
        });

      // Update Redis cache with current document state (async, non-blocking)
      if (redisPersistence.isEnabled()) {
        redisPersistence.storeDoc(docGuid, ydoc).catch(err => {
          console.error(`Error caching doc to Redis ${docGuid}:`, err);
        });
      }
    });

    try {
      let persistedYdoc = null;

      // Try to load from Redis cache first (faster)
      if (redisEnabled) {
        console.log(`[bindState] Trying Redis for ${docGuid}`);
        const redisStart = Date.now();
        persistedYdoc = await redisPersistence.getDoc(docGuid);
        if (persistedYdoc) {
          console.log(`[bindState] Redis hit for ${docGuid} in ${Date.now() - redisStart}ms`);
          logPerf('REDIS_LOAD', { docGuid, duration: Date.now() - redisStart });
        } else {
          console.log(`[bindState] Redis miss for ${docGuid}`);
        }
      }

      // Fall back to PostgreSQL if not in Redis
      if (!persistedYdoc) {
        console.log(`[bindState] Loading from PostgreSQL for ${docGuid}`);
        const loadStart = Date.now();
        persistedYdoc = await persistenceProvider.getYDoc(docGuid);
        console.log(`[bindState] PostgreSQL loaded ${docGuid} in ${Date.now() - loadStart}ms`);
        logPerf('DB_LOAD', { docGuid, duration: Date.now() - loadStart });

        // Cache in Redis for next time
        if (redisEnabled) {
          redisPersistence.storeDoc(docGuid, persistedYdoc).catch(err => {
            console.error(`Error caching doc to Redis ${docGuid}:`, err);
          });
        }
      }

      // Apply persisted state to the in-memory document
      // Use ORIGIN_DB_LOAD so the update listener knows to skip persisting this
      console.log(`[bindState] Applying state for ${docGuid}`);
      Y.applyUpdate(ydoc, Y.encodeStateAsUpdate(persistedYdoc), ORIGIN_DB_LOAD);

      console.log(`[bindState] COMPLETE for ${docGuid} in ${Date.now() - startTime}ms`);
      logPerf('BIND_STATE_COMPLETE', { docGuid, totalDuration: Date.now() - startTime });
    } catch (error) {
      // If document doesn't exist in persistence, that's okay - start with empty doc
      // Update listener is already set up above
      console.log(`[bindState] NEW DOC for ${docGuid} in ${Date.now() - startTime}ms`);
      logPerf('BIND_STATE_NEW_DOC', { docGuid, totalDuration: Date.now() - startTime });
    }
  },
  // writeState intentionally omitted - we persist on every update via the listener above,
  // so no need to save again on disconnect. This also prevents false "updated" timestamps.
  writeState: async () => {},
  provider: persistenceProvider
});

// Initialize user authentication with shared database pool
initUsers(persistenceProvider.getPool());

// Initialize documents module with shared database pool
documents.init(persistenceProvider.getPool());

// Initialize waitlist module with shared database pool
waitlist.init(persistenceProvider.getPool());

// Initialize MCP module with persistence provider
mcp.init(persistenceProvider);

// Mount auth routes
app.use('/auth', authRouter);

// Mount waitlist routes
app.use('/api/waitlist', waitlist.router);

// OAuth 2.0 Authorization Server Metadata (RFC 8414)
// Required for MCP client discovery of OAuth capabilities
app.get('/.well-known/oauth-authorization-server', (req, res) => {
  console.log('[OAuth Discovery] Metadata requested from:', req.get('origin') || req.get('referer') || 'unknown');
  const host = req.get('host');
  // Force HTTPS for production domains
  const protocol = host.includes('herodocs.xyz') ? 'https' : req.protocol;
  const baseUrl = `${protocol}://${host}`;
  res.json({
    issuer: baseUrl,
    authorization_endpoint: `${baseUrl}/mcp/auth/authorize`,
    token_endpoint: `${baseUrl}/mcp/auth/token`,
    revocation_endpoint: `${baseUrl}/mcp/auth/revoke`,
    registration_endpoint: `${baseUrl}/mcp/auth/register`,
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    code_challenge_methods_supported: ['S256'],
    token_endpoint_auth_methods_supported: ['none'],
    scopes_supported: ['documents:read', 'documents:write'],
  });
});

// Mount MCP OAuth routes first (more specific path takes precedence)
app.use('/mcp/auth', mcp.oauthRouter);

// Mount MCP routes
app.use('/mcp', mcp.router);

// OAuth callback endpoint (displays authorization code)
app.get('/oauth-callback', (req, res) => {
  const { code, state, error, error_description } = req.query;

  if (error) {
    return res.send(`
      <!DOCTYPE html>
      <html>
        <head>
          <title>Authorization Failed</title>
          <style>
            body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; max-width: 600px; margin: 100px auto; padding: 20px; text-align: center; }
            .error { background: #ffebee; color: #c62828; padding: 20px; border-radius: 8px; }
          </style>
        </head>
        <body>
          <div class="error">
            <h2>❌ Authorization Failed</h2>
            <p>${error_description || error}</p>
          </div>
        </body>
      </html>
    `);
  }

  res.send(`
    <!DOCTYPE html>
    <html>
      <head>
        <title>Authorization Successful</title>
        <style>
          body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; max-width: 600px; margin: 100px auto; padding: 20px; }
          .success { background: #e8f5e9; color: #2e7d32; padding: 20px; border-radius: 8px; margin-bottom: 20px; text-align: center; }
          .code-box { background: #f5f5f5; padding: 20px; border-radius: 8px; }
          code { background: #fff; padding: 10px; display: block; margin: 10px 0; border: 1px solid #ddd; border-radius: 4px; word-break: break-all; }
          button { background: #667eea; color: white; border: none; padding: 10px 20px; border-radius: 6px; cursor: pointer; margin-top: 10px; }
          button:hover { background: #5568d3; }
        </style>
      </head>
      <body>
        <div class="success">
          <h2>✅ Authorization Successful!</h2>
          <p id="message">Sending code to parent window...</p>
        </div>
        <div class="code-box">
          <strong>Authorization Code:</strong>
          <code id="authCode">${code}</code>
          <button onclick="copyCode()">Copy Code</button>
        </div>
        <script>
          function copyCode() {
            const code = document.getElementById('authCode').textContent;
            navigator.clipboard.writeText(code).then(() => {
              alert('Code copied to clipboard!');
            });
          }

          // If opened in a popup, send the code to the parent window
          if (window.opener && !window.opener.closed) {
            try {
              window.opener.postMessage({
                type: 'oauth_callback',
                code: '${code}',
                state: '${state || ''}'
              }, window.location.origin);
              document.getElementById('message').textContent = 'Code sent! You can close this window.';

              // Auto-close after 2 seconds
              setTimeout(() => {
                window.close();
              }, 2000);
            } catch (err) {
              console.error('Failed to send message to parent:', err);
              document.getElementById('message').textContent = 'Copy the code below and paste it in the test page.';
            }
          } else {
            document.getElementById('message').textContent = 'Copy the authorization code below to exchange for tokens.';
          }
        </script>
      </body>
    </html>
  `);
});

// Serve static files from client build directory
const clientBuildPath = path.join(__dirname, '../client/dist');

// Health check endpoint
app.get('/health', (req, res) => {
  res.status(200).json({ status: 'ok' });
});

// API: List documents accessible by the current user
app.get('/api/docs', requireAuth, async (req, res) => {
  try {
    const userId = req.user.userId;

    // Get documents the user has access to with their role
    // The title is now included directly from the documents table (denormalized for performance)
    const accessibleDocs = await documents.getAccessibleDocuments(userId);

    // Transform to response format
    const docs = accessibleDocs.map((doc) => ({
      docGuid: doc.doc_id,
      title: doc.title || null,
      updatedAt: doc.updated_at || doc.created_at,
      role: doc.role,
      ownerName: doc.owner_name,
      ownerEmail: doc.owner_email,
      shareCount: parseInt(doc.share_count, 10) || 0,
    }));

    // Sort by updatedAt descending
    docs.sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt));

    res.json({ docs });
  } catch (error) {
    console.error('Error fetching documents:', error);
    const errorMessage = error.message || 'Failed to fetch documents';
    const hint = errorMessage.includes('doc_guid')
      ? ' (Have you run the migration? npm run migrate)'
      : '';
    res.status(500).json({ error: errorMessage + hint });
  }
});

// API: Create a new document (establishes ownership)
app.post('/api/docs', requireAuth, async (req, res) => {
  try {
    const { docId } = req.body;
    const userId = req.user.userId;
    
    if (!docId) {
      return res.status(400).json({ error: 'docId is required' });
    }
    
    // Validate UUID format
    const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    if (!uuidRegex.test(docId)) {
      return res.status(400).json({ error: 'Invalid docId format' });
    }
    
    // Check if document already exists
    const existingDoc = await documents.getDocument(docId);
    if (existingDoc) {
      // Document exists - check if user has access
      const hasAccess = await documents.hasAccess(docId, userId);
      if (!hasAccess) {
        return res.status(403).json({ error: 'Access denied' });
      }
      const role = await documents.getRole(docId, userId);
      return res.json({ doc: existingDoc, role, created: false });
    }
    
    // Create the document with this user as owner
    const doc = await documents.createDocument(docId, userId);
    res.status(201).json({ doc, role: 'owner', created: true });
  } catch (error) {
    console.error('Error creating document:', error);
    res.status(500).json({ error: 'Failed to create document' });
  }
});

// API: Get document info
app.get('/api/docs/:docId', requireAuth, async (req, res) => {
  try {
    const { docId } = req.params;
    const userId = req.user.userId;
    
    // Get user's role
    const role = await documents.getRole(docId, userId);
    if (!role) {
      return res.status(403).json({ error: 'Access denied' });
    }
    
    const doc = await documents.getDocument(docId);
    if (!doc) {
      return res.status(404).json({ error: 'Document not found' });
    }
    
    res.json({
      doc: {
        id: doc.id,
        createdAt: doc.created_at,
        updatedAt: doc.updated_at,
      },
      role,
    });
  } catch (error) {
    console.error('Error getting document:', error);
    res.status(500).json({ error: 'Failed to get document' });
  }
});

// API: Delete a document (owner only)
app.delete('/api/docs/:docId', requireAuth, async (req, res) => {
  try {
    const { docId } = req.params;
    const userId = req.user.userId;
    
    // Check delete permission (owner only)
    const canDelete = await permissions.can.delete(userId, docId);
    if (!canDelete.allowed) {
      return res.status(403).json({ error: canDelete.reason });
    }
    
    // Delete Yjs data
    await persistenceProvider.clearDocument(docId);
    
    // Delete document record and shares
    const deleted = await documents.deleteDocument(docId);
    if (!deleted) {
      return res.status(404).json({ error: 'Document not found' });
    }
    
    res.json({ success: true });
  } catch (error) {
    console.error('Error deleting document:', error);
    res.status(500).json({ error: 'Failed to delete document' });
  }
});

// API: Share document with a user by email
app.post('/api/docs/:docId/share', requireAuth, async (req, res) => {
  try {
    const { docId } = req.params;
    const { email, role = 'editor' } = req.body;
    const userId = req.user.userId;
    
    if (!email) {
      return res.status(400).json({ error: 'email is required' });
    }
    
    // Validate role
    if (!documents.ROLES[role] || role === 'owner') {
      return res.status(400).json({ error: 'Invalid role. Use "editor" or "viewer"' });
    }
    
    // Check if user has access to the document
    const userRole = await documents.getRole(docId, userId);
    if (!userRole) {
      return res.status(403).json({ error: 'You do not have access to this document' });
    }
    
    // Viewers can only add other viewers
    if (userRole === 'viewer' && role !== 'viewer') {
      return res.status(403).json({ error: 'Viewers can only share with viewer access' });
    }
    
    // Find the user to share with
    const targetUser = await documents.findUserByEmail(email);
    if (!targetUser) {
      return res.status(404).json({ error: 'User not found. They must sign in at least once.' });
    }
    
    // Can't share with yourself
    if (targetUser.id === userId) {
      return res.status(400).json({ error: 'Cannot share with yourself' });
    }
    
    // Can't change an owner's role
    const targetRole = await documents.getRole(docId, targetUser.id);
    if (targetRole === 'owner') {
      return res.status(400).json({ error: 'Cannot change owner\'s role' });
    }
    
    // Set the role
    const share = await documents.setRole(docId, targetUser.id, role);
    
    res.status(201).json({
      user: {
        id: targetUser.id,
        email: targetUser.email,
        name: targetUser.name,
        picture: targetUser.picture,
        role: share.role,
      },
    });
  } catch (error) {
    console.error('Error sharing document:', error);
    res.status(500).json({ error: 'Failed to share document' });
  }
});

// API: Update a user's role
app.put('/api/docs/:docId/share/:targetUserId', requireAuth, async (req, res) => {
  try {
    const { docId, targetUserId } = req.params;
    const { role } = req.body;
    const userId = req.user.userId;
    
    // Check manage permission (editors and owners can manage)
    const canManage = await permissions.can.manage(userId, docId);
    if (!canManage.allowed) {
      return res.status(403).json({ error: canManage.reason });
    }
    
    // Validate role
    if (!documents.ROLES[role] || role === 'owner') {
      return res.status(400).json({ error: 'Invalid role. Use "editor" or "viewer"' });
    }
    
    // Can't change your own role
    if (targetUserId === userId) {
      return res.status(400).json({ error: 'Cannot change your own role' });
    }
    
    // Can't change another owner's role
    const targetRole = await documents.getRole(docId, targetUserId);
    if (targetRole === 'owner') {
      return res.status(400).json({ error: 'Cannot change owner\'s role' });
    }
    
    const share = await documents.setRole(docId, targetUserId, role);
    res.json({ role: share.role });
  } catch (error) {
    console.error('Error updating role:', error);
    res.status(500).json({ error: 'Failed to update role' });
  }
});

// API: Remove a user's access
app.delete('/api/docs/:docId/share/:targetUserId', requireAuth, async (req, res) => {
  try {
    const { docId, targetUserId } = req.params;
    const userId = req.user.userId;
    
    // Check manage permission (editors and owners can manage)
    const canManage = await permissions.can.manage(userId, docId);
    if (!canManage.allowed) {
      return res.status(403).json({ error: canManage.reason });
    }
    
    // Can't remove yourself
    if (targetUserId === userId) {
      return res.status(400).json({ error: 'Cannot remove your own access' });
    }
    
    // Can't remove another owner
    const targetRole = await documents.getRole(docId, targetUserId);
    if (targetRole === 'owner') {
      return res.status(400).json({ error: 'Cannot remove owner' });
    }
    
    const removed = await documents.removeAccess(docId, targetUserId);
    if (!removed) {
      return res.status(404).json({ error: 'User not found' });
    }
    
    res.json({ success: true });
  } catch (error) {
    console.error('Error removing access:', error);
    res.status(500).json({ error: 'Failed to remove access' });
  }
});

// API: Get all users with access to a document
app.get('/api/docs/:docId/shares', requireAuth, async (req, res) => {
  try {
    const { docId } = req.params;
    const userId = req.user.userId;

    // Check if user has access
    const role = await documents.getRole(docId, userId);
    if (!role) {
      return res.status(403).json({ error: 'You do not have access to this document' });
    }

    const users = await documents.getDocumentUsers(docId);

    res.json({
      users,
      currentUserRole: role,
    });
  } catch (error) {
    console.error('Error getting shares:', error);
    res.status(500).json({ error: 'Failed to get shares' });
  }
});

// ==================== Version History API ====================

// API: Get version history timeline for a document
app.get('/api/docs/:docId/history', requireAuth, async (req, res) => {
  try {
    const { docId } = req.params;
    const userId = req.user.userId;

    // Check if user has at least view access
    const role = await documents.getRole(docId, userId);
    if (!role) {
      return res.status(403).json({ error: 'You do not have access to this document' });
    }

    const timeline = await versionHistory.getVersionTimeline(persistenceProvider, docId);
    res.json(timeline);
  } catch (error) {
    console.error('Error getting version history:', error);
    res.status(500).json({ error: 'Failed to get version history' });
  }
});

// API: Get document content at a specific version
app.get('/api/docs/:docId/versions/:versionId', requireAuth, async (req, res) => {
  try {
    const { docId, versionId } = req.params;
    const userId = req.user.userId;

    // Check if user has at least view access
    const role = await documents.getRole(docId, userId);
    if (!role) {
      return res.status(403).json({ error: 'You do not have access to this document' });
    }

    const versionData = await versionHistory.getVersionContent(persistenceProvider, docId, versionId);
    res.json(versionData);
  } catch (error) {
    console.error('Error getting version content:', error);
    if (error.message === 'Version not found' || error.message === 'Invalid version ID') {
      return res.status(404).json({ error: error.message });
    }
    res.status(500).json({ error: 'Failed to get version content' });
  }
});

// API: Restore document to a previous version (creates new version)
app.post('/api/docs/:docId/restore', requireAuth, async (req, res) => {
  try {
    const { docId } = req.params;
    const { versionId } = req.body;
    const userId = req.user.userId;

    if (!versionId) {
      return res.status(400).json({ error: 'versionId is required' });
    }

    // Check if user has edit access
    const role = await documents.getRole(docId, userId);
    if (!role || role === 'viewer') {
      return res.status(403).json({ error: 'You do not have permission to restore this document' });
    }

    // Get function to access shared document for broadcasting restore update
    const getSharedDocFn = (docGuid) => {
      try {
        return documentService.getSharedDoc(docGuid);
      } catch (error) {
        // Document service might not be initialized or document not loaded yet
        console.warn(`[Restore] Could not get shared document for ${docGuid}:`, error.message);
        return null;
      }
    };

    const result = await versionHistory.restoreVersion(persistenceProvider, docId, versionId, userId, getSharedDocFn);
    res.json(result);
  } catch (error) {
    console.error('Error restoring version:', error);
    if (error.message === 'Version not found' || error.message === 'Invalid version ID') {
      return res.status(404).json({ error: error.message });
    }
    res.status(500).json({ error: 'Failed to restore version' });
  }
});

// API: Create a named version
app.post('/api/docs/:docId/versions', requireAuth, async (req, res) => {
  try {
    const { docId } = req.params;
    const { name, clockEnd } = req.body;
    const userId = req.user.userId;

    // Check if user has at least view access (anyone can name a version)
    const role = await documents.getRole(docId, userId);
    if (!role) {
      return res.status(403).json({ error: 'You do not have access to this document' });
    }

    // Get updates to find the clock range
    const updates = await persistenceProvider.getUpdatesWithUsers(docId);
    if (updates.length === 0) {
      return res.status(400).json({ error: 'No updates found for this document' });
    }

    // If clockEnd is provided, use it; otherwise use current (latest) clock
    const targetClock = clockEnd || updates[updates.length - 1].clock;

    // Find the version boundaries using time-based grouping
    const versions = versionHistory.groupUpdatesIntoVersions(updates);
    const targetVersion = versions.find(v => v.clockEnd === targetClock);

    if (!targetVersion) {
      // If no exact match, use the provided clockEnd or latest
      const clockStart = updates[0].clock;
      const version = await persistenceProvider.createNamedVersion(
        docId,
        clockStart,
        targetClock,
        name,
        userId
      );
      return res.status(201).json({ version });
    }

    const version = await persistenceProvider.createNamedVersion(
      docId,
      targetVersion.clockStart,
      targetVersion.clockEnd,
      name,
      userId
    );

    res.status(201).json({ version });
  } catch (error) {
    console.error('Error creating named version:', error);
    res.status(500).json({ error: 'Failed to create named version' });
  }
});

// API: Rename a version
app.put('/api/docs/:docId/versions/:versionId', requireAuth, async (req, res) => {
  try {
    const { docId, versionId } = req.params;
    const { name } = req.body;
    const userId = req.user.userId;

    // Check if user has at least view access
    const role = await documents.getRole(docId, userId);
    if (!role) {
      return res.status(403).json({ error: 'You do not have access to this document' });
    }

    // Verify the version belongs to this document
    const existingVersion = await persistenceProvider.getVersionById(versionId);
    if (!existingVersion || existingVersion.doc_id !== docId) {
      return res.status(404).json({ error: 'Version not found' });
    }

    const version = await persistenceProvider.updateVersionName(versionId, name);
    res.json({ version });
  } catch (error) {
    console.error('Error renaming version:', error);
    res.status(500).json({ error: 'Failed to rename version' });
  }
});

// API: Delete a named version (returns to auto-grouping)
app.delete('/api/docs/:docId/versions/:versionId', requireAuth, async (req, res) => {
  try {
    const { docId, versionId } = req.params;
    const userId = req.user.userId;

    // Check if user has at least view access
    const role = await documents.getRole(docId, userId);
    if (!role) {
      return res.status(403).json({ error: 'You do not have access to this document' });
    }

    // Verify the version belongs to this document
    const existingVersion = await persistenceProvider.getVersionById(versionId);
    if (!existingVersion || existingVersion.doc_id !== docId) {
      return res.status(404).json({ error: 'Version not found' });
    }

    const deleted = await persistenceProvider.deleteNamedVersion(versionId);
    if (!deleted) {
      return res.status(404).json({ error: 'Version not found' });
    }

    res.json({ success: true });
  } catch (error) {
    console.error('Error deleting version:', error);
    res.status(500).json({ error: 'Failed to delete version' });
  }
});

// Serve static files and React app (only if build directory exists)
if (fs.existsSync(clientBuildPath)) {
  app.use(express.static(clientBuildPath));
  
  // Serve React app for all other routes
  app.get('*', (req, res) => {
    res.sendFile(path.join(clientBuildPath, 'index.html'));
  });
} else {
  // In development, serve a message if frontend isn't built
  app.get('*', (req, res) => {
    res.send(`
      <html>
        <body>
          <h1>Server is running</h1>
          <p>Please build the client first: <code>cd client && npm run build</code></p>
          <p>Or run in development mode: <code>npm run dev</code></p>
        </body>
      </html>
    `);
  });
}

// Create HTTP server
const server = app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
  console.log(`WebSocket server ready on ws://localhost:${PORT}/s`);

  // Log WebSocket simulator status
  wsSimulator.logStatus();

  // Initialize document service with y-websocket functions
  documentService.init(getYDoc, extractDocGuid);

  // Initialize Redis pub/sub for cross-instance synchronization
  redisPubSub.init().catch((err) => {
    console.error('[RedisPubSub] Failed to initialize:', err.message);
  });
});

// Create WebSocket server attached to HTTP server
// Using noServer mode to handle custom path matching
const wss = new WebSocket.Server({ 
  noServer: true
});

// Handle upgrade requests - mount WebSocket at /s/* to support document-specific paths
// y-websocket clients append document names: /s/default-doc, /s/my-doc, etc.
server.on('upgrade', async (request, socket, head) => {
  const url = new URL(request.url, `http://${request.headers.host}`);
  const pathname = url.pathname;
  
  // Only accept WebSocket connections that start with /s/
  if (!pathname.startsWith('/s/')) {
    socket.write('HTTP/1.1 400 Bad Request\r\n\r\n');
    socket.destroy();
    return;
  }

  // Extract document ID from path: /s/{docId}
  const docId = pathname.slice(3); // Remove '/s/'
  
  // Extract JWT from query string (client sends ?token=xxx)
  const token = url.searchParams.get('token');
  const user = permissions.extractUser({ queryToken: token });

  if (!user) {
    console.error('❌ WebSocket auth failed: no valid token for doc', docId);
    console.error('   → This usually means the user\'s session has expired');
    console.error('   → User should refresh the page to log in again');
    socket.write('HTTP/1.1 401 Unauthorized\r\nX-Auth-Error: Invalid or expired token\r\n\r\n');
    socket.destroy();
    return;
  }

  // Check if user has at least view access
  const viewPermission = await permissions.can.view(user.userId, docId);
  if (!viewPermission.allowed) {
    console.error(`❌ WebSocket access denied for user ${user.userId} to doc ${docId}: ${viewPermission.reason}`);
    console.error('   → User does not have permission to access this document');
    socket.write('HTTP/1.1 403 Forbidden\r\nX-Auth-Error: Access denied\r\n\r\n');
    socket.destroy();
    return;
  }

  // Store user info and role on the request for later use
  request.user = user;
  request.userRole = viewPermission.role;
  request.docId = docId;

  wss.handleUpgrade(request, socket, head, (ws) => {
    // Apply connection simulation if enabled
    const wrappedWs = wsSimulator.simulateFlakyConnection(ws);
    wss.emit('connection', wrappedWs, request);
  });
});

// y-websocket protocol constants
const MESSAGE_SYNC = 0;
const MESSAGE_AWARENESS = 1;
// Sync message sub-types
const SYNC_STEP1 = 0;  // Request state vector
const SYNC_STEP2 = 1;  // Send full state (response)
const SYNC_UPDATE = 2; // Send an update (edit)

/**
 * FIX FOR AWARENESS BUG: y-websocket has a bug where:
 * 1. Server sends User A's awareness to new User B connection
 * 2. User B's client re-broadcasts it back to server (y-websocket client does this)
 * 3. Server adds User A's clientID to User B's "controlled IDs"
 * 4. When User B disconnects, User A's awareness is incorrectly removed
 *
 * Solution: Track the TRUE owner of each clientID and don't let other connections
 * steal ownership via re-broadcast.
 */
// Maps docGuid -> Map<clientId, WebSocket (owner connection)>
const clientIdOwnerMap = new Map();

/**
 * Check if a WebSocket message is an edit operation
 * @param {Buffer} data - Raw message data
 * @returns {boolean} True if this is an edit operation
 */
function isEditMessage(data) {
  if (!data || data.length < 2) return false;
  const messageType = data[0];
  const syncType = data[1];
  // Edit = sync message with update type
  return messageType === MESSAGE_SYNC && syncType === SYNC_UPDATE;
}

// Handle WebSocket connections
wss.on('connection', (ws, req) => {
  const connId = ++messageCounter;
  const connStart = Date.now();
  const userRole = req.userRole;
  const userId = req.user?.userId;
  const docId = req.docId;
  const canEdit = documents.ROLES[userRole] >= documents.ROLES['editor'];

  // Sanitize URL to remove token from logs
  const sanitizedUrl = req.url?.split('?')[0] || req.url;

  logPerf('WS_CONNECT', { connId, url: sanitizedUrl, role: userRole, canEdit });
  console.log(`✓ WebSocket connection established: ${sanitizedUrl} (role: ${userRole})`);

  // Register user for version history attribution
  if (userId && docId) {
    registerDocumentUser(docId, connId, userId);
  }

  // Setup ping/pong keepalive mechanism
  let isAlive = true;
  ws.isAlive = true;

  ws.on('pong', () => {
    ws.isAlive = true;
    logPerf('WS_PONG', { connId });
  });

  // Send ping every 5 seconds (reduced from 30s to quickly detect stale connections)
  // This helps clean up awareness states from page refreshes faster
  const PING_INTERVAL = 5000; // 5 seconds
  const pingInterval = setInterval(() => {
    if (ws.isAlive === false) {
      console.log(`✗ WebSocket connection ${connId} appears dead, terminating`);
      logPerf('WS_TIMEOUT', { connId, duration: Date.now() - connStart });
      clearInterval(pingInterval);
      return ws.terminate();
    }

    ws.isAlive = false;
    ws.ping();
    logPerf('WS_PING', { connId });
  }, PING_INTERVAL);

  // Create a message filter for viewers
  // We intercept messages before y-websocket processes them
  if (!canEdit) {
    const originalEmit = ws.emit.bind(ws);
    ws.emit = (event, ...args) => {
      if (event === 'message') {
        const data = args[0];
        // Convert to Buffer if needed
        const buffer = Buffer.isBuffer(data) ? data : Buffer.from(data);
        if (isEditMessage(buffer)) {
          logPerf('WS_EDIT_BLOCKED', { connId, userId, docId, role: userRole });
          console.log(`✗ Edit blocked for viewer ${userId} on doc ${docId}`);
          return false; // Don't process this message
        }
      }
      return originalEmit(event, ...args);
    };
  }

  // Profile incoming messages
  ws.on('message', (data) => {
    logPerf('WS_MSG_IN', { connId, size: data.byteLength || data.length });
  });

  // Profile outgoing messages
  const originalSend = ws.send.bind(ws);
  ws.send = (data, cb) => {
    logPerf('WS_MSG_OUT', { connId, size: data.byteLength || data.length });
    return originalSend(data, cb);
  };

  ws.on('error', (error) => {
    logPerf('WS_ERROR', { connId, error: error.message });
    console.error('✗ WebSocket client error:', error.message);
  });

  ws.on('close', () => {
    // Clear ping interval
    clearInterval(pingInterval);
    // Unregister user for version history attribution
    if (docId) {
      unregisterDocumentUser(docId, connId);
    }
    logPerf('WS_CLOSE', { connId, duration: Date.now() - connStart });
    console.log('WebSocket connection closed:', sanitizedUrl);
  });
  
  try {
    setupWSConnection(ws, req, {
      gc: true
    });
    logPerf('WS_SETUP_COMPLETE', { connId });

    // IMPORTANT: y-websocket uses the URL path as the doc name (e.g., "s/UUID")
    // We need to get the SAME doc instance that y-websocket is using
    const wsDocName = `s/${docId}`;
    const doc = getYDoc(wsDocName, true);

    // Initialize owner map for this document if needed
    if (!clientIdOwnerMap.has(docId)) {
      clientIdOwnerMap.set(docId, new Map());
    }
    const ownerMap = clientIdOwnerMap.get(docId);

    // CRITICAL FIX: We need to intervene in how controlled IDs are tracked.
    // The issue is that y-websocket's awarenessChangeHandler adds ALL clientIDs
    // from awareness updates to the connection's controlled IDs. When the client
    // re-broadcasts awareness states it received from the server, this causes
    // cross-contamination of controlled IDs.
    //
    // Our fix: Monitor controlled IDs and remove any clientIDs that are already
    // owned by other connections.

    // After setupWSConnection, we can access the awareness state
    if (docId && doc) {
      // Debug: Log connection state
      const connsCount = doc.conns ? doc.conns.size : 0;
      const awarenessCount = doc.awareness ? doc.awareness.getStates().size : 0;
      console.log(`[WS:${connId}] Connected to doc ${docId} (wsName: ${wsDocName}): ${connsCount} conns, ${awarenessCount} awareness states`);

      // ========== REDIS PUB/SUB SYNC ==========
      // Set up cross-instance synchronization via Redis (once per doc instance)
      if (!doc._redisSyncInitialized && redisPubSub.isEnabled()) {
        doc._redisSyncInitialized = true;
        console.log(`[RedisPubSub] Setting up sync for doc ${docId}`);

        // Subscribe to Redis channels for this document
        redisPubSub.subscribeToDocument(docId, {
          // Handle awareness updates from other server instances
          onAwareness: (buffer) => {
            try {
              awarenessProtocol.applyAwarenessUpdate(
                doc.awareness,
                new Uint8Array(buffer),
                ORIGIN_REDIS
              );
            } catch (err) {
              console.error(`[RedisPubSub] Error applying awareness update for ${docId}:`, err.message);
            }
          },
          // Handle document updates from other server instances
          onUpdate: (buffer) => {
            try {
              Y.applyUpdate(doc, new Uint8Array(buffer), ORIGIN_REDIS);
            } catch (err) {
              console.error(`[RedisPubSub] Error applying doc update for ${docId}:`, err.message);
            }
          },
        });

        // Publish local awareness changes to Redis for other instances
        const redisAwarenessHandler = ({ added, updated, removed }, origin) => {
          // Skip if update came from Redis (prevent feedback loops)
          if (origin === ORIGIN_REDIS) return;

          const changedClients = added.concat(updated);
          if (changedClients.length > 0) {
            try {
              const update = awarenessProtocol.encodeAwarenessUpdate(
                doc.awareness,
                changedClients
              );
              redisPubSub.publishAwareness(docId, update);
            } catch (err) {
              console.error(`[RedisPubSub] Error publishing awareness for ${docId}:`, err.message);
            }
          }
        };

        // Publish local document updates to Redis for other instances
        const redisUpdateHandler = (update, origin) => {
          // Skip if update came from Redis or DB load (prevent feedback loops)
          if (origin === ORIGIN_REDIS || origin === ORIGIN_DB_LOAD) return;

          try {
            redisPubSub.publishUpdate(docId, update);
          } catch (err) {
            console.error(`[RedisPubSub] Error publishing update for ${docId}:`, err.message);
          }
        };

        // Register handlers
        doc.awareness.on('update', redisAwarenessHandler);
        doc.on('update', redisUpdateHandler);

        // Store handlers for cleanup
        doc._redisAwarenessHandler = redisAwarenessHandler;
        doc._redisUpdateHandler = redisUpdateHandler;
      }
      // ========== END REDIS PUB/SUB SYNC ==========

      if (doc.awareness) {
        // Log current awareness states
        doc.awareness.getStates().forEach((state, clientId) => {
          console.log(`  [awareness] Client ${clientId}: ${state?.user?.name || 'no user'}, owner: ${ownerMap.get(clientId) === ws ? 'this' : 'other'}`);
        });

        // Log controlled IDs for this connection
        const controlledIds = doc.conns.get(ws);
        console.log(`[WS:${connId}] Initial controlled IDs:`, controlledIds ? Array.from(controlledIds) : []);

        /**
         * FIX: Monitor controlled IDs and immediately remove any that this connection
         * shouldn't own. This runs SYNCHRONOUSLY in the same tick as y-websocket's handler.
         */
        const fixControlledIdsHandler = ({ added, updated, removed }, origin) => {
          const connControlledIds = doc.conns.get(ws);
          if (!connControlledIds) return;

          // For each "added" clientId, check if this connection should own it
          for (const clientId of added) {
            const existingOwner = ownerMap.get(clientId);

            if (existingOwner && existingOwner !== ws) {
              // Another connection already owns this clientId!
              // This means the client re-broadcast someone else's awareness.
              // Remove it from this connection's controlled IDs.
              if (connControlledIds.has(clientId)) {
                console.log(`[WS:${connId}] FIX: Removing stolen clientId ${clientId} from controlled IDs (owned by another connection)`);
                connControlledIds.delete(clientId);
              }
            } else if (!existingOwner) {
              // No owner yet - this connection becomes the owner
              ownerMap.set(clientId, ws);
              console.log(`[WS:${connId}] Claiming ownership of clientId ${clientId}`);
            }
            // else: this connection already owns it, that's fine
          }

          // For removed clientIds, if this connection is the owner, clear ownership
          for (const clientId of removed) {
            if (ownerMap.get(clientId) === ws) {
              ownerMap.delete(clientId);
              console.log(`[WS:${connId}] Releasing ownership of clientId ${clientId}`);
            }
          }

          // Debug log
          if (added.length || removed.length) {
            const states = doc.awareness.getStates();
            const users = [];
            states.forEach((s, cid) => {
              const owner = ownerMap.get(cid) === ws ? 'this' : (ownerMap.has(cid) ? 'other' : 'none');
              users.push(`${cid}:${s?.user?.name || 'anon'}(${owner})`);
            });
            console.log(`[WS:${connId}] Awareness after fix: [${users.join(', ')}]`);
            console.log(`[WS:${connId}] Controlled IDs after fix:`, Array.from(connControlledIds));
          }
        };

        // Register our fix handler - runs SYNCHRONOUSLY after y-websocket's handler
        doc.awareness.on('update', fixControlledIdsHandler);

        // Agent detection
        const checkAwareness = () => {
          const awarenessStates = doc.awareness.getStates();
          for (const [clientId, state] of awarenessStates.entries()) {
            if (state.user && state.user.isAgent && state.user.name) {
              registerDocumentUser(docId, connId, userId, state.user.name);
              console.log(`[Agent] Detected: ${state.user.name} for doc ${docId}`);
            }
          }
        };
        setTimeout(checkAwareness, 100);
        doc.awareness.on('update', checkAwareness);

        // Clean up on close
        ws.on('close', () => {
          // Clean up ownership for all clientIds this connection owned
          for (const [clientId, owner] of ownerMap.entries()) {
            if (owner === ws) {
              console.log(`[WS:${connId}] CLOSING - releasing owned clientId ${clientId}`);
              ownerMap.delete(clientId);
            }
          }

          // Clean up owner map if document has no more connections
          if (ownerMap.size === 0) {
            clientIdOwnerMap.delete(docId);
          }

          const idsToRemove = doc.conns?.get(ws);
          console.log(`[WS:${connId}] CLOSING - controlled IDs being removed:`, idsToRemove ? Array.from(idsToRemove) : []);

          doc.awareness.off('update', fixControlledIdsHandler);
          doc.awareness.off('update', checkAwareness);

          // ========== REDIS PUB/SUB CLEANUP ==========
          // If no more local connections, unsubscribe from Redis after a delay
          // (delay handles rapid reconnect scenarios)
          setTimeout(() => {
            if (doc.conns.size === 0 && redisPubSub.isEnabled()) {
              console.log(`[RedisPubSub] No more connections for doc ${docId}, cleaning up`);

              redisPubSub.unsubscribeFromDocument(docId);
              doc._redisSyncInitialized = false;

              // Remove Redis handlers
              if (doc._redisAwarenessHandler) {
                doc.awareness.off('update', doc._redisAwarenessHandler);
                doc._redisAwarenessHandler = null;
              }
              if (doc._redisUpdateHandler) {
                doc.off('update', doc._redisUpdateHandler);
                doc._redisUpdateHandler = null;
              }
            }
          }, 1000); // 1 second delay
          // ========== END REDIS PUB/SUB CLEANUP ==========
        });
      }
    }
  } catch (error) {
    logPerf('WS_SETUP_ERROR', { connId, error: error.message });
    console.error('✗ Error setting up WebSocket connection:', error);
    ws.close();
  }
});

// Handle WebSocket server errors
wss.on('error', (error) => {
  console.error('✗ WebSocket server error:', error);
});

// Graceful shutdown
process.on('SIGINT', async () => {
  console.log('Shutting down...');
  await redisPubSub.cleanup();
  await persistenceProvider.destroy();
  server.close(() => {
    console.log('Server closed');
    process.exit(0);
  });
});

// Export for internal use (MCP tools, tests)
module.exports = {
  getYDoc,
  extractDocGuid,
};
