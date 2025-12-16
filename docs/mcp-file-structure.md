# MCP Integration File Structure

## Overview
This document outlines the complete file structure for the MCP integration, showing where new code will be organized and how it integrates with the existing codebase.

## New Directory Structure

```
server/
├── mcp/                                    # New MCP module (root)
│   ├── index.js                           # Main MCP server setup and router
│   ├── transport.js                       # HTTP + SSE transport layer
│   ├── middleware.js                      # MCP-specific middleware (auth, validation)
│   │
│   ├── auth/                              # Authentication & delegation
│   │   ├── delegation.js                  # Delegation management (create, revoke, check)
│   │   ├── oauth-flow.js                  # OAuth authorization flow for agents
│   │   ├── jwt.js                         # Agent JWT generation and verification
│   │   └── middleware.js                  # requireAgentAuth, requireScope
│   │
│   ├── tools/                             # MCP tool implementations
│   │   ├── index.js                       # Tool registry and dispatcher
│   │   ├── list-documents.js              # list_documents tool
│   │   ├── get-document.js                # get_document tool
│   │   ├── update-document.js             # update_document tool
│   │   ├── watch-document.js              # watch_document tool
│   │   ├── create-document.js             # create_document tool
│   │   ├── share-document.js              # share_document tool
│   │   └── get-document-info.js           # get_document_info tool
│   │
│   ├── yjs/                               # Yjs/TipTap integration
│   │   ├── adapter.js                     # Yjs ↔ MCP format conversion
│   │   ├── operations.js                  # High-level operations on Yjs docs
│   │   ├── serialization.js               # Serialize Yjs to readable format
│   │   ├── connection-manager.js          # Manage WebSocket connections for agents
│   │   └── tiptap-nodes.js                # TipTap node creation helpers
│   │
│   ├── streaming/                         # Real-time streaming
│   │   ├── sse.js                         # Server-Sent Events helpers
│   │   ├── updates.js                     # Document update streaming
│   │   └── presence.js                    # Agent presence management
│   │
│   └── __tests__/                         # MCP tests
│       ├── auth/
│       │   ├── delegation.test.js
│       │   ├── oauth-flow.test.js
│       │   └── middleware.test.js
│       ├── tools/
│       │   ├── list-documents.test.js
│       │   ├── get-document.test.js
│       │   └── update-document.test.js
│       ├── yjs/
│       │   ├── adapter.test.js
│       │   └── operations.test.js
│       └── integration/
│           ├── full-workflow.test.js      # End-to-end agent workflow
│           └── streaming.test.js          # SSE streaming tests
│
├── permissions.js                         # Extended to handle agent delegations
├── index.js                               # Import and mount MCP router
└── ...

migrations/
└── 010_mcp_agent_delegations.js           # Database schema for MCP

client/
└── src/
    ├── components/
    │   ├── AgentSettings.jsx              # Manage agent delegations UI
    │   ├── AgentAuthDialog.jsx            # OAuth consent screen
    │   ├── AgentPresenceIndicator.jsx     # Show agent in editor
    │   └── Editor.jsx                     # Extended to show agent presence
    │
    └── contexts/
        └── AgentContext.jsx                # Agent state management
```

## File Descriptions

### Core MCP Server

#### `server/mcp/index.js`
Main entry point for MCP server. Sets up Express router and mounts all endpoints.

```javascript
const express = require('express');
const { requireAgentAuth } = require('./auth/middleware');
const toolRegistry = require('./tools');

const router = express.Router();

// Tool discovery
router.post('/tools/list', requireAgentAuth, handleToolList);

// Tool execution
router.post('/tools/call', requireAgentAuth, handleToolCall);

// SSE streaming endpoint
router.get('/events/:callId', requireAgentAuth, handleEventStream);

module.exports = router;
```

#### `server/mcp/transport.js`
Handles MCP protocol message format and SSE setup.

```javascript
// Parse MCP request
function parseMCPRequest(req) { ... }

// Format MCP response
function formatMCPResponse(result, callId) { ... }

// Setup SSE stream
function setupSSEStream(res, callId) { ... }
```

#### `server/mcp/middleware.js`
MCP-specific middleware for validation and error handling.

```javascript
// Validate MCP request format
function validateMCPRequest(req, res, next) { ... }

// Handle MCP errors
function handleMCPError(err, req, res, next) { ... }
```

### Authentication & Delegation

#### `server/mcp/auth/delegation.js`
Core delegation management logic.

```javascript
// Create new agent delegation
async function createDelegation(userId, agentId, agentName, scopes) { ... }

// Check if delegation is valid
async function checkDelegation(delegationId) { ... }

// Revoke delegation
async function revokeDelegation(userId, delegationId) { ... }

// List user's delegations
async function listDelegations(userId) { ... }
```

#### `server/mcp/auth/oauth-flow.js`
OAuth authorization flow for agents.

```javascript
// Initiate authorization
async function authorize(req, res) { ... }

// Exchange code for token
async function token(req, res) { ... }

// Revoke token
async function revoke(req, res) { ... }
```

#### `server/mcp/auth/jwt.js`
Agent JWT token generation and verification.

```javascript
// Generate agent access token
function generateAgentToken(delegation) { ... }

// Verify agent token
function verifyAgentToken(token) { ... }
```

#### `server/mcp/auth/middleware.js`
Authentication middleware for MCP endpoints.

```javascript
// Require agent authentication
function requireAgentAuth(req, res, next) { ... }

// Require specific scope
function requireScope(scope) { ... }
```

### MCP Tools

Each tool file exports:
- `schema`: JSON schema for tool parameters
- `description`: Tool description for discovery
- `handler`: Async function to execute the tool

#### `server/mcp/tools/index.js`
Tool registry and dispatcher.

```javascript
const listDocuments = require('./list-documents');
const getDocument = require('./get-document');
// ... other tools

const tools = {
  'list_documents': listDocuments,
  'get_document': getDocument,
  // ...
};

// Get tool list for discovery
function getToolList() { ... }

// Execute a tool
async function executeTool(toolName, args, agentToken) { ... }
```

#### `server/mcp/tools/list-documents.js`
Example tool implementation.

```javascript
module.exports = {
  name: 'list_documents',
  description: 'List all documents accessible to the authenticated user',
  inputSchema: {
    type: 'object',
    properties: {
      filter: {
        type: 'string',
        enum: ['owned', 'shared_with_me', 'all'],
        default: 'all'
      }
    }
  },
  handler: async (args, agentToken) => {
    const userId = agentToken.userId;
    // Implementation...
    return { documents: [...] };
  }
};
```

### Yjs/TipTap Integration

#### `server/mcp/yjs/adapter.js`
Convert between Yjs and MCP-friendly formats.

```javascript
// Convert Yjs XmlFragment to readable structure
function yjsToReadable(xmlFragment) { ... }

// Convert operations to Yjs updates
function operationsToYjs(doc, operations) { ... }
```

#### `server/mcp/yjs/operations.js`
High-level operations on Yjs documents.

```javascript
// Insert content at position
function insertContent(xmlFragment, position, content) { ... }

// Delete content
function deleteContent(xmlFragment, position, length) { ... }

// Replace content
function replaceContent(xmlFragment, position, length, newContent) { ... }
```

#### `server/mcp/yjs/serialization.js`
Serialize Yjs documents to readable formats.

```javascript
// Serialize to plain text
function toPlainText(xmlFragment) { ... }

// Serialize to structured JSON
function toJSON(xmlFragment) { ... }
```

#### `server/mcp/yjs/connection-manager.js`
Manage WebSocket connections for agents.

```javascript
class AgentConnectionManager {
  async connectAgent(docGuid, agentToken) { ... }
  async disconnectAgent(docGuid, agentToken) { ... }
  getConnection(docGuid, agentId) { ... }
}
```

#### `server/mcp/yjs/tiptap-nodes.js`
Create TipTap nodes.

```javascript
// Create paragraph node
function createParagraph(text) { ... }

// Create heading node
function createHeading(level, text) { ... }

// Create list node
function createList(type, items) { ... }
```

### Streaming

#### `server/mcp/streaming/sse.js`
Server-Sent Events helpers.

```javascript
// Setup SSE response
function setupSSE(res) { ... }

// Send SSE message
function sendSSE(res, data) { ... }

// Close SSE stream
function closeSSE(res) { ... }
```

#### `server/mcp/streaming/updates.js`
Stream document updates to agents.

```javascript
// Stream document updates
async function streamUpdates(docGuid, agentToken, onUpdate) { ... }
```

#### `server/mcp/streaming/presence.js`
Track and broadcast agent presence.

```javascript
// Register agent presence
function registerAgentPresence(docGuid, agentToken) { ... }

// Unregister agent presence
function unregisterAgentPresence(docGuid, agentToken) { ... }
```

### Frontend Components

#### `client/src/components/AgentSettings.jsx`
Agent delegation management UI.

```javascript
// Shows:
// - List of authorized agents
// - Revoke buttons
// - Activity log
// - "Authorize New Agent" button
```

#### `client/src/components/AgentAuthDialog.jsx`
OAuth consent screen for authorizing agents.

```javascript
// Shows:
// - Agent name and icon
// - Requested scopes/permissions
// - "Authorize" / "Deny" buttons
// - Expiration settings
```

#### `client/src/components/AgentPresenceIndicator.jsx`
Display agent presence in editor.

```javascript
// Shows:
// - Robot icon
// - Agent name
// - Purple cursor/selection
// - Tooltip with details
```

## Integration Points

### 1. Main Server (`server/index.js`)
```javascript
const mcpRouter = require('./mcp');
app.use('/mcp', mcpRouter);
```

### 2. Permissions (`server/permissions.js`)
```javascript
// Extend to check agent delegations
async function checkPermission(userOrAgent, docGuid, action) {
  if (userOrAgent.agentId) {
    // Check delegation + user permission
  } else {
    // Check user permission (existing logic)
  }
}
```

### 3. WebSocket (`server/index.js`)
```javascript
// Detect agent connections
wss.on('connection', (ws, req) => {
  const clientType = req.url.searchParams.get('clientType');
  if (clientType === 'agent') {
    // Handle as agent connection
    handleAgentConnection(ws, req);
  }
});
```

## Dependencies to Add

```json
{
  "dependencies": {
    "express-rate-limit": "^7.1.0",  // Rate limiting
    "@modelcontextprotocol/sdk": "^1.0.0"  // MCP SDK (if available)
  }
}
```

## Environment Variables

```bash
# MCP Configuration
MCP_ENABLED=true
MCP_JWT_SECRET=<secret>
MCP_TOKEN_EXPIRY=30d

# OAuth for Agents
MCP_OAUTH_CLIENT_ID=<client_id>
MCP_OAUTH_CLIENT_SECRET=<client_secret>
MCP_OAUTH_REDIRECT_URI=http://localhost:3001/mcp/auth/callback
```

## Next Steps

1. Create `server/mcp/` directory structure
2. Implement Phase 1: Core infrastructure (index.js, transport.js, middleware.js)
3. Implement Phase 2: Authentication (auth/* files)
4. Implement Phase 3: Tools (tools/* files)
5. Implement Phase 4: Yjs integration (yjs/* files)
6. Implement Phase 5: Streaming (streaming/* files)
7. Implement Phase 6: Frontend (client/src/components/Agent*.jsx)
