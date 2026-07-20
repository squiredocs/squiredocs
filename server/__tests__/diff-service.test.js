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
  let mockPersistence;
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
    // Feature 023 C1: DiffService now fetches diff rows through the persistence
    // provider's gap-tolerant getUpdateRowsUpTo (returns { rows, gapped }) — not
    // a raw pool. Default: gap-free empty result; individual tests override.
    mockPersistence = {
      getUpdateRowsUpTo: jest.fn().mockResolvedValue({ rows: [], gapped: false }),
    };
    diffService = new DiffService(mockPersistence);
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

    test('handles newlines within styled text nodes', () => {
      const { markdownToPm } = require('../../shared/markdown');
      const { toMarkdown } = require('../mcp/yjs/serialization');

      // Create a doc with \n in a styled text node (occurs from MCP edits)
      const doc = new Y.Doc();
      const fragment = doc.getXmlFragment('default');
      doc.transact(() => {
        const list = new Y.XmlElement('bulletList');
        const li = new Y.XmlElement('listItem');
        const p = new Y.XmlElement('paragraph');
        const t = new Y.XmlText();
        t.insert(0, 'First line.\nSecond line.', {
          textStyle: { fontSize: '17px' },
        });
        p.insert(0, [t]);
        li.insert(0, [p]);
        list.insert(0, [li]);
        fragment.insert(0, [list]);
      });

      const md = toMarkdown(fragment);

      // The markdown should contain the text (span will cross the newline)
      expect(md).toContain('First line.');
      expect(md).toContain('Second line.');

      // Round-trip should produce valid blocks with diffInsert on all text
      const pmJson = markdownToPm(md, 'diffInsert');
      const jsonStr = JSON.stringify(pmJson);

      // Should NOT have broken </span> as text content
      expect(jsonStr).not.toContain('"text":"</span>');
      // All blocks should have diffInsert
      expect(jsonStr).toContain('diffInsert');
      // Newline should be preserved in text
      expect(jsonStr).toContain('First line.\\nSecond line.');

      doc.destroy();
    });

    test('lineHeight survives markdown round-trip', () => {
      const { markdownToPm } = require('../../shared/markdown');
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

  describe('computeMarkdownDiff — word-level marks (feature 022, US2)', () => {
    // Helper: build a Y.Doc from an array of paragraph strings (with optional
    // per-paragraph inline attrs applied to the whole paragraph text).
    function docFrom(paras) {
      const doc = new Y.Doc();
      const fragment = doc.getXmlFragment('default');
      doc.transact(() => {
        const els = paras.map(({ text, attrs }) => {
          const p = new Y.XmlElement('paragraph');
          const t = new Y.XmlText();
          t.insert(0, text, attrs || {});
          p.insert(0, [t]);
          return p;
        });
        fragment.insert(0, els);
      });
      return doc;
    }

    test('a single-word change marks ONLY the changed word strong; the rest stays subtle', () => {
      const prev = docFrom([{ text: 'The quick brown fox' }]);
      const curr = docFrom([{ text: 'The slow brown fox' }]);
      const result = diffService.computeMarkdownDiff(prev, curr, false);
      const json = JSON.stringify(result);

      // Strong marks present on the changed word only
      expect(json).toContain('diffDeleteWord');
      expect(json).toContain('diffInsertWord');

      // Find the removed paragraph and inspect its runs
      const removed = result.content.find((b) => JSON.stringify(b).includes('diffDeleteWord'));
      const runs = removed.content;
      const strong = runs.filter((r) => r.marks.some((m) => m.type === 'diffDeleteWord'));
      expect(strong.map((r) => r.text)).toEqual(['quick']);
      // Every other run carries the subtle diffDelete mark (two-tier, never both)
      const subtle = runs.filter((r) => r.marks.some((m) => m.type === 'diffDelete'));
      expect(subtle.map((r) => r.text).join('')).toBe('The  brown fox');
      for (const r of runs) {
        const hasStrong = r.marks.some((m) => m.type === 'diffDeleteWord');
        const hasSubtle = r.marks.some((m) => m.type === 'diffDelete');
        expect(hasStrong && hasSubtle).toBe(false); // tiers never nest (FR-010)
      }

      prev.destroy();
      curr.destroy();
    });

    test('a changed word carrying inline formatting keeps the formatting mark alongside the diff mark (FR-010)', () => {
      const prev = docFrom([{ text: 'The quick fox', attrs: { bold: true } }]);
      const curr = docFrom([{ text: 'The slow fox', attrs: { bold: true } }]);
      const result = diffService.computeMarkdownDiff(prev, curr, false);
      const removed = result.content.find((b) => JSON.stringify(b).includes('diffDeleteWord'));
      const changed = removed.content.find((r) => r.marks.some((m) => m.type === 'diffDeleteWord'));
      expect(changed.text).toBe('quick');
      const markTypes = changed.marks.map((m) => m.type);
      expect(markTypes).toContain('bold');
      expect(markTypes).toContain('diffDeleteWord');
      // diff mark is applied LAST
      expect(markTypes[markTypes.length - 1]).toBe('diffDeleteWord');

      prev.destroy();
      curr.destroy();
    });

    test('lone-added paragraph (clean insert between unchanged blocks) stays subtle diffInsert only', () => {
      // A pure `added` diffLines part (no adjacent `removed`) — not a replace
      // region — so no word marks, exactly as before feature 022.
      const prev = docFrom([{ text: 'Alpha' }, { text: 'Gamma' }]);
      const curr = docFrom([{ text: 'Alpha' }, { text: 'Beta' }, { text: 'Gamma' }]);
      const result = diffService.computeMarkdownDiff(prev, curr, false);
      const json = JSON.stringify(result);
      expect(json).toContain('diffInsert');
      expect(json).not.toContain('diffInsertWord');
      expect(json).not.toContain('diffDeleteWord');
      prev.destroy();
      curr.destroy();
    });

    test('lone-removed paragraph (clean delete between unchanged blocks) stays subtle diffDelete only', () => {
      const prev = docFrom([{ text: 'Alpha' }, { text: 'Beta' }, { text: 'Gamma' }]);
      const curr = docFrom([{ text: 'Alpha' }, { text: 'Gamma' }]);
      const result = diffService.computeMarkdownDiff(prev, curr, false);
      const json = JSON.stringify(result);
      expect(json).toContain('diffDelete');
      expect(json).not.toContain('diffDeleteWord');
      expect(json).not.toContain('diffInsertWord');
      prev.destroy();
      curr.destroy();
    });

    test('unchanged text yields a plain doc with no diff marks at all', () => {
      const prev = docFrom([{ text: 'Nothing changes here' }]);
      const curr = docFrom([{ text: 'Nothing changes here' }]);
      const result = diffService.computeMarkdownDiff(prev, curr, true);
      const json = JSON.stringify(result);
      expect(json).not.toContain('diffInsert');
      expect(json).not.toContain('diffDelete');
      prev.destroy();
      curr.destroy();
    });

    test('format-only-at-region-level (same words, different formatting) yields subtle marks only', () => {
      // bold → italic on the SAME words: a replace region whose plain text is
      // identical, so no word is "changed" → all subtle, no strong marks.
      const prev = docFrom([{ text: 'same words', attrs: { bold: true } }]);
      const curr = docFrom([{ text: 'same words', attrs: { italic: true } }]);
      const result = diffService.computeMarkdownDiff(prev, curr, false);
      const json = JSON.stringify(result);
      expect(json).toContain('diffInsert');
      expect(json).toContain('diffDelete');
      expect(json).not.toContain('diffInsertWord');
      expect(json).not.toContain('diffDeleteWord');
      prev.destroy();
      curr.destroy();
    });

    test('fault injection: refinement error degrades to line-level marks; no throw, no word marks (RBD-3/FR-012)', () => {
      const consoleError = jest.spyOn(console, 'error').mockImplementation(() => {});
      // Inject a failure into the region refinement via the shared helper the
      // same module instance apply-word-marks calls (namespace spy — no module
      // isolation, so the Y.Doc constructor identity is preserved).
      const wordDiff = require('../../shared/diff/word-diff');
      const segSpy = jest.spyOn(wordDiff, 'computeWordSegments').mockImplementation(() => {
        throw new Error('injected refinement failure');
      });

      const prev = docFrom([{ text: 'The quick brown fox' }]);
      const curr = docFrom([{ text: 'The slow brown fox' }]);
      let result;
      expect(() => {
        result = diffService.computeMarkdownDiff(prev, curr, false);
      }).not.toThrow();

      const json = JSON.stringify(result);
      // Degraded to today's line-level presentation (subtle marks, no word marks)
      expect(json).toContain('diffDelete');
      expect(json).toContain('diffInsert');
      expect(json).not.toContain('diffDeleteWord');
      expect(json).not.toContain('diffInsertWord');

      segSpy.mockRestore();
      consoleError.mockRestore();
      prev.destroy();
      curr.destroy();
    });

    test('guardrail null (oversized/slow region) degrades to line-level marks WITHOUT logging an error', () => {
      const consoleError = jest.spyOn(console, 'error').mockImplementation(() => {});
      const wordDiff = require('../../shared/diff/word-diff');
      const segSpy = jest.spyOn(wordDiff, 'computeWordSegments').mockReturnValue(null);

      const prev = docFrom([{ text: 'The quick brown fox' }]);
      const curr = docFrom([{ text: 'The slow brown fox' }]);
      const result = diffService.computeMarkdownDiff(prev, curr, false);

      const json = JSON.stringify(result);
      expect(json).toContain('diffDelete');
      expect(json).toContain('diffInsert');
      expect(json).not.toContain('diffDeleteWord');
      expect(json).not.toContain('diffInsertWord');
      // Expected degradation, not an error: nothing logged
      expect(consoleError).not.toHaveBeenCalled();

      segSpy.mockRestore();
      consoleError.mockRestore();
      prev.destroy();
      curr.destroy();
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
      mockPersistence.getUpdateRowsUpTo.mockResolvedValue({
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
      mockPersistence.getUpdateRowsUpTo.mockResolvedValue({
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

      mockPersistence.getUpdateRowsUpTo.mockResolvedValue({
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

      mockPersistence.getUpdateRowsUpTo.mockResolvedValue({
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
      expect(mockPersistence.getUpdateRowsUpTo).not.toHaveBeenCalled();
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

      mockPersistence.getUpdateRowsUpTo.mockResolvedValue({
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

    // Feature 023 T010 (FR-009, D-2, SC-002): a diff computed from a still-gapped
    // row set is SERVED but never frozen into the cache — the next request
    // recomputes from a healed log.
    test('gapped row fetch: diff served but NOT cached', async () => {
      const { isRedisEnabled, getRedisClient } = require('../redis');
      isRedisEnabled.mockReturnValue(true);

      const mockSetex = jest.fn().mockResolvedValue('OK');
      getRedisClient.mockReturnValue({
        get: jest.fn().mockResolvedValue(null),
        setex: mockSetex,
      });

      const doc = createDocWithText('Gapped');
      const update = Y.encodeStateAsUpdate(doc);

      mockPersistence.getUpdateRowsUpTo.mockResolvedValue({
        rows: [{ clock: 0, update_data: Buffer.from(update) }],
        gapped: true, // torn read after the retry budget
      });

      const result = await diffService.computeDiff('test-doc', -1, 0);

      // Served: a real diff result comes back.
      expect(result).toHaveProperty('document');
      expect(result.meta.currentClock).toBe(0);
      // But the cache key is never written (assert setex absent).
      expect(mockSetex).not.toHaveBeenCalled();

      doc.destroy();
    });
  });
});
