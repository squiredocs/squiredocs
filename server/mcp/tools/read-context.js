/**
 * read_context MCP Tool
 *
 * Read text around the current cursor position without moving it.
 */

const Y = require('yjs');
const agentPresence = require('../agent-presence');
const { getCursorContext, resolveCursorPosition } = require('../yjs/cursor-operations');

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
const name = 'read_context';

const description = `Get text content around the current cursor position.

═══════════════════════════════════════════════════════════════════════════
CONTEXTUAL READING
═══════════════════════════════════════════════════════════════════════════

Read text before and after your cursor to understand context before making edits.
Does NOT move cursor.

WHEN TO USE THIS:
- Understand surrounding text before editing
- Check context around cursor position
- Preview what's nearby without scrolling

═══════════════════════════════════════════════════════════════════════════
PARAMETERS
═══════════════════════════════════════════════════════════════════════════

- docGuid: Document UUID (required)
- before: Characters before cursor (optional, default: 200)
- after: Characters after cursor (optional, default: 200)
- includeBlockInfo: Include block structure (optional, default: true)

═══════════════════════════════════════════════════════════════════════════
RETURNS
═══════════════════════════════════════════════════════════════════════════

- context:
  - before: Text before cursor
  - after: Text after cursor
  - selection: Selected text if any
- blocks: Array of blocks in context range (if includeBlockInfo true)
- cursor:
  - block: Current block index
  - offset: Offset within block
  - blockType: Type of block

═══════════════════════════════════════════════════════════════════════════
EXAMPLE
═══════════════════════════════════════════════════════════════════════════

// Get 200 chars before/after cursor
await read_context({
  docGuid: "abc-123"
});

// Get more context (500 chars each direction)
await read_context({
  docGuid: "abc-123",
  before: 500,
  after: 500
});`;

const inputSchema = {
  type: 'object',
  properties: {
    docGuid: {
      type: 'string',
      format: 'uuid',
      description: 'The document UUID',
    },
    before: {
      type: 'integer',
      minimum: 0,
      maximum: 10000,
      description: 'Characters before cursor (default: 200)',
    },
    after: {
      type: 'integer',
      minimum: 0,
      maximum: 10000,
      description: 'Characters after cursor (default: 200)',
    },
    includeBlockInfo: {
      type: 'boolean',
      description: 'Include block structure info (default: true)',
    },
  },
  required: ['docGuid'],
};

/**
 * Handler function for the tool
 * @param {object} args - Tool arguments
 * @param {string} args.docGuid - Document UUID
 * @param {number} [args.before=200] - Characters before
 * @param {number} [args.after=200] - Characters after
 * @param {boolean} [args.includeBlockInfo=true] - Include blocks
 * @param {object} agentToken - Decoded agent JWT token
 * @returns {Promise<object>} Context information
 */
async function handler(args, agentToken) {
  if (!persistenceProvider) throw new Error('read_context tool not initialized');

  const { docGuid, before = 200, after = 200, includeBlockInfo = true } = args;
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

  // Get session
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

  const cursorPos = session.cursor.head;
  const context = getCursorContext(xmlFragment, cursorPos, before, after);

  if (!context) {
    throw new Error('Could not resolve cursor position');
  }

  const resolved = resolveCursorPosition(xmlFragment, cursorPos);

  // Get selection text if exists
  let selectionText = null;
  if (session.cursor.anchor && session.cursor.head) {
    const { getTextInSelection } = require('../yjs/cursor-operations');
    selectionText = getTextInSelection(xmlFragment, session.cursor.anchor, session.cursor.head);
    if (selectionText.length === 0) {
      selectionText = null;  // No selection
    }
  }

  const result = {
    context: {
      before: context.before,
      after: context.after,
      selection: selectionText,
    },
    cursor: {
      block: resolved.blockIndex,
      offset: resolved.offset,
      blockType: resolved.blockType,
    },
  };

  // Optionally include block info
  if (includeBlockInfo) {
    const blocks = xmlFragment.toArray();
    const blockInfo = [];

    for (let i = 0; i < blocks.length; i++) {
      const block = blocks[i];
      let preview = '';

      function extractPreview(node, maxChars = 50) {
        let text = '';
        function traverse(n) {
          if (text.length >= maxChars) return;
          if (n instanceof Y.XmlText) {
            text += n.toString();
          } else if (n instanceof Y.XmlElement) {
            const children = n.toArray();
            for (const child of children) {
              traverse(child);
              if (text.length >= maxChars) break;
            }
          }
        }
        traverse(node);
        return text.substring(0, maxChars);
      }

      preview = extractPreview(block);

      blockInfo.push({
        index: i,
        type: block.nodeName,
        preview: preview + (preview.length === 50 ? '...' : ''),
      });
    }

    result.blocks = blockInfo;
  }

  return result;
}

module.exports = {
  init,
  name,
  description,
  inputSchema,
  handler,
};
