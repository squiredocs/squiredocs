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

// Session and reading tools
const readDocument = require('./read-document');
const getCollaborators = require('./get-collaborators');
const undo = require('./undo');
const redo = require('./redo');

// Document modification
const modify = require('./modify');

// Documentation for the script-based tools (modify, compare_document_versions)
const getToolDocumentation = require('./get-tool-documentation');

// Version history tools
const listDocumentVersions = require('./list-document-versions');
const readDocumentVersion = require('./read-document-version');
const setDocumentVersionName = require('./set-document-version-name');
const restoreDocumentVersion = require('./restore-document-version');
const compareDocumentVersions = require('./compare-document-versions');

const agentPresence = require('../agent-presence'); // Still needed for init()

// All available tools
const tools = {
  // Document management
  list_documents: listDocuments,
  create_document: createDocument,
  share_document: shareDocument,
  set_document_title: setDocumentTitle,

  // Session and reading tools
  read_document: readDocument,
  get_collaborators: getCollaborators,
  undo: undo,
  redo: redo,

  // Document modification (replaces 15 deprecated editing tools)
  modify: modify,

  // Full API docs for the script-based tools (MCP clients truncate descriptions)
  get_tool_documentation: getToolDocumentation,

  // Version history tools
  list_document_versions: listDocumentVersions,
  read_document_version: readDocumentVersion,
  set_document_version_name: setDocumentVersionName,
  restore_document_version: restoreDocumentVersion,
  compare_document_versions: compareDocumentVersions,
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

// Required scopes per tool
const TOOL_SCOPES = {
  // Write operations
  modify: 'documents:write',
  create_document: 'documents:write',
  share_document: 'documents:write',
  set_document_title: 'documents:write',
  undo: 'documents:write',
  redo: 'documents:write',
  set_document_version_name: 'documents:write',
  restore_document_version: 'documents:write',
  // Read operations
  list_documents: 'documents:read',
  read_document: 'documents:read',
  get_collaborators: 'documents:read',
  list_document_versions: 'documents:read',
  read_document_version: 'documents:read',
  compare_document_versions: 'documents:read',
  get_tool_documentation: 'documents:read',
};

/**
 * Validate tool arguments against the tool's inputSchema.
 *
 * Without this, a typo'd parameter name (e.g. documentId instead of docGuid)
 * falls through to the handler as an undefined docGuid and surfaces as
 * "Document not found or you do not have access" — a misleading permissions
 * error. Checks unknown params, missing required params, and enum membership.
 */
function validateToolArgs(name, inputSchema, args) {
  if (!inputSchema || inputSchema.type !== 'object' || !inputSchema.properties) return;
  const properties = inputSchema.properties;
  const valid = Object.keys(properties).join(', ');

  // Underscore-prefixed params are internal, injected by trusted server-side
  // callers rather than typed by a model — e.g. the chat layer adds _baseClock
  // to modify calls for conflict detection. They are deliberately absent from
  // the public schema (exposing them would invite models to set them), so the
  // unknown-param check must not reject them.
  const unknown = Object.keys(args).filter((k) => !(k in properties) && !k.startsWith('_'));
  if (unknown.length > 0) {
    throw new Error(
      `Invalid parameters for tool '${name}': unknown parameter${unknown.length > 1 ? 's' : ''} ` +
      `${unknown.map((u) => `'${u}'`).join(', ')}. Valid parameters: ${valid}`
    );
  }

  for (const req of inputSchema.required || []) {
    if (args[req] === undefined || args[req] === null) {
      throw new Error(
        `Invalid parameters for tool '${name}': missing required parameter '${req}'. Valid parameters: ${valid}`
      );
    }
  }

  for (const [key, spec] of Object.entries(properties)) {
    if (args[key] !== undefined && spec.enum && !spec.enum.includes(args[key])) {
      throw new Error(
        `Invalid parameters for tool '${name}': '${key}' must be one of: ${spec.enum.join(', ')} (got '${args[key]}')`
      );
    }
  }
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

  validateToolArgs(name, tool.inputSchema, args);

  // Check scope authorization
  const requiredScope = TOOL_SCOPES[name];
  if (requiredScope && agentToken) {
    const agentScopes = agentToken.scopes || [];
    if (!agentScopes.includes(requiredScope)) {
      throw new Error(`Insufficient scope: '${requiredScope}' is required for tool '${name}'. Granted scopes: ${agentScopes.join(', ')}`);
    }
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
