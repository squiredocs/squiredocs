/**
 * Feature 027 — User Story 2 (P2): text-less blocks still get a visible,
 * resolvable highlight; none are silently dropped (FR-004/SC-003).
 *
 * The cheap "zero-write" fix would skip text-less blocks — passing US1 while
 * quietly degrading the presence feature. These tests block that: every block
 * in an expanding read sweep (including image/hr/empty-paragraph) is covered,
 * and every emitted anchor/head resolves NON-NULL under the client's resolution
 * semantics (the live-replica y-prosemirror resolver).
 */

const Y = require('yjs');
const {
  createExpandingBlockHighlights,
  computeExpandingChunks,
  createNodeSelection,
  createBlockRangeSelection,
} = require('../../yjs/cursor-operations');
const { buildReplica, resolveViaClient } = require('./helpers/replica-resolve');

/** A doc mixing text and text-less blocks (8 blocks). */
function mixedDoc() {
  const doc = new Y.Doc();
  const frag = doc.get('default', Y.XmlFragment);
  doc.transact(() => {
    const textPara = (s) => {
      const p = new Y.XmlElement('paragraph');
      const t = new Y.XmlText();
      t.insert(0, s);
      p.insert(0, [t]);
      return p;
    };
    const image = () => {
      const img = new Y.XmlElement('image');
      img.setAttribute('src', 'https://example.com/i.png');
      return img;
    };
    const hr = () => new Y.XmlElement('horizontalRule');
    frag.insert(0, [
      textPara('first'),   // 0 text
      image(),             // 1 text-less
      textPara('third'),   // 2 text
      hr(),                // 3 text-less
      textPara('fifth'),   // 4 text
      image(),             // 5 text-less
      hr(),                // 6 text-less
      textPara('eighth'),  // 7 text
    ]);
  });
  return { doc, frag };
}

describe('027 US2 — expanding sweep fidelity over mixed text/text-less blocks', () => {
  test('createExpandingBlockHighlights drops no step and every endpoint resolves', () => {
    const { doc, frag } = mixedDoc();
    const n = frag.length; // 8
    const { targetChunks } = computeExpandingChunks(n);

    const positions = createExpandingBlockHighlights(frag, 0, n);

    // No dropped steps: one position per expanding chunk (SC-003, scenario 2).
    expect(positions.length).toBe(targetChunks);

    const replica = buildReplica(doc);
    const resolvedHeads = [];
    for (const { anchor, head } of positions) {
      const a = resolveViaClient(replica, anchor);
      const h = resolveViaClient(replica, head);
      expect(a).not.toBeNull();
      expect(h).not.toBeNull();
      resolvedHeads.push(h);
    }

    // The sweep expands monotonically (no gaps) and the last head reaches the
    // end of the document (covers the final block, whatever its type).
    for (let i = 1; i < resolvedHeads.length; i++) {
      expect(resolvedHeads[i]).toBeGreaterThan(resolvedHeads[i - 1]);
    }
    // Last head lands at/near the document end (within the last block).
    expect(resolvedHeads[resolvedHeads.length - 1]).toBeGreaterThanOrEqual(replica.pmDoc.content.size - 2);
  });

  test('a head landing on a text-less block still resolves (image at chunk boundary)', () => {
    // computeExpandingChunks(8) => 3 chunks of 3 => heads at blocks 2, 5, 7;
    // block 5 is an image (text-less). Confirm that head resolves.
    const { doc, frag } = mixedDoc();
    const positions = createExpandingBlockHighlights(frag, 0, frag.length);
    const replica = buildReplica(doc);
    // Second position's head is at block index 5 (the image).
    const secondHead = resolveViaClient(replica, positions[1].head);
    expect(secondHead).not.toBeNull();
    expect(typeof secondHead).toBe('number');
  });
});

describe('027 US2 — node/range selections over text-less blocks are non-null and resolvable', () => {
  test('createNodeSelection returns a resolvable selection for image and hr (read path emits, not skips)', () => {
    const { doc, frag } = mixedDoc();
    const replica = buildReplica(doc);
    for (const idx of [1, 3, 5, 6]) {
      const node = frag.get(idx);
      const sel = createNodeSelection(frag, node);
      // Non-null => the read-document xpath branch pushes a highlight for this
      // text-less node rather than skipping it.
      expect(sel).not.toBeNull();
      expect(resolveViaClient(replica, sel.anchor)).not.toBeNull();
      expect(resolveViaClient(replica, sel.head)).not.toBeNull();
    }
  });

  test('createNodeSelection resolves for an empty paragraph', () => {
    const doc = new Y.Doc();
    const frag = doc.get('default', Y.XmlFragment);
    doc.transact(() => {
      const p = new Y.XmlElement('paragraph');
      const t = new Y.XmlText();
      t.insert(0, 'lead');
      p.insert(0, [t]);
      frag.insert(0, [p, new Y.XmlElement('paragraph')]); // [1] empty paragraph
    });
    const emptyP = frag.get(1);
    const sel = createNodeSelection(frag, emptyP);
    expect(sel).not.toBeNull();
    const replica = buildReplica(doc);
    expect(resolveViaClient(replica, sel.anchor)).not.toBeNull();
    expect(resolveViaClient(replica, sel.head)).not.toBeNull();
  });

  test('createBlockRangeSelection spanning text-less blocks resolves both endpoints', () => {
    const { doc, frag } = mixedDoc();
    // Range [1..6] starts on an image and ends on an hr (both text-less).
    const sel = createBlockRangeSelection(frag, 1, 6);
    expect(sel).not.toBeNull();
    const replica = buildReplica(doc);
    expect(resolveViaClient(replica, sel.anchor)).not.toBeNull();
    expect(resolveViaClient(replica, sel.head)).not.toBeNull();
  });
});
