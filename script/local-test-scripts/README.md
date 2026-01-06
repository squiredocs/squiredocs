# Local MCP Test Scripts

Test scripts for demonstrating MCP functionality with visual highlighting.

## Prerequisites

- Server running on port 59177 (or set `MCP_PORT` environment variable)
- Valid dev user in database (default: `10937127-083d-4359-b0be-6c1390878780`)
- `jq` installed for JSON formatting (optional but recommended)

## Scripts

### swap-case.sh

Swaps the case of all letters in the document while preserving formatting (italics, links, etc.).

**What it demonstrates:**
- Mutation aggregation with expanding selections
- Progressive highlighting over ~500ms (5 chunks with 80-240ms random delays)
- Clears XPath highlights before showing mutations

**Usage:**
```bash
# Run with defaults
./script/local-test-scripts/swap-case.sh

# Specify document GUID
DOC_GUID=your-doc-guid ./script/local-test-scripts/swap-case.sh

# Use different port
MCP_PORT=3001 ./script/local-test-scripts/swap-case.sh
```

**Expected output:**
```json
{
  "success": true,
  "operationCount": 252,
  "summary": {
    "toArray": 109,
    "toDelta": 27,
    "insert": 54,
    "delete": 27,
    "format": 35
  }
}
```

### xpath-only.sh

Queries document elements using XPath without making any modifications.

**What it demonstrates:**
- Pure XPath highlighting
- Sequential element highlighting with 80-240ms random delays
- No document mutations

**Usage:**
```bash
# Run with defaults
./script/local-test-scripts/xpath-only.sh

# Specify document GUID
DOC_GUID=your-doc-guid ./script/local-test-scripts/xpath-only.sh

# Use different port
MCP_PORT=3001 ./script/local-test-scripts/xpath-only.sh
```

**Expected output:**
```json
{
  "success": true,
  "operationCount": 123,
  "summary": {
    "toArray": 123
  }
}
```

## Environment Variables

All scripts support these environment variables:

- `DOC_GUID` - Document GUID to modify (default: Green Day history document)
- `USER_ID` - User ID for JWT token (default: dev user)
- `MCP_PORT` - MCP server port (default: 59177)
- `MCP_SECRET` - JWT signing secret (default: dev secret)

## Visual Behavior

### swap-case.sh
1. XPath query highlights appear first (headings, paragraphs)
2. After ~1-2 seconds, XPath highlights are cleared
3. Mutation aggregation creates 5 expanding selections
4. Each selection expands to include more content
5. Random 80-240ms delays between expansions
6. Total highlighting time: ~500ms

### xpath-only.sh
1. Headings highlight sequentially
2. Paragraphs highlight sequentially
3. List items highlight sequentially
4. Random 80-240ms delays between each
5. No document changes

## Finding Your Document GUID

```bash
# Generate token
TOKEN=$(node -e "const jwt = require('jsonwebtoken'); console.log(jwt.sign({ userId: '10937127-083d-4359-b0be-6c1390878780', agentName: 'Test', agentId: 'test', scopes: ['read', 'write'], isAgent: true }, 'dev-mcp-secret-change-in-production', { expiresIn: '1h', issuer: 'collab-app-mcp' }));")

# List documents
curl -s -X POST http://localhost:59177/mcp \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $TOKEN" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"list_documents","arguments":{}}}' | jq .
```

## Troubleshooting

**"Document not found or you do not have access"**
- Check that the document GUID exists
- Verify the user ID has access to the document
- Check that the server is running

**"Invalid token"**
- Verify MCP_SECRET matches server configuration
- Check that the user exists in the database

**"Connection refused"**
- Verify the server is running on the specified port
- Check MCP_PORT environment variable

## Implementation Details

These scripts demonstrate the mutation aggregation system:

1. **Time-based buffering**: Mutations are buffered within 200ms windows
2. **Block-based chunking**: Groups mutations by document blocks to avoid position resolution issues
3. **Cumulative expansion**: Each chunk includes all previous mutations, creating an expanding effect
4. **Document state positions**: Uses current block boundaries rather than mutation positions to avoid deleted position issues

See `/Users/samg/dev/collab/server/mcp/mutation-aggregator.js` for implementation.
