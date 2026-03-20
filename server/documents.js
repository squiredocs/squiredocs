/**
 * Document permissions module - RBAC model
 * Roles: owner, editor, viewer
 */

// Role hierarchy: owner > editor > viewer
const ROLES = {
  owner: 3,
  editor: 2,
  viewer: 1,
};

// Database pool - set by init function
let pool = null;

/** Escape ILIKE metacharacters */
function escapeIlike(str) {
  return str.replace(/[\\%_]/g, '\\$&');
}

/**
 * Initialize the documents module with a database pool
 * @param {Pool} dbPool - PostgreSQL connection pool
 */
function init(dbPool) {
  pool = dbPool;
}

/**
 * Get a user's role for a document
 * @param {string} docId - Document UUID
 * @param {string} userId - User UUID
 * @returns {Promise<string|null>} Role ('owner', 'editor', 'viewer') or null
 */
async function getRole(docId, userId) {
  if (!pool) throw new Error('Documents module not initialized');

  const result = await pool.query(
    'SELECT role FROM document_shares WHERE doc_id = $1 AND user_id = $2',
    [docId, userId]
  );

  return result.rows[0]?.role || null;
}

/**
 * Check if user has at least the required role
 * @param {string} docId - Document UUID
 * @param {string} userId - User UUID
 * @param {string} requiredRole - Minimum role required
 * @returns {Promise<boolean>}
 */
async function hasRole(docId, userId, requiredRole) {
  const role = await getRole(docId, userId);
  if (!role) return false;
  return ROLES[role] >= ROLES[requiredRole];
}

// Convenience methods
const hasAccess = (docId, userId) => hasRole(docId, userId, 'viewer');
const canEdit = (docId, userId) => hasRole(docId, userId, 'editor');
const isOwner = (docId, userId) => hasRole(docId, userId, 'owner');

/**
 * Set a user's role for a document (create or update)
 * @param {string} docId - Document UUID
 * @param {string} userId - User UUID
 * @param {string} role - Role to set
 * @returns {Promise<object>} Share record
 */
async function setRole(docId, userId, role) {
  if (!pool) throw new Error('Documents module not initialized');
  if (!ROLES[role]) throw new Error(`Invalid role: ${role}`);

  const result = await pool.query(
    `INSERT INTO document_shares (doc_id, user_id, role)
     VALUES ($1, $2, $3)
     ON CONFLICT (doc_id, user_id) DO UPDATE SET role = $3
     RETURNING *`,
    [docId, userId, role]
  );

  return result.rows[0];
}

/**
 * Remove a user's access to a document
 * @param {string} docId - Document UUID
 * @param {string} userId - User UUID
 * @returns {Promise<boolean>} True if removed
 */
async function removeAccess(docId, userId) {
  if (!pool) throw new Error('Documents module not initialized');

  const result = await pool.query(
    'DELETE FROM document_shares WHERE doc_id = $1 AND user_id = $2',
    [docId, userId]
  );

  return result.rowCount > 0;
}

/**
 * Ensure a document exists (creates record in documents table)
 * @param {string} docId - Document UUID
 * @param {string} creatorId - Creator's user UUID (optional, only set on creation)
 * @returns {Promise<object>} Document record
 */
async function ensureDocument(docId, creatorId = null) {
  if (!pool) throw new Error('Documents module not initialized');

  const result = await pool.query(
    `INSERT INTO documents (id, creator_id)
     VALUES ($1, $2)
     ON CONFLICT (id) DO UPDATE SET updated_at = now()
     RETURNING *`,
    [docId, creatorId]
  );

  return result.rows[0];
}

/**
 * Create a new document with an owner
 * @param {string} docId - Document UUID
 * @param {string} ownerId - Owner's user UUID (also becomes creator)
 * @returns {Promise<object>} Document record
 */
async function createDocument(docId, ownerId) {
  if (!pool) throw new Error('Documents module not initialized');

  // Create document record with creator
  const doc = await ensureDocument(docId, ownerId);

  // Set owner role
  await setRole(docId, ownerId, 'owner');

  return doc;
}

/**
 * Get all users with access to a document
 * @param {string} docId - Document UUID
 * @returns {Promise<Array<object>>} Array of user records with role
 */
async function getDocumentUsers(docId) {
  if (!pool) throw new Error('Documents module not initialized');

  const result = await pool.query(
    `SELECT u.id, u.email, u.name, u.picture, ds.role, ds.created_at
     FROM document_shares ds
     JOIN users u ON ds.user_id = u.id
     WHERE ds.doc_id = $1
     ORDER BY 
       CASE ds.role 
         WHEN 'owner' THEN 1 
         WHEN 'editor' THEN 2 
         WHEN 'viewer' THEN 3 
       END,
       ds.created_at ASC`,
    [docId]
  );

  return result.rows;
}

/**
 * Get all documents accessible by a user with optional filtering, search, and pagination
 * @param {string} userId - User UUID
 * @param {object} options - Query options
 * @param {string} options.search - Search by title (case-insensitive partial match)
 * @param {string} options.filter - Filter by role: 'owned', 'shared_with_me', or 'all'
 * @param {string} options.sortBy - Sort field: 'title', 'updatedAt', 'createdAt'
 * @param {string} options.sortOrder - Sort direction: 'asc' or 'desc'
 * @param {number} options.limit - Max results (1-100)
 * @param {number} options.offset - Pagination offset
 * @returns {Promise<object>} { rows: Array, total: number }
 */
async function getAccessibleDocuments(userId, options = {}) {
  if (!pool) throw new Error('Documents module not initialized');

  const {
    search = null,
    filter = 'all',
    sortBy = 'updatedAt',
    sortOrder = 'desc',
    limit = null,
    offset = 0,
  } = options;

  // Validate and sanitize inputs
  const validSortBy = ['title', 'updatedAt', 'createdAt'].includes(sortBy) ? sortBy : 'updatedAt';
  const validSortOrder = sortOrder === 'asc' ? 'ASC' : 'DESC';
  const validLimit = limit ? Math.max(1, Math.min(100, parseInt(limit, 10) || 100)) : null;
  const validOffset = Math.max(0, parseInt(offset, 10) || 0);

  // Map sortBy to SQL column names
  const sortColumnMap = {
    title: 'd.title',
    updatedAt: 'd.updated_at',
    createdAt: 'd.created_at',
  };
  const sortColumn = sortColumnMap[validSortBy];

  // Build the WHERE clause for role filter
  let roleCondition = '';
  if (filter === 'owned') {
    roleCondition = "AND ds.role = 'owner'";
  } else if (filter === 'shared_with_me') {
    roleCondition = "AND ds.role != 'owner'";
  }

  // Build pagination clause
  const paginationClause = validLimit ? `LIMIT ${validLimit} OFFSET ${validOffset}` : '';

  const result = await pool.query(
    `SELECT
       d.id as doc_id,
       d.title,
       d.created_at,
       d.updated_at,
       ds.role,
       owner_share.user_id as owner_id,
       owner_user.name as owner_name,
       owner_user.email as owner_email,
       (SELECT COUNT(*) FROM document_shares WHERE doc_id = d.id) as share_count,
       COUNT(*) OVER() as total_count
     FROM documents d
     JOIN document_shares ds ON d.id = ds.doc_id AND ds.user_id = $1
     LEFT JOIN document_shares owner_share ON d.id = owner_share.doc_id AND owner_share.role = 'owner'
     LEFT JOIN users owner_user ON owner_share.user_id = owner_user.id
     WHERE ($2::text IS NULL OR d.title ILIKE '%' || $2 || '%')
     ${roleCondition}
     ORDER BY ${sortColumn} ${validSortOrder} NULLS LAST
     ${paginationClause}`,
    [userId, search ? escapeIlike(search) : null]
  );

  // Extract total count from first row (or 0 if no results)
  const total = result.rows.length > 0 ? parseInt(result.rows[0].total_count, 10) : 0;

  return { rows: result.rows, total };
}

/**
 * Find a user by email
 * @param {string} email - User's email address
 * @returns {Promise<object|null>} User record or null
 */
async function findUserByEmail(email) {
  if (!pool) throw new Error('Documents module not initialized');

  const result = await pool.query(
    'SELECT id, email, name, picture FROM users WHERE LOWER(email) = LOWER($1)',
    [email]
  );

  return result.rows[0] || null;
}

/**
 * Get document record
 * @param {string} docId - Document UUID
 * @returns {Promise<object|null>} Document record or null
 */
async function getDocument(docId) {
  if (!pool) throw new Error('Documents module not initialized');

  const result = await pool.query(
    'SELECT * FROM documents WHERE id = $1',
    [docId]
  );

  return result.rows[0] || null;
}

/**
 * Delete a document and all associated data
 * @param {string} docId - Document UUID
 * @returns {Promise<boolean>} True if deleted
 */
async function deleteDocument(docId) {
  if (!pool) throw new Error('Documents module not initialized');

  // Delete shares first (foreign key constraint)
  await pool.query('DELETE FROM document_shares WHERE doc_id = $1', [docId]);
  
  // Delete document record
  const result = await pool.query('DELETE FROM documents WHERE id = $1', [docId]);

  return result.rowCount > 0;
}

module.exports = {
  ROLES,
  init,
  getRole,
  hasRole,
  hasAccess,
  canEdit,
  isOwner,
  setRole,
  removeAccess,
  ensureDocument,
  createDocument,
  getDocument,
  deleteDocument,
  getDocumentUsers,
  getAccessibleDocuments,
  findUserByEmail,
};
