/**
 * read_document Tool Tests
 *
 * Tests for the read_document MCP tool with XPath filtering.
 */

const Y = require('yjs');

// Mock agent-presence
jest.mock('../../agent-presence', () => ({
  getOrCreateSession: jest.fn(),
}));

// Mock xpath module
jest.mock('../../sandbox/xpath', () => ({
  xpath: jest.fn(),
}));

const readDocument = require('../../tools/read-document');
const agentPresence = require('../../agent-presence');
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

    test('returns text format when requested', async () => {
      const result = await readDocument.handler(
        { docGuid: 'test-doc-id', format: 'text' },
        { userId: 'test-user' }
      );

      expect(typeof result.content).toBe('string');
      expect(result.content).toContain('Test Heading');
      expect(result.content).toContain('First paragraph');
      expect(result.content).toContain('Second paragraph');
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

    test('xpath results can be returned as text format', async () => {
      const headings = mockXmlFragment.toArray().filter(
        (n) => n instanceof Y.XmlElement && n.nodeName === 'heading'
      );
      xpath.mockReturnValue(headings);

      const result = await readDocument.handler(
        { docGuid: 'test-doc-id', xpath: '//heading', format: 'text' },
        { userId: 'test-user' }
      );

      expect(typeof result.content).toBe('string');
      expect(result.content).toContain('Test Heading');
      expect(result.content).toContain('Subheading');
      expect(result.content).not.toContain('paragraph');
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
      mockPool.query.mockResolvedValue({ rows: [] });

      await expect(
        readDocument.handler({ docGuid: 'test-doc-id' }, { userId: 'unauthorized-user' })
      ).rejects.toThrow('Document not found or you do not have access');
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
