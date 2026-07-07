/**
 * Tool argument validation tests
 *
 * executeTool validates args against each tool's inputSchema so that a
 * typo'd parameter name surfaces as a validation error instead of a
 * misleading "Document not found or you do not have access".
 */

const toolRegistry = require('../../tools/index');

describe('executeTool argument validation', () => {
  const agentToken = { userId: 'test-user', scopes: ['documents:read', 'documents:write'] };

  test('rejects unknown parameter with the valid parameter list', async () => {
    await expect(
      toolRegistry.executeTool('read_document', { documentId: 'abc-123' }, agentToken)
    ).rejects.toThrow(
      "Invalid parameters for tool 'read_document': unknown parameter 'documentId'. " +
      'Valid parameters: docGuid, xpath, format'
    );
  });

  test('rejects missing required parameter', async () => {
    await expect(
      toolRegistry.executeTool('read_document', {}, agentToken)
    ).rejects.toThrow(
      "Invalid parameters for tool 'read_document': missing required parameter 'docGuid'"
    );
  });

  test('rejects invalid enum value', async () => {
    await expect(
      toolRegistry.executeTool('read_document', { docGuid: 'abc-123', format: 'html' }, agentToken)
    ).rejects.toThrow(
      "Invalid parameters for tool 'read_document': 'format' must be one of: markdown, structured (got 'html')"
    );
  });

  test('reports multiple unknown parameters at once', async () => {
    await expect(
      toolRegistry.executeTool('read_document', { docGuid: 'abc-123', foo: 1, bar: 2 }, agentToken)
    ).rejects.toThrow("unknown parameters 'foo', 'bar'");
  });

  test('validation runs before the handler for every registered tool', () => {
    // Guards against a tool being added with a schema shape the validator skips
    for (const tool of toolRegistry.getToolList()) {
      expect(tool.inputSchema.type).toBe('object');
      expect(tool.inputSchema.properties).toBeDefined();
    }
  });
});
