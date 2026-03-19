/**
 * Admin API — user list with stats, extra credit grants
 *
 * Follows the init(pool) + Express router pattern used by ai-usage.js.
 */
const express = require('express');
const aiUsage = require('../ai-usage');

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
        COALESCE(a.ai_used_cents, 0)::int AS ai_used_cents,
        COALESCE(ec.ai_extra_credit_cents, 0)::int AS ai_extra_credit_cents
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
      LEFT JOIN (
        SELECT user_id, SUM(amount_cents - used_cents)::int AS ai_extra_credit_cents
        FROM ai_extra_credits
        WHERE used_cents < amount_cents
          AND (expires_at IS NULL OR expires_at > now())
        GROUP BY user_id
      ) ec ON ec.user_id = u.id
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
      aiExtraCreditCents: parseInt(r.ai_extra_credit_cents, 10),
      aiRemainingCents: Math.max(0, r.ai_credit_cents + parseInt(r.ai_extra_credit_cents, 10) - parseInt(r.ai_used_cents, 10)),
    }));

    res.json({ users });
  } catch (err) {
    console.error('[Admin] Error fetching users:', err);
    res.status(500).json({ error: 'Failed to fetch users' });
  }
});

/**
 * POST /extra-credits — grant extra AI credits to a user
 * Body: { userId, amountCents, memo?, expiresAt? }
 */
router.post('/extra-credits', async (req, res) => {
  try {
    const { userId, amountCents, memo, expiresAt } = req.body;

    if (!userId || !amountCents || typeof amountCents !== 'number' || amountCents <= 0) {
      return res.status(400).json({ error: 'userId and positive amountCents are required' });
    }

    if (expiresAt) {
      const expDate = new Date(expiresAt);
      if (isNaN(expDate.getTime()) || expDate <= new Date()) {
        return res.status(400).json({ error: 'expiresAt must be a valid future date' });
      }
    }

    const grant = await aiUsage.grantExtraCredits(userId, Math.round(amountCents), {
      memo,
      grantedBy: req.user.userId,
      expiresAt: expiresAt || null,
    });

    res.json({ grant });
  } catch (err) {
    console.error('[Admin] Error granting extra credits:', err);
    res.status(500).json({ error: 'Failed to grant extra credits' });
  }
});

module.exports = { init, router };
