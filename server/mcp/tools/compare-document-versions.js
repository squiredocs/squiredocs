/**
 * compare_document_versions MCP Tool
 *
 * Compare two document versions using a TypeScript script in a read-only sandbox.
 * Scripts can extract exactly the information needed without modifying documents.
 */

const Y = require('yjs');
const versionHistory = require('../../version-history');
const { executeComparisonScript } = require('../sandbox');
const documents = require('../../documents');

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
const name = 'compare_document_versions';

const description = `═══════════════════════════════════════════════════════════════════════════
OVERVIEW
═══════════════════════════════════════════════════════════════════════════

Compare two document versions using a programmable TypeScript environment.
Instead of a fixed diff format, write custom comparison logic to extract
exactly the information you need.

Use cases:
- "Did the title change?" - Compare specific elements
- "How many sections were added?" - Count structural changes
- "Were any links added?" - Extract and compare links
- "Find paragraphs mentioning 'budget'" - Semantic search across versions

═══════════════════════════════════════════════════════════════════════════
SCRIPT ENVIRONMENT
═══════════════════════════════════════════════════════════════════════════

Your script receives two Y.XmlFragment objects (read-only):
- doc1: Document at versionId1
- doc2: Document at versionId2

Return any data you want - the tool will return it to you.

Script structure:
  export default function compare(doc1: Y.XmlFragment, doc2: Y.XmlFragment) {
    // Your comparison logic here
    return { ... };
  }

READ-ONLY: You cannot modify the documents. This is purely for analysis.

═══════════════════════════════════════════════════════════════════════════
HELPER FUNCTIONS
═══════════════════════════════════════════════════════════════════════════

Text extraction:
- extractPlainText(doc) - Get all text from document
- extractText(xmlText) - Get text from Y.XmlText node
- findTextNode(element) - Find first text node in element

Finding elements:
- xpath(doc, '//heading[@level="1"]') - Query with XPath
- findByText(doc, 'search text') - Find element containing text
- findAllByText(doc, 'search text') - Find all matching elements
- getElementByType(doc, 'heading') - Get all elements of type

Comparison helpers:
- getBlockCount(doc) - Count total blocks
- getWordCount(doc) - Count total words
- getCharacterCount(doc) - Count total characters
- extractLinks(doc) - Get all links [{text, href}, ...]

Element properties:
- getAttributes(element) - Get all attributes as object
- hasAttribute(element, name, value?) - Check if attribute exists

═══════════════════════════════════════════════════════════════════════════
EXAMPLES
═══════════════════════════════════════════════════════════════════════════

// Check if title changed
export default function compare(doc1, doc2) {
  const title1 = xpath(doc1, '//heading[@level="1"]')[0];
  const title2 = xpath(doc2, '//heading[@level="1"]')[0];

  return {
    titleChanged: extractPlainText(title1) !== extractPlainText(title2),
    oldTitle: extractPlainText(title1),
    newTitle: extractPlainText(title2)
  };
}

// Count new links
export default function compare(doc1, doc2) {
  const links1 = extractLinks(doc1);
  const links2 = extractLinks(doc2);

  const newLinks = links2.filter(l2 =>
    !links1.some(l1 => l1.href === l2.href)
  );

  return { linksAdded: newLinks.length, newLinks };
}

// Word count change
export default function compare(doc1, doc2) {
  return {
    wordsAdded: getWordCount(doc2) - getWordCount(doc1),
    wordsV1: getWordCount(doc1),
    wordsV2: getWordCount(doc2)
  };
}
`;

const inputSchema = {
  type: 'object',
  properties: {
    docGuid: {
      type: 'string',
      format: 'uuid',
      description: 'Document UUID',
    },
    versionId1: {
      type: 'string',
      description: 'First version to compare (UUID, "auto-{clock}", or "clock-{clock}")',
    },
    versionId2: {
      type: 'string',
      description: 'Second version to compare (UUID, "auto-{clock}", or "clock-{clock}")',
    },
    script: {
      type: 'string',
      description: 'TypeScript source code to execute for comparison',
    },
    timeout: {
      type: 'integer',
      minimum: 100,
      maximum: 30000,
      default: 5000,
      description: 'Execution timeout in milliseconds',
    },
  },
  required: ['docGuid', 'versionId1', 'versionId2', 'script'],
};

/**
 * Tool handler
 * @param {object} args - Tool arguments
 * @param {object} agentToken - Decoded agent JWT token
 * @returns {Promise<object>}
 */
async function handler(args, agentToken) {
  if (!persistenceProvider) {
    throw new Error('Tool not initialized');
  }

  const { docGuid, versionId1, versionId2, script, timeout = 5000 } = args;
  const userId = agentToken.userId;

  // Validate timeout
  if (timeout > 30000) {
    throw new Error('Timeout cannot exceed 30000ms');
  }

  // Check document access (any role - read-only operation)
  const hasAccess = await documents.hasAccess(docGuid, userId);
  if (!hasAccess) {
    throw new Error('Document not found or you do not have access');
  }

  // Load both versions
  let doc1, doc2;
  try {
    const content1 = await versionHistory.getVersionContent(
      persistenceProvider,
      docGuid,
      versionId1
    );
    // Reconstruct Y.Doc from version content
    doc1 = new Y.Doc();
    Y.applyUpdate(doc1, new Uint8Array(content1.content));
  } catch (error) {
    throw new Error(`Version 1 not found: ${versionId1}`);
  }

  try {
    const content2 = await versionHistory.getVersionContent(
      persistenceProvider,
      docGuid,
      versionId2
    );
    // Reconstruct Y.Doc from version content
    doc2 = new Y.Doc();
    Y.applyUpdate(doc2, new Uint8Array(content2.content));
  } catch (error) {
    throw new Error(`Version 2 not found: ${versionId2}`);
  }

  // Execute comparison script
  const startTime = Date.now();
  try {
    const result = await executeComparisonScript(
      script,
      doc1.get('default', Y.XmlFragment),
      doc2.get('default', Y.XmlFragment),
      { timeout }
    );

    return {
      success: true,
      result: result,
      executionTime: Date.now() - startTime
    };
  } catch (error) {
    return {
      success: false,
      error: error.message,
      executionTime: Date.now() - startTime
    };
  }
}

module.exports = {
  name,
  description,
  inputSchema,
  handler,
  init,
};
