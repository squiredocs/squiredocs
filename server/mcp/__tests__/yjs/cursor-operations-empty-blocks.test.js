/**
 * Tests for cursor operations with empty blocks.
 *
 * Feature 027 (read-only-highlights) RE-PIN: this suite previously asserted the
 * BUGGY behavior — that positioning a cursor in a text-less block INSERTED a
 * placeholder Y.XmlText (children.length === 1, children[0] instanceof
 * Y.XmlText). That insertion was a persisted, agent-attributed write produced by
 * a read-only operation. The invariant is now "position math never writes": a
 * text-less block is anchored at its element boundary with NO child created.
 *
 * These tests are re-pinned honestly to the new invariant (SC-006, research
 * R-5) — no child is created, and the returned position still resolves at the
 * boundary — not deleted.
 */

const Y = require('yjs');
const {
  createCursorPosition,
  resolveCursorPosition,
} = require('../../yjs/cursor-operations');

describe('Cursor Operations - Empty Block Handling', () => {
  let ydoc, xmlFragment;

  beforeEach(() => {
    ydoc = new Y.Doc();
    xmlFragment = ydoc.get('default', Y.XmlFragment);
  });

  test('createCursorPosition anchors an empty block at its boundary without creating a text node', () => {
    // Create a paragraph block with NO text nodes (empty block)
    const emptyParagraph = new Y.XmlElement('paragraph');
    xmlFragment.insert(0, [emptyParagraph]);

    const before = Y.encodeStateAsUpdate(ydoc).length;
    // Post-fix: returns a boundary-anchored position and writes nothing.
    const cursorPos = createCursorPosition(xmlFragment, 0, 0);
    const after = Y.encodeStateAsUpdate(ydoc).length;

    expect(cursorPos).toBeDefined();
    expect(cursorPos).toHaveProperty('type');
    expect(cursorPos.type).toHaveProperty('client');
    expect(cursorPos.type).toHaveProperty('clock');

    // The position math wrote nothing.
    expect(after - before).toBe(0);

    // No placeholder text node was created in the block.
    const block = xmlFragment.toArray()[0];
    expect(block.toArray().length).toBe(0);

    // The boundary position still resolves.
    const resolved = resolveCursorPosition(xmlFragment, cursorPos);
    expect(resolved).toBeDefined();
    expect(resolved.blockIndex).toBe(0);
  });

  test('createCursorPosition at an end/past-end offset in an empty block creates no text node', () => {
    // Create multiple blocks, some empty
    const paragraph1 = new Y.XmlElement('paragraph');
    const text1 = new Y.XmlText();
    text1.insert(0, 'First paragraph');
    paragraph1.insert(0, [text1]);

    const emptyParagraph = new Y.XmlElement('paragraph');  // No text nodes

    const paragraph3 = new Y.XmlElement('paragraph');
    const text3 = new Y.XmlText();
    text3.insert(0, 'Third paragraph');
    paragraph3.insert(0, [text3]);

    xmlFragment.insert(0, [paragraph1, emptyParagraph, paragraph3]);

    const before = Y.encodeStateAsUpdate(ydoc).length;
    // Position at the end of the empty block (block index 1), offset beyond length.
    const cursorPos = createCursorPosition(xmlFragment, 1, 999);
    const after = Y.encodeStateAsUpdate(ydoc).length;

    expect(cursorPos).toBeDefined();
    expect(after - before).toBe(0);

    // The empty block still has NO children (no placeholder text node).
    const block = xmlFragment.toArray()[1];
    expect(block.toArray().length).toBe(0);
  });

  test('cursor works normally after an empty block gains text via a real edit', () => {
    // Create empty block
    const emptyParagraph = new Y.XmlElement('paragraph');
    xmlFragment.insert(0, [emptyParagraph]);

    // Create cursor position (pure — no text node created)
    const pos1 = createCursorPosition(xmlFragment, 0, 0);
    expect(pos1).toBeDefined();
    expect(xmlFragment.toArray()[0].toArray().length).toBe(0);

    // Resolve the boundary position
    const resolved1 = resolveCursorPosition(xmlFragment, pos1);
    expect(resolved1).toBeDefined();
    expect(resolved1.blockIndex).toBe(0);
    expect(resolved1.offset).toBe(0);

    // Now a REAL edit adds text to the block (this is a mutation, not position math).
    const textNode = new Y.XmlText();
    xmlFragment.toArray()[0].insert(0, [textNode]);
    textNode.insert(0, 'Hello world');

    // Create a new cursor position in the middle of the text
    const pos2 = createCursorPosition(xmlFragment, 0, 5);
    expect(pos2).toBeDefined();

    const resolved2 = resolveCursorPosition(xmlFragment, pos2);
    expect(resolved2).toBeDefined();
    expect(resolved2.blockIndex).toBe(0);
    expect(resolved2.offset).toBe(5);
  });

  test('multiple empty blocks are each boundary-anchored with no text nodes created', () => {
    // Create document with multiple empty blocks
    const empty1 = new Y.XmlElement('paragraph');
    const empty2 = new Y.XmlElement('heading');
    const empty3 = new Y.XmlElement('paragraph');

    xmlFragment.insert(0, [empty1, empty2, empty3]);

    const before = Y.encodeStateAsUpdate(ydoc).length;
    // Create cursor positions in each empty block
    const pos1 = createCursorPosition(xmlFragment, 0, 0);
    const pos2 = createCursorPosition(xmlFragment, 1, 0);
    const pos3 = createCursorPosition(xmlFragment, 2, 0);
    const after = Y.encodeStateAsUpdate(ydoc).length;

    expect(pos1).toBeDefined();
    expect(pos2).toBeDefined();
    expect(pos3).toBeDefined();
    expect(after - before).toBe(0);

    // Verify NO block gained a text node.
    const blocks = xmlFragment.toArray();
    for (let i = 0; i < blocks.length; i++) {
      expect(blocks[i].toArray().length).toBe(0);
    }
  });

  test('empty block at document end resolves at its boundary with no text node', () => {
    // Create document with text and then empty block
    const paragraph1 = new Y.XmlElement('paragraph');
    const text1 = new Y.XmlText();
    text1.insert(0, 'Some content here');
    paragraph1.insert(0, [text1]);

    const emptyParagraph = new Y.XmlElement('paragraph');

    xmlFragment.insert(0, [paragraph1, emptyParagraph]);

    const before = Y.encodeStateAsUpdate(ydoc).length;
    const cursorPos = createCursorPosition(xmlFragment, 1, 0);
    const after = Y.encodeStateAsUpdate(ydoc).length;

    expect(cursorPos).toBeDefined();
    expect(after - before).toBe(0);
    expect(xmlFragment.toArray()[1].toArray().length).toBe(0);

    // Verify resolution works
    const resolved = resolveCursorPosition(xmlFragment, cursorPos);
    expect(resolved).toBeDefined();
    expect(resolved.blockIndex).toBe(1);
    expect(resolved.offset).toBe(0);
  });

  test('positioning a cursor in a freshly-inserted empty block creates no text node', () => {
    // Simulate what insert_block does:
    // 1. Create existing content
    const paragraph1 = new Y.XmlElement('paragraph');
    const text1 = new Y.XmlText();
    text1.insert(0, 'Existing text');
    paragraph1.insert(0, [text1]);
    xmlFragment.insert(0, [paragraph1]);

    // 2. Insert new empty paragraph after
    const newParagraph = new Y.XmlElement('paragraph');
    xmlFragment.insert(1, [newParagraph]);

    const before = Y.encodeStateAsUpdate(ydoc).length;
    // 3. Position cursor at start of new empty block (this used to throw, then
    //    used to insert a placeholder; now it is a pure boundary anchor).
    const cursorPos = createCursorPosition(xmlFragment, 1, 0);
    const after = Y.encodeStateAsUpdate(ydoc).length;

    expect(cursorPos).toBeDefined();
    expect(after - before).toBe(0);

    // 4. Verify it can be resolved
    const resolved = resolveCursorPosition(xmlFragment, cursorPos);
    expect(resolved).toBeDefined();
    expect(resolved.blockIndex).toBe(1);
    expect(resolved.offset).toBe(0);
    expect(resolved.blockType).toBe('paragraph');

    // 5. Verify NO placeholder text node was created.
    const newBlock = xmlFragment.toArray()[1];
    expect(newBlock.toArray().length).toBe(0);
  });
});
