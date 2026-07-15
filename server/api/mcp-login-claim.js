/**
 * One-shot credential claim endpoint (feature 008-mcp-login-bootstrap).
 *
 *   GET /api/mcp/login/claim
 *
 * Authenticated solely by the login handle (Bearer, or ?handle= fallback) — the
 * caller has no user credential yet; the handle IS the credential (FR-020). NOT
 * behind requireAuth. The claim atomically flips the approved authorization to
 * claimed and mints the sk_sqd_ token in the same transaction (loginService),
 * streaming the token bytes to the response so it writes straight to disk.
 *
 * Every failure except the per-IP rate limit and the FR-022 token-cap carve-out
 * collapses to a byte-identical 404 { "error": "invalid_or_expired" } — no
 * account/handle-existence oracle (D5). Mounted in server/index.js beside the
 * export/import routers.
 */
const express = require('express');
const loginService = require('../mcp/auth/login-service');
const rateLimit = require('../mcp/auth/rate-limit');
const { CLAIM_ATTEMPTS_PER_MINUTE_PER_IP } = require('../mcp/auth/login-constants');

/** Extract the handle from the Authorization: Bearer header, or the ?handle= query. */
function extractHandle(req) {
  const auth = req.headers.authorization;
  if (auth && auth.startsWith('Bearer ')) {
    return auth.slice('Bearer '.length).trim();
  }
  if (req.query && typeof req.query.handle === 'string') {
    return req.query.handle.trim();
  }
  return null;
}

// eslint-disable-next-line no-unused-vars
function createLoginClaimRouter(persistence) {
  const router = express.Router();

  router.get('/api/mcp/login/claim', async (req, res) => {
    // Rate limit is keyed on the IP and checked BEFORE any handle inspection, so
    // it leaks nothing per-handle (and can't be used to probe handles).
    const gate = await rateLimit.consume(`claim:ip:${req.ip}`, CLAIM_ATTEMPTS_PER_MINUTE_PER_IP, 60);
    if (!gate.allowed) {
      res.set('Retry-After', String(gate.retryAfterSeconds));
      return res.status(429).json({ error: 'rate_limited', retryAfterSeconds: gate.retryAfterSeconds });
    }

    const handle = extractHandle(req);
    if (!handle) {
      // Malformed/missing handle is indistinguishable from an unknown one.
      return res.status(404).json({ error: 'invalid_or_expired' });
    }

    let result;
    try {
      result = await loginService.claimCredential(handle, 'rest');
    } catch (err) {
      console.error('[login-claim] unexpected error during claim:', err.message);
      return res.status(500).json({ error: 'server_error' });
    }

    if (result.ok) {
      res.set('Cache-Control', 'no-store');
      res.set('Content-Type', 'text/plain; charset=utf-8');
      // Trailing newline so `curl -o file` writes a clean, shell-friendly line.
      return res.status(200).send(`${result.token}\n`);
    }

    if (result.error === 'token_limit') {
      return res.status(409).json({
        error: 'token_limit',
        message:
          'This account has reached its API-token limit. Revoke a token in '
          + 'Settings → API Tokens, then run the claim again — the approval stays '
          + 'valid until its window expires.',
      });
    }

    if (result.error === 'mint_failed') {
      return res.status(500).json({ error: 'server_error' });
    }

    return res.status(404).json({ error: 'invalid_or_expired' });
  });

  return router;
}

module.exports = { createLoginClaimRouter };
