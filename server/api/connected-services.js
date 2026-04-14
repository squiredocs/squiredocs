/**
 * Connected Services REST API
 *
 * Manages external service connections (Google Drive, future: Gmail, etc.).
 * Provides endpoints for listing and disconnecting services.
 * Never exposes tokens in responses.
 */
const express = require('express');
const { requireAuth } = require('../auth/middleware');
const { revokeTokens: revokeDriveTokens, SERVICE_NAME: DRIVE_SERVICE } = require('../google-docs/google-auth');

const router = express.Router();

let pool = null;

function init(dbPool) {
  pool = dbPool;
}

/**
 * Service-specific revocation handlers.
 * Each service may have its own API to call when revoking tokens.
 */
const REVOKE_HANDLERS = {
  [DRIVE_SERVICE]: revokeDriveTokens,
};

/**
 * GET /api/settings/connected-services
 * List all connected services for the authenticated user.
 * Never returns tokens.
 */
router.get('/', requireAuth, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT id, service, service_email, token_status, error_message,
              expires_at, connected_at, last_used_at
       FROM connected_services
       WHERE user_id = $1 AND revoked_at IS NULL
       ORDER BY connected_at DESC`,
      [req.user.userId]
    );

    res.json({ services: rows });
  } catch (error) {
    console.error('[connected-services] List error:', error);
    res.status(500).json({ error: 'Failed to list connected services' });
  }
});

/**
 * DELETE /api/settings/connected-services/:service
 * Disconnect a service: revoke at provider, then clear locally.
 */
router.delete('/:service', requireAuth, async (req, res) => {
  const { service } = req.params;

  try {
    // Use service-specific handler if available
    const revokeHandler = REVOKE_HANDLERS[service];
    if (revokeHandler) {
      await revokeHandler(pool, req.user.userId);
    } else {
      // Generic fallback: just mark as revoked locally
      await pool.query(
        `UPDATE connected_services SET revoked_at = now(), refresh_token = 'revoked'
         WHERE user_id = $1 AND service = $2 AND revoked_at IS NULL`,
        [req.user.userId, service]
      );
    }

    res.json({ success: true, message: `${service} disconnected` });
  } catch (error) {
    console.error(`[connected-services] Disconnect ${service} error:`, error);
    res.status(500).json({ error: `Failed to disconnect ${service}` });
  }
});

module.exports = { router, init };
