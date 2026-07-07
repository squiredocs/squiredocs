/**
 * Yjs Document Serialization
 *
 * Converts Yjs documents to readable formats for AI agents.
 * Provides both fragment-level (whole document) and node-level (individual elements) serialization.
 */
const Y = require('yjs');
const { getNodeTextLength } = require('./cursor-operations');
const { INLINE_MARKS, attrsToCSS } = require('../../format-registry');
const {
  isInlineContentBlock,
  isCodeLikeBlock,
  isListContainer,
} = require('./block-types');

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

      // Image is a void leaf — emit a marker (with alt text if present)
      if (tagName === 'image') {
        const alt = node.getAttribute('alt');
        parts.push(alt ? `[image: ${alt}]\n` : '[image]\n');
        return;
      }

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
      if (isInlineContentBlock(tagName) || isListContainer(tagName)) {
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
 * Serialize an array of Yjs nodes to Markdown
 * @param {Array<Y.XmlElement|Y.XmlText>} nodes - Yjs nodes (e.g. fragment blocks or xpath matches)
 * @returns {string} Markdown content
 */
function toMarkdownNodes(nodes) {
  const parts = [];

  function renderInline(textNode) {
    const delta = textNode.toDelta();
    let out = '';
    for (const op of delta) {
      if (typeof op.insert !== 'string') continue;
      let seg = op.insert;
      const a = op.attributes || {};
      // Apply marks from registry (innermost first)
      for (const m of INLINE_MARKS) {
        if (!a[m.yjsAttr]) continue;
        if (m.wrap) seg = m.wrap[0] + seg + m.wrap[1];
        else seg = `<${m.htmlTag}>${seg}</${m.htmlTag}>`;
      }
      // textStyle: CSS from registry-derived STYLE_PROPS
      const ts = typeof a.textStyle === 'object' && a.textStyle;
      if (ts) {
        const css = attrsToCSS(ts);
        if (css) seg = `<span style="${css}">${seg}</span>`;
      }
      // link (custom — not a simple wrap/tag)
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
    } else if (tag === 'mermaid') {
      parts.push('```mermaid\n' + getChildText(node) + '\n```\n');
    } else if (tag === 'blockquote') {
      // Render children into a temporary capture by splicing the shared
      // `parts` array so the closure-based processNode writes into it.
      const saved = parts.splice(0);    // save & clear accumulated output
      for (const child of node.toArray()) {
        processNode(child, indent);
      }
      const innerLines = parts.splice(0); // capture child output
      parts.push(...saved);              // restore previous output
      for (const line of innerLines) {
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
    } else if (tag === 'image') {
      const src = node.getAttribute('src') || '';
      const alt = node.getAttribute('alt') || '';
      parts.push(`![${alt}](${src})\n`);
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
    // CommonMark: child blocks must reach the parent's content column,
    // i.e. be indented by the full marker width ("1. " = 3, "- " = 2).
    const childIndent = indent + ' '.repeat(marker.length);
    let first = true;
    for (const child of children) {
      if (child instanceof Y.XmlElement) {
        if (['bulletList', 'orderedList'].includes(child.nodeName)) {
          processNode(child, childIndent);
        } else {
          const text = getChildText(child);
          if (first) {
            parts.push(indent + marker + text + '\n');
            first = false;
          } else {
            parts.push(childIndent + text + '\n');
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

  // Render each top-level node separately and join with blank lines —
  // GFM needs them (tables can't interrupt a paragraph, paragraphs merge).
  const blocks = [];
  for (const node of nodes) {
    processNode(node, '');
    const rendered = parts.splice(0).join('').replace(/\n+$/, '');
    if (rendered !== '') blocks.push(rendered);
  }

  return blocks.join('\n\n').replace(/\n{3,}/g, '\n\n').trim();
}

/**
 * Serialize a Yjs XmlFragment to Markdown
 * @param {Y.XmlFragment} xmlFragment - Yjs XmlFragment
 * @returns {string} Markdown content
 */
function toMarkdown(xmlFragment) {
  return toMarkdownNodes(xmlFragment.toArray());
}

/**
 * Serialize a Yjs XmlFragment to structured JSON format
 * @param {Y.XmlFragment} xmlFragment - Yjs XmlFragment
 * @returns {Array} Array of structured nodes
 */
function toStructured(xmlFragment) {
  const nodes = [];

  for (const child of xmlFragment.toArray()) {
    const processed = toStructuredNode(child);
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
 * Collapse a flat content array into the simplest representation:
 * - All plain strings with no marks → joined string
 * - Single plain string → the string itself
 * - Mixed/marked content → the array as-is
 * - Empty → undefined
 *
 * @param {Array} flatContent - Array of strings and {text, marks} objects
 * @param {{ forceString?: boolean }} options - forceString: always join (e.g. codeBlock)
 * @returns {string|Array|undefined}
 */
function simplifyContent(flatContent, { forceString = false } = {}) {
  if (flatContent.length === 0) return undefined;
  const hasMarks = flatContent.some(item => typeof item === 'object' && item.marks);
  if (forceString || (!hasMarks && flatContent.every(c => typeof c === 'string'))) {
    return flatContent.join('');
  }
  if (flatContent.length === 1 && typeof flatContent[0] === 'string') {
    return flatContent[0];
  }
  return flatContent;
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

  // Void elements (self-closing, no content) - filter out any children.
  // Their attributes (e.g. image src/alt/title/width) are already captured above.
  if (tagName === 'horizontalRule' || tagName === 'image') {
    return result;
  }

  // Simplify content for table cells — collect recursively from nested children
  if (['tableCell', 'tableHeader'].includes(tagName)) {
    const flatContent = [];
    if (children.length > 0) {
      collectContent(children, flatContent, () => {});
    }
    result.content = simplifyContent(flatContent) ?? '';

  } else if (isInlineContentBlock(tagName)) {
    // Simplify content for leaf blocks
    const allText = children.every((c) => c.type === 'text');
    if (allText && children.length > 0) {
      const flatContent = [];
      for (const child of children) {
        if (Array.isArray(child.content)) flatContent.push(...child.content);
      }
      const simplified = simplifyContent(flatContent, {
        forceString: isCodeLikeBlock(tagName),
      });
      if (simplified !== undefined) result.content = simplified;
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

  // Image is a void leaf — emit a marker (with alt text if present)
  if (tagName === 'image') {
    const alt = node.getAttribute('alt');
    return alt ? `[image: ${alt}]\n` : '[image]\n';
  }

  let text = '';

  for (const child of node.toArray()) {
    text += toTextNode(child);
  }

  // Add appropriate newlines
  if (isInlineContentBlock(tagName) || isListContainer(tagName)) {
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


module.exports = {
  // Fragment-level serialization (existing)
  toPlainText,
  toMarkdown,
  toStructured,
  loadYDoc,
  // Node-level serialization (new)
  toMarkdownNodes,
  toStructuredNode,
  toTextNode,
  extractTextWithMarks,
  // Helper functions (new)
  countCharacters,
  countBlocks,
};
