/**
 * ProseMirror Schema Validation for Yjs Documents
 *
 * Validates Yjs XmlFragment content against the shared ProseMirror schema
 * to catch invalid document structures before they propagate to clients.
 */

const Y = require('yjs');

/**
 * Build a ProseMirror-compatible JSON tree by walking the Yjs structure.
 *
 * Read-only traversal — unlike yXmlFragmentToProseMirrorRootNode from
 * y-prosemirror, this does NOT mutate the Yjs document.
 */
function yjsToProseMirrorJson(node) {
  if (node instanceof Y.XmlText) {
    const delta = node.toDelta();
    if (!delta.length) return [];
    return delta.map((op) => {
      const result = { type: 'text', text: op.insert };
      if (op.attributes) {
        result.marks = Object.entries(op.attributes)
          .filter(([, v]) => v !== null)
          .map(([type, value]) =>
            typeof value === 'object' ? { type, attrs: value } : { type }
          );
      }
      return result;
    });
  }

  if (node instanceof Y.XmlElement) {
    const children = [];
    for (let i = 0; i < node.length; i++) {
      const r = yjsToProseMirrorJson(node.get(i));
      if (Array.isArray(r)) children.push(...r);
      else children.push(r);
    }
    const json = { type: node.nodeName };
    if (children.length) json.content = children;
    const attrs = node.getAttributes();
    if (Object.keys(attrs).length) json.attrs = attrs;
    return json;
  }

  // XmlFragment → doc node
  const children = [];
  for (let i = 0; i < node.length; i++) {
    const r = yjsToProseMirrorJson(node.get(i));
    if (Array.isArray(r)) children.push(...r);
    else children.push(r);
  }
  return { type: 'doc', content: children.length ? children : undefined };
}

/**
 * Validate a Yjs XmlFragment against the ProseMirror schema.
 *
 * Builds a ProseMirror JSON tree from the Yjs structure (read-only, no
 * mutation), then uses schema.nodeFromJSON() + node.check() to validate.
 * Produces clear errors like:
 *   "Invalid content for node bulletList: <paragraph("Bad")>"
 *
 * @param {Y.XmlFragment} xmlFragment - Document fragment to validate
 * @returns {{ valid: boolean, error: string|null }}
 */
function validateDocumentSchema(xmlFragment) {
  try {
    const { schema } = require('../../../shared/prosemirror-schema');
    const json = yjsToProseMirrorJson(xmlFragment);
    const node = schema.nodeFromJSON(json);
    node.check();
    return { valid: true, error: null };
  } catch (err) {
    return { valid: false, error: err.message };
  }
}

module.exports = {
  validateDocumentSchema,
};
