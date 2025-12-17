/**
 * MCP Tool Registry
 *
 * Manages registration and execution of MCP tools.
 */

const listDocuments = require('./list-documents');
const getDocument = require('./get-document');
const updateDocument = require('./update-document');
const createDocument = require('./create-document');
const shareDocument = require('./share-document');
const setDocumentTitle = require('./set-document-title');
const setAgentSelection = require('./set-agent-selection');

// All available tools
const tools = {
  list_documents: listDocuments,
  get_document: getDocument,
  update_document: updateDocument,
  create_document: createDocument,
  share_document: shareDocument,
  set_document_title: setDocumentTitle,
  set_agent_selection: setAgentSelection,
};

/**
 * Initialize all tools with the persistence provider
 * @param {PostgresPersistence} persistence - PostgreSQL persistence provider
 */
function init(persistence) {
  Object.values(tools).forEach((tool) => {
    if (tool.init) {
      tool.init(persistence);
    }
  });
}

/**
 * Get list of all tools for MCP discovery
 * @returns {Array} Array of tool definitions
 */
function getToolList() {
  return Object.values(tools).map((tool) => ({
    name: tool.name,
    description: tool.description,
    inputSchema: tool.inputSchema,
  }));
}

/**
 * Get a specific tool by name
 * @param {string} name - Tool name
 * @returns {object|null} Tool module or null
 */
function getTool(name) {
  return tools[name] || null;
}

/**
 * Execute a tool
 * @param {string} name - Tool name
 * @param {object} args - Tool arguments
 * @param {object} agentToken - Decoded agent JWT token
 * @returns {Promise<object>} Tool result
 */
async function executeTool(name, args, agentToken) {
  const tool = getTool(name);

  if (!tool) {
    throw new Error(`Unknown tool: ${name}`);
  }

  return tool.handler(args, agentToken);
}

module.exports = {
  init,
  getToolList,
  getTool,
  executeTool,
};
