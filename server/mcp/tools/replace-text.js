/**
 * replace_text MCP Tool
 *
 * Replaces a specific range of text within a block without replacing the entire block.
 */
const Y = require('yjs');
const { replaceText: doReplaceText, extractText } = require('../yjs/text-operations');
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
const name = 'replace_text';

const description = `Replace a specific range of text within a block.

✅ INDEX SAFETY: This tool does NOT change element indices
⚠️  CHARACTER POSITION WARNING: May change positions WITHIN the block
═══════════════════════════════════════════════════════════════════════════

Block indices remain unchanged. Character positions AFTER the replacement
will shift if the new text has different length than the old text.

BEFORE replace 10-15:  "The quick brown fox jumps"
                              ^^^^^ replace "brown" (5 chars)
AFTER  replace with "red":  "The quick red fox jumps"
                                   ^^^ new text (3 chars)
                                      ↑ "fox" was at 16, now at 14

Length changed by: new_length - old_length = 3 - 5 = -2
Positions after 15 shift left by 2

If replacement length equals original length, positions don't change.
Otherwise, read the block again or calculate: new_pos = old_pos + length_diff

═══════════════════════════════════════════════════════════════════════════
SURGICAL TEXT EDITING
═══════════════════════════════════════════════════════════════════════════

Replace specific text within a block without affecting the rest of the content.
This preserves concurrent edits and avoids replacing the entire block.

Use cases:
- Fix typos or rephrase sentences
- Update specific words or phrases
- Change text while preserving formatting

═══════════════════════════════════════════════════════════════════════════
PARAMETERS
═══════════════════════════════════════════════════════════════════════════

- docGuid: Document UUID
- elementIndex: Which block to edit
- startPosition: Character offset where replacement starts (0-based, inclusive)
- endPosition: Character offset where replacement ends (0-based, exclusive)
- newText: Text to insert in place of the deleted range
- marks: Optional array of formatting marks to apply to new text
  - Simple marks: ["bold"], ["italic"], ["underline"], ["strike"]
  - Multiple marks: ["bold", "italic"]
  - Link: [{ "type": "link", "href": "https://example.com" }]
- durationSeconds: How long to highlight the change (default: 45)

═══════════════════════════════════════════════════════════════════════════
RETURN VALUES
═══════════════════════════════════════════════════════════════════════════

- success: true if replaced successfully
- replacedText: The text that was removed
- newBlockLength: New character count of the block
- highlighted: Whether the change was highlighted

═══════════════════════════════════════════════════════════════════════════
WORKFLOW EXAMPLE
═══════════════════════════════════════════════════════════════════════════

// Step 1: Read the block to see current content
const block = await read_document_block({
  docGuid: "abc-123",
  elementIndex: 0
});
// Returns: "The quick brown fox jumps over the lazy dog"

// Step 2: Replace "brown" with "red"
const result = await replace_text({
  docGuid: "abc-123",
  elementIndex: 0,
  startPosition: 10,   // Position of "brown"
  endPosition: 15,     // End of "brown"
  newText: "red",
  durationSeconds: 30
});

// Result: "The quick red fox jumps over the lazy dog"
// Returns: { success: true, replacedText: "brown", newBlockLength: 41 }

// Step 3: Make the word "red" bold
const formatted = await replace_text({
  docGuid: "abc-123",
  elementIndex: 0,
  startPosition: 10,
  endPosition: 13,
  newText: "red",
  marks: ["bold"]
});

═══════════════════════════════════════════════════════════════════════════
EXAMPLES
═══════════════════════════════════════════════════════════════════════════

1. FIX A TYPO:
replace_text({
  docGuid: "abc-123",
  elementIndex: 1,
  startPosition: 15,
  endPosition: 20,
  newText: "their"  // Fix "there" to "their"
})

2. ADD FORMATTING TO NEW TEXT:
replace_text({
  docGuid: "abc-123",
  elementIndex: 2,
  startPosition: 0,
  endPosition: 5,
  newText: "URGENT",
  marks: ["bold", "underline"]
})

3. REPLACE WITH LINK:
replace_text({
  docGuid: "abc-123",
  elementIndex: 3,
  startPosition: 10,
  endPosition: 20,
  newText: "click here",
  marks: [{ "type": "link", "href": "https://example.com" }]
})

4. DELETE TEXT (replace with empty string):
replace_text({
  docGuid: "abc-123",
  elementIndex: 1,
  startPosition: 10,
  endPosition: 20,
  newText: ""
})

═══════════════════════════════════════════════════════════════════════════
CHARACTER POSITION TIPS
═══════════════════════════════════════════════════════════════════════════

- Positions are 0-based (first character is position 0)
- startPosition is inclusive (character at this position is replaced)
- endPosition is exclusive (character at this position is NOT replaced)
- Use read_document_block to see current content and plan positions
- To replace a single character: startPosition = N, endPosition = N + 1

═══════════════════════════════════════════════════════════════════════════
NOTES
═══════════════════════════════════════════════════════════════════════════

- Changes sync to all users in real-time
- Automatically saved to database
- Requires "editor" or "owner" role
- Preserves formatting outside the replaced range
- More efficient than update_document_block for small changes
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
    newText: {
      type: 'string',
      description: 'New text to insert (empty string to delete)',
    },
    marks: {
      type: 'array',
      description: 'Optional formatting marks for the new text',
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
  required: ['docGuid', 'elementIndex', 'startPosition', 'endPosition', 'newText'],
};

/**
 * Handler function for the tool
 * @param {object} args - Tool arguments
 * @param {string} args.docGuid - Document UUID
 * @param {number} args.elementIndex - Element index
 * @param {number} args.startPosition - Start position
 * @param {number} args.endPosition - End position
 * @param {string} args.newText - New text
 * @param {Array} [args.marks] - Optional formatting marks
 * @param {number} [args.durationSeconds=45] - Duration to highlight
 * @param {object} agentToken - Decoded agent JWT token
 * @returns {Promise<object>} Replace result
 */
async function handler(args, agentToken) {
  if (!persistenceProvider) throw new Error('replace_text tool not initialized');

  const { docGuid, elementIndex, startPosition, endPosition, newText, marks, durationSeconds = 45 } = args;
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
    throw new Error('Viewer role cannot replace text');
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

  // Perform the replacement in a transaction
  let replacedText;
  let newBlockLength;

  ydoc.transact(() => {
    const result = doReplaceText(element, startPosition, endPosition, newText, marks);
    replacedText = result.deletedText;
    newBlockLength = result.newLength;
  });

  // Highlight the changed range
  let highlighted = false;
  try {
    // We need to highlight the text range within the block
    // This is more complex than highlighting a whole block
    // For now, we'll highlight the entire block
    const anchorPos = Y.createRelativePositionFromTypeIndex(xmlFragment, elementIndex);
    const headIndex = elementIndex + 1;
    const headPos = Y.createRelativePositionFromTypeIndex(xmlFragment, headIndex);

    const anchor = Y.relativePositionToJSON(anchorPos);
    const head = Y.relativePositionToJSON(headPos);

    session.awareness.setLocalStateField('cursor', { anchor, head });
    highlighted = true;
  } catch (error) {
    console.error('[replace-text] Failed to set highlight:', error);
  }

  return {
    success: true,
    replacedText,
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
