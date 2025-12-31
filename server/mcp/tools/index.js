/**
 * MCP Tool Registry
 *
 * Manages registration and execution of MCP tools.
 */

const listDocuments = require('./list-documents');
const createDocument = require('./create-document');
const shareDocument = require('./share-document');
const setDocumentTitle = require('./set-document-title');
const getDocumentStructure = require('./get-document-structure');
const getDocumentSchema = require('./get-document-schema');
const readDocumentBlocks = require('./read-document-blocks');
const selectTextRange = require('./select-text-range');
const insertDocumentBlocks = require('./insert-document-blocks');
const deleteDocumentBlocks = require('./delete-document-blocks');
const replaceDocumentBlocks = require('./replace-document-blocks');
const replaceText = require('./replace-text');
const insertText = require('./insert-text');
const deleteText = require('./delete-text');
const applyMarks = require('./apply-marks');
const searchDocument = require('./search-document');
const getDocumentText = require('./get-document-text');
const agentPresence = require('../agent-presence');

// All available tools
const tools = {
  list_documents: listDocuments,
  create_document: createDocument,
  share_document: shareDocument,
  set_document_title: setDocumentTitle,
  get_document_structure: getDocumentStructure,
  get_document_schema: getDocumentSchema,
  read_document_blocks: readDocumentBlocks,
  select_text_range: selectTextRange,
  insert_document_blocks: insertDocumentBlocks,
  delete_document_blocks: deleteDocumentBlocks,
  replace_document_blocks: replaceDocumentBlocks,
  replace_text: replaceText,
  insert_text: insertText,
  delete_text: deleteText,
  apply_marks: applyMarks,
  search_document: searchDocument,
  get_document_text: getDocumentText,
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
