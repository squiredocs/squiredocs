/**
 * Doc-start highlight renderability (read_document highlight regression,
 * 2026-08-01).
 *
 * The client's cursor resolver — @tiptap/y-tiptap 3.0.7
 * relativePositionToAbsolutePosition — ends with an upstream guard:
 *
 *   isMisresolvedTextPosition: decoded.type instanceof Y.XmlText
 *     && relPos.item !== null && absPos <= 1  → resolve to null
 *
 * A null endpoint drops the ENTIRE decoration (caret + selection) for that
 * awareness state. Every full-document read highlight anchors at char 0 of
 * block 0, which resolves to absolute position exactly 1 — so read highlights
 * (and the initial doc-start caret) were invisible while mid-document edit
 * highlights kept working. The 027 resolver-parity gate missed this because it
 * resolves through plain y-prosemirror, which has no such guard.
 *
 * Fix: offset-0 text positions serialize as the left-associated boundary form
 * ({ type, item: null, assoc: -1 }) — same resolved location (yjs: item null +
 * assoc < 0 → index 0), structurally immune to the guard (item === null).
 *
 * This suite pins (1) the serialized shape, (2) location equivalence through
 * the server resolver, (3) non-veto through the client resolver pipeline with
 * the guard predicate replicated verbatim from the pinned y-tiptap dist.
 */

const Y = require('yjs');
const { initProseMirrorDoc, relativePositionToAbsolutePosition } = require('y-prosemirror');
const { schema } = require('../../../../shared/prosemirror-schema');
const {
  createCursorPosition,
  createCursorPositionFromPath,
  createNodeSelection,
  createExpandingBlockHighlights,
  resolveCursorPosition,
} = require('../../yjs/cursor-operations');

function buildDoc() {
  const doc = new Y.Doc();
  doc.clientID = 42;
  const frag = doc.get('default', Y.XmlFragment);
  doc.transact(() => {
    const h = new Y.XmlElement('heading');
    h.setAttribute('level', '1');
    h.insert(0, [new Y.XmlText('Title text')]);
    const p1 = new Y.XmlElement('paragraph');
    p1.insert(0, [new Y.XmlText('First paragraph body.')]);
    const p2 = new Y.XmlElement('paragraph');
    p2.insert(0, [new Y.XmlText('Second paragraph body.')]);
    frag.insert(0, [h, p1, p2]);
  });
  return { doc, frag };
}

/** The client's resolver harness: live replica + headless PM mapping. */
function buildReplica(authorDoc) {
  const replica = new Y.Doc();
  Y.applyUpdate(replica, Y.encodeStateAsUpdate(authorDoc));
  const rf = replica.get('default', Y.XmlFragment);
  const { mapping } = initProseMirrorDoc(rf, schema);
  return { replica, rf, mapping };
}

/**
 * The veto predicate, replicated VERBATIM (modulo names) from
 * client/node_modules/@tiptap/y-tiptap/dist/y-tiptap.cjs 3.0.7. If a y-tiptap
 * upgrade changes it, re-check this copy against the dist.
 */
function isMisresolvedTextPosition(ydoc, relPosJson, absPos) {
  if (absPos === null) return false;
  const relPos = Y.createRelativePositionFromJSON(relPosJson);
  const decoded = Y.createAbsolutePositionFromRelativePosition(relPos, ydoc);
  return decoded !== null &&
    decoded.type instanceof Y.XmlText &&
    relPos.item !== null &&
    absPos <= 1;
}

/** Resolve through the client pipeline INCLUDING the guard; null = invisible. */
function resolveAsClient(harness, posJson) {
  const rel = Y.createRelativePositionFromJSON(posJson);
  const abs = relativePositionToAbsolutePosition(harness.replica, harness.rf, rel, harness.mapping);
  if (abs === null) return null;
  return isMisresolvedTextPosition(harness.replica, posJson, abs) ? null : abs;
}

describe('offset-0 text positions serialize as the boundary form', () => {
  test('createCursorPosition at block 0, offset 0', () => {
    const { frag } = buildDoc();
    const pos = createCursorPosition(frag, 0, 0);
    expect(pos.item == null).toBe(true);
    expect(pos.assoc).toBe(-1);
  });

  test('createCursorPositionFromPath at path [0], offset 0', () => {
    const { frag } = buildDoc();
    const pos = createCursorPositionFromPath(frag, [0], 0);
    expect(pos.item == null).toBe(true);
    expect(pos.assoc).toBe(-1);
  });

  test('non-zero offsets keep the item-anchored form', () => {
    const { frag } = buildDoc();
    const pos = createCursorPosition(frag, 0, 3);
    expect(pos.item).not.toBeNull();
    expect(pos.assoc).toBe(0);
  });
});

describe('boundary form resolves to the same location', () => {
  test('server resolver: block 0, offset 0', () => {
    const { frag } = buildDoc();
    const pos = createCursorPosition(frag, 0, 0);
    expect(resolveCursorPosition(frag, pos)).toEqual({
      blockIndex: 0,
      offset: 0,
      blockType: 'heading',
    });
  });
});

describe('doc-start highlights survive the client resolver guard', () => {
  test('full-document expanding highlight (the read_document default path)', () => {
    const { doc, frag } = buildDoc();
    const harness = buildReplica(doc);
    const positions = createExpandingBlockHighlights(frag, 0, 3);
    expect(positions.length).toBeGreaterThan(0);
    for (const { anchor, head } of positions) {
      const a = resolveAsClient(harness, anchor);
      const h = resolveAsClient(harness, head);
      expect(a).not.toBeNull();
      expect(h).not.toBeNull();
      expect(h).toBeGreaterThan(a); // a real, renderable selection
    }
    // The anchor is the doc-start position the old shape got vetoed at.
    expect(resolveAsClient(harness, positions[0].anchor)).toBe(1);
  });

  test('node selection of the FIRST block (xpath matching block 0)', () => {
    const { doc, frag } = buildDoc();
    const harness = buildReplica(doc);
    const sel = createNodeSelection(frag, frag.get(0));
    expect(sel).not.toBeNull();
    expect(resolveAsClient(harness, sel.anchor)).not.toBeNull();
    expect(resolveAsClient(harness, sel.head)).not.toBeNull();
  });

  test('regression oracle: the OLD item-anchored doc-start shape IS vetoed', () => {
    // Proves the replicated guard actually discriminates — if this stops
    // failing for the old shape, the verbatim copy above has drifted from the
    // installed y-tiptap dist and must be re-checked.
    const { doc, frag } = buildDoc();
    const harness = buildReplica(doc);
    const oldShape = Y.relativePositionToJSON(
      Y.createRelativePositionFromTypeIndex(frag.get(0).toArray()[0], 0)
    );
    expect(oldShape.item).not.toBeNull();
    expect(resolveAsClient(harness, oldShape)).toBeNull();
  });
});
