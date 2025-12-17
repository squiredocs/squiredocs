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
    element.setAttribute('level', level.toString());
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
  } else if (content) {
    // Text content: may include marks
    const textElements = buildTextContent(content);
    if (textElements.length > 0) {
      element.insert(0, textElements);
    }
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
