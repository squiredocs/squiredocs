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

    // ---------------------------------------------------------------------
    // Feature 039 US7 (FR-016) — extractText walks the Yjs tree instead of
    // regex-stripping anything that LOOKS like a tag.
    // ---------------------------------------------------------------------

    test('039: literal angle-bracket prose survives verbatim', () => {
      // The old implementation was node.toString().replace(/<[^>]*>/g, ''),
      // which ate this sentence's `<div>` along with the real markup — so two
      // versions differing only here extracted to identical text and the
      // comparison claimed "Formatting changes only" for a real content change.
      const doc = createDocWithText('use <div> tags for layout');
      expect(extractText(doc)).toBe('use <div> tags for layout');
      doc.destroy();
    });

    test('039: an unclosed / mathematical angle bracket survives too', () => {
      const doc = createDocWithText('if a < b then swap');
      expect(extractText(doc)).toBe('if a < b then swap');
      doc.destroy();
    });

    test('039: angle-bracket prose inside a bold run survives (toDelta, not toString)', () => {
      // The Y.XmlText subtlety: toString() re-emits inline formatting as tags,
      // so a formatted run would reintroduce exactly the markup the walk is
      // meant to avoid. The walk must read the delta's string inserts.
      const doc = new Y.Doc();
      const fragment = doc.getXmlFragment('default');
      doc.transact(() => {
        const p = new Y.XmlElement('paragraph');
        const t = new Y.XmlText();
        t.insert(0, 'use ');
        t.insert(4, '<section>', { bold: true });
        t.insert(13, ' here');
        p.insert(0, [t]);
        fragment.insert(0, [p]);
      });
      const text = extractText(doc);
      expect(text).toBe('use <section> here');
      // No formatting markup leaked into the plain text.
      expect(text).not.toContain('<strong');
      expect(text).not.toContain('<bold');
      doc.destroy();
    });

    test('039 CD-8: line shape is preserved exactly', () => {
      // One line per TOP-LEVEL fragment node; descendants concatenated with NO
      // separator; trailing whitespace trimmed. formattingOnly and the diff
      // cache both depend on this shape, so it is pinned.
      const doc = createDocWithParagraphs(['First paragraph', 'Second paragraph']);
      expect(extractText(doc)).toBe('First paragraph\nSecond paragraph');
      doc.destroy();

      // Descendants of ONE top-level node concatenate with no separator.
      const nested = new Y.Doc();
      const frag = nested.getXmlFragment('default');
      nested.transact(() => {
        const list = new Y.XmlElement('bulletList');
        for (const label of ['alpha', 'beta']) {
          const item = new Y.XmlElement('listItem');
          const para = new Y.XmlElement('paragraph');
          const t = new Y.XmlText();
          t.insert(0, label);
          para.insert(0, [t]);
          item.insert(0, [para]);
          list.insert(list.length, [item]);
        }
        frag.insert(0, [list]);
      });
      expect(extractText(nested)).toBe('alphabeta');
      nested.destroy();
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

  // =========================================================================
  // Feature 039 — the cache-write gate (FR-005), single-replay reconstruction
  // (FR-015) and metadata correctness (FR-016/017).
  //
  // A comparison may be frozen for an hour only when it is provably COMPLETE,
  // SUCCESSFUL and DETERMINISTIC. Each condition is a veto: a result failing any
  // of them is still SERVED (today's presentation, no new UI state) and simply
  // not written, so the next request self-heals.
  //
  // Contract: specs/039-diff-cache-integrity/contracts/cache-write-rules.md
  // =========================================================================
  describe('039 cache-write gate', () => {
    // ---- T007: the shared cache assertion harness -------------------------
    /**
     * Enable Redis with a fresh spy pair and return them. Every test in this
     * block asserts one of exactly two outcomes:
     *   served + NOT cached   →  expectServedNotCached(result, setex)
     *   served + cached       →  expectServedAndCached(result, setex, key)
     */
    function withRedis(cached = null) {
      const { isRedisEnabled, getRedisClient } = require('../redis');
      isRedisEnabled.mockReturnValue(true);
      const setex = jest.fn().mockResolvedValue('OK');
      const get = jest.fn().mockResolvedValue(cached);
      getRedisClient.mockReturnValue({ get, setex });
      return { setex, get };
    }

    function expectServedNotCached(result, setex) {
      // Served: a real, complete response reached the caller...
      expect(result).toHaveProperty('document');
      expect(result).toHaveProperty('currentDocument');
      expect(result).toHaveProperty('meta');
      // ...and nothing was frozen.
      expect(setex).not.toHaveBeenCalled();
    }

    function expectServedAndCached(result, setex, docGuid, prev, curr) {
      expect(result).toHaveProperty('document');
      expect(setex).toHaveBeenCalledTimes(1);
      const [key, ttl, payload] = setex.mock.calls[0];
      expect(key).toBe(`diff${CACHE_VERSION}:${docGuid}:${prev}:${curr}`);
      expect(key.startsWith('diffv11:')).toBe(true);   // CW-T6
      expect(ttl).toBe(3600);                          // CW-6, unchanged
      expect(typeof payload).toBe('string');
    }

    /** Rows for a one-update document at clock 0. */
    function singleRow(text = 'Hello') {
      const doc = createDocWithText(text);
      const row = { clock: 0, update_data: Buffer.from(Y.encodeStateAsUpdate(doc)) };
      doc.destroy();
      return row;
    }

    /**
     * A real two-clock chain whose second update REPLACES the first's text, so
     * diffLines produces a `removed` part immediately followed by an `added`
     * part — i.e. an actual replace region, which is the only thing that calls
     * applyWordMarks. A pure insert (previousClock = -1) never segments a single
     * word, so it cannot exercise the degradation path at all.
     */
    function replaceRegionRows() {
      const doc = new Y.Doc();
      const frag = doc.getXmlFragment('default');
      doc.transact(() => {
        const p = new Y.XmlElement('paragraph');
        const t = new Y.XmlText();
        t.insert(0, 'the quick brown fox');
        p.insert(0, [t]);
        frag.insert(0, [p]);
      });
      const u0 = Y.encodeStateAsUpdate(doc);
      const sv = Y.encodeStateVector(doc);
      doc.transact(() => {
        const t = frag.get(0).get(0);
        t.delete(0, t.length);
        t.insert(0, 'the slow brown cat');
      });
      const u1 = Y.encodeStateAsUpdate(doc, sv);
      doc.destroy();
      return [
        { clock: 0, update_data: Buffer.from(u0) },
        { clock: 1, update_data: Buffer.from(u1) },
      ];
    }

    // ---- US1 / CW-T1 ------------------------------------------------------
    test('CW-T1: a tail-short (incomplete) read is served but NOT cached, and heals next time', async () => {
      const { setex } = withRedis();
      // The persistence layer reports the read never reached the requested
      // version — gap-free rows, but short of currentClock.
      mockPersistence.getUpdateRowsUpTo.mockResolvedValue({ rows: [singleRow()], gapped: true });

      const result = await diffService.computeDiff('test-doc', -1, 5);
      expectServedNotCached(result, setex);

      // FR-003: the diff path opts in, telling the read which clock it must reach.
      expect(mockPersistence.getUpdateRowsUpTo).toHaveBeenCalledWith(
        'test-doc', 5, { expectedTailClock: 5 }
      );

      // Log heals → complete read → cached under the v10 namespace.
      const healed = withRedis();
      mockPersistence.getUpdateRowsUpTo.mockResolvedValue({ rows: [singleRow()], gapped: false });
      const second = await diffService.computeDiff('test-doc', -1, 5);
      expectServedAndCached(second, healed.setex, 'test-doc', -1, 5);
    });

    // ---- US2 / CW-T2 ------------------------------------------------------
    test('CW-T2: a failed computation is served as the plain fallback but NOT cached', async () => {
      const { setex } = withRedis();
      mockPersistence.getUpdateRowsUpTo.mockResolvedValue({ rows: [singleRow('Fallback')], gapped: false });
      jest.spyOn(console, 'error').mockImplementation(() => {});
      const boom = jest.spyOn(diffService, 'computeMarkdownDiff').mockImplementation(() => {
        throw new Error('transient parse failure');
      });

      const result = await diffService.computeDiff('test-doc', -1, 0);

      // CD-2: today's presentation exactly — the plain current document plus the
      // existing diffFailed flag that drives the "Diff highlighting unavailable"
      // notice. No new UI state was introduced.
      expect(result.meta.diffFailed).toBe(true);
      expect(result.document).toEqual(result.currentDocument);
      expectServedNotCached(result, setex);

      // F8: with the failure gone the same pair recovers AND caches — pre-039
      // the failure itself was frozen for an hour with no retry path.
      boom.mockRestore();
      const healed = withRedis();
      const second = await diffService.computeDiff('test-doc', -1, 0);
      expect(second.meta.diffFailed).toBe(false);
      expectServedAndCached(second, healed.setex, 'test-doc', -1, 0);
    });

    // ---- US3 / CW-T3..CW-T5 ----------------------------------------------
    test('CW-T3: a SIZE-degraded comparison IS cached (deterministic)', async () => {
      const { setex } = withRedis();
      mockPersistence.getUpdateRowsUpTo.mockResolvedValue({ rows: replaceRegionRows(), gapped: false });
      const wordDiff = require('../../shared/diff/word-diff');
      const spy = jest.spyOn(wordDiff, 'computeWordSegments').mockImplementation((b, a, report) => {
        // Size cap: deterministic, so it reports nothing.
        return null;
      });

      const result = await diffService.computeDiff('test-doc', 0, 1);
      expect(spy).toHaveBeenCalled();   // the region really did segment
      // MAX_SIDE_CHARS is a pure function of the inputs: the line-level result is
      // the correct, reproducible answer for this pair, so caching it is right.
      expectServedAndCached(result, setex, 'test-doc', 0, 1);
    });

    test('CW-T4: a TIMEOUT-degraded comparison is served but NOT cached, and recovers', async () => {
      const { setex } = withRedis();
      mockPersistence.getUpdateRowsUpTo.mockResolvedValue({ rows: replaceRegionRows(), gapped: false });
      const wordDiff = require('../../shared/diff/word-diff');
      const spy = jest.spyOn(wordDiff, 'computeWordSegments').mockImplementation((b, a, report) => {
        if (report) report.timedOut = true;
        return null;
      });

      const result = await diffService.computeDiff('test-doc', 0, 1);
      expect(spy).toHaveBeenCalled();
      expectServedNotCached(result, setex);

      // Under normal load the same pair returns word-level emphasis and caches.
      spy.mockRestore();
      const healed = withRedis();
      const second = await diffService.computeDiff('test-doc', 0, 1);
      expect(JSON.stringify(second.document)).toContain('diffDeleteWord');
      expectServedAndCached(second, healed.setex, 'test-doc', 0, 1);
    });

    // U1 — the correctness fix this feature exists for. The report sink is
    // SHARED across every replace region in one comparison, so a last-write-wins
    // field would let a later region erase an earlier timeout and cache a
    // comparison FR-005(c) forbids caching. The flag accumulates instead.
    test('U1: a later clean/size region cannot erase an earlier TIMEOUT (sticky flag)', async () => {
      const { setex } = withRedis();
      // TWO replace regions in one comparison, separated by an unchanged block:
      // the first times out, the second is merely size-capped.
      const prev = createDocWithParagraphs(['alpha one', 'separator', 'gamma one']);
      const curr = createDocWithParagraphs(['alpha two', 'separator', 'gamma two']);

      const wordDiff = require('../../shared/diff/word-diff');
      let call = 0;
      const spy = jest.spyOn(wordDiff, 'computeWordSegments').mockImplementation((b, a, report) => {
        call += 1;
        // First region times out; later regions are merely size-capped and
        // report nothing — the accumulated timeout must survive them.
        if (report && call === 1) report.timedOut = true;
        return null;
      });

      const report = { timedOut: false };
      diffService.computeMarkdownDiff(prev, curr, report);
      expect(call).toBeGreaterThan(1);          // more than one region ran
      expect(report.timedOut).toBe(true);       // the accumulator remembers region 1

      // End-to-end: because the timeout survived, the comparison is NOT cached.
      // A last-write-wins field would have been overwritten by the later region
      // and cached it — the exact bug this feature exists to fix.
      call = 0;
      mockPersistence.getUpdateRowsUpTo.mockResolvedValue({ rows: replaceRegionRows(), gapped: false });
      spy.mockImplementation((b, a, rep) => {
        call += 1;
        if (rep && call === 1) rep.timedOut = true;
        return null;
      });
      const result = await diffService.computeDiff('test-doc', 0, 1);
      expectServedNotCached(result, setex);

      prev.destroy();
      curr.destroy();
    });

    test('CW-T5: several simultaneous failures still yield ONE served response and no cache write', async () => {
      const { setex } = withRedis();
      jest.spyOn(console, 'error').mockImplementation(() => {});
      // incomplete read + failed computation at once
      mockPersistence.getUpdateRowsUpTo.mockResolvedValue({ rows: [singleRow()], gapped: true });
      jest.spyOn(diffService, 'computeMarkdownDiff').mockImplementation(() => {
        throw new Error('boom');
      });

      const result = await diffService.computeDiff('test-doc', -1, 0);
      // CW-1: the conditions are vetoes, never traded off against each other.
      expect(result.meta.diffFailed).toBe(true);
      expectServedNotCached(result, setex);
    });

    test('CW-T7: the healthy path caches exactly as before — TTL 3600, v11 key', async () => {
      const { setex } = withRedis();
      mockPersistence.getUpdateRowsUpTo.mockResolvedValue({ rows: [singleRow()], gapped: false });
      const result = await diffService.computeDiff('doc-healthy', -1, 0);
      expectServedAndCached(result, setex, 'doc-healthy', -1, 0);
    });

    // Bumped v10 → v11 for feature 054 (RBD-054-12): the strict parser that
    // feeds this engine now preserves an ordered list's `start`, so entries
    // cached before it render numbering the document no longer agrees with.
    test('CW-T6: CACHE_VERSION is v11 and a v10 entry is never read', async () => {
      expect(CACHE_VERSION).toBe('v11');
      const { get } = withRedis();
      mockPersistence.getUpdateRowsUpTo.mockResolvedValue({ rows: [singleRow()], gapped: false });
      await diffService.computeDiff('doc-ns', 1, 2);
      expect(get).toHaveBeenCalledWith('diffv11:doc-ns:1:2');
      expect(get).not.toHaveBeenCalledWith(expect.stringContaining('diffv10:'));
    });

    test('CW-T8: a throwing setex is caught and logged, and never fails the request', async () => {
      const { isRedisEnabled, getRedisClient } = require('../redis');
      isRedisEnabled.mockReturnValue(true);
      const setex = jest.fn().mockRejectedValue(new Error('redis down'));
      getRedisClient.mockReturnValue({ get: jest.fn().mockResolvedValue(null), setex });
      const errSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
      mockPersistence.getUpdateRowsUpTo.mockResolvedValue({ rows: [singleRow()], gapped: false });

      const result = await diffService.computeDiff('doc-redis-down', -1, 0);
      expect(result).toHaveProperty('document');   // CW-5: non-fatal
      expect(errSpy).toHaveBeenCalledWith(
        '[DiffService] Redis cache write error:', 'redis down'
      );
    });

    test('CW-4: the predicate has exactly the three FR-005 conditions — no more, no fewer', async () => {
      // Complete + successful + no timeout ⇒ cached. Flip each condition in turn
      // and the write must disappear; nothing else may suppress it.
      const rows = replaceRegionRows();
      const wordDiff = require('../../shared/diff/word-diff');
      jest.spyOn(console, 'error').mockImplementation(() => {});

      // baseline: all three satisfied
      let r = withRedis();
      mockPersistence.getUpdateRowsUpTo.mockResolvedValue({ rows, gapped: false });
      await diffService.computeDiff('d', 0, 1);
      expect(r.setex).toHaveBeenCalledTimes(1);

      // (a) incomplete
      r = withRedis();
      mockPersistence.getUpdateRowsUpTo.mockResolvedValue({ rows, gapped: true });
      await diffService.computeDiff('d', 0, 1);
      expect(r.setex).not.toHaveBeenCalled();

      // (b) diffFailed
      r = withRedis();
      mockPersistence.getUpdateRowsUpTo.mockResolvedValue({ rows, gapped: false });
      const boom = jest.spyOn(diffService, 'computeMarkdownDiff').mockImplementation(() => { throw new Error('x'); });
      await diffService.computeDiff('d', 0, 1);
      expect(r.setex).not.toHaveBeenCalled();
      boom.mockRestore();

      // (c) timeout degradation
      r = withRedis();
      const seg = jest.spyOn(wordDiff, 'computeWordSegments').mockImplementation((b, a, report) => {
        if (report) report.timedOut = true;
        return null;
      });
      await diffService.computeDiff('d', 0, 1);
      expect(r.setex).not.toHaveBeenCalled();
      seg.mockRestore();

      // and a SIZE degradation alone does NOT suppress the write (CW-2) — the
      // fourth combination, proving the gate is not just "any degradation".
      r = withRedis();
      const sizeOnly = jest.spyOn(wordDiff, 'computeWordSegments').mockImplementation((b, a, report) => {
        // Size cap: deterministic, so it reports nothing.
        return null;
      });
      await diffService.computeDiff('d', 0, 1);
      expect(r.setex).toHaveBeenCalledTimes(1);
      sizeOnly.mockRestore();
    });
  });

  // =========================================================================
  // Feature 039 US6 (FR-015) — single-replay state reconstruction.
  // =========================================================================
  describe('039 single-replay reconstruction', () => {
    /**
     * Build a chain of n incremental updates from one client, so update i is
     * causally dependent on i-1 (the realistic log shape).
     */
    function buildChain(n) {
      const doc = new Y.Doc();
      const frag = doc.getXmlFragment('default');
      const rows = [];
      for (let i = 0; i < n; i++) {
        const sv = Y.encodeStateVector(doc);
        doc.transact(() => {
          const p = new Y.XmlElement('paragraph');
          const t = new Y.XmlText();
          t.insert(0, `para-${i}`);
          p.insert(0, [t]);
          frag.push([p]);
        });
        rows.push({ clock: i, update_data: Buffer.from(Y.encodeStateAsUpdate(doc, sv)) });
      }
      doc.destroy();
      return rows;
    }

    /** The pre-039 double-replay reconstruction, kept here as the oracle. */
    function legacyBuild(updates, previousClock, currentClock) {
      const prevDoc = new Y.Doc({ gc: false });
      const currDoc = new Y.Doc({ gc: false });
      for (const row of updates) {
        const u = new Uint8Array(row.update_data);
        if (previousClock >= 0 && row.clock <= previousClock) Y.applyUpdate(prevDoc, u);
        if (row.clock <= currentClock) Y.applyUpdate(currDoc, u);
      }
      const { extractText } = require('../yjs-utils');
      const out = {
        prevText: extractText(prevDoc),
        currText: extractText(currDoc),
        prevXml: require('../yjs-utils').extractXml(prevDoc),
        currXml: require('../yjs-utils').extractXml(currDoc),
      };
      prevDoc.destroy();
      currDoc.destroy();
      return out;
    }

    // CW-T9 — SR-3
    test('CW-T9: output is deep-equal to the double-replay result for representative pairs', () => {
      const rows = buildChain(8);
      const { extractXml } = require('../yjs-utils');
      // Includes previousClock = -1 (the empty-state case, where seeding is
      // skipped) plus mid-history and full-history pairs.
      for (const [prev, curr] of [[-1, 7], [-1, 0], [0, 7], [3, 7], [2, 5], [6, 7]]) {
        const legacy = legacyBuild(rows, prev, curr);
        const built = diffService.buildDocsAtClocks(rows, prev, curr);
        expect(built.prevText).toEqual(legacy.prevText);
        expect(built.currText).toEqual(legacy.currText);
        expect(extractXml(built.prevDoc)).toEqual(legacy.prevXml);
        expect(extractXml(built.currDoc)).toEqual(legacy.currXml);
        built.prevDoc.destroy();
        built.currDoc.destroy();
      }
    });

    // CW-T10 — SR-1 / SC-006
    test('CW-T10: no log row is applied more than once per reconstruction', () => {
      const rows = buildChain(8);
      const applySpy = jest.spyOn(Y, 'applyUpdate');

      const built = diffService.buildDocsAtClocks(rows, 3, 7);

      // Count how many times each ROW's bytes were applied. The single seed
      // update (encodeStateAsUpdate(prevDoc)) is not one of the rows, so it is
      // matched out rather than counted.
      const rowBytes = rows.map((r) => Buffer.from(r.update_data).toString('base64'));
      const counts = new Map(rowBytes.map((b) => [b, 0]));
      for (const [, update] of applySpy.mock.calls) {
        const key = Buffer.from(update).toString('base64');
        if (counts.has(key)) counts.set(key, counts.get(key) + 1);
      }
      for (const [, n] of counts) expect(n).toBeLessThanOrEqual(1);

      // And the work really did halve: pre-039 this pair applied rows 0..3 twice
      // (8 rows → 12 applications); now it is 8 row-applies + 1 seed.
      expect(applySpy.mock.calls.length).toBe(9);

      applySpy.mockRestore();
      built.prevDoc.destroy();
      built.currDoc.destroy();
    });

    test('SR-4: previousClock < 0 skips seeding entirely', () => {
      const rows = buildChain(4);
      const applySpy = jest.spyOn(Y, 'applyUpdate');
      const built = diffService.buildDocsAtClocks(rows, -1, 3);
      // Exactly the 4 rows, no seed update.
      expect(applySpy.mock.calls.length).toBe(4);
      expect(built.prevText).toBe('');
      applySpy.mockRestore();
      built.prevDoc.destroy();
      built.currDoc.destroy();
    });

    test('SR-2: gc:false is preserved on both docs (load-bearing for the seed)', () => {
      const rows = buildChain(3);
      const built = diffService.buildDocsAtClocks(rows, 0, 2);
      expect(built.prevDoc.gc).toBe(false);
      expect(built.currDoc.gc).toBe(false);
      built.prevDoc.destroy();
      built.currDoc.destroy();
    });
  });

  // =========================================================================
  // Feature 039 US7 (FR-016/017) — the "Formatting changes only" banner.
  // =========================================================================
  describe('039 formatting-only honesty', () => {
    /**
     * Drive computeDiff over a genuine two-clock update CHAIN: `seed` builds the
     * clock-0 state, `evolve` mutates that same document to produce the clock-1
     * delta. (Encoding two INDEPENDENT docs as clocks 0 and 1 would not model a
     * version pair at all — replaying both merges them into one document with
     * everything twice.)
     */
    async function metaForChain(seed, evolve, attrs) {
      const doc = new Y.Doc();
      const frag = doc.getXmlFragment('default');
      doc.transact(() => {
        const p = new Y.XmlElement('paragraph');
        const t = new Y.XmlText();
        t.insert(0, seed, attrs || {});
        p.insert(0, [t]);
        frag.insert(0, [p]);
      });
      const u0 = Y.encodeStateAsUpdate(doc);
      const sv = Y.encodeStateVector(doc);
      doc.transact(() => evolve(frag.get(0).get(0)));
      const u1 = Y.encodeStateAsUpdate(doc, sv);
      doc.destroy();

      mockPersistence.getUpdateRowsUpTo.mockResolvedValue({
        rows: [
          { clock: 0, update_data: Buffer.from(u0) },
          { clock: 1, update_data: Buffer.from(u1) },
        ],
        gapped: false,
      });
      const { isRedisEnabled } = require('../redis');
      isRedisEnabled.mockReturnValue(false);
      return (await diffService.computeDiff('fmt-doc', 0, 1)).meta;
    }

    const retype = (text, attrs) => (t) => {
      t.delete(0, t.length);
      t.insert(0, text, attrs || {});
    };

    // CW-T11
    test('CW-T11: versions differing only inside literal <div> prose report a TEXT change', async () => {
      // Pre-039 the regex ate both bracketed words, the two versions extracted
      // to the SAME string, and the UI announced "Formatting changes only" for a
      // real content edit.
      const meta = await metaForChain(
        'use <div> tags for layout',
        retype('use <span> tags for layout')
      );
      expect(meta.textIdentical).toBe(false);
      expect(meta.formattingOnly).toBe(false);
    });

    // CW-T12
    test('CW-T12: the same holds when the literal < sits inside a bold run', async () => {
      // The Y.XmlText toDelta subtlety: a toString()-based walk would re-emit
      // the bold as markup and reintroduce the very bug being fixed.
      const meta = await metaForChain(
        'use <div> tags',
        retype('use <span> tags', { bold: true }),
        { bold: true }
      );
      expect(meta.textIdentical).toBe(false);
      expect(meta.formattingOnly).toBe(false);
    });

    test('a genuine formatting-only change still reports formattingOnly', async () => {
      // The other direction must not regress: identical text, different marks.
      const meta = await metaForChain(
        'unchanged words here',
        (t) => t.format(0, t.length, { bold: true })
      );
      expect(meta.textIdentical).toBe(true);
      expect(meta.formattingOnly).toBe(true);
    });

    test('a plain text edit with no formatting change reports neither flag', async () => {
      const meta = await metaForChain('alpha beta gamma', retype('alpha DELTA gamma'));
      expect(meta.textIdentical).toBe(false);
      expect(meta.formattingOnly).toBe(false);
    });

    // FR-017
    test('FR-017: computeMarkdownDiff no longer declares a textIdentical parameter', () => {
      // The old third parameter was declared but never read — the function
      // re-derives the answer from prevMd === currMd. It is now the report sink.
      const src = diffService.computeMarkdownDiff.toString();
      expect(src).not.toContain('textIdentical');
      expect(diffService.computeMarkdownDiff.length).toBe(3);
    });
  });
});
