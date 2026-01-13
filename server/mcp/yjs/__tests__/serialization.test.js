/**
 * Serialization Tests
 */

const Y = require('yjs');
const {
  toStructuredNode,
  extractTextWithMarks,
  toStructured,
} = require('../serialization');

describe('Serialization', () => {
  describe('extractTextWithMarks', () => {
    it('should extract textStyle marks (color)', () => {
      const doc = new Y.Doc();
      const fragment = doc.get('default', Y.XmlFragment);

      const para = new Y.XmlElement('paragraph');
      const text = new Y.XmlText();
      text.insert(0, 'Red text');
      text.format(0, 8, { textStyle: { color: '#dc2626' } });
      para.insert(0, [text]);
      fragment.insert(0, [para]);

      const result = extractTextWithMarks(text);

      expect(result).toEqual([
        {
          text: 'Red text',
          marks: [{ type: 'textStyle', color: '#dc2626' }]
        }
      ]);
    });

    it('should extract textStyle marks with multiple properties', () => {
      const doc = new Y.Doc();
      const fragment = doc.get('default', Y.XmlFragment);

      const para = new Y.XmlElement('paragraph');
      const text = new Y.XmlText();
      text.insert(0, 'Styled text');
      text.format(0, 11, {
        textStyle: { color: '#ff0000', fontSize: '18px', fontFamily: 'Georgia' }
      });
      para.insert(0, [text]);
      fragment.insert(0, [para]);

      const result = extractTextWithMarks(text);

      expect(result).toEqual([
        {
          text: 'Styled text',
          marks: [
            {
              type: 'textStyle',
              color: '#ff0000',
              fontSize: '18px',
              fontFamily: 'Georgia'
            }
          ]
        }
      ]);
    });

    it('should extract textStyle combined with other marks', () => {
      const doc = new Y.Doc();
      const fragment = doc.get('default', Y.XmlFragment);

      const para = new Y.XmlElement('paragraph');
      const text = new Y.XmlText();
      text.insert(0, 'Bold red text');
      text.format(0, 13, {
        bold: true,
        textStyle: { color: '#dc2626' }
      });
      para.insert(0, [text]);
      fragment.insert(0, [para]);

      const result = extractTextWithMarks(text);

      expect(result).toEqual([
        {
          text: 'Bold red text',
          marks: ['bold', { type: 'textStyle', color: '#dc2626' }]
        }
      ]);
    });

    it('should extract subscript and superscript marks', () => {
      const doc = new Y.Doc();
      const fragment = doc.get('default', Y.XmlFragment);

      const para = new Y.XmlElement('paragraph');
      const text = new Y.XmlText();
      text.insert(0, 'H2O and x2');
      text.format(1, 1, { subscript: true });
      text.format(9, 1, { superscript: true });
      para.insert(0, [text]);
      fragment.insert(0, [para]);

      const result = extractTextWithMarks(text);

      expect(result).toEqual([
        'H',
        { text: '2', marks: ['subscript'] },
        'O and x',
        { text: '2', marks: ['superscript'] }
      ]);
    });

    it('should extract code mark', () => {
      const doc = new Y.Doc();
      const fragment = doc.get('default', Y.XmlFragment);

      const para = new Y.XmlElement('paragraph');
      const text = new Y.XmlText();
      text.insert(0, 'The variable foo is undefined');
      text.format(13, 3, { code: true });
      para.insert(0, [text]);
      fragment.insert(0, [para]);

      const result = extractTextWithMarks(text);

      expect(result).toEqual([
        'The variable ',
        { text: 'foo', marks: ['code'] },
        ' is undefined'
      ]);
    });
  });

  describe('toStructuredNode', () => {
    it('should serialize paragraph with textStyle marks', () => {
      const doc = new Y.Doc();
      const fragment = doc.get('default', Y.XmlFragment);

      const para = new Y.XmlElement('paragraph');
      const text = new Y.XmlText();
      text.insert(0, 'Red text');
      text.format(0, 8, { textStyle: { color: '#dc2626' } });
      para.insert(0, [text]);
      fragment.insert(0, [para]);

      const result = toStructuredNode(para);

      expect(result).toEqual({
        type: 'paragraph',
        content: [
          {
            text: 'Red text',
            marks: [{ type: 'textStyle', color: '#dc2626' }]
          }
        ]
      });
    });

    it('should serialize paragraph with mixed marks including textStyle', () => {
      const doc = new Y.Doc();
      const fragment = doc.get('default', Y.XmlFragment);

      const para = new Y.XmlElement('paragraph');
      const text = new Y.XmlText();
      text.insert(0, 'Plain bold red plain');
      text.format(6, 9, { bold: true, textStyle: { color: '#dc2626' } });
      para.insert(0, [text]);
      fragment.insert(0, [para]);

      const result = toStructuredNode(para);

      expect(result).toEqual({
        type: 'paragraph',
        content: [
          'Plain ',
          {
            text: 'bold red ',
            marks: ['bold', { type: 'textStyle', color: '#dc2626' }]
          },
          'plain'
        ]
      });
    });
  });

  describe('toStructured (fragment-level)', () => {
    it('should serialize document with textStyle marks', () => {
      const doc = new Y.Doc();
      const fragment = doc.get('default', Y.XmlFragment);

      const para = new Y.XmlElement('paragraph');
      const text = new Y.XmlText();
      text.insert(0, 'Red and blue');
      text.format(0, 3, { textStyle: { color: '#dc2626' } });
      text.format(8, 4, { textStyle: { color: '#2563eb' } });
      para.insert(0, [text]);
      fragment.insert(0, [para]);

      const result = toStructured(fragment);

      expect(result).toEqual([
        {
          type: 'paragraph',
          content: [
            {
              text: 'Red',
              marks: [{ type: 'textStyle', color: '#dc2626' }]
            },
            ' and ',
            {
              text: 'blue',
              marks: [{ type: 'textStyle', color: '#2563eb' }]
            }
          ]
        }
      ]);
    });
  });
});
