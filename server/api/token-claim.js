/**
 * GET /api/tokens/claim — one-shot redemption of a pending create_access_token
 * mint (server/mcp/auth/pending-mints.js).
 *
 * Authenticated by the claim secret in the Authorization header — never a
 * query param, so it can't land in proxy access logs. Responds with the raw
 * token bytes (text/plain) so `curl -o <file>` writes the credential straight
 * to disk without it transiting model context or the conversation transcript.
 *
 * Failure modes are deliberately shaped: unknown/expired/already-claimed are
 * indistinguishable (401, no oracle); refusals after redemption (revoked
 * minter, token caps) are reasoned 409s — the caller proved possession of the
 * one-shot secret, which is spent either way. No per-IP rate limiting: the
 * secret is 256-bit, one-shot, and dies within minutes.
 */
const express = require('express');
const apiTokens = require('../mcp/auth/api-tokens');
const delegation = require('../mcp/auth/delegation');
const pendingMints = require('../mcp/auth/pending-mints');

function createTokenClaimRouter() {
  const router = express.Router();

  router.get('/api/tokens/claim', async (req, res) => {
    res.set('Cache-Control', 'no-store');
    try {
      const match = (req.headers.authorization || '').match(/^Bearer\s+(.+)$/i);
      const pending = match ? await pendingMints.redeemPendingMint(match[1].trim()) : null;
      if (!pending) {
        return res.status(401).json({ error: 'Invalid or expired claim' });
      }

      // The one-shot is spent; re-check what may have changed since the mint
      // was requested (the delegation could have been revoked, caps filled).
      if (pending.mintedByDelegationId) {
        const check = await delegation.checkDelegation(pending.mintedByDelegationId, null);
        if (!check.isValid) {
          return res.status(409).json({ error: `Cannot mint token: ${check.reason}` });
        }
      }
      await apiTokens.enforceMinterCap({
        delegationId: pending.mintedByDelegationId || null,
        apiTokenId: pending.mintedByApiTokenId || null,
      });
      const { token } = await apiTokens.createToken(pending.userId, pending.name, {
        scopes: pending.scopes,
        expiresAt: new Date(Date.now() + pending.ttlSeconds * 1000),
        mintedByDelegationId: pending.mintedByDelegationId || null,
        mintedByApiTokenId: pending.mintedByApiTokenId || null,
      });
      res.type('text/plain').send(token);
    } catch (err) {
      if (/Maximum of \d+ active tokens/.test(err.message || '')) {
        return res.status(409).json({ error: err.message });
      }
      console.error('Token claim error:', err.message);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  return router;
}

module.exports = { createTokenClaimRouter };
