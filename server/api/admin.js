/**
 * Admin API — user list with stats, credit management
 *
 * Follows the init(pool) + Express router pattern used by ai-usage.js.
 */
const express = require('express');
const aiUsage = require('../ai-usage');
const { sendWelcomeEmail } = require('../email');
const appSettings = require('./app-settings');
const { MODEL_DEFS, getAvailableModels, resolveSharedDefaultKey, resolveUserChatModelKey } = require('./chat-models');
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
        -- Feature 035 — admin-only per-user model pin; NULL = follow the shared default.
        u.chat_model_override,
        COALESCE(d.doc_count, 0)::int AS doc_count,
        COALESCE(a.ai_used_cents, 0)::int AS ai_used_cents,
        COALESCE(ec.ai_extra_credit_cents, 0)::int AS ai_extra_credit_cents,
        -- Last activity = the most recent thing the user actually did, not just
        -- the last full login (refresh tokens keep sessions alive for weeks, so
        -- last_login_at alone goes stale). GREATEST skips NULLs.
        GREATEST(
          u.last_login_at,
          ye.last_edit_at::timestamptz,
          ch.last_chat_at,
          au.last_ai_at,
          ag.last_agent_at
        ) AS last_activity_at
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
      LEFT JOIN (
        SELECT user_id, MAX(created_at) AS last_edit_at
        FROM yjs_updates
        WHERE user_id IS NOT NULL
        GROUP BY user_id
      ) ye ON ye.user_id = u.id
      LEFT JOIN (
        SELECT user_id, MAX(updated_at) AS last_chat_at
        FROM chats
        GROUP BY user_id
      ) ch ON ch.user_id = u.id
      LEFT JOIN (
        SELECT user_id, MAX(created_at) AS last_ai_at
        FROM ai_usage_log
        GROUP BY user_id
      ) au ON au.user_id = u.id
      LEFT JOIN (
        SELECT user_id, MAX(created_at) AS last_agent_at
        FROM agent_activity_log
        GROUP BY user_id
      ) ag ON ag.user_id = u.id
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
      lastActivityAt: r.last_activity_at,
      // Feature 034 — signup/last-login origin (null for pre-feature accounts).
      signupIp: r.signup_ip,
      signupUserAgent: r.signup_user_agent,
      lastLoginIp: r.last_login_ip,
      lastLoginUserAgent: r.last_login_user_agent,
      // Feature 035 — the stored pin only; the client derives the effective label
      // from the shared-model payload it already holds (RBD-12).
      chatModelOverride: r.chat_model_override,
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
 * PATCH /users/:userId/chat-model — pin (or clear) one user's assistant model.
 * Body: { modelKey: string | null }  (null clears the pin → back to the shared default)
 *
 * Feature 035. Admin-only by virtue of the mount (`app.use('/api/admin',
 * requireAdmin, admin.router)`) — no in-handler check, same as its neighbours.
 * Validation mirrors PUT /settings/shared-model: the two 400 branches are
 * isSharedEligible decomposed for message clarity, so the write-time rule and
 * the resolution-time fallback can never disagree (FR-005/FR-007).
 *
 * The stored value is admin-only: it is never echoed to the user it applies to
 * (FR-011), and BYOK state is deliberately not consulted — pinning a BYOK-active
 * user succeeds and simply lies dormant (FR-015/RBD-5).
 */
router.patch('/users/:userId/chat-model', async (req, res) => {
  try {
    const { userId } = req.params;
    const { modelKey } = req.body;

    if (modelKey !== null && typeof modelKey !== 'string') {
      return res.status(400).json({ error: 'modelKey must be a model key string or null' });
    }

    if (modelKey !== null) {
      const def = MODEL_DEFS.find((d) => d.key === modelKey);
      if (!def) {
        return res.status(400).json({ error: `Unknown model: ${modelKey}` });
      }
      if (!hasServerKey(def.provider)) {
        return res.status(400).json({
          error: `Model "${modelKey}" has no shared server key and can't be pinned for a user`,
        });
      }
    }

    const result = await pool.query(
      'UPDATE users SET chat_model_override = $1 WHERE id = $2 RETURNING chat_model_override',
      [modelKey, userId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }

    const stored = result.rows[0].chat_model_override;
    res.json({
      chatModelOverride: stored,
      // What this user's next shared-path turn will actually run on — after a
      // clear that is the CURRENT shared default, not the one in force when the
      // pin was set (SC-003).
      effectiveModelKey: resolveUserChatModelKey(stored, appSettings.getSharedDefaultModel()),
    });
  } catch (err) {
    // A malformed user id reaches pg as an invalid uuid literal (22P02). That is
    // "no such user", not a server fault — the contract promises 404.
    if (err?.code === '22P02') {
      return res.status(404).json({ error: 'User not found' });
    }
    console.error('[Admin] Error updating chat model override:', err);
    res.status(500).json({ error: 'Failed to update chat model override' });
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

// Feature 036 — :userId is shape-checked before it reaches a query, so a
// mistyped id is "no such user" rather than a Postgres invalid-uuid error.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Lifetime state of a credential row: revoked beats expired (a credential
 * revoked before its expiry is revoked, not expired), and everything else is
 * active. Evaluated against `now` at request time, so a row expiring during the
 * request may land on either side — accepted (spec Edge Cases).
 */
function credentialState(revokedAt, expiresAt, now) {
  if (revokedAt) return 'revoked';
  if (expiresAt && new Date(expiresAt) <= now) return 'expired';
  return 'active';
}

/**
 * GET /users/:userId/adoption — one user's agent-access and onboarding detail.
 *
 * Feature 036. Strictly read-only: it reports, it never revokes, mints or
 * edits — revocation stays in the user's own Settings (FR-010). Nothing here
 * writes, and nothing is precomputed: every value is read from the live tables
 * at request time, so there is no counter to drift (FR-011).
 *
 * SECURITY: the three credential tables carry secret material —
 * `agent_delegations.refresh_token_hash`, `mcp_api_tokens.token_hash`,
 * `registered_agents.client_secret_hash`. Every query below uses an EXPLICIT
 * column list and every response field is an explicit literal, so a `SELECT *`
 * can never wash a hash into an admin payload (FR-009). For the same reason
 * this does NOT reuse delegation.listUserDelegations()/apiTokens.listUserTokens()
 * — they are `SELECT *` and they filter revoked rows out, which is the opposite
 * of the lifetime semantics this view needs.
 *
 * `agent_activity_log.metadata` is never read: it records tool arguments
 * verbatim, i.e. user content. The summary is a count and a timestamp.
 */
router.get('/users/:userId/adoption', async (req, res) => {
  try {
    const { userId } = req.params;

    // Shape-checked before any query, so a mistyped id is a 404 rather than a
    // Postgres 22P02 surfacing as a 500 (RBD-11). Still passed as a bound
    // parameter everywhere below — never interpolated.
    if (!UUID_RE.test(userId)) {
      return res.status(404).json({ error: 'User not found' });
    }

    // The onboarding row doubles as the existence check, so an unknown id is a
    // 404 rather than an empty payload that would read as "this account never
    // connected anything". The EXISTS rides along on the same row — one trip.
    //
    // NOT read here: signup_ip / signup_user_agent / last_login_* (034 already
    // carries those on the list row); nothing secret lives on users.
    //
    // authored_non_welcome_doc deliberately diverges from onboarding.js
    // isEngaged(), which additionally requires persisted content (RBD-10): this
    // is the same ownership notion as the Docs column on the same admin row, and
    // the UI labels it "Owns a doc besides the welcome doc" rather than
    // "engaged" so the weaker predicate is not oversold. When welcome_doc_id is
    // NULL (cleared, or never seeded for an agent-OAuth signup) every owned doc
    // counts — the documented imprecision (spec Edge Cases).
    const userResult = await pool.query(
      `SELECT u.created_at, u.signup_source, u.onboarded_at, u.welcome_email_sent_at,
              EXISTS (
                SELECT 1 FROM document_shares ds
                WHERE ds.user_id = u.id AND ds.role = 'owner'
                  AND (u.welcome_doc_id IS NULL OR ds.doc_id <> u.welcome_doc_id)
              ) AS authored_non_welcome_doc
       FROM users u
       WHERE u.id = $1`,
      [userId]
    );
    if (userResult.rows.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }
    const user = userResult.rows[0];

    // Lifetime listing — revoked and expired rows are INCLUDED and labelled.
    // "Did this account ever connect an agent?" is unanswerable if dead
    // credentials are hidden (FR-003). Re-consent reuses the same row, so
    // created_at is the original consent time, which is the honest answer.
    //
    // FORBIDDEN in this SELECT list: agent_delegations.refresh_token_hash,
    // agent_delegations.agent_metadata, registered_agents.client_secret_hash.
    // Explicit columns only — no SELECT *, and no reuse of
    // delegation.listUserDelegations() (it is SELECT *, so it carries the
    // refresh-token hash, and it filters out exactly the rows FR-003 needs).
    const delegationsResult = await pool.query(
      `SELECT d.id, d.agent_name, d.agent_client_id, d.scopes,
              d.created_at, d.last_used_at, d.revoked_at, d.expires_at,
              ra.name AS registered_name
       FROM agent_delegations d
       LEFT JOIN registered_agents ra ON ra.id = d.agent_client_id
       WHERE d.user_id = $1
       ORDER BY d.created_at DESC`,
      [userId]
    );

    // FORBIDDEN in this SELECT list: mcp_api_tokens.token_hash. Explicit
    // columns only — no SELECT *, and no reuse of apiTokens.listUserTokens()
    // (it filters revoked/expired rows out, the opposite of FR-003).
    const tokensResult = await pool.query(
      `SELECT id, name, token_prefix, scopes, created_at, last_used_at,
              revoked_at, expires_at, minted_by_delegation_id, minted_by_api_token_id
       FROM mcp_api_tokens
       WHERE user_id = $1
       ORDER BY created_at DESC`,
      [userId]
    );

    // Index-served by idx_agent_activity_user_time.
    //
    // FORBIDDEN in this SELECT list: agent_activity_log.metadata — it stores
    // raw tool arguments, i.e. user content.
    //
    // This table covers DELEGATION-authenticated MCP calls only: its
    // delegation_id is NOT NULL and the write is gated on it, so sk_sqd_ token
    // calls and REST import/export traffic never appear. The number is
    // therefore not total agent usage, and the UI heading says so (FR-006).
    const activityResult = await pool.query(
      `SELECT COUNT(*)::int AS count, MAX(created_at) AS last_activity_at
       FROM agent_activity_log
       WHERE user_id = $1`,
      [userId]
    );

    const now = new Date();

    const delegations = delegationsResult.rows.map((r) => ({
      id: r.id,
      // The registered catalog's display name wins; a delegation with no
      // catalog link (older, or dynamically registered) falls back to its
      // self-reported name rather than being dropped or blank (FR-004).
      // Both are attacker-controlled strings — the client renders them as
      // text children only, never as markup.
      agentName: r.registered_name || r.agent_name,
      // null = no catalog link, which is what makes a self-reported name
      // visibly unbacked in the UI.
      agentClientId: r.agent_client_id,
      scopes: r.scopes || [],
      createdAt: r.created_at,
      lastUsedAt: r.last_used_at,
      revokedAt: r.revoked_at,
      expiresAt: r.expires_at,
      state: credentialState(r.revoked_at, r.expires_at, now),
    }));

    const tokens = tokensResult.rows.map((r) => ({
      id: r.id,
      name: r.name,
      // The non-secret prefix only — never the hash, never a token value.
      tokenPrefix: r.token_prefix,
      scopes: r.scopes || [],
      createdAt: r.created_at,
      lastUsedAt: r.last_used_at,
      revokedAt: r.revoked_at,
      expiresAt: r.expires_at,
      state: credentialState(r.revoked_at, r.expires_at, now),
      // Minted by a delegation OR by another token — both are the agent path.
      // A token whose mint-parent row was deleted has its reference nulled
      // (ON DELETE SET NULL) and so reads as interactive: accepted imprecision
      // at current scale (spec Edge Cases).
      mintedBy: (r.minted_by_delegation_id || r.minted_by_api_token_id) ? 'agent' : 'interactive',
      // The parent ids ship too, so the admin can correlate a minted token back
      // to the delegation or token that created it without a second request.
      mintedByDelegationId: r.minted_by_delegation_id,
      mintedByApiTokenId: r.minted_by_api_token_id,
    }));

    res.json({
      delegations,
      tokens,
      onboarding: {
        signupSource: user.signup_source,
        createdAt: user.created_at,
        onboardedAt: user.onboarded_at,
        authoredNonWelcomeDoc: user.authored_non_welcome_doc,
        welcomeEmailSentAt: user.welcome_email_sent_at,
      },
      activity: {
        count: activityResult.rows[0].count,
        lastActivityAt: activityResult.rows[0].last_activity_at,
      },
    });
  } catch (err) {
    console.error('[Admin] Error fetching agent adoption detail:', err);
    res.status(500).json({ error: 'Failed to fetch agent adoption detail' });
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
