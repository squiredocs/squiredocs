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

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Is this value a well-formed UUID?
 *
 * The one shape check for ids that reach a `uuid` column. Postgres answers a
 * malformed one with 22P02, which surfaces as a 500 and an exception
 * notification — so callers that promise a 404 (the /api/spaces/:id routes,
 * invariant I11) test the shape first.
 *
 * @param {*} value
 * @returns {boolean}
 */
function isUuid(value) {
  return typeof value === 'string' && UUID_PATTERN.test(value);
}

/**
 * Normalize the `space` scope shared by the document list, search and the MCP
 * `list_documents` tool (feature 053, FR-026/FR-040/FR-047).
 *
 * @param {string|null|undefined} space - `'all'`, `'personal'`, or a space uuid
 * @returns {string|null} `null` for "no scope clause" (the pre-spaces default),
 *   `'personal'`, or a validated uuid
 * @throws {Error} when the value is neither keyword nor a uuid — a typo must be
 *   a 400, not a silently unfiltered list
 */
function normalizeSpaceScope(space) {
  if (space === null || space === undefined || space === '' || space === 'all') return null;
  if (space === 'personal') return 'personal';
  if (isUuid(space)) return space;
  throw new Error("space must be 'all', 'personal', or a space id");
}

/**
 * Initialize the documents module with a database pool
 * @param {Pool} dbPool - PostgreSQL connection pool
 */
function init(dbPool) {
  pool = dbPool;
}

/**
 * Get a user's EFFECTIVE role for a document.
 *
 * Since feature 053 (spaces) this is the stronger of two grants: the user's
 * direct `document_shares` role and the role they hold in the space the
 * document lives in (`documents.space_id` → `space_members`). The space role
 * passes through uncapped — a space owner is an owner of every document in the
 * space, including delete and share management (design/spaces.md D3/D5).
 *
 * The union is computed by the `document_access` view and nowhere else; see
 * specs/053-spaces/contracts/access-derivation.md. If you need "does this user
 * DIRECTLY own it" — the move rule, the owned/shared filters, the admin counts
 * — read `document_shares` or `document_access.direct_role`, never this.
 *
 * @param {string} docId - Document UUID
 * @param {string} userId - User UUID
 * @returns {Promise<string|null>} Role ('owner', 'editor', 'viewer') or null
 */
async function getRole(docId, userId) {
  if (!pool) throw new Error('Documents module not initialized');

  const result = await pool.query(
    'SELECT role FROM document_access WHERE doc_id = $1 AND user_id = $2',
    [docId, userId]
  );

  return result.rows[0]?.role || null;
}

/**
 * Get a user's DIRECT role for a document — their `document_shares` row only,
 * ignoring anything the space grants them.
 *
 * This is the question the target-owner guards ask ("is this user the owner
 * whose direct row I must not touch?"), and it is NOT the same question as
 * `getRole`. Since spaces exist, a space-owner MEMBER has EFFECTIVE owner on
 * every document in the space (D5), so guarding on `getRole` would refuse to
 * create, change or remove that member's DIRECT share — freezing exactly the
 * grants a manager is trying to manage (post-merge review M1).
 *
 * Read through `document_access.direct_role` rather than `document_shares`, so
 * "direct" has one definition (RBD-053-7) and stays aligned with the list's
 * `direct_role` column and the owned/shared filters.
 *
 * @param {string} docId - Document UUID
 * @param {string} userId - User UUID
 * @returns {Promise<string|null>} Direct role, or null when the user has no
 *   direct share (including when they DO have space-derived access)
 */
async function getDirectRole(docId, userId) {
  if (!pool) throw new Error('Documents module not initialized');

  const result = await pool.query(
    'SELECT direct_role FROM document_access WHERE doc_id = $1 AND user_id = $2',
    [docId, userId]
  );

  return result.rows[0]?.direct_role || null;
}

/**
 * Decide what a live connection's periodic access re-check should do.
 *
 * Extracted from the 60-second interval in `server/index.js` so the DECISION is
 * executable in a test without sleeping a minute or standing up a socket
 * (feature 053 SC-003). The interval keeps the side effects — closing the
 * socket with 4403, the degraded-capability bookkeeping — and this owns the
 * question they act on.
 *
 * Since spaces exist, `revoked` is true for a member who was removed from the
 * space, whose space was deleted, or whose document was moved out of it, by
 * exactly the same path a revoked direct share already took.
 *
 * @param {string} docId
 * @param {string} userId
 * @param {boolean} tokenMayWrite - a re-check must never WIDEN what the token allows
 * @returns {Promise<{revoked: boolean, role: string|null, canEdit: boolean}>}
 */
async function evaluateAccessRecheck(docId, userId, tokenMayWrite) {
  const role = await getRole(docId, userId);
  if (!role) return { revoked: true, role: null, canEdit: false };
  return { revoked: false, role, canEdit: !!tokenMayWrite && ROLES[role] >= ROLES.editor };
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
 * Set a user's role for a document (create or update).
 *
 * This is the single INSERT chokepoint for every human sharing path, which is
 * why `grantedBy` is REQUIRED rather than defaulted (design/spaces.md D8): a
 * default would silently mis-attribute a future caller, whereas a throw fails
 * the first test that touches the path. `ON CONFLICT` overwrites the grantor
 * because a role change IS a new grant by the acting user.
 *
 * @param {string} docId - Document UUID
 * @param {string} userId - User UUID whose access is being set
 * @param {string} role - Role to set
 * @param {string} grantedBy - UUID of the user making the grant (required)
 * @returns {Promise<object>} Share record
 */
async function setRole(docId, userId, role, grantedBy) {
  if (!pool) throw new Error('Documents module not initialized');
  if (!ROLES[role]) throw new Error(`Invalid role: ${role}`);
  if (!grantedBy) {
    throw new Error('setRole requires grantedBy (D8: every share records its grantor)');
  }

  const result = await pool.query(
    `INSERT INTO document_shares (doc_id, user_id, role, granted_by)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (doc_id, user_id) DO UPDATE SET role = $3, granted_by = $4
     RETURNING *`,
    [docId, userId, role, grantedBy]
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
 * @param {string|null} [spaceId] - Space to create the document into (FR-044).
 *   Only applied on INSERT: an existing document's home is changed by
 *   `spaces.moveDocument`, which enforces the move rules, never by this.
 * @returns {Promise<object>} Document record
 */
async function ensureDocument(docId, creatorId = null, spaceId = null) {
  if (!pool) throw new Error('Documents module not initialized');

  const result = await pool.query(
    `INSERT INTO documents (id, creator_id, space_id)
     VALUES ($1, $2, $3)
     ON CONFLICT (id) DO UPDATE SET updated_at = now()
     RETURNING *`,
    [docId, creatorId, spaceId]
  );

  return result.rows[0];
}

/**
 * Create a new document with an owner
 * @param {string} docId - Document UUID
 * @param {string} ownerId - Owner's user UUID (also becomes creator)
 * @param {string|null} [title] - Optional title to set on the document row
 * @param {string|null} [spaceId] - Space to create the document into (FR-044).
 *   The creator still receives a DIRECT owner share, so their access never
 *   depends on their membership surviving.
 * @returns {Promise<object>} Document record
 */
async function createDocument(docId, ownerId, title = null, spaceId = null) {
  if (!pool) throw new Error('Documents module not initialized');

  // Create document record with creator
  const doc = await ensureDocument(docId, ownerId, spaceId);

  // Set owner role — the creator grants it to themselves (D8)
  await setRole(docId, ownerId, 'owner', ownerId);

  if (title != null) {
    const result = await pool.query(
      'UPDATE documents SET title = $1 WHERE id = $2 RETURNING *',
      [title, docId]
    );
    return result.rows[0];
  }

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
 * @param {string|Date} options.updatedSince - Only documents whose last content
 *   update (yjs_updates) is after this time. Unlike updated_at, this reflects
 *   actual edits — updated_at is also bumped when a document is merely opened.
 * @param {string} [options.space] - Space scope (feature 053): `'all'` or
 *   omitted leaves the result set byte-identical to before spaces existed,
 *   `'personal'` restricts to documents in no space, a uuid restricts to that
 *   space. A non-member asking for someone else's space id simply gets zero
 *   rows — the access join already excludes them, so there is no membership
 *   oracle here (invariant I11).
 * @returns {Promise<object>} { rows: Array, total: number } — rows carry
 *   last_clock / last_modified_at from the yjs update log (null for documents
 *   with no persisted updates), plus space_id / space_name
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
    updatedSince = null,
    space = null,
  } = options;

  let updatedSinceDate = null;
  if (updatedSince !== null && updatedSince !== undefined) {
    updatedSinceDate = new Date(updatedSince);
    if (isNaN(updatedSinceDate.getTime())) {
      throw new Error('updatedSince must be a valid ISO-8601 timestamp');
    }
  }

  // Validate and sanitize inputs
  const validSortBy = ['updatedAt', 'createdAt'].includes(sortBy) ? sortBy : 'updatedAt';
  const validSortOrder = sortOrder === 'asc' ? 'ASC' : 'DESC';
  const validLimit = limit ? Math.max(1, Math.min(100, parseInt(limit, 10) || 100)) : null;
  const validOffset = Math.max(0, parseInt(offset, 10) || 0);

  // Map sortBy to SQL column names
  const sortColumnMap = {
    updatedAt: 'd.updated_at',
    createdAt: 'd.created_at',
  };
  const sortColumn = sortColumnMap[validSortBy];

  // Build the WHERE clause for role filter.
  //
  // These read `direct_role`, not the effective `role` (RBD-053-7): "owned"
  // means the user holds a direct owner share, not that a space membership
  // lets them act like an owner. A space-only document has NO direct role at
  // all, so `shared_with_me` must accept NULL or such documents would vanish
  // from every filtered view.
  let roleCondition = '';
  if (filter === 'owned') {
    roleCondition = "AND ds.direct_role = 'owner'";
  } else if (filter === 'shared_with_me') {
    roleCondition = "AND (ds.direct_role IS NULL OR ds.direct_role <> 'owner')";
  }

  // Space scope (feature 053). `all`/omitted is the pre-spaces behavior.
  const spaceScope = normalizeSpaceScope(space);
  let spaceCondition = '';
  if (spaceScope === 'personal') {
    spaceCondition = 'AND d.space_id IS NULL';
  } else if (spaceScope !== null) {
    spaceCondition = 'AND d.space_id = $4::uuid';
  }

  // Build pagination clause
  const paginationClause = validLimit ? `LIMIT ${validLimit} OFFSET ${validOffset}` : '';

  const params = [userId, search ? escapeIlike(search) : null, updatedSinceDate];
  if (spaceScope !== null && spaceScope !== 'personal') params.push(spaceScope);

  const result = await pool.query(
    `SELECT
       d.id as doc_id,
       d.title,
       d.created_at,
       d.updated_at,
       d.space_id,
       s.name as space_name,
       lu.clock as last_clock,
       lu.created_at as last_modified_at,
       ds.role,
       ds.direct_role,
       ds.space_role,
       owner_share.user_id as owner_id,
       owner_user.name as owner_name,
       owner_user.email as owner_email,
       (SELECT COUNT(*) FROM document_shares WHERE doc_id = d.id) as share_count,
       COUNT(*) OVER() as total_count
     FROM documents d
     JOIN document_access ds ON d.id = ds.doc_id AND ds.user_id = $1
     LEFT JOIN spaces s ON s.id = d.space_id
     LEFT JOIN document_shares owner_share ON d.id = owner_share.doc_id AND owner_share.role = 'owner'
     LEFT JOIN users owner_user ON owner_share.user_id = owner_user.id
     LEFT JOIN LATERAL (
       SELECT yu.clock, yu.created_at
       FROM yjs_updates yu
       WHERE yu.doc_guid = d.id
       ORDER BY yu.clock DESC
       LIMIT 1
     ) lu ON TRUE
     WHERE ($2::text IS NULL OR d.title ILIKE '%' || $2 || '%')
     AND ($3::timestamp IS NULL OR lu.created_at > $3)
     ${roleCondition}
     ${spaceCondition}
     ORDER BY ${sortColumn} ${validSortOrder} NULLS LAST
     ${paginationClause}`,
    params
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
 * Search registered users by name or email, for the share autocomplete.
 * Excludes the requesting user and anyone who already has access to the doc.
 * @param {string} query - Partial name or email
 * @param {object} options
 * @param {string} options.excludeUserId - Requesting user's UUID (omitted from results)
 * @param {string} [options.excludeDocId] - Doc UUID; users already shared on it are omitted
 * @returns {Promise<Array<object>>} Up to 8 user records (id, email, name, picture)
 */
async function searchUsers(query, { excludeUserId, excludeDocId = null } = {}) {
  if (!pool) throw new Error('Documents module not initialized');

  const pattern = `%${escapeIlike(query)}%`;
  const result = await pool.query(
    `SELECT u.id, u.email, u.name, u.picture
     FROM users u
     WHERE (u.email ILIKE $1 OR u.name ILIKE $1)
       AND u.id <> $2
       AND ($3::uuid IS NULL OR NOT EXISTS (
         SELECT 1 FROM document_shares ds
         WHERE ds.doc_id = $3 AND ds.user_id = u.id
       ))
     ORDER BY u.name
     LIMIT 8`,
    [pattern, excludeUserId, excludeDocId]
  );

  return result.rows;
}

/**
 * Create (or update) a pending share invite for an email that is not yet a user.
 * Idempotent per (doc_id, lower(email)); a re-invite updates the role/inviter.
 * @param {string} docId - Document UUID
 * @param {string} email - Invitee email (stored as entered)
 * @param {string} role - 'editor' or 'viewer'
 * @param {string} invitedByUserId - Inviter's user UUID
 * @returns {Promise<object>} Invite record
 */
async function createInvite(docId, email, role, invitedByUserId) {
  if (!pool) throw new Error('Documents module not initialized');
  if (!ROLES[role]) throw new Error(`Invalid role: ${role}`);

  const result = await pool.query(
    `INSERT INTO document_share_invites (doc_id, email, role, invited_by_user_id)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (doc_id, lower(email))
       DO UPDATE SET role = EXCLUDED.role, invited_by_user_id = EXCLUDED.invited_by_user_id
     RETURNING *`,
    [docId, email, role, invitedByUserId]
  );

  return result.rows[0];
}

/**
 * Get all pending invites for a document.
 * @param {string} docId - Document UUID
 * @returns {Promise<Array<object>>} Invite records
 */
async function getInvitesForDoc(docId) {
  if (!pool) throw new Error('Documents module not initialized');

  const result = await pool.query(
    `SELECT id, email, role, invited_by_user_id, created_at
     FROM document_share_invites
     WHERE doc_id = $1
     ORDER BY created_at ASC`,
    [docId]
  );

  return result.rows;
}

/**
 * Remove a pending invite (case-insensitive email).
 * @param {string} docId - Document UUID
 * @param {string} email - Invitee email
 * @returns {Promise<boolean>} True if removed
 */
async function removeInvite(docId, email) {
  if (!pool) throw new Error('Documents module not initialized');

  const result = await pool.query(
    'DELETE FROM document_share_invites WHERE doc_id = $1 AND lower(email) = lower($2)',
    [docId, email]
  );

  return result.rowCount > 0;
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

  // Delete shares and pending invites first (foreign key constraint).
  // ON DELETE CASCADE also covers these, but we delete explicitly for parity.
  await pool.query('DELETE FROM document_shares WHERE doc_id = $1', [docId]);
  await pool.query('DELETE FROM document_share_invites WHERE doc_id = $1', [docId]);

  // Undo/redo chain records (feature 016): agent_edits has no FK on the
  // document, so remove the doc's rows here — the log itself is removed by
  // the caller via clearDocument, and chain state must not outlive it.
  await pool.query('DELETE FROM agent_edits WHERE doc_guid = $1', [docId]);

  // Delete document record
  const result = await pool.query('DELETE FROM documents WHERE id = $1', [docId]);

  return result.rowCount > 0;
}

module.exports = {
  ROLES,
  init,
  isUuid,
  normalizeSpaceScope,
  getRole,
  getDirectRole,
  evaluateAccessRecheck,
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
  searchUsers,
  createInvite,
  getInvitesForDoc,
  removeInvite,
};
