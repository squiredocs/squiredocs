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
      // Chat-only tools are always added (import_markdown, insert_image,
      // view_image, view_svg_blocks).
      expect(tools).toHaveProperty('import_markdown');
      expect(tools).toHaveProperty('insert_image');
      expect(tools).toHaveProperty('view_image');
      expect(tools).toHaveProperty('view_svg_blocks');
      expect(mockTool).toHaveBeenCalledTimes(7); // 3 MCP tools + 4 chat-only tools
    });

    it('omits the vision tools for a text-only model (supportsImages:false)', () => {
      // A GLM (text-only) model 404s if the agent feeds image bytes back via a
      // tool result, so view_image/view_svg_blocks/insert_image must not be
      // offered. import_markdown stays (it never sends image content).
      const tools = buildTools(fakeToken, { supportsImages: false });
      expect(tools).not.toHaveProperty('insert_image');
      expect(tools).not.toHaveProperty('view_image');
      expect(tools).not.toHaveProperty('view_svg_blocks');
      expect(tools).toHaveProperty('import_markdown');
      // Non-image tools are unaffected.
      expect(tools).toHaveProperty('read_document');
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

    it('uses the generic message for read_document_version (left the chat surface — 019 DR-1)', () => {
      const error = buildOversizedError('read_document_version', 500_000, MAX_RESULT_CHARS, { blockCount: 100 });
      expect(error.error).toContain('too large');
      expect(error.error).not.toContain('xpath');
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
    it('contains read_document but no longer read_document_version (019 DR-1)', () => {
      expect(XPATH_TOOLS.has('read_document')).toBe(true);
      // read_document_version left the chat surface — paging guidance keys
      // off read_document (with versionId) now.
      expect(XPATH_TOOLS.has('read_document_version')).toBe(false);
      expect(XPATH_TOOLS.has('list_documents')).toBe(false);
    });

    it('oversized-result paging guidance still fires for read_document', () => {
      const error = buildOversizedError('read_document', 500_000, MAX_RESULT_CHARS, { blockCount: 100 });
      expect(error.error).toContain('xpath');
      expect(error.error).toContain('100 blocks');
    });
  });

  describe('derived chat tool set (feature 019 DR-1 / X1 — real registry)', () => {
    // chat-tools builds its tool map from toolRegistry.getToolList(), so the
    // chat agent's exposure follows the advertised registry. Both changes here
    // are CONSCIOUS decisions, not accidents (design amendment c790282 defers
    // chat/MCP exposure partitioning):
    // - read_document_version leaves chat's list with the registry (hidden
    //   alias is not advertised);
    // - import_markdown_file APPEARS in chat: the in-app chat agent is
    //   shell-less, but the recipe result's guidance field (RBD-5) covers
    //   exactly that caller, and the claim-secret residue class is identical
    //   to create_access_token, which chat already exposes.
    it('drops read_document_version and includes import_markdown_file', () => {
      const realRegistry = jest.requireActual('../mcp/tools');
      mockGetToolList.mockReturnValue(realRegistry.getToolList());
      mockGetTool.mockImplementation((name) => realRegistry.getTool(name));
      try {
        const tools = buildTools(fakeToken);
        expect(tools).not.toHaveProperty('read_document_version');
        expect(tools).toHaveProperty('import_markdown_file');
        // The advertised registry the chat set derives from is the final 16.
        expect(realRegistry.getToolList()).toHaveLength(16);

        // RBD-5 conscious-exposure guard: the tool that chat now exposes must
        // itself carry the shell-less signpost in its static surface (the
        // result-level guidance is asserted in import-markdown-file.test.js).
        const mod = realRegistry.getTool('import_markdown_file');
        expect(mod.description).toMatch(/no shell/i);
      } finally {
        // jest.clearAllMocks() clears calls but NOT implementations — restore
        // the default so later tests see the file-level mock again.
        mockGetTool.mockImplementation(() => null);
      }
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

    it('advances the holder from a modify conflict that echoed content', async () => {
      mockExecuteTool.mockResolvedValue({ changed: false, conflict: true, clock: 54, content: [] });
      const holder = { byDoc: new Map([[DOC, 50]]) };
      buildTools(fakeToken, { observedClockHolder: holder });

      await findExecute('Modify a doc')({ docGuid: DOC });
      expect(holder.byDoc.get(DOC)).toBe(54);
    });

    it('does NOT advance the holder from a content-less modify conflict', async () => {
      // Without the echoed content the agent has not seen the other author's
      // edits — a blind retry must re-trip the conflict guard until it
      // read_documents (which advances the clock).
      mockExecuteTool.mockResolvedValue({
        changed: false, conflict: true, clock: 54, contentOmitted: true,
      });
      const holder = { byDoc: new Map([[DOC, 50]]) };
      buildTools(fakeToken, { observedClockHolder: holder });

      await findExecute('Modify a doc')({ docGuid: DOC });
      expect(holder.byDoc.get(DOC)).toBe(50);
    });

    it('advances the holder from a modify success without echoed content', async () => {
      mockExecuteTool.mockResolvedValue({ changed: true, clock: 54, contentOmitted: true });
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

    it('keys _baseClock off the target docGuid when sourceDocGuids is present', async () => {
      // Multi-doc modify: staleness plumbing must track the writable target
      // only — read-only sources have no conflict semantics.
      const holder = { byDoc: new Map([[DOC, 54], ['src-1', 99]]) };
      buildTools(fakeToken, { observedClockHolder: holder });

      mockExecuteTool.mockResolvedValueOnce({ changed: true, clock: 55 });
      await findExecute('Modify a doc')({ docGuid: DOC, sourceDocGuids: ['src-1'] });

      const modifyArgs = mockExecuteTool.mock.calls.find(c => c[0] === 'modify')[1];
      expect(modifyArgs._baseClock).toBe(54);
      expect(modifyArgs.sourceDocGuids).toEqual(['src-1']);
      // Source baseline untouched by the modify result's clock
      expect(holder.byDoc.get('src-1')).toBe(99);
      expect(holder.byDoc.get(DOC)).toBe(55);
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
