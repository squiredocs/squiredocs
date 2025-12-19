/**
 * get_document_structure MCP Tool
 *
 * Returns the document's block structure with element indices and offsets.
 * This helps agents understand the document structure and reference specific blocks.
 */
const Y = require('yjs');
const { formatDocumentStructure } = require('../yjs/block-structure');
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
const name = 'get_document_structure';

const description = `Get the document's block structure - THE STARTING POINT for all document editing.

═══════════════════════════════════════════════════════════════════════════
ABOUT THIS COLLABORATIVE EDITOR
═══════════════════════════════════════════════════════════════════════════

This is a real-time collaborative rich text editor using ProseMirror and Yjs:
- Documents are structured as BLOCKS (paragraphs, headings, lists, code blocks)
- Text within blocks can have MARKS (bold, italic, underline, links)
- Multiple users can edit simultaneously with conflict-free merging
- Changes sync in real-time across all connected users

═══════════════════════════════════════════════════════════════════════════
RECOMMENDED WORKFLOW
═══════════════════════════════════════════════════════════════════════════

1. START HERE: Call get_document_structure to see the document layout
2. READ: Use read_document_block to read specific blocks by their index
3. UPDATE: Use update_document_block to modify blocks (also by index)
4. HIGHLIGHT: All read/update operations automatically highlight changes for users

═══════════════════════════════════════════════════════════════════════════
WHAT THIS TOOL RETURNS
═══════════════════════════════════════════════════════════════════════════

A formatted view showing:
- Element indices [0], [1], [2] for top-level blocks
- Character offset ranges for precise text selection
- Nested structure (like list items) with ↳ markers
- Text previews so you can identify content

ELEMENT INDICES:
- Top-level blocks get indices: [0], [1], [2], etc.
- These are what you use with read_document_block and update_document_block
- Nested items (like list items) don't get separate indices
- They're accessed through their parent block

CHARACTER OFFSETS:
- Show position of text within each block
- Inclusive ranges: offsets:0-19 means characters 0 through 19
- Use with set_agent_selection to highlight specific text ranges
- Nested items show offsets relative to their top-level parent

═══════════════════════════════════════════════════════════════════════════
EXAMPLE OUTPUT
═══════════════════════════════════════════════════════════════════════════

[0] <paragraph> offsets:0-19 "First paragraph text"
[1] <heading> {"level":2} offsets:20-34 "Section Heading"
[2] <bulletList> offsets:35-100
  ↳ <listItem> offsets:0-20 "First list item"
  ↳ <listItem> offsets:21-45 "Second list item"
[3] <codeBlock> {"language":"javascript"} offsets:101-130 "const x = 42;"

The structure shows 4 top-level blocks (indices 0-3).
To read the bullet list: read_document_block({ elementIndex: 2 })
To update the heading: update_document_block({ elementIndex: 1, newContent: {...} })

═══════════════════════════════════════════════════════════════════════════
RETURNS
═══════════════════════════════════════════════════════════════════════════

- structure: Formatted text showing the complete block hierarchy
- totalElements: Number of top-level blocks you can read/update
- docGuid: The document UUID (for subsequent operations)`;

const inputSchema = {
  type: 'object',
  properties: {
    docGuid: {
      type: 'string',
      format: 'uuid',
      description: 'The document UUID',
    },
  },
  required: ['docGuid'],
};

/**
 * Handler function for the tool
 * @param {object} args - Tool arguments
 * @param {string} args.docGuid - Document UUID
 * @param {object} agentToken - Decoded agent JWT token
 * @returns {Promise<object>} { structure, totalElements, docGuid }
 */
async function handler(args, agentToken) {
  if (!persistenceProvider) throw new Error('get_document_structure tool not initialized');

  const { docGuid } = args;
  const userId = agentToken.userId;
  const pool = persistenceProvider.getPool();

  // Check if user has access to the document
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

  // Connect to the shared WebSocket-managed document
  // This ensures we see the latest real-time state
  const session = await agentPresence.getOrCreateSession(docGuid, agentToken, 30);
  const ydoc = session.provider.doc;
  const xmlFragment = ydoc.get('default', Y.XmlFragment);

  // Format the structure
  const structure = formatDocumentStructure(xmlFragment);
  const totalElements = xmlFragment.length;

  return {
    docGuid,
    structure,
    totalElements,
  };
}

module.exports = {
  init,
  name,
  description,
  inputSchema,
  handler,
};
