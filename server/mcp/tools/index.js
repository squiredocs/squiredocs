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

// Diagram rendering
const renderDiagram = require('./render-diagram');

// Version history tools
const listDocumentVersions = require('./list-document-versions');
const readDocumentVersion = require('./read-document-version');
const setDocumentVersionName = require('./set-document-version-name');
const restoreDocumentVersion = require('./restore-document-version');
const compareDocumentVersions = require('./compare-document-versions');

// Google Docs sync tools
const exportToGoogleDocs = require('./export-to-google-docs');
const importFromGoogleDocs = require('./import-from-google-docs');
const listGoogleDocs = require('./list-google-docs');

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

  // Diagram rendering (server-side render so agents can see the output)
  render_diagram: renderDiagram,

  // Version history tools
  list_document_versions: listDocumentVersions,
  read_document_version: readDocumentVersion,
  set_document_version_name: setDocumentVersionName,
  restore_document_version: restoreDocumentVersion,
  compare_document_versions: compareDocumentVersions,

  // Google Docs sync tools
  export_to_google_docs: exportToGoogleDocs,
  import_from_google_docs: importFromGoogleDocs,
  list_google_docs: listGoogleDocs,
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
  render_diagram: 'documents:read',
  get_collaborators: 'documents:read',
  list_document_versions: 'documents:read',
  read_document_version: 'documents:read',
  compare_document_versions: 'documents:read',
  // Google Docs sync
  export_to_google_docs: 'documents:read',
  import_from_google_docs: 'documents:write',
  list_google_docs: 'documents:read',
};

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
