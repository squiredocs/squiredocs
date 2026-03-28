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
 * Serialize a Yjs XmlFragment to Markdown
 * @param {Y.XmlFragment} xmlFragment - Yjs XmlFragment
 * @returns {string} Markdown content
 */
function toMarkdown(xmlFragment) {
  const parts = [];

  function renderInline(textNode) {
    const delta = textNode.toDelta();
    let out = '';
    for (const op of delta) {
      if (typeof op.insert !== 'string') continue;
      let seg = op.insert;
      const a = op.attributes || {};
      if (a.code) seg = '`' + seg + '`';
      if (a.bold) seg = '**' + seg + '**';
      if (a.italic) seg = '_' + seg + '_';
      if (a.strikethrough) seg = '~~' + seg + '~~';
      if (a.underline) seg = `<u>${seg}</u>`;
      if (a.highlight) seg = `<mark>${seg}</mark>`;
      if (a.subscript) seg = `<sub>${seg}</sub>`;
      if (a.superscript) seg = `<sup>${seg}</sup>`;
      // textStyle attributes (color, background, font size/family)
      const styles = [];
      if (a.color) styles.push(`color:${a.color}`);
      if (a.backgroundColor) styles.push(`background-color:${a.backgroundColor}`);
      if (a.fontSize) styles.push(`font-size:${a.fontSize}`);
      if (a.fontFamily) styles.push(`font-family:${a.fontFamily}`);
      if (styles.length) seg = `<span style="${styles.join(';')}">${seg}</span>`;
      if (a.link) seg = `[${seg}](${typeof a.link === 'object' ? a.link.href : a.link})`;
      out += seg;
    }
    return out;
  }

  function getChildText(node) {
    let text = '';
    for (const child of node.toArray()) {
      if (child instanceof Y.XmlText) {
        text += renderInline(child);
      } else if (child instanceof Y.XmlElement) {
        text += getChildText(child);
      }
    }
    return text;
  }

  function processNode(node, indent) {
    if (node instanceof Y.XmlText) {
      parts.push(renderInline(node));
      return;
    }
    if (!(node instanceof Y.XmlElement)) return;

    const tag = node.nodeName;

    if (tag === 'paragraph') {
      parts.push(getChildText(node) + '\n');
    } else if (tag === 'heading') {
      const level = parseInt(node.getAttribute('level') || '1', 10);
      parts.push('#'.repeat(level) + ' ' + getChildText(node) + '\n');
    } else if (tag === 'codeBlock') {
      const lang = node.getAttribute('language') || '';
      parts.push('```' + lang + '\n' + getChildText(node) + '\n```\n');
    } else if (tag === 'blockquote') {
      const inner = [];
      for (const child of node.toArray()) {
        const sub = [];
        const save = parts;
        // temporarily redirect output
        parts.length = 0;
        Object.assign(parts, []);
        processNode(child, indent);
        sub.push(...parts);
        parts.length = 0;
        Object.assign(parts, save);
        for (const line of sub) {
          inner.push(line);
        }
      }
      for (const line of inner) {
        parts.push('> ' + line);
      }
    } else if (tag === 'bulletList') {
      for (const child of node.toArray()) {
        if (child instanceof Y.XmlElement && child.nodeName === 'listItem') {
          renderListItem(child, indent, '- ');
        }
      }
    } else if (tag === 'orderedList') {
      let num = 1;
      for (const child of node.toArray()) {
        if (child instanceof Y.XmlElement && child.nodeName === 'listItem') {
          renderListItem(child, indent, `${num}. `);
          num++;
        }
      }
    } else if (tag === 'horizontalRule') {
      parts.push('---\n');
    } else if (tag === 'table') {
      renderTable(node);
    } else {
      // Fallback: recurse into children
      for (const child of node.toArray()) {
        processNode(child, indent);
      }
    }
  }

  function renderListItem(node, indent, marker) {
    const children = node.toArray();
    let first = true;
    for (const child of children) {
      if (child instanceof Y.XmlElement) {
        if (['bulletList', 'orderedList'].includes(child.nodeName)) {
          processNode(child, indent + '  ');
        } else {
          const text = getChildText(child);
          if (first) {
            parts.push(indent + marker + text + '\n');
            first = false;
          } else {
            parts.push(indent + '  ' + text + '\n');
          }
        }
      }
    }
  }

  function renderTable(tableNode) {
    const rows = [];
    for (const child of tableNode.toArray()) {
      if (child instanceof Y.XmlElement && child.nodeName === 'tableRow') {
        const cells = [];
        for (const cell of child.toArray()) {
          if (cell instanceof Y.XmlElement) {
            cells.push(getChildText(cell).replace(/\|/g, '\\|'));
          }
        }
        rows.push(cells);
      }
    }
    if (rows.length === 0) return;
    // Header row
    parts.push('| ' + rows[0].join(' | ') + ' |\n');
    parts.push('| ' + rows[0].map(() => '---').join(' | ') + ' |\n');
    for (let i = 1; i < rows.length; i++) {
      parts.push('| ' + rows[i].join(' | ') + ' |\n');
    }
  }

  for (const child of xmlFragment.toArray()) {
    processNode(child, '');
  }

  return parts.join('').replace(/\n{3,}/g, '\n\n').trim();
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

        // Extract all marks from attributes
        const marks = [];

        for (const [key, value] of Object.entries(attrs)) {
          if (value === true) {
            // Boolean marks (bold, italic, etc.)
            marks.push(key);
          } else if (typeof value === 'object' && value !== null) {
            // Object marks (link, textStyle, etc.)
            if (key === 'link') {
              marks.push({ type: 'link', href: value.href || value });
            } else {
              marks.push({ type: key, ...value });
            }
          }
          // Skip false/null/undefined values
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

      // Get all attributes generically from the element
      const allAttrs = node.getAttributes();
      for (const [key, value] of Object.entries(allAttrs)) {
        if (value !== undefined && value !== null) {
          // Parse numeric attributes
          if (['colspan', 'rowspan', 'level'].includes(key)) {
            attrs[key] = parseInt(value, 10);
          } else {
            attrs[key] = value;
          }
        }
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
        ...attrs, // Include all attributes generically
      };

      // Void elements (self-closing, no content) - return without children
      if (tagName === 'horizontalRule') {
        return result;
      }

      // For table cells - extract content from nested paragraphs
      if (['tableCell', 'tableHeader'].includes(tagName)) {
        if (children.length > 0) {
          // Table cells contain paragraphs, extract their content
          const flatContent = [];
          let hasMarks = false;

          for (const child of children) {
            if (child.type === 'paragraph' && child.content) {
              if (Array.isArray(child.content)) {
                flatContent.push(...child.content);
                if (child.content.some((item) => typeof item === 'object' && item.marks)) {
                  hasMarks = true;
                }
              } else if (typeof child.content === 'string') {
                flatContent.push(child.content);
              }
            } else if (child.type === 'text' && child.content) {
              // Direct text children
              if (Array.isArray(child.content)) {
                flatContent.push(...child.content);
                if (child.content.some((item) => typeof item === 'object' && item.marks)) {
                  hasMarks = true;
                }
              } else if (typeof child.content === 'string') {
                flatContent.push(child.content);
              }
            }
          }

          // Simplify to string if no marks
          if (!hasMarks && flatContent.every((c) => typeof c === 'string')) {
            result.content = flatContent.join('');
          } else if (flatContent.length === 1 && typeof flatContent[0] === 'string') {
            result.content = flatContent[0];
          } else if (flatContent.length > 0) {
            result.content = flatContent;
          }
        }
      } else if (['paragraph', 'heading', 'codeBlock', 'listItem'].includes(tagName)) {
        // For content nodes (paragraph, heading, listItem, codeBlock)
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

      // Extract all marks from attributes
      const marks = [];

      for (const [key, value] of Object.entries(attrs)) {
        if (value === true) {
          // Boolean marks (bold, italic, etc.)
          marks.push(key);
        } else if (typeof value === 'object' && value !== null) {
          // Object marks (link, textStyle, etc.)
          if (key === 'link') {
            marks.push({ type: 'link', href: value.href || value });
          } else {
            marks.push({ type: key, ...value });
          }
        }
        // Skip false/null/undefined values
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
 * Recursively collect text content from structured node children.
 * Walks into content, children, and nested structures so that
 * container elements like tableCell always get a content string
 * even when their children are paragraphs, lists, etc.
 */
function collectContent(nodes, out, setHasMarks) {
  for (const child of nodes) {
    // Direct content (string or array of text/mark items)
    const content = child.content;
    if (content) {
      if (Array.isArray(content)) {
        out.push(...content);
        if (content.some((item) => typeof item === 'object' && item.marks)) {
          setHasMarks(true);
        }
      } else if (typeof content === 'string') {
        out.push(content);
      }
    }
    // Recurse into children (lists, blockquotes, nested structures)
    if (child.children) {
      collectContent(child.children, out, setHasMarks);
    }
  }
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

  // Extract all attributes generically
  const allAttrs = node.getAttributes();
  for (const [key, value] of Object.entries(allAttrs)) {
    if (value !== undefined && value !== null) {
      // Parse numeric attributes
      if (['colspan', 'rowspan', 'level'].includes(key)) {
        result[key] = parseInt(value, 10);
      } else {
        result[key] = value;
      }
    }
  }

  // Process children
  const children = [];
  for (const child of node.toArray()) {
    const processed = toStructuredNode(child);
    if (processed) children.push(processed);
  }

  // Void elements (self-closing, no content) - filter out any children
  if (tagName === 'horizontalRule') {
    // horizontalRule should have no children, even if TipTap adds empty text nodes
    return result;
  }

  // Simplify content for table cells - extract text from nested children
  if (['tableCell', 'tableHeader'].includes(tagName)) {
    if (children.length > 0) {
      const flatContent = [];
      let hasMarks = false;
      collectContent(children, flatContent, (m) => { hasMarks = hasMarks || m; });
      // Collapse to string if no marks
      if (!hasMarks && flatContent.every((c) => typeof c === 'string')) {
        result.content = flatContent.join('');
      } else if (flatContent.length === 1 && typeof flatContent[0] === 'string') {
        result.content = flatContent[0];
      } else if (flatContent.length > 0) {
        result.content = flatContent;
      }
    }
  } else if (['paragraph', 'heading', 'codeBlock', 'listItem'].includes(tagName)) {
    // Simplify content for leaf blocks
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
  toMarkdown,
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
