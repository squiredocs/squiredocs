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

  describe('table cell attributes', () => {
    it('should serialize table cells with colspan and rowspan', () => {
      const doc = new Y.Doc();
      const fragment = doc.get('default', Y.XmlFragment);

      const table = new Y.XmlElement('table');
      const row = new Y.XmlElement('tableRow');

      // Cell with colspan
      const cell1 = new Y.XmlElement('tableHeader');
      cell1.setAttribute('colspan', 2);
      cell1.setAttribute('rowspan', 1);
      cell1.setAttribute('colwidth', null);
      const p1 = new Y.XmlElement('paragraph');
      const t1 = new Y.XmlText();
      t1.insert(0, 'Merged Header');
      p1.insert(0, [t1]);
      cell1.insert(0, [p1]);

      // Normal cell
      const cell2 = new Y.XmlElement('tableHeader');
      cell2.setAttribute('colspan', 1);
      cell2.setAttribute('rowspan', 1);
      cell2.setAttribute('colwidth', null);
      const p2 = new Y.XmlElement('paragraph');
      const t2 = new Y.XmlText();
      t2.insert(0, 'Normal');
      p2.insert(0, [t2]);
      cell2.insert(0, [p2]);

      row.insert(0, [cell1, cell2]);
      table.insert(0, [row]);
      fragment.insert(0, [table]);

      const result = toStructuredNode(table);

      expect(result.type).toBe('table');
      expect(result.children[0].type).toBe('tableRow');
      expect(result.children[0].children[0]).toMatchObject({
        type: 'tableHeader',
        colspan: 2,
        rowspan: 1,
        content: 'Merged Header'
      });
      expect(result.children[0].children[1]).toMatchObject({
        type: 'tableHeader',
        colspan: 1,
        rowspan: 1,
        content: 'Normal'
      });
    });

    it('should serialize table cells with colwidth', () => {
      const doc = new Y.Doc();
      const fragment = doc.get('default', Y.XmlFragment);

      const table = new Y.XmlElement('table');
      const row = new Y.XmlElement('tableRow');

      const cell = new Y.XmlElement('tableCell');
      cell.setAttribute('colspan', 1);
      cell.setAttribute('rowspan', 1);
      cell.setAttribute('colwidth', [150]); // Column width in pixels
      const p = new Y.XmlElement('paragraph');
      const t = new Y.XmlText();
      t.insert(0, 'Wide cell');
      p.insert(0, [t]);
      cell.insert(0, [p]);

      row.insert(0, [cell]);
      table.insert(0, [row]);
      fragment.insert(0, [table]);

      const result = toStructuredNode(table);

      expect(result.children[0].children[0]).toMatchObject({
        type: 'tableCell',
        colspan: 1,
        rowspan: 1,
        colwidth: [150],
        content: 'Wide cell'
      });
    });

    it('should serialize table cells with multiple column widths', () => {
      const doc = new Y.Doc();
      const fragment = doc.get('default', Y.XmlFragment);

      const table = new Y.XmlElement('table');
      const row = new Y.XmlElement('tableRow');

      // Cell spanning multiple columns with different widths
      const cell = new Y.XmlElement('tableCell');
      cell.setAttribute('colspan', 3);
      cell.setAttribute('rowspan', 1);
      cell.setAttribute('colwidth', [100, 150, 200]); // Different width for each spanned column
      const p = new Y.XmlElement('paragraph');
      const t = new Y.XmlText();
      t.insert(0, 'Multi-column cell');
      p.insert(0, [t]);
      cell.insert(0, [p]);

      row.insert(0, [cell]);
      table.insert(0, [row]);
      fragment.insert(0, [table]);

      const result = toStructuredNode(table);

      expect(result.children[0].children[0]).toMatchObject({
        type: 'tableCell',
        colspan: 3,
        rowspan: 1,
        colwidth: [100, 150, 200],
        content: 'Multi-column cell'
      });
    });
  });

  describe('horizontalRule serialization', () => {
    it('should serialize horizontalRule without children', () => {
      const doc = new Y.Doc();
      const fragment = doc.get('default', Y.XmlFragment);

      const hr = new Y.XmlElement('horizontalRule');
      fragment.insert(0, [hr]);

      const result = toStructuredNode(hr);

      expect(result).toEqual({
        type: 'horizontalRule'
      });
      expect(result.children).toBeUndefined();
    });

    it('should serialize horizontalRule ignoring empty text children', () => {
      const doc = new Y.Doc();
      const fragment = doc.get('default', Y.XmlFragment);

      const hr = new Y.XmlElement('horizontalRule');
      // Simulate what TipTap might do - add an empty text node
      const emptyText = new Y.XmlText();
      hr.insert(0, [emptyText]);
      fragment.insert(0, [hr]);

      const result = toStructuredNode(hr);

      // Should filter out empty text children for void elements
      expect(result).toEqual({
        type: 'horizontalRule'
      });
      expect(result.children).toBeUndefined();
    });
  });
});
