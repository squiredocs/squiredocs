const express = require('express');
const WebSocket = require('ws');
const { setupWSConnection } = require('y-websocket/bin/utils');
const path = require('path');
const fs = require('fs');
const { LeveldbPersistence } = require('y-leveldb');

const app = express();
const PORT = process.env.PORT || 3001;
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '../data/leveldb');

// Ensure data directory exists
if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

// Initialize LevelDB persistence
const persistence = new LeveldbPersistence(DATA_DIR);

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
      gc: true,
      persistence: persistence
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
  await persistence.destroy();
  server.close(() => {
    console.log('Server closed');
    process.exit(0);
  });
});

