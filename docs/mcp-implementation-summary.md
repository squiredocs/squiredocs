# MCP Integration Implementation Summary

## Overview

We implemented a Model Context Protocol (MCP) integration that allows AI agents like Claude Desktop to interact with the collaborative editor. The integration uses an OAuth-style delegation model for secure agent authentication.

## What Was Built

### Authentication System
- **Agent Delegations**: Database-backed delegation records that grant agents permission to act on behalf of users
- **JWT Tokens**: Short-lived (1 hour) tokens for agent authentication, separate from user session tokens
- **Middleware**: Express middleware for validating agent tokens and checking scopes

### MCP Tools (5 total)

| Tool | Description |
|------|-------------|
| `list_documents` | List documents accessible to the user (filter: owned/shared_with_me/all) |
| `get_document` | Read document content in plain-text or structured JSON format |
| `create_document` | Create a new document with optional initial content |
| `update_document` | Modify document content (replace/insert/delete/append) |
| `share_document` | Share a document with another user by email |

### Infrastructure
- **HTTP API**: REST endpoints at `/mcp/*` for tool discovery and execution
- **Stdio Bridge**: `mcp-server.js` bridges Claude Desktop's stdio protocol to the HTTP API
- **Yjs Serialization**: Converts Yjs CRDT documents to readable text/JSON formats

## Files Created

```
server/mcp/
├── index.js                 # Main MCP router
├── auth/
│   ├── delegation.js        # Delegation CRUD operations
│   ├── jwt.js               # Agent token generation/verification
│   └── middleware.js        # Auth middleware
├── tools/
│   ├── index.js             # Tool registry
│   ├── list-documents.js
│   ├── get-document.js
│   ├── create-document.js
│   ├── update-document.js
│   └── share-document.js
└── yjs/
    └── serialization.js     # Yjs to text/JSON conversion

mcp-server.js                # Stdio bridge for Claude Desktop
script/generate-mcp-token.js # Token generation utility
migrations/010_mcp_agent_delegations.js  # Database schema
```

## Test Coverage

80 passing tests covering:
- Delegation lifecycle (create, revoke, expire)
- JWT generation and verification
- Authentication middleware
- All 5 tools with success and error cases
- Full integration workflows

## Usage

1. Start dev server: `kubectl exec -it deployment/app-dev -n collab -- sh -c "cd /local-dev && npm run dev"`
2. Start minikube tunnel: `minikube service app-dev-service --url -n collab`
3. Generate token: `kubectl exec deployment/app-dev -n collab -- sh -c "cd /local-dev && node script/generate-mcp-token.js"`
4. Configure Claude Desktop with token and minikube URL
5. Restart Claude Desktop

See `docs/mcp-quickstart.md` for detailed setup instructions.
