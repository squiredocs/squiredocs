/**
 * Tests for diff-service module
 */
const DiffService = require('../diff-service');
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

  describe('extractText', () => {
    test('extracts text from Y.Doc', () => {
      const doc = createDocWithText('Hello world');
      const text = diffService.extractText(doc);
      expect(text).toBe('Hello world');
      doc.destroy();
    });

    test('extracts text from multiple paragraphs', () => {
      const doc = createDocWithParagraphs(['First paragraph', 'Second paragraph']);
      const text = diffService.extractText(doc);
      expect(text).toContain('First paragraph');
      expect(text).toContain('Second paragraph');
      doc.destroy();
    });

    test('handles empty document', () => {
      const doc = new Y.Doc();
      const text = diffService.extractText(doc);
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

  describe('computeChanges', () => {
    test('detects insertions', () => {
      const oldDoc = createDocWithText('Hello');
      const newDoc = createDocWithText('Hello World');

      const oldPmDoc = diffService.yDocToProseMirror(oldDoc);
      const newPmDoc = diffService.yDocToProseMirror(newDoc);

      const changes = diffService.computeChanges(oldPmDoc, newPmDoc);

      expect(changes.length).toBeGreaterThan(0);
      expect(changes.some(c => c.type === 'insert')).toBe(true);

      oldDoc.destroy();
      newDoc.destroy();
    });

    test('detects deletions with formatted content', () => {
      const oldDoc = createDocWithText('Hello World');
      const newDoc = createDocWithText('Hello');

      const oldPmDoc = diffService.yDocToProseMirror(oldDoc);
      const newPmDoc = diffService.yDocToProseMirror(newDoc);

      const changes = diffService.computeChanges(oldPmDoc, newPmDoc);

      expect(changes.length).toBeGreaterThan(0);
      const deleteChange = changes.find(c => c.type === 'delete');
      expect(deleteChange).toBeDefined();
      // Deletions now include deletedContent as array of node JSONs
      expect(deleteChange.deletedContent).toBeDefined();
      expect(Array.isArray(deleteChange.deletedContent)).toBe(true);

      oldDoc.destroy();
      newDoc.destroy();
    });

    test('returns empty array for identical documents', () => {
      const doc1 = createDocWithText('Same content');
      const doc2 = createDocWithText('Same content');

      const pmDoc1 = diffService.yDocToProseMirror(doc1);
      const pmDoc2 = diffService.yDocToProseMirror(doc2);

      const changes = diffService.computeChanges(pmDoc1, pmDoc2);

      expect(changes).toEqual([]);

      doc1.destroy();
      doc2.destroy();
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
      expect(result).toHaveProperty('changes');
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
      // With markdown-based diff, insertions are baked into the document as diffInsert marks
      // rather than being returned in the changes array
      const docJson = JSON.stringify(result.document);
      expect(docJson.includes('diffInsert') || result.changes.some(c => c.type === 'insert')).toBe(true);

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
        'diffv3:test-doc:-1:0',
        3600,
        expect.any(String)
      );

      doc.destroy();
    });
  });
});
