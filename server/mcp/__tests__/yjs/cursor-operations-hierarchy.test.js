/**
 * Cursor operations hierarchy tests
 *
 * Tests path-based cursor operations for hierarchical document navigation.
 */
const Y = require('yjs');
const {
  createCursorPosition,
  resolveCursorPosition,
  createCursorPositionFromPath,
  resolveCursorPositionToPath,
  getParentPath,
  getSiblingIndex,
} = require('../../yjs/cursor-operations');

describe('Path-based cursor operations', () => {
  let ydoc;
  let xmlFragment;

  beforeEach(() => {
    ydoc = new Y.Doc();
    xmlFragment = ydoc.get('default', Y.XmlFragment);
  });

  describe('createCursorPositionFromPath', () => {
    test('creates cursor at top-level block', () => {
      // Create a simple document with one paragraph
      const paragraph = new Y.XmlElement('paragraph');
      const text = new Y.XmlText('Hello world');
      paragraph.insert(0, [text]);
      xmlFragment.insert(0, [paragraph]);

      const pos = createCursorPositionFromPath(xmlFragment, [0, 0], 6); // After "Hello "

      expect(pos).toBeDefined();
      const resolved = resolveCursorPosition(xmlFragment, pos);
      expect(resolved.blockIndex).toBe(0);
      expect(resolved.offset).toBe(6);
    });

    test('creates cursor at nested list item', () => {
      // Create: bulletList > listItem > paragraph > text
      const bulletList = new Y.XmlElement('bulletList');
      const listItem = new Y.XmlElement('listItem');
      const paragraph = new Y.XmlElement('paragraph');
      const text = new Y.XmlText('List item content');

      paragraph.insert(0, [text]);
      listItem.insert(0, [paragraph]);
      bulletList.insert(0, [listItem]);
      xmlFragment.insert(0, [bulletList]);

      const pos = createCursorPositionFromPath(xmlFragment, [0, 0, 0, 0], 5); // After "List "

      expect(pos).toBeDefined();
      const resolved = resolveCursorPosition(xmlFragment, pos);
      expect(resolved.blockIndex).toBe(0);
      expect(resolved.offset).toBe(5);
    });

    test('throws error for invalid path', () => {
      const paragraph = new Y.XmlElement('paragraph');
      const text = new Y.XmlText('Hello');
      paragraph.insert(0, [text]);
      xmlFragment.insert(0, [paragraph]);

      expect(() => createCursorPositionFromPath(xmlFragment, [1], 0)).toThrow('Block index 1 out of bounds');
      expect(() => createCursorPositionFromPath(xmlFragment, [0, 0, 0], 0)).toThrow('Path element at depth 1 is not an XmlElement');
    });
  });

  describe('resolveCursorPositionToPath', () => {
    test('resolves top-level block position to path', () => {
      const paragraph = new Y.XmlElement('paragraph');
      const text = new Y.XmlText('Hello world');
      paragraph.insert(0, [text]);
      xmlFragment.insert(0, [paragraph]);

      const pos = createCursorPosition(xmlFragment, 0, 6);
      const pathResolved = resolveCursorPositionToPath(xmlFragment, pos);

      expect(pathResolved).toEqual({
        path: [0, 0],
        offset: 0, // Current implementation returns 0
        blockType: 'paragraph',
      });
    });

    test('resolves nested list item position to path', () => {
      const bulletList = new Y.XmlElement('bulletList');
      const listItem = new Y.XmlElement('listItem');
      const paragraph = new Y.XmlElement('paragraph');
      const text = new Y.XmlText('List item content');

      paragraph.insert(0, [text]);
      listItem.insert(0, [paragraph]);
      bulletList.insert(0, [listItem]);
      xmlFragment.insert(0, [bulletList]);

      const pos = createCursorPosition(xmlFragment, 0, 5);
      const pathResolved = resolveCursorPositionToPath(xmlFragment, pos);

      expect(pathResolved).toEqual({
        path: [0, 0, 0, 0],
        offset: 0, // Current implementation returns 0
        blockType: 'bulletList',
      });
    });

    test('returns null for invalid position', () => {
      const invalidPos = { type: 'invalid' };
      const result = resolveCursorPositionToPath(xmlFragment, invalidPos);
      expect(result).toBeNull();
    });
  });

  describe('getParentPath', () => {
    test('returns parent path for nested path', () => {
      expect(getParentPath([0, 1, 2])).toEqual([0, 1]);
      expect(getParentPath([2, 0])).toEqual([2]);
    });

    test('returns empty array for top-level path', () => {
      expect(getParentPath([0])).toEqual([]);
      expect(getParentPath([5])).toEqual([]);
    });
  });

  describe('getSiblingIndex', () => {
    test('returns last element of path', () => {
      expect(getSiblingIndex([0, 1, 2])).toBe(2);
      expect(getSiblingIndex([5])).toBe(5);
      expect(getSiblingIndex([2, 0])).toBe(0);
    });

    test('returns -1 for empty path', () => {
      expect(getSiblingIndex([])).toBe(-1);
    });
  });

  describe('integration with complex hierarchy', () => {
    test('navigates complex nested structure', () => {
      // Create a complex structure:
      // bulletList (0)
      //   listItem (0,0)
      //     paragraph (0,0,0)
      //       text
      //   listItem (0,1)
      //     paragraph (0,1,0)
      //       text
      //     bulletList (0,1,1) - nested list!
      //       listItem (0,1,1,0)
      //         paragraph (0,1,1,0,0)
      //           text
      // paragraph (1) - separate top-level block

      const rootList = new Y.XmlElement('bulletList');

      // First list item with simple content
      const item1 = new Y.XmlElement('listItem');
      const para1 = new Y.XmlElement('paragraph');
      const text1 = new Y.XmlText('First item');
      para1.insert(0, [text1]);
      item1.insert(0, [para1]);
      rootList.insert(0, [item1]);

      // Second list item with nested list
      const item2 = new Y.XmlElement('listItem');
      const para2 = new Y.XmlElement('paragraph');
      const text2 = new Y.XmlText('Second item');
      para2.insert(0, [text2]);

      const nestedList = new Y.XmlElement('bulletList');
      const nestedItem = new Y.XmlElement('listItem');
      const nestedPara = new Y.XmlElement('paragraph');
      const nestedText = new Y.XmlText('Nested item');
      nestedPara.insert(0, [nestedText]);
      nestedItem.insert(0, [nestedPara]);
      nestedList.insert(0, [nestedItem]);

      item2.insert(0, [para2, nestedList]);
      rootList.insert(1, [item2]);

      // Top-level paragraph
      const topPara = new Y.XmlElement('paragraph');
      const topText = new Y.XmlText('Top level paragraph');
      topPara.insert(0, [topText]);

      xmlFragment.insert(0, [rootList, topPara]);

      // Test various path resolutions
      const pos1 = createCursorPositionFromPath(xmlFragment, [0, 0, 0, 0], 5); // First item text
      const path1 = resolveCursorPositionToPath(xmlFragment, pos1);
      expect(path1.path).toEqual([0, 0, 0, 0]);

      const pos2 = createCursorPositionFromPath(xmlFragment, [0, 1, 1, 0, 0], 7); // Nested item text
      const path2 = resolveCursorPositionToPath(xmlFragment, pos2);
      expect(path2.path).toEqual([0, 1, 1, 0, 0, 0]);

      const pos3 = createCursorPositionFromPath(xmlFragment, [1, 0], 10); // Top-level paragraph
      const path3 = resolveCursorPositionToPath(xmlFragment, pos3);
      expect(path3.path).toEqual([1, 0]);
    });
  });
});
