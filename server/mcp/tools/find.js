/**
 * find MCP Tool
 *
 * Search for text from current cursor position.
 */

const Y = require('yjs');
const agentPresence = require('../agent-presence');
const { findFromCursor, resolveCursorPosition, getCursorContext, getTextInSelection } = require('../yjs/cursor-operations');

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
const name = 'find';

const description = `Search for text from current cursor position.

═══════════════════════════════════════════════════════════════════════════
SEARCH AND NAVIGATE
═══════════════════════════════════════════════════════════════════════════

Search for text starting from your current cursor position.
Can move cursor to match, select the match, or just peek without moving.

WHEN TO USE THIS:
- Find specific text in document
- Navigate to search results
- Select text for editing
- Check if text exists without moving cursor

SEARCH OPTIONS:
- direction: "forward" or "backward" (default: "forward")
- caseSensitive: Case-sensitive search (default: false)
- regex: Treat query as regular expression (default: false)
- wrap: Wrap around document (default: true)

ACTIONS:
- "goto": Move cursor to start of match
- "select": Select the matched text
- "peek": Just return match info without moving cursor

═══════════════════════════════════════════════════════════════════════════
PARAMETERS
═══════════════════════════════════════════════════════════════════════════

- docGuid: Document UUID (required)
- query: Text to search for (required)
- options: Search options (optional)
  - direction: "forward" | "backward" (default: "forward")
  - caseSensitive: boolean (default: false)
  - regex: boolean (default: false)
  - wrap: boolean (default: true)
  - action: "goto" | "select" | "peek" (default: "goto")

═══════════════════════════════════════════════════════════════════════════
RETURNS
═══════════════════════════════════════════════════════════════════════════

- success: true if operation succeeded
- found: true if match was found
- match: (if found)
  - text: Matched text
  - block: Block index
  - offset: Offset within block
  - length: Length of match
- cursor: Updated cursor state (if action != "peek")
- selection: Selection info (if action == "select")

═══════════════════════════════════════════════════════════════════════════
EXAMPLES
═══════════════════════════════════════════════════════════════════════════

// Find and go to "TODO"
await find({
  docGuid: "abc-123",
  query: "TODO",
  options: { action: "goto" }
});

// Find and select "important" (case-sensitive)
await find({
  docGuid: "abc-123",
  query: "important",
  options: { action: "select", caseSensitive: true }
});

// Search backward with regex
await find({
  docGuid: "abc-123",
  query: "bug-\\d+",
  options: { direction: "backward", regex: true }
});

// Just check if text exists (peek mode)
await find({
  docGuid: "abc-123",
  query: "FIXME",
  options: { action: "peek" }
});`;

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
    options: {
      type: 'object',
      properties: {
        direction: {
          type: 'string',
          enum: ['forward', 'backward'],
          description: 'Search direction (default: "forward")',
        },
        caseSensitive: {
          type: 'boolean',
          description: 'Case-sensitive search (default: false)',
        },
        regex: {
          type: 'boolean',
          description: 'Treat query as regex (default: false)',
        },
        wrap: {
          type: 'boolean',
          description: 'Wrap around document (default: true)',
        },
        action: {
          type: 'string',
          enum: ['goto', 'select', 'peek'],
          description: 'Action to take (default: "goto")',
        },
      },
    },
  },
  required: ['docGuid', 'query'],
};

/**
 * Handler function for the tool
 * @param {object} args - Tool arguments
 * @param {string} args.docGuid - Document UUID
 * @param {string} args.query - Search query
 * @param {object} [args.options] - Search options
 * @param {object} agentToken - Decoded agent JWT token
 * @returns {Promise<object>} Search result
 */
async function handler(args, agentToken) {
  if (!persistenceProvider) throw new Error('find tool not initialized');

  const { docGuid, query, options = {} } = args;
  const {
    direction = 'forward',
    caseSensitive = false,
    regex = false,
    wrap = true,
    action = 'goto',
  } = options;

  const userId = agentToken.userId;
  const pool = persistenceProvider.getPool();

  // Check if user has access to the document
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

  // Get session
  const sessionKey = `${userId}-${docGuid}`;
  const activeSessions = agentPresence.getActiveSessions();

  let session = null;
  for (const [sid, sess] of activeSessions.entries()) {
    if (sess.key === sessionKey) {
      session = sess;
      break;
    }
  }

  if (!session || !session.cursor) {
    throw new Error('No active session found. Use open_document first.');
  }

  const ydoc = session.provider.doc;
  const xmlFragment = ydoc.get('default', Y.XmlFragment);

  // Search from cursor
  const currentHead = session.cursor.head;
  const searchResult = findFromCursor(xmlFragment, currentHead, query, {
    direction,
    caseSensitive,
    regex,
    wrap,
  });

  if (!searchResult.found) {
    return {
      success: true,
      found: false,
      match: null,
      cursor: null,
      selection: null,
    };
  }

  const matchInfo = {
    text: searchResult.matchText,
    block: searchResult.block,
    offset: searchResult.offset,
    length: searchResult.matchLength,
  };

  // Handle actions
  let cursorInfo = null;
  let selectionInfo = null;

  if (action === 'peek') {
    // Don't move cursor, just return match
    const currentResolved = resolveCursorPosition(xmlFragment, currentHead);
    if (currentResolved) {
      cursorInfo = {
        block: currentResolved.blockIndex,
        offset: currentResolved.offset,
        blockType: currentResolved.blockType,
      };
    }
  } else if (action === 'goto') {
    // Move cursor to start of match
    const matchPos = searchResult.position;
    agentPresence.updateSessionCursor(session.sessionId, matchPos, matchPos);

    const resolved = resolveCursorPosition(xmlFragment, matchPos);
    const context = getCursorContext(xmlFragment, matchPos, 50, 50);

    cursorInfo = {
      block: resolved.blockIndex,
      offset: resolved.offset,
      blockType: resolved.blockType,
      context: context ? `${context.before}|${context.after}` : '',
    };
  } else if (action === 'select') {
    // Select the matched text
    const matchStartPos = searchResult.position;

    // Calculate end position (start + length)
    const { moveCursor } = require('../yjs/cursor-operations');
    const moveResult = moveCursor(xmlFragment, matchStartPos, 'forward', 'char', searchResult.matchLength);

    if (!moveResult) {
      throw new Error('Could not calculate match end position');
    }

    const matchEndPos = moveResult.newPos;

    // Set selection: anchor at start, head at end
    agentPresence.updateSessionCursor(session.sessionId, matchStartPos, matchEndPos);

    const resolved = resolveCursorPosition(xmlFragment, matchEndPos);
    const context = getCursorContext(xmlFragment, matchEndPos, 50, 50);

    cursorInfo = {
      block: resolved.blockIndex,
      offset: resolved.offset,
      blockType: resolved.blockType,
      context: context ? `${context.before}|${context.after}` : '',
    };

    selectionInfo = {
      text: searchResult.matchText,
      length: searchResult.matchLength,
    };
  }

  return {
    success: true,
    found: true,
    match: matchInfo,
    cursor: cursorInfo,
    selection: selectionInfo,
  };
}

module.exports = {
  init,
  name,
  description,
  inputSchema,
  handler,
};
