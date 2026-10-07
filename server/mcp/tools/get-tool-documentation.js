/**
 * get_tool_documentation MCP Tool
 *
 * Returns the full API reference for the script-based tools (modify,
 * compare_document_versions). Their MCP-facing descriptions are short
 * summaries because clients such as Claude Code truncate tool descriptions
 * at 2KB; this tool is the guaranteed retrieval path for the complete docs.
 */

const toolDocumentation = require('./tool-documentation');
const { getInstanceConfig } = require('../../instance-config');

/**
 * Initialize the tool. No persistence needed - documentation is static.
 */
function init() {}

const name = 'get_tool_documentation';

const description = `Get the complete API docs for the script tools AND the REST byte channel (rest_api: markdown export, import, two-way sync).

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
  // The REST reference names this instance: the request's origin, else APP_URL
  // (feature 058, FR-031).
  const baseUrl = (agentToken && agentToken.baseUrl) || getInstanceConfig().appUrl;

  const entry = toolDocumentation.getDocs(tool, { baseUrl });
  if (!entry) {
    throw new Error(
      `No documentation for tool "${tool}". Available: ${toolDocumentation.DOC_TOPICS.join(', ')}`
    );
  }

  if (section) {
    const match = toolDocumentation.getSection(tool, section, { baseUrl });
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
