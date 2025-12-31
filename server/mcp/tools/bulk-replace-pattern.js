/**
 * bulk_replace_pattern MCP Tool
 *
 * Find all blocks matching a pattern and replace them with new blocks in one operation.
 */
const Y = require('yjs');
const { getTextContent } = require('../yjs/block-structure');
const { buildYjsNode } = require('../yjs/node-builder');
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
const name = 'bulk_replace_pattern';

const description = `Find and replace all blocks matching a pattern in a single atomic operation.

⚠️  POWERFUL: BULK PATTERN MATCHING
═══════════════════════════════════════════════════════════════════════════
This tool finds ALL blocks that match your pattern and replaces them in one
atomic transaction. Perfect for:

- Converting markdown-style headings to proper heading blocks
- Standardizing block types across a document
- Batch content transformations
- Cleaning up formatting

═══════════════════════════════════════════════════════════════════════════
HOW IT WORKS
═══════════════════════════════════════════════════════════════════════════

1. Scans all blocks in the document
2. For each block, checks if content matches the regex pattern
3. If match, extracts capture groups and transforms to new block
4. Replaces all matching blocks in single transaction
5. Returns count of replacements made

═══════════════════════════════════════════════════════════════════════════
PATTERN MATCHING
═══════════════════════════════════════════════════════════════════════════

- pattern: JavaScript regex pattern to match against block text content
- flags: Regex flags (default: "")
  Common flags: "i" for case-insensitive, "m" for multiline

Capture groups in the pattern can be referenced in the replacement:
  - $1, $2, etc. in contentTransform refer to capture groups
  - $& refers to the entire match

═══════════════════════════════════════════════════════════════════════════
PARAMETERS
═══════════════════════════════════════════════════════════════════════════

- docGuid: Document UUID (required)
- pattern: Regex pattern to match (required)
- flags: Regex flags like "i" for case-insensitive (optional)
- blockType: Type of block to create (required)
- attributes: Type-specific attributes (optional)
- contentTransform: How to transform matched content (required)
    Use $1, $2 for capture groups, $& for full match
- durationSeconds: How long to keep selection active (default: 30)

═══════════════════════════════════════════════════════════════════════════
RETURN VALUES
═══════════════════════════════════════════════════════════════════════════

- success: true if operation succeeded
- matchesFound: Number of blocks that matched the pattern
- replacementsM

ade: Number of blocks actually replaced
- totalElements: Final block count after replacements
- highlighted: Whether the affected range was highlighted

═══════════════════════════════════════════════════════════════════════════
EXAMPLES
═══════════════════════════════════════════════════════════════════════════

// Convert all "## Title" paragraphs to heading level 2
await bulk_replace_pattern({
  docGuid: "abc-123",
  pattern: "^##\\s+(.+)$",
  blockType: "heading",
  attributes: { level: 2 },
  contentTransform: "$1"  // Just the title, without ##
});

// Convert all "### Title" paragraphs to heading level 3
await bulk_replace_pattern({
  docGuid: "abc-123",
  pattern: "^###\\s+(.+)$",
  blockType: "heading",
  attributes: { level: 3 },
  contentTransform: "$1"
});

// Convert code-like paragraphs to code blocks
await bulk_replace_pattern({
  docGuid: "abc-123",
  pattern: "^\\`\\`\\`(\\w+)\\n([\\s\\S]+?)\\`\\`\\`$",
  flags: "m",
  blockType: "codeBlock",
  attributes: { language: "$1" },  // First capture group
  contentTransform: "$2"           // Second capture group
});

// Wrap all single-word paragraphs in emphasis
await bulk_replace_pattern({
  docGuid: "abc-123",
  pattern: "^(\\w+)$",
  blockType: "paragraph",
  contentTransform: "*$1*"
});

═══════════════════════════════════════════════════════════════════════════
WORKFLOW COMPARISON
═══════════════════════════════════════════════════════════════════════════

❌ OLD WAY (search + multiple replaces):
  const results = await search_document({ query: "##" })
  for (const result of results.matches) {
    await replace_document_blocks({
      fromIndex: result.index,  // indices invalidate!
      blocks: [...]
    })
    await get_document_structure()  // refresh indices
  }

✅ NEW WAY (single bulk operation):
  await bulk_replace_pattern({
    pattern: "^##\\s+(.+)$",
    blockType: "heading",
    attributes: { level: 2 },
    contentTransform: "$1"
  })

═══════════════════════════════════════════════════════════════════════════`;

const inputSchema = {
  type: 'object',
  properties: {
    docGuid: {
      type: 'string',
      format: 'uuid',
      description: 'The document UUID',
    },
    pattern: {
      type: 'string',
      description: 'Regex pattern to match against block text content',
    },
    flags: {
      type: 'string',
      description: 'Regex flags (e.g., "i" for case-insensitive, "m" for multiline)',
    },
    blockType: {
      type: 'string',
      description: 'Type of block to create (paragraph, heading, codeBlock, etc.)',
    },
    attributes: {
      type: 'object',
      description: 'Type-specific attributes. Use $1, $2 for capture groups in values.',
    },
    contentTransform: {
      type: 'string',
      description: 'How to transform content. Use $1, $2 for capture groups, $& for full match.',
    },
    durationSeconds: {
      type: 'integer',
      minimum: 1,
      maximum: 300,
      description: 'How long to keep selection active (1-300 seconds, default: 30)',
    },
  },
  required: ['docGuid', 'pattern', 'blockType', 'contentTransform'],
};

/**
 * Replace capture group references in a string
 * @param {string} template - Template string with $1, $2, $& references
 * @param {Array} match - Regex match result
 * @returns {string} Transformed string
 */
function replaceCaptureGroups(template, match) {
  if (!template) return '';

  let result = template;

  // Replace $& with full match
  result = result.replace(/\$&/g, match[0] || '');

  // Replace $1, $2, etc. with capture groups
  for (let i = 1; i < match.length; i++) {
    const regex = new RegExp(`\\$${i}`, 'g');
    result = result.replace(regex, match[i] || '');
  }

  return result;
}

/**
 * Handler function for the tool
 * @param {object} args - Tool arguments
 * @param {string} args.docGuid - Document UUID
 * @param {string} args.pattern - Regex pattern
 * @param {string} [args.flags] - Regex flags
 * @param {string} args.blockType - Target block type
 * @param {object} [args.attributes] - Block attributes
 * @param {string} args.contentTransform - Content transformation template
 * @param {number} [args.durationSeconds=30] - Duration to keep selection active
 * @param {object} agentToken - Decoded agent JWT token
 * @returns {Promise<object>} Bulk replace result
 */
async function handler(args, agentToken) {
  if (!persistenceProvider) throw new Error('bulk_replace_pattern tool not initialized');

  const {
    docGuid,
    pattern,
    flags = '',
    blockType,
    attributes = {},
    contentTransform,
    durationSeconds = 30,
  } = args;
  const userId = agentToken.userId;
  const pool = persistenceProvider.getPool();

  // Validate pattern
  let regex;
  try {
    regex = new RegExp(pattern, flags);
  } catch (error) {
    throw new Error(`Invalid regex pattern: ${error.message}`);
  }

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
    throw new Error('Viewer role cannot replace blocks');
  }

  // Connect to the shared WebSocket-managed document
  const session = await agentPresence.getOrCreateSession(docGuid, agentToken, durationSeconds);
  const ydoc = session.provider.doc;
  const xmlFragment = ydoc.get('default', Y.XmlFragment);

  // Find all matching blocks
  const matches = [];
  for (let i = 0; i < xmlFragment.length; i++) {
    const element = xmlFragment.get(i);
    const textContent = getTextContent(element);
    const match = textContent.match(regex);

    if (match) {
      matches.push({ index: i, match, originalType: element.nodeName });
    }
  }

  if (matches.length === 0) {
    return {
      success: true,
      matchesFound: 0,
      replacementsMade: 0,
      totalElements: xmlFragment.length,
      highlighted: false,
    };
  }

  let minIndex = Infinity;
  let maxIndex = -1;

  // Replace all matches in a single transaction (from highest index to lowest)
  ydoc.transact(() => {
    // Sort matches from highest to lowest index to avoid invalidation
    const sortedMatches = [...matches].sort((a, b) => b.index - a.index);

    for (const { index, match } of sortedMatches) {
      // Transform content using capture groups
      const transformedContent = replaceCaptureGroups(contentTransform, match);

      // Transform attributes using capture groups
      const transformedAttributes = {};
      for (const [key, value] of Object.entries(attributes)) {
        if (typeof value === 'string') {
          transformedAttributes[key] = replaceCaptureGroups(value, match);
          // Try to convert to number if it looks like a number
          const num = parseInt(transformedAttributes[key], 10);
          if (!isNaN(num) && num.toString() === transformedAttributes[key]) {
            transformedAttributes[key] = num;
          }
        } else {
          transformedAttributes[key] = value;
        }
      }

      // Build new block
      const blockSpec = {
        type: blockType,
        content: transformedContent,
        ...transformedAttributes,
      };

      try {
        const newNode = buildYjsNode(blockSpec);
        xmlFragment.delete(index, 1);
        xmlFragment.insert(index, [newNode]);

        minIndex = Math.min(minIndex, index);
        maxIndex = Math.max(maxIndex, index);
      } catch (error) {
        console.error(`[bulk-replace-pattern] Failed to replace block ${index}:`, error);
        // Continue with other replacements
      }
    }
  });

  // Highlight the affected range
  let highlighted = false;
  if (minIndex !== Infinity && maxIndex !== -1) {
    try {
      const anchorPos = Y.createRelativePositionFromTypeIndex(xmlFragment, minIndex);
      const headPos = Y.createRelativePositionFromTypeIndex(xmlFragment, maxIndex + 1);

      const anchor = Y.relativePositionToJSON(anchorPos);
      const head = Y.relativePositionToJSON(headPos);

      session.awareness.setLocalStateField('cursor', { anchor, head });
      highlighted = true;
    } catch (error) {
      console.error('[bulk-replace-pattern] Failed to set highlight:', error);
    }
  }

  return {
    success: true,
    matchesFound: matches.length,
    replacementsMade: matches.length,
    totalElements: xmlFragment.length,
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
