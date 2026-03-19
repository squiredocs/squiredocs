/**
 * Admin API — user list with stats, credit management
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
 * PATCH /:userId/credit — update a user's monthly AI credit allowance
 * Body: { aiCreditCents: number }
 */
router.patch('/:userId/credit', async (req, res) => {
  try {
    const { userId } = req.params;
    const { aiCreditCents } = req.body;

    if (typeof aiCreditCents !== 'number' || aiCreditCents < 0) {
      return res.status(400).json({ error: 'aiCreditCents must be a non-negative number' });
    }

    const result = await pool.query(
      'UPDATE users SET ai_credit_cents = $1 WHERE id = $2 RETURNING ai_credit_cents',
      [Math.round(aiCreditCents), userId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }

    res.json({ aiCreditCents: result.rows[0].ai_credit_cents });
  } catch (err) {
    console.error('[Admin] Error updating credit:', err);
    res.status(500).json({ error: 'Failed to update credit' });
  }
});

/**
 * GET /:userId/extra-credits — list all extra credit records for a user
 */
router.get('/:userId/extra-credits', async (req, res) => {
  try {
    const { userId } = req.params;

    const { rows } = await pool.query(
      `SELECT ec.id, ec.amount_cents, ec.used_cents, ec.memo,
              ec.created_at, ec.expires_at,
              g.name AS granted_by_name
       FROM ai_extra_credits ec
       LEFT JOIN users g ON g.id = ec.granted_by
       WHERE ec.user_id = $1
       ORDER BY ec.id DESC`,
      [userId]
    );

    const credits = rows.map((r) => ({
      id: r.id,
      amountCents: r.amount_cents,
      usedCents: r.used_cents,
      remainingCents: r.amount_cents - r.used_cents,
      memo: r.memo,
      grantedByName: r.granted_by_name,
      createdAt: r.created_at,
      expiresAt: r.expires_at,
      isExpired: !!(r.expires_at && new Date(r.expires_at) <= new Date()),
      isDepleted: r.used_cents >= r.amount_cents,
    }));

    res.json({ credits });
  } catch (err) {
    console.error('[Admin] Error fetching extra credits:', err);
    res.status(500).json({ error: 'Failed to fetch extra credits' });
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

/**
 * DELETE /extra-credits/:creditId — remove an extra credit record
 */
router.delete('/extra-credits/:creditId', async (req, res) => {
  try {
    const { creditId } = req.params;

    const result = await pool.query(
      'DELETE FROM ai_extra_credits WHERE id = $1 RETURNING id',
      [creditId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Extra credit record not found' });
    }

    res.json({ success: true });
  } catch (err) {
    console.error('[Admin] Error deleting extra credit:', err);
    res.status(500).json({ error: 'Failed to delete extra credit' });
  }
});

module.exports = { init, router };
