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

const description = `Read document content at a specific version with optional XPath filtering.

═══════════════════════════════════════════════════════════════════════════
OVERVIEW
═══════════════════════════════════════════════════════════════════════════

Read the content of a document as it existed at a specific point in its
version history. Supports the same XPath filtering and output formats as
read_document. Use this to review historical content or understand what
changed between versions.

═══════════════════════════════════════════════════════════════════════════
PARAMETERS
═══════════════════════════════════════════════════════════════════════════

- docGuid: Document UUID (required)
- versionId: Version identifier (required)
  - UUID for named versions
  - Clock number as string for auto-generated versions (e.g., "42")
- xpath: XPath expression to filter results (optional)
  - Same syntax as read_document tool
- format: "structured" or "text" (optional, default: "structured")

═══════════════════════════════════════════════════════════════════════════
XPATH EXAMPLES
═══════════════════════════════════════════════════════════════════════════

// Get all headings from version
xpath: "//heading"

// Find paragraphs containing specific text
xpath: "//paragraph[contains(., 'TODO')]"

// Get list items
xpath: "//listItem"

═══════════════════════════════════════════════════════════════════════════
RETURNS
═══════════════════════════════════════════════════════════════════════════

- content: Structured array or text string (based on format parameter)
- matchCount: Number of elements returned (when using xpath)
- blockCount: Total blocks in this version
- characterCount: Total characters in results
- version: Version metadata with id, name, clockStart, clockEnd, timestamp

═══════════════════════════════════════════════════════════════════════════
EXAMPLES
═══════════════════════════════════════════════════════════════════════════

// Read entire version
await read_document_version({
  docGuid: "abc-123",
  versionId: "auto-42"
});

// Read named version
await read_document_version({
  docGuid: "abc-123",
  versionId: "550e8400-e29b-41d4-a716-446655440000"
});

// Find headings in historical version
await read_document_version({
  docGuid: "abc-123",
  versionId: "auto-42",
  xpath: "//heading",
  format: "text"
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
      enum: ['text', 'structured'],
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
