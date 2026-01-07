#!/bin/bash
#
# Test script: Append several paragraphs to the end of a document
# Demonstrates selection animation for inserted content
#

set -e

# Configuration
DOC_GUID="${DOC_GUID:-cd0eb033-f9f7-4925-85fb-c3b672be83d8}"
USER_ID="${USER_ID:-10937127-083d-4359-b0be-6c1390878780}"
MCP_PORT="${MCP_PORT:-59177}"
MCP_SECRET="${MCP_SECRET:-dev-mcp-secret-change-in-production}"

echo "Running append-paragraphs test script..."
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
      "script": "export default function edit(doc) {\n  console.log('Appending paragraphs to the end of the document...');\n  \n  // Create a heading\n  const heading = new Y.XmlElement('heading');\n  heading.setAttribute('level', 2);\n  const headingText = new Y.XmlText();\n  headingText.insert(0, 'Additional Notes');\n  heading.insert(0, [headingText]);\n  doc.insert(doc.length, [heading]);\n  \n  // Paragraph 1 - plain text\n  const para1 = new Y.XmlElement('paragraph');\n  const text1 = new Y.XmlText();\n  text1.insert(0, 'This is the first paragraph of additional content. It contains some basic text to demonstrate how new content appears in the document with selection animation.');\n  para1.insert(0, [text1]);\n  doc.insert(doc.length, [para1]);\n  \n  // Paragraph 2 - with bold text\n  const para2 = new Y.XmlElement('paragraph');\n  const text2 = createFormattedText([\n    'The second paragraph includes some ',\n    { text: 'bold text', attrs: { bold: true } },\n    ' and also some ',\n    { text: 'italic text', attrs: { italic: true } },\n    ' to show formatting is preserved during animation.'\n  ]);\n  para2.insert(0, [text2]);\n  doc.insert(doc.length, [para2]);\n  \n  // Paragraph 3 - with a link\n  const para3 = new Y.XmlElement('paragraph');\n  const text3 = createFormattedText([\n    'This paragraph contains a link to ',\n    { text: 'Example Website', attrs: { link: { href: 'https://example.com' } } },\n    ' which should also animate correctly when selected.'\n  ]);\n  para3.insert(0, [text3]);\n  doc.insert(doc.length, [para3]);\n  \n  // Paragraph 4 - longer content\n  const para4 = new Y.XmlElement('paragraph');\n  const text4 = new Y.XmlText();\n  text4.insert(0, 'Finally, here is a longer paragraph with more substantial content. This helps test how the selection animation handles larger blocks of text that might wrap across multiple lines in the editor. The animation should smoothly highlight this entire paragraph as part of the mutation feedback.');\n  para4.insert(0, [text4]);\n  doc.insert(doc.length, [para4]);\n  \n  console.log('Added 1 heading and 4 paragraphs to the document');\n}"
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
