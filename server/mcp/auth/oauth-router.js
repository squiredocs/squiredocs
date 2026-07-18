/**
 * MCP OAuth Router
 *
 * Mounts all OAuth endpoints for agent authorization.
 */
const express = require('express');
const oauthFlow = require('./oauth-flow');
const registeredAgents = require('./registered-agents');
const apiTokens = require('./api-tokens');
const rateLimit = require('../../rate-limit');
const { requireAuth } = require('../../auth/middleware');
const { optionalAuth } = require('../../auth/middleware');

const router = express.Router();

// Public endpoints (agent-initiated). Rate limits:
//  - POST /token gets the per-IP `token` budget applied to THIS handler only,
//    not the whole /mcp/auth/* mount — /authorize stays unlimited (FR-005, A1).
//  - POST /register is intentionally UNLIMITED: sign-up is never gated (the
//    per-IP + global-daily admission caps were removed 2026-07-18 — a shared
//    global counter let one abuser lock out all sign-ups). Coarse edge-level
//    flood protection remains via the WAF per-IP rate limit (2000/5min).
router.get('/authorize', optionalAuth, oauthFlow.handleAuthorize);
router.post('/token', rateLimit.perIp('token'), oauthFlow.handleToken);
router.post('/revoke', oauthFlow.handleRevoke);
router.post('/register', oauthFlow.handleRegister);

// Protected endpoints (user-initiated, require session auth)
router.post('/approve', requireAuth, oauthFlow.handleApprove);
router.get('/delegations', requireAuth, oauthFlow.handleListDelegations);
router.delete('/delegations/:id', requireAuth, oauthFlow.handleDeleteDelegation);

// API Token management endpoints (user-session-authenticated)
router.post('/api-tokens', requireAuth, async (req, res) => {
  try {
    const { name, scopes } = req.body;
    if (!name || !name.trim()) {
      return res.status(400).json({ error: 'Token name is required' });
    }
    const options = {};
    if (scopes) options.scopes = scopes;
    const { token, record } = await apiTokens.createToken(req.user.userId, name, options);
    res.json({
      token,
      id: record.id,
      name: record.name,
      tokenPrefix: record.token_prefix,
      scopes: record.scopes,
      createdAt: record.created_at,
    });
  } catch (error) {
    if (error.message.includes('Maximum of')) {
      return res.status(400).json({ error: error.message });
    }
    console.error('Error creating API token:', error);
    res.status(500).json({ error: error.message });
  }
});

router.get('/api-tokens', requireAuth, async (req, res) => {
  try {
    const tokens = await apiTokens.listUserTokens(req.user.userId);
    res.json({
      tokens: tokens.map(t => ({
        id: t.id,
        name: t.name,
        tokenPrefix: t.token_prefix,
        scopes: t.scopes,
        createdAt: t.created_at,
        lastUsedAt: t.last_used_at,
        expiresAt: t.expires_at,
      })),
    });
  } catch (error) {
    console.error('Error listing API tokens:', error);
    res.status(500).json({ error: 'Failed to list tokens' });
  }
});

router.delete('/api-tokens/:id', requireAuth, async (req, res) => {
  try {
    const revoked = await apiTokens.revokeToken(req.params.id, req.user.userId);
    if (!revoked) {
      return res.status(404).json({ error: 'Token not found' });
    }
    res.json({ success: true });
  } catch (error) {
    console.error('Error revoking API token:', error);
    res.status(500).json({ error: 'Failed to revoke token' });
  }
});

// Agent info endpoint (public, for displaying on consent screen)
router.get('/agents/:clientId', async (req, res) => {
  try {
    const agent = await registeredAgents.getRegisteredAgent(req.params.clientId);
    if (!agent) {
      return res.status(404).json({ error: 'Agent not found' });
    }
    res.json({
      id: agent.id,
      name: agent.name,
      description: agent.description,
      iconUrl: agent.icon_url,
    });
  } catch (error) {
    console.error('Error fetching agent info:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;
