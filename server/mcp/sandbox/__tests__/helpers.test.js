/**
 * Tests for sandbox helper functions
 */

const Y = require('yjs');
const helpers = require('../helpers');

describe('Sandbox Helpers', () => {
  let ydoc;
  let fragment;

  beforeEach(() => {
    ydoc = new Y.Doc();
    fragment = ydoc.get('default', Y.XmlFragment);
  });

  describe('findTextNode', () => {
    it('should find direct text child', () => {
      const para = new Y.XmlElement('paragraph');
      const text = new Y.XmlText();
      text.insert(0, 'Hello');
      para.insert(0, [text]);
      fragment.insert(0, [para]);

      const found = helpers.findTextNode(para);
      expect(found).toBe(text);
    });

    it('should find nested text node', () => {
      const list = new Y.XmlElement('bulletList');
      const item = new Y.XmlElement('listItem');
      const para = new Y.XmlElement('paragraph');
      const text = new Y.XmlText();
      text.insert(0, 'Item');
      para.insert(0, [text]);
      item.insert(0, [para]);
      list.insert(0, [item]);
      fragment.insert(0, [list]);

      const found = helpers.findTextNode(list);
      expect(found).toBe(text);
    });

    it('should return null for element without text', () => {
      const empty = new Y.XmlElement('paragraph');
      fragment.insert(0, [empty]);

      const found = helpers.findTextNode(empty);
      expect(found).toBeNull();
    });

    it('should return null for non-element input', () => {
      expect(helpers.findTextNode(null)).toBeNull();
      expect(helpers.findTextNode('string')).toBeNull();
    });
  });

  describe('extractText', () => {
    it('should extract plain text', () => {
      const para = new Y.XmlElement('paragraph');
      const text = new Y.XmlText();
      text.insert(0, 'Hello world');
      para.insert(0, [text]);
      fragment.insert(0, [para]);

      const result = helpers.extractText(text);
      expect(result).toBe('Hello world');
    });

    it('should extract text with formatting using toDelta', () => {
      const para = new Y.XmlElement('paragraph');
      const text = new Y.XmlText();
      text.insert(0, 'Hello');
      text.insert(5, ' world');
      text.format(0, 5, { bold: true });
      para.insert(0, [text]);
      fragment.insert(0, [para]);

      const result = helpers.extractText(text);
      // Should get plain text, not XML markup
      expect(result).toBe('Hello world');
      expect(result).not.toContain('<bold>');
    });

    it('should throw for non-XmlText input', () => {
      expect(() => helpers.extractText(null)).toThrow('expects a Y.XmlText instance');

      const para = new Y.XmlElement('paragraph');
      fragment.insert(0, [para]);
      expect(() => helpers.extractText(para)).toThrow();
    });
  });

  describe('getTextContent', () => {
    it('should get text from XmlText node', () => {
      const para = new Y.XmlElement('paragraph');
      const text = new Y.XmlText();
      text.insert(0, 'Hello');
      para.insert(0, [text]);
      fragment.insert(0, [para]);

      expect(helpers.getTextContent(text)).toBe('Hello');
    });

    it('should get text from simple element', () => {
      const para = new Y.XmlElement('paragraph');
      const text = new Y.XmlText();
      text.insert(0, 'Hello');
      para.insert(0, [text]);
      fragment.insert(0, [para]);

      expect(helpers.getTextContent(para)).toBe('Hello');
    });

    it('should get all text from nested structure', () => {
      const list = new Y.XmlElement('bulletList');

      // First item
      const item1 = new Y.XmlElement('listItem');
      const p1 = new Y.XmlElement('paragraph');
      const t1 = new Y.XmlText();
      t1.insert(0, 'Item 1');
      p1.insert(0, [t1]);
      item1.insert(0, [p1]);

      // Second item
      const item2 = new Y.XmlElement('listItem');
      const p2 = new Y.XmlElement('paragraph');
      const t2 = new Y.XmlText();
      t2.insert(0, 'Item 2');
      p2.insert(0, [t2]);
      item2.insert(0, [p2]);

      list.insert(0, [item1, item2]);
      fragment.insert(0, [list]);

      // List items are block-level elements, so they're separated by newlines
      expect(helpers.getTextContent(list)).toBe('Item 1\nItem 2');
    });

    it('should return empty string for empty element', () => {
      const para = new Y.XmlElement('paragraph');
      fragment.insert(0, [para]);
      expect(helpers.getTextContent(para)).toBe('');
    });
  });

  describe('findElements', () => {
    beforeEach(() => {
      // Create a simple document structure
      const h1 = new Y.XmlElement('heading');
      h1.setAttribute('level', 1);
      const h1Text = new Y.XmlText();
      h1Text.insert(0, 'Title');
      h1.insert(0, [h1Text]);

      const para = new Y.XmlElement('paragraph');
      const paraText = new Y.XmlText();
      paraText.insert(0, 'Content');
      para.insert(0, [paraText]);

      const list = new Y.XmlElement('bulletList');
      const item = new Y.XmlElement('listItem');
      const itemPara = new Y.XmlElement('paragraph');
      const itemText = new Y.XmlText();
      itemText.insert(0, 'List item');
      itemPara.insert(0, [itemText]);
      item.insert(0, [itemPara]);
      list.insert(0, [item]);

      fragment.insert(0, [h1, para, list]);
    });

    it('should find elements by predicate', () => {
      const headings = helpers.findElements(fragment, el => el.nodeName === 'heading');
      expect(headings).toHaveLength(1);
      expect(headings[0].nodeName).toBe('heading');
    });

    it('should find nested elements', () => {
      const paragraphs = helpers.findElements(fragment, el => el.nodeName === 'paragraph');
      // Should find: top-level paragraph + nested paragraph in list item
      expect(paragraphs.length).toBeGreaterThanOrEqual(2);
    });

    it('should find by attribute', () => {
      const h1s = helpers.findElements(fragment, el =>
        el.nodeName === 'heading' && el.getAttribute('level') === 1
      );
      expect(h1s).toHaveLength(1);
    });

    it('should return empty array when no matches', () => {
      const notFound = helpers.findElements(fragment, el => el.nodeName === 'codeBlock');
      expect(notFound).toEqual([]);
    });
  });

  describe('findByNodeName', () => {
    beforeEach(() => {
      const h1 = new Y.XmlElement('heading');
      const h2 = new Y.XmlElement('heading');
      const para = new Y.XmlElement('paragraph');

      fragment.insert(0, [h1, h2, para]);
    });

    it('should find all elements with matching nodeName', () => {
      const headings = helpers.findByNodeName(fragment, 'heading');
      expect(headings).toHaveLength(2);
      expect(headings.every(el => el.nodeName === 'heading')).toBe(true);
    });

    it('should return empty array when no matches', () => {
      const codeBlocks = helpers.findByNodeName(fragment, 'codeBlock');
      expect(codeBlocks).toEqual([]);
    });
  });

  describe('findByText', () => {
    beforeEach(() => {
      const p1 = new Y.XmlElement('paragraph');
      const t1 = new Y.XmlText();
      t1.insert(0, 'TODO: Implement feature');
      p1.insert(0, [t1]);

      const p2 = new Y.XmlElement('paragraph');
      const t2 = new Y.XmlText();
      t2.insert(0, 'This is normal text');
      p2.insert(0, [t2]);

      const p3 = new Y.XmlElement('paragraph');
      const t3 = new Y.XmlText();
      t3.insert(0, 'Another todo item');
      p3.insert(0, [t3]);

      fragment.insert(0, [p1, p2, p3]);
    });

    it('should find elements containing text (case insensitive)', () => {
      const todos = helpers.findByText(fragment, 'TODO');
      // Should find both "TODO: Implement feature" and "Another todo item" (case insensitive)
      expect(todos).toHaveLength(2);
      expect(helpers.getTextContent(todos[0])).toMatch(/TODO/i);
    });

    it('should be case insensitive by default', () => {
      const todos = helpers.findByText(fragment, 'todo');
      expect(todos).toHaveLength(2); // Finds "TODO" and "todo"
    });

    it('should support case sensitive search', () => {
      const upperTodos = helpers.findByText(fragment, 'TODO', true);
      expect(upperTodos).toHaveLength(1);

      const lowerTodos = helpers.findByText(fragment, 'todo', true);
      expect(lowerTodos).toHaveLength(1);
    });

    it('should return empty array when no matches', () => {
      const notFound = helpers.findByText(fragment, 'NOTFOUND');
      expect(notFound).toEqual([]);
    });

    it('should work with nested structures', () => {
      const list = new Y.XmlElement('bulletList');
      const item = new Y.XmlElement('listItem');
      const para = new Y.XmlElement('paragraph');
      const text = new Y.XmlText();
      text.insert(0, 'TODO in list');
      para.insert(0, [text]);
      item.insert(0, [para]);
      list.insert(0, [item]);

      fragment.insert(fragment.length, [list]);

      const todos = helpers.findByText(fragment, 'TODO');
      expect(todos.length).toBeGreaterThanOrEqual(2); // Original + nested
    });
  });

  describe('createFormattedText', () => {
    it('should create plain text from string segments', () => {
      const text = helpers.createFormattedText(['Hello', ' ', 'world']);
      // Need to attach to doc before reading
      const para = new Y.XmlElement('paragraph');
      para.insert(0, [text]);
      fragment.insert(0, [para]);

      const delta = text.toDelta();
      expect(delta).toHaveLength(1);
      expect(delta[0].insert).toBe('Hello world');
      expect(delta[0].attributes).toBeUndefined();
    });

    it('should create text with single formatted segment', () => {
      const text = helpers.createFormattedText([
        'Visit ',
        { text: 'Example Site', attrs: { link: { href: 'https://example.com' } } },
        ' for more info'
      ]);

      const para = new Y.XmlElement('paragraph');
      para.insert(0, [text]);
      fragment.insert(0, [para]);

      const delta = text.toDelta();
      expect(delta).toHaveLength(3);
      expect(delta[0].insert).toBe('Visit ');
      expect(delta[0].attributes).toBeUndefined();
      expect(delta[1].insert).toBe('Example Site');
      expect(delta[1].attributes).toEqual({ link: { href: 'https://example.com' } });
      expect(delta[2].insert).toBe(' for more info');
      expect(delta[2].attributes).toBeUndefined();
    });

    it('should create text with multiple formatted segments', () => {
      const text = helpers.createFormattedText([
        { text: 'Important:', attrs: { bold: true } },
        ' This is ',
        { text: 'italic', attrs: { italic: true } },
        ' text'
      ]);

      const para = new Y.XmlElement('paragraph');
      para.insert(0, [text]);
      fragment.insert(0, [para]);

      const delta = text.toDelta();
      expect(delta).toHaveLength(4);
      expect(delta[0].insert).toBe('Important:');
      expect(delta[0].attributes).toEqual({ bold: true });
      expect(delta[1].insert).toBe(' This is ');
      expect(delta[2].insert).toBe('italic');
      expect(delta[2].attributes).toEqual({ italic: true });
      expect(delta[3].insert).toBe(' text');
    });

    it('should maintain correct text order (avoiding reversal bug)', () => {
      // This is the key test - verifies the bug is avoided
      const text = helpers.createFormattedText([
        'Plain intro ',
        { text: 'linked text', attrs: { link: { href: 'https://example.com' } } }
      ]);

      const para = new Y.XmlElement('paragraph');
      para.insert(0, [text]);
      fragment.insert(0, [para]);

      const fullText = helpers.extractText(text);
      expect(fullText).toBe('Plain intro linked text');
      // NOT 'linked textPlain intro ' which would happen with the bug
    });

    it('should handle segment with empty attrs as plain text', () => {
      const text = helpers.createFormattedText([
        { text: 'Plain', attrs: {} },
        ' text'
      ]);

      const para = new Y.XmlElement('paragraph');
      para.insert(0, [text]);
      fragment.insert(0, [para]);

      const delta = text.toDelta();
      // Empty attrs should not create formatting
      expect(delta).toHaveLength(1);
      expect(delta[0].insert).toBe('Plain text');
    });

    it('should throw for empty array', () => {
      expect(() => helpers.createFormattedText([])).toThrow('non-empty array');
    });

    it('should throw for non-array input', () => {
      expect(() => helpers.createFormattedText('string')).toThrow('non-empty array');
      expect(() => helpers.createFormattedText(null)).toThrow('non-empty array');
    });

    it('should throw for incorrect textStyle format (color directly)', () => {
      expect(() => helpers.createFormattedText([
        { text: 'Red text', attrs: { color: '#ff0000' } }
      ])).toThrow(/TextStyle marks must be wrapped in a 'textStyle' object/);
    });

    it('should accept textStyle with only color', () => {
      const text = helpers.createFormattedText([
        { text: 'Red text', attrs: { textStyle: { color: '#ff0000' } }}
      ]);

      const para = new Y.XmlElement('paragraph');
      para.insert(0, [text]);
      fragment.insert(0, [para]);

      const delta = text.toDelta();
      expect(delta[0].attributes).toEqual({
        textStyle: { color: '#ff0000' }
      });
    });

    it('should accept textStyle with multiple properties', () => {
      const text = helpers.createFormattedText([
        { text: 'Styled text', attrs: {
          textStyle: { color: '#ff0000', fontSize: '18px', fontFamily: 'Georgia' }
        }}
      ]);

      const para = new Y.XmlElement('paragraph');
      para.insert(0, [text]);
      fragment.insert(0, [para]);

      const delta = text.toDelta();
      expect(delta[0].attributes).toEqual({
        textStyle: { color: '#ff0000', fontSize: '18px', fontFamily: 'Georgia' }
      });
    });
  });

  describe('appendBlocks', () => {
    describe('basic block creation', () => {
      it('should create a simple paragraph', () => {
        helpers.appendBlocks(fragment, [
          { type: 'paragraph', content: 'Hello world' }
        ]);

        expect(fragment.length).toBe(1);
        const para = fragment.get(0);
        expect(para.nodeName).toBe('paragraph');
        expect(helpers.getTextContent(para)).toBe('Hello world');
      });

      it('should create a heading with level', () => {
        helpers.appendBlocks(fragment, [
          { type: 'heading', level: 2, content: 'Section Title' }
        ]);

        expect(fragment.length).toBe(1);
        const heading = fragment.get(0);
        expect(heading.nodeName).toBe('heading');
        expect(heading.getAttribute('level')).toBe(2);
        expect(helpers.getTextContent(heading)).toBe('Section Title');
      });

      it('should create a code block', () => {
        helpers.appendBlocks(fragment, [
          { type: 'codeBlock', content: 'const x = 42;' }
        ]);

        expect(fragment.length).toBe(1);
        const codeBlock = fragment.get(0);
        expect(codeBlock.nodeName).toBe('codeBlock');
        expect(helpers.getTextContent(codeBlock)).toBe('const x = 42;');
      });

      it('should create a mermaid diagram block', () => {
        helpers.appendBlocks(fragment, [
          { type: 'mermaid', content: 'graph TD\n  A --> B' }
        ]);

        expect(fragment.length).toBe(1);
        const mermaid = fragment.get(0);
        expect(mermaid.nodeName).toBe('mermaid');
        expect(helpers.getTextContent(mermaid)).toBe('graph TD\n  A --> B');
      });

      it('should require content for diagram blocks', () => {
        expect(() =>
          helpers.appendBlocks(fragment, [{ type: 'mermaid' }])
        ).toThrow(/mermaid requires content/);
      });

      it('should create a bullet list', () => {
        helpers.appendBlocks(fragment, [
          { type: 'bulletList', items: ['Item one', 'Item two', 'Item three'] }
        ]);

        expect(fragment.length).toBe(1);
        const list = fragment.get(0);
        expect(list.nodeName).toBe('bulletList');
        expect(list.length).toBe(3);

        const items = list.toArray();
        expect(items[0].nodeName).toBe('listItem');
        expect(helpers.getTextContent(items[0])).toBe('Item one');
        expect(helpers.getTextContent(items[1])).toBe('Item two');
        expect(helpers.getTextContent(items[2])).toBe('Item three');
      });

      it('should create an ordered list', () => {
        helpers.appendBlocks(fragment, [
          { type: 'orderedList', items: ['First', 'Second'] }
        ]);

        expect(fragment.length).toBe(1);
        const list = fragment.get(0);
        expect(list.nodeName).toBe('orderedList');
        expect(list.length).toBe(2);
      });

      it('should create multiple blocks at once', () => {
        helpers.appendBlocks(fragment, [
          { type: 'heading', level: 1, content: 'Title' },
          { type: 'paragraph', content: 'First paragraph.' },
          { type: 'paragraph', content: 'Second paragraph.' }
        ]);

        expect(fragment.length).toBe(3);
        expect(fragment.get(0).nodeName).toBe('heading');
        expect(fragment.get(1).nodeName).toBe('paragraph');
        expect(fragment.get(2).nodeName).toBe('paragraph');
      });

      it('should create a blockquote', () => {
        helpers.appendBlocks(fragment, [
          { type: 'blockquote', content: 'To be or not to be...' }
        ]);

        expect(fragment.length).toBe(1);
        const blockquote = fragment.get(0);
        expect(blockquote.nodeName).toBe('blockquote');
        // Blockquote contains a paragraph
        expect(blockquote.get(0).nodeName).toBe('paragraph');
        expect(helpers.getTextContent(blockquote)).toBe('To be or not to be...');
      });

      it('should create a blockquote with formatted content', () => {
        helpers.appendBlocks(fragment, [
          { type: 'blockquote', content: [
            'Quote with ',
            { text: 'emphasis', attrs: { italic: true } }
          ]}
        ]);

        const blockquote = fragment.get(0);
        const para = blockquote.get(0);
        const text = helpers.findTextNode(para);
        const delta = text.toDelta();

        expect(delta.length).toBe(2);
        expect(delta[1].attributes).toEqual({ italic: true });
      });

      it('should create a horizontal rule', () => {
        helpers.appendBlocks(fragment, [
          { type: 'horizontalRule' }
        ]);

        expect(fragment.length).toBe(1);
        const hr = fragment.get(0);
        expect(hr.nodeName).toBe('horizontalRule');
      });

      it('should create a table with headers and rows', () => {
        helpers.appendBlocks(fragment, [
          { type: 'table',
            headers: ['Name', 'Age', 'City'],
            rows: [
              ['Alice', '30', 'NYC'],
              ['Bob', '25', 'LA']
            ]
          }
        ]);

        expect(fragment.length).toBe(1);
        const table = fragment.get(0);
        expect(table.nodeName).toBe('table');
        expect(table.length).toBe(3); // 1 header row + 2 data rows

        // Check header row
        const headerRow = table.get(0);
        expect(headerRow.nodeName).toBe('tableRow');
        expect(headerRow.length).toBe(3);
        expect(headerRow.get(0).nodeName).toBe('tableHeader');
        expect(helpers.getTextContent(headerRow.get(0))).toBe('Name');
        expect(helpers.getTextContent(headerRow.get(1))).toBe('Age');
        expect(helpers.getTextContent(headerRow.get(2))).toBe('City');

        // Check data rows
        const dataRow1 = table.get(1);
        expect(dataRow1.nodeName).toBe('tableRow');
        expect(dataRow1.get(0).nodeName).toBe('tableCell');
        expect(helpers.getTextContent(dataRow1.get(0))).toBe('Alice');

        const dataRow2 = table.get(2);
        expect(helpers.getTextContent(dataRow2.get(0))).toBe('Bob');
      });

      it('should create a table without headers', () => {
        helpers.appendBlocks(fragment, [
          { type: 'table',
            rows: [
              ['Cell 1', 'Cell 2'],
              ['Cell 3', 'Cell 4']
            ]
          }
        ]);

        const table = fragment.get(0);
        expect(table.length).toBe(2); // 2 data rows only

        // All cells should be tableCell, not tableHeader
        const row1 = table.get(0);
        expect(row1.get(0).nodeName).toBe('tableCell');
        expect(row1.get(1).nodeName).toBe('tableCell');
      });

      it('should create a table with formatted cell content', () => {
        helpers.appendBlocks(fragment, [
          { type: 'table',
            rows: [
              [['Cell with ', { text: 'bold', attrs: { bold: true } }], 'Plain cell']
            ]
          }
        ]);

        const table = fragment.get(0);
        const row = table.get(0);
        const cell = row.get(0);
        const para = cell.get(0);
        const text = helpers.findTextNode(para);
        const delta = text.toDelta();

        expect(delta.length).toBe(2);
        expect(delta[1].attributes).toEqual({ bold: true });
      });
    });

    describe('formatted content', () => {
      it('should create paragraph with formatted content', () => {
        helpers.appendBlocks(fragment, [
          { type: 'paragraph', content: [
            'Text with ',
            { text: 'bold', attrs: { bold: true } },
            ' formatting.'
          ]}
        ]);

        const para = fragment.get(0);
        const text = helpers.findTextNode(para);
        const delta = text.toDelta();

        expect(delta.length).toBe(3);
        expect(delta[0].insert).toBe('Text with ');
        expect(delta[1].insert).toBe('bold');
        expect(delta[1].attributes).toEqual({ bold: true });
        expect(delta[2].insert).toBe(' formatting.');
      });

      it('should create heading with formatted content', () => {
        helpers.appendBlocks(fragment, [
          { type: 'heading', level: 2, content: [
            'Title with ',
            { text: 'emphasis', attrs: { italic: true } }
          ]}
        ]);

        const heading = fragment.get(0);
        const text = helpers.findTextNode(heading);
        const delta = text.toDelta();

        expect(delta.length).toBe(2);
        expect(delta[1].attributes).toEqual({ italic: true });
      });

      it('should create list items with formatted content', () => {
        helpers.appendBlocks(fragment, [
          { type: 'bulletList', items: [
            'Plain item',
            ['Item with ', { text: 'emphasis', attrs: { italic: true } }]
          ]}
        ]);

        const list = fragment.get(0);
        const items = list.toArray();

        // Second item has formatting
        const para = items[1].get(0);
        const text = helpers.findTextNode(para);
        const delta = text.toDelta();
        expect(delta.length).toBe(2);
        expect(delta[1].attributes).toEqual({ italic: true });
      });
    });

    describe('nested lists', () => {
      it('should create a bullet list with nested bullet list', () => {
        helpers.appendBlocks(fragment, [
          { type: 'bulletList', items: [
            'Simple item',
            { content: 'Parent item', items: ['Nested one', 'Nested two'] },
            'Another simple item'
          ]}
        ]);

        const list = fragment.get(0);
        expect(list.nodeName).toBe('bulletList');
        expect(list.length).toBe(3);

        // First item is simple
        const firstItem = list.get(0);
        expect(firstItem.nodeName).toBe('listItem');
        expect(firstItem.length).toBe(1);
        expect(helpers.getTextContent(firstItem)).toBe('Simple item');

        // Second item has nested list
        const secondItem = list.get(1);
        expect(secondItem.nodeName).toBe('listItem');
        expect(secondItem.length).toBe(2); // paragraph + nested list
        expect(helpers.getTextContent(secondItem.get(0))).toBe('Parent item');

        const nestedList = secondItem.get(1);
        expect(nestedList.nodeName).toBe('bulletList');
        expect(nestedList.length).toBe(2);
        expect(helpers.getTextContent(nestedList.get(0))).toBe('Nested one');
        expect(helpers.getTextContent(nestedList.get(1))).toBe('Nested two');

        // Third item is simple
        expect(helpers.getTextContent(list.get(2))).toBe('Another simple item');
      });

      it('should create an ordered list with nested ordered list', () => {
        helpers.appendBlocks(fragment, [
          { type: 'orderedList', items: [
            'First',
            { content: 'Second with nested', items: ['2.1', '2.2'] },
            'Third'
          ]}
        ]);

        const list = fragment.get(0);
        expect(list.nodeName).toBe('orderedList');

        const secondItem = list.get(1);
        const nestedList = secondItem.get(1);
        expect(nestedList.nodeName).toBe('orderedList'); // inherits parent type
        expect(nestedList.length).toBe(2);
      });

      it('should allow specifying different nested list type', () => {
        helpers.appendBlocks(fragment, [
          { type: 'orderedList', items: [
            { content: 'Ordered parent', items: ['Bullet child'], type: 'bulletList' }
          ]}
        ]);

        const list = fragment.get(0);
        expect(list.nodeName).toBe('orderedList');

        const item = list.get(0);
        const nestedList = item.get(1);
        expect(nestedList.nodeName).toBe('bulletList'); // overridden type
      });

      it('should support deeply nested lists', () => {
        helpers.appendBlocks(fragment, [
          { type: 'bulletList', items: [
            { content: 'Level 1', items: [
              { content: 'Level 2', items: [
                'Level 3 item'
              ]}
            ]}
          ]}
        ]);

        const list = fragment.get(0);
        const level1Item = list.get(0);
        const level2List = level1Item.get(1);
        const level2Item = level2List.get(0);
        const level3List = level2Item.get(1);
        const level3Item = level3List.get(0);

        expect(helpers.getTextContent(level1Item.get(0))).toBe('Level 1');
        expect(helpers.getTextContent(level2Item.get(0))).toBe('Level 2');
        expect(helpers.getTextContent(level3Item)).toBe('Level 3 item');
      });

      it('should support formatted content in nested items', () => {
        helpers.appendBlocks(fragment, [
          { type: 'bulletList', items: [
            {
              content: ['Parent with ', { text: 'bold', attrs: { bold: true } }],
              items: [
                ['Child with ', { text: 'italic', attrs: { italic: true } }]
              ]
            }
          ]}
        ]);

        const list = fragment.get(0);
        const parentItem = list.get(0);
        const parentPara = parentItem.get(0);
        const parentText = helpers.findTextNode(parentPara);
        const parentDelta = parentText.toDelta();
        expect(parentDelta[1].attributes).toEqual({ bold: true });

        const nestedList = parentItem.get(1);
        const childItem = nestedList.get(0);
        const childPara = childItem.get(0);
        const childText = helpers.findTextNode(childPara);
        const childDelta = childText.toDelta();
        expect(childDelta[1].attributes).toEqual({ italic: true });
      });

      it('should handle item with content but no items', () => {
        helpers.appendBlocks(fragment, [
          { type: 'bulletList', items: [
            { content: 'Just content, no nested items' }
          ]}
        ]);

        const list = fragment.get(0);
        const item = list.get(0);
        expect(item.length).toBe(1); // only paragraph, no nested list
        expect(helpers.getTextContent(item)).toBe('Just content, no nested items');
      });

      it('should handle empty items array', () => {
        helpers.appendBlocks(fragment, [
          { type: 'bulletList', items: [
            { content: 'Has empty items', items: [] }
          ]}
        ]);

        const list = fragment.get(0);
        const item = list.get(0);
        expect(item.length).toBe(1); // only paragraph, no nested list
      });
    });

    describe('positioning', () => {
      beforeEach(() => {
        // Create initial content
        const h1 = new Y.XmlElement('heading');
        h1.setAttribute('level', 1);
        const h1Text = new Y.XmlText();
        h1Text.insert(0, 'Introduction');
        h1.insert(0, [h1Text]);

        const para = new Y.XmlElement('paragraph');
        const paraText = new Y.XmlText();
        paraText.insert(0, 'Content here.');
        para.insert(0, [paraText]);

        const h2 = new Y.XmlElement('heading');
        h2.setAttribute('level', 2);
        const h2Text = new Y.XmlText();
        h2Text.insert(0, 'Conclusion');
        h2.insert(0, [h2Text]);

        fragment.insert(0, [h1, para, h2]);
      });

      it('should append at end by default', () => {
        helpers.appendBlocks(fragment, [
          { type: 'paragraph', content: 'New content' }
        ]);

        expect(fragment.length).toBe(4);
        expect(helpers.getTextContent(fragment.get(3))).toBe('New content');
      });

      it('should append at end with explicit position', () => {
        helpers.appendBlocks(fragment, [
          { type: 'paragraph', content: 'New content' }
        ], { at: 'end' });

        expect(fragment.length).toBe(4);
        expect(helpers.getTextContent(fragment.get(3))).toBe('New content');
      });

      it('should insert at start', () => {
        helpers.appendBlocks(fragment, [
          { type: 'paragraph', content: 'New content' }
        ], { at: 'start' });

        expect(fragment.length).toBe(4);
        expect(helpers.getTextContent(fragment.get(0))).toBe('New content');
        expect(helpers.getTextContent(fragment.get(1))).toBe('Introduction');
      });

      it('should insert before an element reference', () => {
        const conclusion = fragment.get(2); // The "Conclusion" heading

        helpers.appendBlocks(fragment, [
          { type: 'paragraph', content: 'Before conclusion' }
        ], { before: conclusion });

        expect(fragment.length).toBe(4);
        expect(helpers.getTextContent(fragment.get(2))).toBe('Before conclusion');
        expect(helpers.getTextContent(fragment.get(3))).toBe('Conclusion');
      });

      it('should insert after an element reference', () => {
        const intro = fragment.get(0); // The "Introduction" heading

        helpers.appendBlocks(fragment, [
          { type: 'paragraph', content: 'After intro' }
        ], { after: intro });

        expect(fragment.length).toBe(4);
        expect(helpers.getTextContent(fragment.get(0))).toBe('Introduction');
        expect(helpers.getTextContent(fragment.get(1))).toBe('After intro');
        expect(helpers.getTextContent(fragment.get(2))).toBe('Content here.');
      });
    });

    describe('return value', () => {
      it('should return array of created elements', () => {
        const elements = helpers.appendBlocks(fragment, [
          { type: 'heading', level: 2, content: 'Title' },
          { type: 'paragraph', content: 'Content' }
        ]);

        expect(elements).toHaveLength(2);
        expect(elements[0].nodeName).toBe('heading');
        expect(elements[1].nodeName).toBe('paragraph');
      });
    });

    describe('error handling', () => {
      it('should throw for invalid container', () => {
        expect(() => helpers.appendBlocks(null, []))
          .toThrow('container must be a Y.XmlFragment or Y.XmlElement');
        expect(() => helpers.appendBlocks({}, []))
          .toThrow('container must be a Y.XmlFragment or Y.XmlElement');
      });

      it('should throw for empty blocks array', () => {
        expect(() => helpers.appendBlocks(fragment, []))
          .toThrow('blocks must be a non-empty array');
      });

      it('should throw for block without type', () => {
        expect(() => helpers.appendBlocks(fragment, [{ content: 'test' }]))
          .toThrow('must have a type property');
      });

      it('should throw for unknown block type', () => {
        expect(() => helpers.appendBlocks(fragment, [{ type: 'unknown' }]))
          .toThrow('unknown block type "unknown"');
      });

      it('should throw for paragraph without content', () => {
        expect(() => helpers.appendBlocks(fragment, [{ type: 'paragraph' }]))
          .toThrow('paragraph requires content');
      });

      it('should throw for heading without content', () => {
        expect(() => helpers.appendBlocks(fragment, [{ type: 'heading', level: 1 }]))
          .toThrow('heading requires content');
      });

      it('should throw for heading with invalid level', () => {
        expect(() => helpers.appendBlocks(fragment, [{ type: 'heading', level: 0, content: 'x' }]))
          .toThrow('heading level must be 1-5');
        expect(() => helpers.appendBlocks(fragment, [{ type: 'heading', level: 6, content: 'x' }]))
          .toThrow('heading level must be 1-5');
      });

      it('should throw for bulletList without items', () => {
        expect(() => helpers.appendBlocks(fragment, [{ type: 'bulletList' }]))
          .toThrow('bulletList requires items');
      });

      it('should throw for bulletList with empty items', () => {
        expect(() => helpers.appendBlocks(fragment, [{ type: 'bulletList', items: [] }]))
          .toThrow('items must be a non-empty array');
      });

      it('should throw for codeBlock without content', () => {
        expect(() => helpers.appendBlocks(fragment, [{ type: 'codeBlock' }]))
          .toThrow('codeBlock requires content');
      });

      it('should throw for codeBlock with non-string content', () => {
        expect(() => helpers.appendBlocks(fragment, [{ type: 'codeBlock', content: ['array'] }]))
          .toThrow('codeBlock content must be a string');
      });

      it('should throw for blockquote without content', () => {
        expect(() => helpers.appendBlocks(fragment, [{ type: 'blockquote' }]))
          .toThrow('blockquote requires content');
      });

      it('should throw for table without rows', () => {
        expect(() => helpers.appendBlocks(fragment, [{ type: 'table' }]))
          .toThrow('table requires rows');
      });

      it('should throw for table with empty rows', () => {
        expect(() => helpers.appendBlocks(fragment, [{ type: 'table', rows: [] }]))
          .toThrow('table requires rows array');
      });

      it('should throw for table with non-array row', () => {
        expect(() => helpers.appendBlocks(fragment, [{ type: 'table', rows: ['not an array'] }]))
          .toThrow('each table row must be an array');
      });

      it('should throw for invalid content segment', () => {
        expect(() => helpers.appendBlocks(fragment, [
          { type: 'paragraph', content: [123] }
        ])).toThrow('invalid content segment');
      });

      it('should throw for invalid position', () => {
        expect(() => helpers.appendBlocks(fragment, [
          { type: 'paragraph', content: 'test' }
        ], { invalid: true })).toThrow('invalid position');
      });

      it('should throw when target element not found in container', () => {
        const orphan = new Y.XmlElement('paragraph');
        expect(() => helpers.appendBlocks(fragment, [
          { type: 'paragraph', content: 'test' }
        ], { before: orphan })).toThrow('target element not found');
      });

      it('should throw for xpath positioning without xpathFirst option', () => {
        expect(() => helpers.appendBlocks(fragment, [
          { type: 'paragraph', content: 'test' }
        ], { after: '//heading' })).toThrow('xpath positioning requires xpathFirst');
      });
    });

    describe('xpath positioning with xpathFirst option', () => {
      const { xpathFirst } = require('../xpath');

      beforeEach(() => {
        const h1 = new Y.XmlElement('heading');
        h1.setAttribute('level', 1);
        const h1Text = new Y.XmlText();
        h1Text.insert(0, 'Introduction');
        h1.insert(0, [h1Text]);

        const para = new Y.XmlElement('paragraph');
        const paraText = new Y.XmlText();
        paraText.insert(0, 'Content here.');
        para.insert(0, [paraText]);

        const h2 = new Y.XmlElement('heading');
        h2.setAttribute('level', 2);
        const h2Text = new Y.XmlText();
        h2Text.insert(0, 'Conclusion');
        h2.insert(0, [h2Text]);

        fragment.insert(0, [h1, para, h2]);
      });

      it('should insert after xpath match', () => {
        helpers.appendBlocks(fragment, [
          { type: 'paragraph', content: 'After intro' }
        ], { after: '//heading[contains(., "Introduction")]' }, { xpathFirst });

        expect(fragment.length).toBe(4);
        expect(helpers.getTextContent(fragment.get(1))).toBe('After intro');
      });

      it('should insert before xpath match', () => {
        helpers.appendBlocks(fragment, [
          { type: 'paragraph', content: 'Before conclusion' }
        ], { before: '//heading[contains(., "Conclusion")]' }, { xpathFirst });

        expect(fragment.length).toBe(4);
        expect(helpers.getTextContent(fragment.get(2))).toBe('Before conclusion');
      });

      it('should throw when xpath finds no match', () => {
        expect(() => helpers.appendBlocks(fragment, [
          { type: 'paragraph', content: 'test' }
        ], { after: '//heading[contains(., "NotFound")]' }, { xpathFirst }))
          .toThrow('no element found matching xpath');
      });
    });

    describe('real-world example', () => {
      it('should create email draft structure', () => {
        // The example from the feature request
        helpers.appendBlocks(fragment, [
          { type: 'heading', level: 2, content: 'Draft Response' },
          { type: 'paragraph', content: 'Hi Sal,' },
          { type: 'paragraph', content: 'Thanks for sending over the server details.' },
          { type: 'paragraph', content: 'I didn\'t receive the secure email with the SSH keys...' },
          { type: 'paragraph', content: 'Alternatively, I could share a public SSH key...' },
          { type: 'paragraph', content: 'Let me know what works best.' },
          { type: 'paragraph', content: 'Best,' },
          { type: 'paragraph', content: 'Sam' }
        ]);

        expect(fragment.length).toBe(8);
        expect(fragment.get(0).nodeName).toBe('heading');
        expect(fragment.get(0).getAttribute('level')).toBe(2);
        expect(helpers.getTextContent(fragment.get(1))).toBe('Hi Sal,');
        expect(helpers.getTextContent(fragment.get(7))).toBe('Sam');
      });

      it('should create mixed content document', () => {
        helpers.appendBlocks(fragment, [
          { type: 'heading', level: 2, content: 'Section Title' },
          { type: 'paragraph', content: 'Plain text paragraph.' },
          { type: 'paragraph', content: [
            'Text with ',
            { text: 'formatting', attrs: { bold: true } }
          ]},
          { type: 'bulletList', items: ['Item one', 'Item two', 'Item three'] },
          { type: 'orderedList', items: ['First', 'Second', 'Third'] },
          { type: 'codeBlock', content: 'const x = 42;' }
        ]);

        expect(fragment.length).toBe(6);
        expect(fragment.get(0).nodeName).toBe('heading');
        expect(fragment.get(3).nodeName).toBe('bulletList');
        expect(fragment.get(4).nodeName).toBe('orderedList');
        expect(fragment.get(5).nodeName).toBe('codeBlock');
      });
    });
  });

  describe('getFormattedContent', () => {
    it('should read plain text correctly', () => {
      const para = new Y.XmlElement('paragraph');
      const text = new Y.XmlText();
      text.insert(0, 'Hello world');
      para.insert(0, [text]);
      fragment.insert(0, [para]);

      const segments = helpers.getFormattedContent(para);
      expect(segments).toEqual(['Hello world']);
    });

    it('should read formatted text with attrs', () => {
      const para = new Y.XmlElement('paragraph');
      const text = new Y.XmlText();
      text.insert(0, 'Hello bold world');
      text.format(6, 4, { bold: true });
      para.insert(0, [text]);
      fragment.insert(0, [para]);

      const segments = helpers.getFormattedContent(para);
      expect(segments).toEqual([
        'Hello ',
        { text: 'bold', attrs: { bold: true } },
        ' world'
      ]);
    });

    it('should read text with link formatting', () => {
      const para = new Y.XmlElement('paragraph');
      const text = new Y.XmlText();
      text.insert(0, 'Visit Example for info');
      text.format(6, 7, { link: { href: 'https://example.com' } });
      para.insert(0, [text]);
      fragment.insert(0, [para]);

      const segments = helpers.getFormattedContent(para);
      expect(segments).toEqual([
        'Visit ',
        { text: 'Example', attrs: { link: { href: 'https://example.com' } } },
        ' for info'
      ]);
    });

    it('should handle container elements (listItem)', () => {
      const list = new Y.XmlElement('bulletList');
      const item = new Y.XmlElement('listItem');
      const para = new Y.XmlElement('paragraph');
      const text = new Y.XmlText();
      text.insert(0, 'List item text');
      para.insert(0, [text]);
      item.insert(0, [para]);
      list.insert(0, [item]);
      fragment.insert(0, [list]);

      const segments = helpers.getFormattedContent(item);
      expect(segments).toEqual(['List item text']);
    });

    it('should handle container elements (tableCell)', () => {
      const table = new Y.XmlElement('table');
      const row = new Y.XmlElement('tableRow');
      const cell = new Y.XmlElement('tableCell');
      const para = new Y.XmlElement('paragraph');
      const text = new Y.XmlText();
      text.insert(0, 'Cell content');
      para.insert(0, [text]);
      cell.insert(0, [para]);
      row.insert(0, [cell]);
      table.insert(0, [row]);
      fragment.insert(0, [table]);

      const segments = helpers.getFormattedContent(cell);
      expect(segments).toEqual(['Cell content']);
    });

    it('should return empty array for element without text', () => {
      const para = new Y.XmlElement('paragraph');
      fragment.insert(0, [para]);

      const segments = helpers.getFormattedContent(para);
      expect(segments).toEqual([]);
    });

    it('should work directly on Y.XmlText', () => {
      const para = new Y.XmlElement('paragraph');
      const text = new Y.XmlText();
      text.insert(0, 'Direct text');
      para.insert(0, [text]);
      fragment.insert(0, [para]);

      const segments = helpers.getFormattedContent(text);
      expect(segments).toEqual(['Direct text']);
    });
  });

  describe('setFormattedContent', () => {
    it('should write plain text segments', () => {
      const para = new Y.XmlElement('paragraph');
      const text = new Y.XmlText();
      para.insert(0, [text]);
      fragment.insert(0, [para]);

      helpers.setFormattedContent(para, ['Hello world']);

      expect(helpers.getTextContent(para)).toBe('Hello world');
    });

    it('should write formatted segments', () => {
      const para = new Y.XmlElement('paragraph');
      const text = new Y.XmlText();
      para.insert(0, [text]);
      fragment.insert(0, [para]);

      helpers.setFormattedContent(para, [
        'Hello ',
        { text: 'bold', attrs: { bold: true } },
        ' world'
      ]);

      const resultText = helpers.findTextNode(para);
      const delta = resultText.toDelta();
      expect(delta).toHaveLength(3);
      expect(delta[0].insert).toBe('Hello ');
      expect(delta[1].insert).toBe('bold');
      expect(delta[1].attributes).toEqual({ bold: true });
      expect(delta[2].insert).toBe(' world');
    });

    it('should clear existing content before writing', () => {
      const para = new Y.XmlElement('paragraph');
      const text = new Y.XmlText();
      text.insert(0, 'Old content');
      para.insert(0, [text]);
      fragment.insert(0, [para]);

      helpers.setFormattedContent(para, ['New content']);

      expect(helpers.getTextContent(para)).toBe('New content');
    });

    it('should throw for non-array segments', () => {
      const para = new Y.XmlElement('paragraph');
      const text = new Y.XmlText();
      para.insert(0, [text]);
      fragment.insert(0, [para]);

      expect(() => helpers.setFormattedContent(para, 'not an array'))
        .toThrow('segments must be an array');
    });

    it('should throw for element without text node', () => {
      const para = new Y.XmlElement('paragraph');
      fragment.insert(0, [para]);

      expect(() => helpers.setFormattedContent(para, ['content']))
        .toThrow('no text node found');
    });

    it('should handle container elements (listItem)', () => {
      const list = new Y.XmlElement('bulletList');
      const item = new Y.XmlElement('listItem');
      const para = new Y.XmlElement('paragraph');
      const text = new Y.XmlText();
      text.insert(0, 'Original');
      para.insert(0, [text]);
      item.insert(0, [para]);
      list.insert(0, [item]);
      fragment.insert(0, [list]);

      helpers.setFormattedContent(item, ['Updated content']);

      expect(helpers.getTextContent(item)).toBe('Updated content');
    });
  });

  describe('getPlainText', () => {
    it('should extract plain text from plain segments', () => {
      const segments = ['Hello ', 'world'];
      expect(helpers.getPlainText(segments)).toBe('Hello world');
    });

    it('should extract plain text from formatted segments', () => {
      const segments = [
        'Hello ',
        { text: 'bold', attrs: { bold: true } },
        ' world'
      ];
      expect(helpers.getPlainText(segments)).toBe('Hello bold world');
    });

    it('should handle mixed segments', () => {
      const segments = [
        'Visit ',
        { text: 'Example', attrs: { link: { href: 'https://example.com' } } },
        ' for info'
      ];
      expect(helpers.getPlainText(segments)).toBe('Visit Example for info');
    });

    it('should return empty string for empty array', () => {
      expect(helpers.getPlainText([])).toBe('');
    });

    it('should return empty string for non-array', () => {
      expect(helpers.getPlainText(null)).toBe('');
      expect(helpers.getPlainText(undefined)).toBe('');
      expect(helpers.getPlainText('string')).toBe('');
    });

    it('should handle segment with undefined text', () => {
      const segments = ['Hello ', { attrs: { bold: true } }, ' world'];
      expect(helpers.getPlainText(segments)).toBe('Hello  world');
    });
  });

  describe('getParagraphs', () => {
    it('should read all paragraphs from a container', () => {
      const list = new Y.XmlElement('bulletList');
      const item = new Y.XmlElement('listItem');
      const para1 = new Y.XmlElement('paragraph');
      const text1 = new Y.XmlText();
      text1.insert(0, 'First para');
      para1.insert(0, [text1]);
      const para2 = new Y.XmlElement('paragraph');
      const text2 = new Y.XmlText();
      text2.insert(0, 'Second para');
      para2.insert(0, [text2]);
      item.insert(0, [para1, para2]);
      list.insert(0, [item]);
      fragment.insert(0, [list]);

      const paras = helpers.getParagraphs(item);
      expect(paras).toEqual([['First para'], ['Second para']]);
    });

    it('should return formatted content for each paragraph', () => {
      const list = new Y.XmlElement('bulletList');
      const item = new Y.XmlElement('listItem');
      const para = new Y.XmlElement('paragraph');
      const text = new Y.XmlText();
      text.insert(0, 'Text with bold');
      text.format(10, 4, { bold: true });
      para.insert(0, [text]);
      item.insert(0, [para]);
      list.insert(0, [item]);
      fragment.insert(0, [list]);

      const paras = helpers.getParagraphs(item);
      expect(paras).toEqual([
        ['Text with ', { text: 'bold', attrs: { bold: true } }]
      ]);
    });

    it('should return empty array for container without paragraphs', () => {
      const list = new Y.XmlElement('bulletList');
      const item = new Y.XmlElement('listItem');
      list.insert(0, [item]);
      fragment.insert(0, [list]);

      const paras = helpers.getParagraphs(item);
      expect(paras).toEqual([]);
    });

    it('should throw for non-XmlElement input', () => {
      expect(() => helpers.getParagraphs(null)).toThrow('expected Y.XmlElement');
      expect(() => helpers.getParagraphs('string')).toThrow('expected Y.XmlElement');
    });
  });

  describe('setParagraphs', () => {
    it('should replace all paragraphs in a container', () => {
      const list = new Y.XmlElement('bulletList');
      const item = new Y.XmlElement('listItem');
      const para = new Y.XmlElement('paragraph');
      const text = new Y.XmlText();
      text.insert(0, 'Original');
      para.insert(0, [text]);
      item.insert(0, [para]);
      list.insert(0, [item]);
      fragment.insert(0, [list]);

      helpers.setParagraphs(item, [['First new'], ['Second new']]);

      const paras = helpers.getParagraphs(item);
      expect(paras).toEqual([['First new'], ['Second new']]);
    });

    it('should support formatted content', () => {
      const list = new Y.XmlElement('bulletList');
      const item = new Y.XmlElement('listItem');
      const para = new Y.XmlElement('paragraph');
      const text = new Y.XmlText();
      text.insert(0, 'Original');
      para.insert(0, [text]);
      item.insert(0, [para]);
      list.insert(0, [item]);
      fragment.insert(0, [list]);

      helpers.setParagraphs(item, [
        ['Hello ', { text: 'world', attrs: { bold: true } }]
      ]);

      const paras = helpers.getParagraphs(item);
      expect(paras).toEqual([
        ['Hello ', { text: 'world', attrs: { bold: true } }]
      ]);
    });

    it('should insert paragraphs at first paragraph position', () => {
      const list = new Y.XmlElement('bulletList');
      const item = new Y.XmlElement('listItem');
      const para = new Y.XmlElement('paragraph');
      const text = new Y.XmlText();
      text.insert(0, 'Original');
      para.insert(0, [text]);
      const nestedList = new Y.XmlElement('bulletList');
      item.insert(0, [para, nestedList]); // paragraph at 0, nested list at 1
      list.insert(0, [item]);
      fragment.insert(0, [list]);

      helpers.setParagraphs(item, [['New para']]);

      // Nested list should still be at index 1
      expect(item.get(0).nodeName).toBe('paragraph');
      expect(item.get(1).nodeName).toBe('bulletList');
      expect(helpers.getTextContent(item.get(0))).toBe('New para');
    });

    it('should throw for non-XmlElement input', () => {
      expect(() => helpers.setParagraphs(null, [['test']]))
        .toThrow('expected Y.XmlElement');
    });

    it('should throw for non-array segmentArrays', () => {
      const para = new Y.XmlElement('paragraph');
      fragment.insert(0, [para]);

      expect(() => helpers.setParagraphs(para, 'not array'))
        .toThrow('expected array of segment arrays');
    });
  });

  describe('setFormattedContent — replacing formatted content', () => {
    it('should not inherit marks from previously formatted content', () => {
      const para = new Y.XmlElement('paragraph');
      const text = new Y.XmlText();
      text.insert(0, 'italic text');
      text.format(0, 11, { italic: true });
      para.insert(0, [text]);
      fragment.insert(0, [para]);

      // Replace with plain text (no formatting)
      helpers.setFormattedContent(para, ['plain text']);

      const delta = helpers.findTextNode(para).toDelta();
      expect(delta).toHaveLength(1);
      expect(delta[0].insert).toBe('plain text');
      expect(delta[0].attributes).toBeUndefined();
    });

    it('should replace bold text with different formatting', () => {
      const para = new Y.XmlElement('paragraph');
      const text = new Y.XmlText();
      text.insert(0, 'bold text');
      text.format(0, 9, { bold: true });
      para.insert(0, [text]);
      fragment.insert(0, [para]);

      // Replace with italic text
      helpers.setFormattedContent(para, [
        { text: 'italic text', attrs: { italic: true } }
      ]);

      const delta = helpers.findTextNode(para).toDelta();
      expect(delta).toHaveLength(1);
      expect(delta[0].insert).toBe('italic text');
      expect(delta[0].attributes).toEqual({ italic: true });
    });

    it('should replace formatted content in a table cell', () => {
      const table = new Y.XmlElement('table');
      const row = new Y.XmlElement('tableRow');
      const cell = new Y.XmlElement('tableCell');
      const para = new Y.XmlElement('paragraph');
      const text = new Y.XmlText();
      text.insert(0, 'Dublin → Adare');
      text.format(0, 14, { italic: true });
      para.insert(0, [text]);
      cell.insert(0, [para]);
      row.insert(0, [cell]);
      table.insert(0, [row]);
      fragment.insert(0, [table]);

      // Replace with plain text via the cell's paragraph
      helpers.setFormattedContent(para, ['Cork → Galway']);

      const delta = helpers.findTextNode(para).toDelta();
      expect(delta).toHaveLength(1);
      expect(delta[0].insert).toBe('Cork → Galway');
      expect(delta[0].attributes).toBeUndefined();
    });

    it('should replace mixed-format content with new mixed formatting', () => {
      const para = new Y.XmlElement('paragraph');
      const text = new Y.XmlText();
      text.insert(0, 'hello world');
      text.format(0, 5, { bold: true });
      text.format(6, 5, { italic: true });
      para.insert(0, [text]);
      fragment.insert(0, [para]);

      // Replace with completely different formatting
      helpers.setFormattedContent(para, [
        'plain ',
        { text: 'underlined', attrs: { underline: true } },
      ]);

      const delta = helpers.findTextNode(para).toDelta();
      expect(delta).toHaveLength(2);
      expect(delta[0].insert).toBe('plain ');
      expect(delta[0].attributes).toBeUndefined();
      expect(delta[1].insert).toBe('underlined');
      expect(delta[1].attributes).toEqual({ underline: true });
    });
  });

  describe('round-trip: getFormattedContent -> setFormattedContent', () => {
    it('should preserve formatting through round-trip', () => {
      const para = new Y.XmlElement('paragraph');
      const text = new Y.XmlText();
      text.insert(0, 'Hello bold and italic text');
      text.format(6, 4, { bold: true });
      text.format(15, 6, { italic: true });
      para.insert(0, [text]);
      fragment.insert(0, [para]);

      // Read
      const segments = helpers.getFormattedContent(para);

      // Modify only plain text
      const modified = segments.map(s =>
        typeof s === 'string' ? s.replace('Hello', 'Hi') : s
      );

      // Write back
      helpers.setFormattedContent(para, modified);

      // Verify
      const result = helpers.getFormattedContent(para);
      expect(helpers.getPlainText(result)).toBe('Hi bold and italic text');

      // Formatting should be preserved
      expect(result).toContainEqual({ text: 'bold', attrs: { bold: true } });
      expect(result).toContainEqual({ text: 'italic', attrs: { italic: true } });
    });

    it('should preserve link formatting through round-trip', () => {
      const para = new Y.XmlElement('paragraph');
      const text = new Y.XmlText();
      text.insert(0, 'Visit Example for more');
      text.format(6, 7, { link: { href: 'https://example.com' } });
      para.insert(0, [text]);
      fragment.insert(0, [para]);

      // Read, modify, write
      const segments = helpers.getFormattedContent(para);
      const modified = segments.map(s =>
        typeof s === 'string' ? s.replace('more', 'info') : s
      );
      helpers.setFormattedContent(para, modified);

      // Verify
      const result = helpers.getFormattedContent(para);
      expect(helpers.getPlainText(result)).toBe('Visit Example for info');
      expect(result).toContainEqual({
        text: 'Example',
        attrs: { link: { href: 'https://example.com' } }
      });
    });
  });

  describe('nested list bug reproductions', () => {
    it('appendBlocks should append items to a nested bulletList container', () => {
      // Build: bulletList > listItem > [paragraph, bulletList > [listItem("Existing 1"), listItem("Existing 2")]]
      const outerList = new Y.XmlElement('bulletList');
      const outerItem = new Y.XmlElement('listItem');
      const outerPara = new Y.XmlElement('paragraph');
      const outerText = new Y.XmlText();
      outerText.insert(0, 'Parent');
      outerPara.insert(0, [outerText]);
      outerItem.insert(0, [outerPara]);

      const innerList = new Y.XmlElement('bulletList');
      for (const label of ['Existing 1', 'Existing 2']) {
        const li = new Y.XmlElement('listItem');
        const p = new Y.XmlElement('paragraph');
        const t = new Y.XmlText();
        t.insert(0, label);
        p.insert(0, [t]);
        li.insert(0, [p]);
        innerList.insert(innerList.length, [li]);
      }

      outerItem.insert(1, [innerList]);
      outerList.insert(0, [outerItem]);
      fragment.insert(0, [outerList]);

      // Append to the *nested* bulletList, not the root
      helpers.appendBlocks(innerList, [
        { type: 'paragraph', content: 'New item' }
      ]);

      // Items should be added to the nested list
      expect(innerList.length).toBe(3);
      expect(helpers.getTextContent(innerList.get(2))).toBe('New item');

      // The outer structure should be unchanged
      expect(outerList.length).toBe(1);
      expect(outerItem.length).toBe(2); // paragraph + nested list
    });

    it('setParagraphs on a nested listItem should preserve sibling nested list', () => {
      // Build: bulletList > listItem > [paragraph("Parent"), bulletList > listItem > [paragraph("Original"), bulletList > ...]]
      const outerList = new Y.XmlElement('bulletList');
      const outerItem = new Y.XmlElement('listItem');
      const outerPara = new Y.XmlElement('paragraph');
      const outerText = new Y.XmlText();
      outerText.insert(0, 'Parent');
      outerPara.insert(0, [outerText]);
      outerItem.insert(0, [outerPara]);

      const innerList = new Y.XmlElement('bulletList');
      const innerItem = new Y.XmlElement('listItem');
      const innerPara = new Y.XmlElement('paragraph');
      const innerText = new Y.XmlText();
      innerText.insert(0, 'Original');
      innerPara.insert(0, [innerText]);

      // The inner listItem has both a paragraph and a deeper nested list
      const deeperList = new Y.XmlElement('bulletList');
      const deeperItem = new Y.XmlElement('listItem');
      const deeperPara = new Y.XmlElement('paragraph');
      const deeperText = new Y.XmlText();
      deeperText.insert(0, 'Deep child');
      deeperPara.insert(0, [deeperText]);
      deeperItem.insert(0, [deeperPara]);
      deeperList.insert(0, [deeperItem]);

      innerItem.insert(0, [innerPara, deeperList]);
      innerList.insert(0, [innerItem]);
      outerItem.insert(1, [innerList]);
      outerList.insert(0, [outerItem]);
      fragment.insert(0, [outerList]);

      // Update the inner listItem's paragraph text
      helpers.setParagraphs(innerItem, [['Updated']]);

      // Paragraph text should be updated
      expect(helpers.getTextContent(innerItem.get(0))).toBe('Updated');

      // The deeper nested list should still be intact
      expect(innerItem.length).toBe(2); // paragraph + deeperList
      expect(innerItem.get(1).nodeName).toBe('bulletList');
      expect(helpers.getTextContent(innerItem.get(1).get(0))).toBe('Deep child');
    });
  });
});
