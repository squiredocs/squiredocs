# MCP Integration Quick Start

Connect Claude Desktop or Claude Code to your collaborative editor via the Model Context Protocol (MCP).

## Prerequisites

1. **Dev environment running:**
   ```bash
   kubectl exec -it deployment/app-dev -n collab -- sh -c "cd /local-dev && npm run dev"
   ```

2. **Port forwarding active (in a separate terminal):**
   ```bash
   kubectl port-forward deployment/app-dev 3001:3001 -n collab
   ```

---

## Claude Desktop Setup

### Step 1: Generate an Agent Token

```bash
kubectl exec deployment/app-dev -n collab -- sh -c "cd /local-dev && node script/generate-mcp-token.js"
```

Copy the token that's displayed (it starts with `eyJ...`).

### Step 2: Configure Claude Desktop

Edit the Claude Desktop configuration file:

**macOS:** `~/Library/Application Support/Claude/claude_desktop_config.json`
**Windows:** `%APPDATA%\Claude\claude_desktop_config.json`

Add the MCP server configuration:

```json
{
  "mcpServers": {
    "collab-editor": {
      "command": "node",
      "args": ["/Users/YOUR_USERNAME/dev/collab/mcp-server.js"],
      "env": {
        "MCP_TOKEN": "YOUR_TOKEN_HERE",
        "MCP_SERVER_URL": "http://localhost:3001"
      }
    }
  }
}
```

**Replace:**
- `/Users/YOUR_USERNAME/dev/collab/mcp-server.js` with the actual path
- `YOUR_TOKEN_HERE` with the token from Step 1

### Step 3: Restart Claude Desktop

Completely quit and reopen Claude Desktop to load the new MCP server.

### Step 4: Test It

In Claude Desktop, try asking:

> "Can you list my documents from the collaborative editor?"

or

> "Use the collab-editor tools to show me what documents I have."

Claude should use the `list_documents` tool and display your documents.

---

## Claude Code (CLI) Setup

### Step 1: Generate Token (same as above)

```bash
kubectl exec deployment/app-dev -n collab -- sh -c "cd /local-dev && node script/generate-mcp-token.js"
```

### Step 2: Configure Claude Code

Edit `~/.claude/settings.json`:

```json
{
  "mcpServers": {
    "collab-editor": {
      "command": "node",
      "args": ["/path/to/collab/mcp-server.js"],
      "env": {
        "MCP_TOKEN": "YOUR_TOKEN_HERE",
        "MCP_SERVER_URL": "http://localhost:3001"
      }
    }
  }
}
```

### Step 3: Restart Claude Code

Exit and restart your Claude Code session.

---

## One-Line Setup (Quick Test)

For quick testing without modifying config files:

```bash
# Terminal 1: Port forward
kubectl port-forward deployment/app-dev 3001:3001 -n collab

# Terminal 2: Generate token and test
TOKEN=$(kubectl exec deployment/app-dev -n collab -- sh -c "cd /local-dev && node script/generate-mcp-token.js" 2>/dev/null | grep "^eyJ")

# Test the MCP server directly
echo '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}' | \
  MCP_TOKEN="$TOKEN" MCP_SERVER_URL="http://localhost:3001" \
  node /path/to/collab/mcp-server.js
```

## Available Tools

### list_documents
Lists all documents accessible to you with their IDs, titles, roles, timestamps, and share counts.

**Arguments:**
- `filter` (optional): `"owned"`, `"shared_with_me"`, or `"all"` (default)

**Returns:**
- `documents`: Array of documents, each with `id`, `title`, `role`, `createdAt`, `updatedAt`, and `shareCount`

### get_document
Reads document content.

**Arguments:**
- `docGuid` (required): Document UUID
- `format` (optional): `"plain-text"` (default) or `"structured"`

### set_document_title
Sets the title of a document.

**Arguments:**
- `docGuid` (required): Document UUID
- `title` (required): The new title for the document

**Returns:**
- `success`: Boolean indicating if the operation succeeded
- `title`: The title that was set
- `message`: Confirmation message

### set_agent_selection
Sets a text selection in a document that is visible to all users, allowing the AI agent to highlight specific parts of the document. The selection appears with the agent's name and color, just like human user selections.

**Arguments:**
- `docGuid` (required): Document UUID
- `anchor` (required): Anchor position as a Yjs relative position JSON object
- `head` (required): Head position as a Yjs relative position JSON object
- `durationSeconds` (optional): How long to keep the selection visible (1-300 seconds, default: 60)

**Returns:**
- `success`: Boolean indicating if the operation succeeded
- `message`: Confirmation message
- `sessionId`: Unique ID for this selection session
- `expiresIn`: Duration in seconds before the selection disappears
- `selection`: Object with `anchor` and `head` positions
- `agent`: Object with `name` and `color` of the agent

**Use Cases:**
- Draw attention to specific parts of the document
- Highlight text being analyzed or referenced
- Show which section is being edited or reviewed
- Indicate focus areas during collaborative work

**Workflow:**
1. Use `get_document` to understand the document structure and find element indices
2. Use `create_selection_position` to create relative position objects for anchor and head
3. Pass those positions to `set_agent_selection` to highlight the text

**Example:**
```javascript
// First, create positions
const anchorPos = await create_selection_position({
  docGuid: "550e8400-e29b-41d4-a716-446655440000",
  elementIndex: 0,
  textOffset: 10
});

const headPos = await create_selection_position({
  docGuid: "550e8400-e29b-41d4-a716-446655440000",
  elementIndex: 2,
  textOffset: 50
});

// Then set the selection
await set_agent_selection({
  docGuid: "550e8400-e29b-41d4-a716-446655440000",
  anchor: anchorPos.position,
  head: headPos.position,
  durationSeconds: 30
});
```

**Notes:**
- Positions use Yjs relative positions which remain stable as document changes
- Use `create_selection_position` helper tool to create positions
- The selection will automatically disappear after the specified duration
- Multiple agents can have selections active simultaneously

### create_selection_position
Helper tool to create Yjs relative position objects for use with `set_agent_selection`.

**Arguments:**
- `docGuid` (required): Document UUID
- `elementIndex` (required): Index of the element in the document (0-based)
- `textOffset` (optional): Offset within the element's text (default: 0)

**Returns:**
- `success`: Boolean indicating if the operation succeeded
- `position`: The Yjs relative position JSON object
- `elementIndex`: The element index used
- `textOffset`: The text offset used
- `message`: Confirmation message

**Example:**
```javascript
// Create a position at element 2, offset 50
{
  "docGuid": "550e8400-e29b-41d4-a716-446655440000",
  "elementIndex": 2,
  "textOffset": 50
}
```

## Troubleshooting

### Token Expired
Tokens expire after 1 hour. Generate a new one:
```bash
kubectl exec deployment/app-dev -n collab -- sh -c "cd /local-dev && node script/generate-mcp-token.js"
```

### Connection Refused
Make sure:
1. The dev server is running
2. Port forwarding is active: `kubectl port-forward deployment/app-dev 3001:3001 -n collab`

### Debug Mode
Run the MCP server manually to see logs:
```bash
export MCP_TOKEN="your-token"
export MCP_SERVER_URL="http://localhost:3001"
node mcp-server.js
```

Then send test messages:
```json
{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}
{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}
```

## API Endpoints (for direct HTTP access)

```
GET  http://localhost:3001/mcp           - Server info
POST http://localhost:3001/mcp           - JSON-RPC messages
POST http://localhost:3001/mcp/tools/list - List available tools
POST http://localhost:3001/mcp/tools/call - Execute a tool (requires auth)
```

### Example curl commands

```bash
# List tools (no auth required)
curl -X POST http://localhost:3001/mcp/tools/list

# Call a tool (auth required)
curl -X POST http://localhost:3001/mcp/tools/call \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -d '{"name": "list_documents", "arguments": {}}'

# Get a specific document
curl -X POST http://localhost:3001/mcp/tools/call \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -d '{"name": "get_document", "arguments": {"docGuid": "UUID_HERE"}}'
```
