/**
 * First-class REST login endpoints (feature 009-rest-login-api).
 *
 *   POST /api/login/start   — begin a device pairing (anonymous)
 *   GET  /api/login/status  — poll the pairing (anonymous, Bearer-handle only)
 *
 * These are THIN wrappers over server/mcp/auth/login-service.js — the exact same
 * state machine the `login` / `login_status` MCP tools drive. There is no second
 * implementation of any flow step: start calls the SAME shared rate-limit helper
 * the tool uses (one `login:ip:<ip>` budget, never doubled — RD-8) and the same
 * createPendingAuthorization; status delegates to the same getStatus. The
 * one-shot approved payload and the credential are therefore delivered jointly
 * across the tool and REST channels (a pairing has exactly one approved delivery
 * and one credential delivery, whichever door observes it first).
 *
 * Neither route is behind requireAuth (the caller has no credential yet). The
 * handle is carried ONLY in Authorization: Bearer (008 log-safety rule); it is
 * never accepted from the query string. Any auth-header defect on status is
 * indistinguishable from an unknown handle (uniform `expired`, RD-6 — no oracle).
 */
const express = require('express');
const loginService = require('./../mcp/auth/login-service');
const { buildBaseUrl } = require('../url');

// Uniform body for every rate-limited outcome on start — byte-identical whether
// the per-IP login budget or a pending cap tripped (no gate oracle), matching
// the `login` tool's rate_limited result.
const RATE_LIMITED_BODY = {
  status: 'rate_limited',
  retryable: true,
  message: 'Too many login attempts. Wait a minute and try again.',
};

/** Extract the handle from Authorization: Bearer — the only accepted carrier. */
function extractHandle(req) {
  const auth = req.headers.authorization;
  if (auth && auth.startsWith('Bearer ')) {
    return auth.slice('Bearer '.length).trim();
  }
  return null;
}

// eslint-disable-next-line no-unused-vars
function createLoginRouter(persistence) {
  const router = express.Router();

  // POST /api/login/start — same gate order as the `login` tool (RD-8):
  //   1. agentName validation (400, no pending created),
  //   2. shared per-IP login rate limit (429 + Retry-After),
  //   3. per-IP + global pending caps inside createPendingAuthorization (429).
  router.post('/api/login/start', express.json(), async (req, res) => {
    const baseUrl = buildBaseUrl(req);

    let agentName;
    try {
      agentName = loginService.validateAgentName((req.body || {}).agentName);
    } catch (err) {
      // Validation failure → 400, actionable message, NO pending authorization.
      return res.status(400).json({ error: 'invalid_agent_name', message: err.message });
    }

    const gate = await loginService.checkLoginRateLimit(req.ip);
    if (!gate.allowed) {
      if (gate.retryAfterSeconds != null) res.set('Retry-After', String(gate.retryAfterSeconds));
      return res.status(429).json(RATE_LIMITED_BODY);
    }

    let result;
    try {
      result = await loginService.createPendingAuthorization({ agentName, ip: req.ip, baseUrl });
    } catch (err) {
      console.error('[login-start] unexpected error creating pending authorization:', err.message);
      return res.status(500).json({ error: 'server_error' });
    }

    // A pending-cap breach surfaces as the uniform rate_limited result (no retry
    // time known → no Retry-After header).
    if (result.status === 'rate_limited') {
      return res.status(429).json(RATE_LIMITED_BODY);
    }

    // Success: the tool's payload superset (RD-1), with instructions rephrased
    // for the REST channel — poll the status URL with the Bearer handle, not the
    // tool.
    return res.status(200).json({
      ...result,
      instructions:
        `Open ${result.verificationUri} and enter ${result.userCode}. Then poll `
        + `GET ${baseUrl}/api/login/status with Authorization: Bearer <handle> every `
        + `${result.pollIntervalSeconds} seconds until approved. `
        + 'Never move the credential through this conversation.',
    });
  });

  // GET /api/login/status — every decision-table outcome is HTTP 200 with the
  // outcome in `status` (RD-2). Handle is Bearer-header-only; missing/malformed/
  // wrong-scheme is routed through the same getStatus path as an unknown handle
  // so the body is byte-identical (uniform expired, RD-6).
  router.get('/api/login/status', async (req, res) => {
    const handle = extractHandle(req);
    const inline = req.query.inline === 'true';
    const baseUrl = buildBaseUrl(req);

    let result;
    try {
      result = await loginService.getStatus(handle, { inline, baseUrl });
    } catch (err) {
      console.error('[login-status] unexpected error resolving status:', err.message);
      return res.status(500).json({ error: 'server_error' });
    }

    // Any credential-bearing (inline) response must not be cached (FR-006).
    if (result && result.credential) res.set('Cache-Control', 'no-store');
    return res.status(200).json(result);
  });

  return router;
}

module.exports = { createLoginRouter };
