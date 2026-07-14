/**
 * get_tool_documentation MCP Tool
 *
 * Returns the full API reference for the script-based tools (modify,
 * compare_document_versions). Their MCP-facing descriptions are short
 * summaries because clients such as Claude Code truncate tool descriptions
 * at 2KB; this tool is the guaranteed retrieval path for the complete docs.
 */

const toolDocumentation = require('./tool-documentation');

/**
 * Initialize the tool. No persistence needed - documentation is static.
 */
function init() {}

const name = 'get_tool_documentation';

const description = `Get the complete API documentation for this server's script-based tools.

MCP clients truncate long tool descriptions, so the modify and
compare_document_versions descriptions are short summaries. Call this tool to
retrieve their full scripting API reference (built-in helper functions, XPath
targeting, the Yjs API, worked examples, and common pitfalls) BEFORE writing
your first script, or when a script error message directs you here.

PARAMETERS
- tool: Which tool to get documentation for: ${toolDocumentation.DOC_TOPICS.join(' | ')} (required).
  rest_api covers the REST byte channel in BOTH directions — markdown export,
  import, and two-way repo sync (export_api is an alias of it).
- section: Optional section id to fetch a single section instead of the full
  reference. Omit it on your first call; the full reference lists the
  available section ids.

Read-only; takes no document arguments.`;

const inputSchema = {
  type: 'object',
  properties: {
    tool: {
      type: 'string',
      enum: toolDocumentation.DOC_TOPICS,
      description: 'The tool to get the full API documentation for',
    },
    section: {
      type: 'string',
      description:
        'Optional: return only this documentation section (e.g. "examples", "common-pitfalls"). Omit for the full reference.',
    },
  },
  required: ['tool'],
};

/**
 * Tool handler
 * @param {object} args - Tool arguments
 * @param {object} agentToken - Decoded agent JWT token (unused; docs are static)
 * @returns {Promise<object>}
 */
async function handler(args, agentToken) {
  const { tool, section } = args;

  const entry = toolDocumentation.getDocs(tool);
  if (!entry) {
    throw new Error(
      `No documentation for tool "${tool}". Available: ${toolDocumentation.DOC_TOPICS.join(', ')}`
    );
  }

  if (section) {
    const match = toolDocumentation.getSection(tool, section);
    if (!match) {
      throw new Error(
        `Unknown section "${section}" for tool "${tool}". Valid sections: ${entry.sectionIds.join(', ')}`
      );
    }
    return {
      tool,
      section: match.id,
      title: match.title,
      documentation: match.text,
    };
  }

  return {
    tool,
    documentation: entry.full,
    sections: entry.sectionIds,
  };
}

module.exports = {
  name,
  description,
  inputSchema,
  handler,
  init,
};
