/**
 * read_document_version MCP Tool
 *
 * Read document content at a specific version with optional XPath filtering.
 * Aligned with read_document tool but for historical versions.
 */

const Y = require('yjs');
const versionHistory = require('../../version-history');
const { xpath } = require('../sandbox/xpath');
const {
  toStructuredNode,
  toTextNode,
  countCharacters,
  countBlocks,
} = require('../yjs/serialization');

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
  - "auto-{clock}" for auto-generated versions (e.g., "auto-42")
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
      description: 'Version ID (UUID or "auto-{clock}")',
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
  const pool = persistenceProvider.getPool();

  // Check document access
  const accessResult = await pool.query(
    `SELECT d.id, ds.role
     FROM documents d
     JOIN document_shares ds ON d.id = ds.doc_id AND ds.user_id = $2
     WHERE d.id = $1`,
    [docGuid, userId]
  );

  if (accessResult.rows.length === 0) {
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

  const allBlocks = xmlFragment.toArray();
  const blockCount = countBlocks(xmlFragment);

  // Get nodes to serialize (either xpath results or all blocks)
  let nodes;
  if (xpathExpr) {
    try {
      nodes = xpath(xpathExpr, xmlFragment);
    } catch (err) {
      throw new Error(`Invalid XPath expression: ${err.message}`);
    }
  } else {
    nodes = allBlocks;
  }

  // Serialize based on format
  let content;
  if (format === 'text') {
    content = nodes.map(toTextNode).join('').trim();
  } else {
    content = nodes.map(toStructuredNode).filter(Boolean);
  }

  // Count characters in results
  const characterCount = countCharacters(nodes);

  const result = {
    content,
    blockCount,
    characterCount,
    version: versionData.version,
  };

  if (xpathExpr) {
    result.matchCount = nodes.length;
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
