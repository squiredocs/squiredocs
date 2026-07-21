/**
 * Feature 027 — Read-only highlights: element-boundary anchoring is PURE.
 *
 * For a target element with no text run (empty paragraph, image, horizontal
 * rule, nested empty container, empty document), the position constructors
 * MUST:
 *   (a) write ZERO bytes to the Y.Doc (no persisted update),
 *   (b) create NO child inside the target element (no placeholder Y.XmlText),
 *   (c) return a position that resolves NON-NULL via
 *       Y.createAbsolutePositionFromRelativePosition (server-side resolution).
 *
 * Plus D-4: a nonzero offset into a text-less element clamps to the boundary
 * and does not throw.
 *
 * These assertions encode FR-001/FR-002/FR-003 and are expected to FAIL against
 * the pre-fix code (which inserted a placeholder text node).
 */

const Y = require('yjs');
const {
  createCursorPosition,
  createCursorPositionFromPath,
} = require('../../yjs/cursor-operations');

/** Count total descendant nodes under an element (children at every depth). */
function countDescendants(node) {
  let n = 0;
  if (node instanceof Y.XmlElement) {
    const kids = node.toArray();
    n += kids.length;
    for (const k of kids) n += countDescendants(k);
  }
  return n;
}

/** Assert a position JSON resolves to a non-null absolute position. */
function expectResolvesNonNull(doc, posJson) {
  expect(posJson).toBeDefined();
  const relPos = Y.createRelativePositionFromJSON(posJson);
  const absPos = Y.createAbsolutePositionFromRelativePosition(relPos, doc);
  expect(absPos).not.toBeNull();
}

/**
 * Run the purity + resolvability contract for a builder that returns
 * { doc, frag, targetPath, targetLinearIndex } and a caller (linear|path).
 */
function assertPure(build, callKind, offset) {
  const { doc, frag, targetPath, targetLinearIndex } = build();
  const before = Y.encodeStateAsUpdate(doc).length;

  // The element we expect NOT to gain children.
  let targetEl;
  if (callKind === 'linear') {
    targetEl = frag.get(targetLinearIndex);
  } else {
    targetEl = frag.get(targetPath[0]);
    for (let i = 1; i < targetPath.length; i++) {
      targetEl = targetEl.toArray()[targetPath[i]];
    }
  }
  const descBefore = countDescendants(targetEl);

  let pos;
  const run = () => {
    pos = callKind === 'linear'
      ? createCursorPosition(frag, targetLinearIndex, offset)
      : createCursorPositionFromPath(frag, targetPath, offset);
  };
  expect(run).not.toThrow();

  const after = Y.encodeStateAsUpdate(doc).length;
  const descAfter = countDescendants(targetEl);

  // (a) zero bytes written
  expect(after - before).toBe(0);
  // (b) no child created
  expect(descAfter).toBe(descBefore);
  // (c) resolves non-null
  expectResolvesNonNull(doc, pos);
}

// ---------------------------------------------------------------------------
// Builders — each returns a text-LESS target.
// ---------------------------------------------------------------------------

function emptyParagraph() {
  const doc = new Y.Doc();
  const frag = doc.get('default', Y.XmlFragment);
  frag.insert(0, [new Y.XmlElement('paragraph')]);
  return { doc, frag, targetPath: [0], targetLinearIndex: 0 };
}

function imageBlock() {
  const doc = new Y.Doc();
  const frag = doc.get('default', Y.XmlFragment);
  const img = new Y.XmlElement('image');
  img.setAttribute('src', 'https://example.com/x.png');
  frag.insert(0, [img]);
  return { doc, frag, targetPath: [0], targetLinearIndex: 0 };
}

function horizontalRule() {
  const doc = new Y.Doc();
  const frag = doc.get('default', Y.XmlFragment);
  frag.insert(0, [new Y.XmlElement('horizontalRule')]);
  return { doc, frag, targetPath: [0], targetLinearIndex: 0 };
}

function emptyBlockquote() {
  const doc = new Y.Doc();
  const frag = doc.get('default', Y.XmlFragment);
  frag.insert(0, [new Y.XmlElement('blockquote')]);
  return { doc, frag, targetPath: [0], targetLinearIndex: 0 };
}

// Nested empty list item: bulletList > listItem(empty). Path targets the item.
function nestedEmptyListItem() {
  const doc = new Y.Doc();
  const frag = doc.get('default', Y.XmlFragment);
  const list = new Y.XmlElement('bulletList');
  list.insert(0, [new Y.XmlElement('listItem')]);
  frag.insert(0, [list]);
  return { doc, frag, targetPath: [0, 0], targetLinearIndex: 0 };
}

// Nested empty table cell: table > tableRow > tableCell(empty).
function nestedEmptyTableCell() {
  const doc = new Y.Doc();
  const frag = doc.get('default', Y.XmlFragment);
  const table = new Y.XmlElement('table');
  const row = new Y.XmlElement('tableRow');
  row.insert(0, [new Y.XmlElement('tableCell')]);
  table.insert(0, [row]);
  frag.insert(0, [table]);
  return { doc, frag, targetPath: [0, 0, 0], targetLinearIndex: 0 };
}

describe('027 boundary anchoring — position math is pure for text-less targets', () => {
  describe('top-level text-less blocks (both constructors)', () => {
    const cases = [
      ['empty paragraph', emptyParagraph],
      ['image', imageBlock],
      ['horizontal rule', horizontalRule],
      ['empty blockquote', emptyBlockquote],
    ];
    for (const [name, build] of cases) {
      test(`${name}: createCursorPosition writes nothing and resolves`, () => {
        assertPure(build, 'linear', 0);
      });
      test(`${name}: createCursorPositionFromPath writes nothing and resolves`, () => {
        assertPure(build, 'path', 0);
      });
    }
  });

  describe('nested empty containers (path constructor targets the element)', () => {
    test('empty list item: boundary anchor at the item, no insertion', () => {
      assertPure(nestedEmptyListItem, 'path', 0);
    });
    test('empty table cell: boundary anchor at the cell, no insertion', () => {
      assertPure(nestedEmptyTableCell, 'path', 0);
    });
  });

  describe('D-4 — nonzero offset into a text-less element clamps to boundary', () => {
    test('createCursorPosition with past-end offset does not throw and writes nothing', () => {
      assertPure(emptyParagraph, 'linear', 999);
    });
    test('createCursorPositionFromPath with past-end offset does not throw and writes nothing', () => {
      assertPure(nestedEmptyListItem, 'path', 999);
    });
    test('image with a large offset still clamps to boundary, no write', () => {
      assertPure(imageBlock, 'linear', 500);
    });
  });

  describe('empty document (zero blocks)', () => {
    test('a position request on an empty fragment writes zero bytes', () => {
      const doc = new Y.Doc();
      const frag = doc.get('default', Y.XmlFragment);
      const before = Y.encodeStateAsUpdate(doc).length;
      // No block exists to anchor to; the constructor may throw out-of-bounds,
      // but it MUST NOT write. The read path handles "no highlight" above this.
      try { createCursorPosition(frag, 0, 0); } catch (_) { /* out of bounds ok */ }
      try { createCursorPositionFromPath(frag, [0], 0); } catch (_) { /* ok */ }
      const after = Y.encodeStateAsUpdate(doc).length;
      expect(after - before).toBe(0);
      expect(frag.toArray().length).toBe(0);
    });
  });
});
