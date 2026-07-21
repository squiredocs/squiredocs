/**
 * Feature 027 — Resolver-parity GATE (FR-004/SC-003, research R-3).
 *
 * GO/NO-GO decision procedure for the chosen anchoring construction. Proves
 * that an element-boundary anchor — Y.createRelativePositionFromTypeIndex(el, 0)
 * — resolves NON-NULL through the SAME resolver the client viewer uses:
 * y-prosemirror's relativePositionToAbsolutePosition, over the app schema
 * (shared/prosemirror-schema.js), on a LIVE REPLICA (a second Y.Doc synced from
 * the author doc; PM mapping built headlessly via initProseMirrorDoc — the
 * client's ySyncPlugin binding.mapping equivalent).
 *
 * GATE OUTCOME (recorded): GO for the element-boundary construction. Every
 * text-less block that can appear in a VALID ProseMirror document resolves
 * non-null: empty paragraph, image, horizontalRule, and the empty paragraph
 * that a real "empty" blockquote / list item actually contains (the schema
 * requires block+/paragraph content, so a rendered empty container is
 * container > empty paragraph, never a bare empty container).
 *
 * A BARE empty container (blockquote/listItem/tableCell with zero children) is
 * schema-invalid, is dropped by ProseMirror, and resolves null under this
 * resolver — with the OLD placeholder-inserting code too (inserting a bare
 * Y.XmlText into a blockquote is still schema-invalid). For that unreachable
 * shape the invariant that matters is FR-009: the construction still writes
 * ZERO bytes and the presence effect is skipped (fail-observational), never a
 * write. Asserted in the fail-observational block below. This is why the
 * fragment-index fallback (research R-3) was NOT needed: element-boundary
 * anchoring already resolves for every renderable text-less block.
 */

const Y = require('yjs');
const { initProseMirrorDoc, relativePositionToAbsolutePosition } = require('y-prosemirror');
const { schema } = require('../../../../shared/prosemirror-schema');
const {
  createCursorPositionFromPath,
  createNodeSelection,
} = require('../../yjs/cursor-operations');

/**
 * Sync a live replica from the author doc and build the headless PM mapping
 * (the client's ySyncPlugin binding.mapping equivalent).
 */
function buildReplica(authorDoc) {
  const replica = new Y.Doc();
  Y.applyUpdate(replica, Y.encodeStateAsUpdate(authorDoc));
  const rf = replica.get('default', Y.XmlFragment);
  const { mapping } = initProseMirrorDoc(rf, schema);
  return { replica, rf, mapping };
}

/** Resolve a serialized RelativePosition through the client's resolver. */
function resolveViaClient({ replica, rf, mapping }, posJson) {
  const rel = Y.createRelativePositionFromJSON(posJson);
  return relativePositionToAbsolutePosition(replica, rf, rel, mapping);
}

/** Resolve a Y element from a fragment by descending a child-index path. */
function elementAtPath(frag, path) {
  let el = frag.get(path[0]);
  for (let i = 1; i < path.length; i++) el = el.toArray()[path[i]];
  return el;
}

/**
 * Author doc holding every RENDERABLE text-less shape at a known path:
 *   [0]        paragraph "anchor text"
 *   [1]        empty paragraph
 *   [2]        image
 *   [3]        horizontalRule
 *   [4][0]     blockquote > empty paragraph  (a real empty blockquote)
 *   [5][0][0]  bulletList > listItem > empty paragraph  (a real empty list item)
 */
function authorWithRenderableTextless() {
  const doc = new Y.Doc();
  const frag = doc.get('default', Y.XmlFragment);
  doc.transact(() => {
    const p = new Y.XmlElement('paragraph');
    const t = new Y.XmlText();
    t.insert(0, 'anchor text');
    p.insert(0, [t]);

    const emptyP = new Y.XmlElement('paragraph');
    const img = new Y.XmlElement('image');
    img.setAttribute('src', 'https://example.com/x.png');
    const hr = new Y.XmlElement('horizontalRule');

    const quote = new Y.XmlElement('blockquote');
    quote.insert(0, [new Y.XmlElement('paragraph')]);

    const list = new Y.XmlElement('bulletList');
    const item = new Y.XmlElement('listItem');
    item.insert(0, [new Y.XmlElement('paragraph')]);
    list.insert(0, [item]);

    frag.insert(0, [p, emptyP, img, hr, quote, list]);
  });
  return { doc, frag };
}

const RENDERABLE_TARGETS = [
  { name: 'empty paragraph', path: [1] },
  { name: 'image', path: [2] },
  { name: 'horizontalRule', path: [3] },
  { name: 'empty paragraph inside blockquote', path: [4, 0] },
  { name: 'empty paragraph inside list item', path: [5, 0, 0] },
];

describe('027 resolver-parity GATE — element-boundary anchors resolve on a live replica', () => {
  describe('direct construction (the go/no-go decision) — renderable text-less blocks', () => {
    for (const target of RENDERABLE_TARGETS) {
      test(`${target.name}: createRelativePositionFromTypeIndex(el, 0) resolves non-null`, () => {
        const { doc, frag } = authorWithRenderableTextless();
        const el = elementAtPath(frag, target.path);
        const json = Y.relativePositionToJSON(Y.createRelativePositionFromTypeIndex(el, 0));

        const replica = buildReplica(doc);
        const abs = resolveViaClient(replica, json);
        expect(abs).not.toBeNull();
        expect(typeof abs).toBe('number');
      });
    }
  });

  describe('shipped helper output resolves for renderable text-less blocks (post-fix)', () => {
    for (const target of RENDERABLE_TARGETS) {
      test(`${target.name}: createCursorPositionFromPath anchor+head resolve non-null`, () => {
        const { doc, frag } = authorWithRenderableTextless();
        const anchorJson = createCursorPositionFromPath(frag, target.path, 0);
        const headJson = createCursorPositionFromPath(frag, target.path, 999); // clamps to boundary

        const replica = buildReplica(doc);
        expect(resolveViaClient(replica, anchorJson)).not.toBeNull();
        expect(resolveViaClient(replica, headJson)).not.toBeNull();
      });

      test(`${target.name}: createNodeSelection endpoints resolve non-null`, () => {
        const { doc, frag } = authorWithRenderableTextless();
        const node = elementAtPath(frag, target.path);
        const sel = createNodeSelection(frag, node);
        expect(sel).not.toBeNull();

        const replica = buildReplica(doc);
        expect(resolveViaClient(replica, sel.anchor)).not.toBeNull();
        expect(resolveViaClient(replica, sel.head)).not.toBeNull();
      });
    }
  });

  describe('fail-observational (FR-009) — bare schema-invalid empty container', () => {
    // A bare empty blockquote cannot exist in a valid ProseMirror document and
    // is dropped on render, so its boundary position resolves null under the
    // client resolver. The invariant that must hold is ZERO WRITE: the position
    // math is pure even for this unreachable shape, and the highlight is simply
    // skipped rather than forced by a mutation.
    test('bare empty blockquote: construction writes nothing; PM resolution is null (skipped, not written)', () => {
      const doc = new Y.Doc();
      const frag = doc.get('default', Y.XmlFragment);
      frag.insert(0, [new Y.XmlElement('blockquote')]);

      const before = Y.encodeStateAsUpdate(doc).length;
      const pos = createCursorPositionFromPath(frag, [0], 0);
      const after = Y.encodeStateAsUpdate(doc).length;

      // Purity holds even for the unreachable shape.
      expect(after - before).toBe(0);
      expect(frag.get(0).toArray().length).toBe(0);

      // Server-level (Yjs) resolution is non-null (the element exists)...
      const relPos = Y.createRelativePositionFromJSON(pos);
      expect(Y.createAbsolutePositionFromRelativePosition(relPos, doc)).not.toBeNull();

      // ...but the CLIENT PM resolver returns null because the bare container
      // never renders — the highlight is fail-observationally skipped.
      const replica = buildReplica(doc);
      expect(resolveViaClient(replica, pos)).toBeNull();
    });
  });
});
