/**
 * Block Structure Utilities
 *
 * Provides utilities for working with document block structure,
 * showing element indices and offsets for MCP API usage.
 */

const Y = require('yjs');

/**
 * Format a single block node with offsets
 * @param {object} node - Yjs node
 * @param {number} depth - Nesting depth
 * @param {number} topLevelOffset - Offset relative to top-level element
 * @param {number} absoluteOffset - Absolute offset in document
 * @param {object} state - Shared state for tracking
 * @returns {string} Formatted output
 */
function formatNode(node, depth = 0, topLevelOffset = 0, absoluteOffset = 0, state = { elementIndex: 0 }) {
  const indent = '  '.repeat(depth);
  const textContent = getTextContent(node);
  const textLength = textContent.length;

  let result = '';

  // Only top-level blocks get an elementIndex
  if (depth === 0) {
    const preview = textContent ? ` "${textContent.slice(0, 50)}${textContent.length > 50 ? '...' : ''}"` : '';
    const endPos = absoluteOffset + textLength; // Exclusive end position
    const attrs = getNodeAttributes(node);
    const attrsStr = attrs ? ` ${JSON.stringify(attrs)}` : '';

    result += `${indent}[${state.elementIndex}] <${node.nodeName}>${attrsStr} offsets:${absoluteOffset}-${endPos}${preview}\n`;
    state.elementIndex++;

    // Process children
    if (node.length > 0) {
      let childOffset = 0;
      for (let i = 0; i < node.length; i++) {
        const child = node.get(i);
        if (child instanceof Y.XmlElement) {
          result += formatNode(child, depth + 1, childOffset, absoluteOffset + childOffset, state);
          childOffset += getTextContent(child).length;
        }
      }
    }
  } else {
    // Nested blocks show offset within TOP-LEVEL element
    const preview = textContent ? ` "${textContent.slice(0, 40)}${textContent.length > 40 ? '...' : ''}"` : '';
    const endPos = topLevelOffset + textLength; // Exclusive end position
    const attrs = getNodeAttributes(node);
    const attrsStr = attrs ? ` ${JSON.stringify(attrs)}` : '';

    result += `${indent}  ↳ <${node.nodeName}>${attrsStr} offsets:${topLevelOffset}-${endPos}${preview}\n`;

    // Process children
    if (node.length > 0) {
      let childOffset = topLevelOffset;
      for (let i = 0; i < node.length; i++) {
        const child = node.get(i);
        if (child instanceof Y.XmlElement) {
          result += formatNode(child, depth + 1, childOffset, absoluteOffset + (childOffset - topLevelOffset), state);
          childOffset += getTextContent(child).length;
        }
      }
    }
  }

  return result;
}

/**
 * Get text content from a Yjs node
 * @param {object} node - Yjs node
 * @returns {string} Text content
 */
function getTextContent(node) {
  if (node instanceof Y.XmlText) {
    return node.toString();
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
 * Get attributes from a Yjs node
 * @param {object} node - Yjs XmlElement
 * @returns {object|null} Attributes object or null
 */
function getNodeAttributes(node) {
  if (!(node instanceof Y.XmlElement)) return null;

  const attrs = {};
  const level = node.getAttribute('level');
  if (level !== undefined) attrs.level = level;

  const language = node.getAttribute('language');
  if (language !== undefined) attrs.language = language;

  const start = node.getAttribute('start');
  if (start !== undefined) attrs.start = start;

  const type = node.getAttribute('type');
  if (type !== undefined) attrs.type = type;

  return Object.keys(attrs).length > 0 ? attrs : null;
}

/**
 * Format document block structure
 * @param {Y.XmlFragment} xmlFragment - Yjs document fragment
 * @returns {string} Formatted block structure
 */
function formatDocumentStructure(xmlFragment) {
  let output = 'Block Structure (for MCP API)\n';
  output += '─'.repeat(70) + '\n\n';

  const state = { elementIndex: 0 };
  let cumulativeOffset = 0;

  for (let i = 0; i < xmlFragment.length; i++) {
    const node = xmlFragment.get(i);
    if (node instanceof Y.XmlElement) {
      output += formatNode(node, 0, 0, cumulativeOffset, state);
      cumulativeOffset += getTextContent(node).length;
    }
  }

  if (state.elementIndex === 0) {
    return 'No block elements found';
  }

  output += '\n' + '─'.repeat(70) + '\n';
  output += `Total top-level elements: ${state.elementIndex}\n\n`;
  output += 'Usage with MCP API:\n';
  output += '  - elementIndex: Use the [N] value (top-level only)\n';
  output += '  - textOffset: Use any value in the offset range shown\n';
  output += '  - Nested items (↳) are inside their parent element\n';

  return output;
}

/**
 * Get detailed info about a specific block element
 * @param {Y.XmlFragment} xmlFragment - Yjs document fragment
 * @param {number} elementIndex - Element index
 * @returns {object} Block details
 */
function getBlockDetails(xmlFragment, elementIndex) {
  if (elementIndex >= xmlFragment.length) {
    throw new Error(`Element index ${elementIndex} out of bounds (document has ${xmlFragment.length} elements)`);
  }

  const element = xmlFragment.get(elementIndex);
  if (!element) {
    throw new Error(`No element found at index ${elementIndex}`);
  }

  const textContent = getTextContent(element);
  const attrs = getNodeAttributes(element);

  return {
    elementIndex,
    type: element.nodeName,
    attributes: attrs,
    textContent,
    textLength: textContent.length,
    structure: formatNode(element, 0, 0, 0, { elementIndex: 0 }).trim()
  };
}

module.exports = {
  formatDocumentStructure,
  getBlockDetails,
  getTextContent,
  getNodeAttributes
};
