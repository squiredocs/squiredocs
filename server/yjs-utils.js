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
 * Concatenate one node's text by WALKING THE YJS TREE.
 *
 * `Y.XmlText.toDelta()` returns the text as insert ops carrying their formatting
 * as attributes; we take the string inserts and ignore the attributes. Using
 * `toString()` here would be wrong in the same way the old regex was: it
 * re-emits inline formatting as markup (`<strong>…</strong>`), which just moves
 * the tag-stripping problem down one level.
 *
 * @param {*} node - a Y.XmlText, Y.XmlElement, or Y.XmlFragment
 * @returns {string}
 */
function nodeText(node) {
  if (node instanceof Y.XmlText) {
    return node
      .toDelta()
      .map((op) => (typeof op.insert === 'string' ? op.insert : ''))
      .join('');
  }
  if (node instanceof Y.XmlElement || node instanceof Y.XmlFragment) {
    let out = '';
    node.forEach((child) => { out += nodeText(child); });
    return out;
  }
  // Y.XmlHook or anything else contributes no text.
  return '';
}

/**
 * Extract plain text content from a Y.Doc.
 *
 * Feature 039 (FR-016): this used to be `node.toString().replace(/<[^>]*>/g, '')`
 * — a regex that strips anything that LOOKS like a tag. Document prose
 * containing literal angle brackets ("use <div> tags for layout", "if a < b")
 * was silently eaten, so two versions differing only inside such prose extracted
 * to identical text and the comparison reported "Formatting changes only" for a
 * real content change. Walking the structure cannot make that mistake: markup is
 * never in the text to begin with.
 *
 * The output SHAPE is preserved exactly (CD-8), because `formattingOnly` and the
 * cache both depend on it: one line per TOP-LEVEL fragment node, that node's
 * descendants concatenated with NO separator, and a final `.trim()`.
 *
 * `extractXml` is deliberately NOT changed — `formattingOnly` needs the
 * markup-bearing form, and `server/update-classifier.js` depends on it.
 *
 * @param {Y.Doc} doc
 * @returns {string}
 */
function extractText(doc) {
  const fragment = doc.get('default', Y.XmlFragment);
  const lines = [];
  fragment.forEach((node) => { lines.push(nodeText(node)); });
  return lines.join('\n').trim();
}

module.exports = { extractXml, extractText };
