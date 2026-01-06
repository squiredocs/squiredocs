#!/bin/bash
#
# Test script: XPath queries without modifications
# Demonstrates pure XPath highlighting with 80-240ms random delays
#

set -e

# Configuration
DOC_GUID="${DOC_GUID:-cd0eb033-f9f7-4925-85fb-c3b672be83d8}"
USER_ID="${USER_ID:-10937127-083d-4359-b0be-6c1390878780}"
MCP_PORT="${MCP_PORT:-59177}"
MCP_SECRET="${MCP_SECRET:-dev-mcp-secret-change-in-production}"

echo "Running xpath-only test script..."
echo "  Document: $DOC_GUID"
echo "  Port: $MCP_PORT"

# Generate JWT token
TOKEN=$(node -e "
const jwt = require('jsonwebtoken');
console.log(jwt.sign({
  userId: '$USER_ID',
  agentName: 'Claude Sonnet 4.5',
  agentId: 'test-agent',
  scopes: ['read', 'write'],
  isAgent: true
}, '$MCP_SECRET', {
  expiresIn: '1h',
  issuer: 'collab-app-mcp'
}));
")

# Create request payload
PAYLOAD=$(cat <<'EOF'
{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "tools/call",
  "params": {
    "name": "modify",
    "arguments": {
      "docGuid": "DOC_GUID_PLACEHOLDER",
      "script": "export default function edit(doc) {\n  // Query various elements in the document using XPath\n  \n  console.log('Searching for headings...');\n  const headings = xpath('//heading');\n  console.log(`Found ${headings.length} headings`);\n  \n  console.log('Searching for paragraphs...');\n  const paragraphs = xpath('//paragraph');\n  console.log(`Found ${paragraphs.length} paragraphs`);\n  \n  console.log('Searching for list items...');\n  const listItems = xpath('//list-item');\n  console.log(`Found ${listItems.length} list items`);\n  \n  console.log('XPath queries complete - no modifications made');\n}"
    }
  }
}
EOF
)

# Substitute the document GUID
PAYLOAD=$(echo "$PAYLOAD" | sed "s/DOC_GUID_PLACEHOLDER/$DOC_GUID/g")

# Make the request
echo ""
echo "Making MCP request..."
curl -s -X POST "http://localhost:$MCP_PORT/mcp" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $TOKEN" \
  -d "$PAYLOAD" | jq .

echo ""
echo "Done!"
