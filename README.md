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

## Version History

The editor maintains a complete version history of all document changes, enabling review and restoration of previous states.

### How It Works

**Auto-Versioning**: Consecutive edits within a 5-minute window are automatically grouped into a single version. When editing pauses for more than 5 minutes, a new version begins. This prevents every keystroke from creating a separate version while preserving meaningful checkpoints.

**Named Versions**: Users can explicitly name any version (e.g., "Final Draft", "Before Refactor"). Named versions store a cached snapshot for instant loading and appear prominently in the timeline.

**Author Tracking**: Each edit records the user (or AI agent) who made it. Versions display all contributors with deterministic avatar colors. Agent edits are tagged with the agent name for transparency.

### UI Navigation

The version history panel uses a three-level hierarchy:
1. **Month** - Versions grouped by calendar month
2. **Version** - Auto or named versions (5-minute grouping threshold)
3. **Sub-versions** - Drill into a version to see grouped edits (10-second grouping threshold)

### Restoring Versions

Restore is **non-destructive**: restoring a previous version creates a new version with that content rather than discarding subsequent history. All users see the restored content in real-time.

### API Endpoints

| Endpoint | Description |
|----------|-------------|
| `GET /api/docs/:docId/history` | Get version timeline |
| `GET /api/docs/:docId/history/updates?from=X&to=Y` | Get individual updates in clock range |
| `GET /api/docs/:docId/history/clock/:clock` | Get document state at specific clock |
| `GET /api/docs/:docId/versions/:versionId` | Get content at named version |
| `POST /api/docs/:docId/versions` | Create named version |
| `POST /api/docs/:docId/restore` | Restore to previous version |

## AI Agent Integration (Model Context Protocol)

This editor supports AI agents via the [Model Context Protocol (MCP)](https://modelcontextprotocol.io), enabling programmatic document manipulation through AI assistants like Claude.

### Features

- **Sandboxed TypeScript execution** - Write scripts with direct Yjs API access for complex edits
- **Type-safe editing** - Full TypeScript support with type definitions
- **OAuth 2.0 authentication** with PKCE flow for secure agent access
- **Real-time collaboration** between humans and AI agents
- **Permission enforcement** - agents respect document roles (Owner, Editor, Viewer)
- **Atomic operations** - Entire scripts execute as single undo step
- **Operation tracking** - Visual cursor animations show edit operations
- **Automatic rollback** - Scripts fail safely without corrupting document

### Available Tools

**Document Management:**
- `create_document` - Create new documents with a title (use `modify` to add content)
- `list_documents` - List accessible documents
- `share_document` - Share with users and set permissions
- `set_document_title` - Update document titles

**Session Management:**
- `open_document` - Initialize session on a document
- `close_document` - End session and remove presence

**Reading:**
- `read_document` - Read document with optional XPath filtering
- `get_collaborators` - See who else is editing

**Sandboxed Script Execution:**
- `execute_script` - Execute TypeScript scripts with direct Yjs API access
  - Edit text, format content, create/modify blocks
  - Build complex nested structures
  - Find and replace patterns
  - All changes atomic (single undo)
  - Real-time sync to all users

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

```typescript
// AI agents use TypeScript scripts for editing:

// 1. Create a new document with a title
const { docGuid } = await create_document({ title: "My Document" });

// 2. Open document (establishes session)
await open_document({ docGuid });

// 3. Execute script to add content
await modify({
  docGuid,
  script: `
    export default function edit(doc) {
      // Find and format all TODO items as bold
      const blocks = doc.toArray();
      blocks.forEach(block => {
        if (block instanceof Y.XmlElement) {
          const text = findTextNode(block);
          if (text) {
            const content = extractText(text);
            const index = content.indexOf('TODO');
            if (index >= 0) {
              text.format(index, 4, { bold: true });
            }
          }
        }
      });

      // Add a summary section at the end
      const heading = new Y.XmlElement('heading');
      heading.setAttribute('level', 2);
      const headingText = new Y.XmlText();
      headingText.insert(0, 'Action Items');
      heading.insert(0, [headingText]);

      doc.insert(doc.length, [heading]);
    }

    function findTextNode(element) {
      for (const child of element.toArray()) {
        if (child instanceof Y.XmlText) return child;
        if (child instanceof Y.XmlElement) {
          const found = findTextNode(child);
          if (found) return found;
        }
      }
      return null;
    }

    function extractText(xmlText) {
      const delta = xmlText.toDelta();
      return delta.map(op =>
        typeof op.insert === 'string' ? op.insert : ''
      ).join('');
    }
  `
});

// 4. Close when done
await close_document({ docGuid });

// Natural language examples with modify:
"Find all TODO items and make them bold"
"Add a summary section at the end with bullet points"
"Create a table of contents based on headings"
"Find all links and convert them to a reference list"
"Reorganize the document with all headings first"

// IMPORTANT: Creating mixed formatting
// When inserting text with different formatting, ALWAYS pass {} for unformatted text:

await execute_script({
  docGuid: "abc-123",
  script: `
    export default function edit(doc) {
      const para = new Y.XmlElement('paragraph');
      const text = new Y.XmlText();

      // ✅ CORRECT - pass {} to prevent inheriting formatting
      text.insert(0, 'BOLD', { bold: true });
      text.insert(4, ' normal', {});  // Empty object prevents inheriting bold!

      // ❌ WRONG - omitting attributes inherits formatting from previous position
      // text.insert(0, 'BOLD', { bold: true });
      // text.insert(4, ' normal');  // This would be bold too!

      para.insert(0, [text]);
      doc.insert(doc.length, [para]);
    }
  `
});

## Hierarchical Document Editing

This editor supports advanced hierarchical document structures with nested lists, subsections, and complex content organization using the `execute_script` tool with direct Yjs API access.

### Creating Nested Content

**Build complex hierarchical structures with TypeScript:**
```typescript
await execute_script({
  docGuid: "abc-123",
  script: `
    export default function edit(doc) {
      // Create a nested bullet list
      const list = new Y.XmlElement('bulletList');

      // Main item
      const item1 = new Y.XmlElement('listItem');
      const p1 = new Y.XmlElement('paragraph');
      const t1 = new Y.XmlText();
      t1.insert(0, 'Main item');
      p1.insert(0, [t1]);
      item1.insert(0, [p1]);

      // Nested sub-list
      const subList = new Y.XmlElement('bulletList');
      const subItem = new Y.XmlElement('listItem');
      const subP = new Y.XmlElement('paragraph');
      const subT = new Y.XmlText();
      subT.insert(0, 'Sub item');
      subP.insert(0, [subT]);
      subItem.insert(0, [subP]);
      subList.insert(0, [subItem]);

      // Add sub-list to main item
      item1.insert(1, [subList]);
      list.insert(0, [item1]);

      doc.insert(0, [list]);
    }
  `
});
```

### Example: Creating a Complex Document Structure

```typescript
await execute_script({
  docGuid: "abc-123",
  script: `
    export default function edit(doc) {
      // Helper to create heading
      function createHeading(level, text) {
        const h = new Y.XmlElement('heading');
        h.setAttribute('level', level);
        const t = new Y.XmlText();
        t.insert(0, text);
        h.insert(0, [t]);
        return h;
      }

      // Helper to create bullet list item
      function createListItem(text) {
        const item = new Y.XmlElement('listItem');
        const p = new Y.XmlElement('paragraph');
        const t = new Y.XmlText();
        t.insert(0, text);
        p.insert(0, [t]);
        item.insert(0, [p]);
        return item;
      }

      // 1. Create main heading
      doc.insert(0, [createHeading(1, 'Project Plan')]);

      // 2. Add sections with nested content
      doc.insert(1, [createHeading(2, 'Objectives')]);

      const list = new Y.XmlElement('bulletList');
      const obj1 = createListItem('Increase user engagement');
      const obj2 = createListItem('Improve performance metrics');

      // Add nested items under first objective
      const nestedList = new Y.XmlElement('bulletList');
      nestedList.insert(0, [
        createListItem('Implement new UI components'),
        createListItem('Add interactive features')
      ]);
      obj1.insert(1, [nestedList]);

      list.insert(0, [obj1, obj2]);
      doc.insert(2, [list]);
    }
  `
});
```

This approach enables AI agents to create professional documents with proper hierarchical structure, including nested lists, subsections, and complex content organization - all in a single atomic operation.

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

### ⚠️ Common Pitfall: Y.XmlText Methods

**CRITICAL:** When working with `Y.XmlText` nodes that may contain formatting (bold, italic, etc.), always use `toDelta()` to extract plain text, **never** `toString()`.

```javascript
// ❌ WRONG - toString() returns XML markup when text has formatting
const text = xmlTextNode.toString();  // Returns "<bold>Hello</bold> world"

// ✅ CORRECT - toDelta() returns plain text regardless of formatting
const delta = xmlTextNode.toDelta();
const text = delta.map(op => typeof op.insert === 'string' ? op.insert : '').join('');  // Returns "Hello world"
```

**Why this matters:**
- `toString()` returns XML serialization like `<bold>text</bold>` when formatting is present
- This causes incorrect text length calculations and position offsets
- Results in formatting being applied at wrong locations or complete failures
- Particularly affects `find` + `format` operations after text has been formatted

**Where to check:**
- Any function that traverses or counts text characters
- Position/offset calculations in `cursor-operations.js`
- Text extraction in `text-operations.js`
- Find/search operations

See `server/mcp/yjs/cursor-operations.js` (getAllText function) and `server/mcp/yjs/text-operations.js` (extractText function) for correct examples.

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

