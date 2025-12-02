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
- **Persistence**: PostgreSQL for server-side storage, IndexedDB for client-side offline support

## Prerequisites

- Node.js 18+ (LTS recommended)
- npm or yarn
- PostgreSQL 12+ (for server-side persistence)

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

4. Set up PostgreSQL database:
   - Make sure PostgreSQL is installed and running
   - Create the database (if it doesn't exist):
     ```bash
     createdb collab_db
     ```
     Or using psql:
     ```bash
     psql -U postgres -c "CREATE DATABASE collab_db;"
     ```
   - Run migrations:
     ```bash
     npm run migrate
     ```
   
   **Optional convenience script:** If you want to automatically create the database and run migrations:
     ```bash
     npm run init-db
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
- `DATABASE_URL`: PostgreSQL connection string (alternative to individual DB config)
- `DB_HOST`: PostgreSQL host (default: `localhost`)
- `DB_PORT`: PostgreSQL port (default: `5432`)
- `DB_NAME`: Database name (default: `collab_db`)
- `DB_USER`: Database user (default: `postgres`)
- `DB_PASSWORD`: Database password (default: `postgres`)

Example using connection string:
```bash
PORT=3001 DATABASE_URL=postgresql://user:password@localhost:5432/collab_db npm start
```

Example using individual config:
```bash
PORT=3001 DB_HOST=localhost DB_PORT=5432 DB_NAME=collab_db DB_USER=postgres DB_PASSWORD=password npm start
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

## Programmatically Updating Documents

You can programmatically update documents using Node.js scripts. This is useful for automation, migrations, or bulk edits.

### Important: Field Name

The TipTap editor uses the `'default'` field with `Y.XmlFragment` for ProseMirror content. **Do not** use `Y.Text` or other field names - they won't appear in the editor.

### Example Script

A sample script is provided at `scripts/edit-default-doc.js`. Here's how it works:

```javascript
const Y = require('yjs');
const { WebsocketProvider } = require('y-websocket');

const WS_URL = process.env.WS_URL || 'ws://localhost:3001';
const DOC_NAME = process.env.DOC_NAME || 'default-doc';

const doc = new Y.Doc();
// TipTap uses 'default' field with XmlFragment for ProseMirror content
const xmlFragment = doc.get('default', Y.XmlFragment);

const provider = new WebsocketProvider(WS_URL, DOC_NAME, doc, {
  connect: true
});

provider.on('sync', (isSynced) => {
  if (isSynced) {
    // Create a paragraph node with text
    const paragraph = new Y.XmlElement('paragraph');
    const textNode = new Y.XmlText();
    textNode.insert(0, 'Your text here');
    paragraph.insert(0, [textNode]);
    
    // Insert at the end of the document
    xmlFragment.insert(xmlFragment.length, [paragraph]);
    
    // Clean up
    setTimeout(() => {
      provider.destroy();
      process.exit(0);
    }, 1000);
  }
});
```

### Running the Script

```bash
# Edit the default document
node scripts/edit-default-doc.js

# Edit a specific document
DOC_NAME=my-document node scripts/edit-default-doc.js

# Connect to a different server
WS_URL=ws://example.com:3001 node scripts/edit-default-doc.js
```

### Key Points

- **Wait for sync**: Always wait for the `sync` event before making edits
- **Use XmlFragment**: TipTap requires `Y.XmlFragment` in the `'default'` field
- **Create proper nodes**: Insert `Y.XmlElement('paragraph')` nodes containing `Y.XmlText` nodes
- **Clean up**: Call `provider.destroy()` when done to close the connection

### Advanced: Editing Existing Content

To modify existing content, you can traverse the XmlFragment:

```javascript
// Get all paragraphs
const paragraphs = Array.from(xmlFragment.toArray());
paragraphs.forEach((node, index) => {
  if (node.nodeName === 'paragraph') {
    // Modify paragraph content
    const textNode = node.firstChild;
    if (textNode && textNode.nodeType === 3) { // Text node
      textNode.insert(textNode.length, ' appended text');
    }
  }
});
```

## Project Structure

```
.
├── server/
│   ├── index.js              # Express server with WebSocket
│   └── postgres-persistence.js  # PostgreSQL persistence adapter
├── client/
│   ├── src/
│   │   ├── components/       # React components
│   │   ├── hooks/            # Custom React hooks
│   │   ├── App.jsx           # Main app component
│   │   └── main.jsx          # Entry point
│   └── package.json
├── scripts/
│   └── init-db.js            # Database initialization script
├── docs/                     # Documentation
└── package.json
```

## Data Storage

- **Server**: Documents are persisted to PostgreSQL database
  - Tables: `yjs_updates` (stores document updates), `yjs_state_vectors` (stores document state)
  - Schema is managed via migrations (see Database Migrations section below)
- **Client**: Changes are cached in browser IndexedDB for offline support

## Database Migrations

This project uses [node-pg-migrate](https://github.com/salsita/node-pg-migrate) for database schema management.

### Running Migrations

The standard way to run migrations is using node-pg-migrate's CLI:

```bash
# Run all pending migrations (up)
npm run migrate
# or: npx node-pg-migrate up

# Rollback last migration (down)
npm run migrate:down
# or: npx node-pg-migrate down

# Create a new migration file
npm run migrate:create migration_name
# or: npx node-pg-migrate create migration_name

# Redo last migration (down then up)
npm run migrate:redo
# or: npx node-pg-migrate redo
```

**Note:** node-pg-migrate requires the database to already exist. It only manages schema within the database, not database creation itself.

### Migration Files

Migration files are located in the `migrations/` directory. Each migration file exports `up` and `down` functions:
- `up`: Applies the migration
- `down`: Rolls back the migration

Example migration structure:
```javascript
exports.up = (pgm) => {
  pgm.createTable('my_table', {
    id: 'id',
    name: { type: 'varchar(100)', notNull: true },
  });
};

exports.down = (pgm) => {
  pgm.dropTable('my_table');
};
```

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

### Database Connection Errors

If you encounter database connection errors:

1. **Check PostgreSQL is running:**
   ```bash
   # macOS (Homebrew)
   brew services list
   
   # Linux
   sudo systemctl status postgresql
   ```

2. **Verify database exists:**
   ```bash
   psql -l | grep collab_db
   ```

3. **Check connection credentials:**
   - Verify environment variables match your PostgreSQL setup
   - Test connection manually:
     ```bash
     psql -h localhost -U postgres -d collab_db
     ```

4. **Reinitialize schema if needed:**
   ```bash
   npm run init-db
   ```
   
   Or run migrations directly:
   ```bash
   npm run migrate
   ```

## Development Notes

- This is Phase 1 (MVP) - single document, single server deployment
- No authentication required (for development/testing)
- Document ID is hardcoded as "default-doc"
- Suitable for internal testing and proof-of-concept demonstrations

## Testing

Comprehensive test suite with Jest (backend) and Vitest (frontend):

```bash
# Backend tests
npm test

# Frontend tests
npm run test:client

# All tests
npm run test:all

# Watch mode
npm run test:watch

# Coverage
npm run test:coverage
cd client && npm run test:coverage
```

**Test Structure:**
- `server/__tests__/` - Server and WebSocket tests
- `client/src/**/__tests__/` - Component and hook tests
- `__tests__/integration/` - End-to-end collaboration tests
- `client/src/test/utils.jsx` - Shared test utilities and mocks

## License

MIT

