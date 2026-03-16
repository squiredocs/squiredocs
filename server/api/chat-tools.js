/**
 * AI SDK Tool Adapter
 *
 * Wraps existing MCP tool modules as AI SDK `tool()` definitions
 * so the chat endpoint can use them with streamText().
 *
 * Tool results are capped at a static size limit. Large documents can be
 * read in chunks via xpath, and the reactive compaction system handles
 * context overflow automatically.
 *
 * Imports from 'ai' are lazy-loaded (called from chat.js at request time).
 */
const toolRegistry = require('../mcp/tools');

// Static cap for any single tool result. Documents larger than this should
// be read in chunks via xpath. Reactive compaction handles overall context.
const MAX_RESULT_CHARS = 100_000;

// Tools that support xpath for reading documents in chunks
const XPATH_TOOLS = new Set(['read_document', 'read_document_version']);

/**
 * Build an error message for an oversized tool result.
 * For xpath-capable tools, includes paging instructions modeled on
 * Claude Code's large-result handling.
 */
function buildOversizedError(toolName, resultChars, maxChars, result) {
  const fmtResult = resultChars.toLocaleString();
  const fmtMax = maxChars.toLocaleString();

  if (XPATH_TOOLS.has(toolName)) {
    const blockCount = result?.blockCount;
    const blockInfo = blockCount ? ` The document has ${blockCount} blocks.` : '';
    return {
      error: `Error: ${toolName} result (${fmtResult} characters) exceeds available context `
        + `(~${fmtMax} characters remaining).${blockInfo}\n\n`
        + 'The document is too large to read in full. Use the xpath parameter to page through '
        + 'it in chunks of top-level blocks:\n'
        + '- Page 1: xpath: "/*[position() <= 50]"\n'
        + '- Page 2: xpath: "/*[position() > 50 and position() <= 100]"\n'
        + (blockCount
          ? `- Continue until all ${blockCount} blocks are covered\n`
          : '- Continue with successive ranges until all blocks are covered\n')
        + '\nYou can also search for specific content:\n'
        + '- xpath: "//heading" \u2014 get document structure\n'
        + '- xpath: "//paragraph[contains(., \'keyword\')]" \u2014 find specific text\n'
        + '\nREQUIREMENTS FOR SUMMARIZATION/ANALYSIS/REVIEW:\n'
        + '- You MUST read the content in sequential chunks until you have covered all blocks\n'
        + '- Before producing ANY summary or analysis, you MUST describe what portions you have read\n'
        + '- If you have not read the entire document, you MUST explicitly state this',
    };
  }

  return {
    error: `Tool result too large (${fmtResult} characters, ~${fmtMax} remaining). `
      + 'Try using more specific parameters to narrow the result.',
  };
}

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
          const result = await toolRegistry.executeTool(name, args, syntheticAgentToken);
          const serialized = JSON.stringify(result);
          if (serialized.length > MAX_RESULT_CHARS) {
            console.warn(
              `[chat-tools] "${name}" result too large: ${serialized.length.toLocaleString()} chars `
              + `(limit: ${MAX_RESULT_CHARS.toLocaleString()})`
            );
            return buildOversizedError(name, serialized.length, MAX_RESULT_CHARS, result);
          }
          return result;
        } catch (error) {
          return { error: error.message };
        }
      },
    });
  }

  return aiTools;
}

module.exports = { buildTools, MAX_RESULT_CHARS, XPATH_TOOLS, buildOversizedError };
