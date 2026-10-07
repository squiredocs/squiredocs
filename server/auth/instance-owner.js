/**
 * Instance owner (feature 059, RBD-059-4, research R7).
 *
 * The owner is the account the first claim link created. The claim
 * transaction records its id in `app_settings` under `instance_owner_user_id`;
 * later `squire claim-link` runs sign that account in.
 *
 * Every read and write here is direct SQL on the caller's client or pool.
 * It deliberately does NOT go through server/api/app-settings.js, whose cache
 * is per process and write-through only on the writing pod: whom a link signs
 * in must come from Postgres on every read (Constitution VII).
 *
 * Requires nothing, so the `squire` CLI can load it safely.
 */

const OWNER_KEY = 'instance_owner_user_id';

/**
 * Resolve the owner.
 *   1. the recorded id, when that user still exists;
 *   2. else the single administrator, when exactly one exists;
 *   3. else none, with a reason.
 *
 * @param {{ query: Function }} db - pool or client
 * @returns {Promise<{ user: object, via: 'record'|'single_admin' } |
 *   { user: null, reason: 'no_users'|'ambiguous_admins' }>}
 */
async function resolveOwner(db) {
  const recorded = await db.query(
    `SELECT u.* FROM app_settings s
       JOIN users u ON u.id::text = s.value
      WHERE s.key = $1`,
    [OWNER_KEY]
  );
  if (recorded.rows.length > 0) return { user: recorded.rows[0], via: 'record' };

  const admins = await db.query('SELECT * FROM users WHERE is_admin = true ORDER BY created_at LIMIT 2');
  if (admins.rows.length === 1) return { user: admins.rows[0], via: 'single_admin' };

  if (admins.rows.length === 0) {
    const any = await db.query('SELECT 1 FROM users LIMIT 1');
    if (any.rows.length === 0) return { user: null, reason: 'no_users' };
  }
  return { user: null, reason: 'ambiguous_admins' };
}

/**
 * Record the owner. Called inside the claim transaction with its client.
 * @param {{ query: Function }} db
 * @param {string} userId
 */
async function recordOwner(db, userId) {
  await db.query(
    `INSERT INTO app_settings (key, value, updated_at) VALUES ($1, $2, now())
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
    [OWNER_KEY, String(userId)]
  );
}

/**
 * @param {{ query: Function }} db
 * @returns {Promise<boolean>}
 */
async function hasOwner(db) {
  const { user } = await resolveOwner(db);
  return !!user;
}

module.exports = { OWNER_KEY, resolveOwner, recordOwner, hasOwner };
