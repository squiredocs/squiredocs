/**
 * insert_text MCP Tool
 *
 * Inserts text at a specific position within a block.
 */
const Y = require('yjs');
const { insertText: doInsertText } = require('../yjs/text-operations');
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
const name = 'insert_text';

const description = `Insert text at a specific position within a block.

═══════════════════════════════════════════════════════════════════════════
ADD TEXT WITHOUT REPLACING
═══════════════════════════════════════════════════════════════════════════

Insert text at any position within a block without removing existing content.
Perfect for adding words, sentences, or phrases in the middle of text.

Use cases:
- Add clarifying words or phrases
- Insert text in the middle of a sentence
- Add formatted text at specific positions

═══════════════════════════════════════════════════════════════════════════
PARAMETERS
═══════════════════════════════════════════════════════════════════════════

- docGuid: Document UUID
- elementIndex: Which block to edit
- characterPosition: Where to insert (0-based, characters after this position shift right)
- text: Text to insert
- marks: Optional array of formatting marks for the new text
  - Simple marks: ["bold"], ["italic"], ["underline"], ["strike"]
  - Multiple marks: ["bold", "italic"]
  - Link: [{ "type": "link", "href": "https://example.com" }]
- durationSeconds: How long to highlight the change (default: 45)

═══════════════════════════════════════════════════════════════════════════
RETURN VALUES
═══════════════════════════════════════════════════════════════════════════

- success: true if inserted successfully
- insertedAt: Character position where text was inserted
- newBlockLength: New character count of the block
- highlighted: Whether the change was highlighted

═══════════════════════════════════════════════════════════════════════════
WORKFLOW EXAMPLE
═══════════════════════════════════════════════════════════════════════════

// Step 1: Read the block
const block = await read_document_block({
  docGuid: "abc-123",
  elementIndex: 0
});
// Returns: "The quick fox jumps"

// Step 2: Insert "brown " before "fox"
const result = await insert_text({
  docGuid: "abc-123",
  elementIndex: 0,
  characterPosition: 10,   // Position before "fox"
  text: "brown ",
  durationSeconds: 30
});

// Result: "The quick brown fox jumps"
// Returns: { success: true, insertedAt: 10, newBlockLength: 25 }

// Step 3: Insert bold text
await insert_text({
  docGuid: "abc-123",
  elementIndex: 0,
  characterPosition: 0,
  text: "Note: ",
  marks: ["bold"]
});

// Result: "Note: The quick brown fox jumps"

═══════════════════════════════════════════════════════════════════════════
EXAMPLES
═══════════════════════════════════════════════════════════════════════════

1. INSERT AT BEGINNING:
insert_text({
  docGuid: "abc-123",
  elementIndex: 1,
  characterPosition: 0,
  text: "Important: "
})

2. INSERT AT END:
// If block has 20 characters
insert_text({
  docGuid: "abc-123",
  elementIndex: 1,
  characterPosition: 20,
  text: " (end note)"
})

3. INSERT WITH FORMATTING:
insert_text({
  docGuid: "abc-123",
  elementIndex: 2,
  characterPosition: 10,
  text: "critical",
  marks: ["bold", "underline"]
})

4. INSERT A LINK:
insert_text({
  docGuid: "abc-123",
  elementIndex: 3,
  characterPosition: 5,
  text: "documentation",
  marks: [{ "type": "link", "href": "https://docs.example.com" }]
})

═══════════════════════════════════════════════════════════════════════════
POSITION TIPS
═══════════════════════════════════════════════════════════════════════════

- Position 0 inserts at the beginning
- Position = block length inserts at the end
- Text after the position shifts right
- Use read_document_block to see current content and plan position

═══════════════════════════════════════════════════════════════════════════
NOTES
═══════════════════════════════════════════════════════════════════════════

- Changes sync to all users in real-time
- Automatically saved to database
- Requires "editor" or "owner" role
- More efficient than replace_text for pure insertions
- Block is highlighted for visual feedback`;

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
    characterPosition: {
      type: 'integer',
      minimum: 0,
      description: 'Character position to insert at (0-based)',
    },
    text: {
      type: 'string',
      description: 'Text to insert',
    },
    marks: {
      type: 'array',
      description: 'Optional formatting marks for the text',
      items: {
        oneOf: [
          { type: 'string', enum: ['bold', 'italic', 'underline', 'strike'] },
          {
            type: 'object',
            properties: {
              type: { type: 'string', enum: ['link'] },
              href: { type: 'string' },
            },
            required: ['type', 'href'],
          },
        ],
      },
    },
    durationSeconds: {
      type: 'integer',
      minimum: 1,
      maximum: 300,
      description: 'How long to highlight the change (1-300 seconds, default: 45)',
    },
  },
  required: ['docGuid', 'elementIndex', 'characterPosition', 'text'],
};

/**
 * Handler function for the tool
 * @param {object} args - Tool arguments
 * @param {string} args.docGuid - Document UUID
 * @param {number} args.elementIndex - Element index
 * @param {number} args.characterPosition - Position to insert at
 * @param {string} args.text - Text to insert
 * @param {Array} [args.marks] - Optional formatting marks
 * @param {number} [args.durationSeconds=45] - Duration to highlight
 * @param {object} agentToken - Decoded agent JWT token
 * @returns {Promise<object>} Insert result
 */
async function handler(args, agentToken) {
  if (!persistenceProvider) throw new Error('insert_text tool not initialized');

  const { docGuid, elementIndex, characterPosition, text, marks, durationSeconds = 45 } = args;
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
    throw new Error('Viewer role cannot insert text');
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

  // Perform the insertion in a transaction
  let newBlockLength;

  ydoc.transact(() => {
    newBlockLength = doInsertText(element, characterPosition, text, marks);
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
    console.error('[insert-text] Failed to set highlight:', error);
  }

  return {
    success: true,
    insertedAt: characterPosition,
    newBlockLength,
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
