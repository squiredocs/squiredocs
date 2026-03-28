/**
 * Shared Yjs document utilities.
 *
 * Extracts text/XML from Y.Doc XmlFragments. Used by both
 * diff-service.js and version-history.js.
 */
const Y = require('yjs');

/**
 * Extract full XML representation from a Y.Doc (includes formatting attributes).
 * @param {Y.Doc} doc
 * @returns {string}
 */
function extractXml(doc) {
  const fragment = doc.get('default', Y.XmlFragment);
  let xml = '';
  fragment.forEach((node) => {
    if (node.toString) xml += node.toString() + '\n';
  });
  return xml.trim();
}

/**
 * Extract plain text content from a Y.Doc (XML tags stripped).
 * @param {Y.Doc} doc
 * @returns {string}
 */
function extractText(doc) {
  const fragment = doc.get('default', Y.XmlFragment);
  let text = '';
  fragment.forEach((node) => {
    if (node.toString) {
      text += node.toString().replace(/<[^>]*>/g, '') + '\n';
    }
  });
  return text.trim();
}

module.exports = { extractXml, extractText };
