/**
 * compare_document_versions MCP Tool
 *
 * Compare two document versions using a TypeScript script in a read-only sandbox.
 * Scripts can extract exactly the information needed without modifying documents.
 */

const versionHistory = require('../../version-history');
const { executeComparisonScript } = require('../sandbox');
const documents = require('../../documents');
const { COMPARE_DOCUMENTATION } = require('./tool-documentation/compare-document-versions');

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

// MCP clients such as Claude Code truncate tool descriptions at 2KB, so the
// MCP-facing description is a short summary pointing to get_tool_documentation.
// The in-app chat agent receives the full reference via chatDescription.
const description = `Compare two document versions using a TypeScript script in a read-only sandbox.

REQUIRED READING: This is a summary. Call
get_tool_documentation({ tool: "compare_document_versions" }) for the full API
reference (helper functions and worked examples) BEFORE writing your first
comparison script.

SCRIPT CONTRACT: export a default function that receives two ephemeral
snapshots and returns any data you need:
  export default function compare(doc1: Y.XmlFragment, doc2: Y.XmlFragment) {
    return { ... };
  }
Write custom comparison logic (did the title change? how many sections were
added? which links are new?) instead of relying on a fixed diff format.
Built-in helpers include xpath, extractPlainText, extractText, extractLinks,
getWordCount, getBlockCount, findByText, getAttributes. Modifications to the
snapshots do not persist.

PARAMETERS:
- docGuid: Document UUID (required)
- versionId1 / versionId2: Versions to compare — UUID (named version) or clock
  number as string (required)
- script: TypeScript source code (required)
- timeout: Execution timeout in ms (optional, default 5000, max 30000)

RETURNS: { success: true, result } where result is whatever your script
returned; on script failure { success: false, error } — if the error directs
you to get_tool_documentation, fetch the docs before retrying.`;

const chatDescription = COMPARE_DOCUMENTATION;

// Appended to script errors. Script authors working from a truncated tool
// description (see the 2KB note above) fail here first; the hint gives them
// the recovery path.
const TRUNCATION_HINT =
  '\n\nHINT: The compare_document_versions tool has a scripting API (helpers, '
  + 'XPath, examples) that MCP clients truncate from its description. If you '
  + 'have not already fetched it, call '
  + 'get_tool_documentation({ tool: "compare_document_versions" }) before retrying.';

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
      description: 'First version to compare. Formats: UUID (named version) or clock number as string',
    },
    versionId2: {
      type: 'string',
      description: 'Second version to compare. Formats: UUID (named version) or clock number as string',
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

  // Load both versions (pass raw bytes to sandbox — docs are reconstructed inside the isolate)
  let snapshot1, snapshot2;
  try {
    const content1 = await versionHistory.getVersionContent(
      persistenceProvider,
      docGuid,
      versionId1
    );
    snapshot1 = content1.content;
  } catch (error) {
    throw new Error(`Version 1 not found: ${versionId1}`);
  }

  try {
    const content2 = await versionHistory.getVersionContent(
      persistenceProvider,
      docGuid,
      versionId2
    );
    snapshot2 = content2.content;
  } catch (error) {
    throw new Error(`Version 2 not found: ${versionId2}`);
  }

  // Execute comparison script in isolated-vm
  const startTime = Date.now();
  try {
    const result = await executeComparisonScript(
      script,
      snapshot1,
      snapshot2,
      { timeout }
    );

    return {
      success: true,
      result: result,
      executionTime: Date.now() - startTime
    };
  } catch (error) {
    const message = error.message.includes('get_tool_documentation')
      ? error.message
      : error.message + TRUNCATION_HINT;
    return {
      success: false,
      error: message,
      executionTime: Date.now() - startTime
    };
  }
}

module.exports = {
  name,
  description,
  chatDescription,
  inputSchema,
  handler,
  init,
};
