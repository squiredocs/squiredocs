/**
 * Tests for diff-service module
 */
const DiffService = require('../diff-service');
const { CACHE_VERSION } = require('../diff-service');
const Y = require('yjs');

// Mock redis module
jest.mock('../redis', () => ({
  getRedisClient: jest.fn(() => ({
    get: jest.fn().mockResolvedValue(null),
    setex: jest.fn().mockResolvedValue('OK'),
  })),
  isRedisEnabled: jest.fn(() => false),
}));

describe('DiffService', () => {
  let mockPool;
  let mockClient;
  let diffService;

  // Helper to create a Y.Doc with text content
  function createDocWithText(text) {
    const doc = new Y.Doc();
    const fragment = doc.getXmlFragment('default');
    doc.transact(() => {
      const paragraph = new Y.XmlElement('paragraph');
      const textContent = new Y.XmlText();
      textContent.insert(0, text);
      paragraph.insert(0, [textContent]);
      fragment.insert(0, [paragraph]);
    });
    return doc;
  }

  // Helper to create a Y.Doc with multiple paragraphs
  function createDocWithParagraphs(paragraphs) {
    const doc = new Y.Doc();
    const fragment = doc.getXmlFragment('default');
    doc.transact(() => {
      const elements = paragraphs.map(text => {
        const paragraph = new Y.XmlElement('paragraph');
        const textContent = new Y.XmlText();
        textContent.insert(0, text);
        paragraph.insert(0, [textContent]);
        return paragraph;
      });
      fragment.insert(0, elements);
    });
    return doc;
  }

  beforeEach(() => {
    mockClient = {
      query: jest.fn(),
      release: jest.fn(),
    };
    mockPool = {
      connect: jest.fn().mockResolvedValue(mockClient),
    };
    diffService = new DiffService(mockPool);
  });

  describe('extractText (shared yjs-utils)', () => {
    const { extractText } = require('../yjs-utils');

    test('extracts text from Y.Doc', () => {
      const doc = createDocWithText('Hello world');
      const text = extractText(doc);
      expect(text).toBe('Hello world');
      doc.destroy();
    });

    test('extracts text from multiple paragraphs', () => {
      const doc = createDocWithParagraphs(['First paragraph', 'Second paragraph']);
      const text = extractText(doc);
      expect(text).toContain('First paragraph');
      expect(text).toContain('Second paragraph');
      doc.destroy();
    });

    test('handles empty document', () => {
      const doc = new Y.Doc();
      const text = extractText(doc);
      expect(text).toBe('');
      doc.destroy();
    });
  });

  describe('buildDocsAtClocks', () => {
    test('builds two docs at different clock positions', () => {
      // Create updates for two clock positions
      const doc1 = createDocWithText('First');
      const update1 = Y.encodeStateAsUpdate(doc1);

      const doc2 = new Y.Doc();
      Y.applyUpdate(doc2, update1);
      doc2.transact(() => {
        const fragment = doc2.getXmlFragment('default');
        const paragraph = new Y.XmlElement('paragraph');
        const textContent = new Y.XmlText();
        textContent.insert(0, 'Second');
        paragraph.insert(0, [textContent]);
        fragment.insert(fragment.length, [paragraph]);
      });
      const update2 = Y.encodeStateAsUpdate(doc2, Y.encodeStateVector(doc1));

      const updates = [
        { clock: 0, update_data: Buffer.from(update1) },
        { clock: 1, update_data: Buffer.from(update2) },
      ];

      const { prevDoc, currDoc, prevText, currText } = diffService.buildDocsAtClocks(updates, 0, 1);

      expect(prevText).toBe('First');
      expect(currText).toContain('First');
      expect(currText).toContain('Second');

      prevDoc.destroy();
      currDoc.destroy();
      doc1.destroy();
      doc2.destroy();
    });

    test('handles previousClock=-1 for initial state comparison', () => {
      const doc = createDocWithText('Initial content');
      const update = Y.encodeStateAsUpdate(doc);

      const updates = [{ clock: 0, update_data: Buffer.from(update) }];

      const { prevDoc, currDoc, prevText, currText } = diffService.buildDocsAtClocks(updates, -1, 0);

      // Previous should be empty (no updates applied)
      expect(prevText).toBe('');
      // Current should have the content
      expect(currText).toBe('Initial content');

      prevDoc.destroy();
      currDoc.destroy();
      doc.destroy();
    });
  });

  describe('yDocToProseMirror', () => {
    test('converts Y.Doc to ProseMirror document', () => {
      const yDoc = createDocWithText('Hello ProseMirror');
      const pmDoc = diffService.yDocToProseMirror(yDoc);

      expect(pmDoc).not.toBeNull();
      expect(pmDoc.type.name).toBe('doc');
      expect(pmDoc.content.size).toBeGreaterThan(0);

      yDoc.destroy();
    });

    test('handles empty Y.Doc', () => {
      const yDoc = new Y.Doc();
      const pmDoc = diffService.yDocToProseMirror(yDoc);

      expect(pmDoc).not.toBeNull();
      expect(pmDoc.type.name).toBe('doc');

      yDoc.destroy();
    });
  });



  describe('computeMarkdownDiff — formatting changes', () => {
    // Helper to create a Y.Doc with a heading, a paragraph, and a blockquote
    function createFormattedDoc({ headingStyle, paraStyle, paraItalic, blockquoteStyle }) {
      const doc = new Y.Doc();
      const fragment = doc.getXmlFragment('default');
      doc.transact(() => {
        // Heading
        const heading = new Y.XmlElement('heading');
        heading.setAttribute('level', '1');
        const headingText = new Y.XmlText();
        const headingAttrs = headingStyle ? { textStyle: headingStyle } : {};
        headingText.insert(0, 'Bug Report', headingAttrs);
        heading.insert(0, [headingText]);

        // Paragraph
        const para = new Y.XmlElement('paragraph');
        const paraText = new Y.XmlText();
        const paraAttrs = {};
        if (paraStyle) paraAttrs.textStyle = paraStyle;
        if (paraItalic) paraAttrs.italic = true;
        paraText.insert(0, 'This report documents an incident.', paraAttrs);
        para.insert(0, [paraText]);

        // Blockquote > paragraph
        const bq = new Y.XmlElement('blockquote');
        const bqPara = new Y.XmlElement('paragraph');
        const bqText = new Y.XmlText();
        const bqAttrs = blockquoteStyle ? { textStyle: blockquoteStyle } : {};
        bqText.insert(0, 'Overall, this addresses the risk.', bqAttrs);
        bqPara.insert(0, [bqText]);
        bq.insert(0, [bqPara]);

        fragment.insert(0, [heading, para, bq]);
      });
      return doc;
    }

    test('detects formatting-only changes and preserves textStyle in diff marks', () => {
      // Before: plain text
      const prevDoc = createFormattedDoc({});
      // After: styled text (font-size, line-height, font-family, color)
      const currDoc = createFormattedDoc({
        headingStyle: { color: '#1e293b', fontFamily: 'Georgia', fontSize: '32px' },
        paraStyle: { fontSize: '17px', lineHeight: '1.6' },
        paraItalic: true,
        blockquoteStyle: { fontSize: '17px', lineHeight: '1.6' },
      });

      const result = diffService.computeMarkdownDiff(prevDoc, currDoc, false);

      // Should produce a valid doc
      expect(result.type).toBe('doc');
      expect(result.content.length).toBeGreaterThan(0);

      // Stringify to check for marks
      const json = JSON.stringify(result);
      expect(json).toContain('diffDelete');
      expect(json).toContain('diffInsert');

      // The inserted heading should have textStyle with all attrs preserved
      const insertedBlocks = result.content.filter(
        block => JSON.stringify(block).includes('diffInsert')
      );
      expect(insertedBlocks.length).toBeGreaterThan(0);

      // Find a text node with textStyle mark containing fontSize
      const allTextNodes = JSON.stringify(insertedBlocks);
      expect(allTextNodes).toContain('"fontSize"');
      expect(allTextNodes).toContain('"fontFamily"');
      expect(allTextNodes).toContain('"color"');
      // lineHeight must survive the round-trip
      expect(allTextNodes).toContain('"lineHeight"');

      prevDoc.destroy();
      currDoc.destroy();
    });

    test('formatting-only change detected via formattingOnly flag', async () => {
      // Same text, different formatting — the text (tags stripped) is identical
      // but the XML differs, so formattingOnly should be true
      const prevDoc = createFormattedDoc({});
      const currDoc = createFormattedDoc({
        blockquoteStyle: { fontSize: '17px' },
      });

      const { extractText } = require('../yjs-utils');
      const textIdentical = extractText(prevDoc) === extractText(currDoc);
      expect(textIdentical).toBe(true);

      const { extractXml } = require('../yjs-utils');
      const xmlDiffers = extractXml(prevDoc) !== extractXml(currDoc);
      expect(xmlDiffers).toBe(true);

      // The diff should still produce diffInsert/diffDelete for the changed blockquote
      const result = diffService.computeMarkdownDiff(prevDoc, currDoc, textIdentical);
      const json = JSON.stringify(result);
      expect(json).toContain('diffInsert');
      expect(json).toContain('diffDelete');

      prevDoc.destroy();
      currDoc.destroy();
    });

    test('lineHeight survives markdown round-trip', () => {
      const { markdownToPm } = require('../markdown-to-pm');
      const { toMarkdown } = require('../mcp/yjs/serialization');

      // Create a doc with lineHeight
      const doc = createFormattedDoc({
        paraStyle: { fontSize: '17px', lineHeight: '1.6' },
      });

      const fragment = doc.get('default', Y.XmlFragment);
      const md = toMarkdown(fragment);

      // Markdown should include line-height
      expect(md).toContain('line-height:1.6');

      // Round-trip through markdownToPm
      const pmJson = markdownToPm(md, null);
      const pmStr = JSON.stringify(pmJson);
      expect(pmStr).toContain('"lineHeight":"1.6"');
      expect(pmStr).toContain('"fontSize":"17px"');

      doc.destroy();
    });
  });

  describe('computeDiff', () => {
    test('computes diff for document with changes', async () => {
      // Create initial document
      const doc1 = createDocWithText('Initial content');
      const update1 = Y.encodeStateAsUpdate(doc1);

      // Create modified document
      const doc2 = createDocWithText('Modified content');
      const update2 = Y.encodeStateAsUpdate(doc2);

      // Mock database query to return updates
      mockClient.query.mockResolvedValue({
        rows: [
          { clock: 0, update_data: Buffer.from(update1) },
          { clock: 1, update_data: Buffer.from(update2) },
        ],
      });

      const result = await diffService.computeDiff('test-doc', 0, 1);

      expect(result).toHaveProperty('document');
      expect(result).toHaveProperty('currentDocument');
      expect(result).toHaveProperty('meta');
      expect(result.meta.previousClock).toBe(0);
      expect(result.meta.currentClock).toBe(1);
      expect(result.document.type).toBe('doc');

      doc1.destroy();
      doc2.destroy();
    });

    test('sets textIdentical=true when text is the same', async () => {
      // Create document
      const doc = createDocWithText('Same content');
      const update = Y.encodeStateAsUpdate(doc);

      // Mock database query - same update for both clocks
      mockClient.query.mockResolvedValue({
        rows: [
          { clock: 0, update_data: Buffer.from(update) },
        ],
      });

      const result = await diffService.computeDiff('test-doc', 0, 0);

      expect(result.meta.textIdentical).toBe(true);

      doc.destroy();
    });

    test('handles initial state comparison (previousClock=-1)', async () => {
      const doc = createDocWithText('First content');
      const update = Y.encodeStateAsUpdate(doc);

      mockClient.query.mockResolvedValue({
        rows: [{ clock: 0, update_data: Buffer.from(update) }],
      });

      const result = await diffService.computeDiff('test-doc', -1, 0);

      expect(result.meta.previousClock).toBe(-1);
      expect(result.meta.currentClock).toBe(0);
      // Insertions are baked into the document as diffInsert marks
      const docJson = JSON.stringify(result.document);
      expect(docJson).toContain('diffInsert');

      doc.destroy();
    });

    test('returns document JSON that can be used by ProseMirror', async () => {
      const doc = createDocWithText('Test document');
      const update = Y.encodeStateAsUpdate(doc);

      mockClient.query.mockResolvedValue({
        rows: [{ clock: 0, update_data: Buffer.from(update) }],
      });

      const result = await diffService.computeDiff('test-doc', -1, 0);

      // Verify document structure
      expect(result.document).toMatchObject({
        type: 'doc',
        content: expect.any(Array),
      });
      expect(result.document.content.length).toBeGreaterThan(0);
      expect(result.document.content[0].type).toBe('paragraph');

      doc.destroy();
    });
  });

  describe('caching', () => {
    test('uses cached result when available', async () => {
      const { isRedisEnabled, getRedisClient } = require('../redis');
      isRedisEnabled.mockReturnValue(true);

      const cachedResult = {
        document: { type: 'doc', content: [] },
        changes: [],
        meta: { previousClock: 0, currentClock: 1, textIdentical: false },
      };

      getRedisClient.mockReturnValue({
        get: jest.fn().mockResolvedValue(JSON.stringify(cachedResult)),
        setex: jest.fn(),
      });

      const result = await diffService.computeDiff('test-doc', 0, 1);

      expect(result).toEqual(cachedResult);
      // Should not have queried database
      expect(mockClient.query).not.toHaveBeenCalled();
    });

    test('caches computed result', async () => {
      const { isRedisEnabled, getRedisClient } = require('../redis');
      isRedisEnabled.mockReturnValue(true);

      const mockSetex = jest.fn().mockResolvedValue('OK');
      getRedisClient.mockReturnValue({
        get: jest.fn().mockResolvedValue(null),
        setex: mockSetex,
      });

      const doc = createDocWithText('Test');
      const update = Y.encodeStateAsUpdate(doc);

      mockClient.query.mockResolvedValue({
        rows: [{ clock: 0, update_data: Buffer.from(update) }],
      });

      await diffService.computeDiff('test-doc', -1, 0);

      expect(mockSetex).toHaveBeenCalledWith(
        `diff${CACHE_VERSION}:test-doc:-1:0`,
        3600,
        expect.any(String)
      );

      doc.destroy();
    });
  });
});
