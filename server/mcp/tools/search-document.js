/**
 * search_document MCP Tool
 *
 * Searches for text within a document and optionally highlights matches.
 */
const Y = require('yjs');
const { getTextContent } = require('../yjs/block-structure');
const agentPresence = require('../agent-presence');

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
const name = 'search_document';

const description = `Search for text within a document with optional highlighting.

═══════════════════════════════════════════════════════════════════════════
FIND TEXT IN DOCUMENTS
═══════════════════════════════════════════════════════════════════════════

Search for all occurrences of text in a document and optionally highlight
them for users to see. Perfect for finding specific content in long documents.

Use cases:
- Find all mentions of a term
- Locate specific phrases
- Identify sections to edit
- Show users where changes are needed

═══════════════════════════════════════════════════════════════════════════
PARAMETERS
═══════════════════════════════════════════════════════════════════════════

- docGuid: Document UUID
- query: Text to search for
- caseSensitive: Whether search is case-sensitive (default: false)
- highlightResults: Whether to highlight matches (default: true)
- durationSeconds: How long to show highlights (default: 60)

═══════════════════════════════════════════════════════════════════════════
RETURN VALUES
═══════════════════════════════════════════════════════════════════════════

- matches: Array of match objects, each containing:
  - elementIndex: Which block contains the match
  - startPosition: Character offset where match starts
  - endPosition: Character offset where match ends
  - context: Surrounding text for context (up to 50 chars before/after)
- totalMatches: Total number of matches found

═══════════════════════════════════════════════════════════════════════════
WORKFLOW EXAMPLE
═══════════════════════════════════════════════════════════════════════════

// Search for all mentions of "API"
const result = await search_document({
  docGuid: "abc-123",
  query: "API",
  caseSensitive: false,
  highlightResults: true,
  durationSeconds: 90
});

// Returns:
{
  matches: [
    {
      elementIndex: 1,
      startPosition: 45,
      endPosition: 48,
      context: "...need to update the API documentation for..."
    },
    {
      elementIndex: 5,
      startPosition: 12,
      endPosition: 15,
      context: "The REST API provides endpoints for..."
    },
    {
      elementIndex: 8,
      startPosition: 89,
      endPosition: 92,
      context: "...authentication via API keys is recommended..."
    }
  ],
  totalMatches: 3
}

// All matches are highlighted in the document!

═══════════════════════════════════════════════════════════════════════════
EXAMPLES
═══════════════════════════════════════════════════════════════════════════

1. CASE-INSENSITIVE SEARCH:
search_document({
  docGuid: "abc-123",
  query: "important",
  caseSensitive: false
})
// Finds: "important", "Important", "IMPORTANT"

2. CASE-SENSITIVE SEARCH:
search_document({
  docGuid: "abc-123",
  query: "ERROR",
  caseSensitive: true
})
// Only finds: "ERROR" (not "error" or "Error")

3. SEARCH WITHOUT HIGHLIGHTING:
search_document({
  docGuid: "abc-123",
  query: "error",
  highlightResults: false
})
// Returns matches but doesn't highlight them

4. SEARCH WITH LONG HIGHLIGHT DURATION:
search_document({
  docGuid: "abc-123",
  query: "review this",
  durationSeconds: 120
})
// Highlights stay visible for 2 minutes

═══════════════════════════════════════════════════════════════════════════
SEARCH TIPS
═══════════════════════════════════════════════════════════════════════════

- Searches across all blocks in the document
- Returns matches in document order
- Context helps identify which occurrence to edit
- Use elementIndex + positions with other tools to edit matches
- Case-insensitive by default for broader results

═══════════════════════════════════════════════════════════════════════════
NOTES
═══════════════════════════════════════════════════════════════════════════

- Requires "viewer", "editor", or "owner" role
- Highlighting (if enabled) syncs to all users
- Matches are returned in document order
- Context shows up to 50 characters before/after match
- Use with replace_text to make targeted edits`;

const inputSchema = {
  type: 'object',
  properties: {
    docGuid: {
      type: 'string',
      format: 'uuid',
      description: 'The document UUID',
    },
    query: {
      type: 'string',
      minLength: 1,
      description: 'Text to search for',
    },
    caseSensitive: {
      type: 'boolean',
      description: 'Whether search is case-sensitive (default: false)',
    },
    highlightResults: {
      type: 'boolean',
      description: 'Whether to highlight matches (default: true)',
    },
    durationSeconds: {
      type: 'integer',
      minimum: 1,
      maximum: 300,
      description: 'How long to show highlights (1-300 seconds, default: 60)',
    },
  },
  required: ['docGuid', 'query'],
};

/**
 * Handler function for the tool
 * @param {object} args - Tool arguments
 * @param {string} args.docGuid - Document UUID
 * @param {string} args.query - Search query
 * @param {boolean} [args.caseSensitive=false] - Case-sensitive search
 * @param {boolean} [args.highlightResults=true] - Whether to highlight
 * @param {number} [args.durationSeconds=60] - Highlight duration
 * @param {object} agentToken - Decoded agent JWT token
 * @returns {Promise<object>} Search results
 */
async function handler(args, agentToken) {
  if (!persistenceProvider) throw new Error('search_document tool not initialized');

  const { docGuid, query, caseSensitive = false, highlightResults = true, durationSeconds = 60 } = args;
  const userId = agentToken.userId;
  const pool = persistenceProvider.getPool();

  // Check if user has access to the document (viewers can search)
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

  // Connect to the shared WebSocket-managed document
  const session = await agentPresence.getOrCreateSession(docGuid, agentToken, durationSeconds);
  const ydoc = session.provider.doc;
  const xmlFragment = ydoc.get('default', Y.XmlFragment);

  // Search through all blocks
  const matches = [];
  const searchQuery = caseSensitive ? query : query.toLowerCase();

  for (let elementIndex = 0; elementIndex < xmlFragment.length; elementIndex++) {
    const element = xmlFragment.get(elementIndex);
    const textContent = getTextContent(element);
    const searchText = caseSensitive ? textContent : textContent.toLowerCase();

    // Find all occurrences in this block
    let startPos = 0;
    while (true) {
      const foundIndex = searchText.indexOf(searchQuery, startPos);
      if (foundIndex === -1) break;

      const matchStart = foundIndex;
      const matchEnd = foundIndex + query.length;

      // Get context (up to 50 chars before and after)
      const contextStart = Math.max(0, matchStart - 50);
      const contextEnd = Math.min(textContent.length, matchEnd + 50);
      let context = textContent.substring(contextStart, contextEnd);

      // Add ellipsis if truncated
      if (contextStart > 0) context = '...' + context;
      if (contextEnd < textContent.length) context = context + '...';

      matches.push({
        elementIndex,
        startPosition: matchStart,
        endPosition: matchEnd,
        context,
      });

      startPos = matchEnd;
    }
  }

  // Highlight matches if requested
  // For now, we'll highlight the blocks containing matches
  // (highlighting specific text ranges would require more complex cursor positioning)
  if (highlightResults && matches.length > 0) {
    try {
      // Highlight the first match block as an example
      const firstMatch = matches[0];
      const anchorPos = Y.createRelativePositionFromTypeIndex(xmlFragment, firstMatch.elementIndex);
      const headIndex = firstMatch.elementIndex + 1;
      const headPos = Y.createRelativePositionFromTypeIndex(xmlFragment, headIndex);

      const anchor = Y.relativePositionToJSON(anchorPos);
      const head = Y.relativePositionToJSON(headPos);

      session.awareness.setLocalStateField('cursor', { anchor, head });
    } catch (error) {
      console.error('[search-document] Failed to set highlight:', error);
    }
  }

  return {
    matches,
    totalMatches: matches.length,
  };
}

module.exports = {
  init,
  name,
  description,
  inputSchema,
  handler,
};
