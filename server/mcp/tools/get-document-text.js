/**
 * get_document_text MCP Tool
 *
 * Retrieves the full plain text content of a document or specific blocks.
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
const name = 'get_document_text';

const description = `Get the full plain text content of a document or specific blocks.

═══════════════════════════════════════════════════════════════════════════
EXTRACT TEXT FOR ANALYSIS
═══════════════════════════════════════════════════════════════════════════

Retrieve plain text from documents without reading block-by-block. Perfect
for analysis, summarization, or processing entire documents.

Use cases:
- Get full document text for analysis
- Extract specific blocks for processing
- Count words or characters
- Generate summaries
- Search and analyze content

═══════════════════════════════════════════════════════════════════════════
PARAMETERS
═══════════════════════════════════════════════════════════════════════════

- docGuid: Document UUID
- elementIndices: Optional array of specific block indices to retrieve
  - If omitted, returns all blocks
  - If provided, only returns text from specified blocks

═══════════════════════════════════════════════════════════════════════════
RETURN VALUES
═══════════════════════════════════════════════════════════════════════════

- text: Plain text content (all formatting removed)
- wordCount: Total number of words
- characterCount: Total number of characters
- blockCount: Number of blocks included

═══════════════════════════════════════════════════════════════════════════
WORKFLOW EXAMPLE
═══════════════════════════════════════════════════════════════════════════

// Get all text from a document
const result = await get_document_text({
  docGuid: "abc-123"
});

// Returns:
{
  text: "Document Title\n\nThis is the introduction paragraph...",
  wordCount: 245,
  characterCount: 1423,
  blockCount: 8
}

// Get text from specific blocks only
const partial = await get_document_text({
  docGuid: "abc-123",
  elementIndices: [0, 1, 5]
});

// Returns only text from blocks 0, 1, and 5

═══════════════════════════════════════════════════════════════════════════
EXAMPLES
═══════════════════════════════════════════════════════════════════════════

1. GET ENTIRE DOCUMENT:
get_document_text({
  docGuid: "abc-123"
})
// Returns all text with blocks separated by newlines

2. GET SPECIFIC BLOCKS:
get_document_text({
  docGuid: "abc-123",
  elementIndices: [0, 2, 4]
})
// Returns only text from blocks 0, 2, and 4

3. GET SINGLE BLOCK AS TEXT:
get_document_text({
  docGuid: "abc-123",
  elementIndices: [3]
})
// Returns text from block 3 only

4. ANALYZE DOCUMENT LENGTH:
const { wordCount, characterCount } = await get_document_text({
  docGuid: "abc-123"
});

if (wordCount > 1000) {
  console.log("This is a long document");
}

═══════════════════════════════════════════════════════════════════════════
TEXT FORMATTING
═══════════════════════════════════════════════════════════════════════════

- All formatting (bold, italic, etc.) is removed
- Blocks are separated by newlines
- List items are joined without special formatting
- Links show only the link text (not the URL)

═══════════════════════════════════════════════════════════════════════════
USE WITH OTHER TOOLS
═══════════════════════════════════════════════════════════════════════════

Combine with other tools for powerful workflows:

1. Search and Replace:
   const { text } = await get_document_text({ docGuid });
   const hasTypo = text.includes("teh");
   if (hasTypo) {
     // Use search_document to find and replace_text to fix
   }

2. Word Count Analysis:
   const { wordCount } = await get_document_text({ docGuid });
   if (wordCount < 100) {
     // Use insert_text to add more content
   }

3. Content Extraction:
   // Get structure to find headings
   const { structure } = await get_document_structure({ docGuid });
   // Get text from heading blocks only
   const headingIndices = [0, 5, 10]; // From structure
   const { text } = await get_document_text({
     docGuid,
     elementIndices: headingIndices
   });

═══════════════════════════════════════════════════════════════════════════
NOTES
═══════════════════════════════════════════════════════════════════════════

- Requires "viewer", "editor", or "owner" role
- Does not modify the document (read-only)
- More efficient than reading blocks one by one
- Plain text only (no formatting preserved)
- Blocks separated by newlines in output`;

const inputSchema = {
  type: 'object',
  properties: {
    docGuid: {
      type: 'string',
      format: 'uuid',
      description: 'The document UUID',
    },
    elementIndices: {
      type: 'array',
      items: {
        type: 'integer',
        minimum: 0,
      },
      description: 'Optional array of block indices to retrieve (omit for all blocks)',
    },
  },
  required: ['docGuid'],
};

/**
 * Count words in text
 * @param {string} text - Text to count
 * @returns {number} Word count
 */
function countWords(text) {
  // Split by whitespace and filter out empty strings
  const words = text.trim().split(/\s+/).filter((word) => word.length > 0);
  return words.length;
}

/**
 * Handler function for the tool
 * @param {object} args - Tool arguments
 * @param {string} args.docGuid - Document UUID
 * @param {Array<number>} [args.elementIndices] - Optional specific block indices
 * @param {object} agentToken - Decoded agent JWT token
 * @returns {Promise<object>} Document text and statistics
 */
async function handler(args, agentToken) {
  if (!persistenceProvider) throw new Error('get_document_text tool not initialized');

  const { docGuid, elementIndices } = args;
  const userId = agentToken.userId;
  const pool = persistenceProvider.getPool();

  // Check if user has access to the document (viewers can read)
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
  const session = await agentPresence.getOrCreateSession(docGuid, agentToken, 30);
  const ydoc = session.provider.doc;
  const xmlFragment = ydoc.get('default', Y.XmlFragment);

  // Determine which blocks to process
  let indicesToProcess;
  if (elementIndices && elementIndices.length > 0) {
    // Validate indices
    for (const idx of elementIndices) {
      if (idx >= xmlFragment.length) {
        throw new Error(`Element index ${idx} out of bounds (document has ${xmlFragment.length} elements)`);
      }
    }
    indicesToProcess = elementIndices;
  } else {
    // Process all blocks
    indicesToProcess = Array.from({ length: xmlFragment.length }, (_, i) => i);
  }

  // Extract text from specified blocks
  const textParts = [];
  for (const elementIndex of indicesToProcess) {
    const element = xmlFragment.get(elementIndex);
    const textContent = getTextContent(element);
    textParts.push(textContent);
  }

  // Join with newlines
  const fullText = textParts.join('\n\n');

  // Calculate statistics
  const wordCount = countWords(fullText);
  const characterCount = fullText.length;
  const blockCount = indicesToProcess.length;

  return {
    text: fullText,
    wordCount,
    characterCount,
    blockCount,
  };
}

module.exports = {
  init,
  name,
  description,
  inputSchema,
  handler,
};
