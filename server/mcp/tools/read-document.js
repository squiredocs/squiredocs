/**
 * read_document MCP Tool
 *
 * Read entire document or specific blocks without moving cursor.
 */

const Y = require('yjs');
const agentPresence = require('../agent-presence');
const { toPlainText, toStructured } = require('../yjs/serialization');

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
const name = 'read_document';

const description = `Read document content without moving cursor.

═══════════════════════════════════════════════════════════════════════════
READ-ONLY OPERATION
═══════════════════════════════════════════════════════════════════════════

Read document content in plain text or structured format.
Does NOT move or affect cursor position.

WHEN TO USE THIS:
- Review entire document or specific blocks
- Get document structure for planning edits
- Extract content for analysis

═══════════════════════════════════════════════════════════════════════════
PARAMETERS
═══════════════════════════════════════════════════════════════════════════

- docGuid: Document UUID (required)
- fromBlock: Start block index (optional, default: 0)
- toBlock: End block index inclusive (optional, default: last block)
- format: "text" or "structured" (optional, default: "structured")
  - "text": Plain text with newlines between blocks
  - "structured": JSON array of block objects with types and content

═══════════════════════════════════════════════════════════════════════════
RETURNS
═══════════════════════════════════════════════════════════════════════════

- content: Text string or structured array (based on format parameter)
- blockCount: Total number of blocks in document
- characterCount: Total characters

═══════════════════════════════════════════════════════════════════════════
EXAMPLE
═══════════════════════════════════════════════════════════════════════════

// Read entire document as structured data
await read_document({
  docGuid: "abc-123",
  format: "structured"
});

// Read blocks 5-10 as plain text
await read_document({
  docGuid: "abc-123",
  fromBlock: 5,
  toBlock: 10,
  format: "text"
});`;

const inputSchema = {
  type: 'object',
  properties: {
    docGuid: {
      type: 'string',
      format: 'uuid',
      description: 'The document UUID',
    },
    fromBlock: {
      type: 'integer',
      minimum: 0,
      description: 'Start block index (default: 0)',
    },
    toBlock: {
      type: 'integer',
      minimum: 0,
      description: 'End block index inclusive (default: last)',
    },
    format: {
      type: 'string',
      enum: ['text', 'structured'],
      description: 'Output format (default: "structured")',
    },
  },
  required: ['docGuid'],
};

/**
 * Handler function for the tool
 * @param {object} args - Tool arguments
 * @param {string} args.docGuid - Document UUID
 * @param {number} [args.fromBlock=0] - Start block
 * @param {number} [args.toBlock] - End block
 * @param {string} [args.format="structured"] - Output format
 * @param {object} agentToken - Decoded agent JWT token
 * @returns {Promise<object>} Document content
 */
async function handler(args, agentToken) {
  if (!persistenceProvider) throw new Error('read_document tool not initialized');

  const { docGuid, fromBlock = 0, toBlock, format = 'structured' } = args;
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

  // Get or create session (doesn't affect cursor)
  const session = await agentPresence.getOrCreateSession(docGuid, agentToken, 60);
  const ydoc = session.provider.doc;
  const xmlFragment = ydoc.get('default', Y.XmlFragment);

  const blocks = xmlFragment.toArray();
  const blockCount = blocks.length;

  // Calculate range
  const startIdx = Math.max(0, fromBlock);
  const endIdx = toBlock !== undefined ? Math.min(toBlock, blockCount - 1) : blockCount - 1;

  if (startIdx > endIdx || startIdx >= blockCount) {
    return {
      content: format === 'text' ? '' : [],
      blockCount,
      characterCount: 0,
    };
  }

  // Extract specified range
  const rangeBlocks = blocks.slice(startIdx, endIdx + 1);

  // Count characters
  let characterCount = 0;
  function countChars(node) {
    if (node instanceof Y.XmlText) {
      characterCount += node.length;
    } else if (node instanceof Y.XmlElement) {
      const children = node.toArray();
      for (const child of children) {
        countChars(child);
      }
    }
  }

  for (const block of rangeBlocks) {
    countChars(block);
  }

  // Format output
  let content;
  if (format === 'text') {
    content = toPlainText(rangeBlocks);
  } else {
    content = toStructured(rangeBlocks);
  }

  return {
    content,
    blockCount,
    characterCount,
  };
}

module.exports = {
  init,
  name,
  description,
  inputSchema,
  handler,
};
