/**
 * Spaces — shared team workspaces (feature 053).
 *
 * GROUND TRUTH: `design/spaces.md` ("Squire Spaces", Ratified 2026-08-07).
 * This module implements the decisions recorded there:
 *
 *   D1  one home per document — `documents.space_id`, NULL means personal
 *   D2  space roles reuse the existing `doc_role` enum
 *   D3  effective document role is the UNION of a direct share and a space
 *       membership; the stronger wins
 *   D4  membership is by email, with pending invites for unknown addresses
 *   D5  the space role passes through UNCAPPED — a space owner is an owner of
 *       every document in the space
 *   D6  document-level sharing thresholds are unchanged
 *   D7  the move rules (see `moveDocument`)
 *   D8  every grant records who made it (`granted_by`, NOT NULL)
 *
 * TWO RULES THAT OVERRIDE INTUITION:
 *
 * 1. NEVER `GREATEST`/`MAX`/`ORDER BY` a `doc_role`. The enum is declared
 *    ['owner','editor','viewer'] so PostgreSQL collates owner < editor <
 *    viewer, the exact inverse of the privilege ladder. Rank arithmetic lives
 *    in exactly one place, the `document_access` view. In this module,
 *    role comparisons happen in JavaScript against `documents.ROLES`.
 *
 * 2. `moveDocument`'s ownership half reads `document_shares` DIRECTLY, not
 *    `document_access`. A space owner's passthrough must not let them move
 *    someone else's document INTO a space. This is the one place in the
 *    feature where the union model is deliberately bypassed.
 *
 * Mirrors `server/documents.js`: `init(pool)`, JSDoc on every export, no
 * Express types anywhere. HTTP lives in `server/api/spaces.js`.
 */

const documents = require('./documents');

/** Database pool — set by init(). */
let pool = null;

/** Longest space name we accept (matches `spaces.name varchar(100)`). */
const MAX_NAME_LENGTH = 100;

/**
 * The single last-owner refusal message, shared by leave, remove and demote so
 * the three cannot drift (research R11).
 */
const LAST_OWNER_MESSAGE =
  'A space must have at least one owner. Make another member an owner first, or delete the space.';

/** Thrown by the service layer with a status the router maps straight through. */
class SpaceError extends Error {
  /**
   * @param {number} status - HTTP status the router should return
   * @param {string} message - Message shown to the caller verbatim
   */
  constructor(status, message) {
    super(message);
    this.name = 'SpaceError';
    this.status = status;
  }
}

/**
 * Initialize the spaces module with a database pool
 * @param {import('pg').Pool} dbPool - PostgreSQL connection pool
 */
function init(dbPool) {
  pool = dbPool;
}

function requirePool() {
  if (!pool) throw new Error('Spaces module not initialized');
  return pool;
}

/**
 * Validate and normalize a space name. Lives here, not in the router, so
 * create and rename cannot diverge (FR-004).
 *
 * Duplicates are allowed by decision (RBD-053-1): two teams may legitimately
 * both have a "Platform" space and neither can see the other's.
 *
 * @param {string} name - Raw name as entered
 * @returns {string} The trimmed name
 * @throws {SpaceError} 400 when blank or too long
 */
function validateName(name) {
  const trimmed = typeof name === 'string' ? name.trim() : '';
  if (!trimmed) throw new SpaceError(400, 'Space name is required');
  if (trimmed.length > MAX_NAME_LENGTH) {
    throw new SpaceError(400, `Space name must be ${MAX_NAME_LENGTH} characters or fewer`);
  }
  return trimmed;
}

/**
 * Validate a space role. Unlike document sharing, `owner` IS grantable here
 * (D5/FR-009) — but only by an owner, enforced by the "at most your own role"
 * rule at the call site.
 * @param {string} role
 * @returns {string} the role
 * @throws {SpaceError} 400 for anything outside the enum
 */
function validateRole(role) {
  if (!documents.ROLES[role]) {
    throw new SpaceError(400, 'Invalid role. Use "owner", "editor" or "viewer"');
  }
  return role;
}

/** Numeric rank for a role, or 0 for none. Never compare doc_role in SQL. */
function rank(role) {
  return role ? documents.ROLES[role] : 0;
}

/**
 * Create a space and make the creator its first owner, in one transaction.
 * @param {string} name - Space name (validated here)
 * @param {string} creatorId - Creating user's UUID
 * @returns {Promise<object>} { id, name, role, memberCount, createdAt }
 */
async function createSpace(name, creatorId) {
  const db = requirePool();
  const clean = validateName(name);

  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(
      'INSERT INTO spaces (name, created_by) VALUES ($1, $2) RETURNING id, name, created_at',
      [clean, creatorId]
    );
    const space = rows[0];
    // The creator grants themselves owner (D8: every membership has a grantor).
    await client.query(
      `INSERT INTO space_members (space_id, user_id, role, granted_by)
       VALUES ($1, $2, 'owner', $2)`,
      [space.id, creatorId]
    );
    await client.query('COMMIT');
    return {
      id: space.id,
      name: space.name,
      role: 'owner',
      memberCount: 1,
      createdAt: space.created_at,
    };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

/**
 * Fetch a space row by id.
 * @param {string} spaceId
 * @returns {Promise<object|null>} The row, or null
 */
async function getSpace(spaceId) {
  const db = requirePool();
  const { rows } = await db.query('SELECT * FROM spaces WHERE id = $1', [spaceId]);
  return rows[0] || null;
}

/**
 * Every space this user is a member of, with their role and the member count.
 * Membership-scoped by construction — there is no "all spaces" read anywhere.
 * @param {string} userId
 * @returns {Promise<Array<object>>} ordered by name
 */
async function getSpacesForUser(userId) {
  const db = requirePool();
  const { rows } = await db.query(
    `SELECT s.id, s.name, m.role, s.created_at,
            (SELECT count(*) FROM space_members m2 WHERE m2.space_id = s.id) AS member_count
       FROM spaces s
       JOIN space_members m ON m.space_id = s.id AND m.user_id = $1
      ORDER BY s.name ASC`,
    [userId]
  );
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    role: r.role,
    memberCount: Number(r.member_count),
    createdAt: r.created_at,
  }));
}

/**
 * This user's role in a space, or null if they are not a member.
 * @param {string} spaceId
 * @param {string} userId
 * @param {import('pg').PoolClient} [client] - run inside an existing transaction
 * @returns {Promise<string|null>}
 */
async function getMemberRole(spaceId, userId, client = null) {
  const q = client || requirePool();
  const { rows } = await q.query(
    'SELECT role FROM space_members WHERE space_id = $1 AND user_id = $2',
    [spaceId, userId]
  );
  return rows[0]?.role || null;
}

/**
 * All members of a space with their user details and grantor.
 * @param {string} spaceId
 * @returns {Promise<Array<object>>} owners first, then editors, then viewers
 */
async function getMembers(spaceId) {
  const db = requirePool();
  const { rows } = await db.query(
    `SELECT m.user_id, u.email, u.name, u.picture, m.role, m.granted_by, m.created_at
       FROM space_members m
       JOIN users u ON u.id = m.user_id
      WHERE m.space_id = $1
      ORDER BY
        CASE m.role WHEN 'owner' THEN 1 WHEN 'editor' THEN 2 ELSE 3 END,
        m.created_at ASC`,
    [spaceId]
  );
  return rows.map((r) => ({
    userId: r.user_id,
    email: r.email,
    name: r.name,
    picture: r.picture,
    role: r.role,
    grantedBy: r.granted_by,
    createdAt: r.created_at,
  }));
}

/**
 * Pending invites for a space.
 *
 * Visible to ALL members, not just owners (RBD-053-16): the design defines the
 * detail view as "members, pending invites, document count", and the document
 * share dialog already shows pending invites to everyone who can see the
 * document. Only revoking is owner-only.
 *
 * @param {string} spaceId
 * @returns {Promise<Array<object>>}
 */
async function getInvites(spaceId) {
  const db = requirePool();
  const { rows } = await db.query(
    'SELECT email, role, created_at FROM space_invites WHERE space_id = $1 ORDER BY created_at ASC',
    [spaceId]
  );
  return rows.map((r) => ({ email: r.email, role: r.role, createdAt: r.created_at }));
}

/**
 * How many documents currently live in a space. Used by the delete
 * confirmation, which must state the count before the user commits (FR-024).
 * @param {string} spaceId
 * @returns {Promise<number>}
 */
async function countDocuments(spaceId) {
  const db = requirePool();
  const { rows } = await db.query(
    'SELECT count(*) AS n FROM documents WHERE space_id = $1',
    [spaceId]
  );
  return Number(rows[0].n);
}

/**
 * The detail payload for one space, from a member's point of view.
 * The caller has already established membership; this does not re-check.
 * @param {string} spaceId
 * @param {string} viewerId - the member asking
 * @returns {Promise<object>} { space, members, invites }
 */
async function getSpaceDetail(spaceId, viewerId) {
  const space = await getSpace(spaceId);
  if (!space) return null;
  const [role, members, invites, documentCount] = await Promise.all([
    getMemberRole(spaceId, viewerId),
    getMembers(spaceId),
    getInvites(spaceId),
    countDocuments(spaceId),
  ]);
  return {
    space: { id: space.id, name: space.name, role, documentCount, createdAt: space.created_at },
    members,
    invites,
  };
}

/**
 * Rename a space. Authorization is the router's job.
 * @param {string} spaceId
 * @param {string} name - validated here, same rule as create (FR-004)
 * @returns {Promise<object|null>} { id, name }
 */
async function renameSpace(spaceId, name) {
  const db = requirePool();
  const clean = validateName(name);
  const { rows } = await db.query(
    'UPDATE spaces SET name = $2 WHERE id = $1 RETURNING id, name',
    [spaceId, clean]
  );
  return rows[0] || null;
}

/**
 * Delete a space.
 *
 * `space_members` and `space_invites` cascade. `documents.space_id` reverts to
 * NULL through the FK's `ON DELETE SET NULL` — NO DOCUMENT IS DELETED, and
 * content, history and direct shares are untouched (FR-024). That behavior is
 * a foreign-key action rather than code here on purpose: it cannot be
 * forgotten by a future delete path.
 *
 * @param {string} spaceId
 * @returns {Promise<{deleted: boolean, documentsReverted: number}>}
 */
async function deleteSpace(spaceId) {
  const db = requirePool();
  const documentsReverted = await countDocuments(spaceId);
  const result = await db.query('DELETE FROM spaces WHERE id = $1', [spaceId]);
  return { deleted: result.rowCount > 0, documentsReverted };
}

/**
 * Refuse an operation that would leave a space with no owner (FR-010, I3).
 *
 * Takes an EXISTING pg client so it runs inside the caller's transaction: the
 * count must be taken under the same lock as the mutation, or two concurrent
 * leaves can both observe two owners and both succeed.
 *
 * One guard, one message, three callers (leave, remove, demote) — anything
 * else guarantees the three drift (research R11).
 *
 * @param {import('pg').PoolClient} client - inside a transaction
 * @param {string} spaceId
 * @param {string} userId - the member about to lose ownership
 * @throws {SpaceError} 409 when this user is the space's last owner
 */
async function assertNotLastOwner(client, spaceId, userId) {
  // Lock the owner ROWS (not a count — Postgres refuses FOR UPDATE alongside an
  // aggregate) so a concurrent departure cannot slip between this read and the
  // mutation that follows it.
  const { rows: owners } = await client.query(
    `SELECT user_id FROM space_members
      WHERE space_id = $1 AND role = 'owner'
      FOR UPDATE`,
    [spaceId]
  );
  const callerIsOwner = owners.some((o) => o.user_id === userId);
  if (callerIsOwner && owners.length === 1) {
    throw new SpaceError(409, LAST_OWNER_MESSAGE);
  }
}

/**
 * Invite someone to a space by email (FR-016..FR-021).
 *
 * Two branches on one rule set:
 *   - the address already has an account → a `space_members` row, immediately;
 *   - it does not → a `space_invites` row, converted at their first login.
 *
 * Both are RAISE-ONLY upserts (I6 / RBD-053-9): re-inviting at a higher role
 * promotes, re-inviting at a lower role is a no-op. The comparison is done in
 * JavaScript against `documents.ROLES`, NOT with SQL `GREATEST`, because the
 * `doc_role` enum collates backwards (research R12).
 *
 * Note this deliberately diverges from `documents.createInvite`, whose
 * `DO UPDATE SET role = EXCLUDED.role` lets a later invite LOWER a pending
 * document invite. The space behavior is monotone by decision; the document
 * behavior is out of scope for this feature.
 *
 * The caller is responsible for the "role ≤ your own role" check and for
 * sending mail; this returns what happened so the router can do both.
 *
 * @param {string} spaceId
 * @param {string} email - as entered; matched case-insensitively
 * @param {string} role
 * @param {string} actorId - the inviting member (becomes `granted_by`)
 * @returns {Promise<object>} `{ kind: 'member', member }` or `{ kind: 'invite', invite }`
 */
async function inviteMember(spaceId, email, role, actorId) {
  const db = requirePool();
  validateRole(role);
  const address = typeof email === 'string' ? email.trim() : '';
  if (!address) throw new SpaceError(400, 'email is required');

  const user = await documents.findUserByEmail(address);

  if (user) {
    const existing = await getMemberRole(spaceId, user.id);
    // Raise-only: a lower or equal re-invite leaves the membership alone.
    const winner = rank(role) > rank(existing) ? role : existing;
    if (existing && winner === existing) {
      return { kind: 'member', member: await memberPayload(spaceId, user.id), raised: false };
    }
    await db.query(
      `INSERT INTO space_members (space_id, user_id, role, granted_by)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (space_id, user_id) DO UPDATE SET role = $3, granted_by = $4`,
      [spaceId, user.id, winner, actorId]
    );
    return { kind: 'member', member: await memberPayload(spaceId, user.id), raised: true };
  }

  const { rows: existingInvite } = await db.query(
    'SELECT role FROM space_invites WHERE space_id = $1 AND lower(email) = lower($2)',
    [spaceId, address]
  );
  const previous = existingInvite[0]?.role || null;
  const winner = rank(role) > rank(previous) ? role : previous;
  if (previous && winner === previous) {
    return { kind: 'invite', invite: { email: address, role: previous, pending: true }, raised: false };
  }
  await db.query(
    `INSERT INTO space_invites (space_id, email, role, invited_by_user_id)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (space_id, lower(email))
       DO UPDATE SET role = $3, invited_by_user_id = $4`,
    [spaceId, address, winner, actorId]
  );
  return { kind: 'invite', invite: { email: address, role: winner, pending: true }, raised: true };
}

/** One member's public shape, re-read after a write. */
async function memberPayload(spaceId, userId) {
  const db = requirePool();
  const { rows } = await db.query(
    `SELECT m.user_id, u.email, u.name, u.picture, m.role, m.granted_by, m.created_at
       FROM space_members m JOIN users u ON u.id = m.user_id
      WHERE m.space_id = $1 AND m.user_id = $2`,
    [spaceId, userId]
  );
  const r = rows[0];
  if (!r) return null;
  return {
    userId: r.user_id,
    email: r.email,
    name: r.name,
    picture: r.picture,
    role: r.role,
    grantedBy: r.granted_by,
    createdAt: r.created_at,
  };
}

/**
 * Change a member's role. Owner-only; the router enforces that.
 * Demoting the last owner is refused (FR-010).
 * @param {string} spaceId
 * @param {string} userId - the member being changed
 * @param {string} role
 * @param {string} actorId - becomes the new `granted_by` (a role change is a new grant)
 * @returns {Promise<object|null>} the updated member
 */
async function setMemberRole(spaceId, userId, role, actorId) {
  const db = requirePool();
  validateRole(role);
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const current = await getMemberRole(spaceId, userId, client);
    if (!current) throw new SpaceError(404, 'Member not found');
    if (role !== 'owner') {
      await assertNotLastOwner(client, spaceId, userId);
    }
    await client.query(
      'UPDATE space_members SET role = $3, granted_by = $4 WHERE space_id = $1 AND user_id = $2',
      [spaceId, userId, role, actorId]
    );
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
  return memberPayload(spaceId, userId);
}

/**
 * Remove a member, or let one leave (the router decides which by comparing
 * `:userId` to the caller). Deletes ONLY the `space_members` row: the member's
 * direct shares on space documents survive (FR-022).
 * @param {string} spaceId
 * @param {string} userId
 * @returns {Promise<boolean>} true if a membership was removed
 */
async function removeMember(spaceId, userId) {
  const db = requirePool();
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    await assertNotLastOwner(client, spaceId, userId);
    const result = await client.query(
      'DELETE FROM space_members WHERE space_id = $1 AND user_id = $2',
      [spaceId, userId]
    );
    await client.query('COMMIT');
    return result.rowCount > 0;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

/**
 * Revoke a pending invite (case-insensitive, idempotent). Owner-only per
 * RBD-053-4; the router enforces that.
 * @param {string} spaceId
 * @param {string} email
 * @returns {Promise<boolean>} true if a row was removed
 */
async function revokeInvite(spaceId, email) {
  const db = requirePool();
  const result = await db.query(
    'DELETE FROM space_invites WHERE space_id = $1 AND lower(email) = lower($2)',
    [spaceId, email]
  );
  return result.rowCount > 0;
}

/**
 * Convert this user's pending space invites into memberships (FR-018).
 *
 * Takes the CALLER'S pg client so it runs inside `convertPendingInvites`'
 * transaction: a login converts everything or nothing (research R6).
 *
 * `DO NOTHING` on conflict is the monotonicity rule at conversion time (I6): a
 * membership acquired between the invite and the first login is never
 * downgraded by the stale invite.
 *
 * `granted_by` falls back through COALESCE because `invited_by_user_id` is
 * nullable (the inviter's account may be gone) while `granted_by` is NOT NULL —
 * RBD-053-13. The last term is the invitee themselves, which is always present.
 *
 * @param {import('pg').PoolClient} client - inside the caller's transaction
 * @param {{id: string, email: string}} user - the user logging in
 * @returns {Promise<number>} number of memberships created
 */
async function convertPendingSpaceInvites(client, user) {
  const inserted = await client.query(
    `INSERT INTO space_members (space_id, user_id, role, granted_by)
     SELECT i.space_id, $1, i.role,
            COALESCE(i.invited_by_user_id,
                     (SELECT o.user_id FROM space_members o
                       WHERE o.space_id = i.space_id AND o.role = 'owner' LIMIT 1),
                     $1)
       FROM space_invites i
      WHERE lower(i.email) = lower($2)
     ON CONFLICT (space_id, user_id) DO NOTHING`,
    [user.id, user.email]
  );
  await client.query('DELETE FROM space_invites WHERE lower(email) = lower($1)', [user.email]);
  return inserted.rowCount;
}

/**
 * Move a document into a space, out of one, or between two (D7 / FR-011..014).
 *
 * THE RULES, composed:
 *   move OUT  (S → NULL): the actor holds a DIRECT owner share, OR is an
 *                         `owner` member of the source space. The second is the
 *                         "curation" path and may only target NULL (RBD-053-3).
 *   move IN   (NULL → S): the actor holds a DIRECT owner share AND is an
 *                         editor-or-owner member of the target.
 *   move ACROSS (A → B):  both of the above must hold.
 *
 * WHY "DIRECT": the ownership half reads `document_shares`, NOT
 * `document_access`. A space owner has passthrough owner on every document in
 * their space (D5); letting that satisfy the move-in rule would let them
 * relocate someone else's document into a space of their choosing (US3
 * scenario 5). The view exposes `direct_role` precisely so the two agree if a
 * later refactor prefers reading it from there.
 *
 * Runs in ONE transaction with `SELECT ... FOR UPDATE` on the document row, so
 * two simultaneous moves serialize and the document's home is always exactly
 * one space or personal — never a dangling reference. NEVER writes
 * `document_shares` (I9/FR-014): a move changes reachability, not grants.
 *
 * @param {string} actorId
 * @param {string} docId
 * @param {string|null} targetSpaceId - null moves the document to personal
 * @returns {Promise<{docId: string, spaceId: string|null, spaceName: string|null}>}
 * @throws {SpaceError} 404/403 per contracts/spaces-rest-api.md
 */
async function moveDocument(actorId, docId, targetSpaceId) {
  const db = requirePool();
  const client = await db.connect();
  try {
    await client.query('BEGIN');

    const { rows: docRows } = await client.query(
      'SELECT id, space_id FROM documents WHERE id = $1 FOR UPDATE',
      [docId]
    );
    const doc = docRows[0];
    if (!doc) throw new SpaceError(404, 'Document not found');

    const sourceSpaceId = doc.space_id;

    // Effective access first: someone with no access at all must not be able to
    // tell a document they cannot see from one that does not exist.
    const { rows: accessRows } = await client.query(
      'SELECT role FROM document_access WHERE doc_id = $1 AND user_id = $2',
      [docId, actorId]
    );
    if (!accessRows[0]) throw new SpaceError(404, 'Document not found');

    // Same target — a no-op success, not an error (spec edge case).
    if ((sourceSpaceId || null) === (targetSpaceId || null)) {
      const name = targetSpaceId ? (await getSpace(targetSpaceId))?.name || null : null;
      await client.query('COMMIT');
      return { docId, spaceId: targetSpaceId || null, spaceName: name };
    }

    // The ownership half — DIRECT share only. See the docblock.
    const { rows: directRows } = await client.query(
      'SELECT role FROM document_shares WHERE doc_id = $1 AND user_id = $2',
      [docId, actorId]
    );
    const isDirectOwner = directRows[0]?.role === 'owner';

    const sourceRole = sourceSpaceId
      ? await getMemberRole(sourceSpaceId, actorId, client)
      : null;

    // ── move OUT half ────────────────────────────────────────────────────────
    let curationOnly = false;
    if (sourceSpaceId) {
      if (isDirectOwner) {
        // fine
      } else if (sourceRole === 'owner') {
        curationOnly = true;
      } else {
        throw new SpaceError(
          403,
          'Only the document owner or an owner of its space can move it out'
        );
      }
    } else if (!isDirectOwner) {
      throw new SpaceError(403, 'Only the document owner can move it into a space');
    }

    // ── move IN half ─────────────────────────────────────────────────────────
    if (targetSpaceId) {
      if (curationOnly) {
        // A space owner curating someone else's document may only evict it.
        throw new SpaceError(403, 'You can only move this document out to your personal area');
      }
      const { rows: targetRows } = await client.query(
        'SELECT id, name FROM spaces WHERE id = $1 FOR SHARE',
        [targetSpaceId]
      );
      if (!targetRows[0]) throw new SpaceError(404, 'Space not found');
      const targetRole = await getMemberRole(targetSpaceId, actorId, client);
      if (!targetRole) throw new SpaceError(404, 'Space not found');
      if (rank(targetRole) < documents.ROLES.editor) {
        throw new SpaceError(403, 'You must be an editor or owner of the target space');
      }
      await client.query('UPDATE documents SET space_id = $2 WHERE id = $1', [
        docId,
        targetSpaceId,
      ]);
      await client.query('COMMIT');
      return { docId, spaceId: targetSpaceId, spaceName: targetRows[0].name };
    }

    await client.query('UPDATE documents SET space_id = NULL WHERE id = $1', [docId]);
    await client.query('COMMIT');
    return { docId, spaceId: null, spaceName: null };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

module.exports = {
  SpaceError,
  LAST_OWNER_MESSAGE,
  MAX_NAME_LENGTH,
  init,
  validateName,
  validateRole,
  createSpace,
  getSpace,
  getSpacesForUser,
  getSpaceDetail,
  getMemberRole,
  getMembers,
  getInvites,
  countDocuments,
  renameSpace,
  deleteSpace,
  assertNotLastOwner,
  inviteMember,
  setMemberRole,
  removeMember,
  revokeInvite,
  convertPendingSpaceInvites,
  moveDocument,
};
