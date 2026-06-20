/**
 * Support API — "Get Support" requests submitted from the Settings page.
 *
 * Persists each request to the support_requests table and emails the admin.
 * Follows the init(pool) + Express router pattern used by admin.js / byok-settings.js.
 */
const express = require('express');
const { requireAuth } = require('../auth');
const { notifySupportRequest } = require('../email');

const router = express.Router();
let pool = null;

function init(dbPool) {
  pool = dbPool;
}

const MAX_MESSAGE_LENGTH = 5000;

/**
 * GET / — list the authenticated user's previous support requests (newest first)
 */
router.get('/', requireAuth, async (req, res) => {
  try {
    const { rows } = await pool.query(
      'SELECT id, message, created_at FROM support_requests WHERE user_id = $1 ORDER BY id DESC',
      [req.user.userId]
    );
    res.json({
      requests: rows.map((r) => ({
        id: r.id,
        message: r.message,
        createdAt: r.created_at,
      })),
    });
  } catch (err) {
    console.error('[Support] Error listing requests:', err);
    res.status(500).json({ error: 'Failed to load support requests' });
  }
});

/**
 * POST / — submit a support request
 * Body: { message: string }
 */
router.post('/', requireAuth, async (req, res) => {
  try {
    const message = typeof req.body.message === 'string' ? req.body.message.trim() : '';
    if (!message) {
      return res.status(400).json({ error: 'A message is required' });
    }
    if (message.length > MAX_MESSAGE_LENGTH) {
      return res.status(400).json({ error: `Message must be ${MAX_MESSAGE_LENGTH} characters or fewer` });
    }

    await pool.query(
      'INSERT INTO support_requests (user_id, message) VALUES ($1, $2)',
      [req.user.userId, message]
    );

    // Look up identity for the notification; fire-and-forget (never blocks/throws).
    const { rows } = await pool.query(
      'SELECT email, name FROM users WHERE id = $1',
      [req.user.userId]
    );
    const user = rows[0] || {};
    notifySupportRequest({ email: user.email, name: user.name, message });

    res.json({ success: true });
  } catch (err) {
    console.error('[Support] Error submitting request:', err);
    res.status(500).json({ error: 'Failed to submit support request' });
  }
});

module.exports = { init, router };
