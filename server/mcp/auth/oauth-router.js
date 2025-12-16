/**
 * MCP OAuth Router
 *
 * Mounts all OAuth endpoints for agent authorization.
 */
const express = require('express');
const oauthFlow = require('./oauth-flow');
const registeredAgents = require('./registered-agents');
const { requireAuth } = require('../../auth/middleware');
const { optionalAuth } = require('../../auth/middleware');

const router = express.Router();

// Public endpoints (agent-initiated)
router.get('/authorize', optionalAuth, oauthFlow.handleAuthorize);
router.post('/token', oauthFlow.handleToken);
router.post('/revoke', oauthFlow.handleRevoke);

// Protected endpoints (user-initiated, require session auth)
router.post('/approve', requireAuth, oauthFlow.handleApprove);
router.get('/delegations', requireAuth, oauthFlow.handleListDelegations);
router.delete('/delegations/:id', requireAuth, oauthFlow.handleDeleteDelegation);

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
