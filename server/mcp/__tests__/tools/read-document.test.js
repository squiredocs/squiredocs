/**
 * read_document Tool Tests
 *
 * Tests for the read_document MCP tool with XPath filtering.
 */

const Y = require('yjs');

// Mock agent-presence
jest.mock('../../agent-presence', () => ({
  getOrCreateSession: jest.fn(),
  queueHighlightSequence: jest.fn(),
}));

// Mock xpath module
jest.mock('../../sandbox/xpath', () => ({
  xpath: jest.fn(),
}));

// Mocks for the versionId (historical read) branch — feature 019 DR-1.
jest.mock('../../../documents', () => ({
  hasAccess: jest.fn(),
}));
jest.mock('../../../version-history', () => ({
  getVersionContent: jest.fn(),
  createAuthor: jest.fn(),
  getCurrentSessionAuthors: jest.fn(() => []),
}));

const readDocument = require('../../tools/read-document');
const readDocumentVersion = require('../../tools/read-document-version');
const agentPresence = require('../../agent-presence');
const documents = require('../../../documents');
const versionHistory = require('../../../version-history');
const { xpath } = require('../../sandbox/xpath');

describe('read_document tool', () => {
  let mockPool;
  let mockDoc;
  let mockXmlFragment;

  beforeEach(() => {
    // Reset mocks
    jest.clearAllMocks();

    // Create a real Yjs document for testing
    mockDoc = new Y.Doc();
    mockXmlFragment = mockDoc.get('default', Y.XmlFragment);

    // Add some test content
    const heading = new Y.XmlElement('heading');
    heading.setAttribute('level', 1);
    const headingText = new Y.XmlText();
    headingText.insert(0, 'Test Heading');
    heading.insert(0, [headingText]);

    const para1 = new Y.XmlElement('paragraph');
    const para1Text = new Y.XmlText();
    para1Text.insert(0, 'First paragraph with TODO item');
    para1.insert(0, [para1Text]);

    const para2 = new Y.XmlElement('paragraph');
    const para2Text = new Y.XmlText();
    para2Text.insert(0, 'Second paragraph');
    para2.insert(0, [para2Text]);

    const heading2 = new Y.XmlElement('heading');
    heading2.setAttribute('level', 2);
    const heading2Text = new Y.XmlText();
    heading2Text.insert(0, 'Subheading');
    heading2.insert(0, [heading2Text]);

    mockXmlFragment.insert(0, [heading, para1, para2, heading2]);

    // Mock pool
    mockPool = {
      query: jest.fn().mockResolvedValue({
        rows: [{ id: 'test-doc-id', role: 'editor' }],
      }),
    };

    // Mock persistence provider
    const mockPersistence = {
      getPool: () => mockPool,
      getRecentUpdatesWithUsers: jest.fn().mockResolvedValue([]),
    };

    // Initialize tool
    readDocument.init(mockPersistence);

    // Mock agent presence
    agentPresence.getOrCreateSession.mockResolvedValue({
      provider: { doc: mockDoc },
      sessionId: 'test-session',
    });
  });

  describe('basic functionality', () => {
    test('reads entire document when no xpath provided', async () => {
      const result = await readDocument.handler(
        { docGuid: 'test-doc-id', format: 'structured' },
        { userId: 'test-user' }
      );

      expect(result.blockCount).toBe(4);
      expect(result.content).toHaveLength(4);
      expect(result.content[0].type).toBe('heading');
      expect(result.content[0].level).toBe(1);
      expect(result.content[0].content).toBe('Test Heading');
      expect(result.matchCount).toBeUndefined(); // No xpath = no matchCount
    });

    test('returns markdown format when requested', async () => {
      const result = await readDocument.handler(
        { docGuid: 'test-doc-id', format: 'markdown' },
        { userId: 'test-user' }
      );

      expect(typeof result.content).toBe('string');
      expect(result.content).toContain('# Test Heading');
      expect(result.content).toContain('First paragraph');
      expect(result.content).toContain('Second paragraph');
      expect(result.content).toContain('## Subheading');
    });

    test('defaults to structured format', async () => {
      const result = await readDocument.handler(
        { docGuid: 'test-doc-id' },
        { userId: 'test-user' }
      );

      expect(Array.isArray(result.content)).toBe(true);
    });
  });

  describe('xpath filtering', () => {
    test('filters results with xpath expression', async () => {
      // Mock xpath to return only headings
      const headings = mockXmlFragment.toArray().filter(
        (n) => n instanceof Y.XmlElement && n.nodeName === 'heading'
      );
      xpath.mockReturnValue(headings);

      const result = await readDocument.handler(
        { docGuid: 'test-doc-id', xpath: '//heading' },
        { userId: 'test-user' }
      );

      expect(xpath).toHaveBeenCalledWith('//heading', mockXmlFragment);
      expect(result.matchCount).toBe(2);
      expect(result.content).toHaveLength(2);
      expect(result.content[0].type).toBe('heading');
      expect(result.content[1].type).toBe('heading');
    });

    test('filters with attribute predicate', async () => {
      // Mock xpath to return only level-2 heading
      const h2 = mockXmlFragment.toArray().filter(
        (n) => n instanceof Y.XmlElement && n.nodeName === 'heading' && n.getAttribute('level') === 2
      );
      xpath.mockReturnValue(h2);

      const result = await readDocument.handler(
        { docGuid: 'test-doc-id', xpath: '//heading[@level=2]' },
        { userId: 'test-user' }
      );

      expect(result.matchCount).toBe(1);
      expect(result.content[0].level).toBe(2);
      expect(result.content[0].content).toBe('Subheading');
    });

    test('filters with text predicate', async () => {
      // Mock xpath to return paragraph with TODO
      const todoPara = mockXmlFragment.toArray().filter((n) => {
        if (!(n instanceof Y.XmlElement) || n.nodeName !== 'paragraph') return false;
        const text = n.get(0);
        if (!(text instanceof Y.XmlText)) return false;
        return text.toString().includes('TODO');
      });
      xpath.mockReturnValue(todoPara);

      const result = await readDocument.handler(
        { docGuid: 'test-doc-id', xpath: "//paragraph[contains(., 'TODO')]" },
        { userId: 'test-user' }
      );

      expect(result.matchCount).toBe(1);
      expect(result.content[0].content).toContain('TODO');
    });

    test('returns empty array when xpath matches nothing', async () => {
      xpath.mockReturnValue([]);

      const result = await readDocument.handler(
        { docGuid: 'test-doc-id', xpath: '//codeBlock' },
        { userId: 'test-user' }
      );

      expect(result.matchCount).toBe(0);
      expect(result.content).toHaveLength(0);
      expect(result.characterCount).toBe(0);
    });

    test('throws error for invalid xpath', async () => {
      xpath.mockImplementation(() => {
        throw new Error('Invalid XPath syntax');
      });

      await expect(
        readDocument.handler(
          { docGuid: 'test-doc-id', xpath: '///invalid[[[' },
          { userId: 'test-user' }
        )
      ).rejects.toThrow('Invalid XPath expression');
    });

    test('xpath results can be returned as markdown format', async () => {
      const headings = mockXmlFragment.toArray().filter(
        (n) => n instanceof Y.XmlElement && n.nodeName === 'heading'
      );
      xpath.mockReturnValue(headings);

      const result = await readDocument.handler(
        { docGuid: 'test-doc-id', xpath: '//heading', format: 'markdown' },
        { userId: 'test-user' }
      );

      expect(typeof result.content).toBe('string');
      expect(result.content).toContain('# Test Heading');
      expect(result.content).toContain('## Subheading');
      expect(result.content).not.toContain('paragraph');
    });
  });

  describe('markdown output format', () => {
    test('renders lists, code blocks, and tables as markdown', async () => {
      const bulletList = new Y.XmlElement('bulletList');
      const listItem = new Y.XmlElement('listItem');
      const itemPara = new Y.XmlElement('paragraph');
      const itemText = new Y.XmlText();
      itemText.insert(0, 'List entry');
      itemPara.insert(0, [itemText]);
      listItem.insert(0, [itemPara]);
      bulletList.insert(0, [listItem]);

      const codeBlock = new Y.XmlElement('codeBlock');
      codeBlock.setAttribute('language', 'js');
      const codeText = new Y.XmlText();
      codeText.insert(0, 'const x = 1;');
      codeBlock.insert(0, [codeText]);

      const table = new Y.XmlElement('table');
      const row = new Y.XmlElement('tableRow');
      const cell = new Y.XmlElement('tableHeader');
      const cellPara = new Y.XmlElement('paragraph');
      const cellText = new Y.XmlText();
      cellText.insert(0, 'Col A');
      cellPara.insert(0, [cellText]);
      cell.insert(0, [cellPara]);
      row.insert(0, [cell]);
      table.insert(0, [row]);

      mockXmlFragment.insert(mockXmlFragment.length, [bulletList, codeBlock, table]);

      const result = await readDocument.handler(
        { docGuid: 'test-doc-id', format: 'markdown' },
        { userId: 'test-user' }
      );

      expect(result.content).toContain('- List entry');
      expect(result.content).toContain('```js\nconst x = 1;\n```');
      expect(result.content).toContain('| Col A |');
      expect(result.content).toContain('| --- |');
    });

    test('renders strikethrough with the editor mark name (strike)', async () => {
      const para = new Y.XmlElement('paragraph');
      const text = new Y.XmlText();
      text.insert(0, 'crossed off', { strike: true });
      para.insert(0, [text]);
      mockXmlFragment.insert(mockXmlFragment.length, [para]);

      const result = await readDocument.handler(
        { docGuid: 'test-doc-id', format: 'markdown' },
        { userId: 'test-user' }
      );

      expect(result.content).toContain('~~crossed off~~');
    });

    test('indents nested ordered lists to the parent content column', async () => {
      const ol = new Y.XmlElement('orderedList');
      const li = new Y.XmlElement('listItem');
      const liPara = new Y.XmlElement('paragraph');
      const liText = new Y.XmlText();
      liText.insert(0, 'Parent');
      liPara.insert(0, [liText]);
      const inner = new Y.XmlElement('orderedList');
      const innerLi = new Y.XmlElement('listItem');
      const innerPara = new Y.XmlElement('paragraph');
      const innerText = new Y.XmlText();
      innerText.insert(0, 'Child');
      innerPara.insert(0, [innerText]);
      innerLi.insert(0, [innerPara]);
      inner.insert(0, [innerLi]);
      li.insert(0, [liPara, inner]);
      ol.insert(0, [li]);
      mockXmlFragment.insert(mockXmlFragment.length, [ol]);

      const result = await readDocument.handler(
        { docGuid: 'test-doc-id', format: 'markdown' },
        { userId: 'test-user' }
      );

      // "1. " marker is 3 chars wide, so the child needs 3 spaces
      expect(result.content).toContain('1. Parent\n   1. Child');
    });

    test('separates top-level blocks with blank lines', async () => {
      const result = await readDocument.handler(
        { docGuid: 'test-doc-id', format: 'markdown' },
        { userId: 'test-user' }
      );

      // GFM tables can't interrupt a paragraph and paragraphs merge
      // without a separating blank line
      expect(result.content).toContain('# Test Heading\n\nFirst paragraph');
      expect(result.content).toContain('First paragraph with TODO item\n\nSecond paragraph');
    });

    test('renders inline marks as markdown', async () => {
      const boldPara = new Y.XmlElement('paragraph');
      const boldText = new Y.XmlText();
      boldText.insert(0, 'Normal and bold text');
      boldText.format(11, 4, { bold: true });
      boldPara.insert(0, [boldText]);
      mockXmlFragment.insert(mockXmlFragment.length, [boldPara]);

      const result = await readDocument.handler(
        { docGuid: 'test-doc-id', format: 'markdown' },
        { userId: 'test-user' }
      );

      expect(result.content).toContain('Normal and **bold** text');
    });
  });

  describe('structured output format', () => {
    test('includes heading level attribute', async () => {
      const result = await readDocument.handler(
        { docGuid: 'test-doc-id' },
        { userId: 'test-user' }
      );

      const h1 = result.content.find((b) => b.type === 'heading' && b.level === 1);
      const h2 = result.content.find((b) => b.type === 'heading' && b.level === 2);

      expect(h1).toBeDefined();
      expect(h1.level).toBe(1);
      expect(h2).toBeDefined();
      expect(h2.level).toBe(2);
    });

    test('flattens simple text content to string', async () => {
      const result = await readDocument.handler(
        { docGuid: 'test-doc-id' },
        { userId: 'test-user' }
      );

      // Paragraphs with plain text should have content as string
      const para = result.content.find((b) => b.type === 'paragraph');
      expect(typeof para.content).toBe('string');
    });

    test('preserves formatting marks in content', async () => {
      // Add a paragraph with bold text
      const boldPara = new Y.XmlElement('paragraph');
      const boldText = new Y.XmlText();
      boldText.insert(0, 'Normal and bold text');
      boldText.format(11, 4, { bold: true }); // "bold" is bold
      boldPara.insert(0, [boldText]);
      mockXmlFragment.insert(mockXmlFragment.length, [boldPara]);

      const result = await readDocument.handler(
        { docGuid: 'test-doc-id' },
        { userId: 'test-user' }
      );

      const lastPara = result.content[result.content.length - 1];
      expect(Array.isArray(lastPara.content)).toBe(true);
      expect(lastPara.content.some((c) => typeof c === 'object' && c.marks)).toBe(true);
    });
  });

  describe('character counting', () => {
    test('counts characters correctly for full document', async () => {
      const result = await readDocument.handler(
        { docGuid: 'test-doc-id' },
        { userId: 'test-user' }
      );

      // "Test Heading" (12) + "First paragraph with TODO item" (30) + "Second paragraph" (16) + "Subheading" (10) = 68
      expect(result.characterCount).toBe(68);
    });

    test('counts characters correctly for xpath results', async () => {
      const headings = mockXmlFragment.toArray().filter(
        (n) => n instanceof Y.XmlElement && n.nodeName === 'heading'
      );
      xpath.mockReturnValue(headings);

      const result = await readDocument.handler(
        { docGuid: 'test-doc-id', xpath: '//heading' },
        { userId: 'test-user' }
      );

      // "Test Heading" (12) + "Subheading" (10) = 22
      expect(result.characterCount).toBe(22);
    });
  });

  describe('access control', () => {
    test('throws error when user has no access', async () => {
      agentPresence.getOrCreateSession.mockRejectedValueOnce(
        new Error('Document not found or you do not have access')
      );

      await expect(
        readDocument.handler({ docGuid: 'test-doc-id' }, { userId: 'unauthorized-user' })
      ).rejects.toThrow('Document not found or you do not have access');
    });
  });

  // ==========================================================================
  // versionId — read_document absorbs read_document_version (feature 019 DR-1)
  // ==========================================================================
  describe('versionId (historical reads)', () => {
    const VERSION_UUID = '7c3a2f10-9b2d-4f6e-a1c2-5d8e9f0a1b2c';
    let historicalDoc;
    let historicalFragment;
    let versionMeta;

    beforeEach(() => {
      // A historical Y.Doc whose content differs from the live mockDoc.
      historicalDoc = new Y.Doc();
      historicalFragment = historicalDoc.get('default', Y.XmlFragment);
      const heading = new Y.XmlElement('heading');
      heading.setAttribute('level', 1);
      const headingText = new Y.XmlText();
      headingText.insert(0, 'Historical Heading');
      heading.insert(0, [headingText]);
      const para = new Y.XmlElement('paragraph');
      const paraText = new Y.XmlText();
      paraText.insert(0, 'Historical paragraph content');
      para.insert(0, [paraText]);
      historicalFragment.insert(0, [heading, para]);

      versionMeta = {
        id: '42',
        name: null,
        clockStart: 40,
        clockEnd: 42,
        timestamp: '2026-07-01T00:00:00Z',
      };

      documents.hasAccess.mockResolvedValue(true);
      versionHistory.getVersionContent.mockResolvedValue({
        content: Buffer.from(Y.encodeStateAsUpdate(historicalDoc)),
        version: versionMeta,
      });
      readDocumentVersion.init({
        getPool: () => mockPool,
        getRecentUpdatesWithUsers: jest.fn().mockResolvedValue([]),
      });
    });

    test('accepts a clock-number string and returns the historical content with version metadata', async () => {
      const result = await readDocument.handler(
        { docGuid: 'test-doc-id', versionId: '42', format: 'markdown' },
        { userId: 'test-user' }
      );

      expect(versionHistory.getVersionContent).toHaveBeenCalledWith(
        expect.anything(), 'test-doc-id', '42'
      );
      expect(result.content).toContain('# Historical Heading');
      expect(result.content).toContain('Historical paragraph content');
      expect(result.content).not.toContain('Test Heading'); // not the live doc
      expect(result.blockCount).toBe(2);
      expect(result.version).toEqual(versionMeta);
    });

    test('accepts a version UUID', async () => {
      const result = await readDocument.handler(
        { docGuid: 'test-doc-id', versionId: VERSION_UUID },
        { userId: 'test-user' }
      );
      expect(versionHistory.getVersionContent).toHaveBeenCalledWith(
        expect.anything(), 'test-doc-id', VERSION_UUID
      );
      expect(result.version).toEqual(versionMeta);
    });

    test('returns the version result shape — no url/clock/lastModified/recentAuthors', async () => {
      const result = await readDocument.handler(
        { docGuid: 'test-doc-id', versionId: '42' },
        { userId: 'test-user' }
      );
      expect(Object.keys(result).sort()).toEqual(
        ['blockCount', 'characterCount', 'content', 'version']
      );
    });

    test('creates NO presence session and NO highlights on versioned reads', async () => {
      await readDocument.handler(
        { docGuid: 'test-doc-id', versionId: '42' },
        { userId: 'test-user' }
      );
      expect(agentPresence.getOrCreateSession).not.toHaveBeenCalled();
      expect(agentPresence.queueHighlightSequence).not.toHaveBeenCalled();
    });

    test('supports identical xpath semantics against the historical version', async () => {
      const headings = historicalFragment.toArray().filter(
        (n) => n instanceof Y.XmlElement && n.nodeName === 'heading'
      );
      xpath.mockReturnValue(headings);

      const result = await readDocument.handler(
        { docGuid: 'test-doc-id', versionId: '42', xpath: '//heading', format: 'structured' },
        { userId: 'test-user' }
      );

      expect(result.matchCount).toBe(1);
      expect(result.content[0].type).toBe('heading');
      expect(result.content[0].content).toBe('Historical Heading');
    });

    test('behaves identically to the read_document_version tool (ported behavior)', async () => {
      const viaReadDocument = await readDocument.handler(
        { docGuid: 'test-doc-id', versionId: '42', format: 'markdown' },
        { userId: 'test-user' }
      );
      const viaLegacyTool = await readDocumentVersion.handler(
        { docGuid: 'test-doc-id', versionId: '42', format: 'markdown' },
        { userId: 'test-user' }
      );
      expect(viaReadDocument).toEqual(viaLegacyTool);
    });

    test('enforces access via documents.hasAccess (no presence path)', async () => {
      documents.hasAccess.mockResolvedValue(false);
      await expect(
        readDocument.handler(
          { docGuid: 'test-doc-id', versionId: '42' },
          { userId: 'unauthorized' }
        )
      ).rejects.toThrow('Document not found or you do not have access');
      expect(versionHistory.getVersionContent).not.toHaveBeenCalled();
    });

    test('propagates unknown-version errors unchanged', async () => {
      versionHistory.getVersionContent.mockRejectedValue(new Error('Version not found'));
      await expect(
        readDocument.handler(
          { docGuid: 'test-doc-id', versionId: 'invalid-format' },
          { userId: 'test-user' }
        )
      ).rejects.toThrow('Version not found');
    });

    test('without versionId the current-content behavior is unchanged (presence + full shape)', async () => {
      const result = await readDocument.handler(
        { docGuid: 'test-doc-id', format: 'markdown' },
        { userId: 'test-user' }
      );
      expect(agentPresence.getOrCreateSession).toHaveBeenCalled();
      expect(result.content).toContain('# Test Heading');
      expect(result).toHaveProperty('url');
      expect(result).toHaveProperty('clock');
      expect(result).toHaveProperty('recentAuthors');
      expect(result.version).toBeUndefined();
    });

    test('inputSchema gains optional versionId (string), docGuid stays the only required param', () => {
      expect(readDocument.inputSchema.properties.versionId).toBeDefined();
      expect(readDocument.inputSchema.properties.versionId.type).toBe('string');
      expect(readDocument.inputSchema.required).toEqual(['docGuid']);
    });
  });

  describe('tool metadata', () => {
    test('has correct name', () => {
      expect(readDocument.name).toBe('read_document');
    });

    test('has description mentioning xpath', () => {
      expect(readDocument.description).toContain('XPath');
    });

    test('inputSchema includes xpath property', () => {
      expect(readDocument.inputSchema.properties.xpath).toBeDefined();
      expect(readDocument.inputSchema.properties.xpath.type).toBe('string');
    });

    test('inputSchema does not include fromBlock/toBlock', () => {
      expect(readDocument.inputSchema.properties.fromBlock).toBeUndefined();
      expect(readDocument.inputSchema.properties.toBlock).toBeUndefined();
    });
  });
});
