/**
 * share_document MCP Tool
 *
 * Shares a document with another user by email.
 */

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
const name = 'share_document';

const description = 'Share a document with another user by email address';

const inputSchema = {
  type: 'object',
  properties: {
    docGuid: {
      type: 'string',
      format: 'uuid',
      description: 'The document UUID to share',
    },
    email: {
      type: 'string',
      format: 'email',
      description: 'Email address of the user to share with',
    },
    role: {
      type: 'string',
      enum: ['editor', 'viewer'],
      default: 'viewer',
      description: 'Permission level: "editor" can edit, "viewer" can only read',
    },
  },
  required: ['docGuid', 'email'],
};

/**
 * Handler function for the tool
 * @param {object} args - Tool arguments
 * @param {string} args.docGuid - Document UUID
 * @param {string} args.email - User's email address
 * @param {string} args.role - Role to grant
 * @param {object} agentToken - Decoded agent JWT token
 * @returns {Promise<object>} { success, message }
 */
async function handler(args, agentToken) {
  if (!persistenceProvider) throw new Error('share_document tool not initialized');

  const { docGuid, email, role = 'viewer' } = args;
  const userId = agentToken.userId;
  const pool = persistenceProvider.getPool();

  // Check if user has owner access to the document
  const accessResult = await pool.query(
    `SELECT ds.role
     FROM documents d
     JOIN document_shares ds ON d.id = ds.doc_id AND ds.user_id = $2
     WHERE d.id = $1`,
    [docGuid, userId]
  );

  if (accessResult.rows.length === 0) {
    throw new Error('Document not found or you do not have access');
  }

  const { role: currentRole } = accessResult.rows[0];
  if (currentRole !== 'owner') {
    throw new Error('Only the document owner can share documents');
  }

  // Find the target user by email
  const userResult = await pool.query(
    'SELECT id, email, name FROM users WHERE LOWER(email) = LOWER($1)',
    [email]
  );

  if (userResult.rows.length === 0) {
    throw new Error(`No user found with email: ${email}`);
  }

  const targetUser = userResult.rows[0];

  // Check if user is trying to share with themselves
  if (targetUser.id === userId) {
    throw new Error('You cannot share a document with yourself');
  }

  // Check if user already has access
  const existingAccess = await pool.query(
    'SELECT role FROM document_shares WHERE doc_id = $1 AND user_id = $2',
    [docGuid, targetUser.id]
  );

  let message;
  if (existingAccess.rows.length > 0) {
    const existingRole = existingAccess.rows[0].role;
    if (existingRole === 'owner') {
      throw new Error('Cannot modify owner permissions');
    }

    // Update existing access
    await pool.query(
      'UPDATE document_shares SET role = $3 WHERE doc_id = $1 AND user_id = $2',
      [docGuid, targetUser.id, role]
    );
    message = `Updated ${targetUser.email}'s access from ${existingRole} to ${role}`;
  } else {
    // Grant new access
    await pool.query(
      'INSERT INTO document_shares (doc_id, user_id, role) VALUES ($1, $2, $3)',
      [docGuid, targetUser.id, role]
    );
    message = `Shared document with ${targetUser.email} as ${role}`;
  }

  // Update document timestamp
  await pool.query('UPDATE documents SET updated_at = now() WHERE id = $1', [docGuid]);

  const baseUrl = agentToken.baseUrl || '';
  return {
    success: true,
    message,
    docGuid,
    url: `${baseUrl}/d/${docGuid}`,
    sharedWith: {
      email: targetUser.email,
      name: targetUser.name,
      role,
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
