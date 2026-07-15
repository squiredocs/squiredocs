/**
 * Pending-authorization store (feature 008-mcp-login-bootstrap).
 *
 * The persistence layer for `mcp_pending_authorizations`. Every consuming
 * transition is a single conditional `UPDATE … RETURNING` (research R5) — no
 * read-then-write races. Under READ COMMITTED, Postgres row locking makes
 * concurrent conditional updates serialize with exactly one winner, which is
 * how the one-shot code entry, one-shot approved-payload delivery, and
 * one-shot atomic claim are all enforced.
 *
 * Handle and user code are only ever stored/queried as SHA-256 hex digests;
 * this module never sees a plaintext credential and never logs a handle/code.
 *
 * A boot-time singleton like delegation.js: init(pool) once, then use.
 */

let pool = null;

function init(dbPool) {
  pool = dbPool;
}

function requirePool() {
  if (!pool) throw new Error('pending-authorizations store not initialized');
  return pool;
}

/**
 * Insert a new pending authorization. `generateCode` is called to produce a
 * fresh `{ userCode, userCodeHash }` on each attempt so that a collision on the
 * partial-unique outstanding-code index (FR-009) can be retried with a new code
 * (cap 5 attempts; 20^8 space makes even one collision astronomically rare).
 *
 * @returns {{ row: object, userCode: string }} The inserted row and the
 *   plaintext (grouped) user code that was actually stored — the caller shows
 *   this to the agent; only its hash is persisted.
 */
async function create({ agentName, handleHash, originIp, expiresAt, generateCode }) {
  const db = requirePool();
  let lastErr = null;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const { userCode, userCodeHash } = generateCode();
    try {
      const result = await db.query(
        `INSERT INTO mcp_pending_authorizations
           (handle_hash, user_code_hash, agent_name, origin_ip, expires_at)
         VALUES ($1, $2, $3, $4, $5)
         RETURNING *`,
        [handleHash, userCodeHash, agentName, originIp, expiresAt]
      );
      return { row: result.rows[0], userCode };
    } catch (err) {
      // Regenerate and retry only on an outstanding-code collision.
      const target = `${err.constraint || ''} ${err.detail || ''}`;
      if (err.code === '23505' && /user_code/.test(target)) {
        lastErr = err;
        continue;
      }
      throw err;
    }
  }
  throw lastErr || new Error('Could not allocate a unique user code');
}

/**
 * Look up a row by handle hash (exact index lookup — no oracle: the DB compares
 * digests of attacker input, not secrets).
 */
async function findByHandleHash(handleHash) {
  const db = requirePool();
  const result = await db.query(
    'SELECT * FROM mcp_pending_authorizations WHERE handle_hash = $1',
    [handleHash]
  );
  return result.rows[0] || null;
}

/** Look up a row by primary key (consent decision ownership check). */
async function findById(id) {
  const db = requirePool();
  const result = await db.query(
    'SELECT * FROM mcp_pending_authorizations WHERE id = $1',
    [id]
  );
  return result.rows[0] || null;
}

/**
 * One-shot code consumption: bind the entering user, keep state pending.
 * Predicate rejects wrong/expired/already-used codes uniformly (0 rows).
 */
async function consumeCode(userCodeHash, userId) {
  const db = requirePool();
  const result = await db.query(
    `UPDATE mcp_pending_authorizations
     SET code_entered_at = NOW(), entered_by_user_id = $2
     WHERE user_code_hash = $1
       AND state = 'pending'
       AND code_entered_at IS NULL
       AND expires_at > NOW()
     RETURNING *`,
    [userCodeHash, userId]
  );
  return result.rows[0] || null;
}

/**
 * Atomic approve transition (caller-managed transaction — pass the tx client).
 * Zero rows ⇒ TTL lapsed between code entry and click ⇒ caller rolls back.
 */
async function approve(client, id, userId, delegationId, claimWindowSeconds) {
  const result = await client.query(
    `UPDATE mcp_pending_authorizations
     SET state = 'approved',
         approved_at = NOW(),
         approved_by_user_id = $2,
         delegation_id = $3,
         claim_expires_at = NOW() + make_interval(secs => $4)
     WHERE id = $1 AND state = 'pending' AND expires_at > NOW()
     RETURNING *`,
    [id, userId, delegationId, claimWindowSeconds]
  );
  return result.rows[0] || null;
}

/** Deny transition. Zero rows ⇒ not pending ⇒ uniform failure at the caller. */
async function deny(id) {
  const db = requirePool();
  const result = await db.query(
    `UPDATE mcp_pending_authorizations
     SET state = 'denied'
     WHERE id = $1 AND state = 'pending'
     RETURNING id`,
    [id]
  );
  return result.rows[0] || null;
}

/**
 * One-shot approved-payload delivery: sets payload_delivered_at exactly once.
 * Later status polls then answer as if expired (D12). Zero rows ⇒ already
 * delivered / not approved / window lapsed.
 */
async function markPayloadDelivered(handleHash) {
  const db = requirePool();
  const result = await db.query(
    `UPDATE mcp_pending_authorizations
     SET payload_delivered_at = NOW()
     WHERE handle_hash = $1
       AND state = 'approved'
       AND payload_delivered_at IS NULL
       AND claim_expires_at > NOW()
     RETURNING *`,
    [handleHash]
  );
  return result.rows[0] || null;
}

/**
 * Atomic one-shot claim (caller-managed transaction — pass the tx client).
 * Exactly one concurrent claim wins the row lock; losers get zero rows.
 */
async function claim(client, handleHash, channel) {
  const result = await client.query(
    `UPDATE mcp_pending_authorizations
     SET state = 'claimed', claimed_at = NOW(), claim_channel = $2
     WHERE handle_hash = $1
       AND state = 'approved'
       AND claim_expires_at > NOW()
     RETURNING *`,
    [handleHash, channel]
  );
  return result.rows[0] || null;
}

/**
 * Lazy auto-revoke sweep (FR-021): flip approved rows whose claim window has
 * lapsed to expired. Returns the affected rows so the caller can revoke each
 * delegation (cascade to any minted token).
 */
async function expireLapsedApproved() {
  const db = requirePool();
  const result = await db.query(
    `UPDATE mcp_pending_authorizations
     SET state = 'expired'
     WHERE state = 'approved' AND claim_expires_at <= NOW()
     RETURNING id, delegation_id`
  );
  return result.rows;
}

/** Lazy TTL expiry of pending rows whose authorization window has lapsed. */
async function expireLapsedPending() {
  const db = requirePool();
  const result = await db.query(
    `UPDATE mcp_pending_authorizations
     SET state = 'expired'
     WHERE state = 'pending' AND expires_at <= NOW()
     RETURNING id`
  );
  return result.rows;
}

/** Delete terminal rows older than N hours (bounded audit residue; no secrets). */
async function deleteTerminalOlderThan(hours) {
  const db = requirePool();
  const result = await db.query(
    `DELETE FROM mcp_pending_authorizations
     WHERE state IN ('denied', 'expired', 'claimed')
       AND created_at < NOW() - make_interval(hours => $1)
     RETURNING id`,
    [hours]
  );
  return result.rows;
}

/** Count of live pending authorizations from one IP (per-IP cap, FR-024). */
async function countPendingByIp(ip) {
  const db = requirePool();
  const result = await db.query(
    `SELECT COUNT(*)::int AS count
     FROM mcp_pending_authorizations
     WHERE state = 'pending' AND expires_at > NOW() AND origin_ip = $1`,
    [ip]
  );
  return result.rows[0].count;
}

/** Count of all live pending authorizations (global cap, FR-024). */
async function countPendingGlobal() {
  const db = requirePool();
  const result = await db.query(
    `SELECT COUNT(*)::int AS count
     FROM mcp_pending_authorizations
     WHERE state = 'pending' AND expires_at > NOW()`
  );
  return result.rows[0].count;
}

/**
 * Poll bookkeeping (D8): in one statement, decide whether this poll is
 * premature (arrived before required_poll_interval_seconds since the last poll),
 * bump last_polled_at, and — only on a premature poll — raise the required
 * interval by `incrementSeconds`. Returns { premature, requiredInterval } where
 * requiredInterval is the interval AFTER any bump (the value to report to the
 * caller). Unknown handle ⇒ null (caller treats as expired).
 */
async function recordPoll(handleHash, incrementSeconds) {
  const db = requirePool();
  const result = await db.query(
    `WITH cur AS (
       SELECT id,
              (last_polled_at IS NOT NULL
               AND NOW() < last_polled_at
                   + make_interval(secs => required_poll_interval_seconds)) AS premature
       FROM mcp_pending_authorizations
       WHERE handle_hash = $1
     )
     UPDATE mcp_pending_authorizations m
     SET last_polled_at = NOW(),
         required_poll_interval_seconds =
           m.required_poll_interval_seconds + CASE WHEN cur.premature THEN $2 ELSE 0 END
     FROM cur
     WHERE m.id = cur.id
     RETURNING cur.premature AS premature,
               m.required_poll_interval_seconds AS required_interval`,
    [handleHash, incrementSeconds]
  );
  if (result.rows.length === 0) return null;
  return {
    premature: result.rows[0].premature,
    requiredInterval: result.rows[0].required_interval,
  };
}

module.exports = {
  init,
  create,
  findByHandleHash,
  findById,
  consumeCode,
  approve,
  deny,
  markPayloadDelivered,
  claim,
  expireLapsedApproved,
  expireLapsedPending,
  deleteTerminalOlderThan,
  countPendingByIp,
  countPendingGlobal,
  recordPoll,
};
