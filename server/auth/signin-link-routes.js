/**
 * Feature 059 HTTP surface (contracts/auth-providers.md, contracts/signin-links.md):
 *
 *   GET  /auth/providers         the instance's mode and listed providers
 *   POST /auth/signin-link/peek  read-only inspection of a link (claim page)
 *   POST /auth/signin-link       redeem a link (form post or JSON)
 *
 * Mounted from server/auth/routes.js, so every route sits behind the per-IP
 * `/auth` limiter that server/index.js applies to the whole router (FR-035).
 *
 * Nothing here mints a link (FR-033). No response carries a secret, a token,
 * a token hash, or a user list (FR-047). Refusals never set cookies.
 */
const express = require('express');
const users = require('./users');
const { getPublicProviderInfo } = require('./providers');
const { peekLink, redeemLink, isPlausibleToken, SigninLinkError } = require('./signin-links');
const { establishSession, completePostAuth } = require('./post-auth');
const { authContext } = require('./auth-context');
const onboarding = require('../onboarding');

/**
 * @param {{ getClientUrl: (req: object) => string }} deps - routes.js's client-URL resolver
 */
function createSigninLinkRouter({ getClientUrl }) {
  const router = express.Router();

  router.get('/providers', async (req, res) => {
    const info = await getPublicProviderInfo(users.getPool());
    res.set('Cache-Control', 'public, max-age=60');
    res.json(info);
  });

  router.post('/signin-link/peek', async (req, res) => {
    const token = req.body?.token;
    if (typeof token !== 'string' || token.length < 20 || token.length > 128) {
      return res.status(400).json({ error: 'token_required' });
    }
    try {
      const result = await peekLink(users.getPool(), token);
      return res.json(result);
    } catch (err) {
      console.error('[SigninLink] peek failed:', err?.message || err);
      return res.json({ valid: false });
    }
  });

  router.post('/signin-link', async (req, res) => {
    const wantsJson = req.accepts(['html', 'json']) === 'json';
    const clientUrl = getClientUrl(req);
    const { token, name, email } = req.body || {};
    const ctx = authContext(req);

    const refuse = (code, field) => {
      if (wantsJson) {
        const status = code === 'instance_claimed' ? 409 : 400;
        const body = { ok: false, error: code };
        if (code === 'claim_invalid' && field) body.field = field;
        return res.status(status).json(body);
      }
      if (code === 'claim_invalid') return res.redirect(303, `${clientUrl}/claim?error=claim_invalid`);
      return res.redirect(302, `${clientUrl}/login?error=${code}`);
    };

    if (!isPlausibleToken(token)) return refuse('link_invalid');

    let user;
    try {
      ({ user } = await redeemLink(users.getPool(), token, { name, email, ctx }));
    } catch (err) {
      if (err instanceof SigninLinkError) return refuse(err.code, err.field);
      console.error('[SigninLink] redeem failed:', err?.message || err);
      return refuse('link_invalid');
    }

    const signupSource = 'signin_link';
    if (!wantsJson) {
      // A sign-in link never carries a return path: rawReturnTo is null, so the
      // feature 031 auto-issue cannot fire here (FR-011, D2), whatever
      // oauth_return_to cookie the browser happens to hold.
      return completePostAuth(res, { user, signupSource, clientUrl, rawReturnTo: null, ctx });
    }

    await establishSession(res, user, { signupSource, ctx, notify: true });
    let welcomeDocId = null;
    let onboarded = true;
    try {
      ({ welcomeDocId, onboarded } = await onboarding.resolveOnboarding(user, { seed: true }));
    } catch (e) {
      console.error('Onboarding resolve failed (signin-link):', e);
    }
    return res.json({
      ok: true,
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        isAdmin: !!user.is_admin,
        welcomeDocId,
        onboarded,
      },
    });
  });

  return router;
}

module.exports = { createSigninLinkRouter };
