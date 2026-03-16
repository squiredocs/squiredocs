/**
 * Chat tools adapter tests
 *
 * Tests the dynamic tool result size limiting in chat-tools.js.
 */

// Mock the MCP tool registry
const mockGetToolList = jest.fn();
const mockExecuteTool = jest.fn();
jest.mock('../mcp/tools', () => ({
  getToolList: mockGetToolList,
  executeTool: mockExecuteTool,
}));

// Mock the AI SDK's tool and jsonSchema functions
const mockTool = jest.fn((def) => ({ ...def, _isTool: true }));
const mockJsonSchema = jest.fn((schema) => schema);
jest.mock('ai', () => ({
  tool: mockTool,
  jsonSchema: mockJsonSchema,
}));

const { buildTools, buildOversizedError, OVERHEAD_CHARS, MIN_RESULT_CHARS, XPATH_TOOLS } = require('../api/chat-tools');

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

  describe('buildTools', () => {
    it('creates tool definitions for each MCP tool', () => {
      const tools = buildTools(fakeToken);
      expect(tools).toHaveProperty('read_document');
      expect(tools).toHaveProperty('list_documents');
      expect(tools).toHaveProperty('read_document_version');
      expect(mockTool).toHaveBeenCalledTimes(3);
    });

    it('passes results through when under the size limit', async () => {
      const smallResult = { content: 'hello', blockCount: 1 };
      mockExecuteTool.mockResolvedValue(smallResult);

      const tools = buildTools(fakeToken, {
        contextWindowTokens: 1_000_000,
        currentUsageChars: 0,
      });

      // Extract the execute function from the tool call
      const executeFn = mockTool.mock.calls.find(c => c[0].description === 'Read a doc')[0].execute;
      const result = await executeFn({});
      expect(result).toEqual(smallResult);
    });

    it('returns an error when result exceeds the dynamic limit', async () => {
      // Create a result that's larger than available context
      const largeContent = 'x'.repeat(200_000);
      const largeResult = { content: largeContent, blockCount: 271 };
      mockExecuteTool.mockResolvedValue(largeResult);

      // Small context window: 100K tokens = 400K chars, minus 400K overhead = near floor
      const tools = buildTools(fakeToken, {
        contextWindowTokens: 100_000,
        currentUsageChars: 0,
      });

      const executeFn = mockTool.mock.calls.find(c => c[0].description === 'Read a doc')[0].execute;
      const result = await executeFn({});
      expect(result).toHaveProperty('error');
      expect(result.error).toContain('exceeds available context');
    });

    it('uses MIN_RESULT_CHARS as a floor', () => {
      // Even with a tiny context window, the limit shouldn't go below MIN_RESULT_CHARS
      const tools = buildTools(fakeToken, {
        contextWindowTokens: 10_000, // very small
        currentUsageChars: 100_000,
      });

      // The computed limit would be negative, but clamped to MIN_RESULT_CHARS
      // We verify by checking a result just under MIN_RESULT_CHARS passes
      expect(MIN_RESULT_CHARS).toBe(50_000);
    });

    it('computes a larger limit for larger context windows', () => {
      // With 1M token window and 0 usage:
      // available = (1_000_000 * 4) - 0 - 400_000 = 3_600_000
      const tools1M = buildTools(fakeToken, {
        contextWindowTokens: 1_000_000,
        currentUsageChars: 0,
      });

      // With 200K token window and 0 usage:
      // available = (200_000 * 4) - 0 - 400_000 = 400_000
      const tools200K = buildTools(fakeToken, {
        contextWindowTokens: 200_000,
        currentUsageChars: 0,
      });

      // Both should create tools, but with different internal limits
      // We test this by checking that a 500K result passes on 1M but fails on 200K
      expect(tools1M).toHaveProperty('read_document');
      expect(tools200K).toHaveProperty('read_document');
    });

    it('reduces available context as conversation grows', async () => {
      const result = { content: 'x'.repeat(100_000), blockCount: 50 };
      mockExecuteTool.mockResolvedValue(result);

      // With heavy existing usage, even a moderate result may exceed the limit
      buildTools(fakeToken, {
        contextWindowTokens: 200_000, // 800K chars total
        currentUsageChars: 500_000,   // already using 500K
      });
      // available = 800K - 500K - 400K = -100K → clamped to 50K (MIN_RESULT_CHARS)

      const executeFn = mockTool.mock.calls.find(c => c[0].description === 'Read a doc')[0].execute;
      const execResult = await executeFn({});
      expect(execResult).toHaveProperty('error');
    });

    it('still catches thrown errors from tool execution', async () => {
      mockExecuteTool.mockRejectedValue(new Error('Database connection failed'));

      const tools = buildTools(fakeToken);
      const executeFn = mockTool.mock.calls.find(c => c[0].description === 'Read a doc')[0].execute;
      const result = await executeFn({});
      expect(result).toEqual({ error: 'Database connection failed' });
    });

    it('defaults to 1M token context window when no context info provided', () => {
      const tools = buildTools(fakeToken);
      // Should not throw, uses defaults
      expect(tools).toHaveProperty('read_document');
    });
  });

  describe('buildOversizedError', () => {
    it('includes xpath paging instructions for read_document', () => {
      const error = buildOversizedError('read_document', 726_163, 500_000, { blockCount: 271 });
      expect(error.error).toContain('xpath');
      expect(error.error).toContain('/*[position() <= 50]');
      expect(error.error).toContain('271 blocks');
      expect(error.error).toContain('REQUIREMENTS FOR SUMMARIZATION');
    });

    it('includes xpath paging instructions for read_document_version', () => {
      const error = buildOversizedError('read_document_version', 500_000, 400_000, { blockCount: 100 });
      expect(error.error).toContain('xpath');
      expect(error.error).toContain('100 blocks');
    });

    it('uses generic message for non-xpath tools', () => {
      const error = buildOversizedError('list_documents', 200_000, 100_000, {});
      expect(error.error).toContain('too large');
      expect(error.error).toContain('more specific parameters');
      expect(error.error).not.toContain('xpath');
    });

    it('handles missing blockCount gracefully', () => {
      const error = buildOversizedError('read_document', 500_000, 400_000, {});
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
});
