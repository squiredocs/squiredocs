/**
 * Shared Yjs document utilities.
 *
 * Extracts text/XML from Y.Doc XmlFragments, and performs the generic XML-node
 * surgery (deep clone, fragment replacement) that copying content between
 * documents needs. Used by diff-service.js and version-history.js.
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

/**
 * Deep-clone a Yjs XML node into a NEW, unattached node of the same shape.
 *
 * Yjs types cannot be re-parented: inserting a node that already lives in a
 * document moves nothing and throws. Copying content between documents (the
 * restore path) therefore has to rebuild it node by node.
 *
 * `Y.XmlText` is cloned through `applyDelta(source.toDelta())` rather than
 * `insert()` calls, because the delta carries mark boundaries exactly. Building
 * the text with successive inserts lets marks BLEED into adjacent runs — bold
 * that swallows the next word — which is precisely the kind of silent
 * corruption a restore must not introduce.
 *
 * Extracted unchanged from `restoreVersion` in feature 042 (FR-010); it is
 * generic Yjs surgery with no persistence awareness, so it belongs here.
 *
 * @param {*} sourceElement - a Y.XmlText or Y.XmlElement (anything else is not
 *   clonable content)
 * @returns {Y.XmlText|Y.XmlElement|null} a new detached node, or null for a node
 *   type this cannot represent (the caller skips those)
 */
function cloneXmlNode(sourceElement) {
  if (sourceElement instanceof Y.XmlText) {
    const clone = new Y.XmlText();
    clone.applyDelta(sourceElement.toDelta());
    return clone;
  }
  if (sourceElement instanceof Y.XmlElement) {
    const clone = new Y.XmlElement(sourceElement.nodeName);
    const attrs = sourceElement.getAttributes();
    for (const [key, value] of Object.entries(attrs)) {
      clone.setAttribute(key, value);
    }
    const children = [];
    for (let i = 0; i < sourceElement.length; i++) {
      children.push(cloneXmlNode(sourceElement.get(i)));
    }
    if (children.length > 0) {
      clone.insert(0, children);
    }
    return clone;
  }
  return null;
}

/**
 * Replace a fragment's entire contents with a clone of another fragment's.
 *
 * ⚠️ SHAPE NOTE (feature 042, DEC-9). This is a delete-all-then-reinsert, which
 * is in tension with Constitution Principle IV (never delete-and-recreate live
 * document content) and with the y-tiptap viewer-deletion bug class. It is
 * moved here VERBATIM from `restoreVersion`, where it has shipped since feature
 * 023, because 042's contract is zero behavior change — adding a guard here
 * would be a behavior change, and that guard deserves its own feature with its
 * own tests. Relocating this code does not mean it has been reviewed and
 * blessed; the tension is recorded, not resolved.
 *
 * Callers should run this inside a `doc.transact()` so the whole replacement
 * lands as ONE update rather than a delete storm followed by an insert storm.
 *
 * @param {Y.XmlFragment} targetFragment - the fragment to overwrite, in place
 * @param {Y.XmlFragment} sourceFragment - the fragment whose contents to copy
 * @returns {number} how many nodes were cloned in (unclonable nodes are skipped)
 */
function replaceFragmentContents(targetFragment, sourceFragment) {
  while (targetFragment.length > 0) {
    targetFragment.delete(0, targetFragment.length);
  }

  const clonedElements = [];
  for (let i = 0; i < sourceFragment.length; i++) {
    const cloned = cloneXmlNode(sourceFragment.get(i));
    if (cloned) {
      clonedElements.push(cloned);
    }
  }

  if (clonedElements.length > 0) {
    targetFragment.insert(0, clonedElements);
  }
  return clonedElements.length;
}

module.exports = { extractXml, extractText, cloneXmlNode, replaceFragmentContents };
