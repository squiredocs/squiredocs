# Collaborative Rich Text Editor

A real-time collaborative rich text editor built with Yjs, TipTap, and Node.js. Multiple users can edit the same document simultaneously with automatic conflict resolution.

## Features

- **Real-time Collaboration**: Multiple users can edit simultaneously with changes appearing in real-time
- **Rich Text Formatting**: Bold, italic, underline, strikethrough, headings (H1-H3), lists, and code snippets
- **Offline Support**: Edit while disconnected, changes sync automatically when connection is restored
- **User Presence**: See who's online and their cursor positions
- **Conflict-free**: Automatic conflict resolution using Yjs CRDT technology

## Technology Stack

- **Frontend**: React 18, TipTap, Yjs
- **Backend**: Node.js, Express, WebSocket (y-websocket)
- **Persistence**: LevelDB (y-leveldb) for server-side storage, IndexedDB for client-side offline support

## Prerequisites

- Node.js 18+ (LTS recommended)
- npm or yarn

## Installation

1. Clone the repository:
```bash
git clone <repository-url>
cd collaborative-editor
```

2. Install root dependencies:
```bash
npm install
```

3. Install client dependencies:
```bash
cd client
npm install
cd ..
```

## Development

To run both the server and client in development mode:

```bash
npm run dev
```

This will start:
- Backend server on `http://localhost:3001`
- Frontend dev server on `http://localhost:5173`

Open `http://localhost:5173` in your browser to use the editor.

### Running Separately

**Backend only:**
```bash
npm run server
```

**Frontend only:**
```bash
npm run client
```

## Production Build

1. Build the frontend:
```bash
npm run build
```

2. Start the production server:
```bash
npm start
```

The server will serve the built frontend from `client/dist` and handle WebSocket connections.

## Configuration

### Environment Variables

- `PORT`: Server port (default: 3001)
- `DATA_DIR`: Directory for LevelDB storage (default: `./data/leveldb`)

Example:
```bash
PORT=3001 DATA_DIR=./data/leveldb npm start
```

### WebSocket URL

The frontend connects to the WebSocket server. By default, it connects to `ws://localhost:3001`. To change this, set the `VITE_WS_URL` environment variable when building:

```bash
VITE_WS_URL=ws://your-server.com npm run build
```

## Usage

1. Open the application in your browser
2. Enter your name (or use the default)
3. Start editing! Changes will sync in real-time with other connected users
4. You can see other users in the sidebar
5. Connection status is shown in the top-right corner

## Project Structure

```
.
├── server/
│   └── index.js          # Express server with WebSocket and LevelDB
├── client/
│   ├── src/
│   │   ├── components/   # React components
│   │   ├── hooks/        # Custom React hooks
│   │   ├── App.jsx       # Main app component
│   │   └── main.jsx      # Entry point
│   └── package.json
├── data/                 # LevelDB storage (created automatically)
├── docs/                 # Documentation
└── package.json
```

## Data Storage

- **Server**: Documents are persisted to LevelDB in `./data/leveldb/` directory
- **Client**: Changes are cached in browser IndexedDB for offline support

The `data/` directory is git-ignored and created automatically on first run.

## Troubleshooting

### WebSocket Connection Issues

- Ensure the server is running on the correct port
- Check firewall settings if accessing remotely
- Verify `VITE_WS_URL` matches your server URL

### Port Already in Use

Change the port using the `PORT` environment variable:
```bash
PORT=3002 npm start
```

### LevelDB Errors

If you encounter LevelDB errors, try deleting the `data/` directory and restarting:
```bash
rm -rf data/
npm start
```

## Development Notes

- This is Phase 1 (MVP) - single document, single server deployment
- No authentication required (for development/testing)
- Document ID is hardcoded as "default-doc"
- Suitable for internal testing and proof-of-concept demonstrations

## License

MIT

