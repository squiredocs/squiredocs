const express = require('express');
const WebSocket = require('ws');
const { setupWSConnection, setPersistence } = require('y-websocket/bin/utils');
const path = require('path');
const fs = require('fs');
const { PostgresPersistence } = require('./postgres-persistence');
const Y = require('yjs');

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

// Set up persistence layer for y-websocket
// y-websocket expects a persistence object with bindState and writeState methods
// bindState is async but not awaited by y-websocket - it applies persisted state when it completes
setPersistence({
  bindState: async (docName, ydoc) => {
    const startTime = Date.now();
    try {
      // Load persisted document from PostgreSQL
      const loadStart = Date.now();
      const persistedYdoc = await persistenceProvider.getYDoc(docName);
      logPerf('DB_LOAD', { docName, duration: Date.now() - loadStart });
      
      // Store the current (empty) document state first (like y-leveldb does)
      // This ensures the document structure exists
      const newUpdates = Y.encodeStateAsUpdate(ydoc);
      const storeStart = Date.now();
      await persistenceProvider.storeUpdate(docName, newUpdates);
      logPerf('DB_STORE_INITIAL', { docName, duration: Date.now() - storeStart, size: newUpdates.byteLength });
      
      // Apply persisted state to the in-memory document
      // This triggers the 'update' event which broadcasts to all connected clients
      Y.applyUpdate(ydoc, Y.encodeStateAsUpdate(persistedYdoc));
      
      // Set up update listener AFTER applying persisted state (like y-leveldb does)
      // This ensures persisted updates get persisted going forward
      ydoc.on('update', update => {
        const persistStart = Date.now();
        persistenceProvider.storeUpdate(docName, update)
          .then(() => {
            logPerf('DB_PERSIST', { docName, duration: Date.now() - persistStart, size: update.byteLength });
          })
          .catch(err => {
            console.error(`Error persisting update for ${docName}:`, err);
          });
      });
      
      logPerf('BIND_STATE_COMPLETE', { docName, totalDuration: Date.now() - startTime });
    } catch (error) {
      // If document doesn't exist in persistence, that's okay - start with empty doc
      // Still set up the update listener
      ydoc.on('update', update => {
        const persistStart = Date.now();
        persistenceProvider.storeUpdate(docName, update)
          .then(() => {
            logPerf('DB_PERSIST', { docName, duration: Date.now() - persistStart, size: update.byteLength });
          })
          .catch(err => {
            console.error(`Error persisting update for ${docName}:`, err);
          });
      });
      logPerf('BIND_STATE_NEW_DOC', { docName, totalDuration: Date.now() - startTime });
    }
  },
  writeState: async (docName, ydoc) => {
    // Called when document is destroyed (no more connections)
    // Store final state
    try {
      const update = Y.encodeStateAsUpdate(ydoc);
      await persistenceProvider.storeUpdate(docName, update);
    } catch (error) {
      console.error(`Error writing state for ${docName}:`, error);
    }
  },
  provider: persistenceProvider
});

// Serve static files from client build directory
const clientBuildPath = path.join(__dirname, '../client/dist');

// Health check endpoint
app.get('/health', (req, res) => {
  res.status(200).json({ status: 'ok' });
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
server.on('upgrade', (request, socket, head) => {
  const pathname = new URL(request.url, `http://${request.headers.host}`).pathname;
  
  // Accept WebSocket connections that start with /s/
  if (pathname.startsWith('/s/')) {
    wss.handleUpgrade(request, socket, head, (ws) => {
      wss.emit('connection', ws, request);
    });
  } else {
    // Reject connections to other paths
    socket.write('HTTP/1.1 400 Bad Request\r\n\r\n');
    socket.destroy();
  }
});

// Handle WebSocket connections
wss.on('connection', (ws, req) => {
  const connId = ++messageCounter;
  const connStart = Date.now();
  logPerf('WS_CONNECT', { connId, url: req.url });
  console.log('✓ WebSocket connection established:', req.url);
  
  // Profile incoming messages
  const originalOnMessage = ws.onmessage;
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

