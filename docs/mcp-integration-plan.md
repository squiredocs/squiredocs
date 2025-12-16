# MCP Integration Plan

## Overview

This document outlines the plan to integrate Model Context Protocol (MCP) into the collaborative editor, enabling AI agents to access and edit documents in real-time with the same collaborative UX as human users.

## Goals

1. **Real-time AI Agent Access**: AI agents can read and write documents with live updates appearing to all users
2. **OAuth Delegation Model**: Agents authenticate via OAuth and inherit permissions from the delegating user
3. **Native Format Support**: Agents manipulate Yjs/TipTap documents directly (no markdown conversion)
4. **Streaming Updates**: Real-time bidirectional communication between agents and documents

## Architecture Overview

```
┌─────────────────┐         MCP Protocol         ┌──────────────────────┐
│   AI Agent      │ ◄──────────────────────────► │   MCP Server         │
│  (Claude, etc)  │   (HTTP + Server-Sent Events)│   (Express + SSE)    │
└─────────────────┘                               └──────────────────────┘
                                                            │
                                                            │ Auth + Permissions
                                                            ▼
                                                   ┌──────────────────────┐
                                                   │  Auth & User System  │
                                                   │  (OAuth Delegation)  │
                                                   └──────────────────────┘
                                                            │
                                                            │ WebSocket
                                                            ▼
                                                   ┌──────────────────────┐
                                                   │  Yjs WebSocket       │
                                                   │  (y-websocket)       │
                                                   └──────────────────────┘
                                                            │
                                                            ▼
                                                   ┌──────────────────────┐
                                                   │  PostgreSQL          │
                                                   │  (Persistence)       │
                                                   └──────────────────────┘
```

## Implementation Plan

### Phase 1: Core MCP Server Infrastructure

#### 1.1 MCP Server Setup

**Files to create:**
- `server/mcp/index.js` - Main MCP server setup
- `server/mcp/transport.js` - HTTP + SSE transport layer
- `server/mcp/tools/index.js` - Tool registry
- `server/mcp/middleware.js` - MCP-specific middleware

**Implementation details:**
- Create Express router for MCP endpoints
- Implement SSE (Server-Sent Events) for streaming tool responses
- Support MCP protocol message format (JSON-RPC style)
- Handle tool discovery, invocation, and streaming results

**Key endpoints:**
- `POST /mcp/tools/list` - List available tools
- `POST /mcp/tools/call` - Invoke a tool
- `GET /mcp/events/:callId` - SSE stream for tool results

#### 1.2 Tool Definitions

Create the following MCP tools in `server/mcp/tools/`:

**1. `list_documents`**
```javascript
{
  name: "list_documents",
  description: "List all documents accessible to the authenticated user",
  inputSchema: {
    type: "object",
    properties: {
      filter: {
        type: "string",
        enum: ["owned", "shared_with_me", "all"],
        default: "all"
      }
    }
  }
}
```

**2. `get_document`**
```javascript
{
  name: "get_document",
  description: "Read document content and metadata",
  inputSchema: {
    type: "object",
    properties: {
      docGuid: { type: "string", format: "uuid" },
      format: {
        type: "string",
        enum: ["yjs-json", "plain-text"],
        default: "plain-text"
      }
    },
    required: ["docGuid"]
  }
}
```

**3. `update_document`**
```javascript
{
  name: "update_document",
  description: "Update document content using Yjs operations",
  inputSchema: {
    type: "object",
    properties: {
      docGuid: { type: "string", format: "uuid" },
      operations: {
        type: "array",
        items: {
          type: "object",
          properties: {
            type: {
              type: "string",
              enum: ["insert", "delete", "replace"]
            },
            position: { type: "integer" },
            content: {
              oneOf: [
                { type: "string" },
                {
                  type: "object",
                  properties: {
                    type: { type: "string" },
                    content: {}
                  }
                }
              ]
            }
          },
          required: ["type", "position"]
        }
      },
      streamUpdates: {
        type: "boolean",
        default: true,
        description: "Stream real-time updates back to agent"
      }
    },
    required: ["docGuid", "operations"]
  }
}
```

**4. `watch_document`**
```javascript
{
  name: "watch_document",
  description: "Subscribe to real-time updates for a document",
  inputSchema: {
    type: "object",
    properties: {
      docGuid: { type: "string", format: "uuid" },
      duration: {
        type: "integer",
        default: 300,
        description: "Watch duration in seconds"
      }
    },
    required: ["docGuid"]
  }
}
```

**5. `create_document`**
```javascript
{
  name: "create_document",
  description: "Create a new document",
  inputSchema: {
    type: "object",
    properties: {
      title: { type: "string" },
      initialContent: { type: "string" }
    },
    required: ["title"]
  }
}
```

**6. `share_document`**
```javascript
{
  name: "share_document",
  description: "Share document with other users",
  inputSchema: {
    type: "object",
    properties: {
      docGuid: { type: "string", format: "uuid" },
      email: { type: "string", format: "email" },
      role: {
        type: "string",
        enum: ["viewer", "editor", "owner"]
      }
    },
    required: ["docGuid", "email", "role"]
  }
}
```

**7. `get_document_info`**
```javascript
{
  name: "get_document_info",
  description: "Get document metadata, permissions, and version history",
  inputSchema: {
    type: "object",
    properties: {
      docGuid: { type: "string", format: "uuid" }
    },
    required: ["docGuid"]
  }
}
```

### Phase 2: Authentication & Delegation

#### 2.1 OAuth Delegation Model

**Concept**: Users authorize AI agents to act on their behalf. The agent inherits the user's exact permissions but is tracked separately for audit purposes.

**Files to create:**
- `server/mcp/auth/delegation.js` - Delegation management
- `server/mcp/auth/oauth-flow.js` - OAuth flow for agents

**Database schema additions:**

```sql
-- Agent delegations table
CREATE TABLE agent_delegations (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  agent_id VARCHAR(255) NOT NULL,  -- Unique agent identifier (e.g., "claude-code:abc123")
  agent_name VARCHAR(255) NOT NULL,  -- Human-readable name (e.g., "Claude Code")
  agent_metadata JSONB,  -- Additional agent info
  scopes TEXT[] DEFAULT ARRAY['documents:read', 'documents:write', 'documents:share'],
  created_at TIMESTAMP DEFAULT NOW(),
  last_used_at TIMESTAMP,
  revoked_at TIMESTAMP,
  expires_at TIMESTAMP,
  UNIQUE(user_id, agent_id)
);

CREATE INDEX idx_agent_delegations_user ON agent_delegations(user_id);
CREATE INDEX idx_agent_delegations_agent ON agent_delegations(agent_id);
CREATE INDEX idx_agent_delegations_active ON agent_delegations(user_id, agent_id)
  WHERE revoked_at IS NULL;
```

**JWT token structure for agents:**
```javascript
{
  userId: 123,  // The delegating user's ID
  agentId: "claude-code:abc123",
  agentName: "Claude Code",
  delegationId: 456,
  scopes: ["documents:read", "documents:write"],
  iat: 1234567890,
  exp: 1234567890,
  issuer: "collab-app-mcp"
}
```

#### 2.2 OAuth Authorization Flow

**Authorization endpoint:**
- `GET /mcp/auth/authorize` - Initiate OAuth flow for agent
  - Parameters: `agent_id`, `agent_name`, `scopes`, `redirect_uri`
  - Shows consent screen to user
  - User approves/denies delegation

**Token exchange:**
- `POST /mcp/auth/token` - Exchange authorization code for access token
  - Returns agent JWT with delegation info

**Revocation:**
- `POST /mcp/auth/revoke` - Revoke agent delegation
- `GET /mcp/auth/delegations` - List user's active delegations

#### 2.3 Permission Checking

Extend `server/permissions.js` to handle agent delegations:

```javascript
// Check if user (or their agent) can perform action
async function canUserPerformAction(userIdOrToken, docGuid, action) {
  let userId;
  let isAgent = false;

  if (typeof userIdOrToken === 'object' && userIdOrToken.agentId) {
    // This is an agent token - check delegation
    const delegation = await checkDelegation(userIdOrToken);
    if (!delegation.isValid) {
      return false;
    }
    userId = userIdOrToken.userId;  // Use delegating user's ID
    isAgent = true;
  } else {
    userId = userIdOrToken;
  }

  // Check permissions using the user's ID (same logic as before)
  const hasPermission = await existingPermissionCheck(userId, docGuid, action);

  // Log agent actions for audit trail
  if (isAgent && hasPermission) {
    await logAgentAction(userIdOrToken, docGuid, action);
  }

  return hasPermission;
}
```

### Phase 3: Yjs/TipTap Native Format Support

#### 3.1 Yjs Format Adapter

**Files to create:**
- `server/mcp/yjs/adapter.js` - Yjs ↔ MCP format conversion
- `server/mcp/yjs/operations.js` - High-level operations on Yjs docs
- `server/mcp/yjs/serialization.js` - Serialize Yjs to readable format

**Key functions:**

```javascript
// Convert Yjs XmlFragment to AI-readable format
function yjsToReadableFormat(xmlFragment) {
  // Parse Yjs structure into a hierarchical representation
  // Example output:
  // [
  //   { type: 'heading', level: 1, content: 'Title' },
  //   { type: 'paragraph', content: 'First paragraph...' },
  //   { type: 'bulletList', items: ['Item 1', 'Item 2'] }
  // ]
}

// Convert AI operations to Yjs updates
function operationsToYjsUpdate(doc, operations) {
  // Take high-level operations and translate to Yjs XmlFragment updates
  // Handle: insert, delete, replace, format
}

// Apply operations to Yjs document
async function applyOperations(docGuid, operations, agentToken) {
  const doc = new Y.Doc();
  const provider = new WebsocketProvider(WS_URL, `s/${docGuid}`, doc);

  await waitForSync(provider);

  const xmlFragment = doc.get('default', Y.XmlFragment);

  // Apply each operation
  for (const op of operations) {
    switch (op.type) {
      case 'insert':
        insertContent(xmlFragment, op.position, op.content);
        break;
      case 'delete':
        deleteContent(xmlFragment, op.position, op.length);
        break;
      case 'replace':
        replaceContent(xmlFragment, op.position, op.length, op.content);
        break;
    }
  }

  // Let updates propagate, then cleanup
  await delay(100);
  provider.destroy();
}
```

#### 3.2 TipTap Node Handling

Support creating and manipulating TipTap node types:
- `paragraph`
- `heading` (h1, h2, h3)
- `bulletList` / `orderedList`
- `listItem`
- `codeBlock`
- `bold`, `italic`, `underline`, `strike` (marks)

**Example helper:**
```javascript
function createTipTapNode(type, content, attrs = {}) {
  const node = new Y.XmlElement(type);

  if (attrs) {
    Object.entries(attrs).forEach(([key, value]) => {
      node.setAttribute(key, value);
    });
  }

  if (typeof content === 'string') {
    const textNode = new Y.XmlText();
    textNode.insert(0, content);
    node.insert(0, [textNode]);
  } else if (Array.isArray(content)) {
    node.insert(0, content);
  }

  return node;
}
```

### Phase 4: Real-time Streaming

#### 4.1 WebSocket Integration for Agents

**Files to create:**
- `server/mcp/yjs/connection-manager.js` - Manage WebSocket connections for agents
- `server/mcp/streaming/updates.js` - Stream document updates to agents

**Connection management:**
```javascript
class AgentConnectionManager {
  constructor() {
    this.connections = new Map();  // docGuid -> { provider, clients }
  }

  async connectAgent(docGuid, agentToken) {
    const doc = new Y.Doc();
    const provider = new WebsocketProvider(
      WS_URL,
      `s/${docGuid}`,
      doc,
      {
        params: {
          agentToken,  // Include agent auth in WebSocket connection
          clientType: 'agent'
        }
      }
    );

    // Track as agent connection
    await this.registerConnection(docGuid, provider, agentToken);

    return { doc, provider };
  }

  async disconnectAgent(docGuid, agentToken) {
    // Clean up agent connection
  }
}
```

#### 4.2 Server-Sent Events for Streaming

Use SSE to stream updates back to agents during long-running operations:

```javascript
// In MCP tool handler
app.post('/mcp/tools/call', requireAgentAuth, async (req, res) => {
  const { tool, arguments: args, callId } = req.body;

  if (args.streamUpdates) {
    // Set up SSE for streaming
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');

    // Execute tool and stream results
    await executeToolWithStreaming(tool, args, req.agentToken, (update) => {
      res.write(`data: ${JSON.stringify(update)}\n\n`);
    });

    res.write('data: [DONE]\n\n');
    res.end();
  } else {
    // Regular JSON response
    const result = await executeTool(tool, args, req.agentToken);
    res.json(result);
  }
});
```

#### 4.3 Update Notifications

Stream document changes back to agent in real-time:

```javascript
async function watchDocument(docGuid, agentToken, onUpdate) {
  const { doc, provider } = await connectionManager.connectAgent(
    docGuid,
    agentToken
  );

  const xmlFragment = doc.get('default', Y.XmlFragment);

  // Listen for updates
  doc.on('update', (update, origin) => {
    if (origin !== 'agent') {  // Don't echo agent's own changes
      const readable = yjsToReadableFormat(xmlFragment);
      onUpdate({
        type: 'document_update',
        docGuid,
        timestamp: Date.now(),
        content: readable,
        updateSize: update.byteLength
      });
    }
  });

  // Return cleanup function
  return () => provider.destroy();
}
```

### Phase 5: Agent Presence & Attribution

#### 5.1 Agent Identity in Editor

Show agents as special "users" in the collaborative editor:

**Database addition:**
```sql
-- Add agent identifier to users table
ALTER TABLE users ADD COLUMN is_agent BOOLEAN DEFAULT FALSE;
ALTER TABLE users ADD COLUMN delegated_by_user_id INTEGER REFERENCES users(id);
ALTER TABLE users ADD COLUMN agent_metadata JSONB;
```

**Agent presence:**
- Agents connect to WebSocket with special `clientType: 'agent'` flag
- Frontend shows agent presence with robot icon
- Agent cursor/selections appear in different color (e.g., purple)

#### 5.2 Audit Logging

**Database schema:**
```sql
CREATE TABLE agent_activity_log (
  id SERIAL PRIMARY KEY,
  delegation_id INTEGER REFERENCES agent_delegations(id),
  agent_id VARCHAR(255) NOT NULL,
  user_id INTEGER REFERENCES users(id),
  action VARCHAR(100) NOT NULL,
  doc_guid UUID REFERENCES documents(guid),
  metadata JSONB,
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX idx_agent_activity_user ON agent_activity_log(user_id, created_at);
CREATE INDEX idx_agent_activity_doc ON agent_activity_log(doc_guid, created_at);
```

**Logged actions:**
- Document reads
- Document updates
- Document creation
- Sharing operations
- Version history access

### Phase 6: Frontend Integration

#### 6.1 Agent Management UI

**New components:**
- `client/src/components/AgentSettings.jsx` - Manage agent delegations
- `client/src/components/AgentAuthDialog.jsx` - OAuth consent screen

**Features:**
- List authorized agents
- Revoke agent access
- View agent activity log
- See agent presence in documents

#### 6.2 Agent Presence Indicators

Extend `client/src/components/Editor.jsx` to show agent presence:
- Robot icon for agents
- Different color scheme
- Tooltip showing "Agent: Claude Code (acting as You)"

### Phase 7: Security & Rate Limiting

#### 7.1 Rate Limiting

Implement rate limits for agent API calls:

```javascript
const rateLimit = require('express-rate-limit');

const mcpLimiter = rateLimit({
  windowMs: 60 * 1000,  // 1 minute
  max: 60,  // 60 requests per minute
  keyGenerator: (req) => req.agentToken.delegationId,
  message: 'Too many requests from this agent'
});

app.use('/mcp/', mcpLimiter);
```

#### 7.2 Scope Validation

Ensure agents only perform operations within their granted scopes:

```javascript
function requireScope(scope) {
  return (req, res, next) => {
    if (!req.agentToken.scopes.includes(scope)) {
      return res.status(403).json({
        error: 'Insufficient scope',
        required: scope,
        granted: req.agentToken.scopes
      });
    }
    next();
  };
}

// Usage
app.post('/mcp/tools/call',
  requireAgentAuth,
  requireScope('documents:write'),
  handleToolCall
);
```

#### 7.3 Delegation Expiry

- Delegations expire after configurable period (default: 30 days)
- Users can set custom expiry when authorizing
- Expired delegations automatically revoke access

## Implementation Phases

### Phase 1: Foundation (Week 1-2)
- [ ] MCP server infrastructure
- [ ] Basic tool definitions (list, get, update)
- [ ] HTTP + SSE transport layer
- [ ] Database schema for delegations

### Phase 2: Authentication (Week 2-3)
- [ ] OAuth delegation flow
- [ ] Agent JWT tokens
- [ ] Permission checking with delegation
- [ ] Frontend consent UI

### Phase 3: Yjs Integration (Week 3-4)
- [ ] Yjs format adapter
- [ ] TipTap node operations
- [ ] WebSocket connection for agents
- [ ] Document update streaming

### Phase 4: Real-time Features (Week 4-5)
- [ ] Agent presence in editor
- [ ] Bidirectional streaming
- [ ] Watch tool implementation
- [ ] Real-time update notifications

### Phase 5: Polish & Security (Week 5-6)
- [ ] Rate limiting
- [ ] Audit logging
- [ ] Agent activity UI
- [ ] Comprehensive testing
- [ ] Documentation

## Testing Strategy

### Unit Tests
- Tool handler functions
- Yjs format conversion
- Permission checking with delegation
- OAuth flow components

### Integration Tests
- MCP protocol compliance
- Agent authentication flow
- Document operations via MCP
- Real-time update propagation

### End-to-End Tests
- Complete agent workflow (auth → read → edit → watch)
- Multi-user + agent collaboration
- Permission enforcement
- Streaming scenarios

## Documentation

### For Users
- How to authorize AI agents
- Managing agent access
- Understanding agent presence in documents

### For Developers
- MCP server API reference
- Tool implementation guide
- Yjs format specification
- Agent integration examples

## Future Enhancements

1. **Fine-grained Scopes**: Document-specific permissions for agents
2. **Agent Sandboxing**: Restrict agents to specific documents or folders
3. **Collaborative Prompts**: Multi-agent editing with coordination
4. **Version History for Agents**: Track and revert agent changes separately
5. **Agent Templates**: Pre-configured agents for common tasks (summarize, format, etc.)

## Open Questions

1. **WebSocket Auth**: How to authenticate agents on WebSocket connections?
   - Option A: Send JWT in connection params
   - Option B: Initial HTTP handshake, then upgrade to WebSocket

2. **Concurrent Agent Editing**: How to handle multiple agents editing simultaneously?
   - Yjs handles conflicts automatically, but should we notify agents?

3. **Agent Quotas**: Should agents have usage limits separate from users?
   - Could implement token-based metering for LLM costs

4. **MCP Protocol Version**: Which MCP spec version to target?
   - Need to review latest MCP specification

## References

- [Model Context Protocol Specification](https://spec.modelcontextprotocol.io/)
- [Yjs Documentation](https://docs.yjs.dev/)
- [TipTap Schema](https://tiptap.dev/api/schema)
- [y-websocket Protocol](https://github.com/yjs/y-websocket)
