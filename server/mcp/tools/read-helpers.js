/**
 * Shared helpers for read_document and read_document_version.
 *
 * Extracts the common pipeline: xpath filtering, format-based
 * serialization, character counting, and matchCount — plus the historical
 * read core shared by read_document({ versionId }) and the hidden
 * read_document_version deprecation alias (feature 019 DR-1).
 */

const Y = require('yjs');
const { xpath } = require('../sandbox/xpath');
const documents = require('../../documents');
const versionHistory = require('../../version-history');
const {
  toStructuredNode,
  toMarkdownNodes,
  countCharacters,
  countBlocks,
} = require('../yjs/serialization');

/**
 * Query nodes from an xmlFragment (via xpath or all blocks),
 * serialize them, and return content with metadata.
 *
 * @param {Y.XmlFragment} xmlFragment
 * @param {string|undefined} xpathExpr - XPath expression or undefined for all blocks
 * @param {string} format - 'markdown' or 'structured'
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
  if (format === 'markdown') {
    content = toMarkdownNodes(nodes);
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

/**
 * Historical-read core (feature 019 DR-1): read a document's content as of a
 * version, with the same xpath/format semantics as a current read.
 *
 * Deliberately NO presence session and NO highlights — a historical read
 * must not move the live cursor. Access is checked via documents.hasAccess
 * (the same wording the presence path produces on failure).
 *
 * @param {PostgresPersistence} persistenceProvider
 * @param {object} params - { docGuid, versionId, xpathExpr, format, userId }
 * @returns {Promise<{content, blockCount, characterCount, matchCount?, version}>}
 */
async function readDocumentAtVersion(persistenceProvider, { docGuid, versionId, xpathExpr, format, userId }) {
  // Check document access
  if (!await documents.hasAccess(docGuid, userId)) {
    throw new Error('Document not found or you do not have access');
  }

  // Get version content
  const versionData = await versionHistory.getVersionContent(
    persistenceProvider,
    docGuid,
    versionId
  );

  // Create Y.Doc from version content
  const ydoc = new Y.Doc();
  Y.applyUpdate(ydoc, new Uint8Array(versionData.content));
  const xmlFragment = ydoc.get('default', Y.XmlFragment);

  const { content, blockCount, characterCount, matchCount } = queryAndSerialize(xmlFragment, xpathExpr, format);

  const result = {
    content,
    blockCount,
    characterCount,
    version: versionData.version,
  };

  if (matchCount !== undefined) {
    result.matchCount = matchCount;
  }

  // Cleanup
  ydoc.destroy();

  return result;
}

module.exports = { queryAndSerialize, readDocumentAtVersion };
