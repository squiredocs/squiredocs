/**
 * read_document MCP Tool
 *
 * Read document content with optional XPath filtering.
 */

const Y = require('yjs');
const agentPresence = require('../agent-presence');
const {
  createNodeSelection,
  createExpandingBlockHighlights,
} = require('../yjs/cursor-operations');
const { queryAndSerialize } = require('./read-helpers');
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

  // Get document (verifies access internally)
  const session = await agentPresence.getOrCreateSession(docGuid, agentToken, 60);
  const ydoc = session.provider.doc;
  const xmlFragment = ydoc.get('default', Y.XmlFragment);

  const { nodes, content, blockCount, characterCount, matchCount } = queryAndSerialize(xmlFragment, xpathExpr, format);

  // Highlight the nodes being read
  if (nodes.length > 0) {
    try {
      let positions = [];

      if (xpathExpr) {
        for (const node of nodes) {
          const selection = createNodeSelection(xmlFragment, node);
          if (selection) positions.push(selection);
        }
      } else {
        positions = createExpandingBlockHighlights(xmlFragment, 0, nodes.length);
      }

      if (positions.length > 0) {
        agentPresence.queueHighlightSequence(session.sessionId, positions);
      }
    } catch (err) {
      console.warn('[read-document] Could not highlight selection:', err.message);
    }
  }

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

  if (matchCount !== undefined) {
    result.matchCount = matchCount;
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
