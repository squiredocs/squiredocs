// Load environment variables from .env file
require('dotenv').config();

const express = require('express');
const WebSocket = require('ws');
const { setupWSConnection, setPersistence } = require('y-websocket/bin/utils');
const path = require('path');
const fs = require('fs');
const cookieParser = require('cookie-parser');
const { PostgresPersistence } = require('./postgres-persistence');
const Y = require('yjs');
const { router: authRouter, initUsers, requireAuth } = require('./auth');
const documents = require('./documents');
const permissions = require('./permissions');

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

setPersistence({
  bindState: async (docName, ydoc) => {
    // docName from y-websocket includes the URL path prefix (e.g., "s/uuid")
    // Extract the clean UUID
    const docGuid = extractDocGuid(docName);
    const startTime = Date.now();
    
    // IMPORTANT: Set up update listener FIRST, before any async operations!
    // y-websocket does NOT await bindState, so client updates can arrive
    // while we're still loading from DB. We must capture ALL updates.
    ydoc.on('update', (update, origin) => {
      // Skip persisting updates that come from loading persisted state
      // (they're already in the DB, no need to save again)
      if (origin === ORIGIN_DB_LOAD) {
        return;
      }
      
      const persistStart = Date.now();
      persistenceProvider.storeUpdate(docGuid, update)
        .then(() => {
          logPerf('DB_PERSIST', { docGuid, duration: Date.now() - persistStart, size: update.byteLength });
        })
        .catch(err => {
          console.error(`Error persisting update for ${docGuid}:`, err);
        });
    });
    
    try {
      // Load persisted document from PostgreSQL
      const loadStart = Date.now();
      const persistedYdoc = await persistenceProvider.getYDoc(docGuid);
      logPerf('DB_LOAD', { docGuid, duration: Date.now() - loadStart });
      
      // Apply persisted state to the in-memory document
      // Use ORIGIN_DB_LOAD so the update listener knows to skip persisting this
      Y.applyUpdate(ydoc, Y.encodeStateAsUpdate(persistedYdoc), ORIGIN_DB_LOAD);
      
      logPerf('BIND_STATE_COMPLETE', { docGuid, totalDuration: Date.now() - startTime });
    } catch (error) {
      // If document doesn't exist in persistence, that's okay - start with empty doc
      // Update listener is already set up above
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

// Mount auth routes
app.use('/auth', authRouter);

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
    const accessibleDocs = await documents.getAccessibleDocuments(userId);
    
    // Build a map of docId -> access info
    const accessMap = new Map();
    for (const doc of accessibleDocs) {
      accessMap.set(doc.doc_id, {
        role: doc.role,
        ownerName: doc.owner_name,
        ownerEmail: doc.owner_email,
      });
    }
    
    // Get all docs with metadata from persistence
    const allDocsWithMeta = await persistenceProvider.getAllDocumentsWithMeta();
    
    // Filter to only accessible docs and enrich with role info
    const docs = allDocsWithMeta
      .filter(doc => accessMap.has(doc.docGuid))
      .map(doc => {
        const access = accessMap.get(doc.docGuid);
        return {
          ...doc,
          role: access.role,
          ownerName: access.ownerName,
          ownerEmail: access.ownerEmail,
        };
      });
    
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
    
    // Check if user has access to the document (anyone with access can share)
    const hasAccess = await documents.hasAccess(docId, userId);
    if (!hasAccess) {
      return res.status(403).json({ error: 'You do not have access to this document' });
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
    console.log('WebSocket auth failed: no valid token');
    socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
    socket.destroy();
    return;
  }

  // Check if user has at least view access
  const viewPermission = await permissions.can.view(user.userId, docId);
  if (!viewPermission.allowed) {
    console.log(`WebSocket access denied for user ${user.userId} to doc ${docId}: ${viewPermission.reason}`);
    socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
    socket.destroy();
    return;
  }

  // Store user info and role on the request for later use
  request.user = user;
  request.userRole = viewPermission.role;
  request.docId = docId;
  
  wss.handleUpgrade(request, socket, head, (ws) => {
    wss.emit('connection', ws, request);
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
  
  logPerf('WS_CONNECT', { connId, url: req.url, role: userRole, canEdit });
  console.log(`✓ WebSocket connection established: ${req.url} (role: ${userRole})`);
  
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
    logPerf('WS_CLOSE', { connId, duration: Date.now() - connStart });
    console.log('WebSocket connection closed:', req.url);
  });
  
  try {
    setupWSConnection(ws, req, {
      gc: true
    });
    logPerf('WS_SETUP_COMPLETE', { connId });
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
  await persistenceProvider.destroy();
  server.close(() => {
    console.log('Server closed');
    process.exit(0);
  });
});

