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
const { webFetch } = require('./web-fetch');

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
 * Build provider-specific webSearch and universal webFetch tools.
 * @param {string} providerName - 'anthropic' or 'google'
 * @param {object} provider - AI SDK provider factory (e.g. google or anthropic)
 * @returns {object} { webSearch, webFetch } tool definitions
 */
function buildWebTools(providerName, provider) {
  const { tool, generateText, jsonSchema } = require('ai');
  const tools = {};

  // Provider-specific web search
  if (providerName === 'anthropic') {
    tools.webSearch = provider.tools.webSearch_20250305();
  } else if (providerName === 'google') {
    // Gemini can't combine googleSearch with function tools in one request,
    // so we wrap it as a function tool that makes a separate generateText call.
    const searchModel = provider('gemini-2.5-flash');
    tools.webSearch = tool({
      description: 'Search the web for current information using Google Search. Returns a grounded summary of search results. You MUST provide a query.',
      inputSchema: jsonSchema({
        type: 'object',
        properties: {
          query: { type: 'string', description: 'The search query to look up on the web' },
        },
        required: ['query'],
      }),
      execute: async (args) => {
        const query = args.query || (typeof args === 'string' ? args : JSON.stringify(args));
        console.log('[Chat API] webSearch query:', query);
        const searchResult = await generateText({
          model: searchModel,
          maxTokens: 1024,
          tools: { googleSearch: provider.tools.googleSearch({}) },
          prompt: `Search the web and summarize what you find for: ${query}`,
        });
        return searchResult.text || 'No results found.';
      },
    });
  }

  // Universal webFetch — works the same for all providers
  tools.webFetch = tool({
    description: 'Fetch and read the contents of a web page at a specific URL. Use this when the user asks you to read, review, or summarize a web page, or when you need to check a link.',
    inputSchema: jsonSchema({
      type: 'object',
      properties: {
        url: { type: 'string', description: 'The URL to fetch and read' },
      },
      required: ['url'],
    }),
    execute: async (args) => {
      const url = args.url || (typeof args === 'string' ? args : '');
      console.log('[Chat API] webFetch url:', url);
      try {
        const result = await webFetch(url);
        return result.truncated ? result.content + '\n\n[Content truncated]' : result.content;
      } catch (err) {
        console.error('[Chat API] webFetch error:', err.message);
        return 'Could not fetch the requested URL.';
      }
    },
  });

  return tools;
}

/**
 * Build AI SDK tool definitions from the MCP tool registry,
 * plus provider-specific web tools when provider info is given.
 * @param {object} syntheticAgentToken - Token object for tool execution context
 * @param {object} [opts] - Optional provider info for web tools
 * @param {string} [opts.providerName] - 'anthropic' or 'google'
 * @param {object} [opts.provider] - AI SDK provider factory
 * @returns {object} Map of tool name -> AI SDK tool definition
 */
function buildTools(syntheticAgentToken, { providerName, provider, pool } = {}) {
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
          // Enrich doc-scoped tool results with title for chat UI labels
          if (pool && args.docGuid && result && typeof result === 'object' && !result.error) {
            try {
              const titleRow = await pool.query('SELECT title FROM documents WHERE id = $1', [args.docGuid]);
              result.docTitle = titleRow.rows[0]?.title || null;
            } catch (_) { /* best-effort */ }
          }
          return result;
        } catch (error) {
          return { error: error.message };
        }
      },
    });
  }

  if (providerName && provider) {
    Object.assign(aiTools, buildWebTools(providerName, provider));
  }

  return aiTools;
}

module.exports = { buildTools, buildWebTools, MAX_RESULT_CHARS, XPATH_TOOLS, buildOversizedError };
