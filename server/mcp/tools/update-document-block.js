/**
 * update_document_block MCP Tool
 *
 * Updates a specific block element by replacing it with new content and highlights the change.
 */
const Y = require('yjs');
const { buildYjsNode } = require('../yjs/node-builder');
const { loadYDoc } = require('../yjs/serialization');
const agentPresence = require('../agent-presence');

// Persistence provider - set by init function
let persistenceProvider = null;

/**
 * Initialize the tool with a persistence provider
 * @param {PostgresPersistence} persistence - PostgreSQL persistence provider
 */
function init(persistence) {
  persistenceProvider = persistence;
}

/**
 * Tool definition for MCP discovery
 */
const name = 'update_document_block';

const description = `Update a block by replacing it with new content - WORKFLOW STEP 3.

═══════════════════════════════════════════════════════════════════════════
WORKFLOW STEP 3: UPDATE BLOCKS
═══════════════════════════════════════════════════════════════════════════

After reading blocks with read_document_block, use this to make changes.
The change is automatically highlighted so users see what you modified.

RECOMMENDED PATTERN:
1. get_document_structure → See what exists
2. read_document_block → Read the block you want to change
3. update_document_block → Replace with new content (THIS TOOL)

═══════════════════════════════════════════════════════════════════════════
UNDERSTANDING BLOCKS vs MARKS
═══════════════════════════════════════════════════════════════════════════

BLOCKS = Document Structure (what you're updating with this tool)
  - paragraph: Regular text block
  - heading: Section headings (level 1-3)
  - bulletList: Unordered list container
  - orderedList: Numbered list container
  - listItem: Individual item in a list
  - codeBlock: Code with optional syntax highlighting

MARKS = Inline Formatting (within blocks)
  - bold: Bold text
  - italic: Italic text
  - underline: Underlined text
  - strike: Strikethrough text
  - link: Hyperlink with href attribute

You can combine blocks and marks to create rich formatted documents!

═══════════════════════════════════════════════════════════════════════════
BLOCK EXAMPLES - COPY THESE PATTERNS
═══════════════════════════════════════════════════════════════════════════

1. SIMPLE PARAGRAPH (plain text):
{
  "type": "paragraph",
  "content": "This is plain text with no formatting"
}

2. PARAGRAPH WITH MARKS (formatted text):
{
  "type": "paragraph",
  "content": [
    "Normal text, ",
    { "text": "bold text", "marks": ["bold"] },
    ", ",
    { "text": "italic text", "marks": ["italic"] },
    ", and ",
    { "text": "bold italic", "marks": ["bold", "italic"] },
    "."
  ]
}

3. PARAGRAPH WITH LINK:
{
  "type": "paragraph",
  "content": [
    "Check out ",
    {
      "text": "this link",
      "marks": [{ "type": "link", "href": "https://example.com" }]
    },
    " for more info."
  ]
}

4. HEADING (level 1, 2, or 3):
{
  "type": "heading",
  "level": 2,
  "content": "Section Title"
}

5. BULLET LIST (unordered):
{
  "type": "bulletList",
  "children": [
    { "type": "listItem", "content": "First item" },
    { "type": "listItem", "content": "Second item" },
    {
      "type": "listItem",
      "content": [
        "Item with ",
        { "text": "bold text", "marks": ["bold"] }
      ]
    }
  ]
}

6. NUMBERED LIST (ordered):
{
  "type": "orderedList",
  "children": [
    { "type": "listItem", "content": "First step" },
    { "type": "listItem", "content": "Second step" },
    { "type": "listItem", "content": "Third step" }
  ]
}

7. CODE BLOCK (with syntax highlighting):
{
  "type": "codeBlock",
  "language": "javascript",
  "content": "const greeting = 'Hello, world!';"
}

8. NESTED LIST (list within list):
{
  "type": "bulletList",
  "children": [
    { "type": "listItem", "content": "Parent item" },
    {
      "type": "listItem",
      "content": "Parent with nested list",
      "children": [
        {
          "type": "bulletList",
          "children": [
            { "type": "listItem", "content": "Nested item 1" },
            { "type": "listItem", "content": "Nested item 2" }
          ]
        }
      ]
    }
  ]
}

═══════════════════════════════════════════════════════════════════════════
PARAMETERS
═══════════════════════════════════════════════════════════════════════════

- docGuid: Document UUID
- elementIndex: Which block to replace (from get_document_structure)
- newContent: New block structure (see examples above)
- durationSeconds: How long to highlight the change (default: 45)

═══════════════════════════════════════════════════════════════════════════
COMPLETE WORKFLOW EXAMPLE
═══════════════════════════════════════════════════════════════════════════

// Step 1: See what's in the document
const { structure } = await get_document_structure({ docGuid: "abc-123" });
// Shows: [0] paragraph, [1] heading, [2] paragraph

// Step 2: Read the paragraph at index 2
const block = await read_document_block({
  docGuid: "abc-123",
  elementIndex: 2
});
// Returns: { type: "paragraph", content: "Old text..." }

// Step 3: Replace it with a formatted paragraph
await update_document_block({
  docGuid: "abc-123",
  elementIndex: 2,
  newContent: {
    type: "paragraph",
    content: [
      "Updated text with ",
      { text: "bold", marks: ["bold"] },
      " and ",
      { text: "italic", marks: ["italic"] },
      " formatting!"
    ]
  },
  durationSeconds: 60
});

// The block is replaced and highlighted for all users!

═══════════════════════════════════════════════════════════════════════════
IMPORTANT NOTES
═══════════════════════════════════════════════════════════════════════════

- Replaces the ENTIRE block (not just parts of it)
- Changes sync to all users in real-time
- Automatically saved to database
- Requires "editor" or "owner" role (viewers cannot edit)
- Block type can change (e.g., paragraph → heading → list)
- Changes are highlighted so users see what you modified`;

const inputSchema = {
  type: 'object',
  properties: {
    docGuid: {
      type: 'string',
      format: 'uuid',
      description: 'The document UUID',
    },
    elementIndex: {
      type: 'integer',
      minimum: 0,
      description: 'The index of the block element to update',
    },
    newContent: {
      type: 'object',
      description: 'The new block structure to replace the old one',
      properties: {
        type: {
          type: 'string',
          enum: ['paragraph', 'heading', 'bulletList', 'orderedList', 'codeBlock', 'listItem'],
          description: 'Block type',
        },
        content: {
          description: 'Text content (string or array with formatting)',
        },
        children: {
          type: 'array',
          description: 'Child nodes (for lists)',
        },
        level: {
          type: 'integer',
          minimum: 1,
          maximum: 3,
          description: 'Heading level (1-3)',
        },
        language: {
          type: 'string',
          description: 'Code block language',
        },
      },
      required: ['type'],
    },
    durationSeconds: {
      type: 'integer',
      minimum: 1,
      maximum: 300,
      description: 'How long to highlight the change (1-300 seconds, default: 45)',
    },
  },
  required: ['docGuid', 'elementIndex', 'newContent'],
};

/**
 * Handler function for the tool
 * @param {object} args - Tool arguments
 * @param {string} args.docGuid - Document UUID
 * @param {number} args.elementIndex - Element index
 * @param {object} args.newContent - New block structure
 * @param {number} [args.durationSeconds=45] - Duration to highlight
 * @param {object} agentToken - Decoded agent JWT token
 * @returns {Promise<object>} Update result
 */
async function handler(args, agentToken) {
  if (!persistenceProvider) throw new Error('update_document_block tool not initialized');

  const { docGuid, elementIndex, newContent, durationSeconds = 45 } = args;
  const userId = agentToken.userId;
  const pool = persistenceProvider.getPool();

  // Check if user has editor access to the document
  const accessResult = await pool.query(
    `SELECT d.id, ds.role
     FROM documents d
     JOIN document_shares ds ON d.id = ds.doc_id AND ds.user_id = $2
     WHERE d.id = $1`,
    [docGuid, userId]
  );

  if (accessResult.rows.length === 0) {
    throw new Error('Document not found or you do not have access');
  }

  const { role } = accessResult.rows[0];
  if (role === 'viewer') {
    throw new Error('Viewer role cannot update document blocks');
  }

  // Connect to the shared WebSocket-managed document
  // This ensures changes sync to all connected clients in real-time
  const session = await agentPresence.getOrCreateSession(docGuid, agentToken, durationSeconds);
  const ydoc = session.provider.doc;
  const xmlFragment = ydoc.get('default', Y.XmlFragment);

  // Validate element index
  if (elementIndex >= xmlFragment.length) {
    throw new Error(
      `Element index ${elementIndex} out of bounds (document has ${xmlFragment.length} elements)`
    );
  }

  // Get the old element for reference
  const oldElement = xmlFragment.get(elementIndex);
  const oldType = oldElement.nodeName;

  // Perform the update in a transaction
  ydoc.transact(() => {
    // Delete the old element
    xmlFragment.delete(elementIndex, 1);

    // Build and insert the new element
    const newNode = buildYjsNode(newContent);
    xmlFragment.insert(elementIndex, [newNode]);
  });

  // No need to manually persist - the y-websocket server's update listener
  // automatically persists all changes to the database

  // Highlight the updated block
  let highlighted = false;
  try {
    // Create relative positions for the block
    const anchorPos = Y.createRelativePositionFromTypeIndex(xmlFragment, elementIndex);
    const headIndex = elementIndex + 1;
    const headPos = Y.createRelativePositionFromTypeIndex(xmlFragment, headIndex);

    const anchor = Y.relativePositionToJSON(anchorPos);
    const head = Y.relativePositionToJSON(headPos);

    // Set cursor on the session we already created
    session.awareness.setLocalStateField('cursor', { anchor, head });
    highlighted = true;
  } catch (error) {
    console.error('[update-document-block] Failed to set highlight:', error);
  }

  return {
    success: true,
    elementIndex,
    oldType,
    newType: newContent.type,
    highlighted,
  };
}

module.exports = {
  init,
  name,
  description,
  inputSchema,
  handler,
};
