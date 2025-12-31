/**
 * convert_block_type MCP Tool
 *
 * Converts a block from one type to another while preserving content.
 */
const Y = require('yjs');
const { getTextContent } = require('../yjs/block-structure');
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
const name = 'convert_block_type';

const description = `Convert a block from one type to another while preserving its content.

═══════════════════════════════════════════════════════════════════════════
COMMON USE CASES
═══════════════════════════════════════════════════════════════════════════

- Convert paragraph to heading (with optional prefix trimming)
- Convert heading to paragraph
- Convert paragraph to code block
- Change heading level
- Extract plain text from complex blocks

═══════════════════════════════════════════════════════════════════════════
HOW IT WORKS
═══════════════════════════════════════════════════════════════════════════

1. Reads the block at the specified index
2. Extracts its text content
3. Optionally trims a prefix (e.g., "## " for markdown headings)
4. Creates a new block of the target type with the content
5. Replaces the original block atomically

═══════════════════════════════════════════════════════════════════════════
PARAMETERS
═══════════════════════════════════════════════════════════════════════════

- docGuid: Document UUID (required)
- elementIndex: Index of block to convert (required)
- newType: Target block type (required) - paragraph, heading, codeBlock, etc.
- newAttributes: Type-specific attributes (optional)
    - For heading: { level: 1-6 }
    - For codeBlock: { language: "javascript" }
- trimPrefix: String to remove from beginning of content (optional)
- durationSeconds: How long to keep selection active (default: 30)

═══════════════════════════════════════════════════════════════════════════
RETURN VALUES
═══════════════════════════════════════════════════════════════════════════

- success: true if converted successfully
- originalType: The block's original type
- newType: The block's new type
- content: The extracted/trimmed content
- totalElements: Total block count (unchanged)
- highlighted: Whether the block was highlighted

═══════════════════════════════════════════════════════════════════════════
EXAMPLES
═══════════════════════════════════════════════════════════════════════════

// Convert paragraph with "## Title" to heading level 2
await convert_block_type({
  docGuid: "abc-123",
  elementIndex: 5,
  newType: "heading",
  newAttributes: { level: 2 },
  trimPrefix: "## "
});

// Convert heading to paragraph
await convert_block_type({
  docGuid: "abc-123",
  elementIndex: 3,
  newType: "paragraph"
});

// Convert paragraph to code block
await convert_block_type({
  docGuid: "abc-123",
  elementIndex: 10,
  newType: "codeBlock",
  newAttributes: { language: "javascript" }
});

// Change heading level from 3 to 2
await convert_block_type({
  docGuid: "abc-123",
  elementIndex: 7,
  newType: "heading",
  newAttributes: { level: 2 }
});

═══════════════════════════════════════════════════════════════════════════`;

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
      description: 'Index of the block to convert',
    },
    newType: {
      type: 'string',
      description: 'Target block type (paragraph, heading, codeBlock, etc.)',
    },
    newAttributes: {
      type: 'object',
      description: 'Type-specific attributes (e.g., {level: 2} for headings, {language: "js"} for code)',
    },
    trimPrefix: {
      type: 'string',
      description: 'Optional prefix to remove from content (e.g., "## " for markdown headings)',
    },
    durationSeconds: {
      type: 'integer',
      minimum: 1,
      maximum: 300,
      description: 'How long to keep selection active (1-300 seconds, default: 30)',
    },
  },
  required: ['docGuid', 'elementIndex', 'newType'],
};

/**
 * Handler function for the tool
 * @param {object} args - Tool arguments
 * @param {string} args.docGuid - Document UUID
 * @param {number} args.elementIndex - Block index to convert
 * @param {string} args.newType - Target block type
 * @param {object} [args.newAttributes] - Type-specific attributes
 * @param {string} [args.trimPrefix] - Prefix to trim from content
 * @param {number} [args.durationSeconds=30] - Duration to keep selection active
 * @param {object} agentToken - Decoded agent JWT token
 * @returns {Promise<object>} Conversion result
 */
async function handler(args, agentToken) {
  if (!persistenceProvider) throw new Error('convert_block_type tool not initialized');

  const { docGuid, elementIndex, newType, newAttributes, trimPrefix, durationSeconds = 30 } = args;
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
    throw new Error('Viewer role cannot convert blocks');
  }

  // Connect to the shared WebSocket-managed document
  const session = await agentPresence.getOrCreateSession(docGuid, agentToken, durationSeconds);
  const ydoc = session.provider.doc;
  const xmlFragment = ydoc.get('default', Y.XmlFragment);

  // Validate index
  if (elementIndex >= xmlFragment.length) {
    throw new Error(
      `elementIndex ${elementIndex} out of bounds (document has ${xmlFragment.length} elements)`
    );
  }

  // Get the original block
  const originalBlock = xmlFragment.get(elementIndex);
  const originalType = originalBlock.nodeName;

  // Extract text content
  let content = getTextContent(originalBlock);

  // Trim prefix if specified
  if (trimPrefix && content.startsWith(trimPrefix)) {
    content = content.slice(trimPrefix.length);
  }

  // Build new block specification
  const blockSpec = {
    type: newType,
    content,
    ...newAttributes,
  };

  // Create the new Yjs node
  let newNode;
  try {
    newNode = buildYjsNode(blockSpec);
  } catch (error) {
    throw new Error(`Failed to create new block: ${error.message}`);
  }

  // Replace the block in a transaction
  ydoc.transact(() => {
    xmlFragment.delete(elementIndex, 1);
    xmlFragment.insert(elementIndex, [newNode]);
  });

  // Highlight the converted block
  let highlighted = false;
  try {
    const anchorPos = Y.createRelativePositionFromTypeIndex(xmlFragment, elementIndex);
    const headPos = Y.createRelativePositionFromTypeIndex(xmlFragment, elementIndex + 1);

    const anchor = Y.relativePositionToJSON(anchorPos);
    const head = Y.relativePositionToJSON(headPos);

    session.awareness.setLocalStateField('cursor', { anchor, head });
    highlighted = true;
  } catch (error) {
    console.error('[convert-block-type] Failed to set highlight:', error);
  }

  return {
    success: true,
    originalType,
    newType,
    content,
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
