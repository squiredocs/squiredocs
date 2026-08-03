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
const { queryAndSerialize, readDocumentAtVersion } = require('./read-helpers');
const versionHistory = require('../../version-history');
const { resolveForRows } = require('../../resupply-resolution');

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

const description = `Read document content — current, or historical via versionId — with optional
XPath filtering. Returns structured JSON or Markdown. Use this to understand
document structure before modifying. Same XPath syntax as the modify tool.

XPATH EXAMPLES:
- "//heading" - all headings
- "//heading[@level=2]" - level-2 headings only
- "//paragraph[contains(., 'TODO')]" - paragraphs containing "TODO"
- "//listItem" - all list items
- "//heading[contains(., 'Tasks')]/following-sibling::bulletList[1]" - the
  bullet list after a specific heading

RETURNS: content, blockCount, characterCount, matchCount (with xpath), and —
for current reads — clock, lastModifiedAt/By, recentAuthors. With versionId
the content is historical and the result carries version metadata instead.

AUTHORSHIP IS NOT ALWAYS KNOWABLE. Content that reached the server through
another client's reconnect is attributed to its real author when that can be
proven from the document's own history; when it cannot, the author entry is
"Synced content" with isSynced: true. That entry means "someone edited here and
we will not guess who" — never that the named client wrote it. An author whose
account was deleted appears as "Unknown author". Do not present either as a
person, and do not treat lastModifiedBy: null as "nobody" — it means the
document has no update rows at all.

EXAMPLE:
await read_document({ docGuid: "abc-123", xpath: "//heading", format: "markdown" });`;

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
      enum: ['markdown', 'structured'],
      description: 'Output format (default: "structured")',
    },
    versionId: {
      type: 'string',
      description:
        'Optional: read the document as of this version — a version UUID or a clock number as a string (e.g. "42"). Omit for current content.',
    },
  },
  required: ['docGuid'],
};


/**
 * Handler function for the tool
 */
async function handler(args, agentToken) {
  if (!persistenceProvider) throw new Error('read_document tool not initialized');

  const { docGuid, versionId, xpath: xpathExpr, format = 'structured' } = args;

  // Historical read (feature 019 DR-1): identical xpath/format semantics via
  // the shared core, but NO presence session and NO highlights — reading a
  // version must not move the live cursor — and the version result shape.
  if (versionId !== undefined) {
    return readDocumentAtVersion(persistenceProvider, {
      docGuid,
      versionId,
      xpathExpr,
      format,
      userId: agentToken.userId,
    });
  }

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
    // Feature 045: this feed is the one agents ACT on, so it obeys the same
    // resolution the timeline does — resolved once for this window, consumed by
    // both fields. `lastModifiedBy` takes the single-slot collapse (RBD-045-9,
    // RBD-045-12); `recentAuthors` may therefore include the "Synced content"
    // entry. The response shape is unchanged apart from that entry's additive
    // isSynced marker; a relayer is never reported as an author either way.
    const resolution = await resolveForRows(persistenceProvider, docGuid, recentUpdates);
    lastModifiedBy = versionHistory.authorForSingleSlot(lastUpdate, resolution);
    recentAuthors = versionHistory.getCurrentSessionAuthors(recentUpdates, { resolution });
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
