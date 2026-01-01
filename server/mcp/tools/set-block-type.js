/**
 * set_block_type MCP Tool
 *
 * Change the type of the current block.
 */

const Y = require('yjs');
const agentPresence = require('../agent-presence');
const { resolveCursorPosition } = require('../yjs/cursor-operations');
const { buildYjsNode } = require('../yjs/node-builder');

let persistenceProvider = null;

function init(persistence) {
  persistenceProvider = persistence;
}

const name = 'set_block_type';

const description = `Convert current block to a different type.

Preserves content, changes wrapper. Cursor stays in same logical position.

PARAMETERS:
- docGuid: Document UUID (required)
- type: New block type (required): "paragraph", "heading", "bulletList", "orderedList", "codeBlock"
- attributes: Type-specific attributes (optional)
  - For heading: {level: 1|2|3}
  - For codeBlock: {language: "javascript"}

RETURNS:
- success, previousType, newType, cursor`;

const inputSchema = {
  type: 'object',
  properties: {
    docGuid: { type: 'string', format: 'uuid' },
    type: { type: 'string', enum: ['paragraph', 'heading', 'bulletList', 'orderedList', 'codeBlock'] },
    attributes: { type: 'object' },
  },
  required: ['docGuid', 'type'],
};

async function handler(args, agentToken) {
  if (!persistenceProvider) throw new Error('set_block_type tool not initialized');

  const { docGuid, type, attributes = {} } = args;
  const userId = agentToken.userId;
  const pool = persistenceProvider.getPool();

  const accessResult = await pool.query(
    `SELECT d.id, ds.role FROM documents d
     JOIN document_shares ds ON d.id = ds.doc_id AND ds.user_id = $2
     WHERE d.id = $1`,
    [docGuid, userId]
  );

  if (accessResult.rows.length === 0) {
    throw new Error('Document not found or you do not have access');
  }

  if (accessResult.rows[0].role === 'viewer') {
    throw new Error('Permission denied: viewers cannot edit documents');
  }

  const sessionKey = `${userId}-${docGuid}`;
  const activeSessions = agentPresence.getActiveSessions();

  let session = null;
  for (const [sid, sess] of activeSessions.entries()) {
    if (sess.key === sessionKey) {
      session = sess;
      break;
    }
  }

  if (!session || !session.cursor) {
    throw new Error('No active session found. Use open_document first.');
  }

  const ydoc = session.provider.doc;
  const xmlFragment = ydoc.get('default', Y.XmlFragment);
  const undoManager = session.undoManager;

  const currentResolved = resolveCursorPosition(xmlFragment, session.cursor.head);
  const blockIndex = currentResolved.blockIndex;
  const blocks = xmlFragment.toArray();
  const currentBlock = blocks[blockIndex];

  const previousType = currentBlock.nodeName;

  // Extract content from current block
  function extractContent(node) {
    const content = [];
    function traverse(n) {
      if (n instanceof Y.XmlText) {
        content.push({ type: 'text', text: n.toString() });
      } else if (n instanceof Y.XmlElement) {
        for (const child of n.toArray()) {
          traverse(child);
        }
      }
    }
    traverse(node);
    return content;
  }

  const content = extractContent(currentBlock);

  // Build new block with same content
  const newBlock = buildYjsNode({
    type,
    ...attributes,
    content,
  });

  ydoc.transact(() => {
    xmlFragment.delete(blockIndex, 1);
    xmlFragment.insert(blockIndex, [newBlock]);
  }, undoManager);

  return {
    success: true,
    previousType,
    newType: type,
    cursor: {
      block: blockIndex,
      offset: currentResolved.offset,
      blockType: type,
    },
  };
}

module.exports = { init, name, description, inputSchema, handler };
