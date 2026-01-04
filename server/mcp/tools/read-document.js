/**
 * read_document MCP Tool
 *
 * Read entire document or specific blocks without moving cursor.
 */

const Y = require('yjs');
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
 * Find the first text node in a block (depth-first)
 * @param {Y.XmlElement} node - Block to search
 * @returns {Y.XmlText|null} First text node or null
 */
function findFirstTextNode(node) {
  if (node instanceof Y.XmlText) {
    return node;
  }
  if (node instanceof Y.XmlElement) {
    const children = node.toArray();
    for (const child of children) {
      const textNode = findFirstTextNode(child);
      if (textNode) return textNode;
    }
  }
  return null;
}

/**
 * Find the last text node in a block (depth-first, reversed)
 * @param {Y.XmlElement} node - Block to search
 * @returns {Y.XmlText|null} Last text node or null
 */
function findLastTextNode(node) {
  if (node instanceof Y.XmlText) {
    return node;
  }
  if (node instanceof Y.XmlElement) {
    const children = node.toArray();
    for (let i = children.length - 1; i >= 0; i--) {
      const textNode = findLastTextNode(children[i]);
      if (textNode) return textNode;
    }
  }
  return null;
}

/**
 * Create a selection spanning the given blocks
 * @param {Array<Y.XmlElement>} blocks - Blocks to select
 * @returns {object|null} { anchor, head } RelativePositions or null
 */
function createSelectionForBlocks(blocks) {
  if (!blocks || blocks.length === 0) {
    return null;
  }

  // Find first text node in first block
  const firstTextNode = findFirstTextNode(blocks[0]);
  if (!firstTextNode) {
    return null;
  }

  // Find last text node in last block
  const lastTextNode = findLastTextNode(blocks[blocks.length - 1]);
  if (!lastTextNode) {
    return null;
  }

  // Create RelativePositions
  const anchorRel = Y.createRelativePositionFromTypeIndex(firstTextNode, 0);
  const headRel = Y.createRelativePositionFromTypeIndex(lastTextNode, lastTextNode.length);

  return {
    anchor: Y.relativePositionToJSON(anchorRel),
    head: Y.relativePositionToJSON(headRel),
  };
}

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

  // Highlight the read range
  try {
    const selection = createSelectionForBlocks(rangeBlocks);
    if (selection) {
      agentPresence.setTemporarySelection(session.sessionId, selection.anchor, selection.head);
    }
  } catch (err) {
    // Non-fatal: log but don't fail the read
    console.warn('[read-document] Could not highlight selection:', err.message);
  }

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
    // Convert blocks array to plain text
    const parts = [];
    function processNode(node) {
      if (node instanceof Y.XmlText) {
        const delta = node.toDelta();
        const text = delta.map((op) => (typeof op.insert === 'string' ? op.insert : '')).join('');
        parts.push(text);
      } else if (node instanceof Y.XmlElement) {
        const tagName = node.nodeName;
        if (tagName === 'heading' && parts.length > 0 && !parts[parts.length - 1].endsWith('\n\n')) {
          parts.push('\n\n');
        }
        for (const child of node.toArray()) {
          processNode(child);
        }
        if (['paragraph', 'heading', 'codeBlock'].includes(tagName)) {
          parts.push('\n');
        } else if (tagName === 'listItem') {
          parts.push('\n');
        } else if (['bulletList', 'orderedList'].includes(tagName)) {
          parts.push('\n');
        }
      }
    }
    for (const block of rangeBlocks) {
      processNode(block);
    }
    content = parts.join('').trim();
  } else {
    // Convert blocks array to structured format
    const structuredBlocks = [];

    function extractTextWithMarks(textNode) {
      const delta = textNode.toDelta();
      const result = [];
      for (const op of delta) {
        if (typeof op.insert === 'string') {
          const text = op.insert;
          const attrs = op.attributes || {};
          const marks = [];
          if (attrs.bold) marks.push('bold');
          if (attrs.italic) marks.push('italic');
          if (attrs.underline) marks.push('underline');
          if (attrs.strike) marks.push('strike');
          if (attrs.link) marks.push({ type: 'link', href: attrs.link.href || attrs.link });
          if (marks.length > 0) {
            result.push({ text, marks });
          } else {
            result.push(text);
          }
        }
      }
      return result;
    }

    function processBlock(node) {
      if (node instanceof Y.XmlElement) {
        const tagName = node.nodeName;
        const attrs = {};
        const level = node.getAttribute('level');
        if (level !== undefined) attrs.level = level;
        const language = node.getAttribute('language');
        if (language !== undefined) attrs.language = language;

        const children = [];
        for (const child of node.toArray()) {
          if (child instanceof Y.XmlText) {
            const textContent = extractTextWithMarks(child);
            children.push({ type: 'text', content: textContent });
          } else if (child instanceof Y.XmlElement) {
            children.push(processBlock(child));
          }
        }

        const result = { type: tagName };
        if (attrs.level) result.level = parseInt(attrs.level, 10);
        if (attrs.language) result.language = attrs.language;

        if (['paragraph', 'heading', 'codeBlock', 'listItem'].includes(tagName)) {
          const allText = children.every((c) => c.type === 'text');
          if (allText && children.length > 0) {
            const flatContent = [];
            let hasMarks = false;
            for (const child of children) {
              if (Array.isArray(child.content)) {
                flatContent.push(...child.content);
                if (child.content.some((item) => typeof item === 'object' && item.marks)) {
                  hasMarks = true;
                }
              } else if (typeof child.content === 'string') {
                flatContent.push(child.content);
              }
            }
            if (tagName === 'codeBlock' || (!hasMarks && flatContent.every((c) => typeof c === 'string'))) {
              result.content = flatContent.join('');
            } else if (flatContent.length === 1 && typeof flatContent[0] === 'string') {
              result.content = flatContent[0];
            } else {
              result.content = flatContent;
            }
          } else if (children.length > 0) {
            result.children = children;
          }
        } else {
          if (children.length > 0) result.children = children;
        }

        return result;
      }
      return null;
    }

    for (const block of rangeBlocks) {
      const processed = processBlock(block);
      if (processed) {
        structuredBlocks.push(processed);
      }
    }
    content = structuredBlocks;
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
