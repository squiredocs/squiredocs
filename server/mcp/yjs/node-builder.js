/**
 * Yjs Node Builder
 *
 * Converts structured JSON nodes to Yjs XmlElement structures.
 */
const Y = require('yjs');

/**
 * Convert structured node to Yjs XmlElement
 * @param {object} node - Structured node definition
 * @returns {Y.XmlElement} Yjs element
 */
function buildYjsNode(node) {
  const { type, content, children, level, language } = node;

  const element = new Y.XmlElement(type);

  // Set attributes
  if (level !== undefined) {
    element.setAttribute('level', level);
  }
  if (language !== undefined) {
    element.setAttribute('language', language);
  }

  // Build content
  if (type === 'codeBlock') {
    // Code blocks: plain text only
    const text = new Y.XmlText();
    text.insert(0, content || '');
    element.insert(0, [text]);
  } else if (children) {
    // Lists: process child nodes
    const childElements = children.map((child) => buildYjsNode(child));
    element.insert(0, childElements);
  } else if (type === 'listItem') {
    // CRITICAL: ListItems must contain a paragraph as first child (TipTap schema requirement)
    // Schema: content: 'paragraph block*'
    // We need to wrap the text content in a paragraph node
    const paragraph = new Y.XmlElement('paragraph');

    if (content !== undefined && content !== null) {
      const textElements = buildTextContent(content);
      if (textElements.length > 0) {
        paragraph.insert(0, textElements);
      } else {
        // Empty content - add empty text node
        const emptyText = new Y.XmlText();
        paragraph.insert(0, [emptyText]);
      }
    } else {
      // No content provided - add empty text node
      const emptyText = new Y.XmlText();
      paragraph.insert(0, [emptyText]);
    }

    // Insert the paragraph into the listItem
    element.insert(0, [paragraph]);
  } else if (content !== undefined && content !== null) {
    // Text content: may include marks (for paragraphs, headings, etc.)
    const textElements = buildTextContent(content);
    if (textElements.length > 0) {
      element.insert(0, textElements);
    } else if (type === 'paragraph' || type === 'heading') {
      // For content blocks, if content is explicitly provided but empty,
      // insert an empty text node to prevent invisible blocks
      const emptyText = new Y.XmlText();
      element.insert(0, [emptyText]);
    }
  } else if (type === 'paragraph' || type === 'heading') {
    // If no content was provided at all for a content block,
    // still insert an empty text node to prevent invisible blocks
    const emptyText = new Y.XmlText();
    element.insert(0, [emptyText]);
  }

  return element;
}

/**
 * Build text content with marks
 * @param {string|Array} content - Text content
 * @returns {Array<Y.XmlText>} Array of Yjs text elements
 */
function buildTextContent(content) {
  // Shorthand: single string
  if (typeof content === 'string') {
    const text = new Y.XmlText();
    text.insert(0, content);
    return [text];
  }

  // Array of strings and formatted text objects
  if (!Array.isArray(content)) {
    return [];
  }

  const result = [];

  for (const item of content) {
    if (typeof item === 'string') {
      const text = new Y.XmlText();
      text.insert(0, item);
      result.push(text);
    } else if (item.text !== undefined) {
      const text = new Y.XmlText();

      // Build attributes object for marks
      const attrs = {};
      if (item.marks && item.marks.length > 0) {
        for (const mark of item.marks) {
          if (typeof mark === 'string') {
            // Simple mark: bold, italic, etc.
            attrs[mark] = true;
          } else if (mark.type === 'link') {
            // Link mark
            attrs.link = { href: mark.href };
          }
        }
      }

      // Insert text with formatting attributes
      text.insert(0, item.text, Object.keys(attrs).length > 0 ? attrs : undefined);
      result.push(text);
    }
  }

  return result;
}

module.exports = { buildYjsNode, buildTextContent };
