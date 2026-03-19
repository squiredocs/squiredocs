/**
 * read_document MCP Tool
 *
 * Read document content with optional XPath filtering.
 */

const Y = require('yjs');
const agentPresence = require('../agent-presence');
const { xpath } = require('../sandbox/xpath');
const {
  createNodeSelection,
  createExpandingBlockHighlights,
} = require('../yjs/cursor-operations');
const {
  toStructuredNode,
  toTextNode,
  countCharacters,
  countBlocks,
} = require('../yjs/serialization');
const versionHistory = require('../../version-history');

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
const name = 'read_document';

const description = `Read document content with optional XPath filtering.

═══════════════════════════════════════════════════════════════════════════
OVERVIEW
═══════════════════════════════════════════════════════════════════════════

Query document content using XPath expressions. Returns structured JSON
or plain text. Use this to understand document structure before modifying.

═══════════════════════════════════════════════════════════════════════════
PARAMETERS
═══════════════════════════════════════════════════════════════════════════

- docGuid: Document UUID (required)
- xpath: XPath expression to filter results (optional)
  - If omitted, returns entire document
  - Uses same XPath syntax as modify tool
- format: "structured" or "text" (optional, default: "structured")

═══════════════════════════════════════════════════════════════════════════
XPATH EXAMPLES
═══════════════════════════════════════════════════════════════════════════

// Get all headings
xpath: "//heading"

// Get level-2 headings only
xpath: "//heading[@level=2]"

// Find paragraphs containing "TODO"
xpath: "//paragraph[contains(., 'TODO')]"

// Get all list items
xpath: "//listItem"

// Get bullet list after a specific heading
xpath: "//heading[contains(., 'Tasks')]/following-sibling::bulletList[1]"

═══════════════════════════════════════════════════════════════════════════
RETURNS
═══════════════════════════════════════════════════════════════════════════

- content: Structured array or text string (based on format)
- matchCount: Number of elements returned (when using xpath)
- blockCount: Total blocks in document
- characterCount: Total characters in result
- clock: Current document version (update counter)
- lastModifiedAt: ISO timestamp of last modification
- lastModifiedBy: Author object of last modifier
- recentAuthors: Array of authors from current editing session

═══════════════════════════════════════════════════════════════════════════
EXAMPLES
═══════════════════════════════════════════════════════════════════════════

// Read entire document
await read_document({ docGuid: "abc-123" });

// Read only headings
await read_document({
  docGuid: "abc-123",
  xpath: "//heading"
});

// Find TODOs as plain text
await read_document({
  docGuid: "abc-123",
  xpath: "//paragraph[contains(., 'TODO')]",
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
  required: ['docGuid'],
};


/**
 * Handler function for the tool
 */
async function handler(args, agentToken) {
  if (!persistenceProvider) throw new Error('read_document tool not initialized');

  const { docGuid, xpath: xpathExpr, format = 'structured' } = args;
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

  // Get document
  const session = await agentPresence.getOrCreateSession(docGuid, agentToken, 60);
  const ydoc = session.provider.doc;
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

  // Highlight the nodes being read
  if (nodes.length > 0) {
    try {
      let positions = [];

      if (xpathExpr) {
        // XPath query: cycle through each matched element
        for (const node of nodes) {
          const selection = createNodeSelection(xmlFragment, node);
          if (selection) positions.push(selection);
        }
      } else {
        // Full document read: expanding selection from start toward end
        positions = createExpandingBlockHighlights(xmlFragment, 0, nodes.length);
      }

      if (positions.length > 0) {
        agentPresence.queueHighlightSequence(session.sessionId, positions);
      }
    } catch (err) {
      // Non-fatal: log but don't fail the read
      console.warn('[read-document] Could not highlight selection:', err.message);
    }
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

  // Fetch version metadata
  const recentUpdates = await persistenceProvider.getRecentUpdatesWithUsers(docGuid, 100);

  let clock = null;
  let lastModifiedAt = null;
  let lastModifiedBy = null;
  let recentAuthors = [];

  if (recentUpdates.length > 0) {
    const lastUpdate = recentUpdates[recentUpdates.length - 1];
    clock = lastUpdate.clock;
    lastModifiedAt = lastUpdate.createdAt;
    lastModifiedBy = versionHistory.createAuthor(lastUpdate);
    recentAuthors = versionHistory.getCurrentSessionAuthors(recentUpdates);
  }

  const baseUrl = agentToken.baseUrl || '';
  const result = {
    content,
    url: `${baseUrl}/d/${docGuid}`,
    blockCount,
    characterCount,
    clock,
    lastModifiedAt,
    lastModifiedBy,
    recentAuthors,
  };

  if (xpathExpr) {
    result.matchCount = nodes.length;
  }

  return result;
}

module.exports = {
  init,
  name,
  description,
  inputSchema,
  handler,
};
