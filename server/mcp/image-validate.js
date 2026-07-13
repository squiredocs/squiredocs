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
const Y = require('yjs');
const { findByNodeName } = require('./sandbox/helpers');
const { isAppImageUrl, parseAppImageUrl } = require('../image-url');
const documents = require('../documents');
const documentImages = require('../document-images');
const s3Images = require('../s3-images');
const { rehostImagesInFragment } = require('../image-rehost');
const { IMPORT_ORIGIN_ATTR } = require('./sandbox/from-markdown');
const { isAllowedLinkHref, schemeOf } = require('../../shared/link-protocol');

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

/**
 * Rehost image nodes that entered a modify script via `fromMarkdown` (feature
 * 002, FR-021). Those nodes carry the transient IMPORT_ORIGIN_ATTR marker on
 * their external src; this fetch-and-rehosts them (or degrades to a plain
 * link) exactly like the REST/create import path, instead of the default
 * strip. Directly authored external srcs (no marker) are left for
 * sanitizeImageSrcs to strip — the boundary CN-8/FR-021 draws.
 *
 * The marker is removed from every tagged node before rehosting (rehost keys
 * off src, not the marker; degrade replaces the node entirely), so no marker
 * survives into the stored document either way.
 *
 * @param {Y.XmlFragment} xmlFragment - live document fragment
 * @param {string} docId - the document being edited (rehost target)
 * @param {string} userId - acting user (storage attribution)
 * @returns {Promise<{ rehosted: Array<{src,url}>, degraded: Array<{src,reason}> }>}
 */
async function rehostImportOriginImages(xmlFragment, docId, userId) {
  const tagged = findByNodeName(xmlFragment, 'image').filter(
    (node) => node.getAttribute(IMPORT_ORIGIN_ATTR) != null
  );
  if (tagged.length === 0) return { rehosted: [], degraded: [] };

  // Consume the marker up front — it must never persist into the document.
  for (const node of tagged) {
    node.removeAttribute(IMPORT_ORIGIN_ATTR);
  }

  return rehostImagesInFragment(tagged, { docId, userId });
}

/**
 * Server-side guardrail for agent-written link marks (D-6, Sam 2026-07-13).
 *
 * The markdown-import path already validates link hrefs against a protocol
 * allowlist (shared/link-protocol.js, run in every PM-JSON materialization
 * path). This promotes that same allowlist to the modify WRITE boundary: a
 * modify script can format text with a link mark carrying any href —
 * javascript:/data:/vbscript:/file: included — which the CRDT would store,
 * defused only by the client TipTap Link extension's render-time gate. Here we
 * walk the live fragment and, for every link mark whose href is not allowed
 * (http/https/mailto or scheme-less app-relative `/…`/`#…`), remove the mark
 * and KEEP the text — the same lossless policy as import's sanitizeLinkMarks.
 *
 * Mutates the fragment in place so the fix persists with the rest of the edit,
 * and reports each stripped mark so the agent gets teaching feedback (the
 * constitution's instructive-errors preference), mirroring imageErrors.
 *
 * @param {Y.XmlFragment} xmlFragment - live document fragment to sanitize
 * @returns {Array<{href: string|null, reason: string}>} one entry per stripped link mark
 */
function sanitizeLinkHrefs(xmlFragment) {
  const errors = [];

  function walk(node) {
    if (node instanceof Y.XmlText) {
      // Collect the disallowed link ranges from the ORIGINAL delta first, then
      // clear them. Clearing a mark leaves the text length (and therefore every
      // character offset) unchanged, so offsets computed here stay valid across
      // the successive format() clears.
      const delta = node.toDelta();
      let offset = 0;
      const toClear = [];
      for (const op of delta) {
        const len = typeof op.insert === 'string' ? op.insert.length : 1;
        const link = op.attributes && op.attributes.link;
        if (link) {
          // TipTap stores the link mark as { href }, but tolerate a bare string.
          const href = typeof link === 'string' ? link : (link && link.href);
          if (!isAllowedLinkHref(href)) {
            toClear.push({ offset, len, href: href || null });
          }
        }
        offset += len;
      }
      for (const range of toClear) {
        node.format(range.offset, range.len, { link: null });
        const scheme = schemeOf(range.href);
        errors.push({
          href: range.href,
          reason: scheme ? `disallowed link protocol "${scheme}:"` : 'disallowed link href',
        });
      }
      return;
    }
    // Y.XmlElement extends Y.XmlFragment; both expose toArray(). Recurse into
    // block/inline containers to reach every text node.
    if (node instanceof Y.XmlFragment) {
      for (const child of node.toArray()) walk(child);
    }
  }

  walk(xmlFragment);
  return errors;
}

module.exports = {
  sanitizeImageSrcs,
  isAllowedImageSrc,
  reconcileCrossDocImages,
  rehostImportOriginImages,
  sanitizeLinkHrefs,
};
