/**
 * read_document_version MCP Tool
 *
 * Read document content at a specific version with optional XPath filtering.
 * Aligned with read_document tool but for historical versions.
 */

const Y = require('yjs');
const documents = require('../../documents');
const versionHistory = require('../../version-history');
const { queryAndSerialize } = require('./read-helpers');

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
 * Tool definition for MCP discovery
 */
const name = 'read_document_version';

const description = `Read document content as it existed at a specific version, with optional
XPath filtering. Supports the same XPath syntax and output formats as
read_document. Use it to review historical content or understand what changed
between versions.

PARAMETERS:
- docGuid: Document UUID (required)
- versionId: Version identifier (required) - UUID for named versions, or the
  clock number as a string (e.g. "42") for auto-generated versions
- xpath: XPath expression to filter results (optional)
- format: "structured" or "markdown" (optional, default "structured")

RETURNS:
- content: Structured array or Markdown string (based on format)
- matchCount: Number of elements returned (when using xpath)
- blockCount / characterCount: Size of this version / of the result
- version: Version metadata { id, name, clockStart, clockEnd, timestamp }

EXAMPLE:
await read_document_version({
  docGuid: "abc-123",
  versionId: "42",
  xpath: "//heading",
  format: "markdown"
});`;

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
 * Handler function for the tool
 */
async function handler(args, agentToken) {
  if (!persistenceProvider) throw new Error('read_document_version tool not initialized');

  const { docGuid, versionId, xpath: xpathExpr, format = 'structured' } = args;
  const userId = agentToken.userId;

  // Check document access
  if (!await documents.hasAccess(docGuid, userId)) {
    throw new Error('Document not found or you do not have access');
  }

  // Get version content
  const versionData = await versionHistory.getVersionContent(
    persistenceProvider,
    docGuid,
    versionId
  );

  // Create Y.Doc from version content
  const ydoc = new Y.Doc();
  Y.applyUpdate(ydoc, new Uint8Array(versionData.content));
  const xmlFragment = ydoc.get('default', Y.XmlFragment);

  const { content, blockCount, characterCount, matchCount } = queryAndSerialize(xmlFragment, xpathExpr, format);

  const result = {
    content,
    blockCount,
    characterCount,
    version: versionData.version,
  };

  if (matchCount !== undefined) {
    result.matchCount = matchCount;
  }

  // Cleanup
  ydoc.destroy();

  return result;
}

module.exports = {
  init,
  name,
  description,
  inputSchema,
  handler,
};
