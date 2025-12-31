/**
 * insert_document_block MCP Tool
 *
 * Inserts a new block at a specified position and highlights it.
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
const name = 'insert_document_block';

const description = `Insert a new block at a specific position in the document.

⚠️  CRITICAL: INDEX INVALIDATION WARNING
═══════════════════════════════════════════════════════════════════════════

This tool CHANGES element indices! After insertion, blocks at or after the
insert position will have NEW indices.

BEFORE insert at position 1:  [0] heading, [1] paragraph, [2] paragraph
AFTER  insert at position 1:  [0] heading, [1] NEW BLOCK, [2] paragraph, [3] paragraph
                                            ↑ inserted   ↑ was [1]   ↑ was [2]

REQUIRED NEXT STEP: After using this tool, you MUST call get_document_structure
to get updated indices before performing any other block operations.

Example workflow:
  1. insert_document_block({ position: 1, ... })
  2. get_document_structure({ docGuid })  ← REQUIRED to refresh indices
  3. Now safe to use other tools with updated indices

═══════════════════════════════════════════════════════════════════════════
POSITION OPTIONS
═══════════════════════════════════════════════════════════════════════════

- "start": Insert at the beginning (becomes element 0)
- "end": Insert at the end (after last element)
- number: Insert at specific index (existing blocks shift down)

Examples:
  position: 0 or "start" → New block becomes first
  position: 2 → New block at index 2, old [2] becomes [3]
  position: "end" → New block added after last element

═══════════════════════════════════════════════════════════════════════════
BLOCK EXAMPLES
═══════════════════════════════════════════════════════════════════════════

1. SIMPLE PARAGRAPH:
{
  "type": "paragraph",
  "content": "This is a new paragraph"
}

2. HEADING:
{
  "type": "heading",
  "level": 2,
  "content": "New Section Title"
}

3. BULLET LIST:
{
  "type": "bulletList",
  "children": [
    { "type": "listItem", "content": "First item" },
    { "type": "listItem", "content": "Second item" }
  ]
}

4. FORMATTED TEXT:
{
  "type": "paragraph",
  "content": [
    "Normal text with ",
    { "text": "bold", "marks": ["bold"] },
    " and ",
    { "text": "italic", "marks": ["italic"] }
  ]
}

═══════════════════════════════════════════════════════════════════════════
PARAMETERS
═══════════════════════════════════════════════════════════════════════════

- docGuid: Document UUID
- position: Where to insert ("start", "end", or number)
- newContent: Block structure (see examples above)
- durationSeconds: How long to highlight the new block (default: 45)

═══════════════════════════════════════════════════════════════════════════
RETURN VALUES
═══════════════════════════════════════════════════════════════════════════

- success: true if inserted successfully
- newElementIndex: Where the block was inserted
- totalElements: New total count of blocks
- highlighted: Whether the block was highlighted

═══════════════════════════════════════════════════════════════════════════
WORKFLOW EXAMPLE
═══════════════════════════════════════════════════════════════════════════

// Step 1: See current structure
const { structure, totalElements } = await get_document_structure({
  docGuid: "abc-123"
});
// Shows: [0] heading, [1] paragraph (2 total)

// Step 2: Insert a paragraph at the end
await insert_document_block({
  docGuid: "abc-123",
  position: "end",
  newContent: {
    type: "paragraph",
    content: "This is a conclusion"
  },
  durationSeconds: 60
});

// Result: [0] heading, [1] paragraph, [2] paragraph (3 total)

// Step 3: Insert a heading at the start
await insert_document_block({
  docGuid: "abc-123",
  position: "start",
  newContent: {
    type: "heading",
    level: 1,
    content: "Document Title"
  }
});

// Result: [0] heading, [1] heading, [2] paragraph, [3] paragraph (4 total)

═══════════════════════════════════════════════════════════════════════════
NOTES
═══════════════════════════════════════════════════════════════════════════

- ⚠️  INVALIDATES INDICES: Blocks at/after insert position get new indices
- After insertion, ALWAYS call get_document_structure to refresh indices
- Changes sync to all users in real-time
- Automatically saved to database
- Requires "editor" or "owner" role
- New block is highlighted for visual feedback

═══════════════════════════════════════════════════════════════════════════
SAFE MULTI-BLOCK INSERTION
═══════════════════════════════════════════════════════════════════════════

To insert multiple blocks safely:

APPROACH 1 - Insert from end to beginning (no index refresh needed):
  insert_document_block({ position: "end", ... })
  insert_document_block({ position: "end", ... })
  insert_document_block({ position: "end", ... })

APPROACH 2 - Insert and refresh indices each time:
  insert_document_block({ position: 2, ... })
  const { structure } = get_document_structure({ docGuid })  // refresh
  insert_document_block({ position: 5, ... })  // use updated indices
  const { structure } = get_document_structure({ docGuid })  // refresh again

APPROACH 3 - Insert at beginning (earlier indices shift):
  insert_document_block({ position: "start", ... })
  get_document_structure({ docGuid })  // required before next operation`;

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
        { type: 'string', enum: ['start', 'end'] },
        { type: 'integer', minimum: 0 }
      ],
      description: 'Where to insert: "start", "end", or specific index',
    },
    newContent: {
      type: 'object',
      description: 'The new block structure to insert',
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
      description: 'How long to highlight the new block (1-300 seconds, default: 45)',
    },
  },
  required: ['docGuid', 'position', 'newContent'],
};

/**
 * Handler function for the tool
 * @param {object} args - Tool arguments
 * @param {string} args.docGuid - Document UUID
 * @param {string|number} args.position - Position to insert ("start", "end", or number)
 * @param {object} args.newContent - New block structure
 * @param {number} [args.durationSeconds=45] - Duration to highlight
 * @param {object} agentToken - Decoded agent JWT token
 * @returns {Promise<object>} Insert result
 */
async function handler(args, agentToken) {
  if (!persistenceProvider) throw new Error('insert_document_block tool not initialized');

  const { docGuid, position, newContent, durationSeconds = 45 } = args;
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
    throw new Error('Viewer role cannot insert document blocks');
  }

  // Connect to the shared WebSocket-managed document
  const session = await agentPresence.getOrCreateSession(docGuid, agentToken, durationSeconds);
  const ydoc = session.provider.doc;
  const xmlFragment = ydoc.get('default', Y.XmlFragment);

  // Calculate the actual insert index
  let insertIndex;
  if (position === 'start') {
    insertIndex = 0;
  } else if (position === 'end') {
    insertIndex = xmlFragment.length;
  } else {
    insertIndex = position;
    // Validate the index
    if (insertIndex > xmlFragment.length) {
      throw new Error(
        `Insert index ${insertIndex} out of bounds (document has ${xmlFragment.length} elements, max insert index is ${xmlFragment.length})`
      );
    }
  }

  // Build the new node
  const newNode = buildYjsNode(newContent);

  // Perform the insert in a transaction
  ydoc.transact(() => {
    xmlFragment.insert(insertIndex, [newNode]);
  });

  // Highlight the new block
  let highlighted = false;
  try {
    // Create relative positions for the block
    const anchorPos = Y.createRelativePositionFromTypeIndex(xmlFragment, insertIndex);
    const headIndex = insertIndex + 1;
    const headPos = Y.createRelativePositionFromTypeIndex(xmlFragment, headIndex);

    const anchor = Y.relativePositionToJSON(anchorPos);
    const head = Y.relativePositionToJSON(headPos);

    // Set cursor on the session we already created
    session.awareness.setLocalStateField('cursor', { anchor, head });
    highlighted = true;
  } catch (error) {
    console.error('[insert-document-block] Failed to set highlight:', error);
  }

  return {
    success: true,
    newElementIndex: insertIndex,
    totalElements: xmlFragment.length,
    blockType: newContent.type,
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
