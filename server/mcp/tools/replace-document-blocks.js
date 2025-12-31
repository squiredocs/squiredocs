/**
 * replace_document_blocks MCP Tool
 *
 * Replaces one or more blocks with new blocks in a single transaction.
 * More efficient and safer than separate delete + insert operations.
 */
const Y = require('yjs');
const { buildYjsNode } = require('../yjs/node-builder');
const { getTextContent } = require('../yjs/block-structure');
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
const name = 'replace_document_blocks';

const description = `Replace one or more blocks with new blocks in a single atomic operation.

⚠️  CRITICAL: INDEX INVALIDATION WARNING
═══════════════════════════════════════════════════════════════════════════
This tool CHANGES element indices! After replacement, blocks after the replaced
range will have NEW indices if the number of new blocks differs from the old.

BEFORE replace 2-4 with 2 blocks:  [0] h1, [1] p, [2] p, [3] p, [4] p, [5] p, [6] p
AFTER  replace 2-4 with 2 blocks:  [0] h1, [1] p, [2] NEW, [3] NEW, [4] p, [5] p
                                                                ↑ was [5] ↑ was [6]

REQUIRED NEXT STEP: After using this tool, you MUST call get_document_structure
to get updated indices before performing any other block operations.

Example workflow:
  1. replace_document_blocks({ fromIndex: 2, toIndex: 4, blocks: [newBlock1, newBlock2] })
  2. get_document_structure({ docGuid })  ← REQUIRED to refresh indices
  3. Now safe to use other tools with updated indices

═══════════════════════════════════════════════════════════════════════════
HOW IT WORKS
═══════════════════════════════════════════════════════════════════════════

- Replaces blocks from fromIndex to toIndex (INCLUSIVE) with new blocks
- If toIndex is omitted, replaces only the single block at fromIndex
- Replacement is ATOMIC - happens in a single Yjs transaction
- Can replace N blocks with M blocks (N and M can be different)
- Returns info about old blocks (deleted) and new blocks (inserted)

Examples:
  // Replace single block
  replace_document_blocks({
    fromIndex: 5,
    blocks: [{ type: 'heading', level: 2, content: 'New Title' }]
  })
  → Replaces 1 block at index 5 with 1 new block

  // Replace multiple paragraphs with a list
  replace_document_blocks({
    fromIndex: 2,
    toIndex: 4,
    blocks: [{
      type: 'bulletList',
      children: [
        { type: 'listItem', content: 'Item from paragraph 2' },
        { type: 'listItem', content: 'Item from paragraph 3' },
        { type: 'listItem', content: 'Item from paragraph 4' }
      ]
    }]
  })
  → Replaces 3 blocks (indices 2-4) with 1 bulletList block

  // Replace range with multiple new blocks
  replace_document_blocks({
    fromIndex: 1,
    toIndex: 1,
    blocks: [
      { type: 'heading', level: 2, content: 'Section' },
      { type: 'paragraph', content: 'Description' }
    ]
  })
  → Replaces 1 block with 2 new blocks

═══════════════════════════════════════════════════════════════════════════
PARAMETERS
═══════════════════════════════════════════════════════════════════════════

- docGuid: Document UUID (required)
- fromIndex: Starting index to replace (required)
- toIndex: Ending index to replace (optional, defaults to fromIndex)
- blocks: Array of new block specifications (required, min 1 block)
- durationSeconds: How long to highlight after replacement (default: 15)

Block specification format - see get_document_schema for full details.

IMPORTANT: Both fromIndex and toIndex are INCLUSIVE.
  Range 2-4 replaces: [2], [3], [4] = 3 blocks total
  Single block: fromIndex: 5 (no toIndex) replaces only [5]

═══════════════════════════════════════════════════════════════════════════
RETURN VALUES
═══════════════════════════════════════════════════════════════════════════

- success: true if replaced successfully
- replacedBlocks: Array of { type, content } for each replaced (deleted) block
- replacedCount: Number of blocks removed
- insertedCount: Number of blocks inserted
- insertedIndices: Array of indices where new blocks were inserted
- totalElements: New total count of blocks after replacement
- highlighted: Whether the range was highlighted after replacement

═══════════════════════════════════════════════════════════════════════════
WORKFLOW EXAMPLE
═══════════════════════════════════════════════════════════════════════════

// Step 1: See current structure
const { structure } = await get_document_structure({
  docGuid: "abc-123"
});
// Shows: [0] h1, [1] p, [2] p, [3] p, [4] p (5 total)

// Step 2: Replace paragraphs 2-3 with a bullet list
const result = await replace_document_blocks({
  docGuid: "abc-123",
  fromIndex: 2,
  toIndex: 3,
  blocks: [{
    type: 'bulletList',
    children: [
      { type: 'listItem', content: 'Converted item 1' },
      { type: 'listItem', content: 'Converted item 2' }
    ]
  }],
  durationSeconds: 20
});

// Returns:
// {
//   success: true,
//   replacedBlocks: [
//     { type: "paragraph", content: "..." },
//     { type: "paragraph", content: "..." }
//   ],
//   replacedCount: 2,
//   insertedCount: 1,
//   insertedIndices: [2],
//   totalElements: 4,  // Was 5, replaced 2 with 1, now 4
//   highlighted: true
// }

// Step 3: Get updated structure (REQUIRED!)
const { structure } = await get_document_structure({ docGuid: "abc-123" });
// Shows: [0] h1, [1] p, [2] bulletList, [3] p (was [4])

═══════════════════════════════════════════════════════════════════════════
SAFE PATTERNS
═══════════════════════════════════════════════════════════════════════════

✅ GOOD: Replace single block
  replace_document_blocks({ fromIndex: 5, blocks: [newBlock] })

✅ GOOD: Replace range with different number of blocks
  replace_document_blocks({ fromIndex: 2, toIndex: 4, blocks: [block1, block2] })
  get_document_structure()  // refresh indices

✅ GOOD: Multiple replacements from END to BEGINNING
  replace_document_blocks({ fromIndex: 20, toIndex: 25, blocks: [...] })
  replace_document_blocks({ fromIndex: 10, toIndex: 15, blocks: [...] })
  get_document_structure()  // refresh once at end

❌ AVOID: Multiple replacements from beginning to end (indices invalidate!)
  replace_document_blocks({ fromIndex: 3, toIndex: 5, blocks: [...] })
  replace_document_blocks({ fromIndex: 10, toIndex: 15, blocks: [...] })  // WRONG!

═══════════════════════════════════════════════════════════════════════════`;

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
      description: 'Starting index to replace (inclusive). For single block replacement, only provide this.',
    },
    toIndex: {
      type: 'integer',
      minimum: 0,
      description: 'Ending index to replace (inclusive, optional). Omit for single block replacement.',
    },
    blocks: {
      type: 'array',
      minItems: 1,
      description: 'Array of new block specifications to insert in place of the replaced blocks',
      items: {
        type: 'object',
        properties: {
          type: {
            type: 'string',
            description: 'Block type (paragraph, heading, bulletList, orderedList, codeBlock, etc.)',
          },
          content: {
            description: 'Text content (string or array of text/marks objects)',
          },
          level: {
            type: 'integer',
            minimum: 1,
            maximum: 6,
            description: 'Heading level (1-6, for heading type only)',
          },
          language: {
            type: 'string',
            description: 'Programming language (for codeBlock type only)',
          },
          children: {
            type: 'array',
            description: 'Child items (for bulletList/orderedList types)',
          },
        },
        required: ['type'],
      },
    },
    durationSeconds: {
      type: 'integer',
      minimum: 1,
      maximum: 300,
      description: 'How long to highlight after replacement (1-300 seconds, default: 15)',
    },
  },
  required: ['docGuid', 'fromIndex', 'blocks'],
};

/**
 * Handler function for the tool
 * @param {object} args - Tool arguments
 * @param {string} args.docGuid - Document UUID
 * @param {number} args.fromIndex - Starting index to replace (inclusive)
 * @param {number} [args.toIndex] - Ending index to replace (inclusive, defaults to fromIndex)
 * @param {Array} args.blocks - Array of new block specifications
 * @param {number} [args.durationSeconds=15] - Duration to show highlight
 * @param {object} agentToken - Decoded agent JWT token
 * @returns {Promise<object>} Replace result
 */
async function handler(args, agentToken) {
  if (!persistenceProvider) throw new Error('replace_document_blocks tool not initialized');

  const { docGuid, fromIndex, blocks, durationSeconds = 15 } = args;
  // Default toIndex to fromIndex for single block replacement
  const toIndex = args.toIndex !== undefined ? args.toIndex : fromIndex;
  const userId = agentToken.userId;
  const pool = persistenceProvider.getPool();

  // Validate range
  if (fromIndex > toIndex) {
    throw new Error(
      `Invalid range: fromIndex (${fromIndex}) must be <= toIndex (${toIndex})`
    );
  }

  // Validate blocks array
  if (!Array.isArray(blocks) || blocks.length === 0) {
    throw new Error('blocks must be a non-empty array');
  }

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
    throw new Error('Viewer role cannot replace document blocks');
  }

  // Connect to the shared WebSocket-managed document
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

  // Calculate how many blocks to replace
  const replaceCount = toIndex - fromIndex + 1;

  // Collect info about blocks being replaced (before replacement)
  const replacedBlocks = [];
  for (let i = fromIndex; i <= toIndex; i++) {
    const element = xmlFragment.get(i);
    replacedBlocks.push({
      type: element.nodeName,
      content: getTextContent(element),
    });
  }

  // Build Yjs nodes from new block specifications
  const yjsNodes = [];
  for (let i = 0; i < blocks.length; i++) {
    try {
      const node = buildYjsNode(blocks[i]);
      yjsNodes.push(node);
    } catch (error) {
      throw new Error(`Invalid block specification at index ${i}: ${error.message}`);
    }
  }

  // Perform replacement in a single transaction
  // Delete old blocks and insert new blocks atomically
  ydoc.transact(() => {
    xmlFragment.delete(fromIndex, replaceCount);
    xmlFragment.insert(fromIndex, yjsNodes);
  });

  // Calculate inserted indices
  const insertedIndices = [];
  for (let i = 0; i < blocks.length; i++) {
    insertedIndices.push(fromIndex + i);
  }

  // Highlight the replaced range
  let highlighted = false;
  try {
    const anchorPos = Y.createRelativePositionFromTypeIndex(xmlFragment, fromIndex);
    const headIndex = fromIndex + blocks.length; // Head is exclusive
    const headPos = Y.createRelativePositionFromTypeIndex(xmlFragment, headIndex);

    const anchor = Y.relativePositionToJSON(anchorPos);
    const head = Y.relativePositionToJSON(headPos);

    session.awareness.setLocalStateField('cursor', { anchor, head });
    highlighted = true;

    // Brief delay to show the highlight
    await new Promise((resolve) => setTimeout(resolve, 500));

    // Clear the cursor highlight
    session.awareness.setLocalStateField('cursor', null);
  } catch (error) {
    console.error('[replace-document-blocks] Failed to set/clear highlight:', error);
    // Continue even if highlight fails
  }

  return {
    success: true,
    replacedBlocks,
    replacedCount: replaceCount,
    insertedCount: blocks.length,
    insertedIndices,
    totalElements: xmlFragment.length,
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
