/**
 * Markdown import module (feature 002) — the single code path every import
 * surface wraps (FR-001). No surface parses or materializes on its own.
 *
 * Pipeline (contracts/import-module.md):
 *   normalize → frontmatter (markdown-import-frontmatter) → markdownToPm
 *   (feature 001, tolerant, exclusively — FR-003) → image reconstruction →
 *   link-href sanitation (FR-022) → `data:` image rejection (FR-019) →
 *   materialize (pm-json-to-nodes) → staged image pass (rehost/degrade,
 *   cross-doc reconciliation) → ONE attributed documentService.updateDocument
 *   transaction applying the mode.
 *
 * Two deliberate notes against the contract's step ordering:
 *
 * - IMAGE RECONSTRUCTION: the shipped 001 parser has no image grammar — it
 *   degrades `![alt](src)` to a literal `!` text run plus a link mark on the
 *   alt text (001 data-model: "image nodes are 002 scope"). This module
 *   reconstructs block-level image nodes from that canonical degradation shape
 *   for TOP-LEVEL paragraphs (the schema's image node is a block atom, so an
 *   image cannot live inside list items/table cells — nested image markdown
 *   stays in its degraded link form, which is exactly FR-018's degradation
 *   form). This is a PM-JSON transform, not a markdown parse: grammar
 *   knowledge stays in the parser.
 *
 * - IMAGE PASS RUNS ON A STAGING FRAGMENT, BEFORE THE LIVE TRANSACTION: the
 *   contract sequences the rehost pass "after materialization"; running it
 *   after the live-doc mutation would add extra transactions (breaking the
 *   one-undo-boundary / one-version-entry invariant, FR-004) and transiently
 *   store external srcs (violating SC-003's letter). Instead the detached
 *   nodes are staged into a scratch Y.Doc, the full image pass (rehost or
 *   degrade + existing cross-doc reconciliation) runs there, and the final
 *   nodes land in the live doc in ONE transaction. Every contract invariant
 *   (§Invariants) holds strictly stronger this way.
 */

const Y = require('yjs');
const documentService = require('./document-service');
const { consumeFrontmatter } = require('./markdown-import-frontmatter');
const { markdownToPm } = require('../shared/markdown');
const { pmJsonToNodes } = require('./mcp/yjs/pm-json-to-nodes');
const { reconcileCrossDocImages } = require('./mcp/image-validate');
const { isAppImageUrl } = require('./image-url');
const { xpathFirst } = require('./mcp/sandbox/xpath');
const { findByNodeName, cloneNodes } = require('./mcp/sandbox/helpers');

/** Error with a stable `code` the surfaces map to HTTP statuses. */
class ImportError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'ImportError';
    this.code = code;
  }
}

const MODES = ['append', 'replace', 'insertAfterXPath'];

// ---------------------------------------------------------------------------
// PM-JSON transforms
// ---------------------------------------------------------------------------

/** Strip C0 controls / whitespace, then read a URL scheme (lowercased). */
function schemeOf(href) {
  if (typeof href !== 'string') return null;
  // Browsers ignore control and whitespace characters when parsing scheme;
  // strip them everywhere so `jav\tascript:` can't sneak through.
  const cleaned = href.replace(/[\u0000-\u0020\u007f\s]+/g, '');
  const m = cleaned.match(/^([a-z][a-z0-9+.-]*):/i);
  return m ? m[1].toLowerCase() : null;
}

/** Cleaned href (control/whitespace-stripped) for prefix checks. */
function cleanedHref(href) {
  return typeof href === 'string' ? href.replace(/[\u0000-\u0020\u007f\s]+/g, '') : '';
}

const ALLOWED_LINK_SCHEMES = new Set(['http', 'https', 'mailto']);

/** Whether a link href passes the import protocol allowlist (FR-022, CN-9). */
function isAllowedLinkHref(href) {
  const scheme = schemeOf(href);
  if (scheme) return ALLOWED_LINK_SCHEMES.has(scheme);
  // Scheme-less: app-relative paths and fragments are allowed. `//host` is
  // scheme-relative http(s), which the allowlist permits anyway.
  const cleaned = cleanedHref(href);
  return cleaned.startsWith('/') || cleaned.startsWith('#');
}

/**
 * Drop link marks whose href protocol is outside the allowlist; keep the text
 * (FR-022). Mutates and returns the PM JSON.
 */
function sanitizeLinkMarks(pmJson) {
  function walk(node) {
    if (Array.isArray(node.marks)) {
      node.marks = node.marks.filter((mark) => {
        if (!mark || mark.type !== 'link') return true;
        return isAllowedLinkHref(mark.attrs && mark.attrs.href);
      });
      if (node.marks.length === 0) delete node.marks;
    }
    if (Array.isArray(node.content)) node.content.forEach(walk);
    return node;
  }
  return walk(pmJson);
}

/** src schemes reconstruction recognizes as image sources. */
function isImageSrcCandidate(href) {
  const scheme = schemeOf(href);
  if (scheme) return scheme === 'http' || scheme === 'https' || scheme === 'data';
  return cleanedHref(href).startsWith('/');
}

function linkHrefOf(node) {
  if (!node || node.type !== 'text' || !Array.isArray(node.marks)) return null;
  const link = node.marks.find((m) => m && m.type === 'link');
  return link && link.attrs && typeof link.attrs.href === 'string' ? link.attrs.href : null;
}

/**
 * Rebuild block-level image nodes from the parser's canonical image
 * degradation: a text run ending in `!` immediately followed by link-marked
 * text (see module header). Top-level paragraphs only. Mutates and returns
 * the PM JSON.
 */
function reconstructImages(pmJson) {
  if (!pmJson || !Array.isArray(pmJson.content)) return pmJson;

  const newBlocks = [];
  for (const block of pmJson.content) {
    if (!block || block.type !== 'paragraph' || !Array.isArray(block.content)) {
      newBlocks.push(block);
      continue;
    }

    const segments = []; // alternating: arrays of inline nodes / image nodes
    let current = [];
    const inline = block.content;
    let i = 0;
    while (i < inline.length) {
      const node = inline[i];
      const isBangCarrier =
        node && node.type === 'text' && typeof node.text === 'string' &&
        node.text.endsWith('!') && !linkHrefOf(node);
      const nextHref = i + 1 < inline.length ? linkHrefOf(inline[i + 1]) : null;

      if (isBangCarrier && nextHref && isImageSrcCandidate(nextHref)) {
        // Collect the whole linked run (formatted alt text spans several nodes).
        let j = i + 1;
        const altParts = [];
        while (j < inline.length && linkHrefOf(inline[j]) === nextHref) {
          altParts.push(inline[j].text || '');
          j++;
        }
        // Keep any text before the '!' as ordinary inline content.
        const before = node.text.slice(0, -1);
        if (before) current.push({ ...node, text: before });
        if (current.length > 0) {
          segments.push({ kind: 'inline', nodes: current });
          current = [];
        }
        segments.push({
          kind: 'image',
          node: { type: 'image', attrs: { src: nextHref, alt: altParts.join('') || null } },
        });
        i = j;
      } else {
        current.push(node);
        i++;
      }
    }
    if (current.length > 0) segments.push({ kind: 'inline', nodes: current });

    if (!segments.some((s) => s.kind === 'image')) {
      newBlocks.push(block);
      continue;
    }
    for (const segment of segments) {
      if (segment.kind === 'image') {
        newBlocks.push(segment.node);
      } else {
        newBlocks.push({ ...block, content: segment.nodes });
      }
    }
  }
  pmJson.content = newBlocks;
  return pmJson;
}

/** Truncate long (data:) srcs for the report. */
function reportSrc(src) {
  return typeof src === 'string' && src.length > 64 ? `${src.slice(0, 64)}…` : src;
}

/**
 * Reject `data:` image srcs (FR-019, CN-6): never fetched, never stored,
 * never written. The node degrades to its alt text (dropped entirely when the
 * alt is empty). Mutates the PM JSON; returns report entries.
 */
function rejectDataImages(pmJson) {
  const rejected = [];
  if (!pmJson || !Array.isArray(pmJson.content)) return rejected;
  pmJson.content = pmJson.content.flatMap((block) => {
    if (!block || block.type !== 'image') return [block];
    const src = block.attrs && block.attrs.src;
    if (schemeOf(src) !== 'data') return [block];
    rejected.push({ src: reportSrc(src), reason: 'data-url' });
    const alt = (block.attrs && block.attrs.alt) || '';
    if (!alt.trim()) return [];
    return [{ type: 'paragraph', content: [{ type: 'text', text: alt }] }];
  });
  return rejected;
}

/** Whether the parsed document has any real content (FR-005 / CN-11 guard). */
function hasRealContent(pmJson) {
  if (!pmJson || !Array.isArray(pmJson.content)) return false;
  return pmJson.content.some((block) => {
    if (!block) return false;
    if (block.type !== 'paragraph') return true;
    if (!Array.isArray(block.content)) return false;
    return block.content.some(
      (n) => (n.type === 'text' && n.text && n.text.trim() !== '') || n.type === 'hardBreak'
    );
  });
}

// ---------------------------------------------------------------------------
// Staged image pass
// ---------------------------------------------------------------------------

/** Replace an image node (in a staging fragment) with a degradation node. */
function degradeImageNode(node, { withLink }) {
  const parent = node.parent;
  if (!parent) return;
  const idx = parent.toArray().indexOf(node);
  if (idx < 0) return;
  const src = node.getAttribute('src') || '';
  const alt = node.getAttribute('alt') || '';
  const text = alt || src;
  const para = new Y.XmlElement('paragraph');
  const t = new Y.XmlText();
  if (text) {
    t.insert(0, text);
    if (withLink) t.format(0, text.length, { link: { href: src } });
  }
  para.insert(0, [t]);
  parent.delete(idx, 1);
  parent.insert(idx, [para]);
}

/**
 * Phase-2 baseline external-image pass: every external http(s) src degrades
 * to a plain link (FR-018's degradation form) — fetch-and-rehost replaces
 * this implementation in US4 (server/image-rehost.js). Non-http(s), non-app
 * srcs degrade to plain text (no link — never re-emit a dangerous href).
 *
 * @param {Y.XmlFragment} stagingFragment
 * @param {{ docId: string, userId: string }} ctx
 * @returns {Promise<{ rehosted: [], degraded: Array<{src, reason}> }>}
 */
async function baselineExternalImagePass(stagingFragment) {
  const degraded = [];
  for (const node of findByNodeName(stagingFragment, 'image')) {
    const src = node.getAttribute('src');
    if (isAppImageUrl(src)) continue;
    const scheme = schemeOf(src);
    if (scheme === 'http' || scheme === 'https') {
      degraded.push({ src: reportSrc(src), reason: 'rehost-unavailable' });
      degradeImageNode(node, { withLink: true });
    } else {
      // Anything else (app-relative non-image path, unexpected scheme) is not
      // servable — degrade to plain text, never re-emitting the src as a href.
      degraded.push({ src: reportSrc(src), reason: 'bad-scheme' });
      degradeImageNode(node, { withLink: false });
    }
  }
  return { rehosted: [], degraded };
}

// The external-image pass used by importMarkdown. US4 (T021) replaces this
// binding with the SSRF-safe fetch-and-rehost pass from server/image-rehost.js.
let externalImagePass = baselineExternalImagePass;

/** Test/wiring seam: swap the external-image pass implementation. */
function setExternalImagePass(fn) {
  externalImagePass = fn || baselineExternalImagePass;
}

/**
 * Prepare markdown for import: full pipeline up to (but excluding) the live
 * document transaction. Returns detached nodes ready for a single insert, plus
 * the report pieces. Used by importMarkdown and by the create surfaces (which
 * seed the nodes through createSeededDocument's single birth transaction).
 *
 * @param {string} markdown
 * @param {{ docId: string, userId: string }} imageContext - target document
 *   (must already exist — image copies/rehosts attach to it) and acting user.
 * @returns {Promise<{ nodes: Array, images: object, frontmatter: object }>}
 * @throws {ImportError} EMPTY_IMPORT when nothing real would be imported.
 */
async function prepareImport(markdown, imageContext) {
  const fm = consumeFrontmatter(markdown);

  let pmJson = markdownToPm(fm.content);
  pmJson = reconstructImages(pmJson);
  pmJson = sanitizeLinkMarks(pmJson);
  const rejected = rejectDataImages(pmJson);

  const hasImages = pmJson.content.some((b) => b && b.type === 'image');
  if (!hasRealContent(pmJson) && !hasImages) {
    throw new ImportError(
      'EMPTY_IMPORT',
      'Nothing to import: the markdown is empty (or empty once frontmatter is removed).'
    );
  }

  // Stage into a scratch doc so the async image pass mutates detached state,
  // never the live document (one live transaction, applied later).
  const detached = pmJsonToNodes(pmJson);
  const staging = new Y.Doc();
  let nodes;
  const images = { rehosted: [], copied: [], degraded: [], rejected };
  try {
    const stagingFragment = staging.get('staging', Y.XmlFragment);
    staging.transact(() => stagingFragment.insert(0, detached));

    // External http(s) srcs: rehost (US4) or degrade — never left external.
    const external = await externalImagePass(stagingFragment, imageContext);
    images.rehosted = external.rehosted || [];
    images.degraded = external.degraded || [];

    // Cross-document app URLs: existing access-checked copy-or-strip (FR-020).
    const reconciled = await reconcileCrossDocImages(
      stagingFragment,
      imageContext.docId,
      imageContext.userId
    );
    images.copied = reconciled.copied;
    for (const r of reconciled.removed) {
      images.rejected.push({ src: r.src, reason: 'source document not accessible' });
    }

    nodes = cloneNodes(stagingFragment, { XmlElement: Y.XmlElement, XmlText: Y.XmlText });
  } finally {
    staging.destroy();
  }

  if (nodes.length === 0) {
    throw new ImportError(
      'EMPTY_IMPORT',
      'Nothing to import: no content remained after image policy was applied.'
    );
  }

  const frontmatter = {};
  if (fm.squire && fm.squire.title) frontmatter.title = fm.squire.title;

  return { nodes, images, frontmatter };
}

/** Find the index of the top-level block containing (or being) `element`. */
function topLevelIndexOf(fragment, element) {
  let node = element;
  while (node && node.parent && node.parent !== fragment) {
    node = node.parent;
  }
  if (!node || node.parent !== fragment) return -1;
  return fragment.toArray().indexOf(node);
}

/**
 * Import markdown into a live document (contracts/import-module.md).
 *
 * @param {Y.Doc} ydoc - live shared doc (documentService.getSharedDoc — the
 *   same instance updateDocument uses; callers must hand a LOADED doc for
 *   `replace`).
 * @param {string} markdown - untrusted markdown (already size-capped upstream)
 * @param {object} options
 * @param {'append'|'replace'|'insertAfterXPath'} options.mode
 * @param {string} [options.insertAfterXPath] - required iff mode==='insertAfterXPath'
 * @param {{ userId: string, agentName?: string|null }} options.actor
 * @param {{ docId: string }} options.imageContext
 * @returns {Promise<{ blocks: {imported: number}, images: object, frontmatter: object }>}
 */
async function importMarkdown(ydoc, markdown, options = {}) {
  const { mode, insertAfterXPath, actor, imageContext } = options;
  if (!MODES.includes(mode)) {
    throw new ImportError('INVALID_MODE', `Unknown import mode: ${String(mode)}`);
  }
  if (mode === 'insertAfterXPath' && (typeof insertAfterXPath !== 'string' || !insertAfterXPath)) {
    throw new ImportError('INVALID_MODE', 'insertAfterXPath mode requires an insertAfterXPath query');
  }
  if (!actor || !actor.userId) throw new ImportError('INVALID_ACTOR', 'options.actor.userId is required');
  if (!imageContext || !imageContext.docId) {
    throw new ImportError('INVALID_CONTEXT', 'options.imageContext.docId is required');
  }

  const fragment = ydoc.get('default', Y.XmlFragment);

  // Resolve the XPath target before anything else: no match ⇒ error without
  // any mutation (FR-002). Re-resolved inside the transaction below.
  if (mode === 'insertAfterXPath') {
    const match = xpathFirst(insertAfterXPath, fragment);
    if (!match || topLevelIndexOf(fragment, match) === -1) {
      throw new ImportError('XPATH_NO_MATCH', `No element matches XPath: ${insertAfterXPath}`);
    }
  }

  const { nodes, images, frontmatter } = await prepareImport(
    markdown,
    { docId: imageContext.docId, userId: actor.userId }
  );

  // ONE transaction — one undo boundary, one attributed version entry (FR-004).
  await documentService.updateDocument(
    imageContext.docId,
    (liveDoc) => {
      const liveFragment = liveDoc.get('default', Y.XmlFragment);
      if (mode === 'append') {
        liveFragment.insert(liveFragment.length, nodes);
      } else if (mode === 'replace') {
        // Block-level deletes + inserts against the SAME fragment — never
        // recreate the fragment or doc (plan.md Complexity Tracking).
        if (liveFragment.length > 0) liveFragment.delete(0, liveFragment.length);
        liveFragment.insert(0, nodes);
      } else {
        // Re-resolve inside the transaction; throwing here aborts before any
        // mutation (nothing has been inserted or deleted yet).
        const match = xpathFirst(insertAfterXPath, liveFragment);
        const idx = match ? topLevelIndexOf(liveFragment, match) : -1;
        if (idx === -1) {
          throw new ImportError('XPATH_NO_MATCH', `No element matches XPath: ${insertAfterXPath}`);
        }
        liveFragment.insert(idx + 1, nodes);
      }
    },
    { userId: actor.userId, agentName: actor.agentName || null }
  );

  return { blocks: { imported: nodes.length }, images, frontmatter };
}

module.exports = {
  importMarkdown,
  prepareImport,
  sanitizeLinkMarks,
  reconstructImages,
  rejectDataImages,
  hasRealContent,
  isAllowedLinkHref,
  setExternalImagePass,
  ImportError,
  MODES,
};
