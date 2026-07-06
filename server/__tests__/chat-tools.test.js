/**
 * Chat tools adapter tests
 *
 * Tests the static tool result size limiting in chat-tools.js.
 */

// Mock the MCP tool registry
const mockGetToolList = jest.fn();
const mockExecuteTool = jest.fn();
// buildTools consults getTool(name).chatDescription for the script tools;
// these fake tools have none, so return null like the real registry does
// for unknown names.
const mockGetTool = jest.fn(() => null);
jest.mock('../mcp/tools', () => ({
  getToolList: mockGetToolList,
  executeTool: mockExecuteTool,
  getTool: mockGetTool,
}));

// Mock the AI SDK's tool and jsonSchema functions
const mockTool = jest.fn((def) => ({ ...def, _isTool: true }));
const mockJsonSchema = jest.fn((schema) => schema);
jest.mock('ai', () => ({
  tool: mockTool,
  jsonSchema: mockJsonSchema,
}));

const { buildTools, buildOversizedError, MAX_RESULT_CHARS, XPATH_TOOLS } = require('../api/chat-tools');

describe('chat-tools', () => {
  const fakeToken = { token: 'test-token' };

  beforeEach(() => {
    jest.clearAllMocks();
    mockGetToolList.mockReturnValue([
      { name: 'read_document', description: 'Read a doc', inputSchema: { type: 'object' } },
      { name: 'list_documents', description: 'List docs', inputSchema: { type: 'object' } },
      { name: 'read_document_version', description: 'Read version', inputSchema: { type: 'object' } },
    ]);
  });

  describe('MAX_RESULT_CHARS', () => {
    it('is 100,000', () => {
      expect(MAX_RESULT_CHARS).toBe(100_000);
    });
  });

  describe('buildTools', () => {
    it('creates tool definitions for each MCP tool', () => {
      const tools = buildTools(fakeToken);
      expect(tools).toHaveProperty('read_document');
      expect(tools).toHaveProperty('list_documents');
      expect(tools).toHaveProperty('read_document_version');
      // Chat-only image tools are always added (insert_image, view_image).
      expect(tools).toHaveProperty('insert_image');
      expect(tools).toHaveProperty('view_image');
      expect(mockTool).toHaveBeenCalledTimes(5); // 3 MCP tools + 2 image tools
    });

    it('passes results through when under the size limit', async () => {
      const smallResult = { content: 'hello', blockCount: 1 };
      mockExecuteTool.mockResolvedValue(smallResult);

      buildTools(fakeToken);

      const executeFn = mockTool.mock.calls.find(c => c[0].description === 'Read a doc')[0].execute;
      const result = await executeFn({});
      expect(result).toEqual(smallResult);
    });

    it('returns an error when result exceeds the static limit', async () => {
      const largeContent = 'x'.repeat(MAX_RESULT_CHARS + 1);
      const largeResult = { content: largeContent, blockCount: 271 };
      mockExecuteTool.mockResolvedValue(largeResult);

      buildTools(fakeToken);

      const executeFn = mockTool.mock.calls.find(c => c[0].description === 'Read a doc')[0].execute;
      const result = await executeFn({});
      expect(result).toHaveProperty('error');
      expect(result.error).toContain('exceeds available context');
    });

    it('passes results just under the limit', async () => {
      // A result whose JSON serialization is under MAX_RESULT_CHARS
      const content = 'x'.repeat(MAX_RESULT_CHARS - 100);
      const result = { content };
      mockExecuteTool.mockResolvedValue(result);

      buildTools(fakeToken);

      const executeFn = mockTool.mock.calls.find(c => c[0].description === 'Read a doc')[0].execute;
      const execResult = await executeFn({});
      expect(execResult).toEqual(result);
    });

    it('catches thrown errors from tool execution', async () => {
      mockExecuteTool.mockRejectedValue(new Error('Database connection failed'));

      buildTools(fakeToken);
      const executeFn = mockTool.mock.calls.find(c => c[0].description === 'Read a doc')[0].execute;
      const result = await executeFn({});
      expect(result).toEqual({ error: 'Database connection failed' });
    });
  });

  describe('buildOversizedError', () => {
    it('includes xpath paging instructions for read_document', () => {
      const error = buildOversizedError('read_document', 726_163, MAX_RESULT_CHARS, { blockCount: 271 });
      expect(error.error).toContain('xpath');
      expect(error.error).toContain('/*[position() <= 50]');
      expect(error.error).toContain('271 blocks');
      expect(error.error).toContain('REQUIREMENTS FOR SUMMARIZATION');
    });

    it('includes xpath paging instructions for read_document_version', () => {
      const error = buildOversizedError('read_document_version', 500_000, MAX_RESULT_CHARS, { blockCount: 100 });
      expect(error.error).toContain('xpath');
      expect(error.error).toContain('100 blocks');
    });

    it('uses generic message for non-xpath tools', () => {
      const error = buildOversizedError('list_documents', 200_000, MAX_RESULT_CHARS, {});
      expect(error.error).toContain('too large');
      expect(error.error).toContain('more specific parameters');
      expect(error.error).not.toContain('xpath');
    });

    it('handles missing blockCount gracefully', () => {
      const error = buildOversizedError('read_document', 500_000, MAX_RESULT_CHARS, {});
      expect(error.error).toContain('xpath');
      expect(error.error).not.toContain('undefined');
    });
  });

  describe('XPATH_TOOLS', () => {
    it('contains read_document and read_document_version', () => {
      expect(XPATH_TOOLS.has('read_document')).toBe(true);
      expect(XPATH_TOOLS.has('read_document_version')).toBe(true);
      expect(XPATH_TOOLS.has('list_documents')).toBe(false);
    });
  });

  describe('observed-clock baseline advancement', () => {
    // Mid-turn, the agent re-reads / receives modify conflicts that carry newer
    // clocks. The holder must advance live so a conflict can clear within the
    // same turn instead of every retry resending a frozen _baseClock.
    const DOC = 'doc-1';
    const findExecute = (description) =>
      mockTool.mock.calls.find(c => c[0].description === description)[0].execute;

    beforeEach(() => {
      mockGetToolList.mockReturnValue([
        { name: 'read_document', description: 'Read a doc', inputSchema: { type: 'object' } },
        { name: 'modify', description: 'Modify a doc', inputSchema: { type: 'object' } },
        { name: 'list_documents', description: 'List docs', inputSchema: { type: 'object' } },
      ]);
    });

    it('advances the holder from a read_document result clock', async () => {
      mockExecuteTool.mockResolvedValue({ content: 'x', clock: 54 });
      const holder = { byDoc: new Map() };
      buildTools(fakeToken, { observedClockHolder: holder });

      await findExecute('Read a doc')({ docGuid: DOC });
      expect(holder.byDoc.get(DOC)).toBe(54);
    });

    it('advances the holder from a modify conflict result clock', async () => {
      mockExecuteTool.mockResolvedValue({ changed: false, conflict: true, clock: 54 });
      const holder = { byDoc: new Map([[DOC, 50]]) };
      buildTools(fakeToken, { observedClockHolder: holder });

      await findExecute('Modify a doc')({ docGuid: DOC });
      expect(holder.byDoc.get(DOC)).toBe(54);
    });

    it('uses the advanced baseline as _baseClock on the next modify', async () => {
      const holder = { byDoc: new Map() };
      buildTools(fakeToken, { observedClockHolder: holder });

      // First a read advances the baseline to 54...
      mockExecuteTool.mockResolvedValueOnce({ content: 'x', clock: 54 });
      await findExecute('Read a doc')({ docGuid: DOC });

      // ...then a modify should send _baseClock: 54.
      mockExecuteTool.mockResolvedValueOnce({ changed: true, clock: 54 });
      await findExecute('Modify a doc')({ docGuid: DOC });

      const modifyArgs = mockExecuteTool.mock.calls.find(c => c[0] === 'modify')[1];
      expect(modifyArgs._baseClock).toBe(54);
    });

    it('does not regress the baseline when a result reports a lower clock', async () => {
      const holder = { byDoc: new Map([[DOC, 60]]) };
      buildTools(fakeToken, { observedClockHolder: holder });

      mockExecuteTool.mockResolvedValue({ content: 'x', clock: 54 });
      await findExecute('Read a doc')({ docGuid: DOC });
      expect(holder.byDoc.get(DOC)).toBe(60);
    });

    it('does not advance the baseline for non-snapshot tools', async () => {
      const holder = { byDoc: new Map() };
      buildTools(fakeToken, { observedClockHolder: holder });

      mockExecuteTool.mockResolvedValue({ documents: [], clock: 54 });
      await findExecute('List docs')({ docGuid: DOC });
      expect(holder.byDoc.has(DOC)).toBe(false);
    });
  });
});
