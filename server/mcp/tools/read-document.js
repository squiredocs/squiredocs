/**
 * read_document MCP Tool
 *
 * Read document content with optional XPath filtering.
 */

const Y = require('yjs');
const agentPresence = require('../agent-presence');
const { xpath } = require('../sandbox/xpath');
const { createCursorPositionFromPath, getNodePath, getNodeTextLength } = require('../yjs/cursor-operations');

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

const description = `Read document content with optional XPath filtering.

═══════════════════════════════════════════════════════════════════════════
OVERVIEW
═══════════════════════════════════════════════════════════════════════════

Query document content using XPath expressions. Returns structured JSON
or plain text. Use this to understand document structure before modifying.

═══════════════════════════════════════════════════════════════════════════
PARAMETERS
═══════════════════════════════════════════════════════════════════════════

- docGuid: Document UUID (required)
- xpath: XPath expression to filter results (optional)
  - If omitted, returns entire document
  - Uses same XPath syntax as modify tool
- format: "structured" or "text" (optional, default: "structured")

═══════════════════════════════════════════════════════════════════════════
XPATH EXAMPLES
═══════════════════════════════════════════════════════════════════════════

// Get all headings
xpath: "//heading"

// Get level-2 headings only
xpath: "//heading[@level=2]"

// Find paragraphs containing "TODO"
xpath: "//paragraph[contains(., 'TODO')]"

// Get all list items
xpath: "//listItem"

// Get bullet list after a specific heading
xpath: "//heading[contains(., 'Tasks')]/following-sibling::bulletList[1]"

═══════════════════════════════════════════════════════════════════════════
RETURNS
═══════════════════════════════════════════════════════════════════════════

- content: Structured array or text string (based on format)
- matchCount: Number of elements returned (when using xpath)
- blockCount: Total blocks in document

═══════════════════════════════════════════════════════════════════════════
EXAMPLES
═══════════════════════════════════════════════════════════════════════════

// Read entire document
await read_document({ docGuid: "abc-123" });

// Read only headings
await read_document({
  docGuid: "abc-123",
  xpath: "//heading"
});

// Find TODOs as plain text
await read_document({
  docGuid: "abc-123",
  xpath: "//paragraph[contains(., 'TODO')]",
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
    xpath: {
      type: 'string',
      description: 'XPath expression to filter results (optional)',
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
 * Extract text with formatting marks from a Y.XmlText node
 */
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

/**
 * Convert a Yjs node to structured format
 */
function toStructured(node) {
  if (node instanceof Y.XmlText) {
    return { type: 'text', content: extractTextWithMarks(node) };
  }

  if (!(node instanceof Y.XmlElement)) {
    return null;
  }

  const tagName = node.nodeName;
  const result = { type: tagName };

  // Extract attributes
  const level = node.getAttribute('level');
  if (level !== undefined) result.level = parseInt(level, 10);
  const language = node.getAttribute('language');
  if (language !== undefined) result.language = language;

  // Process children
  const children = [];
  for (const child of node.toArray()) {
    const processed = toStructured(child);
    if (processed) children.push(processed);
  }

  // Simplify content for leaf blocks
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
        }
      }
      // Collapse to string if no marks
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
  } else if (children.length > 0) {
    result.children = children;
  }

  return result;
}

/**
 * Convert a Yjs node to plain text
 */
function toText(node) {
  if (node instanceof Y.XmlText) {
    const delta = node.toDelta();
    return delta.map((op) => (typeof op.insert === 'string' ? op.insert : '')).join('');
  }

  if (!(node instanceof Y.XmlElement)) {
    return '';
  }

  const tagName = node.nodeName;
  let text = '';

  for (const child of node.toArray()) {
    text += toText(child);
  }

  // Add appropriate newlines
  if (['paragraph', 'heading', 'codeBlock', 'listItem'].includes(tagName)) {
    text += '\n';
  } else if (['bulletList', 'orderedList'].includes(tagName)) {
    text += '\n';
  }

  return text;
}

/**
 * Handler function for the tool
 */
async function handler(args, agentToken) {
  if (!persistenceProvider) throw new Error('read_document tool not initialized');

  const { docGuid, xpath: xpathExpr, format = 'structured' } = args;
  const userId = agentToken.userId;
  const pool = persistenceProvider.getPool();

  // Check document access
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

  // Get document
  const session = await agentPresence.getOrCreateSession(docGuid, agentToken, 60);
  const ydoc = session.provider.doc;
  const xmlFragment = ydoc.get('default', Y.XmlFragment);

  const allBlocks = xmlFragment.toArray();
  const blockCount = allBlocks.length;

  // Get nodes to serialize (either xpath results or all blocks)
  let nodes;
  if (xpathExpr) {
    try {
      nodes = xpath(xpathExpr, xmlFragment);
    } catch (err) {
      throw new Error(`Invalid XPath expression: ${err.message}`);
    }
  } else {
    nodes = allBlocks;
  }

  // Highlight the nodes being read
  if (nodes.length > 0) {
    try {
      const positions = [];

      if (xpathExpr) {
        // XPath query: cycle through each matched element
        for (const node of nodes) {
          const path = getNodePath(xmlFragment, node);
          if (path) {
            const anchor = createCursorPositionFromPath(xmlFragment, path, 0);
            const head = createCursorPositionFromPath(xmlFragment, path, getNodeTextLength(node));
            if (anchor && head) {
              positions.push({ anchor, head });
            }
          }
        }
      } else {
        // Full document read: expanding selection from start toward end
        const anchor = createCursorPositionFromPath(xmlFragment, [0], 0);
        const numChunks = Math.min(5, Math.max(3, Math.ceil(nodes.length / 4)));

        for (let i = 1; i <= numChunks; i++) {
          const endBlock = Math.min(Math.ceil(i * nodes.length / numChunks), nodes.length) - 1;
          const head = createCursorPositionFromPath(xmlFragment, [endBlock], getNodeTextLength(nodes[endBlock]));
          if (anchor && head) {
            positions.push({ anchor, head });
          }
        }
      }

      if (positions.length > 0) {
        agentPresence.queueHighlightSequence(session.sessionId, positions);
      }
    } catch (err) {
      // Non-fatal: log but don't fail the read
      console.warn('[read-document] Could not highlight selection:', err.message);
    }
  }

  // Serialize based on format
  let content;
  if (format === 'text') {
    content = nodes.map(toText).join('').trim();
  } else {
    content = nodes.map(toStructured).filter(Boolean);
  }

  // Count characters in results
  const characterCount = nodes.reduce((sum, node) => sum + getNodeTextLength(node), 0);

  const result = {
    content,
    blockCount,
    characterCount,
  };

  if (xpathExpr) {
    result.matchCount = nodes.length;
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
