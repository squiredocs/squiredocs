/**
 * read_document_version MCP Tool — HIDDEN deprecation alias (feature 019 DR-1).
 *
 * read_document absorbed this tool's behavior via its optional versionId
 * parameter. This module is a thin delegate to the shared historical-read
 * core in read-helpers.js: it left getToolList() (not advertised to any
 * client) but is still accepted by executeTool for a transition window so
 * connected clients mid-conversation keep working. Name, schema, and handler
 * behavior are unchanged.
 */

const { readDocumentAtVersion } = require('./read-helpers');

// Persistence provider - set by init function
let persistenceProvider = null;

/**
 * Initialize the tool with a persistence provider
 * @param {PostgresPersistence} persistence - PostgreSQL persistence provider
 */
function init(persistence) {
  persistenceProvider = persistence;
}

/**
 * Tool definition (kept for the execute path; no longer advertised)
 */
const name = 'read_document_version';

const description = `DEPRECATED alias: use read_document with the versionId parameter instead.
Reads document content as it existed at a specific version, with the same
XPath syntax and output formats as read_document.

RETURNS: content, blockCount, characterCount, matchCount (with xpath), and
version metadata { id, name, clockStart, clockEnd, timestamp }.`;

const inputSchema = {
  type: 'object',
  properties: {
    docGuid: {
      type: 'string',
      format: 'uuid',
      description: 'The document UUID',
    },
    versionId: {
      type: 'string',
      description: 'Version ID (UUID or clock number as string)',
    },
    xpath: {
      type: 'string',
      description: 'XPath expression to filter results (optional)',
    },
    format: {
      type: 'string',
      enum: ['markdown', 'structured'],
      description: 'Output format (default: "structured")',
    },
  },
  required: ['docGuid', 'versionId'],
};

/**
 * Handler function for the tool — delegates to the shared historical core.
 */
async function handler(args, agentToken) {
  if (!persistenceProvider) throw new Error('read_document_version tool not initialized');

  const { docGuid, versionId, xpath: xpathExpr, format = 'structured' } = args;

  return readDocumentAtVersion(persistenceProvider, {
    docGuid,
    versionId,
    xpathExpr,
    format,
    userId: agentToken.userId,
  });
}

module.exports = {
  init,
  name,
  description,
  inputSchema,
  handler,
};
