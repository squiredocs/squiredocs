/**
 * Tests for compare_document_versions tool
 * Covers helper functions, version loading, and script execution
 */

const Y = require('yjs');
const helpers = require('../../sandbox/helpers');
const { executeComparisonScript } = require('../../sandbox');

describe('compare_document_versions helper functions', () => {
  let doc;

  beforeEach(() => {
    // Create a test document with content
    doc = new Y.Doc();
    const fragment = doc.get('default', Y.XmlFragment);

    // Add a heading
    const heading = new Y.XmlElement('heading');
    heading.setAttribute('level', '1');
    const headingText = new Y.XmlText();
    headingText.insert(0, 'Test Document');
    heading.insert(0, [headingText]);
    fragment.insert(0, [heading]);

    // Add a paragraph
    const paragraph = new Y.XmlElement('paragraph');
    const paraText = new Y.XmlText();
    paraText.insert(0, 'This is a test paragraph with some words.');
    paragraph.insert(0, [paraText]);
    fragment.insert(1, [paragraph]);

    // Add a link
    const linkPara = new Y.XmlElement('paragraph');
    const linkText = new Y.XmlText();
    linkText.insert(0, 'Click here');
    linkText.format(0, 10, { link: { href: 'https://example.com' } });
    linkPara.insert(0, [linkText]);
    fragment.insert(2, [linkPara]);
  });

  describe('extractPlainText / getTextContent', () => {
    test('extracts text from Y.XmlFragment', () => {
      const fragment = doc.get('default', Y.XmlFragment);
      const text = helpers.extractPlainText(fragment);

      expect(text).toContain('Test Document');
      expect(text).toContain('This is a test paragraph');
      expect(text).toContain('Click here');
    });

    test('returns non-empty string for document with content', () => {
      const fragment = doc.get('default', Y.XmlFragment);
      const text = helpers.extractPlainText(fragment);

      expect(text.length).toBeGreaterThan(0);
      expect(text).not.toBe('');
    });

    test('handles empty fragment', () => {
      const emptyDoc = new Y.Doc();
      const emptyFragment = emptyDoc.get('default', Y.XmlFragment);
      const text = helpers.extractPlainText(emptyFragment);

      expect(text).toBe('');
    });

    test('separates blocks with newlines to prevent word merging', () => {
      // Create a document with multiple blocks
      const testDoc = new Y.Doc();
      const fragment = testDoc.get('default', Y.XmlFragment);

      // Add heading
      const heading = new Y.XmlElement('heading');
      heading.setAttribute('level', '1');
      const headingText = new Y.XmlText();
      headingText.insert(0, 'Europe Trip');
      heading.insert(0, [headingText]);
      fragment.insert(0, [heading]);

      // Add first paragraph
      const para1 = new Y.XmlElement('paragraph');
      const para1Text = new Y.XmlText();
      para1Text.insert(0, 'Summer 2024');
      para1.insert(0, [para1Text]);
      fragment.insert(1, [para1]);

      // Add second paragraph
      const para2 = new Y.XmlElement('paragraph');
      const para2Text = new Y.XmlText();
      para2Text.insert(0, 'TRAVEL TO EUROPE');
      para2.insert(0, [para2Text]);
      fragment.insert(2, [para2]);

      const text = helpers.extractPlainText(fragment);

      // Should have newlines between blocks
      expect(text).toBe('Europe Trip\nSummer 2024\nTRAVEL TO EUROPE');

      // Should NOT merge words at boundaries
      expect(text).not.toContain('2024TRAVEL');
      expect(text).toContain('2024\nTRAVEL');
    });

    test('inline elements do not add separators', () => {
      // Create a paragraph with inline formatting
      const testDoc = new Y.Doc();
      const fragment = testDoc.get('default', Y.XmlFragment);
      const para = new Y.XmlElement('paragraph');
      const text = new Y.XmlText();
      text.insert(0, 'This is ');
      text.insert(8, 'bold', { bold: true });
      text.insert(12, ' text');
      para.insert(0, [text]);
      fragment.insert(0, [para]);

      const extracted = helpers.extractPlainText(fragment);

      // Should NOT have extra separators within the paragraph
      expect(extracted).toBe('This is bold text');
    });
  });

  describe('getWordCount', () => {
    test('returns correct word count for document', () => {
      const fragment = doc.get('default', Y.XmlFragment);
      const count = helpers.getWordCount(fragment);

      // With newlines between blocks:
      // "Test Document" (2) + "This is a test paragraph with some words." (8) + "Click here" (2) = 12
      expect(count).toBe(12);
    });

    test('returns 0 for empty document', () => {
      const emptyDoc = new Y.Doc();
      const emptyFragment = emptyDoc.get('default', Y.XmlFragment);
      const count = helpers.getWordCount(emptyFragment);

      expect(count).toBe(0);
    });
  });

  describe('getCharacterCount', () => {
    test('returns correct character count for document', () => {
      const fragment = doc.get('default', Y.XmlFragment);
      const count = helpers.getCharacterCount(fragment);

      // Should count all characters including spaces
      expect(count).toBeGreaterThan(0);
      const text = helpers.extractPlainText(fragment);
      expect(count).toBe(text.length);
    });

    test('returns 0 for empty document', () => {
      const emptyDoc = new Y.Doc();
      const emptyFragment = emptyDoc.get('default', Y.XmlFragment);
      const count = helpers.getCharacterCount(emptyFragment);

      expect(count).toBe(0);
    });
  });

  describe('getBlockCount', () => {
    test('returns correct block count', () => {
      const fragment = doc.get('default', Y.XmlFragment);
      const count = helpers.getBlockCount(fragment);

      // We added 3 blocks: heading, paragraph, paragraph with link
      expect(count).toBe(3);
    });

    test('returns 0 for empty document', () => {
      const emptyDoc = new Y.Doc();
      const emptyFragment = emptyDoc.get('default', Y.XmlFragment);
      const count = helpers.getBlockCount(emptyFragment);

      expect(count).toBe(0);
    });
  });

  describe('extractLinks', () => {
    test('extracts links from document', () => {
      const fragment = doc.get('default', Y.XmlFragment);
      const links = helpers.extractLinks(fragment);

      expect(links).toHaveLength(1);
      expect(links[0]).toEqual({
        text: 'Click here',
        href: 'https://example.com'
      });
    });

    test('returns empty array for document without links', () => {
      const noLinkDoc = new Y.Doc();
      const fragment = noLinkDoc.get('default', Y.XmlFragment);
      const paragraph = new Y.XmlElement('paragraph');
      const text = new Y.XmlText();
      text.insert(0, 'No links here');
      paragraph.insert(0, [text]);
      fragment.insert(0, [paragraph]);

      const links = helpers.extractLinks(fragment);
      expect(links).toHaveLength(0);
    });
  });

  describe('getElementByType', () => {
    test('finds elements by type', () => {
      const fragment = doc.get('default', Y.XmlFragment);
      const headings = helpers.getElementByType(fragment, 'heading');

      expect(headings).toHaveLength(1);
      expect(headings[0].nodeName).toBe('heading');
    });

    test('finds multiple elements of same type', () => {
      const fragment = doc.get('default', Y.XmlFragment);
      const paragraphs = helpers.getElementByType(fragment, 'paragraph');

      expect(paragraphs).toHaveLength(2);
    });

    test('returns empty array for non-existent type', () => {
      const fragment = doc.get('default', Y.XmlFragment);
      const codeBlocks = helpers.getElementByType(fragment, 'codeBlock');

      expect(codeBlocks).toHaveLength(0);
    });
  });

  describe('getAttributes', () => {
    test('gets element attributes', () => {
      const fragment = doc.get('default', Y.XmlFragment);
      const heading = fragment.get(0);
      const attrs = helpers.getAttributes(heading);

      expect(attrs).toHaveProperty('level', '1');
    });

    test('returns empty object for element without attributes', () => {
      const fragment = doc.get('default', Y.XmlFragment);
      const paragraph = fragment.get(1);
      const attrs = helpers.getAttributes(paragraph);

      expect(attrs).toEqual({});
    });
  });

  describe('hasAttribute', () => {
    test('checks if element has attribute', () => {
      const fragment = doc.get('default', Y.XmlFragment);
      const heading = fragment.get(0);

      expect(helpers.hasAttribute(heading, 'level')).toBe(true);
      expect(helpers.hasAttribute(heading, 'nonexistent')).toBe(false);
    });

    test('checks attribute with specific value', () => {
      const fragment = doc.get('default', Y.XmlFragment);
      const heading = fragment.get(0);

      expect(helpers.hasAttribute(heading, 'level', '1')).toBe(true);
      expect(helpers.hasAttribute(heading, 'level', '2')).toBe(false);
    });
  });
});

describe('executeComparisonScript', () => {
  let doc1, doc2;

  beforeEach(() => {
    // Create doc1
    doc1 = new Y.Doc();
    const fragment1 = doc1.get('default', Y.XmlFragment);
    const heading1 = new Y.XmlElement('heading');
    heading1.setAttribute('level', '1');
    const headingText1 = new Y.XmlText();
    headingText1.insert(0, 'Original Title');
    heading1.insert(0, [headingText1]);
    fragment1.insert(0, [heading1]);

    // Create doc2 with modified content
    doc2 = new Y.Doc();
    const fragment2 = doc2.get('default', Y.XmlFragment);
    const heading2 = new Y.XmlElement('heading');
    heading2.setAttribute('level', '1');
    const headingText2 = new Y.XmlText();
    headingText2.insert(0, 'Updated Title');
    heading2.insert(0, [headingText2]);
    fragment2.insert(0, [heading2]);

    const paragraph = new Y.XmlElement('paragraph');
    const paraText = new Y.XmlText();
    paraText.insert(0, 'New paragraph added');
    paragraph.insert(0, [paraText]);
    fragment2.insert(1, [paragraph]);
  });

  test('executes simple comparison script', async () => {
    const script = `
      export default function compare(doc1, doc2) {
        return {
          blocks1: getBlockCount(doc1),
          blocks2: getBlockCount(doc2),
          added: getBlockCount(doc2) - getBlockCount(doc1)
        };
      }
    `;

    const result = await executeComparisonScript(
      script,
      doc1.get('default', Y.XmlFragment),
      doc2.get('default', Y.XmlFragment)
    );

    expect(result).toEqual({
      blocks1: 1,
      blocks2: 2,
      added: 1
    });
  });

  test('extracts text correctly', async () => {
    const script = `
      export default function compare(doc1, doc2) {
        return {
          text1: extractPlainText(doc1),
          text2: extractPlainText(doc2)
        };
      }
    `;

    const result = await executeComparisonScript(
      script,
      doc1.get('default', Y.XmlFragment),
      doc2.get('default', Y.XmlFragment)
    );

    expect(result.text1).toContain('Original Title');
    expect(result.text2).toContain('Updated Title');
    expect(result.text2).toContain('New paragraph added');
  });

  test('xpath works with correct parameter order', async () => {
    const script = `
      export default function compare(doc1, doc2) {
        const headings1 = xpath('//heading[@level="1"]', doc1);
        const headings2 = xpath('//heading[@level="1"]', doc2);

        return {
          count1: headings1.length,
          count2: headings2.length,
          title1: extractPlainText(headings1[0]),
          title2: extractPlainText(headings2[0])
        };
      }
    `;

    const result = await executeComparisonScript(
      script,
      doc1.get('default', Y.XmlFragment),
      doc2.get('default', Y.XmlFragment)
    );

    expect(result).toEqual({
      count1: 1,
      count2: 1,
      title1: 'Original Title',
      title2: 'Updated Title'
    });
  });

  test('xpath throws helpful error when context is missing', async () => {
    const script = `
      export default function compare(doc1, doc2) {
        // Incorrect: missing context node
        const headings = xpath('//heading');
        return { count: headings.length };
      }
    `;

    await expect(
      executeComparisonScript(
        script,
        doc1.get('default', Y.XmlFragment),
        doc2.get('default', Y.XmlFragment)
      )
    ).rejects.toThrow('requires a context node');
  });

  test('counts words correctly', async () => {
    const script = `
      export default function compare(doc1, doc2) {
        return {
          words1: getWordCount(doc1),
          words2: getWordCount(doc2),
          wordsAdded: getWordCount(doc2) - getWordCount(doc1)
        };
      }
    `;

    const result = await executeComparisonScript(
      script,
      doc1.get('default', Y.XmlFragment),
      doc2.get('default', Y.XmlFragment)
    );

    // doc1: "Original Title" = 2 words
    // doc2: "Updated Title" (2) + "New paragraph added" (3) = 5 words
    // With newlines between blocks, word count is accurate
    expect(result.words1).toBe(2);
    expect(result.words2).toBe(5);
    expect(result.wordsAdded).toBe(3);
  });

  test('script timeout works', async () => {
    const script = `
      export default function compare(doc1, doc2) {
        while (true) {} // Infinite loop
        return {};
      }
    `;

    await expect(
      executeComparisonScript(
        script,
        doc1.get('default', Y.XmlFragment),
        doc2.get('default', Y.XmlFragment),
        { timeout: 100 }
      )
    ).rejects.toThrow('timed out');
  });
});
