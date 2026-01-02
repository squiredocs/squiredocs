# Collaborative Rich Text Editor

A real-time collaborative rich text editor built with Yjs, TipTap, and Node.js. Multiple users can edit the same document simultaneously with automatic conflict resolution.

## Features

- **Real-time Collaboration**: Multiple users can edit simultaneously with changes appearing in real-time
- **AI Agent Integration**: Model Context Protocol (MCP) support for AI-powered document editing including hierarchical content manipulation
- **Document Permissions**: Role-based access control (Owner, Editor, Viewer) with granular sharing
- **Rich Text Formatting**: Bold, italic, underline, strikethrough, headings (H1-H3), lists, and code snippets
- **Version History**: View, name, filter, and restore previous versions of documents
- **Offline Support**: Edit while disconnected, changes sync automatically when connection is restored
- **User Presence**: See who's online and their cursor positions
- **Conflict-free**: Automatic conflict resolution using Yjs CRDT technology
- **Document Management**: Create, share, and delete documents with permission enforcement

## Technology Stack

- **Frontend**: React 18, TipTap, Yjs
- **Backend**: Node.js, Express, WebSocket (y-websocket)
- **Persistence**: PostgreSQL for server-side storage, IndexedDB for client-side offline support
- **Authentication**: Google OAuth with JWT (access and refresh tokens)
- **Database**: PostgreSQL with node-pg-migrate for schema management
- **Caching**: Redis for session and state management
- **AI Integration**: Model Context Protocol (MCP) with OAuth 2.0 for AI agents

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

### MCP OAuth Secrets

The application includes OAuth 2.0 support for AI agents via the Model Context Protocol (MCP). These secrets are used to sign JWT tokens for agent authentication.

**For local development**, generate secrets and add them to your `.env` file:

```bash
./script/generate-mcp-secrets.sh
```

This will output environment variables to add to your `.env` file:
- `MCP_JWT_SECRET`: Signs agent access tokens (JWT)
- `MCP_REFRESH_SECRET`: Signs refresh tokens
- `MCP_AUTH_CODE_SECRET`: Hashes authorization codes

**For Kubernetes deployment**, generate a secret YAML file:

```bash
./script/generate-mcp-secrets.sh --k8s
```

This creates `k8s/mcp-auth-secret.yaml` which is automatically applied during deployment. The generated file is gitignored for security.

**Manual Kubernetes secret creation:**

```bash
kubectl create secret generic mcp-auth-secret \
  --from-literal=MCP_JWT_SECRET=$(node -e "console.log(require('crypto').randomBytes(32).toString('hex'))") \
  --from-literal=MCP_REFRESH_SECRET=$(node -e "console.log(require('crypto').randomBytes(32).toString('hex'))") \
  --from-literal=MCP_AUTH_CODE_SECRET=$(node -e "console.log(require('crypto').randomBytes(32).toString('hex'))") \
  -n collab
```

See [docs/mcp-auth-production-plan.md](docs/mcp-auth-production-plan.md) for complete MCP OAuth documentation.

### WebSocket URL

The frontend connects to the WebSocket server at the `/s` path. By default, it connects to `ws://localhost:3001/s`. To change this, set the `VITE_WS_URL` environment variable when building:

```bash
VITE_WS_URL=ws://your-server.com/s npm run build
```

## Usage

1. **Sign in**: Authenticate with Google OAuth
2. **Create or open documents**: Access your documents from the list page
3. **Share documents**: Click the Share button to add users with Editor or Viewer access
4. **Edit collaboratively**: Multiple users can edit simultaneously with real-time sync
5. **View version history**: Click the History button to view, name, and restore previous versions
6. **Manage permissions**: Editors and Owners can change roles and remove access

### Document Roles

- **Owner**: Full control (edit, share, manage, delete)
- **Editor**: Can edit and manage sharing
- **Viewer**: Read-only access, can only add other viewers

See [docs/permissions.md](docs/permissions.md) for detailed permission documentation.

## AI Agent Integration (Model Context Protocol)

This editor supports AI agents via the [Model Context Protocol (MCP)](https://modelcontextprotocol.io), enabling programmatic document manipulation through AI assistants like Claude.

### Features

- **Cursor-based editing API** - Natural editing with persistent cursor state
- **Comprehensive MCP tools** for document operations including hierarchical editing
- **OAuth 2.0 authentication** with PKCE flow for secure agent access
- **Real-time collaboration** between humans and AI agents
- **Permission enforcement** - agents respect document roles (Owner, Editor, Viewer)
- **Undo/redo support** - Independent undo stack per agent
- **Streaming text insertion** - Visible typing animation for other users

### Available Tools

**Document Management:**
- `create_document` - Create new documents
- `list_documents` - List accessible documents
- `share_document` - Share with users and set permissions
- `set_document_title` - Update document titles

**Session Management:**
- `open_document` - Initialize cursor session on a document
- `close_document` - End cursor session and remove presence

**Navigation:**
- `goto` - Move cursor to absolute location (start, end, block, position)
- `move` - Move cursor relative to current position (by char, word, block)
- `find` - Search for text and navigate/select/peek results

**Selection:**
- `select` - Create selections (word, block, all, to block start/end, none)
- `get_selection` - Query current cursor position and selection

**Reading:**
- `read_document` - Read entire document or specific blocks
- `read_context` - Get text around cursor position
- `get_collaborators` - See who else is editing and their cursor positions

**Editing:**
- `insert` - Insert text at cursor (supports streaming mode)
- `delete` - Delete selected text or by direction/unit/count
- `format` - Apply/remove formatting to selection (bold, italic, underline, strike, links)
- `insert_block` - Insert new blocks (paragraph, heading, list, code) with optional hierarchical placement
- `set_block_type` - Convert block to different type

**Hierarchy & Structure:**
- `indent_block` - Move current block into previous sibling's children (create hierarchy)
- `outdent_block` - Move current block up one level (reduce nesting)
- `nest_block` - Insert a new block nested under a specific parent path

**History:**
- `undo` - Undo last operation
- `redo` - Redo previously undone operation

### Quick Start

1. **Generate MCP OAuth secrets** (required for agent authentication):
   ```bash
   ./script/generate-mcp-secrets.sh
   ```
   Add the output to your `.env` file.

2. **Configure your AI agent** to connect to the MCP server:
   ```json
   {
     "mcpServers": {
       "collaborative-editor": {
         "command": "node",
         "args": ["path/to/collab/server/mcp/index.js"],
         "env": {
           "DATABASE_URL": "postgresql://user:pass@localhost:5432/collab_db"
         }
       }
     }
   }
   ```

3. **Authenticate and start editing** - The agent will guide you through OAuth authentication, then you can use natural language to edit documents.

### Documentation

- [MCP Quickstart Guide](docs/mcp-quickstart.md) - Complete setup instructions
- [MCP Integration Summary](docs/mcp-integration-summary.md) - Full feature documentation
- [MCP File Structure](docs/mcp-file-structure.md) - Understanding the MCP codebase
- [MCP Auth Production Plan](docs/mcp-auth-production-plan.md) - OAuth implementation details

### Example Usage

```javascript
// AI agents use cursor-based workflow:

// 1. Open document (establishes cursor session)
await open_document({ docGuid: "abc-123" });

// 2. Navigate to location
await find({ docGuid: "abc-123", query: "TODO", options: { action: "goto" } });

// 3. Select and edit
await select({ docGuid: "abc-123", mode: "word" });
await format({ docGuid: "abc-123", add: ["bold"] });

// 4. Insert new content
await goto({ docGuid: "abc-123", target: { type: "document_end" } });
await insert_block({ docGuid: "abc-123", position: "after", type: "heading", attributes: { level: 2 } });
await insert({ docGuid: "abc-123", text: "Action Items" });

// Insert nested content
await insert_block({
  docGuid: "abc-123",
  parentPath: [2, 1],  // Nest under listItem 1 of block 2
  type: "paragraph",
  content: "Nested content"
});

// Automatically add to existing list (auto-wraps in listItem)
await insert_block({
  docGuid: "abc-123",
  parentPath: [0],  // Insert into list at block 0
  type: "paragraph",
  content: "New list item"
  // autoListItem defaults to true - automatically wraps in listItem
});

// 5. Close when done
await close_document({ docGuid: "abc-123" });

// Natural language examples:
"Open the document and find the word 'TODO'"
"Select the current paragraph and make it bold"
"Go to the end and add a new heading 'Conclusion'"
"Undo the last change"

## Hierarchical Document Editing

This editor supports advanced hierarchical document structures with nested lists, subsections, and complex content organization. The MCP tools now enable creation and manipulation of nested document structures.

### Creating Nested Content

**Insert blocks at specific hierarchy levels:**
```javascript
// Create a nested list structure
await insert_block({ docGuid: "abc-123", position: "after", type: "bulletList", content: "Main item" });
await nest_block({
  docGuid: "abc-123",
  parentPath: [0, 0],  // Under first list item
  type: "bulletList",
  content: "Sub item"
});
```

### Restructuring Content

**Indent/outdent blocks to change hierarchy:**
```javascript
// Move current block into previous sibling (indent)
await indent_block({ docGuid: "abc-123" });

// Move current block up one level (outdent)
await outdent_block({ docGuid: "abc-123" });
```


### Path-Based Addressing

Many operations now support hierarchical paths for precise content placement:

- `[0]` - First top-level block
- `[0, 1]` - Second child of first top-level block
- `[0, 1, 0]` - First child of second child of first top-level block

### Example: Creating a Complex Document Structure

```javascript
// 1. Create main heading
await insert_block({ docGuid: "abc-123", position: "after", type: "heading", attributes: { level: 1 }, content: "Project Plan" });

// 2. Add main sections
await insert_block({ docGuid: "abc-123", position: "after", type: "heading", attributes: { level: 2 }, content: "Objectives" });
await insert_block({ docGuid: "abc-123", position: "after", type: "heading", attributes: { level: 2 }, content: "Timeline" });

// 3. Add nested content under Objectives
await goto({ docGuid: "abc-123", target: { type: "block", index: 1 } }); // Go to Objectives heading
await insert_block({ docGuid: "abc-123", position: "after", type: "bulletList", content: "Increase user engagement" });
await insert_block({ docGuid: "abc-123", position: "after", type: "bulletList", content: "Improve performance metrics" });

// 4. Create sub-list under first objective
await nest_block({
  docGuid: "abc-123",
  parentPath: [2, 0],  // Under first list item of the bullet list
  type: "bulletList",
  content: "Implement new UI components"
});
await nest_block({
  docGuid: "abc-123",
  parentPath: [2, 0, 1, 0],  // Under first item of the nested list
  type: "paragraph",
  content: "Detailed implementation plan..."
});
```

This enables AI agents to create professional documents with proper hierarchical structure, including nested lists, subsections, and complex content organization.

## Programmatically Updating Documents

You can programmatically update documents using Node.js scripts. This is useful for automation, migrations, or bulk edits.

### Important: Field Name

The TipTap editor uses the `'default'` field with `Y.XmlFragment` for ProseMirror content. **Do not** use `Y.Text` or other field names - they won't appear in the editor.

### Example Script

A sample script is provided at `script/edit-default-doc.js`. Here's how it works:

```javascript
const Y = require('yjs');
const { WebsocketProvider } = require('y-websocket');

const WS_URL = process.env.WS_URL || 'ws://localhost:3001/s';
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
node script/edit-default-doc.js

# Edit a specific document
DOC_NAME=my-document node script/edit-default-doc.js

# Connect to a different server
WS_URL=ws://example.com:3001 node script/edit-default-doc.js
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
│   ├── postgres-persistence.js  # PostgreSQL persistence adapter
│   ├── permissions.js        # Centralized permission checks
│   ├── documents.js          # Document and share management
│   ├── redis.js              # Redis caching layer
│   ├── auth/                 # Human authentication (Google OAuth, JWT)
│   └── mcp/                  # Model Context Protocol integration
│       ├── index.js          # MCP server entry point
│       ├── tools/            # 21 MCP tools for document operations
│       ├── yjs/              # Yjs utilities and serialization
│       ├── auth/             # MCP OAuth 2.0 and PKCE flow
│       └── agent-presence.js # Agent session management
├── client/
│   ├── src/
│   │   ├── components/       # React components
│   │   │   ├── Editor.jsx    # TipTap editor component
│   │   │   ├── EditorView.jsx # Editor page with header/toolbar
│   │   │   ├── DocList.jsx   # Document list page
│   │   │   └── ShareDialog.jsx # Share/permissions dialog
│   │   ├── hooks/            # Custom React hooks
│   │   │   └── useYjs.js     # Yjs document and WebSocket management
│   │   ├── contexts/         # React contexts
│   │   │   └── AuthContext.jsx # Authentication state
│   │   └── main.jsx          # Entry point
│   └── package.json
├── migrations/               # Database migrations
├── script/                   # Utility scripts
│   ├── generate-mcp-secrets.sh # Generate MCP OAuth secrets
│   └── edit-default-doc.js  # Example programmatic editing
├── docs/                     # Documentation
│   ├── mcp-quickstart.md    # MCP setup guide
│   ├── mcp-integration-summary.md # Complete MCP documentation
│   ├── permissions.md        # Permission system details
│   └── dev.md                # Development environment guide
└── package.json
```

## Data Storage

- **Server**: Documents are persisted to PostgreSQL database
  - **Yjs data**: `yjs_updates` (stores document updates), `yjs_state_vectors` (stores document state)
  - **Document metadata**: `documents` table (document info, creator)
  - **Permissions**: `document_shares` table (user-document access with roles)
  - **Users**: `users` table (OAuth user accounts)
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

- **Authentication**: Google OAuth required for all users
- **Document Management**: Full CRUD with permission-based access control
- **Multi-document**: Users can create and manage multiple documents
- **Permission System**: Centralized RBAC enforcement (see `server/permissions.js`)
- **UI Features**: Word processor-style editor with visible margins, share badges, and role-based UI

## UI/UX Features

### Editor Interface
- **Word processor styling**: Visible margins with thin grey lines, centered content area
- **Header layout**: Document icon, title input, and formatting toolbar aligned vertically
- **Keyboard navigation**: Tab key moves focus from title to editor content
- **Format buttons**: Square buttons with hover/active states, styled letters (B/I/U/S)

### Document List
- **Share badges**: Visual indicators for shared documents (green = shared with me, purple = I shared)
- **Date format**: Shows "Opened [date time]" for all documents
- **Quick actions**: 3-dot menu with Share and Delete options
- **Refresh**: Click document icon next to "Documents" title to refresh list

### Sharing Interface
- **Share dialog**: Shows document title, lists all users with access
- **Role management**: Visual role badges, dropdown selectors for role changes
- **Permission hints**: Disabled actions show tooltips explaining restrictions

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

## Documentation

For more detailed information, see:

- **[MCP Quickstart](docs/mcp-quickstart.md)** - Get started with AI agent integration
- **[MCP Integration Summary](docs/mcp-integration-summary.md)** - Complete MCP feature documentation
- **[Permissions Guide](docs/permissions.md)** - Permission system details and role-based access control
- **[Development Guide](docs/dev.md)** - Development environment setup and best practices
- **[MCP Auth Production Plan](docs/mcp-auth-production-plan.md)** - OAuth 2.0 implementation for production

## License

MIT

