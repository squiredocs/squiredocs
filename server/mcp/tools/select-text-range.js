/**
 * select_text_range MCP Tool
 *
 * Selects a text range by character position, making it visible to all users.
 * Much easier to use than set_agent_selection which requires manual Yjs position creation.
 */
const Y = require('yjs');
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
const name = 'select_text_range';

const description = `Select a text range by character position - highlights text for all users.

═══════════════════════════════════════════════════════════════════════════
EASY WAY TO HIGHLIGHT TEXT
═══════════════════════════════════════════════════════════════════════════

Use this tool to highlight specific text ranges by character position.
Much simpler than set_agent_selection which requires Yjs position objects.

WHEN TO USE THIS:
- Highlight specific words or phrases within a block
- Draw attention to a particular text range
- Point out something for the user to review

═══════════════════════════════════════════════════════════════════════════
HOW IT WORKS
═══════════════════════════════════════════════════════════════════════════

Character positions are zero-based and count across the entire document:
- Position 0 = start of first block
- Whitespace and newlines between blocks are NOT counted
- Only actual text content is counted

Example document:
  [0] paragraph: "Hello world"    <- positions 0-10
  [1] paragraph: "Goodbye"        <- positions 11-17

To select "world": anchorPos=6, headPos=11
To select "Goodbye": anchorPos=11, headPos=18

═══════════════════════════════════════════════════════════════════════════
PARAMETERS
═══════════════════════════════════════════════════════════════════════════

- docGuid: Document UUID
- anchorPos: Start position (0-based character index)
- headPos: End position (0-based character index, exclusive)
- durationSeconds: How long to show selection (default: 60, max: 300)

═══════════════════════════════════════════════════════════════════════════
RETURNS
═══════════════════════════════════════════════════════════════════════════

- success: true if selection was set
- message: Confirmation message
- selectedText: The actual text that was selected
- anchorPos: The start position used
- headPos: The end position used
- agent: Your agent name and color

═══════════════════════════════════════════════════════════════════════════
EXAMPLE
═══════════════════════════════════════════════════════════════════════════

// Highlight characters 10-25 for 45 seconds
await select_text_range({
  docGuid: "abc-123",
  anchorPos: 10,
  headPos: 25,
  durationSeconds: 45
});

The selected text will be highlighted for all users to see!`;

const inputSchema = {
  type: 'object',
  properties: {
    docGuid: {
      type: 'string',
      format: 'uuid',
      description: 'The document UUID',
    },
    anchorPos: {
      type: 'integer',
      minimum: 0,
      description: 'Start character position (0-based, inclusive)',
    },
    headPos: {
      type: 'integer',
      minimum: 0,
      description: 'End character position (0-based, exclusive)',
    },
    durationSeconds: {
      type: 'integer',
      minimum: 1,
      maximum: 300,
      description: 'How long to show the selection (1-300 seconds, default: 60)',
    },
  },
  required: ['docGuid', 'anchorPos', 'headPos'],
};

/**
 * Convert a character position to a Yjs relative position
 * @param {Y.XmlFragment} xmlFragment - The document fragment
 * @param {number} charPos - Character position (0-based)
 * @returns {object|null} Yjs relative position JSON or null if out of bounds
 */
function charPosToYjsRelativePosition(xmlFragment, charPos) {
  let currentPos = 0;

  // Traverse all text nodes in the document
  function traverse(node) {
    if (node instanceof Y.XmlText) {
      const textLength = node.length;
      if (currentPos + textLength >= charPos) {
        // Found the text node containing this position
        const offsetInNode = charPos - currentPos;
        const relPos = Y.createRelativePositionFromTypeIndex(node, offsetInNode);
        return Y.relativePositionToJSON(relPos);
      }
      currentPos += textLength;
    } else if (node instanceof Y.XmlElement) {
      // Recurse into element's children
      for (const child of node.toArray()) {
        const result = traverse(child);
        if (result) return result;
      }
    }
    return null;
  }

  // Traverse all top-level blocks
  for (const block of xmlFragment.toArray()) {
    const result = traverse(block);
    if (result) return result;
  }

  // Position is beyond the document - use the end
  // Get the last text node and create a position at its end
  function getLastTextPos(node) {
    if (node instanceof Y.XmlText) {
      const relPos = Y.createRelativePositionFromTypeIndex(node, node.length);
      return Y.relativePositionToJSON(relPos);
    } else if (node instanceof Y.XmlElement) {
      const children = node.toArray();
      if (children.length > 0) {
        return getLastTextPos(children[children.length - 1]);
      }
    }
    return null;
  }

  const blocks = xmlFragment.toArray();
  if (blocks.length > 0) {
    return getLastTextPos(blocks[blocks.length - 1]);
  }

  return null;
}

/**
 * Extract text from a Yjs position range
 * @param {Y.XmlFragment} xmlFragment - The document fragment
 * @param {number} anchorPos - Start position
 * @param {number} headPos - End position
 * @returns {string} Extracted text
 */
function extractTextInRange(xmlFragment, anchorPos, headPos) {
  const startPos = Math.min(anchorPos, headPos);
  const endPos = Math.max(anchorPos, headPos);
  let currentPos = 0;
  let result = '';

  function traverse(node) {
    if (node instanceof Y.XmlText) {
      const textLength = node.length;
      const text = node.toString();

      // Check if this text node intersects with our range
      if (currentPos + textLength > startPos && currentPos < endPos) {
        const localStart = Math.max(0, startPos - currentPos);
        const localEnd = Math.min(textLength, endPos - currentPos);
        result += text.substring(localStart, localEnd);
      }

      currentPos += textLength;
    } else if (node instanceof Y.XmlElement) {
      for (const child of node.toArray()) {
        traverse(child);
        if (currentPos >= endPos) return; // Stop early if we've passed the end
      }
    }
  }

  for (const block of xmlFragment.toArray()) {
    traverse(block);
    if (currentPos >= endPos) break;
  }

  return result;
}

/**
 * Handler function for the tool
 * @param {object} args - Tool arguments
 * @param {string} args.docGuid - Document UUID
 * @param {number} args.anchorPos - Start character position
 * @param {number} args.headPos - End character position
 * @param {number} [args.durationSeconds=60] - Duration to show selection
 * @param {object} agentToken - Decoded agent JWT token
 * @returns {Promise<object>} Selection result
 */
async function handler(args, agentToken) {
  if (!persistenceProvider) throw new Error('select_text_range tool not initialized');

  const { docGuid, anchorPos, headPos, durationSeconds = 60 } = args;
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

  // Connect to the shared WebSocket-managed document
  const session = await agentPresence.getOrCreateSession(docGuid, agentToken, durationSeconds);
  const ydoc = session.provider.doc;
  const xmlFragment = ydoc.get('default', Y.XmlFragment);

  // Convert character positions to Yjs relative positions
  const anchor = charPosToYjsRelativePosition(xmlFragment, anchorPos);
  const head = charPosToYjsRelativePosition(xmlFragment, headPos);

  if (!anchor || !head) {
    throw new Error('Position out of bounds');
  }

  // Extract the selected text for confirmation
  const selectedText = extractTextInRange(xmlFragment, anchorPos, headPos);

  // Set the cursor selection
  session.awareness.setLocalStateField('cursor', { anchor, head });

  return {
    success: true,
    message: 'Text selection set',
    selectedText,
    anchorPos,
    headPos,
    agent: {
      name: session.agentInfo.name,
      color: session.agentInfo.color,
    },
  };
}

module.exports = {
  init,
  name,
  description,
  inputSchema,
  handler,
};
