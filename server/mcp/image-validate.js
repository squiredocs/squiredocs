/**
 * Server-side guardrail for agent-written image nodes.
 *
 * Agents (via the `modify` tool) may reference images that already exist in a
 * document, but must not invent image sources — an external `http(s)`/`data:`
 * src would make every viewer's browser load arbitrary remote content (a
 * tracking/privacy vector). To add a genuinely new image, the in-app assistant
 * uses the `insert_image` tool, which stores bytes in S3 and yields an app URL.
 *
 * This strips any image node whose src isn't the app form
 * (/api/docs/:docId/images/:imageId), mutating the live fragment in place so the
 * removal persists with the rest of the edit, and reports what it removed so the
 * agent can self-correct.
 */
const { findByNodeName } = require('./sandbox/helpers');

// The only src an agent edit may carry: a relative app image URL.
const APP_IMAGE_SRC = /^\/api\/docs\/[^/]+\/images\/[^/]+$/;

/** @returns {boolean} whether src is an allowed app image URL */
function isAllowedImageSrc(src) {
  return typeof src === 'string' && APP_IMAGE_SRC.test(src);
}

/**
 * Remove image nodes with a disallowed src from a document fragment, in place.
 * @param {Y.XmlFragment} xmlFragment - live document fragment to sanitize
 * @returns {Array<{src: string|null}>} one entry per stripped image
 */
function sanitizeImageSrcs(xmlFragment) {
  const images = findByNodeName(xmlFragment, 'image');
  const removed = [];
  for (const node of images) {
    const src = node.getAttribute('src');
    if (isAllowedImageSrc(src)) continue;
    const parent = node.parent;
    if (!parent) continue;
    // Recompute the index each time — earlier deletions shift siblings.
    const idx = parent.toArray().indexOf(node);
    if (idx >= 0) {
      parent.delete(idx, 1);
      removed.push({ src: src || null });
    }
  }
  return removed;
}

module.exports = { sanitizeImageSrcs, isAllowedImageSrc, APP_IMAGE_SRC };
