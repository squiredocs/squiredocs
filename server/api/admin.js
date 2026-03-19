/**
 * Admin API — user list with stats
 *
 * Follows the init(pool) + Express router pattern used by ai-usage.js.
 */
const express = require('express');

const router = express.Router();
let pool = null;

function init(dbPool) {
  pool = dbPool;
}

/**
 * GET /  — list all users with aggregate stats
 */
router.get('/', async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT
        u.id, u.name, u.email, u.picture, u.is_admin,
        u.ai_credit_cents, u.created_at, u.last_login_at,
        COALESCE(d.doc_count, 0)::int AS doc_count,
        COALESCE(a.ai_used_cents, 0)::int AS ai_used_cents
      FROM users u
      LEFT JOIN (
        SELECT user_id, COUNT(*) AS doc_count
        FROM document_shares
        WHERE role = 'owner'
        GROUP BY user_id
      ) d ON d.user_id = u.id
      LEFT JOIN (
        SELECT user_id, SUM(cost_cents)::int AS ai_used_cents
        FROM ai_usage_log
        WHERE created_at >= date_trunc('month', now())
          AND is_byok = false
        GROUP BY user_id
      ) a ON a.user_id = u.id
      ORDER BY u.created_at DESC
    `);

    const users = rows.map((r) => ({
      id: r.id,
      name: r.name,
      email: r.email,
      picture: r.picture,
      isAdmin: r.is_admin,
      aiCreditCents: r.ai_credit_cents,
      createdAt: r.created_at,
      lastLoginAt: r.last_login_at,
      docCount: parseInt(r.doc_count, 10),
      aiUsedCents: parseInt(r.ai_used_cents, 10),
      aiRemainingCents: Math.max(0, r.ai_credit_cents - parseInt(r.ai_used_cents, 10)),
    }));

    res.json({ users });
  } catch (err) {
    console.error('[Admin] Error fetching users:', err);
    res.status(500).json({ error: 'Failed to fetch users' });
  }
});

module.exports = { init, router };
