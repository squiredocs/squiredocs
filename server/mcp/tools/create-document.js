/**
 * create_document MCP Tool
 *
 * Creates a new document with optional initial content.
 */
const Y = require('yjs');

// Database pool - set by init function
let pool = null;

/**
 * Initialize the tool with a database pool
 * @param {Pool} dbPool - PostgreSQL connection pool
 */
function init(dbPool) {
  pool = dbPool;
}

/**
 * Tool definition for MCP discovery
 */
const name = 'create_document';

const description = 'Create a new document with optional initial content';

const inputSchema = {
  type: 'object',
  properties: {
    content: {
      type: 'string',
      description: 'Optional initial text content for the document',
    },
  },
};

/**
 * Handler function for the tool
 * @param {object} args - Tool arguments
 * @param {string} args.content - Optional initial content
 * @param {object} agentToken - Decoded agent JWT token
 * @returns {Promise<object>} { docGuid, message }
 */
async function handler(args, agentToken) {
  if (!pool) throw new Error('create_document tool not initialized');

  const { content } = args;
  const userId = agentToken.userId;

  // Create the document record with a database-generated UUID
  const docResult = await pool.query(
    `INSERT INTO documents (id, creator_id)
     VALUES (uuid_generate_v4(), $1)
     RETURNING id`,
    [userId]
  );
  const docGuid = docResult.rows[0].id;

  // Set the creator as owner
  await pool.query(
    `INSERT INTO document_shares (doc_id, user_id, role)
     VALUES ($1, $2, 'owner')`,
    [docGuid, userId]
  );

  // If content was provided, create initial Yjs document
  if (content) {
    const ydoc = new Y.Doc();
    const xmlFragment = ydoc.get('default', Y.XmlFragment);

    // Split content into paragraphs
    const paragraphs = content.split('\n');
    for (const para of paragraphs) {
      const paragraph = new Y.XmlElement('paragraph');
      const text = new Y.XmlText();
      text.insert(0, para);
      paragraph.insert(0, [text]);
      xmlFragment.insert(xmlFragment.length, [paragraph]);
    }

    // Save the initial update
    const update = Y.encodeStateAsUpdate(ydoc);
    await pool.query(
      'INSERT INTO yjs_updates (doc_guid, clock, update_data) VALUES ($1, 0, $2)',
      [docGuid, Buffer.from(update)]
    );
  }

  // Update document timestamp
  await pool.query('UPDATE documents SET updated_at = now() WHERE id = $1', [docGuid]);

  return {
    docGuid,
    message: content
      ? `Created document with ${content.length} characters of initial content`
      : 'Created empty document',
  };
}

module.exports = {
  init,
  name,
  description,
  inputSchema,
  handler,
};
