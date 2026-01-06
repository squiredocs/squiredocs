#!/bin/bash
#
# Test script: Swap case of all letters in the Green Day document
# Demonstrates mutation aggregation with expanding selections
#

set -e

# Configuration
DOC_GUID="${DOC_GUID:-cd0eb033-f9f7-4925-85fb-c3b672be83d8}"
USER_ID="${USER_ID:-10937127-083d-4359-b0be-6c1390878780}"
MCP_PORT="${MCP_PORT:-59177}"
MCP_SECRET="${MCP_SECRET:-dev-mcp-secret-change-in-production}"

echo "Running swap-case test script..."
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
      "script": "export default function edit(doc) {\n  console.log('Swapping case for all letters in the document...');\n  \n  // Helper to swap case of a string\n  function swapCase(text) {\n    return text.split('').map(char => {\n      if (char >= 'A' && char <= 'Z') {\n        return char.toLowerCase();\n      } else if (char >= 'a' && char <= 'z') {\n        return char.toUpperCase();\n      } else {\n        // Numbers, punctuation, spaces - leave unchanged\n        return char;\n      }\n    }).join('');\n  }\n  \n  // Get all paragraphs (including those in list items)\n  const paragraphs = xpath('//paragraph');\n  \n  let changedCount = 0;\n  \n  for (const para of paragraphs) {\n    const textNode = findTextNode(para);\n    if (!textNode) continue;\n    \n    // Get the delta which includes text and formatting\n    const delta = textNode.toDelta();\n    \n    // Build new segments with swapped case but same formatting\n    const segments = [];\n    \n    for (const op of delta) {\n      if (op.insert && typeof op.insert === 'string') {\n        const swapped = swapCase(op.insert);\n        \n        // Preserve formatting attributes\n        if (op.attributes) {\n          segments.push({ text: swapped, attrs: op.attributes });\n        } else {\n          segments.push(swapped);\n        }\n      }\n    }\n    \n    // Replace the paragraph's text with case-swapped version\n    if (segments.length > 0) {\n      const newTextNode = createFormattedText(segments);\n      para.delete(0, para.length);\n      para.insert(0, [newTextNode]);\n      changedCount++;\n    }\n  }\n  \n  // Also handle headings\n  const headings = xpath('//heading');\n  \n  for (const heading of headings) {\n    const textNode = findTextNode(heading);\n    if (!textNode) continue;\n    \n    const delta = textNode.toDelta();\n    const segments = [];\n    \n    for (const op of delta) {\n      if (op.insert && typeof op.insert === 'string') {\n        const swapped = swapCase(op.insert);\n        \n        if (op.attributes) {\n          segments.push({ text: swapped, attrs: op.attributes });\n        } else {\n          segments.push(swapped);\n        }\n      }\n    }\n    \n    if (segments.length > 0) {\n      const newTextNode = createFormattedText(segments);\n      heading.delete(0, heading.length);\n      heading.insert(0, [newTextNode]);\n      changedCount++;\n    }\n  }\n  \n  console.log('Swapped case in', changedCount, 'text blocks');\n  console.log('All formatting (italics, links) preserved!');\n}"
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
