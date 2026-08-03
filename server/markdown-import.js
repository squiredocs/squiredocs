/**
 * Markdown import module (feature 002) — the single code path every import
 * surface wraps (FR-001). No surface parses or materializes on its own.
 *
 * Pipeline (contracts/import-module.md):
 *   frontmatter (shared/markdown/frontmatter — the canonical js-yaml parser,
 *   shared with export/sync) → markdownToPm
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
const { parseFrontmatter, scalarTitle } = require('../shared/markdown/frontmatter');
const { markdownToPm } = require('../shared/markdown');
const { pmJsonToNodes } = require('./mcp/yjs/pm-json-to-nodes');
const { reconcileCrossDocImages } = require('./mcp/image-validate');
const { rehostImagesInFragment } = require('./image-rehost');
const { xpathFirst } = require('./mcp/sandbox/xpath');
const { cloneNodes } = require('./mcp/sandbox/helpers');
const {
  sanitizeLinkMarks,
  reconstructImages,
  rejectDataImages,
  hasRealContent,
  isAllowedLinkHref,
} = require('./mcp/yjs/pm-json-transforms');

/** Error with a stable `code` the surfaces map to HTTP statuses. */
class ImportError extends Error {
  constructor(code, message, images = null) {
    super(message);
    this.name = 'ImportError';
    this.code = code;
    // EMPTY_IMPORT carries the itemized image report so the create surfaces can
    // surface the dropped image(s) when they fall back to the anchor-only doc
    // (F1) instead of losing them with the thrown error.
    if (images) this.images = images;
  }
}

const MODES = ['append', 'replace', 'insertAfterXPath'];

// ---------------------------------------------------------------------------
// Frontmatter consumption (converged onto shared/markdown/frontmatter.js)
// ---------------------------------------------------------------------------

/**
 * Wrap non-squire frontmatter residue in a fenced `yaml` code block whose fence
 * is guaranteed longer than any backtick run inside the residue, so hostile
 * frontmatter content can never break out of the block (CN-5). The canonical
 * parser hands back the residue byte-verbatim (`foreignRaw`); this is the
 * import surface's presentation of it — no content is lost.
 */
function fenceYaml(residue) {
  let longest = 0;
  for (const m of residue.matchAll(/`+/g)) {
    if (m[0].length > longest) longest = m[0].length;
  }
  const fence = '`'.repeat(Math.max(3, longest + 1));
  return `${fence}yaml\n${residue}\n${fence}`;
}

/**
 * Consume a leading frontmatter block for import through the canonical parser
 * (shared/markdown/frontmatter.js — the SAME js-yaml recognizer export and sync
 * use, so all three surfaces agree on recognition, the 64 KB cap, malformed-
 * as-content, and the foreign-key strip guard). Returns the body to parse with
 * non-squire residue re-emitted as a leading yaml code block (FR-007), the
 * frontmatter-stripped body on its own, and the recognized squire title
 * (FR-006/FR-008). Never throws.
 *
 * @param {string} markdown - raw untrusted markdown
 * @returns {{ content: string, body: string, title: string|null }}
 */
function importFrontmatter(markdown) {
  const { body, squire, foreignRaw } = parseFrontmatter(markdown);
  let content = body;
  if (foreignRaw) {
    content = body ? `${fenceYaml(foreignRaw)}\n\n${body}` : `${fenceYaml(foreignRaw)}\n`;
  }
  return { content, body, title: scalarTitle(squire) };
}

// ---------------------------------------------------------------------------
// Staged image pass
// ---------------------------------------------------------------------------

/**
 * The external-image pass used by importMarkdown: the SSRF-safe
 * fetch-and-rehost pipeline from server/image-rehost.js (US4/T021 — this
 * replaced the Phase-2 baseline degrade-only pass). External http(s) srcs are
 * fetched under the contracts/image-rehost.md policy and rewritten to app
 * URLs; every failure (SSRF block, size, type, budget, storage disabled)
 * degrades the node to a plain link and is itemized. Non-http(s) leftovers
 * degrade to plain text (a dangerous href is never re-emitted).
 */
const defaultExternalImagePass = (stagingFragment, ctx) =>
  rehostImagesInFragment(stagingFragment, ctx);

let externalImagePass = defaultExternalImagePass;

/** Test/wiring seam: swap the external-image pass implementation. */
function setExternalImagePass(fn) {
  externalImagePass = fn || defaultExternalImagePass;
}

/**
 * Run the staged image pass over detached PM nodes: the SSRF-safe external
 * rehost/degrade pass (US4) then the access-checked cross-doc reconciliation
 * (FR-020), on a scratch Y.Doc so the live document is never touched (contract
 * §Invariants). Returns cloned post-policy nodes + the itemized image report.
 * `rejected` seeds the report with any data: images the caller already stripped
 * (FR-019).
 *
 * Shared by prepareImport (002) and the two-way-sync engine (004) so both
 * materialize image content through IDENTICAL policy — no surface reimplements
 * it (FR-001).
 *
 * @param {Array} detachedNodes - detached Y nodes (from pmJsonToNodes)
 * @param {{ docId: string, userId: string }} imageContext
 * @param {Array} [rejected] - report entries for data: images stripped upstream
 * @returns {Promise<{ nodes: Array, images: object }>}
 */
async function stageImagePass(detachedNodes, imageContext, rejected = []) {
  const staging = new Y.Doc();
  const images = { rehosted: [], copied: [], degraded: [], rejected: [...rejected] };
  try {
    const stagingFragment = staging.get('staging', Y.XmlFragment);
    staging.transact(() => stagingFragment.insert(0, detachedNodes));

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

    const nodes = cloneNodes(stagingFragment, { XmlElement: Y.XmlElement, XmlText: Y.XmlText });
    return { nodes, images };
  } finally {
    staging.destroy();
  }
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
  const fm = importFrontmatter(markdown);

  let pmJson = markdownToPm(fm.content);
  pmJson = reconstructImages(pmJson);
  pmJson = sanitizeLinkMarks(pmJson);
  const rejected = rejectDataImages(pmJson);

  const hasImages = pmJson.content.some((b) => b && b.type === 'image');
  if (!hasRealContent(pmJson) && !hasImages) {
    // `rejected` already itemizes any data: images the policy stripped here
    // (the common cause of a body that looked non-empty pre-policy — F1).
    throw new ImportError(
      'EMPTY_IMPORT',
      'Nothing to import: the markdown is empty (or empty once frontmatter is removed).',
      { rehosted: [], copied: [], degraded: [], rejected }
    );
  }

  // Stage into a scratch doc so the async image pass mutates detached state,
  // never the live document (one live transaction, applied later).
  const detached = pmJsonToNodes(pmJson);
  const { nodes, images } = await stageImagePass(detached, imageContext, rejected);

  if (nodes.length === 0) {
    throw new ImportError(
      'EMPTY_IMPORT',
      'Nothing to import: no content remained after image policy was applied.',
      images
    );
  }

  const frontmatter = {};
  if (fm.title) frontmatter.title = fm.title;

  return { nodes, images, frontmatter };
}

/**
 * Title derivation support for the create surfaces (FR-008/FR-012): squire
 * frontmatter title → first heading text → null. Also reports whether the
 * markdown has any real body once frontmatter is stripped (the create
 * surfaces seed an empty anchor document for frontmatter-only input — spec
 * §Edge Cases — while PUT rejects it, CN-11).
 *
 * Kept in the module so no surface parses markdown itself (FR-001); the
 * create flow pays one extra parse because image staging needs the document
 * row to exist (document_images FK) before prepareImport can run.
 *
 * @param {string} markdown
 * @returns {{ title: string|null, hasBody: boolean }}
 */
function deriveImportTitle(markdown) {
  const fm = importFrontmatter(markdown);
  const pmJson = reconstructImages(markdownToPm(fm.content));
  let firstHeading = null;
  for (const block of pmJson.content || []) {
    if (block && block.type === 'heading' && Array.isArray(block.content)) {
      const text = block.content
        .filter((n) => n && n.type === 'text' && typeof n.text === 'string')
        .map((n) => n.text)
        .join('')
        .trim();
      firstHeading = text || null;
      break;
    }
  }
  const hasBody =
    hasRealContent(pmJson) || (pmJson.content || []).some((b) => b && b.type === 'image');
  return {
    title: fm.title || firstHeading || null,
    hasBody,
  };
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

  // FAIL FAST, before the image work: a doomed XPath import should not rehost
  // images to S3 on its way to an error. This is an optimisation, NOT the
  // authoritative resolution — `prepareImport` awaits below, so the document
  // may move underneath us. The resolution that the insert actually uses is the
  // one in the compute phase (feature 049, E-049-A).
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
  //
  // Two-phase (feature 049). Under 048 the XPath target was re-resolved INSIDE
  // the transaction and threw from there; that is now exactly the forbidden
  // mutate-phase throw (yjs does not roll back, so a throw after any insert
  // would broadcast and persist a partial import). The resolution and its throw
  // move into the COMPUTE phase, which returns a mutate closure carrying the
  // already-resolved index.
  //
  // Behavior-preserving: compute and mutate run back to back on the same
  // document with no awaits between them, so the index is still resolved
  // against exactly the state the insert runs on (US2 AS4).
  const live = await documentService.updateDocument(
    imageContext.docId,
    (liveDoc) => {
      const liveFragment = liveDoc.get('default', Y.XmlFragment);

      if (mode === 'append') {
        // `length` is read inside the closure, at mutate time, so this still
        // appends to the current end of the document.
        return () => liveFragment.insert(liveFragment.length, nodes);
      }

      if (mode === 'replace') {
        // Block-level deletes + inserts against the SAME fragment — never
        // recreate the fragment or doc (plan.md Complexity Tracking).
        return () => {
          if (liveFragment.length > 0) liveFragment.delete(0, liveFragment.length);
          liveFragment.insert(0, nodes);
        };
      }

      // insertAfterXPath: resolve and throw HERE, before anything is touched.
      const match = xpathFirst(insertAfterXPath, liveFragment);
      const idx = match ? topLevelIndexOf(liveFragment, match) : -1;
      if (idx === -1) {
        throw new ImportError('XPATH_NO_MATCH', `No element matches XPath: ${insertAfterXPath}`);
      }
      return () => liveFragment.insert(idx + 1, nodes);
    },
    { userId: actor.userId, agentName: actor.agentName || null }
  );

  // `live` carries the transaction's bytes so the caller can fan them out
  // cross-instance when nothing else did (feature 037). INTERNAL module
  // contract — deliberately not part of the HTTP receipt.
  return {
    blocks: { imported: nodes.length },
    images,
    frontmatter,
    live: live || { update: null, hadRedisHandler: false },
  };
}

module.exports = {
  importMarkdown,
  prepareImport,
  stageImagePass,
  deriveImportTitle,
  importFrontmatter,
  sanitizeLinkMarks,
  reconstructImages,
  rejectDataImages,
  hasRealContent,
  isAllowedLinkHref,
  setExternalImagePass,
  ImportError,
  MODES,
};
