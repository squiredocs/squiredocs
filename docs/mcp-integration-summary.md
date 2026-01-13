# MCP Integration Summary

## Overview

Adding Model Context Protocol (MCP) support to enable AI agents (like Claude) to access and collaboratively edit documents in real-time, with the same UX as human users.

## Key Design Principles

1. **Native Format**: Agents work directly with Yjs/TipTap format (no markdown conversion)
2. **OAuth Delegation**: Agents authenticate and inherit user permissions
3. **Real-time**: Bidirectional streaming of document updates
4. **Transparent**: Agent actions appear in real-time to all users

## Architecture at a Glance

```
AI Agent ←→ MCP Server ←→ Auth/Delegation ←→ Yjs WebSocket ←→ PostgreSQL
                                    ↓
                           Frontend (Shows agent presence)
```

## Core Components

### 1. MCP Server (`server/mcp/`)
- **Transport**: HTTP + Server-Sent Events (SSE) for streaming
- **Protocol**: JSON-RPC style MCP messages
- **Endpoints**:
  - `POST /mcp/tools/list` - Discover available tools
  - `POST /mcp/tools/call` - Execute a tool
  - `GET /mcp/events/:callId` - Stream tool results via SSE

### 2. MCP Tools

| Tool | Purpose |
|------|---------|
| `list_documents` | List user's accessible documents |
| `get_document` | Read document content (plain-text or Yjs JSON) |
| `update_document` | Edit document via Yjs operations |
| `watch_document` | Subscribe to real-time updates |
| `create_document` | Create new document |
| `share_document` | Share with other users |
| `get_document_info` | Get metadata, permissions, version history |

### 3. OAuth Delegation Model

**Mental Model**: User delegates their permissions to an AI agent. Agent acts on user's behalf with exact same permissions.

**Flow**:
```
1. Agent requests authorization (shows agent name, requested scopes)
2. User approves via consent screen in web UI
3. Backend creates delegation record
4. Agent receives JWT with delegation info
5. All agent actions inherit user's permissions
6. Agent actions are logged for audit trail
```

**JWT Structure**:
```json
{
  "userId": "uuid-of-delegating-user",
  "agentId": "claude-code:abc123",
  "agentName": "Claude Code",
  "delegationId": "uuid-of-delegation",
  "scopes": ["documents:read", "documents:write"],
  "issuer": "collab-app-mcp"
}
```

### 4. Database Schema

**New Tables**:

```sql
-- Track agent delegations
agent_delegations (
  id, user_id, agent_id, agent_name, scopes,
  created_at, last_used_at, revoked_at, expires_at
)

-- Audit log for agent actions
agent_activity_log (
  id, delegation_id, agent_id, user_id, action,
  doc_guid, metadata, created_at
)
```

### 5. Yjs/TipTap Integration

**Document Format Handling**:
- Read: Convert Yjs XmlFragment → readable hierarchical structure for AI
- Write: Convert high-level operations → Yjs XmlFragment updates
- No markdown conversion! Work directly with TipTap nodes (paragraph, heading, list, etc.)

**Example Readable Format**:
```json
[
  { "type": "heading", "level": 1, "content": "My Document" },
  { "type": "paragraph", "content": "First paragraph..." },
  { "type": "bulletList", "items": ["Item 1", "Item 2"] }
]
```

**Update Operations**:
```json
{
  "operations": [
    {
      "type": "insert",
      "position": 2,
      "content": { "type": "paragraph", "text": "New paragraph" }
    },
    {
      "type": "delete",
      "position": 5,
      "length": 1
    }
  ]
}
```

### 6. Real-time Streaming

**Agent → Document**: WebSocket connection via y-websocket provider
**Document → Agent**: Server-Sent Events (SSE) stream updates back to agent

**Watch Mode**: Agent subscribes to document updates and receives real-time notifications as users edit.

### 7. Frontend Integration

**Agent Presence**:
- Agents appear as special "users" in the editor
- Robot icon instead of avatar
- Different cursor color (e.g., purple)
- Tooltip: "Agent: Claude Code (acting as You)"

**Agent Management UI**:
- Settings page to view/revoke agent delegations
- Activity log showing agent actions
- OAuth consent screen for authorizing new agents

## Security Features

1. **Scope-based permissions**: Agents only access granted scopes
2. **Rate limiting**: 60 requests/minute per agent
3. **Audit logging**: All agent actions logged with user attribution
4. **Expiration**: Delegations auto-expire after 30 days (configurable)
5. **Revocation**: Users can revoke agent access anytime

## Implementation Phases

| Phase | Focus | Duration |
|-------|-------|----------|
| 1 | MCP server infrastructure, basic tools | 1-2 weeks |
| 2 | OAuth delegation, authentication | 1 week |
| 3 | Yjs format adapter, TipTap operations | 1-2 weeks |
| 4 | Real-time streaming, agent presence | 1 week |
| 5 | Polish, security, testing | 1 week |

**Total estimate**: 5-6 weeks

## Example Usage Flow

### Agent Edits Document

1. User authorizes "Claude Code" agent (one-time OAuth)
2. Agent calls `list_documents` → gets list of user's docs
3. Agent calls `get_document(docGuid)` → reads current content
4. Agent calls `update_document(docGuid, operations)` → makes edits
5. User sees agent's edits appear in real-time in their editor
6. Agent cursor/selection visible to user (purple, with robot icon)

### Agent Watches Document

1. Agent calls `watch_document(docGuid, duration=300)`
2. Opens SSE stream to receive updates
3. User types in editor
4. Agent receives real-time updates via SSE stream:
   ```json
   {
     "type": "document_update",
     "docGuid": "...",
     "content": [...],
     "timestamp": 1234567890
   }
   ```
5. Agent can react to changes and make further edits

## Open Questions & Decisions Needed

### 1. WebSocket Authentication for Agents
**Question**: How should agents authenticate on WebSocket connections?

**Options**:
- **A**: Include JWT in connection URL params (simpler, but token in URL)
- **B**: HTTP handshake first, then upgrade to WebSocket (more secure)
- **C**: Custom WebSocket auth message after connection (most flexible)

**Recommendation**: Option A for MVP (simpler), migrate to C later for security

### 2. MCP Protocol Version
**Question**: Which MCP specification version to target?

**Action needed**: Review latest [MCP spec](https://spec.modelcontextprotocol.io/) and confirm version

### 3. Concurrent Agent Editing
**Question**: Multiple agents editing same document simultaneously - any special handling?

**Answer**: Yjs CRDT handles conflicts automatically. No special logic needed, but could add:
- Notification when multiple agents active
- "Agent is typing..." indicators

### 4. Agent Quotas
**Question**: Should agents have usage limits separate from users?

**Options**:
- No limits (inherit from user)
- Per-agent request limits
- Token-based metering for LLM costs

**Recommendation**: Start with simple rate limiting (60 req/min), add metering later if needed

## Breaking Changes

### BREAKING: create_document_version Removed

The `create_document_version` tool has been **removed** and replaced with the more powerful `set_document_version_name` tool.

**Migration:**
```javascript
// OLD (no longer works):
await create_document_version({ docGuid, name: "Draft 1" });

// NEW (creates a named version):
await set_document_version_name({ docGuid, name: "Draft 1" });
```

**New capabilities:**
```javascript
// Rename existing version
await set_document_version_name({
  docGuid,
  versionId: "uuid-here",
  name: "New Name"
});

// Delete named version (set name to null)
await set_document_version_name({
  docGuid,
  versionId: "uuid-here",
  name: null
});
```

The new tool provides a unified interface for all named version operations:
- **CREATE**: Name current state (no versionId)
- **UPDATE**: Rename existing (versionId + name)
- **DELETE**: Remove name (versionId + name: null)

## Next Steps

1. **Review this plan**: Discuss design decisions and open questions
2. **Confirm requirements**: Ensure alignment with your vision
3. **Set up development**: Create `server/mcp/` directory structure
4. **Phase 1 kickoff**: Start with MCP server infrastructure and basic tools

## Resources

- [MCP Specification](https://spec.modelcontextprotocol.io/)
- [Yjs Documentation](https://docs.yjs.dev/)
- [TipTap Schema Reference](https://tiptap.dev/api/schema)
- [y-websocket Protocol](https://github.com/yjs/y-websocket)
- [Server-Sent Events Guide](https://developer.mozilla.org/en-US/docs/Web/API/Server-sent_events)
