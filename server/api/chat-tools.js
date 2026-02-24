/**
 * AI SDK Tool Adapter
 *
 * Wraps existing MCP tool modules as AI SDK `tool()` definitions
 * so the chat endpoint can use them with streamText().
 *
 * Imports from 'ai' are lazy-loaded (called from chat.js at request time).
 */
const toolRegistry = require('../mcp/tools');

/**
 * Build AI SDK tool definitions from the MCP tool registry.
 * @param {object} syntheticAgentToken - Token object for tool execution context
 * @returns {object} Map of tool name -> AI SDK tool definition
 */
function buildTools(syntheticAgentToken) {
  const { tool, jsonSchema } = require('ai');
  const mcpTools = toolRegistry.getToolList();
  const aiTools = {};

  for (const { name, description, inputSchema } of mcpTools) {
    aiTools[name] = tool({
      description,
      inputSchema: jsonSchema(inputSchema),
      execute: async (args) => {
        try {
          return await toolRegistry.executeTool(name, args, syntheticAgentToken);
        } catch (error) {
          return { error: error.message };
        }
      },
    });
  }

  return aiTools;
}

module.exports = { buildTools };
