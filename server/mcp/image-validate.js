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
const { isAppImageUrl, parseAppImageUrl } = require('../image-url');
const documents = require('../documents');
const documentImages = require('../document-images');
const s3Images = require('../s3-images');

/** @returns {boolean} whether src is an allowed app image URL */
function isAllowedImageSrc(src) {
  return isAppImageUrl(src);
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

/**
 * Reconcile image nodes whose src points at a DIFFERENT document than the one
 * being edited. Cloning content across documents (modify's sourceDocGuids)
 * carries the source doc's app URL along, and the image route authorizes
 * strictly against the URL's docId — so target-doc viewers without access to
 * the source doc would get 403s.
 *
 * For each cross-doc image: if the acting user can read the source document,
 * copy the image (S3 object + metadata row) into the target document and
 * rewrite the node's src in place; otherwise strip the node (same policy as
 * sanitizeImageSrcs — never leave a reference the edit's author couldn't read
 * themselves). Repeated references to the same source image share one copy.
 *
 * No-op when image storage is unconfigured (bytes can't be copied; the nodes
 * are no more broken than every other image when storage is off).
 *
 * @param {Y.XmlFragment} xmlFragment - live document fragment to reconcile
 * @param {string} targetDocGuid - the document being edited
 * @param {string} userId - acting user (access checks + copy attribution)
 * @returns {Promise<{copied: Array<{from: string, to: string}>, removed: Array<{src: string}>}>}
 */
async function reconcileCrossDocImages(xmlFragment, targetDocGuid, userId) {
  const copied = [];
  const removed = [];

  const crossDocNodes = [];
  for (const node of findByNodeName(xmlFragment, 'image')) {
    const src = node.getAttribute('src');
    const parsed = parseAppImageUrl(src);
    if (!parsed || parsed.docId === targetDocGuid) continue;
    crossDocNodes.push({ node, src, parsed });
  }
  if (crossDocNodes.length === 0 || !s3Images.isEnabled()) {
    return { copied, removed };
  }

  const accessByDoc = new Map(); // source docId -> boolean
  const newUrlBySrc = new Map(); // old src -> new url, or null (copy impossible)

  for (const { node, src, parsed } of crossDocNodes) {
    let newUrl = newUrlBySrc.get(src);
    if (newUrl === undefined) {
      let hasAccess = accessByDoc.get(parsed.docId);
      if (hasAccess === undefined) {
        hasAccess = await documents.hasAccess(parsed.docId, userId);
        accessByDoc.set(parsed.docId, hasAccess);
      }
      newUrl = null;
      if (hasAccess) {
        const copy = await documentImages.copyImage({
          sourceImageId: parsed.imageId,
          sourceDocId: parsed.docId,
          targetDocId: targetDocGuid,
          uploaderId: userId,
        });
        if (copy) {
          newUrl = copy.url;
          copied.push({ from: src, to: newUrl });
        }
      }
      newUrlBySrc.set(src, newUrl);
    }

    if (newUrl) {
      node.setAttribute('src', newUrl);
    } else {
      const parent = node.parent;
      if (!parent) continue;
      // Recompute the index each time — earlier deletions shift siblings.
      const idx = parent.toArray().indexOf(node);
      if (idx >= 0) {
        parent.delete(idx, 1);
        removed.push({ src });
      }
    }
  }

  return { copied, removed };
}

module.exports = { sanitizeImageSrcs, isAllowedImageSrc, reconcileCrossDocImages };
