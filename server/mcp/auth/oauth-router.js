/**
 * MCP OAuth Router
 *
 * Mounts all OAuth endpoints for agent authorization.
 */
const express = require('express');
const oauthFlow = require('./oauth-flow');
const registeredAgents = require('./registered-agents');
const apiTokens = require('./api-tokens');
const shortLinks = require('./short-links');
const { requireAuth } = require('../../auth/middleware');
const { optionalAuth } = require('../../auth/middleware');
const { buildBaseUrl } = require('../../url');

const router = express.Router();

// Public endpoints (agent-initiated)
router.get('/authorize', optionalAuth, oauthFlow.handleAuthorize);
router.post('/token', oauthFlow.handleToken);
router.post('/revoke', oauthFlow.handleRevoke);
router.post('/register', oauthFlow.handleRegister);

// Authorize-link shortener (public: agents call this before they have any
// credential — that's the point of the authorize URL). Only same-path
// /mcp/auth/authorize URLs are accepted, and the redirect target is rebuilt
// on this origin, so this cannot be used as an open redirector.
router.post('/shorten', async (req, res) => {
  try {
    const result = await shortLinks.createShortLink(req.body?.url);
    if (!result) {
      return res.status(400).json({
        error: 'invalid_url',
        message: 'Only this origin\'s /mcp/auth/authorize URLs can be shortened. Pass the full authorization URL as JSON: { "url": "..." }.',
      });
    }
    res.json({
      shortUrl: `${buildBaseUrl(req)}/mcp/auth/a/${result.code}`,
      expiresAt: result.expiresAt.toISOString(),
      expiresInSeconds: shortLinks.TTL_SECONDS,
    });
  } catch (error) {
    console.error('Error creating short link:', error);
    res.status(500).json({ error: 'Failed to create short link' });
  }
});

router.get('/a/:code', async (req, res) => {
  try {
    const target = await shortLinks.resolveShortLink(req.params.code);
    if (!target) {
      return res
        .status(404)
        .send('This authorization link has expired or does not exist. Ask your agent for a fresh one.');
    }
    res.redirect(302, target);
  } catch (error) {
    console.error('Error resolving short link:', error);
    res.status(500).send('Failed to resolve authorization link');
  }
});

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
