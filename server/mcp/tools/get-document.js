/**
 * get_document MCP Tool
 *
 * Reads document content and metadata.
 */
const Y = require('yjs');
const { toStructured, loadYDoc } = require('../yjs/serialization');

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
const name = 'get_document';

const description = `Read document content as structured nodes.

Returns an array of nodes where each node has:
- type: "paragraph" | "heading" | "bulletList" | "orderedList" | "codeBlock" | "listItem"
- content: Plain string, or array with formatted text like [{ text: "bold", marks: ["bold"] }]
- For headings: level (1-3)
- For lists: children array of listItem nodes
- For code blocks: optional language property

Examples of returned content:
- Paragraph: { type: "paragraph", content: "Hello world" }
- Bold text: { type: "paragraph", content: [{ text: "Important", marks: ["bold"] }] }
- Heading: { type: "heading", level: 1, content: "Title" }
- List: { type: "bulletList", children: [{ type: "listItem", content: "Item 1" }] }`;

const inputSchema = {
  type: 'object',
  properties: {
    docGuid: {
      type: 'string',
      format: 'uuid',
      description: 'The document UUID',
    },
  },
  required: ['docGuid'],
};

/**
 * Handler function for the tool
 * @param {object} args - Tool arguments
 * @param {string} args.docGuid - Document UUID
 * @param {object} agentToken - Decoded agent JWT token
 * @returns {Promise<object>} { docGuid, content, role, updatedAt }
 */
async function handler(args, agentToken) {
  if (!persistenceProvider) throw new Error('get_document tool not initialized');

  const { docGuid } = args;
  const userId = agentToken.userId;
  const pool = persistenceProvider.getPool();

  // Check if user has access to the document
  const accessResult = await pool.query(
    `SELECT d.id, d.updated_at, ds.role
     FROM documents d
     JOIN document_shares ds ON d.id = ds.doc_id AND ds.user_id = $2
     WHERE d.id = $1`,
    [docGuid, userId]
  );

  if (accessResult.rows.length === 0) {
    throw new Error('Document not found or you do not have access');
  }

  const { role, updated_at: updatedAt } = accessResult.rows[0];

  // Load the Yjs document
  const ydoc = await loadYDoc(pool, docGuid);
  const xmlFragment = ydoc.get('default', Y.XmlFragment);

  // Always return structured format
  const content = toStructured(xmlFragment);

  return {
    docGuid,
    content,
    role,
    updatedAt,
  };
}

module.exports = {
  init,
  name,
  description,
  inputSchema,
  handler,
};
