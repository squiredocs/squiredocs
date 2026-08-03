/**
 * Test helper: make a plain `Y.Doc` stand in for a genuinely LIVE shared doc
 * (feature 046).
 *
 * Restore and undo/redo only compute a stored artifact from the in-memory copy
 * of a document when that copy is trustworthy: bound (its persisted state has
 * been applied) AND connected (at least one live WebSocket, which is what keeps
 * it current). See server/live-doc-trust.js for why.
 *
 * A test that wants to exercise the LIVE path must therefore say so, because a
 * bare `Y.Doc` is exactly what a half-loaded or leaked registry doc looks like —
 * and those must fall back to the durable path. This helper is that statement,
 * in one place, so the shape stays in step with the predicate.
 *
 * @param {import('yjs').Doc} doc
 * @param {number} [connCount=1] - how many connections to model
 * @returns {import('yjs').Doc} the same doc, marked
 */
function asLiveSharedDoc(doc, connCount = 1) {
  doc._bindComplete = true;
  // Shaped like y-websocket's `WSSharedDoc.conns`: connection -> controlled ids.
  doc.conns = new Map();
  for (let i = 0; i < connCount; i += 1) doc.conns.set({ fakeConn: i }, new Set());
  return doc;
}

module.exports = { asLiveSharedDoc };
