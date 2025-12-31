/**
 * batch_update_blocks MCP Tool
 *
 * Performs multiple block operations in a single atomic transaction.
 * This eliminates index invalidation issues between operations.
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
const name = 'batch_update_blocks';

const description = `Perform multiple block operations in a single atomic transaction.

⚠️  CRITICAL: NO INDEX INVALIDATION
═══════════════════════════════════════════════════════════════════════════
This tool performs ALL operations in a single Yjs transaction, so you don't
need to worry about index invalidation between operations! All indices refer
to the ORIGINAL document state before any operations are applied.

EXAMPLE:
  Original: [0] h1, [1] p, [2] p, [3] p, [4] p

  Operations using original indices:
  - Delete index 1
  - Replace index 3 with heading
  - Insert at index 2

  All operations use indices from the ORIGINAL state, not intermediate states.

═══════════════════════════════════════════════════════════════════════════
HOW IT WORKS
═══════════════════════════════════════════════════════════════════════════

- Accepts an array of operations: insert, delete, or replace
- All operations execute in a single atomic Yjs transaction
- Operations are automatically ordered to prevent index invalidation
- Much more efficient than multiple separate tool calls

Supported operations:
  - insert: Insert blocks at a position
  - delete: Delete a range of blocks
  - replace: Replace a range with new blocks

═══════════════════════════════════════════════════════════════════════════
OPERATION TYPES
═══════════════════════════════════════════════════════════════════════════

INSERT:
{
  action: "insert",
  position: 5,              // where to insert
  blocks: [block1, block2]  // blocks to insert
}

DELETE:
{
  action: "delete",
  fromIndex: 3,     // start of range
  toIndex: 5        // end of range (optional, defaults to fromIndex)
}

REPLACE:
{
  action: "replace",
  fromIndex: 2,             // start of range to replace
  toIndex: 4,               // end of range (optional, defaults to fromIndex)
  blocks: [newBlock1]       // replacement blocks
}

═══════════════════════════════════════════════════════════════════════════
PARAMETERS
═══════════════════════════════════════════════════════════════════════════

- docGuid: Document UUID (required)
- operations: Array of operation objects (required, min 1)
- durationSeconds: How long to keep selection active (default: 30)

═══════════════════════════════════════════════════════════════════════════
RETURN VALUES
═══════════════════════════════════════════════════════════════════════════

- success: true if all operations succeeded
- operationsApplied: Number of operations executed
- totalElements: Final count of blocks after all operations
- highlighted: Whether the affected range was highlighted
- results: Array of results for each operation

═══════════════════════════════════════════════════════════════════════════
COMPLETE EXAMPLE
═══════════════════════════════════════════════════════════════════════════

// Original document: [0] h1, [1] p, [2] p, [3] p, [4] p, [5] p

const result = await batch_update_blocks({
  docGuid: "abc-123",
  operations: [
    // Delete paragraph at index 1
    { action: "delete", fromIndex: 1 },

    // Replace paragraphs 3-4 with a heading
    {
      action: "replace",
      fromIndex: 3,
      toIndex: 4,
      blocks: [{ type: "heading", level: 2, content: "Section" }]
    },

    // Insert new paragraph at index 2
    {
      action: "insert",
      position: 2,
      blocks: [{ type: "paragraph", content: "Inserted text" }]
    }
  ]
});

// Returns:
{
  success: true,
  operationsApplied: 3,
  totalElements: 4,  // h1, p (inserted), p, heading (replaced)
  highlighted: true,
  results: [
    { action: "delete", deletedCount: 1 },
    { action: "replace", replacedCount: 2, insertedCount: 1 },
    { action: "insert", insertedCount: 1 }
  ]
}

═══════════════════════════════════════════════════════════════════════════
BENEFITS OVER INDIVIDUAL CALLS
═══════════════════════════════════════════════════════════════════════════

❌ OLD WAY (3 separate calls, indices invalidate):
  delete_document_blocks({ fromIndex: 1 })
  get_document_structure()  // refresh indices
  replace_document_blocks({ fromIndex: 2, ... })  // NEW indices!
  get_document_structure()  // refresh again
  insert_document_blocks({ position: 1, ... })  // NEW indices again!

✅ NEW WAY (1 call, no invalidation):
  batch_update_blocks({
    operations: [
      { action: "delete", fromIndex: 1 },
      { action: "replace", fromIndex: 3, ... },  // ORIGINAL indices!
      { action: "insert", position: 2, ... }     // ORIGINAL indices!
    ]
  })

═══════════════════════════════════════════════════════════════════════════`;

const inputSchema = {
  type: 'object',
  properties: {
    docGuid: {
      type: 'string',
      format: 'uuid',
      description: 'The document UUID',
    },
    operations: {
      type: 'array',
      minItems: 1,
      description: 'Array of operations to perform (insert, delete, or replace)',
      items: {
        type: 'object',
        properties: {
          action: {
            type: 'string',
            enum: ['insert', 'delete', 'replace'],
            description: 'Type of operation',
          },
          position: {
            type: 'integer',
            minimum: 0,
            description: 'For insert: where to insert blocks',
          },
          fromIndex: {
            type: 'integer',
            minimum: 0,
            description: 'For delete/replace: starting index',
          },
          toIndex: {
            type: 'integer',
            minimum: 0,
            description: 'For delete/replace: ending index (optional, defaults to fromIndex)',
          },
          blocks: {
            type: 'array',
            description: 'For insert/replace: blocks to insert',
            items: {
              type: 'object',
              properties: {
                type: { type: 'string' },
                content: {},
                level: { type: 'integer' },
                language: { type: 'string' },
                children: { type: 'array' },
              },
              required: ['type'],
            },
          },
        },
        required: ['action'],
      },
    },
    durationSeconds: {
      type: 'integer',
      minimum: 1,
      maximum: 300,
      description: 'How long to keep selection active (1-300 seconds, default: 30)',
    },
  },
  required: ['docGuid', 'operations'],
};

/**
 * Handler function for the tool
 * @param {object} args - Tool arguments
 * @param {string} args.docGuid - Document UUID
 * @param {Array} args.operations - Array of operations
 * @param {number} [args.durationSeconds=30] - Duration to keep selection active
 * @param {object} agentToken - Decoded agent JWT token
 * @returns {Promise<object>} Batch update result
 */
async function handler(args, agentToken) {
  if (!persistenceProvider) throw new Error('batch_update_blocks tool not initialized');

  const { docGuid, operations, durationSeconds = 30 } = args;
  const userId = agentToken.userId;
  const pool = persistenceProvider.getPool();

  // Validate operations array
  if (!Array.isArray(operations) || operations.length === 0) {
    throw new Error('operations must be a non-empty array');
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
    throw new Error('Viewer role cannot update document blocks');
  }

  // Connect to the shared WebSocket-managed document
  const session = await agentPresence.getOrCreateSession(docGuid, agentToken, durationSeconds);
  const ydoc = session.provider.doc;
  const xmlFragment = ydoc.get('default', Y.XmlFragment);

  // Validate all operations before executing any
  for (let i = 0; i < operations.length; i++) {
    const op = operations[i];

    if (!op.action || !['insert', 'delete', 'replace'].includes(op.action)) {
      throw new Error(`Operation ${i}: invalid or missing action`);
    }

    if (op.action === 'insert') {
      if (op.position === undefined) {
        throw new Error(`Operation ${i}: insert requires position`);
      }
      if (!op.blocks || !Array.isArray(op.blocks) || op.blocks.length === 0) {
        throw new Error(`Operation ${i}: insert requires non-empty blocks array`);
      }
    }

    if (op.action === 'delete') {
      if (op.fromIndex === undefined) {
        throw new Error(`Operation ${i}: delete requires fromIndex`);
      }
    }

    if (op.action === 'replace') {
      if (op.fromIndex === undefined) {
        throw new Error(`Operation ${i}: replace requires fromIndex`);
      }
      if (!op.blocks || !Array.isArray(op.blocks) || op.blocks.length === 0) {
        throw new Error(`Operation ${i}: replace requires non-empty blocks array`);
      }
    }
  }

  // Sort operations from highest index to lowest to prevent index invalidation
  // This ensures later indices aren't affected by earlier operations
  const sortedOps = [...operations].map((op, idx) => ({ ...op, originalIndex: idx })).sort((a, b) => {
    const aIndex = a.action === 'insert' ? a.position : a.fromIndex;
    const bIndex = b.action === 'insert' ? b.position : b.fromIndex;
    return bIndex - aIndex; // Sort descending
  });

  const results = new Array(operations.length);
  let minAffectedIndex = Infinity;
  let maxAffectedIndex = -1;

  // Execute all operations in a single transaction
  ydoc.transact(() => {
    for (const op of sortedOps) {
      const resultIdx = op.originalIndex;

      if (op.action === 'delete') {
        const fromIndex = op.fromIndex;
        const toIndex = op.toIndex !== undefined ? op.toIndex : fromIndex;
        const deleteCount = toIndex - fromIndex + 1;

        if (fromIndex >= xmlFragment.length || toIndex >= xmlFragment.length) {
          throw new Error(`Operation ${resultIdx}: indices out of bounds`);
        }

        xmlFragment.delete(fromIndex, deleteCount);
        results[resultIdx] = { action: 'delete', deletedCount: deleteCount };

        minAffectedIndex = Math.min(minAffectedIndex, fromIndex);
        maxAffectedIndex = Math.max(maxAffectedIndex, fromIndex);
      }

      if (op.action === 'insert') {
        const position = op.position;

        if (position > xmlFragment.length) {
          throw new Error(`Operation ${resultIdx}: position out of bounds`);
        }

        const yjsNodes = op.blocks.map((block, i) => {
          try {
            return buildYjsNode(block);
          } catch (error) {
            throw new Error(`Operation ${resultIdx}, block ${i}: ${error.message}`);
          }
        });

        xmlFragment.insert(position, yjsNodes);
        results[resultIdx] = { action: 'insert', insertedCount: yjsNodes.length };

        minAffectedIndex = Math.min(minAffectedIndex, position);
        maxAffectedIndex = Math.max(maxAffectedIndex, position + yjsNodes.length - 1);
      }

      if (op.action === 'replace') {
        const fromIndex = op.fromIndex;
        const toIndex = op.toIndex !== undefined ? op.toIndex : fromIndex;
        const replaceCount = toIndex - fromIndex + 1;

        if (fromIndex >= xmlFragment.length || toIndex >= xmlFragment.length) {
          throw new Error(`Operation ${resultIdx}: indices out of bounds`);
        }

        const yjsNodes = op.blocks.map((block, i) => {
          try {
            return buildYjsNode(block);
          } catch (error) {
            throw new Error(`Operation ${resultIdx}, block ${i}: ${error.message}`);
          }
        });

        xmlFragment.delete(fromIndex, replaceCount);
        xmlFragment.insert(fromIndex, yjsNodes);
        results[resultIdx] = {
          action: 'replace',
          replacedCount: replaceCount,
          insertedCount: yjsNodes.length,
        };

        minAffectedIndex = Math.min(minAffectedIndex, fromIndex);
        maxAffectedIndex = Math.max(maxAffectedIndex, fromIndex + yjsNodes.length - 1);
      }
    }
  });

  // Highlight the affected range
  let highlighted = false;
  if (minAffectedIndex !== Infinity && maxAffectedIndex !== -1) {
    try {
      const anchorPos = Y.createRelativePositionFromTypeIndex(xmlFragment, minAffectedIndex);
      const headIndex = Math.min(maxAffectedIndex + 1, xmlFragment.length);
      const headPos = Y.createRelativePositionFromTypeIndex(xmlFragment, headIndex);

      const anchor = Y.relativePositionToJSON(anchorPos);
      const head = Y.relativePositionToJSON(headPos);

      session.awareness.setLocalStateField('cursor', { anchor, head });
      highlighted = true;
    } catch (error) {
      console.error('[batch-update-blocks] Failed to set highlight:', error);
    }
  }

  return {
    success: true,
    operationsApplied: operations.length,
    totalElements: xmlFragment.length,
    highlighted,
    results,
  };
}

module.exports = {
  init,
  name,
  description,
  inputSchema,
  handler,
};
