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

// V2 cursor-based editing tools
const openDocument = require('./open-document');
const closeDocument = require('./close-document');
const readDocument = require('./read-document');
const readContext = require('./read-context');
const getSelection = require('./get-selection');
const getCollaborators = require('./get-collaborators');
const goto = require('./goto');
const move = require('./move');
const find = require('./find');
const select = require('./select');
const insert = require('./insert');
const deleteOp = require('./delete');
const format = require('./format');
const insertBlock = require('./insert-block');
const setBlockType = require('./set-block-type');
const undo = require('./undo');
const redo = require('./redo');

// V2 hierarchy manipulation tools
const indentBlock = require('./indent-block');
const outdentBlock = require('./outdent-block');
const nestBlock = require('./nest-block');

const agentPresence = require('../agent-presence');

// All available tools
const tools = {
  // Document management
  list_documents: listDocuments,
  create_document: createDocument,
  share_document: shareDocument,
  set_document_title: setDocumentTitle,

  // V2 cursor-based editing tools
  open_document: openDocument,
  close_document: closeDocument,
  read_document: readDocument,
  read_context: readContext,
  get_selection: getSelection,
  get_collaborators: getCollaborators,
  goto: goto,
  move: move,
  find: find,
  select: select,
  insert: insert,
  delete: deleteOp,
  format: format,
  insert_block: insertBlock,
  set_block_type: setBlockType,
  undo: undo,
  redo: redo,

  // V2 hierarchy manipulation tools
  indent_block: indentBlock,
  outdent_block: outdentBlock,
  nest_block: nestBlock,
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

  // If the tool operates on a document (has docGuid), set agent presence
  // This makes the agent appear as an active user in the UI for 1 minute
  if (args.docGuid && agentToken.rawToken) {
    try {
      // Set presence in the background - don't block tool execution
      agentPresence.setAgentPresence(args.docGuid, agentToken, 60).catch((error) => {
        // Log but don't fail the tool execution if presence fails
        console.error(`[executeTool] Failed to set agent presence for ${name}:`, error.message);
      });
    } catch (error) {
      // Presence is best-effort - log but continue with tool execution
      console.error(`[executeTool] Error setting agent presence for ${name}:`, error.message);
    }
  }

  return tool.handler(args, agentToken);
}

module.exports = {
  init,
  getToolList,
  getTool,
  executeTool,
};
