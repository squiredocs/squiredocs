/**
 * Admin API — user list with stats, credit management
 *
 * Follows the init(pool) + Express router pattern used by ai-usage.js.
 */
const express = require('express');
const aiUsage = require('../ai-usage');
const { sendWelcomeEmail } = require('../email');
const appSettings = require('./app-settings');
const { MODEL_DEFS, getAvailableModels, resolveSharedDefaultKey } = require('./chat-models');
const { hasServerKey, listProviders } = require('./ai-providers');

const router = express.Router();
let pool = null;

function init(dbPool) {
  pool = dbPool;
}

/**
 * Models eligible to back the shared-assistant default: those whose provider has
 * a shared server key in this deployment (BYOK-only providers are excluded, since
 * the shared assistant has no user key to run them on).
 *
 * Each entry carries the registry's `pricing` (cents per 1M tokens, e.g. 500 →
 * $5/1M) alongside the getAvailableModels() fields, so the admin picker can show
 * what a model costs while it's being chosen. Registry entries without pricing
 * simply omit the field; the client renders those label-only.
 */
function sharedDefaultModels() {
  return getAvailableModels()
    .filter((m) => hasServerKey(m.provider))
    .map((m) => {
      const pricing = MODEL_DEFS.find((d) => d.key === m.key)?.pricing;
      return pricing ? { ...m, pricing: { input: pricing.input, output: pricing.output } } : m;
    });
}

/**
 * Providers eligible to back the shared-assistant default (those with a configured
 * shared server key), as `{ id, label }`. Additive to the shared-model response so
 * the admin picker can group models under provider <optgroup>s, mirroring the BYOK
 * selector (feature 026 FR-004). Single-sourced from the provider registry so
 * labels never drift. Every sharedDefaultModels() entry's provider appears here.
 */
function sharedDefaultProviders() {
  return listProviders()
    .filter((p) => hasServerKey(p.id))
    .map((p) => ({ id: p.id, label: p.label }));
}

/**
 * GET /settings/shared-model — the shared-assistant default model.
 * Returns the admin-selected key (may be null), the effective key actually used
 * (after env/constant fallback), and the list of eligible models.
 */
router.get('/settings/shared-model', async (req, res) => {
  try {
    const storedKey = appSettings.getSharedDefaultModel();
    res.json({
      modelKey: storedKey,
      effectiveModelKey: resolveSharedDefaultKey(storedKey),
      // What the default resolves to with no admin selection stored — shown in
      // the picker's "Deployment default" label even while an override is set.
      deploymentDefaultKey: resolveSharedDefaultKey(null),
      models: sharedDefaultModels(),
      providers: sharedDefaultProviders(),
    });
  } catch (err) {
    console.error('[Admin] Error fetching shared model:', err);
    res.status(500).json({ error: 'Failed to fetch shared model setting' });
  }
});

/**
 * PUT /settings/shared-model — set the shared-assistant default model.
 * Body: { modelKey: string | null }  (null clears the override → env/constant default)
 */
router.put('/settings/shared-model', async (req, res) => {
  try {
    const { modelKey } = req.body;

    if (modelKey !== null) {
      const def = MODEL_DEFS.find((d) => d.key === modelKey);
      if (!def) {
        return res.status(400).json({ error: `Unknown model: ${modelKey}` });
      }
      if (!hasServerKey(def.provider)) {
        return res.status(400).json({
          error: `Model "${modelKey}" has no shared server key and can't be the shared default`,
        });
      }
    }

    await appSettings.setSharedDefaultModel(modelKey);

    const storedKey = appSettings.getSharedDefaultModel();
    res.json({
      modelKey: storedKey,
      effectiveModelKey: resolveSharedDefaultKey(storedKey),
      deploymentDefaultKey: resolveSharedDefaultKey(null),
      models: sharedDefaultModels(),
      providers: sharedDefaultProviders(),
    });
  } catch (err) {
    console.error('[Admin] Error updating shared model:', err);
    res.status(500).json({ error: 'Failed to update shared model setting' });
  }
});

/**
 * GET /settings/collab-binding-hardening — the feature-021 binding-patch
 * kill-switch (DR-2). enabled=true is the default (row absent).
 */
router.get('/settings/collab-binding-hardening', async (req, res) => {
  try {
    res.json({ enabled: appSettings.getCollabBindingHardening() });
  } catch (err) {
    console.error('[Admin] Error fetching collab binding hardening setting:', err);
    res.status(500).json({ error: 'Failed to fetch collab binding hardening setting' });
  }
});

/**
 * PUT /settings/collab-binding-hardening — flip the kill-switch.
 * Body: { enabled: boolean }. enabled=true clears the row (default-ON stays
 * literal in the store); enabled=false engages the kill-switch — clients
 * revert to the stock binding on their next config fetch (at most a page
 * refresh; open tabs read the flag live and may pick it up sooner).
 */
router.put('/settings/collab-binding-hardening', async (req, res) => {
  try {
    const { enabled } = req.body;
    if (typeof enabled !== 'boolean') {
      return res.status(400).json({ error: 'enabled must be a boolean' });
    }
    await appSettings.setCollabBindingHardening(enabled);
    res.json({ enabled: appSettings.getCollabBindingHardening() });
  } catch (err) {
    console.error('[Admin] Error updating collab binding hardening setting:', err);
    res.status(500).json({ error: 'Failed to update collab binding hardening setting' });
  }
});

/**
 * GET /users  — list all users with aggregate stats
 */
router.get('/users', async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT
        u.id, u.name, u.email, u.picture, u.is_admin, u.email_enabled,
        u.welcome_email_sent_at,
        u.ai_credit_cents, u.created_at, u.last_login_at,
        -- Feature 034 (FR-011): the abuse-signal capture pair, admin-only.
        -- Passed through verbatim — the admin is the investigator and needs the
        -- exact stored value, so no masking, truncation, or reformatting here.
        u.signup_ip, u.signup_user_agent, u.last_login_ip, u.last_login_user_agent,
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
      emailEnabled: r.email_enabled,
      welcomeEmailSentAt: r.welcome_email_sent_at,
      aiCreditCents: r.ai_credit_cents,
      createdAt: r.created_at,
      lastLoginAt: r.last_login_at,
      // Feature 034 — signup/last-login origin (null for pre-feature accounts).
      signupIp: r.signup_ip,
      signupUserAgent: r.signup_user_agent,
      lastLoginIp: r.last_login_ip,
      lastLoginUserAgent: r.last_login_user_agent,
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
 * PATCH /users/:userId/credit — update a user's monthly AI credit allowance
 * Body: { aiCreditCents: number }
 */
router.patch('/users/:userId/credit', async (req, res) => {
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
 * PATCH /users/:userId/email-enabled — mark a user trusted to send share email
 * Body: { emailEnabled: boolean }
 */
router.patch('/users/:userId/email-enabled', async (req, res) => {
  try {
    const { userId } = req.params;
    const { emailEnabled } = req.body;

    if (typeof emailEnabled !== 'boolean') {
      return res.status(400).json({ error: 'emailEnabled must be a boolean' });
    }

    const result = await pool.query(
      'UPDATE users SET email_enabled = $1 WHERE id = $2 RETURNING email_enabled',
      [emailEnabled, userId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }

    res.json({ emailEnabled: result.rows[0].email_enabled });
  } catch (err) {
    console.error('[Admin] Error updating email_enabled:', err);
    res.status(500).json({ error: 'Failed to update email setting' });
  }
});

/**
 * POST /users/:userId/welcome-email — send the beta welcome email to a user.
 * Manual, admin-triggered (never automatic). BCCs the admin. Records the send
 * time in users.welcome_email_sent_at on success.
 */
router.post('/users/:userId/welcome-email', async (req, res) => {
  try {
    const { userId } = req.params;

    const { rows } = await pool.query('SELECT id, name, email FROM users WHERE id = $1', [userId]);
    if (rows.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }
    const user = rows[0];
    const firstName = (user.name || '').trim().split(/\s+/)[0] || '';

    const result = await sendWelcomeEmail({ to: user.email, firstName });
    if (!result.ok) {
      if (result.skipped) {
        return res.status(503).json({ error: 'Email is not configured (SES_FROM_EMAIL unset)' });
      }
      return res.status(502).json({ error: `Failed to send email: ${result.error}` });
    }

    const upd = await pool.query(
      'UPDATE users SET welcome_email_sent_at = now() WHERE id = $1 RETURNING welcome_email_sent_at',
      [userId]
    );
    res.json({ welcomeEmailSentAt: upd.rows[0].welcome_email_sent_at });
  } catch (err) {
    console.error('[Admin] Error sending welcome email:', err);
    res.status(500).json({ error: 'Failed to send welcome email' });
  }
});

/**
 * GET /users/:userId/sharing — review a user's sharing activity
 * Returns the pending invites they created and the collaborators on docs they own.
 * (document_shares has no "granted_by", so shares are scoped to owned docs — the
 * accurate, attributable view of what this user has shared.)
 */
router.get('/users/:userId/sharing', async (req, res) => {
  try {
    const { userId } = req.params;

    const invitesResult = await pool.query(
      `SELECT i.id, i.email, i.role, i.doc_id, d.title AS doc_title, i.created_at
       FROM document_share_invites i
       JOIN documents d ON d.id = i.doc_id
       WHERE i.invited_by_user_id = $1
       ORDER BY i.created_at DESC`,
      [userId]
    );

    const sharesResult = await pool.query(
      `SELECT d.id AS doc_id, d.title AS doc_title,
              mu.email, mu.name, member_s.role, member_s.created_at
       FROM document_shares owner_s
       JOIN documents d ON d.id = owner_s.doc_id
       JOIN document_shares member_s ON member_s.doc_id = d.id AND member_s.user_id <> $1
       JOIN users mu ON mu.id = member_s.user_id
       WHERE owner_s.user_id = $1 AND owner_s.role = 'owner'
       ORDER BY d.title NULLS LAST, member_s.created_at ASC`,
      [userId]
    );

    const invites = invitesResult.rows.map((r) => ({
      id: r.id,
      email: r.email,
      role: r.role,
      docId: r.doc_id,
      docTitle: r.doc_title,
      createdAt: r.created_at,
    }));

    const shares = sharesResult.rows.map((r) => ({
      docId: r.doc_id,
      docTitle: r.doc_title,
      email: r.email,
      name: r.name,
      role: r.role,
      createdAt: r.created_at,
    }));

    res.json({ invites, shares });
  } catch (err) {
    console.error('[Admin] Error fetching sharing activity:', err);
    res.status(500).json({ error: 'Failed to fetch sharing activity' });
  }
});

/**
 * GET /users/:userId/extra-credits — list all extra credit records for a user
 */
router.get('/users/:userId/extra-credits', async (req, res) => {
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
 * POST /users/extra-credits — grant extra AI credits to a user
 * Body: { userId, amountCents, memo?, expiresAt? }
 */
router.post('/users/extra-credits', async (req, res) => {
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
 * DELETE /users/extra-credits/:creditId — remove an extra credit record
 */
router.delete('/users/extra-credits/:creditId', async (req, res) => {
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
