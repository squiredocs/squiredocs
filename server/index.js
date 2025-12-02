const express = require('express');
const WebSocket = require('ws');
const { setupWSConnection, setPersistence } = require('y-websocket/bin/utils');
const path = require('path');
const fs = require('fs');
const { PostgresPersistence } = require('./postgres-persistence');
const Y = require('yjs');

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
    try {
      // Load persisted document from PostgreSQL
      const persistedYdoc = await persistenceProvider.getYDoc(docName);
      
      // Store the current (empty) document state first (like y-leveldb does)
      // This ensures the document structure exists
      const newUpdates = Y.encodeStateAsUpdate(ydoc);
      await persistenceProvider.storeUpdate(docName, newUpdates);
      
      // Apply persisted state to the in-memory document
      // This triggers the 'update' event which broadcasts to all connected clients
      Y.applyUpdate(ydoc, Y.encodeStateAsUpdate(persistedYdoc));
      
      // Set up update listener AFTER applying persisted state (like y-leveldb does)
      // This ensures persisted updates get persisted going forward
      ydoc.on('update', update => {
        persistenceProvider.storeUpdate(docName, update).catch(err => {
          console.error(`Error persisting update for ${docName}:`, err);
        });
      });
    } catch (error) {
      // If document doesn't exist in persistence, that's okay - start with empty doc
      // Still set up the update listener
      ydoc.on('update', update => {
        persistenceProvider.storeUpdate(docName, update).catch(err => {
          console.error(`Error persisting update for ${docName}:`, err);
        });
      });
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
  console.log(`WebSocket server ready on ws://localhost:${PORT}`);
});

// Create WebSocket server attached to HTTP server
const wss = new WebSocket.Server({ server });

// Handle WebSocket connections
wss.on('connection', (ws, req) => {
  console.log('✓ WebSocket connection established:', req.url);
  
  ws.on('error', (error) => {
    console.error('✗ WebSocket client error:', error.message);
  });
  
  ws.on('close', () => {
    console.log('WebSocket connection closed:', req.url);
  });
  
  try {
    setupWSConnection(ws, req, {
      gc: true
    });
  } catch (error) {
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

