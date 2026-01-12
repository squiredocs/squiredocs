/**
 * Yjs Document Serialization
 *
 * Converts Yjs documents to readable formats for AI agents.
 * Provides both fragment-level (whole document) and node-level (individual elements) serialization.
 */
const Y = require('yjs');
const { getNodeTextLength } = require('./cursor-operations');

/**
 * Serialize a Yjs XmlFragment to plain text
 * @param {Y.XmlFragment} xmlFragment - Yjs XmlFragment
 * @returns {string} Plain text content
 */
function toPlainText(xmlFragment) {
  const parts = [];

  function processNode(node) {
    if (node instanceof Y.XmlText) {
      // Use toDelta() to get plain text without XML markup
      // toString() returns XML serialization when text has formatting marks
      const delta = node.toDelta();
      const text = delta.map(op => typeof op.insert === 'string' ? op.insert : '').join('');
      parts.push(text);
    } else if (node instanceof Y.XmlElement) {
      const tagName = node.nodeName;

      // Add appropriate spacing/formatting based on node type
      if (tagName === 'heading') {
        // Add newline before headings if not first
        if (parts.length > 0 && !parts[parts.length - 1].endsWith('\n\n')) {
          parts.push('\n\n');
        }
      }

      // Process children
      for (const child of node.toArray()) {
        processNode(child);
      }

      // Add appropriate ending based on node type
      if (['paragraph', 'heading', 'codeBlock'].includes(tagName)) {
        parts.push('\n');
      } else if (tagName === 'listItem') {
        parts.push('\n');
      } else if (['bulletList', 'orderedList'].includes(tagName)) {
        parts.push('\n');
      }
    }
  }

  for (const child of xmlFragment.toArray()) {
    processNode(child);
  }

  return parts.join('').trim();
}

/**
 * Serialize a Yjs XmlFragment to structured JSON format
 * @param {Y.XmlFragment} xmlFragment - Yjs XmlFragment
 * @returns {Array} Array of structured nodes
 */
function toStructured(xmlFragment) {
  const nodes = [];

  /**
   * Extract text content with marks from a Y.XmlText node
   * @param {Y.XmlText} textNode - Yjs text node
   * @returns {Array} Array of text content items (strings and formatted objects)
   */
  function extractTextWithMarks(textNode) {
    const delta = textNode.toDelta();
    const result = [];

    for (const op of delta) {
      if (typeof op.insert === 'string') {
        const text = op.insert;
        const attrs = op.attributes || {};

        // Check if there are any marks
        const marks = [];

        if (attrs.bold) marks.push('bold');
        if (attrs.italic) marks.push('italic');
        if (attrs.underline) marks.push('underline');
        if (attrs.strike) marks.push('strike');
        if (attrs.link) {
          marks.push({ type: 'link', href: attrs.link.href || attrs.link });
        }

        if (marks.length > 0) {
          result.push({ text, marks });
        } else {
          result.push(text);
        }
      }
    }

    return result;
  }

  function processNode(node) {
    if (node instanceof Y.XmlText) {
      // For text nodes, extract with marks
      const textContent = extractTextWithMarks(node);

      // If it's just a single plain string, simplify
      if (textContent.length === 1 && typeof textContent[0] === 'string') {
        return {
          type: 'text',
          content: textContent[0],
        };
      }

      // Return content array for formatted text
      return {
        type: 'text',
        content: textContent,
      };
    } else if (node instanceof Y.XmlElement) {
      const tagName = node.nodeName;
      const attrs = {};

      // Get attributes - Yjs XmlElement uses getAttribute for individual attrs
      // and stores them internally. We need to check known attributes.
      const level = node.getAttribute('level');
      if (level !== undefined) {
        attrs.level = level;
      }
      const language = node.getAttribute('language');
      if (language !== undefined) {
        attrs.language = language;
      }

      // Process children
      const children = [];
      for (const child of node.toArray()) {
        const processed = processNode(child);
        if (processed) {
          children.push(processed);
        }
      }

      const result = {
        type: tagName,
      };

      // Add level for headings
      if (attrs.level) {
        result.level = parseInt(attrs.level, 10);
      }

      // Add language for code blocks
      if (attrs.language) {
        result.language = attrs.language;
      }

      // For content nodes (paragraph, heading, listItem, codeBlock)
      if (['paragraph', 'heading', 'codeBlock', 'listItem'].includes(tagName)) {
        // Check if all children are text nodes
        const allText = children.every((c) => c.type === 'text');

        if (allText && children.length > 0) {
          // Flatten text content
          const flatContent = [];
          let hasMarks = false;

          for (const child of children) {
            if (Array.isArray(child.content)) {
              flatContent.push(...child.content);
              // Check if any item has marks
              if (child.content.some((item) => typeof item === 'object' && item.marks)) {
                hasMarks = true;
              }
            } else if (typeof child.content === 'string') {
              flatContent.push(child.content);
            }
          }

          // For code blocks or simple text without marks, use plain string
          if (tagName === 'codeBlock' || (!hasMarks && flatContent.every((c) => typeof c === 'string'))) {
            result.content = flatContent.join('');
          } else if (flatContent.length === 1 && typeof flatContent[0] === 'string') {
            // Single plain string
            result.content = flatContent[0];
          } else {
            // Array with formatted content
            result.content = flatContent;
          }
        } else if (children.length > 0) {
          // Complex children (shouldn't happen for these node types, but handle it)
          result.children = children;
        }
      } else if (['bulletList', 'orderedList'].includes(tagName)) {
        // Lists have listItem children
        result.children = children;
      } else if (children.length > 0) {
        // Other nodes with children
        result.children = children;
      }

      return result;
    }

    return null;
  }

  for (const child of xmlFragment.toArray()) {
    const processed = processNode(child);
    if (processed) {
      nodes.push(processed);
    }
  }

  return nodes;
}

/**
 * Load a Yjs document from database updates
 * @param {Pool} pool - PostgreSQL connection pool
 * @param {string} docGuid - Document UUID
 * @returns {Promise<Y.Doc>} Yjs document
 */
async function loadYDoc(pool, docGuid) {
  const result = await pool.query(
    'SELECT update_data FROM yjs_updates WHERE doc_guid = $1 ORDER BY clock ASC',
    [docGuid]
  );

  const ydoc = new Y.Doc();

  if (result.rows.length > 0) {
    ydoc.transact(() => {
      for (const row of result.rows) {
        Y.applyUpdate(ydoc, new Uint8Array(row.update_data));
      }
    });
  }

  return ydoc;
}

/**
 * ============================================================================
 * NODE-LEVEL SERIALIZATION (for xpath results and individual elements)
 * ============================================================================
 */

/**
 * Extract text content with marks from a Y.XmlText node
 * Helper function used by toStructuredNode
 * @param {Y.XmlText} textNode - Yjs text node
 * @returns {Array} Array of text content items (strings and formatted objects)
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
      if (attrs.link) {
        marks.push({ type: 'link', href: attrs.link.href || attrs.link });
      }

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
 * Convert a single Yjs node to structured format (ProseMirror-like JSON)
 * Used for serializing xpath query results
 * @param {Y.XmlElement|Y.XmlText} node - Single Yjs node to serialize
 * @returns {Object|null} Structured representation
 */
function toStructuredNode(node) {
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
    const processed = toStructuredNode(child);
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
 * Convert a single Yjs node to plain text
 * Used for serializing xpath query results
 * @param {Y.XmlElement|Y.XmlText} node - Single Yjs node to serialize
 * @returns {string} Plain text representation
 */
function toTextNode(node) {
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
    text += toTextNode(child);
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
 * ============================================================================
 * HELPER FUNCTIONS
 * ============================================================================
 */

/**
 * Count total characters in an array of Yjs nodes
 * @param {Array<Y.XmlElement|Y.XmlText>} nodes - Array of Yjs nodes
 * @returns {number} Total character count
 */
function countCharacters(nodes) {
  return nodes.reduce((sum, node) => sum + getNodeTextLength(node), 0);
}

/**
 * Count total blocks in a Yjs XmlFragment
 * @param {Y.XmlFragment} xmlFragment - Yjs fragment
 * @returns {number} Total block count
 */
function countBlocks(xmlFragment) {
  return xmlFragment.toArray().length;
}

/**
 * Serialize an array of nodes to structured format
 * @param {Array<Y.XmlElement>} nodes - Nodes to serialize
 * @returns {Array} Array of structured objects
 */
function serializeNodesToStructured(nodes) {
  return nodes.map(toStructuredNode).filter(Boolean);
}

/**
 * Serialize an array of nodes to plain text
 * @param {Array<Y.XmlElement>} nodes - Nodes to serialize
 * @returns {string} Plain text representation
 */
function serializeNodesToText(nodes) {
  return nodes.map(toTextNode).join('').trim();
}

module.exports = {
  // Fragment-level serialization (existing)
  toPlainText,
  toStructured,
  loadYDoc,
  // Node-level serialization (new)
  toStructuredNode,
  toTextNode,
  extractTextWithMarks,
  // Helper functions (new)
  countCharacters,
  countBlocks,
  serializeNodesToStructured,
  serializeNodesToText,
};
