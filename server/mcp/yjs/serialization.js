/**
 * Yjs Document Serialization
 *
 * Converts Yjs documents to readable formats for AI agents.
 */
const Y = require('yjs');

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

module.exports = {
  toPlainText,
  toStructured,
  loadYDoc,
};
