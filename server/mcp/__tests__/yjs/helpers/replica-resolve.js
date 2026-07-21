/**
 * Feature 027 test helper — resolve serialized presence positions exactly the
 * way the client viewer does: through y-prosemirror's
 * relativePositionToAbsolutePosition over the app schema, on a LIVE REPLICA (a
 * second Y.Doc synced from the author doc; PM mapping built headlessly via
 * initProseMirrorDoc — the ySyncPlugin binding.mapping equivalent).
 */

const Y = require('yjs');
const { initProseMirrorDoc, relativePositionToAbsolutePosition } = require('y-prosemirror');
const { schema } = require('../../../../../shared/prosemirror-schema');

/** Sync a live replica from the author doc and build the headless PM mapping. */
function buildReplica(authorDoc) {
  const replica = new Y.Doc();
  Y.applyUpdate(replica, Y.encodeStateAsUpdate(authorDoc));
  const rf = replica.get('default', Y.XmlFragment);
  const { doc: pmDoc, mapping } = initProseMirrorDoc(rf, schema);
  return { replica, rf, mapping, pmDoc };
}

/** Resolve a serialized RelativePosition through the client's resolver. */
function resolveViaClient({ replica, rf, mapping }, posJson) {
  const rel = Y.createRelativePositionFromJSON(posJson);
  return relativePositionToAbsolutePosition(replica, rf, rel, mapping);
}

module.exports = { buildReplica, resolveViaClient };
