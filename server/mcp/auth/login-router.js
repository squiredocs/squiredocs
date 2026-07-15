/**
 * Login consent routes (feature 008-mcp-login-bootstrap).
 *
 * The two session-authenticated endpoints the /activate browser page calls:
 *   POST /mcp/login/code     — consume a user code, return the consent details
 *   POST /mcp/login/decision — approve or deny
 *
 * Mounted at /mcp/login (a sibling of oauth-router at /mcp/auth), BEFORE the
 * /mcp router, so Express matches /mcp/login/* here rather than falling through
 * to the JSON-RPC endpoint. These carry NO OAuth semantics — the transport OAuth
 * surface is untouched.
 */
const express = require('express');
const { requireAuth } = require('../../auth/middleware');
const loginService = require('./login-service');
const rateLimit = require('./rate-limit');
const {
  CODE_ATTEMPTS_PER_MINUTE_PER_USER,
  CODE_ATTEMPTS_PER_HOUR_PER_IP,
} = require('./login-constants');

const router = express.Router();

const INVALID_CODE = {
  error: 'invalid_or_expired',
  message: 'That code is invalid or has expired. Ask your agent to run login again.',
};

// POST /mcp/login/code — consume a code, bind this user, return consent details.
router.post('/code', requireAuth, async (req, res) => {
  const userId = req.user.userId;
  const ip = req.ip;

  // Rate limits (D10): 5/min/user and 20/hour/IP. Both counters advance; a
  // uniform 429 either way (no per-cause distinction).
  const perUser = await rateLimit.consume(`code:user:${userId}`, CODE_ATTEMPTS_PER_MINUTE_PER_USER, 60);
  const perIp = await rateLimit.consume(`code:ip:${ip}`, CODE_ATTEMPTS_PER_HOUR_PER_IP, 3600);
  if (!perUser.allowed || !perIp.allowed) {
    const retryAfter = Math.max(
      perUser.allowed ? 0 : perUser.retryAfterSeconds,
      perIp.allowed ? 0 : perIp.retryAfterSeconds
    );
    res.set('Retry-After', String(retryAfter));
    return res.status(429).json({ error: 'rate_limited' });
  }

  const { code } = req.body || {};
  const result = await loginService.enterCode(code, userId);
  if (!result.ok) {
    return res.status(400).json(INVALID_CODE);
  }
  return res.json({
    authorizationId: result.authorizationId,
    agentName: result.agentName,
    scopes: result.scopes,
    expiresAt: result.expiresAt,
  });
});

// POST /mcp/login/decision — approve or deny (ownership: the code-enterer decides).
router.post('/decision', requireAuth, async (req, res) => {
  const userId = req.user.userId;
  const { authorizationId, approved } = req.body || {};

  if (!authorizationId || typeof approved !== 'boolean') {
    return res.status(400).json({
      error: 'invalid_or_expired',
      message: 'That request is invalid or has expired. Ask your agent to run login again.',
    });
  }

  if (approved) {
    const result = await loginService.approveAuthorization(authorizationId, userId);
    switch (result.status) {
      case 'approved':
        return res.json({
          status: 'approved',
          message:
            'Access granted — the agent can now connect. Manage or revoke this access '
            + 'anytime in Settings → AI Agent Access.',
        });
      case 'token_limit':
        return res.status(409).json({
          error: 'token_limit',
          message:
            "You've reached your API-token limit. Revoke a token in Settings → API Tokens, "
            + 'then approve again.',
        });
      case 'expired':
        return res.status(410).json({
          error: 'expired',
          message: 'This request expired — ask your agent to run login again.',
        });
      default:
        return res.status(400).json({
          error: 'invalid_or_expired',
          message: 'That request is invalid or has expired. Ask your agent to run login again.',
        });
    }
  }

  const result = await loginService.denyAuthorization(authorizationId, userId);
  if (result.status === 'denied') {
    return res.json({ status: 'denied', message: 'Nothing was granted.' });
  }
  return res.status(400).json({
    error: 'invalid_or_expired',
    message: 'That request is invalid or has expired. Ask your agent to run login again.',
  });
});

module.exports = router;
