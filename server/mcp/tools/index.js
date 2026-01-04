/**
 * MCP Tool Registry
 *
 * Manages registration and execution of MCP tools.
 */

// Document management tools (keep these)
const listDocuments = require('./list-documents');
const createDocument = require('./create-document');
const shareDocument = require('./share-document');
const setDocumentTitle = require('./set-document-title');

// Session and reading tools (kept)
const openDocument = require('./open-document');
const closeDocument = require('./close-document');
const readDocument = require('./read-document');
const readContext = require('./read-context');
const getSelection = require('./get-selection');
const getCollaborators = require('./get-collaborators');
const undo = require('./undo');
const redo = require('./redo');

// Sandbox execution
const executeScript = require('./execute-script');

const agentPresence = require('../agent-presence'); // Still needed for init()

// All available tools
const tools = {
  // Document management
  list_documents: listDocuments,
  create_document: createDocument,
  share_document: shareDocument,
  set_document_title: setDocumentTitle,

  // Session and reading tools
  open_document: openDocument,
  close_document: closeDocument,
  read_document: readDocument,
  read_context: readContext,
  get_selection: getSelection,
  get_collaborators: getCollaborators,
  undo: undo,
  redo: redo,

  // Sandbox execution (replaces 15 deprecated editing tools)
  execute_script: executeScript,
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

  // Initialize agent presence manager
  agentPresence.init(persistence);
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

  // Note: Agent presence is managed by individual tool handlers via getOrCreateSession()
  // Each tool that needs presence calls agentPresence.getOrCreateSession() which handles
  // WebSocket connection and awareness state. No need to set presence here.

  return tool.handler(args, agentToken);
}

module.exports = {
  init,
  getToolList,
  getTool,
  executeTool,
};
