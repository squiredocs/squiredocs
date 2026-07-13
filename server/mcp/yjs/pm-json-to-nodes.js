/**
 * PM-JSON → detached Yjs nodes (feature 002, research R1).
 *
 * The single materialization seam between the shared markdown parser's
 * ProseMirror JSON output and Yjs block nodes, used by both the server-side
 * import module (`server/markdown-import.js`) and the sandbox `fromMarkdown`
 * helper. Two steps:
 *
 *   1. Materialize the PM JSON into a scratch Y.Doc via y-prosemirror driven
 *      by the shared ProseMirror schema (schema-aware, mark-preserving — the
 *      exact inverse of the serializer's y→pm path).
 *   2. Re-create the resulting tree as DETACHED nodes with
 *      `helpers.cloneNodes(scratchFragment, { XmlElement, XmlText })` — the
 *      options-object constructor pattern that lets the sandbox pass its
 *      tracked wrapped constructors while server callers use plain `Y.*`.
 *
 * Detachment matters twice over: Yjs nodes attached to one doc cannot be
 * inserted into another, and the sandbox needs nodes built from its tracked
 * constructors so insertions stream like any other script mutation.
 *
 * CommonJS, no Node built-ins — this module is bundled into the isolate
 * (esbuild, platform: neutral) alongside yjs/prosemirror-model/y-prosemirror.
 */

const Y = require('yjs');
const { Schema, Node } = require('prosemirror-model');
const { prosemirrorToYXmlFragment } = require('y-prosemirror');
const { nodes: baseNodes, marks: baseMarks } = require('../../../shared/prosemirror-schema');
const { cloneNodes } = require('../sandbox/helpers');

// Local schema patches (this module's Schema instance only — the shared schema
// is not modified, mirroring html-serialization.js's textStyle patch):
//
// 1. codeBlock gains a `language` attr. The editor stores the fence language
//    as a Yjs attribute and toMarkdown re-emits it, but the shared PM schema
//    spec doesn't declare it — Node.fromJSON silently drops undeclared attrs,
//    which would strip every ```lang fence on import.
const nodes = { ...baseNodes };
if (nodes.codeBlock && !(nodes.codeBlock.attrs && nodes.codeBlock.attrs.language)) {
  nodes.codeBlock = {
    ...nodes.codeBlock,
    attrs: { ...(nodes.codeBlock.attrs || {}), language: { default: null } },
  };
}

// 1b. image gains the transient `data-import-origin` marker attr. fromMarkdown
//    tags externally-srced image nodes with it (in PM JSON, pre-materialization
//    — detached Yjs nodes can't be read back to tag them) so modify's
//    post-script pass knows which externals to rehost vs strip (research R3,
//    FR-021). Undeclared PM attrs are silently dropped by Node.fromJSON, so the
//    marker must be declared here to survive materialization. The server import
//    path never sets it, so this is inert there.
if (nodes.image) {
  nodes.image = {
    ...nodes.image,
    attrs: { ...(nodes.image.attrs || {}), 'data-import-origin': { default: null } },
  };
}

// 2. subscript/superscript must exclude THEMSELVES as well as each other.
//    Their shared-schema specs set `excludes` to only the opposing mark, and
//    y-prosemirror treats any mark that doesn't exclude itself as an
//    "overlapping" mark, storing it under a hash-suffixed attribute name
//    (e.g. `subscript--u+…`) that toMarkdown and the editor don't recognize.
const marks = { ...baseMarks };
for (const [a, b] of [['subscript', 'superscript'], ['superscript', 'subscript']]) {
  if (marks[a] && marks[a].excludes && !marks[a].excludes.split(' ').includes(a)) {
    marks[a] = { ...marks[a], excludes: `${a} ${b}` };
  }
}

const schema = new Schema({ nodes, marks });

/**
 * Convert a ProseMirror doc JSON into detached Yjs block nodes.
 *
 * @param {object} pmJson - ProseMirror document JSON ({ type: 'doc', content })
 *   as produced by `shared/markdown`'s `markdownToPm`.
 * @param {object} [options]
 * @param {Function} [options.XmlElement] - XmlElement constructor (default Y.XmlElement)
 * @param {Function} [options.XmlText] - XmlText constructor (default Y.XmlText)
 * @returns {Array} Detached Yjs nodes (one per top-level block), insertable
 *   into any fragment via `fragment.insert(index, nodes)`.
 */
function pmJsonToNodes(pmJson, options = {}) {
  if (!pmJson || pmJson.type !== 'doc' || !Array.isArray(pmJson.content) || pmJson.content.length === 0) {
    return [];
  }

  const pmNode = Node.fromJSON(schema, pmJson);

  const scratch = new Y.Doc();
  try {
    const scratchFragment = scratch.get('scratch', Y.XmlFragment);
    prosemirrorToYXmlFragment(pmNode, scratchFragment);
    return cloneNodes(scratchFragment, {
      XmlElement: options.XmlElement || Y.XmlElement,
      XmlText: options.XmlText || Y.XmlText,
    });
  } finally {
    scratch.destroy();
  }
}

module.exports = { pmJsonToNodes, schema };
