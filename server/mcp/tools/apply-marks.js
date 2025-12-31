/**
 * apply_marks MCP Tool
 *
 * Applies or removes formatting marks (bold, italic, etc.) to a text range.
 */
const Y = require('yjs');
const { applyMarks: doApplyMarks } = require('../yjs/text-operations');
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
const name = 'apply_marks';

const description = `Apply or remove formatting marks to a text range.

═══════════════════════════════════════════════════════════════════════════
FORMAT TEXT WITHOUT CHANGING CONTENT
═══════════════════════════════════════════════════════════════════════════

Add or remove formatting (bold, italic, underline, strikethrough, links) to
existing text without changing the text itself.

Use cases:
- Make text bold or italic
- Add/remove underlines
- Apply strikethrough
- Add or remove hyperlinks
- Combine multiple formatting styles

═══════════════════════════════════════════════════════════════════════════
PARAMETERS
═══════════════════════════════════════════════════════════════════════════

- docGuid: Document UUID
- elementIndex: Which block to edit
- startPosition: Start of range to format (0-based, inclusive)
- endPosition: End of range to format (0-based, exclusive)
- addMarks: Array of marks to add (optional)
  - Available: "bold", "italic", "underline", "strike"
- removeMarks: Array of marks to remove (optional)
  - Same values as addMarks
- link: Link to add or remove (optional)
  - To add: { "href": "https://example.com" }
  - To remove: null
- durationSeconds: How long to highlight the change (default: 45)

═══════════════════════════════════════════════════════════════════════════
RETURN VALUES
═══════════════════════════════════════════════════════════════════════════

- success: true if formatting applied successfully
- affectedText: The text that was formatted
- highlighted: Whether the change was highlighted

═══════════════════════════════════════════════════════════════════════════
WORKFLOW EXAMPLE
═══════════════════════════════════════════════════════════════════════════

// Step 1: Read the block
const block = await read_document_block({
  docGuid: "abc-123",
  elementIndex: 0
});
// Returns: "This is important text"

// Step 2: Make "important" bold
const result = await apply_marks({
  docGuid: "abc-123",
  elementIndex: 0,
  startPosition: 8,      // Position of "important"
  endPosition: 17,
  addMarks: ["bold"]
});

// Result: "This is **important** text"
// Returns: { success: true, affectedText: "important" }

// Step 3: Add underline to "important" (now bold + underline)
await apply_marks({
  docGuid: "abc-123",
  elementIndex: 0,
  startPosition: 8,
  endPosition: 17,
  addMarks: ["underline"]
});

// Step 4: Remove bold, keep underline
await apply_marks({
  docGuid: "abc-123",
  elementIndex: 0,
  startPosition: 8,
  endPosition: 17,
  removeMarks: ["bold"]
});

═══════════════════════════════════════════════════════════════════════════
EXAMPLES
═══════════════════════════════════════════════════════════════════════════

1. MAKE TEXT BOLD:
apply_marks({
  docGuid: "abc-123",
  elementIndex: 1,
  startPosition: 0,
  endPosition: 10,
  addMarks: ["bold"]
})

2. MAKE TEXT BOLD AND ITALIC:
apply_marks({
  docGuid: "abc-123",
  elementIndex: 1,
  startPosition: 5,
  endPosition: 15,
  addMarks: ["bold", "italic"]
})

3. ADD A HYPERLINK:
apply_marks({
  docGuid: "abc-123",
  elementIndex: 2,
  startPosition: 10,
  endPosition: 20,
  link: { href: "https://example.com" }
})

4. REMOVE ALL FORMATTING:
apply_marks({
  docGuid: "abc-123",
  elementIndex: 3,
  startPosition: 0,
  endPosition: 50,
  removeMarks: ["bold", "italic", "underline", "strike"],
  link: null
})

5. APPLY STRIKETHROUGH (for deletions/corrections):
apply_marks({
  docGuid: "abc-123",
  elementIndex: 1,
  startPosition: 8,
  endPosition: 15,
  addMarks: ["strike"]
})

6. REMOVE LINK BUT KEEP OTHER FORMATTING:
apply_marks({
  docGuid: "abc-123",
  elementIndex: 2,
  startPosition: 10,
  endPosition: 20,
  link: null
})

═══════════════════════════════════════════════════════════════════════════
AVAILABLE MARKS
═══════════════════════════════════════════════════════════════════════════

- bold: Bold text
- italic: Italic text
- underline: Underlined text
- strike: Strikethrough text
- link: Hyperlink (specified via link parameter, not addMarks)

═══════════════════════════════════════════════════════════════════════════
POSITION TIPS
═══════════════════════════════════════════════════════════════════════════

- Positions are 0-based (first character is position 0)
- startPosition is inclusive (formatting starts here)
- endPosition is exclusive (formatting ends before this)
- Use read_document_block to see current content and plan positions
- Marks can be combined on the same text

═══════════════════════════════════════════════════════════════════════════
NOTES
═══════════════════════════════════════════════════════════════════════════

- Changes sync to all users in real-time
- Automatically saved to database
- Requires "editor" or "owner" role
- Can add and remove marks in the same operation
- Preserves text content exactly
- Range is highlighted for visual feedback`;

const inputSchema = {
  type: 'object',
  properties: {
    docGuid: {
      type: 'string',
      format: 'uuid',
      description: 'The document UUID',
    },
    elementIndex: {
      type: 'integer',
      minimum: 0,
      description: 'The index of the block element to edit',
    },
    startPosition: {
      type: 'integer',
      minimum: 0,
      description: 'Start character position (inclusive, 0-based)',
    },
    endPosition: {
      type: 'integer',
      minimum: 0,
      description: 'End character position (exclusive, 0-based)',
    },
    addMarks: {
      type: 'array',
      description: 'Formatting marks to add',
      items: {
        type: 'string',
        enum: ['bold', 'italic', 'underline', 'strike'],
      },
    },
    removeMarks: {
      type: 'array',
      description: 'Formatting marks to remove',
      items: {
        type: 'string',
        enum: ['bold', 'italic', 'underline', 'strike'],
      },
    },
    link: {
      oneOf: [
        {
          type: 'object',
          properties: {
            href: { type: 'string', format: 'uri' },
          },
          required: ['href'],
        },
        { type: 'null' },
      ],
      description: 'Link to add (object with href) or remove (null)',
    },
    durationSeconds: {
      type: 'integer',
      minimum: 1,
      maximum: 300,
      description: 'How long to highlight the change (1-300 seconds, default: 45)',
    },
  },
  required: ['docGuid', 'elementIndex', 'startPosition', 'endPosition'],
};

/**
 * Handler function for the tool
 * @param {object} args - Tool arguments
 * @param {string} args.docGuid - Document UUID
 * @param {number} args.elementIndex - Element index
 * @param {number} args.startPosition - Start position
 * @param {number} args.endPosition - End position
 * @param {Array} [args.addMarks] - Marks to add
 * @param {Array} [args.removeMarks] - Marks to remove
 * @param {Object|null} [args.link] - Link to add/remove
 * @param {number} [args.durationSeconds=45] - Duration to highlight
 * @param {object} agentToken - Decoded agent JWT token
 * @returns {Promise<object>} Apply result
 */
async function handler(args, agentToken) {
  if (!persistenceProvider) throw new Error('apply_marks tool not initialized');

  const {
    docGuid,
    elementIndex,
    startPosition,
    endPosition,
    addMarks = [],
    removeMarks = [],
    link,
    durationSeconds = 45,
  } = args;
  const userId = agentToken.userId;
  const pool = persistenceProvider.getPool();

  // Check if user has editor access to the document
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

  const { role } = accessResult.rows[0];
  if (role === 'viewer') {
    throw new Error('Viewer role cannot apply formatting marks');
  }

  // Connect to the shared WebSocket-managed document
  const session = await agentPresence.getOrCreateSession(docGuid, agentToken, durationSeconds);
  const ydoc = session.provider.doc;
  const xmlFragment = ydoc.get('default', Y.XmlFragment);

  // Validate element index
  if (elementIndex >= xmlFragment.length) {
    throw new Error(
      `Element index ${elementIndex} out of bounds (document has ${xmlFragment.length} elements)`
    );
  }

  // Get the block element
  const element = xmlFragment.get(elementIndex);

  // Perform the formatting in a transaction
  let affectedText;

  ydoc.transact(() => {
    const result = doApplyMarks(element, startPosition, endPosition, addMarks, removeMarks, link);
    affectedText = result.affectedText;
  });

  // Highlight the block
  let highlighted = false;
  try {
    const anchorPos = Y.createRelativePositionFromTypeIndex(xmlFragment, elementIndex);
    const headIndex = elementIndex + 1;
    const headPos = Y.createRelativePositionFromTypeIndex(xmlFragment, headIndex);

    const anchor = Y.relativePositionToJSON(anchorPos);
    const head = Y.relativePositionToJSON(headPos);

    session.awareness.setLocalStateField('cursor', { anchor, head });
    highlighted = true;
  } catch (error) {
    console.error('[apply-marks] Failed to set highlight:', error);
  }

  return {
    success: true,
    affectedText,
    highlighted,
  };
}

module.exports = {
  init,
  name,
  description,
  inputSchema,
  handler,
};
