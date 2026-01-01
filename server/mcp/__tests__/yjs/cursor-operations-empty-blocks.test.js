/**
 * Tests for cursor operations with empty blocks
 *
 * This test suite specifically validates the fix for handling blocks
 * that contain no text nodes, which was causing "Block X contains no text nodes" errors.
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

  test('createCursorPosition should handle empty block by creating text node', () => {
    // Create a paragraph block with NO text nodes (empty block)
    const emptyParagraph = new Y.XmlElement('paragraph');
    xmlFragment.insert(0, [emptyParagraph]);

    // Before the fix, this would throw: "Block 0 contains no text nodes"
    // After the fix, it should create a text node and return a position
    const cursorPos = createCursorPosition(xmlFragment, 0, 0);

    expect(cursorPos).toBeDefined();
    expect(cursorPos).toHaveProperty('type');
    expect(cursorPos.type).toHaveProperty('client');
    expect(cursorPos.type).toHaveProperty('clock');

    // Verify that a text node was created in the block
    const blocks = xmlFragment.toArray();
    const block = blocks[0];
    const children = block.toArray();

    expect(children.length).toBe(1);
    expect(children[0]).toBeInstanceOf(Y.XmlText);
  });

  test('createCursorPosition should handle empty block at end position', () => {
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

    // Try to position cursor at the end of the empty block (block index 1)
    const cursorPos = createCursorPosition(xmlFragment, 1, 999); // offset beyond block length

    expect(cursorPos).toBeDefined();

    // Verify the empty block now has a text node
    const blocks = xmlFragment.toArray();
    const block = blocks[1];
    const children = block.toArray();

    expect(children.length).toBe(1);
    expect(children[0]).toBeInstanceOf(Y.XmlText);
    expect(children[0].length).toBe(0); // Empty text node
  });

  test('cursor should work normally after empty block gets text node', () => {
    // Create empty block
    const emptyParagraph = new Y.XmlElement('paragraph');
    xmlFragment.insert(0, [emptyParagraph]);

    // Create cursor position (this creates the text node)
    const pos1 = createCursorPosition(xmlFragment, 0, 0);
    expect(pos1).toBeDefined();

    // Resolve the position
    const resolved1 = resolveCursorPosition(xmlFragment, pos1);
    expect(resolved1).toBeDefined();
    expect(resolved1.blockIndex).toBe(0);
    expect(resolved1.offset).toBe(0);

    // Now insert some text into the block
    const blocks = xmlFragment.toArray();
    const textNode = blocks[0].toArray()[0];
    textNode.insert(0, 'Hello world');

    // Create a new cursor position in the middle of the text
    const pos2 = createCursorPosition(xmlFragment, 0, 5);
    expect(pos2).toBeDefined();

    const resolved2 = resolveCursorPosition(xmlFragment, pos2);
    expect(resolved2).toBeDefined();
    expect(resolved2.blockIndex).toBe(0);
    expect(resolved2.offset).toBe(5);
  });

  test('multiple empty blocks should all get text nodes', () => {
    // Create document with multiple empty blocks
    const empty1 = new Y.XmlElement('paragraph');
    const empty2 = new Y.XmlElement('heading');
    const empty3 = new Y.XmlElement('paragraph');

    xmlFragment.insert(0, [empty1, empty2, empty3]);

    // Create cursor positions in each empty block
    const pos1 = createCursorPosition(xmlFragment, 0, 0);
    const pos2 = createCursorPosition(xmlFragment, 1, 0);
    const pos3 = createCursorPosition(xmlFragment, 2, 0);

    expect(pos1).toBeDefined();
    expect(pos2).toBeDefined();
    expect(pos3).toBeDefined();

    // Verify all blocks now have text nodes
    const blocks = xmlFragment.toArray();
    for (let i = 0; i < blocks.length; i++) {
      const children = blocks[i].toArray();
      expect(children.length).toBe(1);
      expect(children[0]).toBeInstanceOf(Y.XmlText);
    }
  });

  test('empty block at document end should be handled correctly', () => {
    // Create document with text and then empty block
    const paragraph1 = new Y.XmlElement('paragraph');
    const text1 = new Y.XmlText();
    text1.insert(0, 'Some content here');
    paragraph1.insert(0, [text1]);

    const emptyParagraph = new Y.XmlElement('paragraph');

    xmlFragment.insert(0, [paragraph1, emptyParagraph]);

    // Try to position cursor at end of empty block
    const cursorPos = createCursorPosition(xmlFragment, 1, 0);

    expect(cursorPos).toBeDefined();

    // Verify resolution works
    const resolved = resolveCursorPosition(xmlFragment, cursorPos);
    expect(resolved).toBeDefined();
    expect(resolved.blockIndex).toBe(1);
    expect(resolved.offset).toBe(0);
  });

  test('real-world scenario: insert_block creating empty block then positioning cursor', () => {
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

    // 3. Try to position cursor at start of new empty block
    // This was failing with "Block 1 contains no text nodes"
    const cursorPos = createCursorPosition(xmlFragment, 1, 0);

    expect(cursorPos).toBeDefined();

    // 4. Verify it can be resolved
    const resolved = resolveCursorPosition(xmlFragment, cursorPos);
    expect(resolved).toBeDefined();
    expect(resolved.blockIndex).toBe(1);
    expect(resolved.offset).toBe(0);
    expect(resolved.blockType).toBe('paragraph');

    // 5. Verify the block now has a text node for future operations
    const blocks = xmlFragment.toArray();
    const newBlock = blocks[1];
    const children = newBlock.toArray();
    expect(children.length).toBe(1);
    expect(children[0]).toBeInstanceOf(Y.XmlText);
  });
});
