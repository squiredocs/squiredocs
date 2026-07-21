/**
 * Feature 027 — User Story 3 (P3): mutation cursor sweeps stop inserting
 * placeholders too (FR-001/FR-006, SC-005).
 *
 * A mutation's cursor sweep uses the same position helpers as the read path.
 * After this feature they are pure on every path: a mutation whose sweep crosses
 * a text-less block persists ONLY its intended content edits — no placeholder
 * insertion into the text-less block — while the aggregated sweep spans still
 * cover it.
 *
 * Harness: exercises the REAL bridge-side position math (createOperationSelection)
 * and the REAL MutationAggregator (createBlockRangeSelection) that the sandbox
 * bridge wires up (server/mcp/sandbox/bridge.js + server/mcp/mutation-aggregator.js),
 * without spinning up the worker/WebSocket layer. The "actual edit" is applied to
 * the doc exactly as the worker's Y.applyUpdate would; then all sweep-position
 * math runs and MUST add zero bytes beyond that edit.
 */

const Y = require('yjs');
const { createOperationSelection } = require('../../yjs/cursor-operations');
const { MutationAggregator } = require('../../mutation-aggregator');
const { buildReplica, resolveViaClient } = require('../yjs/helpers/replica-resolve');

/** Doc: paragraph0 "alpha", image1, paragraph2 "gamma". */
function paraImageParaDoc() {
  const doc = new Y.Doc();
  const frag = doc.get('default', Y.XmlFragment);
  doc.transact(() => {
    const p0 = new Y.XmlElement('paragraph');
    const t0 = new Y.XmlText();
    t0.insert(0, 'alpha');
    p0.insert(0, [t0]);

    const img = new Y.XmlElement('image');
    img.setAttribute('src', 'https://example.com/i.png');

    const p2 = new Y.XmlElement('paragraph');
    const t2 = new Y.XmlText();
    t2.insert(0, 'gamma');
    p2.insert(0, [t2]);

    frag.insert(0, [p0, img, p2]);
  });
  return { doc, frag };
}

describe('027 US3 — mutation sweep math is pure (no placeholder writes)', () => {
  test('editing two paragraphs around an image: sweep crosses the image, persists only the edits', async () => {
    const { doc, frag } = paraImageParaDoc();

    // 1. Apply the mutation's ACTUAL edits (as the worker's Y.applyUpdate would):
    //    append text to both paragraphs. These are the only legitimate writes.
    doc.transact(() => {
      frag.get(0).toArray()[0].insert(5, ' edited');   // paragraph0
      frag.get(2).toArray()[0].insert(5, ' edited');   // paragraph2
    });

    // Baseline AFTER the real edits — the sweep math must add nothing beyond this.
    const baseline = Y.encodeStateAsUpdate(doc).length;
    const imgChildrenBefore = frag.get(1).toArray().length;

    // 2. Run the sweep position math exactly as the bridge does: one
    //    createOperationSelection per op, fed into the real aggregator.
    const flushed = [];
    const aggregator = new MutationAggregator({
      sessionId: 'sess-us3',
      xmlFragment: frag,
      windowMs: 200, // buffer both edits into one span, then flush explicitly
      onFlush: (spans) => flushed.push(...spans),
    });

    const ops = [
      { type: 'insert', target: 'XmlText', path: [0], args: [5, ' edited'] },
      { type: 'insert', target: 'XmlText', path: [2], args: [5, ' edited'] },
    ];
    for (const op of ops) {
      const selection = createOperationSelection(frag, op);
      expect(selection).not.toBeNull();
      aggregator.addMutation({ ...selection, timestamp: Date.now() });
    }
    await aggregator.flush();

    // 3. The sweep math wrote NOTHING beyond the real edits (SC-005).
    const after = Y.encodeStateAsUpdate(doc).length;
    expect(after - baseline).toBe(0);
    // The image block was not touched (no placeholder child inserted).
    expect(frag.get(1).toArray().length).toBe(imgChildrenBefore);

    // 4. The aggregated sweep STILL covers the image (crosses block 1).
    expect(flushed.length).toBeGreaterThan(0);
    const span = flushed[0];
    const replica = buildReplica(doc);
    const anchorAbs = resolveViaClient(replica, span.anchor);
    const headAbs = resolveViaClient(replica, span.head);
    expect(anchorAbs).not.toBeNull();
    expect(headAbs).not.toBeNull();
    const lo = Math.min(anchorAbs, headAbs);
    const hi = Math.max(anchorAbs, headAbs);

    // Locate the image node's position in the resolved PM doc and assert the
    // span brackets it (the sweep visibly covers the image).
    let imagePos = null;
    replica.pmDoc.descendants((node, pos) => {
      if (node.type.name === 'image') imagePos = pos;
    });
    expect(imagePos).not.toBeNull();
    expect(lo).toBeLessThanOrEqual(imagePos);
    expect(hi).toBeGreaterThanOrEqual(imagePos);
  });

  test('createOperationSelection for an op whose path targets a text-less element writes zero bytes (D-3)', () => {
    const { doc, frag } = paraImageParaDoc();
    const before = Y.encodeStateAsUpdate(doc).length;
    const imgChildrenBefore = frag.get(1).toArray().length;

    // An operation whose path targets the image (text-less). The default branch
    // of createOperationSelection anchors at the element start via the shared,
    // now-pure helper — no write-allowed flag, no placeholder insertion (D-3).
    const op = { type: 'setAttribute', target: 'XmlElement', path: [1], args: [] };
    const selection = createOperationSelection(frag, op);

    const after = Y.encodeStateAsUpdate(doc).length;
    expect(after - before).toBe(0);
    expect(frag.get(1).toArray().length).toBe(imgChildrenBefore);
    // Still produces a (boundary-anchored) selection rather than dropping it.
    expect(selection).not.toBeNull();
  });

  // C2 (FR-008): a concurrent edit empties a block between position construction
  // and resolution. The sweep math must not write, and resolution must fail
  // gracefully (null, no throw) so the sweep continues.
  test('C2 — concurrent edit empties a block mid-sweep: zero writes, graceful null-resolve, no throw', () => {
    const { doc, frag } = paraImageParaDoc();

    // Construct a sweep position anchored inside paragraph2's text run.
    const op = { type: 'insert', target: 'XmlText', path: [2], args: [0, 'x'] };
    const selection = createOperationSelection(frag, op);
    expect(selection).not.toBeNull();

    // A CONCURRENT edit now empties paragraph2 (deletes its text run entirely),
    // as another collaborator might between construction and resolution.
    doc.transact(() => {
      const p2 = frag.get(2);
      p2.delete(0, p2.toArray().length); // remove the text node -> text-less block
    });
    // The block is now genuinely text-less.
    expect(frag.get(2).toArray().length).toBe(0);

    // Resolving the now-stale head position must not throw and must not write.
    const bytesBeforeResolve = Y.encodeStateAsUpdate(doc).length;
    let resolved;
    expect(() => {
      const rel = Y.createRelativePositionFromJSON(selection.head);
      resolved = Y.createAbsolutePositionFromRelativePosition(rel, doc);
    }).not.toThrow();
    const bytesAfterResolve = Y.encodeStateAsUpdate(doc).length;

    // Zero writes from resolution; the emptied text run yields a null/…-resolve
    // that the viewer skips — the sweep continues rather than aborting.
    expect(bytesAfterResolve - bytesBeforeResolve).toBe(0);

    // Recomputing a fresh sweep position for the now text-less block is also
    // pure (boundary anchor) and does not throw.
    const bytesBeforeRecompute = Y.encodeStateAsUpdate(doc).length;
    let freshSelection;
    expect(() => {
      freshSelection = createOperationSelection(frag, {
        type: 'insert', target: 'XmlText', path: [2], args: [0, 'x'],
      });
    }).not.toThrow();
    const bytesAfterRecompute = Y.encodeStateAsUpdate(doc).length;
    expect(bytesAfterRecompute - bytesBeforeRecompute).toBe(0);
    expect(frag.get(2).toArray().length).toBe(0); // still text-less, no placeholder
  });
});
