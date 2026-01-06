/**
 * Tests for XPath query support in sandbox
 */
const Y = require('yjs');
const { xpath, xpathFirst, YjsNodeWrapper } = require('../mcp/sandbox/xpath');

describe('XPath module', () => {
  let doc;
  let fragment;

  beforeEach(() => {
    // Create a fresh document for each test
    doc = new Y.Doc();
    fragment = doc.get('test', Y.XmlFragment);
  });

  describe('YjsNodeWrapper', () => {
    it('should correctly identify XmlFragment as document node', () => {
      const wrapper = new YjsNodeWrapper(fragment);
      expect(wrapper.nodeType).toBe(9); // DOCUMENT_NODE
      expect(wrapper.nodeName).toBe('#document');
      expect(wrapper.localName).toBeNull();
    });

    it('should correctly identify XmlElement', () => {
      const element = new Y.XmlElement('heading');
      const wrapper = new YjsNodeWrapper(element);
      expect(wrapper.nodeType).toBe(1); // ELEMENT_NODE
      expect(wrapper.nodeName).toBe('heading');
      expect(wrapper.localName).toBe('heading');
    });

    it('should correctly identify XmlText', () => {
      const text = new Y.XmlText();
      text.insert(0, 'Hello');
      const wrapper = new YjsNodeWrapper(text);
      expect(wrapper.nodeType).toBe(3); // TEXT_NODE
      expect(wrapper.nodeName).toBe('#text');
      expect(wrapper.localName).toBeNull();
    });

    it('should cache and return wrapped children', () => {
      const h1 = new Y.XmlElement('heading');
      const h2 = new Y.XmlElement('heading');
      fragment.insert(0, [h1, h2]);

      const wrapper = new YjsNodeWrapper(fragment);
      const children1 = wrapper.getChildren();
      const children2 = wrapper.getChildren();

      expect(children1).toBe(children2); // Same array reference (cached)
      expect(children1.length).toBe(2);
      expect(children1[0].nodeName).toBe('heading');
    });

    it('should track parent references for children', () => {
      const h1 = new Y.XmlElement('heading');
      fragment.insert(0, [h1]);

      const wrapper = new YjsNodeWrapper(fragment);
      const children = wrapper.getChildren();

      expect(children[0]._parent).toBe(wrapper);
    });
  });

  describe('xpath()', () => {
    beforeEach(() => {
      // Set up a test document structure
      const h1 = new Y.XmlElement('heading');
      h1.setAttribute('level', 1);
      const h1Text = new Y.XmlText();
      h1Text.insert(0, 'Main Title');
      h1.insert(0, [h1Text]);

      const h2 = new Y.XmlElement('heading');
      h2.setAttribute('level', 2);
      const h2Text = new Y.XmlText();
      h2Text.insert(0, 'Section One');
      h2.insert(0, [h2Text]);

      const list = new Y.XmlElement('bulletList');
      const item = new Y.XmlElement('listItem');
      const itemPara = new Y.XmlElement('paragraph');
      const itemText = new Y.XmlText();
      itemText.insert(0, 'List item');
      itemPara.insert(0, [itemText]);
      item.insert(0, [itemPara]);
      list.insert(0, [item]);

      const para = new Y.XmlElement('paragraph');
      const paraText = new Y.XmlText();
      paraText.insert(0, 'This is a TODO item');
      para.insert(0, [paraText]);

      fragment.insert(0, [h1, h2, list, para]);
    });

    it('should find all elements by node name', () => {
      const headings = xpath('//heading', fragment);
      expect(headings.length).toBe(2);
      expect(headings[0]).toBeInstanceOf(Y.XmlElement);
      expect(headings[0].nodeName).toBe('heading');
    });

    it('should filter by attribute value', () => {
      const h1s = xpath('//heading[@level=1]', fragment);
      expect(h1s.length).toBe(1);
      expect(h1s[0].getAttribute('level')).toBe(1);

      const h2s = xpath('//heading[@level=2]', fragment);
      expect(h2s.length).toBe(1);
      expect(h2s[0].getAttribute('level')).toBe(2);
    });

    it('should filter by text content', () => {
      const todos = xpath('//paragraph[contains(., "TODO")]', fragment);
      expect(todos.length).toBe(1);
    });

    it('should find nested elements', () => {
      const listParas = xpath('//listItem/paragraph', fragment);
      expect(listParas.length).toBe(1);
    });

    it('should handle following-sibling axis', () => {
      const listsAfterHeading = xpath('//heading/following-sibling::bulletList', fragment);
      expect(listsAfterHeading.length).toBeGreaterThanOrEqual(1);
    });

    it('should return empty array for no matches', () => {
      const nonexistent = xpath('//nonexistent', fragment);
      expect(nonexistent).toEqual([]);
    });

    it('should return actual Yjs nodes (not wrappers)', () => {
      const headings = xpath('//heading', fragment);
      expect(headings[0]).toBeInstanceOf(Y.XmlElement);
      expect(typeof headings[0].getAttribute).toBe('function');
      expect(typeof headings[0].setAttribute).toBe('function');
    });

    it('should allow modifying returned nodes', () => {
      const headings = xpath('//heading[@level=1]', fragment);
      expect(headings.length).toBe(1);

      headings[0].setAttribute('level', 3);
      expect(headings[0].getAttribute('level')).toBe(3);

      // Verify the change persists in the document
      const updated = xpath('//heading[@level=3]', fragment);
      expect(updated.length).toBe(1);
    });
  });

  describe('xpathFirst()', () => {
    beforeEach(() => {
      const h1 = new Y.XmlElement('heading');
      h1.setAttribute('level', 1);
      const h2 = new Y.XmlElement('heading');
      h2.setAttribute('level', 2);
      fragment.insert(0, [h1, h2]);
    });

    it('should return first matching node', () => {
      const heading = xpathFirst('//heading', fragment);
      expect(heading).toBeInstanceOf(Y.XmlElement);
      expect(heading.getAttribute('level')).toBe(1);
    });

    it('should return null for no matches', () => {
      const result = xpathFirst('//nonexistent', fragment);
      expect(result).toBeNull();
    });

    it('should return actual Yjs node (not wrapper)', () => {
      const heading = xpathFirst('//heading', fragment);
      expect(heading).toBeInstanceOf(Y.XmlElement);
      expect(typeof heading.setAttribute).toBe('function');
    });
  });

  describe('attribute handling', () => {
    it('should handle numeric attribute values', () => {
      const h = new Y.XmlElement('heading');
      h.setAttribute('level', 2);
      fragment.insert(0, [h]);

      // Both string and number comparison should work
      const byNum = xpath('//heading[@level=2]', fragment);
      const byStr = xpath('//heading[@level="2"]', fragment);

      expect(byNum.length).toBe(1);
      expect(byStr.length).toBe(1);
    });

    it('should handle string attribute values', () => {
      const code = new Y.XmlElement('codeBlock');
      code.setAttribute('language', 'javascript');
      fragment.insert(0, [code]);

      const result = xpath('//codeBlock[@language="javascript"]', fragment);
      expect(result.length).toBe(1);
    });

    it('should handle attribute existence check', () => {
      const h1 = new Y.XmlElement('heading');
      h1.setAttribute('level', 1);
      const h2 = new Y.XmlElement('heading');
      // h2 has no level attribute
      fragment.insert(0, [h1, h2]);

      const withLevel = xpath('//heading[@level]', fragment);
      expect(withLevel.length).toBe(1);
    });
  });

  describe('text content queries', () => {
    it('should search text content with contains()', () => {
      const para = new Y.XmlElement('paragraph');
      const text = new Y.XmlText();
      text.insert(0, 'Hello World');
      para.insert(0, [text]);
      fragment.insert(0, [para]);

      const result = xpath('//paragraph[contains(., "World")]', fragment);
      expect(result.length).toBe(1);
    });

    it('should handle formatted text correctly', () => {
      const para = new Y.XmlElement('paragraph');
      const text = new Y.XmlText();
      text.insert(0, 'Plain and BOLD text');
      text.format(10, 4, { bold: true }); // Format "BOLD"
      para.insert(0, [text]);
      fragment.insert(0, [para]);

      // Should still find by text content despite formatting
      const result = xpath('//paragraph[contains(., "BOLD")]', fragment);
      expect(result.length).toBe(1);
    });
  });

  describe('sibling navigation', () => {
    beforeEach(() => {
      const h1 = new Y.XmlElement('heading');
      h1.setAttribute('level', 1);
      const para = new Y.XmlElement('paragraph');
      const list = new Y.XmlElement('bulletList');
      const h2 = new Y.XmlElement('heading');
      h2.setAttribute('level', 2);
      fragment.insert(0, [h1, para, list, h2]);
    });

    it('should find following siblings', () => {
      const result = xpath('//heading[@level=1]/following-sibling::paragraph', fragment);
      expect(result.length).toBe(1);
    });

    it('should find preceding siblings', () => {
      const result = xpath('//heading[@level=2]/preceding-sibling::bulletList', fragment);
      expect(result.length).toBe(1);
    });

    it('should limit sibling results with position predicate', () => {
      const result = xpath('//heading[@level=1]/following-sibling::*[1]', fragment);
      expect(result.length).toBe(1);
      expect(result[0].nodeName).toBe('paragraph');
    });
  });

  describe('error handling', () => {
    it('should throw on invalid XPath syntax', () => {
      expect(() => xpath('//[invalid', fragment)).toThrow();
    });
  });
});
