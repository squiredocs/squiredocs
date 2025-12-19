/**
 * read_document_block MCP Tool
 *
 * Reads a specific block element by index and highlights it with the agent's cursor.
 */
const Y = require('yjs');
const { getBlockDetails } = require('../yjs/block-structure');
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
const name = 'read_document_block';

const description = `Read a specific block from the document and highlight it for users.

═══════════════════════════════════════════════════════════════════════════
WORKFLOW STEP 2: READ BLOCKS
═══════════════════════════════════════════════════════════════════════════

After calling get_document_structure, use this tool to read specific blocks.
The block will be automatically highlighted so all users can see what you're reading.

TYPICAL USAGE PATTERN:
1. get_document_structure → See what blocks exist
2. read_document_block → Read the blocks you need to understand/modify
3. update_document_block → Make changes to specific blocks

═══════════════════════════════════════════════════════════════════════════
WHAT YOU GET BACK
═══════════════════════════════════════════════════════════════════════════

BLOCK METADATA:
- elementIndex: Which block this is (matches get_document_structure)
- type: Block type (paragraph, heading, bulletList, orderedList, codeBlock)
- attributes: Type-specific attributes (level for headings, language for code, etc.)
- textContent: Plain text content (all formatting removed)
- textLength: Character count

BLOCK STRUCTURE:
A formatted view showing the block and all nested content with offsets.
This is useful for understanding lists and other nested structures.

Example for a bullet list:
[0] <bulletList> offsets:0-50
  ↳ <listItem> offsets:0-20 "First item"
  ↳ <listItem> offsets:21-50 "Second item"

Example for a paragraph with formatting:
[0] <paragraph> offsets:0-25 "This is bold and italic text"

═══════════════════════════════════════════════════════════════════════════
PARAMETERS
═══════════════════════════════════════════════════════════════════════════

- docGuid: Document UUID (from list_documents or get_document_structure)
- elementIndex: Which block to read (from get_document_structure output)
- durationSeconds: How long to highlight (default: 30, max: 300)

═══════════════════════════════════════════════════════════════════════════
SIDE EFFECTS (VISUAL FEEDBACK)
═══════════════════════════════════════════════════════════════════════════

- The entire block is highlighted in the document
- All connected users see the highlight with your agent name
- Highlight automatically fades after durationSeconds
- This helps users understand what you're analyzing

═══════════════════════════════════════════════════════════════════════════
COMPLETE EXAMPLE
═══════════════════════════════════════════════════════════════════════════

// Step 1: Get the structure
const { structure, totalElements } = await get_document_structure({
  docGuid: "abc-123"
});
// Output shows: [0] paragraph, [1] heading, [2] bulletList

// Step 2: Read the bullet list at index 2
const block = await read_document_block({
  docGuid: "abc-123",
  elementIndex: 2,
  durationSeconds: 45
});

// Returns:
{
  elementIndex: 2,
  type: "bulletList",
  attributes: null,
  textContent: "First itemSecond item",
  textLength: 21,
  structure: "[0] <bulletList>\\n  ↳ <listItem> offsets:0-10...",
  highlighted: true
}

// Step 3: Now you can analyze or update this block`;

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
      description: 'The index of the block element to read',
    },
    durationSeconds: {
      type: 'integer',
      minimum: 1,
      maximum: 300,
      description: 'How long to highlight the block (1-300 seconds, default: 30)',
    },
  },
  required: ['docGuid', 'elementIndex'],
};

/**
 * Handler function for the tool
 * @param {object} args - Tool arguments
 * @param {string} args.docGuid - Document UUID
 * @param {number} args.elementIndex - Element index
 * @param {number} [args.durationSeconds=30] - Duration to highlight
 * @param {object} agentToken - Decoded agent JWT token
 * @returns {Promise<object>} Block details
 */
async function handler(args, agentToken) {
  if (!persistenceProvider) throw new Error('read_document_block tool not initialized');

  const { docGuid, elementIndex, durationSeconds = 30 } = args;
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

  // Load the Yjs document
  const ydoc = await loadYDoc(pool, docGuid);
  const xmlFragment = ydoc.get('default', Y.XmlFragment);

  // Get block details
  const blockDetails = getBlockDetails(xmlFragment, elementIndex);

  // Highlight the block by creating a selection at the start and end
  let highlighted = false;
  try {
    // Create relative positions for the entire block
    const anchorPos = Y.createRelativePositionFromTypeIndex(xmlFragment, elementIndex);
    // Head position should be at the next element (or end of fragment)
    const headIndex = elementIndex + 1;
    const headPos = Y.createRelativePositionFromTypeIndex(xmlFragment, headIndex);

    const anchor = Y.relativePositionToJSON(anchorPos);
    const head = Y.relativePositionToJSON(headPos);

    // Set agent selection
    const session = await agentPresence.getOrCreateSession(docGuid, agentToken, durationSeconds);
    session.awareness.setLocalStateField('cursor', { anchor, head });
    highlighted = true;
  } catch (error) {
    console.error('[read-document-block] Failed to set highlight:', error);
    // Don't fail the whole operation if highlighting fails
  }

  return {
    ...blockDetails,
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
