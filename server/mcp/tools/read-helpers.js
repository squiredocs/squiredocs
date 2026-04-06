/**
 * Shared helpers for read_document and read_document_version.
 *
 * Extracts the common pipeline: xpath filtering, format-based
 * serialization, character counting, and matchCount.
 */

const { xpath } = require('../sandbox/xpath');
const {
  toStructuredNode,
  toTextNode,
  countCharacters,
  countBlocks,
} = require('../yjs/serialization');

/**
 * Query nodes from an xmlFragment (via xpath or all blocks),
 * serialize them, and return content with metadata.
 *
 * @param {Y.XmlFragment} xmlFragment
 * @param {string|undefined} xpathExpr - XPath expression or undefined for all blocks
 * @param {string} format - 'text' or 'structured'
 * @returns {{ nodes: Array, content: string|Array, blockCount: number, characterCount: number, matchCount?: number }}
 */
function queryAndSerialize(xmlFragment, xpathExpr, format) {
  const allBlocks = xmlFragment.toArray();
  const blockCount = countBlocks(xmlFragment);

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

  let content;
  if (format === 'text') {
    content = nodes.map(toTextNode).join('').trim();
  } else {
    content = nodes.map(toStructuredNode).filter(Boolean);
  }

  const characterCount = countCharacters(nodes);

  const result = { nodes, content, blockCount, characterCount };
  if (xpathExpr) {
    result.matchCount = nodes.length;
  }
  return result;
}

module.exports = { queryAndSerialize };
