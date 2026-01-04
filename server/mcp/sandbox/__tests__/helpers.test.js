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

      expect(helpers.getTextContent(list)).toBe('Item 1Item 2');
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
});
