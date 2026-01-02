/**
 * Text Operations Tests
 *
 * Tests for text-operations.js utilities, particularly applyMarks
 * functionality with nested elements (lists).
 */
const Y = require('yjs');
const {
  applyMarks,
  applyMarksToDocument,
  extractText,
  getElementTextLength,
} = require('../../yjs/text-operations');

describe('applyMarks', () => {
  describe('simple single text node', () => {
    let ydoc, xmlFragment, element;

    beforeEach(() => {
      ydoc = new Y.Doc();
      xmlFragment = ydoc.get('default', Y.XmlFragment);
      element = new Y.XmlElement('paragraph');
      element.insert(0, [new Y.XmlText('Hello world')]);
      xmlFragment.insert(0, [element]);
    });

    test('applies bold mark to text range', () => {
      ydoc.transact(() => {
        applyMarks(element, 0, 5, ['bold']);
      });

      const textNode = element.get(0);
      const formatted = textNode.toDelta();

      expect(formatted).toEqual([
        { insert: 'Hello', attributes: { bold: true } },
        { insert: ' world' },
      ]);
    });

    test('applies multiple marks to text range', () => {
      ydoc.transact(() => {
        applyMarks(element, 0, 5, ['bold', 'italic']);
      });

      const textNode = element.get(0);
      const formatted = textNode.toDelta();

      expect(formatted).toEqual([
        { insert: 'Hello', attributes: { bold: true, italic: true } },
        { insert: ' world' },
      ]);
    });

    test('applies strikethrough mark', () => {
      ydoc.transact(() => {
        applyMarks(element, 6, 11, ['strike']);
      });

      const textNode = element.get(0);
      const formatted = textNode.toDelta();

      expect(formatted).toEqual([
        { insert: 'Hello ' },
        { insert: 'world', attributes: { strike: true } },
      ]);
    });

    test('removes marks from text range', () => {
      ydoc.transact(() => {
        // First apply bold
        applyMarks(element, 0, 11, ['bold']);
        // Then remove bold from part of it
        applyMarks(element, 6, 11, [], ['bold']);
      });

      const textNode = element.get(0);
      const formatted = textNode.toDelta();

      expect(formatted).toEqual([
        { insert: 'Hello ', attributes: { bold: true } },
        { insert: 'world' },
      ]);
    });

    test('adds link to text range', () => {
      ydoc.transact(() => {
        applyMarks(element, 0, 5, [], [], { href: 'https://example.com' });
      });

      const textNode = element.get(0);
      const formatted = textNode.toDelta();

      expect(formatted).toEqual([
        { insert: 'Hello', attributes: { link: { href: 'https://example.com' } } },
        { insert: ' world' },
      ]);
    });
  });

  describe('nested list items - bug fix regression test', () => {
    let ydoc, xmlFragment, orderedList;

    beforeEach(() => {
      ydoc = new Y.Doc();
      xmlFragment = ydoc.get('default', Y.XmlFragment);

      // Create structure matching the bug report:
      // orderedList
      //   └─ listItem
      //        └─ paragraph
      //             └─ "Fix nut on car door "
      orderedList = new Y.XmlElement('orderedList');
      orderedList.setAttribute('start', 1);

      const listItem = new Y.XmlElement('listItem');
      const paragraph = new Y.XmlElement('paragraph');
      paragraph.insert(0, [new Y.XmlText('Fix nut on car door ')]);

      listItem.insert(0, [paragraph]);
      orderedList.insert(0, [listItem]);
      xmlFragment.insert(0, [orderedList]);
    });

    test('applies strikethrough to text in nested list item', () => {
      ydoc.transact(() => {
        applyMarks(orderedList, 0, 19, ['strike']);
      });

      // Navigate to the text node
      const listItem = orderedList.get(0);
      const paragraph = listItem.get(0);
      const textNode = paragraph.get(0);
      const formatted = textNode.toDelta();

      expect(formatted).toEqual([
        { insert: 'Fix nut on car door', attributes: { strike: true } },
        { insert: ' ' },
      ]);
    });

    test('applies bold to text in nested list item', () => {
      ydoc.transact(() => {
        applyMarks(orderedList, 0, 7, ['bold']);
      });

      const listItem = orderedList.get(0);
      const paragraph = listItem.get(0);
      const textNode = paragraph.get(0);
      const formatted = textNode.toDelta();

      expect(formatted).toEqual([
        { insert: 'Fix nut', attributes: { bold: true } },
        { insert: ' on car door ' },
      ]);
    });

    test('applies multiple marks to text in nested list item', () => {
      ydoc.transact(() => {
        applyMarks(orderedList, 0, 19, ['bold', 'italic', 'strike']);
      });

      const listItem = orderedList.get(0);
      const paragraph = listItem.get(0);
      const textNode = paragraph.get(0);
      const formatted = textNode.toDelta();

      expect(formatted).toEqual([
        { insert: 'Fix nut on car door', attributes: { bold: true, italic: true, strike: true } },
        { insert: ' ' },
      ]);
    });

    test('extracts correct text from nested list item', () => {
      const text = extractText(orderedList, 0, 19);
      expect(text).toBe('Fix nut on car door');
    });

    test('returns correct affected text', () => {
      let result;
      ydoc.transact(() => {
        result = applyMarks(orderedList, 0, 19, ['strike']);
      });

      expect(result.affectedText).toBe('Fix nut on car door');
    });
  });

  describe('multiple nested list items', () => {
    let ydoc, xmlFragment, bulletList;

    beforeEach(() => {
      ydoc = new Y.Doc();
      xmlFragment = ydoc.get('default', Y.XmlFragment);

      // bulletList
      //   ├─ listItem 1: "First item"
      //   ├─ listItem 2: "Second item"
      //   └─ listItem 3: "Third item"
      bulletList = new Y.XmlElement('bulletList');

      for (const text of ['First item', 'Second item', 'Third item']) {
        const listItem = new Y.XmlElement('listItem');
        const paragraph = new Y.XmlElement('paragraph');
        paragraph.insert(0, [new Y.XmlText(text)]);
        listItem.insert(0, [paragraph]);
        bulletList.insert(bulletList.length, [listItem]);
      }

      xmlFragment.insert(0, [bulletList]);
    });

    test('applies marks across multiple list items', () => {
      // "First item" = 10 chars, "Second item" = 11 chars
      // Apply bold from char 5 (in first item) to char 15 (in second item)
      ydoc.transact(() => {
        applyMarks(bulletList, 5, 21, ['bold']);
      });

      // Check first item: chars 5-10 should be bold
      const listItem1 = bulletList.get(0);
      const paragraph1 = listItem1.get(0);
      const textNode1 = paragraph1.get(0);
      const formatted1 = textNode1.toDelta();

      expect(formatted1).toEqual([
        { insert: 'First' },
        { insert: ' item', attributes: { bold: true } },
      ]);

      // Check second item: all chars should be bold
      const listItem2 = bulletList.get(1);
      const paragraph2 = listItem2.get(0);
      const textNode2 = paragraph2.get(0);
      const formatted2 = textNode2.toDelta();

      expect(formatted2).toEqual([{ insert: 'Second item', attributes: { bold: true } }]);
    });

    test('applies marks to middle list item only', () => {
      // Apply strikethrough to second item only (chars 10-21)
      ydoc.transact(() => {
        applyMarks(bulletList, 10, 21, ['strike']);
      });

      // First item should be unchanged
      const listItem1 = bulletList.get(0);
      const paragraph1 = listItem1.get(0);
      const textNode1 = paragraph1.get(0);
      const formatted1 = textNode1.toDelta();

      expect(formatted1).toEqual([{ insert: 'First item' }]);

      // Second item should have strikethrough
      const listItem2 = bulletList.get(1);
      const paragraph2 = listItem2.get(0);
      const textNode2 = paragraph2.get(0);
      const formatted2 = textNode2.toDelta();

      expect(formatted2).toEqual([{ insert: 'Second item', attributes: { strike: true } }]);

      // Third item should be unchanged
      const listItem3 = bulletList.get(2);
      const paragraph3 = listItem3.get(0);
      const textNode3 = paragraph3.get(0);
      const formatted3 = textNode3.toDelta();

      expect(formatted3).toEqual([{ insert: 'Third item' }]);
    });

    test('gets correct total text length', () => {
      const length = getElementTextLength(bulletList);
      // "First item" (10) + "Second item" (11) + "Third item" (10) = 31
      expect(length).toBe(31);
    });

    test('extracts text across multiple list items', () => {
      const text = extractText(bulletList, 5, 21);
      // From "First |item" to "Second item|"
      expect(text).toBe(' itemSecond item');
    });
  });

  describe('deeply nested structures', () => {
    let ydoc, xmlFragment, orderedList;

    beforeEach(() => {
      ydoc = new Y.Doc();
      xmlFragment = ydoc.get('default', Y.XmlFragment);

      // orderedList
      //   └─ listItem
      //        └─ bulletList (nested list)
      //             └─ listItem
      //                  └─ paragraph
      //                       └─ "Nested text"
      orderedList = new Y.XmlElement('orderedList');
      const outerListItem = new Y.XmlElement('listItem');
      const nestedBulletList = new Y.XmlElement('bulletList');
      const innerListItem = new Y.XmlElement('listItem');
      const paragraph = new Y.XmlElement('paragraph');
      paragraph.insert(0, [new Y.XmlText('Nested text')]);

      innerListItem.insert(0, [paragraph]);
      nestedBulletList.insert(0, [innerListItem]);
      outerListItem.insert(0, [nestedBulletList]);
      orderedList.insert(0, [outerListItem]);
      xmlFragment.insert(0, [orderedList]);
    });

    test('applies marks to deeply nested text', () => {
      ydoc.transact(() => {
        applyMarks(orderedList, 0, 6, ['bold']);
      });

      // Navigate deep into the structure
      const outerListItem = orderedList.get(0);
      const nestedBulletList = outerListItem.get(0);
      const innerListItem = nestedBulletList.get(0);
      const paragraph = innerListItem.get(0);
      const textNode = paragraph.get(0);
      const formatted = textNode.toDelta();

      expect(formatted).toEqual([
        { insert: 'Nested', attributes: { bold: true } },
        { insert: ' text' },
      ]);
    });

    test('extracts text from deeply nested structure', () => {
      const text = extractText(orderedList, 0, 11);
      expect(text).toBe('Nested text');
    });
  });

  describe('edge cases', () => {
    let ydoc, xmlFragment, element;

    beforeEach(() => {
      ydoc = new Y.Doc();
      xmlFragment = ydoc.get('default', Y.XmlFragment);
      element = new Y.XmlElement('paragraph');
      element.insert(0, [new Y.XmlText('Test text')]);
      xmlFragment.insert(0, [element]);
    });

    test('handles zero-length range (no-op)', () => {
      ydoc.transact(() => {
        applyMarks(element, 5, 5, ['bold']);
      });

      const textNode = element.get(0);
      const formatted = textNode.toDelta();

      // Should be unchanged
      expect(formatted).toEqual([{ insert: 'Test text' }]);
    });

    test('handles range at end of text', () => {
      ydoc.transact(() => {
        applyMarks(element, 5, 9, ['bold']);
      });

      const textNode = element.get(0);
      const formatted = textNode.toDelta();

      expect(formatted).toEqual([
        { insert: 'Test ' },
        { insert: 'text', attributes: { bold: true } },
      ]);
    });

    test('handles full text range', () => {
      ydoc.transact(() => {
        applyMarks(element, 0, 9, ['bold']);
      });

      const textNode = element.get(0);
      const formatted = textNode.toDelta();

      expect(formatted).toEqual([{ insert: 'Test text', attributes: { bold: true } }]);
    });
  });

  describe('applyMarksToDocument', () => {
    describe('single block document', () => {
      let ydoc, xmlFragment;

      beforeEach(() => {
        ydoc = new Y.Doc();
        xmlFragment = ydoc.get('default', Y.XmlFragment);

        const paragraph = new Y.XmlElement('paragraph');
        paragraph.insert(0, [new Y.XmlText('Hello world')]);
        xmlFragment.insert(0, [paragraph]);
      });

      test('applies bold to single block', () => {
        ydoc.transact(() => {
          applyMarksToDocument(xmlFragment, 0, 5, ['bold']);
        });

        const paragraph = xmlFragment.get(0);
        const textNode = paragraph.get(0);
        const formatted = textNode.toDelta();

        expect(formatted).toEqual([
          { insert: 'Hello', attributes: { bold: true } },
          { insert: ' world' },
        ]);
      });
    });

    describe('multi-block document', () => {
      let ydoc, xmlFragment;

      beforeEach(() => {
        ydoc = new Y.Doc();
        xmlFragment = ydoc.get('default', Y.XmlFragment);

        // Block 1: "First paragraph" (15 chars)
        const para1 = new Y.XmlElement('paragraph');
        para1.insert(0, [new Y.XmlText('First paragraph')]);
        xmlFragment.insert(0, [para1]);

        // Block 2: "Second paragraph" (16 chars)
        const para2 = new Y.XmlElement('paragraph');
        para2.insert(0, [new Y.XmlText('Second paragraph')]);
        xmlFragment.insert(1, [para2]);

        // Block 3: "Third paragraph" (15 chars)
        const para3 = new Y.XmlElement('paragraph');
        para3.insert(0, [new Y.XmlText('Third paragraph')]);
        xmlFragment.insert(2, [para3]);
      });

      test('applies marks spanning multiple blocks', () => {
        // Apply bold from position 10 (in first block) to position 25 (in second block)
        // "First paragraph" positions: 0-14
        // "Second paragraph" positions: 15-30
        ydoc.transact(() => {
          applyMarksToDocument(xmlFragment, 10, 25, ['bold']);
        });

        // Check first block: positions 10-14 should be bold
        const para1 = xmlFragment.get(0);
        const textNode1 = para1.get(0);
        const formatted1 = textNode1.toDelta();

        expect(formatted1).toEqual([
          { insert: 'First para' },
          { insert: 'graph', attributes: { bold: true } },
        ]);

        // Check second block: positions 0-9 should be bold (relative to block)
        const para2 = xmlFragment.get(1);
        const textNode2 = para2.get(0);
        const formatted2 = textNode2.toDelta();

        expect(formatted2).toEqual([
          { insert: 'Second par', attributes: { bold: true } },
          { insert: 'agraph' },
        ]);

        // Third block should be unchanged
        const para3 = xmlFragment.get(2);
        const textNode3 = para3.get(0);
        const formatted3 = textNode3.toDelta();

        expect(formatted3).toEqual([{ insert: 'Third paragraph' }]);
      });

      test('applies marks to single block within multi-block document', () => {
        // Apply bold to entire second block (positions 15-30)
        ydoc.transact(() => {
          applyMarksToDocument(xmlFragment, 15, 31, ['bold']);
        });

        // First block should be unchanged
        const para1 = xmlFragment.get(0);
        const textNode1 = para1.get(0);
        expect(textNode1.toDelta()).toEqual([{ insert: 'First paragraph' }]);

        // Second block should be fully bold
        const para2 = xmlFragment.get(1);
        const textNode2 = para2.get(0);
        expect(textNode2.toDelta()).toEqual([{ insert: 'Second paragraph', attributes: { bold: true } }]);

        // Third block should be unchanged
        const para3 = xmlFragment.get(2);
        const textNode3 = para3.get(0);
        expect(textNode3.toDelta()).toEqual([{ insert: 'Third paragraph' }]);
      });
    });

    describe('list structures', () => {
      let ydoc, xmlFragment, bulletList;

      beforeEach(() => {
        ydoc = new Y.Doc();
        xmlFragment = ydoc.get('default', Y.XmlFragment);

        // Create a bullet list with multiple items
        bulletList = new Y.XmlElement('bulletList');

        const items = ['First item', 'Second item', 'Third item'];
        for (const text of items) {
          const listItem = new Y.XmlElement('listItem');
          const paragraph = new Y.XmlElement('paragraph');
          paragraph.insert(0, [new Y.XmlText(text)]);
          listItem.insert(0, [paragraph]);
          bulletList.insert(bulletList.length, [listItem]);
        }

        xmlFragment.insert(0, [bulletList]);
      });

      test('applies marks across list items', () => {
        // "First item" = 10 chars, "Second item" = 11 chars
        // Apply bold from char 5 (in first item) to char 15 (in second item)
        ydoc.transact(() => {
          applyMarksToDocument(xmlFragment, 5, 21, ['bold']);
        });

        // Check first item: chars 5-10 should be bold
        const listItem1 = bulletList.get(0);
        const paragraph1 = listItem1.get(0);
        const textNode1 = paragraph1.get(0);
        const formatted1 = textNode1.toDelta();

        expect(formatted1).toEqual([
          { insert: 'First' },
          { insert: ' item', attributes: { bold: true } },
        ]);

        // Check second item: all chars should be bold
        const listItem2 = bulletList.get(1);
        const paragraph2 = listItem2.get(0);
        const textNode2 = paragraph2.get(0);
        const formatted2 = textNode2.toDelta();

        expect(formatted2).toEqual([{ insert: 'Second item', attributes: { bold: true } }]);
      });
    });
  });
});
