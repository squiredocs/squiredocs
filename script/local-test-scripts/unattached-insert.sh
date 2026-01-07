#!/bin/bash
#
# Test script: Reproduce highlighting bug with unattached elements
#
# This demonstrates the bug where operations on unattached elements
# (created with new Y.XmlElement() but not yet in the document)
# get incorrectly highlighted because args[0] is misinterpreted
# as a block index instead of a text/child offset.
#

set -e

# Configuration
DOC_GUID="${DOC_GUID:-cd0eb033-f9f7-4925-85fb-c3b672be83d8}"
USER_ID="${USER_ID:-10937127-083d-4359-b0be-6c1390878780}"
MCP_PORT="${MCP_PORT:-59177}"
MCP_SECRET="${MCP_SECRET:-dev-mcp-secret-change-in-production}"

echo "Running unattached-insert test script (reproduces highlighting bug)..."
echo "  Document: $DOC_GUID"
echo "  Port: $MCP_PORT"
echo ""
echo "BUG: Watch the editor - highlighting should appear at the END of the document"
echo "     where new content is added, but it incorrectly highlights block 0 (the first block)."
echo ""

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

# Create request payload - mimics the prod script that failed
PAYLOAD=$(cat <<'EOF'
{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "tools/call",
  "params": {
    "name": "modify",
    "arguments": {
      "docGuid": "DOC_GUID_PLACEHOLDER",
      "script": "export default function edit(doc) {\n  console.log('Adding content via unattached elements (BUG REPRO)...');\n  console.log('Document length before:', doc.length);\n  \n  // Add empty paragraph for spacing\n  const emptyPara = new Y.XmlElement('paragraph');\n  doc.insert(doc.length, [emptyPara]);\n  \n  // Create paragraph with text BEFORE attaching to document\n  // This is where the bug occurs:\n  // - text3.insert(0, ...) records path=[], args=[0, 'text']\n  // - Code misinterprets 0 as block index, highlights block 0 instead of new content\n  const para3 = new Y.XmlElement('paragraph');\n  const text3 = new Y.XmlText();\n  text3.insert(0, 'This text was inserted into an UNATTACHED element. The highlighting should appear here at the end of the document, not at block 0.');\n  para3.insert(0, [text3]);\n  \n  doc.insert(doc.length, [para3]);\n  \n  console.log('Document length after:', doc.length);\n  console.log('New content added at the END - but highlighting likely appeared at block 0!');\n}"
    }
  }
}
EOF
)

# Substitute the document GUID
PAYLOAD=$(echo "$PAYLOAD" | sed "s/DOC_GUID_PLACEHOLDER/$DOC_GUID/g")

# Make the request
echo "Making MCP request..."
curl -s -X POST "http://localhost:$MCP_PORT/mcp" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $TOKEN" \
  -d "$PAYLOAD" | jq .

echo ""
echo "Done! Check the editor - did highlighting appear at block 0 (wrong) or at the end (correct)?"
