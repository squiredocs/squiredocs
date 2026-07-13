/**
 * `fromMarkdown(md)` sandbox helper builder (feature 002, US3 / T024).
 *
 * Produces detached Yjs nodes from markdown, with the SAME contract as
 * cloneBlocks output (FR-009): insertable via the script's positioning
 * primitives, streamed live because they're built with the sandbox's tracked
 * constructors. Bundled into the isolate (esbuild), so it must stay Node-free.
 *
 * Runs the same parse → reconstruct-images → link-sanitation → data-rejection
 * pipeline as the import module (one grammar, FR-001 — shared via
 * pm-json-transforms), then materializes through the shared pmJsonToNodes
 * seam with the injected tracked constructors.
 *
 * Image handling inside the sandbox (research R3): rehosting is a host-side
 * async/network operation and cannot run in the isolate, so external http(s)
 * image nodes SURVIVE into the returned nodes but are TAGGED with a transient
 * marker attribute (IMPORT_ORIGIN_ATTR). modify's post-script pass consumes
 * the tag: tagged externals are rehosted (import-origin), untagged externals
 * keep today's strip behavior (FR-021). `data:` srcs never survive. App URLs
 * pass through untouched (the host's cross-doc reconciliation handles them).
 */

const { markdownToPm } = require('../../../shared/markdown');
const { pmJsonToNodes } = require('../yjs/pm-json-to-nodes');
const {
  sanitizeLinkMarks,
  reconstructImages,
  rejectDataImages,
  schemeOf,
} = require('../yjs/pm-json-transforms');

/**
 * Transient attribute marking an image node whose external src arrived via
 * `fromMarkdown` and must be rehosted (not stripped) by the modify post-pass.
 * The pass removes the attribute once consumed.
 */
const IMPORT_ORIGIN_ATTR = 'data-import-origin';

/**
 * Tag external http(s) image nodes in the PM JSON (pre-materialization) so
 * the marker survives into the Yjs node — detached Yjs nodes can't be read
 * back to tag them after the fact. Mutates and returns the PM JSON.
 */
function tagImportOriginImages(pmJson) {
  if (!pmJson || !Array.isArray(pmJson.content)) return pmJson;
  for (const block of pmJson.content) {
    if (!block || block.type !== 'image' || !block.attrs) continue;
    const scheme = schemeOf(block.attrs.src);
    if (scheme === 'http' || scheme === 'https') {
      block.attrs[IMPORT_ORIGIN_ATTR] = '1';
    }
  }
  return pmJson;
}

/**
 * Build the sandbox `fromMarkdown` global, bound to the tracked constructors.
 * @param {{ XmlElement: Function, XmlText: Function }} constructors
 * @returns {(md: string) => Array} synchronous, never throws
 */
function buildFromMarkdown({ XmlElement, XmlText }) {
  return function fromMarkdown(md) {
    if (typeof md !== 'string' || md.trim() === '') return [];
    let nodes;
    try {
      let pmJson = markdownToPm(md); // tolerant, never-lose-content, never throws
      pmJson = reconstructImages(pmJson);
      pmJson = sanitizeLinkMarks(pmJson);
      rejectDataImages(pmJson); // data: images dropped (in-fragment: no title/report)
      tagImportOriginImages(pmJson); // mark externals for the host rehost pass
      nodes = pmJsonToNodes(pmJson, { XmlElement, XmlText });
    } catch (e) {
      // Worst case: never throw on content we merely cannot structure. Emit
      // literal-text paragraphs (the parser's own last-resort ladder already
      // does this; this catch is belt-and-suspenders for the materializer).
      nodes = md
        .split('\n')
        .filter((line) => line.trim() !== '')
        .map((line) => {
          const para = new XmlElement('paragraph');
          const t = new XmlText();
          t.insert(0, line);
          para.insert(0, [t]);
          return para;
        });
    }
    return nodes;
  };
}

module.exports = { buildFromMarkdown, IMPORT_ORIGIN_ATTR };
