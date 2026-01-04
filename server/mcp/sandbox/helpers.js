/**
 * Helper Functions for Sandbox Scripts
 *
 * Minimal set of utilities that eliminate common boilerplate patterns.
 * Only includes helpers for operations that would otherwise require
 * users to copy-paste code in every script.
 */

const Y = require('yjs');

/**
 * Find the first Y.XmlText node within an element (traverses recursively)
 *
 * Without this helper, users must copy this traversal logic into every script.
 * This is the most commonly needed helper based on example usage patterns.
 *
 * @param {Y.XmlElement} element - Element to search
 * @returns {Y.XmlText|null} First text node found, or null
 *
 * @example
 *   const text = findTextNode(paragraph);
 *   if (text) {
 *     const content = extractText(text);
 *   }
 */
function findTextNode(element) {
  if (!(element instanceof Y.XmlElement)) {
    return null;
  }

  for (const child of element.toArray()) {
    if (child instanceof Y.XmlText) {
      return child;
    }
    if (child instanceof Y.XmlElement) {
      const found = findTextNode(child);
      if (found) return found;
    }
  }
  return null;
}

/**
 * Extract plain text from a Y.XmlText node using toDelta()
 *
 * CRITICAL: Always use this instead of toString() when text may have formatting.
 * toString() returns XML markup like "<bold>text</bold>" which breaks text operations.
 *
 * Without this helper, users must remember the toDelta pattern in every script.
 *
 * @param {Y.XmlText} xmlText - Text node to extract from
 * @returns {string} Plain text content
 *
 * @example
 *   const text = findTextNode(block);
 *   const plainText = extractText(text);
 *   const index = plainText.indexOf('TODO');
 */
function extractText(xmlText) {
  if (!(xmlText instanceof Y.XmlText)) {
    throw new Error('extractText expects a Y.XmlText instance');
  }

  const delta = xmlText.toDelta();
  return delta.map(op => typeof op.insert === 'string' ? op.insert : '').join('');
}

/**
 * Get all text content from an element recursively
 *
 * Combines findTextNode + extractText for all text nodes in a tree.
 * Useful for getting the full text of complex nested structures.
 *
 * @param {Y.XmlElement|Y.XmlText} node - Node to extract from
 * @returns {string} All text content
 *
 * @example
 *   const listText = getTextContent(bulletList);
 *   if (listText.includes('TODO')) { ... }
 */
function getTextContent(node) {
  if (node instanceof Y.XmlText) {
    return extractText(node);
  } else if (node instanceof Y.XmlElement) {
    let text = '';
    for (let i = 0; i < node.length; i++) {
      const child = node.get(i);
      text += getTextContent(child);
    }
    return text;
  }
  return '';
}

/**
 * Find all elements matching a predicate function
 *
 * Eliminates the boilerplate of recursive tree traversal for searching.
 * Base function for other find helpers.
 *
 * @param {Y.XmlFragment|Y.XmlElement} container - Container to search
 * @param {Function} predicate - Function(element) that returns true for matches
 * @returns {Y.XmlElement[]} Array of matching elements
 *
 * @example
 *   // Find all headings with level 1
 *   const h1s = findElements(doc, el =>
 *     el.nodeName === 'heading' && el.getAttribute('level') === 1
 *   );
 */
function findElements(container, predicate) {
  const matches = [];
  const items = container.toArray();

  for (const item of items) {
    if (item instanceof Y.XmlElement) {
      if (predicate(item)) {
        matches.push(item);
      }
      // Recursively search children
      matches.push(...findElements(item, predicate));
    }
  }

  return matches;
}

/**
 * Find elements by node name (e.g., 'heading', 'paragraph')
 *
 * Common operation that would otherwise require findElements boilerplate.
 *
 * @param {Y.XmlFragment|Y.XmlElement} container - Container to search
 * @param {string} nodeName - Node name to match
 * @returns {Y.XmlElement[]} Array of matching elements
 *
 * @example
 *   const headings = findByNodeName(doc, 'heading');
 *   headings.forEach(h => h.setAttribute('level', 2));
 */
function findByNodeName(container, nodeName) {
  return findElements(container, el => el.nodeName === nodeName);
}

/**
 * Find elements containing specific text
 *
 * Common search operation that would require combining multiple boilerplate patterns.
 *
 * @param {Y.XmlFragment|Y.XmlElement} container - Container to search
 * @param {string} searchText - Text to search for
 * @param {boolean} caseSensitive - Case sensitive search (default: false)
 * @returns {Y.XmlElement[]} Array of matching elements
 *
 * @example
 *   const todos = findByText(doc, 'TODO');
 *   todos.forEach(block => {
 *     const text = findTextNode(block);
 *     if (text) {
 *       const content = extractText(text);
 *       const idx = content.indexOf('TODO');
 *       text.format(idx, 4, { bold: true });
 *     }
 *   });
 */
function findByText(container, searchText, caseSensitive = false) {
  const search = caseSensitive ? searchText : searchText.toLowerCase();

  return findElements(container, el => {
    const text = getTextContent(el);
    const content = caseSensitive ? text : text.toLowerCase();
    return content.includes(search);
  });
}

module.exports = {
  findTextNode,
  extractText,
  getTextContent,
  findElements,
  findByNodeName,
  findByText,
};
