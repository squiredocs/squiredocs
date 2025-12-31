/**
 * read_document_blocks MCP Tool
 *
 * Reads one or more block elements and highlights them with the agent's cursor.
 */
const Y = require('yjs');
const { getBlockDetails } = require('../yjs/block-structure');
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
const name = 'read_document_blocks';

const description = `Read one or more blocks from the document and highlight them for users.

═══════════════════════════════════════════════════════════════════════════
WORKFLOW STEP 2: READ BLOCKS
═══════════════════════════════════════════════════════════════════════════

After calling get_document_structure, use this tool to read specific blocks.
The blocks will be automatically highlighted so all users can see what you're reading.

TYPICAL USAGE PATTERN:
1. get_document_structure → See what blocks exist
2. read_document_blocks → Read the blocks you need to understand/modify
3. insert/delete/replace_document_blocks → Make changes

═══════════════════════════════════════════════════════════════════════════
HOW IT WORKS
═══════════════════════════════════════════════════════════════════════════

- Reads blocks from fromIndex to toIndex (INCLUSIVE)
- If toIndex is omitted, reads only the single block at fromIndex
- Highlights the entire range for visual feedback
- Returns array of block details

Examples:
  // Read single block
  read_document_blocks({ fromIndex: 5 })
  → Reads 1 block: index 5

  // Read range of blocks
  read_document_blocks({ fromIndex: 5, toIndex: 10 })
  → Reads 6 blocks: indices 5, 6, 7, 8, 9, 10

═══════════════════════════════════════════════════════════════════════════
WHAT YOU GET BACK
═══════════════════════════════════════════════════════════════════════════

For each block:
- elementIndex: Which block this is (matches get_document_structure)
- type: Block type (paragraph, heading, bulletList, orderedList, codeBlock)
- attributes: Type-specific attributes (level for headings, language for code, etc.)
- textContent: Plain text content (all formatting removed)
- textLength: Character count
- structure: Formatted view showing the block and all nested content with offsets

═══════════════════════════════════════════════════════════════════════════
PARAMETERS
═══════════════════════════════════════════════════════════════════════════

- docGuid: Document UUID (required)
- fromIndex: Starting index (required)
- toIndex: Ending index (optional, defaults to fromIndex for single block)
- durationSeconds: How long to keep selection active (default: 30)

IMPORTANT: Both fromIndex and toIndex are INCLUSIVE.
  Range 5-10 reads: [5], [6], [7], [8], [9], [10] = 6 blocks total
  Single block: fromIndex: 5 (no toIndex) reads only [5]

═══════════════════════════════════════════════════════════════════════════
SIDE EFFECTS (VISUAL FEEDBACK)
═══════════════════════════════════════════════════════════════════════════

- The entire range is highlighted in the document
- All connected users see the highlight with your agent name
- Highlight stays active for 30 seconds (or until another tool call)
- This helps users understand what you're analyzing

═══════════════════════════════════════════════════════════════════════════
COMPLETE EXAMPLE
═══════════════════════════════════════════════════════════════════════════

// Step 1: Get the structure
const { structure, totalElements } = await get_document_structure({
  docGuid: "abc-123"
});
// Output shows: [0] paragraph, [1] heading, [2] bulletList, [3] paragraph

// Step 2: Read multiple blocks
const result = await read_document_blocks({
  docGuid: "abc-123",
  fromIndex: 1,
  toIndex: 2,
  durationSeconds: 45
});

// Returns:
{
  blocks: [
    {
      elementIndex: 1,
      type: "heading",
      attributes: { level: 2 },
      textContent: "Section Title",
      textLength: 13,
      structure: "[1] <heading level=2> offsets:0-13 \"Section Title\""
    },
    {
      elementIndex: 2,
      type: "bulletList",
      attributes: null,
      textContent: "First itemSecond item",
      textLength: 21,
      structure: "[2] <bulletList>\\n  ↳ <listItem> offsets:0-10..."
    }
  ],
  readCount: 2,
  highlighted: true
}

// Step 3: Now you can analyze or modify these blocks`;

const inputSchema = {
  type: 'object',
  properties: {
    docGuid: {
      type: 'string',
      format: 'uuid',
      description: 'The document UUID',
    },
    fromIndex: {
      type: 'integer',
      minimum: 0,
      description: 'Starting index (inclusive). For single block, only provide this.',
    },
    toIndex: {
      type: 'integer',
      minimum: 0,
      description: 'Ending index (inclusive, optional). Omit for single block.',
    },
    durationSeconds: {
      type: 'integer',
      minimum: 1,
      maximum: 300,
      description: 'How long to keep selection active (1-300 seconds, default: 30)',
    },
  },
  required: ['docGuid', 'fromIndex'],
};

/**
 * Handler function for the tool
 * @param {object} args - Tool arguments
 * @param {string} args.docGuid - Document UUID
 * @param {number} args.fromIndex - Starting index (inclusive)
 * @param {number} [args.toIndex] - Ending index (inclusive, defaults to fromIndex)
 * @param {number} [args.durationSeconds=30] - Duration to keep selection active
 * @param {object} agentToken - Decoded agent JWT token
 * @returns {Promise<object>} Block details
 */
async function handler(args, agentToken) {
  if (!persistenceProvider) throw new Error('read_document_blocks tool not initialized');

  const { docGuid, fromIndex, durationSeconds = 30 } = args;
  // Default toIndex to fromIndex for single block reading
  const toIndex = args.toIndex !== undefined ? args.toIndex : fromIndex;
  const userId = agentToken.userId;
  const pool = persistenceProvider.getPool();

  // Validate range
  if (fromIndex > toIndex) {
    throw new Error(
      `Invalid range: fromIndex (${fromIndex}) must be <= toIndex (${toIndex})`
    );
  }

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
  const session = await agentPresence.getOrCreateSession(docGuid, agentToken, durationSeconds);
  const ydoc = session.provider.doc;
  const xmlFragment = ydoc.get('default', Y.XmlFragment);

  // Validate indices
  if (fromIndex >= xmlFragment.length) {
    throw new Error(
      `fromIndex ${fromIndex} out of bounds (document has ${xmlFragment.length} elements)`
    );
  }

  if (toIndex >= xmlFragment.length) {
    throw new Error(
      `toIndex ${toIndex} out of bounds (document has ${xmlFragment.length} elements)`
    );
  }

  // Read all blocks in the range
  const blocks = [];
  for (let i = fromIndex; i <= toIndex; i++) {
    const blockDetails = getBlockDetails(xmlFragment, i);
    blocks.push(blockDetails);
  }

  // Highlight the entire range
  // Keep the selection active for the duration (30 seconds by default)
  // It will automatically clear when the session expires or another tool call changes it
  let highlighted = false;
  try {
    const anchorPos = Y.createRelativePositionFromTypeIndex(xmlFragment, fromIndex);
    const headIndex = toIndex + 1; // Head is exclusive
    const headPos = Y.createRelativePositionFromTypeIndex(xmlFragment, headIndex);

    const anchor = Y.relativePositionToJSON(anchorPos);
    const head = Y.relativePositionToJSON(headPos);

    session.awareness.setLocalStateField('cursor', { anchor, head });
    highlighted = true;
  } catch (error) {
    console.error('[read-document-blocks] Failed to set highlight:', error);
    // Don't fail the whole operation if highlighting fails
  }

  return {
    blocks,
    readCount: blocks.length,
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
