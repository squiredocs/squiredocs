/**
 * get_tool_documentation Tool Tests
 *
 * The script-based tools (modify, compare_document_versions) ship short MCP
 * descriptions because clients such as Claude Code truncate tool descriptions
 * at 2KB. These tests cover:
 * 1. The full API reference is retrievable (whole and by section)
 * 2. The short descriptions point agents at get_tool_documentation
 * 3. The in-app chat agent still gets the full reference (chatDescription)
 * 4. Script errors direct agents to get_tool_documentation
 */

jest.mock('../../../documents', () => ({
  hasAccess: jest.fn().mockResolvedValue(true),
}));
jest.mock('../../../version-history', () => ({
  getVersionContent: jest.fn().mockResolvedValue({ content: [] }),
}));
jest.mock('../../sandbox', () => ({
  executeScript: jest.fn(),
  executeComparisonScript: jest.fn().mockRejectedValue(new Error('boom: doc1.nope is not a function')),
}));

const getToolDocumentation = require('../../tools/get-tool-documentation');
const modify = require('../../tools/modify');
const compare = require('../../tools/compare-document-versions');

describe('get_tool_documentation', () => {
  describe('full reference fetch', () => {
    test('returns the complete modify documentation', async () => {
      const result = await getToolDocumentation.handler({ tool: 'modify' }, {});

      expect(result.tool).toBe('modify');
      expect(result.documentation.length).toBeGreaterThan(15000);
      // Sentinels from disparate sections prove nothing major was dropped
      expect(result.documentation).toContain('BUILT-IN HELPER FUNCTIONS');
      expect(result.documentation).toContain('COMMON PITFALLS');
      expect(result.documentation).toContain('createFormattedText');
      expect(result.documentation).toContain('appendBlocks');
      expect(result.documentation).toContain('XPATH QUERY FUNCTIONS');
      expect(result.documentation).toContain('cloneBlocks');
      expect(Array.isArray(result.sections)).toBe(true);
      expect(result.sections).toContain('examples');
      expect(result.sections).toContain('common-pitfalls');
      expect(result.sections).toContain('working-with-source-documents');
    });

    test('returns the complete compare_document_versions documentation', async () => {
      const result = await getToolDocumentation.handler(
        { tool: 'compare_document_versions' },
        {}
      );

      expect(result.tool).toBe('compare_document_versions');
      expect(result.documentation).toContain('HELPER FUNCTIONS');
      expect(result.documentation).toContain('extractPlainText');
      expect(result.documentation).toContain('export default function compare');
      expect(result.sections).toContain('examples');
    });

    test('returns the export_api documentation with the curl recipe', async () => {
      const result = await getToolDocumentation.handler({ tool: 'export_api' }, {});

      expect(result.tool).toBe('export_api');
      expect(result.documentation).toContain('/api/docs/<docId>/export?format=markdown');
      expect(result.documentation).toContain('curl -sf');
      expect(result.documentation).toContain('documents:read');
      expect(result.sections).toContain('incremental-sync');
    });
  });

  describe('section fetch', () => {
    test('returns a single section', async () => {
      const result = await getToolDocumentation.handler(
        { tool: 'modify', section: 'common-pitfalls' },
        {}
      );

      expect(result.section).toBe('common-pitfalls');
      expect(result.documentation).toContain('PITFALL 1');
      // Content from other sections is excluded
      expect(result.documentation).not.toContain('BUILT-IN HELPER FUNCTIONS');
    });

    test('unknown section lists valid section ids', async () => {
      await expect(
        getToolDocumentation.handler({ tool: 'modify', section: 'nope' }, {})
      ).rejects.toThrow(/Valid sections: .*common-pitfalls/);
    });
  });

  test('unknown tool lists available tools', async () => {
    await expect(
      getToolDocumentation.handler({ tool: 'unknown_tool' }, {})
    ).rejects.toThrow(/Available: modify, compare_document_versions/);
  });
});

describe('short MCP descriptions point to get_tool_documentation', () => {
  test('modify description leads with the docs pointer', () => {
    expect(modify.description.slice(0, 500)).toContain('get_tool_documentation');
  });

  test('compare_document_versions description leads with the docs pointer', () => {
    expect(compare.description.slice(0, 500)).toContain('get_tool_documentation');
  });

  test('chatDescription carries the full reference for the in-app agent', () => {
    expect(modify.chatDescription).toContain('BUILT-IN HELPER FUNCTIONS');
    expect(modify.chatDescription).toContain('COMMON PITFALLS');
    expect(modify.chatDescription.length).toBeGreaterThan(15000);

    expect(compare.chatDescription).toContain('HELPER FUNCTIONS');
    expect(compare.chatDescription).toContain('extractLinks');
  });
});

describe('script errors direct agents to get_tool_documentation', () => {
  test('modify validation errors include the hint exactly once', async () => {
    modify.init({}); // any truthy persistence provider passes the init check

    let error;
    try {
      await modify.handler({ docGuid: 'abc-123', script: '' }, {});
    } catch (e) {
      error = e;
    }

    expect(error).toBeDefined();
    // Original validation message is preserved
    expect(error.message).toMatch(/Script validation failed/);
    // Hint present, exactly once
    expect(error.message.split('get_tool_documentation').length - 1).toBe(1);
    expect(error.message).toContain('get_tool_documentation({ tool: "modify" })');
  });

  test('modify missing-default-export errors include the hint', async () => {
    modify.init({});

    await expect(
      modify.handler({ docGuid: 'abc-123', script: 'const x = 1;' }, {})
    ).rejects.toThrow(/get_tool_documentation/);
  });

  test('compare script failures include the hint in the returned error', async () => {
    compare.init({});

    const result = await compare.handler(
      {
        docGuid: 'abc-123',
        versionId1: '1',
        versionId2: '2',
        script: 'export default function compare(doc1, doc2) { return doc1.nope(); }',
      },
      { userId: 'user-1' }
    );

    expect(result.success).toBe(false);
    // Original error is preserved and the hint is appended exactly once
    expect(result.error).toContain('boom');
    expect(result.error.split('get_tool_documentation').length - 1).toBe(1);
    expect(result.error).toContain(
      'get_tool_documentation({ tool: "compare_document_versions" })'
    );
  });
});
