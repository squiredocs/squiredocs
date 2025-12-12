/**
 * Waitlist management module
 * Handles email signups for the waitlist
 */

const express = require('express');
const router = express.Router();

let pool = null;

/**
 * Initialize with database pool
 * @param {import('pg').Pool} dbPool
 */
function init(dbPool) {
  pool = dbPool;
}

/**
 * Validate email format
 * @param {string} email
 * @returns {boolean}
 */
function isValidEmail(email) {
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  return emailRegex.test(email);
}

/**
 * POST /api/waitlist
 * Add an email to the waitlist
 */
router.post('/', async (req, res) => {
  try {
    const { email, role, org_size } = req.body;

    // Validate email
    if (!email) {
      return res.status(400).json({ error: 'Email is required' });
    }

    const normalizedEmail = email.toLowerCase().trim();

    if (!isValidEmail(normalizedEmail)) {
      return res.status(400).json({ error: 'Invalid email format' });
    }

    // Validate role if provided
    const validRoles = ['consultant', 'legal', 'grant_writer', 'rfp_manager', 'other'];
    if (role && !validRoles.includes(role)) {
      return res.status(400).json({ error: 'Invalid role' });
    }

    // Validate org_size if provided
    const validOrgSizes = ['1-10', '11-50', '51-200', '201-1000', '1000+'];
    if (org_size && !validOrgSizes.includes(org_size)) {
      return res.status(400).json({ error: 'Invalid organization size' });
    }

    // Insert into waitlist (handle duplicate gracefully)
    const result = await pool.query(
      `INSERT INTO waitlist (email, role, org_size)
       VALUES ($1, $2, $3)
       ON CONFLICT (email) DO UPDATE SET
         role = COALESCE(EXCLUDED.role, waitlist.role),
         org_size = COALESCE(EXCLUDED.org_size, waitlist.org_size)
       RETURNING id, email, created_at`,
      [normalizedEmail, role || null, org_size || null]
    );

    res.status(201).json({
      success: true,
      message: "You're on the list! We'll be in touch soon.",
      id: result.rows[0].id,
    });
  } catch (error) {
    console.error('Waitlist signup error:', error);
    res.status(500).json({ error: 'Failed to join waitlist. Please try again.' });
  }
});

module.exports = { router, init };
