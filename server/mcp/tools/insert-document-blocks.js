/**
 * insert_document_blocks MCP Tool
 *
 * Inserts one or more blocks at a specified position.
 * More efficient than multiple insert_document_block calls.
 */
const Y = require('yjs');
const { buildYjsNode } = require('../yjs/node-builder');
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
const name = 'insert_document_blocks';

const description = `Insert one or more blocks into the document at a specified position.

⚠️  CRITICAL: INDEX INVALIDATION WARNING
═══════════════════════════════════════════════════════════════════════════
This tool CHANGES element indices! After insertion, blocks at and after the
insertion position will have NEW indices.

BEFORE insert at position 2:  [0] h1, [1] p, [2] p, [3] p
AFTER  insert at position 2:  [0] h1, [1] p, [2] NEW, [3] NEW, [4] p, [5] p
                                                            ↑ was [2] ↑ was [3]

REQUIRED NEXT STEP: After using this tool, you MUST call get_document_structure
to get updated indices before performing any other block operations.

Example workflow:
  1. insert_document_blocks({ position: 2, blocks: [block1, block2] })
  2. get_document_structure({ docGuid })  ← REQUIRED to refresh indices
  3. Now safe to use other tools with updated indices

═══════════════════════════════════════════════════════════════════════════
HOW IT WORKS
═══════════════════════════════════════════════════════════════════════════

- Inserts one or more blocks at the specified position
- Position can be: number (index), "start" (beginning), or "end" (append)
- All blocks at and after the insertion position shift down
- Returns array of inserted block indices

Examples:
  // Insert single block at specific position
  insert_document_blocks({
    position: 5,
    blocks: [{ type: 'paragraph', content: 'New paragraph' }]
  })
  → Inserts 1 block at index 5

  // Insert multiple blocks at once
  insert_document_blocks({
    position: 2,
    blocks: [
      { type: 'heading', level: 2, content: 'Section Title' },
      { type: 'paragraph', content: 'First paragraph' },
      { type: 'paragraph', content: 'Second paragraph' }
    ]
  })
  → Inserts 3 blocks starting at index 2

  // Insert at start
  insert_document_blocks({
    position: 'start',
    blocks: [{ type: 'heading', level: 1, content: 'Document Title' }]
  })

  // Append at end
  insert_document_blocks({
    position: 'end',
    blocks: [
      { type: 'paragraph', content: 'Conclusion' },
      { type: 'paragraph', content: 'Final thoughts' }
    ]
  })

═══════════════════════════════════════════════════════════════════════════
PARAMETERS
═══════════════════════════════════════════════════════════════════════════

- docGuid: Document UUID (required)
- position: Where to insert (required) - number, "start", or "end"
- blocks: Array of block specifications (required, min 1 block)
- durationSeconds: How long to keep selection active (default: 30)

Block specification format - see get_document_schema for full details:
  - type: Block type (paragraph, heading, bulletList, codeBlock, etc.)
  - content: Text content (string or array of text/marks)
  - level: For headings (1-6)
  - language: For code blocks
  - children: For lists (array of listItem objects)

═══════════════════════════════════════════════════════════════════════════
RETURN VALUES
═══════════════════════════════════════════════════════════════════════════

- success: true if inserted successfully
- insertedIndices: Array of indices where blocks were inserted
- insertedCount: Number of blocks inserted
- totalElements: New total count of blocks after insertion
- highlighted: Whether the range was highlighted after insertion

═══════════════════════════════════════════════════════════════════════════
WORKFLOW EXAMPLE
═══════════════════════════════════════════════════════════════════════════

// Step 1: See current structure
const { structure } = await get_document_structure({
  docGuid: "abc-123"
});
// Shows: [0] h1, [1] p, [2] p (3 total)

// Step 2: Insert multiple blocks
const result = await insert_document_blocks({
  docGuid: "abc-123",
  position: 1,
  blocks: [
    { type: 'paragraph', content: 'New first paragraph' },
    { type: 'paragraph', content: 'New second paragraph' }
  ],
  durationSeconds: 20
});

// Returns:
// {
//   success: true,
//   insertedIndices: [1, 2],
//   insertedCount: 2,
//   totalElements: 5,  // Was 3, inserted 2, now 5
//   highlighted: true
// }

// Step 3: Get updated structure (REQUIRED!)
const { structure } = await get_document_structure({ docGuid: "abc-123" });
// Shows: [0] h1, [1] p (NEW), [2] p (NEW), [3] p (was [1]), [4] p (was [2])

═══════════════════════════════════════════════════════════════════════════
SAFE PATTERNS
═══════════════════════════════════════════════════════════════════════════

✅ GOOD: Insert single block
  insert_document_blocks({ position: 5, blocks: [block1] })

✅ GOOD: Insert multiple blocks at once
  insert_document_blocks({ position: 5, blocks: [block1, block2, block3] })
  get_document_structure()  // refresh indices

✅ GOOD: Multiple insertions from BEGINNING to END
  insert_document_blocks({ position: 0, blocks: [...] })
  insert_document_blocks({ position: 5, blocks: [...] })  // Account for first insertion!
  get_document_structure()  // refresh once at end

❌ AVOID: Multiple insertions without accounting for index shifts
  insert_document_blocks({ position: 5, blocks: [block1] })
  insert_document_blocks({ position: 10, blocks: [block2] })  // WRONG - indices changed!

═══════════════════════════════════════════════════════════════════════════`;

const inputSchema = {
  type: 'object',
  properties: {
    docGuid: {
      type: 'string',
      format: 'uuid',
      description: 'The document UUID',
    },
    position: {
      oneOf: [
        { type: 'integer', minimum: 0 },
        { type: 'string', enum: ['start', 'end'] },
      ],
      description:
        'Where to insert: number (specific index), "start" (beginning), or "end" (append)',
    },
    blocks: {
      type: 'array',
      minItems: 1,
      description: 'Array of block specifications to insert',
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
      description: 'How long to keep selection active (1-300 seconds, default: 30)',
    },
  },
  required: ['docGuid', 'position', 'blocks'],
};

/**
 * Handler function for the tool
 * @param {object} args - Tool arguments
 * @param {string} args.docGuid - Document UUID
 * @param {number|string} args.position - Where to insert (number, "start", or "end")
 * @param {Array} args.blocks - Array of block specifications
 * @param {number} [args.durationSeconds=30] - Duration to keep selection active
 * @param {object} agentToken - Decoded agent JWT token
 * @returns {Promise<object>} Insert result
 */
async function handler(args, agentToken) {
  if (!persistenceProvider) throw new Error('insert_document_blocks tool not initialized');

  const { docGuid, position, blocks, durationSeconds = 30 } = args;
  const userId = agentToken.userId;
  const pool = persistenceProvider.getPool();

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
    throw new Error('Viewer role cannot insert document blocks');
  }

  // Connect to the shared WebSocket-managed document
  const session = await agentPresence.getOrCreateSession(docGuid, agentToken, durationSeconds);
  const ydoc = session.provider.doc;
  const xmlFragment = ydoc.get('default', Y.XmlFragment);

  // Resolve position to numeric index
  let insertIndex;
  if (position === 'start') {
    insertIndex = 0;
  } else if (position === 'end') {
    insertIndex = xmlFragment.length;
  } else if (typeof position === 'number') {
    insertIndex = position;
    // Validate index (allow inserting at end, so <= length is valid)
    if (insertIndex < 0 || insertIndex > xmlFragment.length) {
      throw new Error(
        `position ${insertIndex} out of bounds (document has ${xmlFragment.length} elements, valid range: 0-${xmlFragment.length})`
      );
    }
  } else {
    throw new Error('position must be a number, "start", or "end"');
  }

  // Build Yjs nodes from block specifications
  const yjsNodes = [];
  for (let i = 0; i < blocks.length; i++) {
    try {
      const node = buildYjsNode(blocks[i]);
      yjsNodes.push(node);
    } catch (error) {
      throw new Error(`Invalid block specification at index ${i}: ${error.message}`);
    }
  }

  // Insert all blocks in a transaction
  ydoc.transact(() => {
    xmlFragment.insert(insertIndex, yjsNodes);
  });

  // Calculate inserted indices
  const insertedIndices = [];
  for (let i = 0; i < blocks.length; i++) {
    insertedIndices.push(insertIndex + i);
  }

  // Highlight the inserted range
  // Keep the selection active for the duration (30 seconds by default)
  // It will automatically clear when the session expires or another tool call changes it
  let highlighted = false;
  try {
    const anchorPos = Y.createRelativePositionFromTypeIndex(xmlFragment, insertIndex);
    const headIndex = insertIndex + blocks.length; // Head is exclusive
    const headPos = Y.createRelativePositionFromTypeIndex(xmlFragment, headIndex);

    const anchor = Y.relativePositionToJSON(anchorPos);
    const head = Y.relativePositionToJSON(headPos);

    session.awareness.setLocalStateField('cursor', { anchor, head });
    highlighted = true;
  } catch (error) {
    console.error('[insert-document-blocks] Failed to set highlight:', error);
    // Continue even if highlight fails
  }

  return {
    success: true,
    insertedIndices,
    insertedCount: blocks.length,
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
