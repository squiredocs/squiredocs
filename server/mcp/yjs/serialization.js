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
      parts.push(node.toString());
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

  function processNode(node) {
    if (node instanceof Y.XmlText) {
      return {
        type: 'text',
        content: node.toString(),
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

      // Extract text content for simple nodes
      const textContent = children
        .filter((c) => c.type === 'text')
        .map((c) => c.content)
        .join('');

      const result = {
        type: tagName,
      };

      // Add level for headings
      if (attrs.level) {
        result.level = parseInt(attrs.level, 10);
      }

      // For simple content nodes, include text directly
      if (
        ['paragraph', 'heading', 'codeBlock', 'listItem'].includes(tagName) &&
        children.every((c) => c.type === 'text')
      ) {
        result.content = textContent;
      } else if (children.length > 0) {
        // For complex nodes, include children array
        result.children = children;
      }

      // Add other attributes (excluding level which is handled separately)
      const otherAttrs = { ...attrs };
      delete otherAttrs.level;
      if (Object.keys(otherAttrs).length > 0) {
        result.attrs = otherAttrs;
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
