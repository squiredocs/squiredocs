/**
 * Google Drive OAuth token management
 *
 * Handles incremental OAuth authorization for Google Drive scope,
 * separate from the login-only OAuth flow. Tokens are encrypted
 * via server/crypto.js and stored in the connected_services table.
 */
const { OAuth2Client } = require('google-auth-library');
const { encrypt, decrypt } = require('../crypto');

const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;
const GOOGLE_DRIVE_REDIRECT_URI =
  process.env.GOOGLE_DRIVE_REDIRECT_URI || 'http://localhost:3001/auth/google/drive-callback';

const DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive';
const SERVICE_NAME = 'google_drive';
const CONNECTION_DURATION_DAYS = 30;

let driveOAuth2Client = null;

/**
 * Get or create the OAuth2 client for Drive operations.
 * Uses a dedicated redirect URI separate from the login flow.
 */
function getDriveOAuth2Client() {
  if (!driveOAuth2Client) {
    if (!GOOGLE_CLIENT_ID || !GOOGLE_CLIENT_SECRET) {
      throw new Error(
        'Google OAuth credentials not configured. Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET.'
      );
    }
    driveOAuth2Client = new OAuth2Client(
      GOOGLE_CLIENT_ID,
      GOOGLE_CLIENT_SECRET,
      GOOGLE_DRIVE_REDIRECT_URI
    );
  }
  return driveOAuth2Client;
}

/**
 * Generate the Google consent URL for Drive scope authorization.
 * @param {string} state - CSRF state parameter
 * @param {string} userEmail - Pre-select the user's Google account
 * @returns {string} Authorization URL
 */
function generateDriveAuthUrl(state, userEmail) {
  const client = getDriveOAuth2Client();

  const opts = {
    access_type: 'offline',
    scope: [
      'openid',
      'https://www.googleapis.com/auth/userinfo.email',
      DRIVE_SCOPE,
    ],
    prompt: 'consent',
    include_granted_scopes: true,
  };

  if (state) opts.state = state;
  if (userEmail) opts.login_hint = userEmail;

  return client.generateAuthUrl(opts);
}

/**
 * Exchange an authorization code for tokens using the Drive OAuth client.
 * @param {string} code - Authorization code from Google callback
 * @returns {Promise<object>} Tokens from Google
 */
async function exchangeDriveCode(code) {
  const client = getDriveOAuth2Client();
  const { tokens } = await client.getToken(code);
  return tokens;
}

/**
 * Verify the ID token from the Drive OAuth flow and extract the Google subject.
 * @param {string} idToken - ID token from the token exchange
 * @returns {Promise<{sub: string, email: string}>}
 */
async function verifyDriveIdToken(idToken) {
  const client = getDriveOAuth2Client();
  const ticket = await client.verifyIdToken({
    idToken,
    audience: GOOGLE_CLIENT_ID,
  });
  const payload = ticket.getPayload();
  return { sub: payload.sub, email: payload.email };
}

/**
 * Store encrypted tokens in the connected_services table.
 * @param {import('pg').Pool} pool
 * @param {string} userId
 * @param {string} refreshToken - Plaintext refresh token (will be encrypted)
 * @param {string} email - Google account email
 */
async function storeTokens(pool, userId, refreshToken, email) {
  const encrypted = encrypt(refreshToken);
  const expiresAt = new Date(Date.now() + CONNECTION_DURATION_DAYS * 24 * 60 * 60 * 1000);

  await pool.query(
    `INSERT INTO connected_services (user_id, service, service_email, refresh_token, token_status, expires_at)
     VALUES ($1, $2, $3, $4, 'active', $5)
     ON CONFLICT (user_id, service) DO UPDATE SET
       service_email = EXCLUDED.service_email,
       refresh_token = EXCLUDED.refresh_token,
       token_status = 'active',
       error_message = NULL,
       expires_at = EXCLUDED.expires_at,
       connected_at = now(),
       revoked_at = NULL`,
    [userId, SERVICE_NAME, email, encrypted, expiresAt]
  );
}

/**
 * Get a valid access token for the user's Google Drive connection.
 * Decrypts the stored refresh token, obtains a fresh access token,
 * and updates last_used_at.
 *
 * @param {import('pg').Pool} pool
 * @param {string} userId
 * @returns {Promise<string>} A valid access token
 * @throws {Error} If not connected, expired, or token is in error state
 */
async function getValidToken(pool, userId) {
  const { rows } = await pool.query(
    `SELECT id, refresh_token, token_status, expires_at, error_message
     FROM connected_services
     WHERE user_id = $1 AND service = $2 AND revoked_at IS NULL`,
    [userId, SERVICE_NAME]
  );

  if (rows.length === 0) {
    const err = new Error('Google Drive is not connected. Connect in Settings.');
    err.code = 'NOT_CONNECTED';
    throw err;
  }

  const row = rows[0];

  if (row.token_status === 'error') {
    const err = new Error(
      row.error_message || 'Google Drive connection needs re-authorization. Reconnect in Settings.'
    );
    err.code = 'TOKEN_ERROR';
    throw err;
  }

  if (row.expires_at && new Date(row.expires_at) < new Date()) {
    const err = new Error('Google Drive connection has expired. Reconnect in Settings.');
    err.code = 'EXPIRED';
    throw err;
  }

  let refreshToken;
  try {
    refreshToken = decrypt(row.refresh_token);
  } catch (e) {
    await pool.query(
      `UPDATE connected_services SET token_status = 'error', error_message = 'Decryption failed'
       WHERE id = $1`,
      [row.id]
    );
    const err = new Error('Google Drive connection error. Please reconnect in Settings.');
    err.code = 'TOKEN_ERROR';
    throw err;
  }

  const client = getDriveOAuth2Client();
  client.setCredentials({ refresh_token: refreshToken });

  let accessToken;
  try {
    const { token } = await client.getAccessToken();
    accessToken = token;
  } catch (e) {
    // invalid_grant means user revoked access or token is no longer valid
    if (e.message && e.message.includes('invalid_grant')) {
      await pool.query(
        `UPDATE connected_services
         SET token_status = 'error', error_message = 'Access revoked. Please reconnect.'
         WHERE id = $1`,
        [row.id]
      );
      const err = new Error('Google Drive access has been revoked. Reconnect in Settings.');
      err.code = 'TOKEN_ERROR';
      throw err;
    }
    throw e;
  }

  // Update last_used_at (fire and forget)
  pool
    .query(`UPDATE connected_services SET last_used_at = now() WHERE id = $1`, [row.id])
    .catch(() => {});

  return accessToken;
}

/**
 * Check if a user has an active Google Drive connection.
 * @param {import('pg').Pool} pool
 * @param {string} userId
 * @returns {Promise<boolean>}
 */
async function hasGoogleDriveAuth(pool, userId) {
  const { rows } = await pool.query(
    `SELECT 1 FROM connected_services
     WHERE user_id = $1 AND service = $2 AND revoked_at IS NULL
       AND token_status = 'active'
       AND (expires_at IS NULL OR expires_at > now())
     LIMIT 1`,
    [userId, SERVICE_NAME]
  );
  return rows.length > 0;
}

/**
 * Revoke Google Drive connection for a user.
 * Calls Google's revocation endpoint, then clears the local record.
 * @param {import('pg').Pool} pool
 * @param {string} userId
 */
async function revokeTokens(pool, userId) {
  const { rows } = await pool.query(
    `SELECT id, refresh_token FROM connected_services
     WHERE user_id = $1 AND service = $2 AND revoked_at IS NULL`,
    [userId, SERVICE_NAME]
  );

  if (rows.length === 0) return;

  const row = rows[0];

  // Attempt to revoke at Google
  try {
    const refreshToken = decrypt(row.refresh_token);
    const client = getDriveOAuth2Client();
    await client.revokeToken(refreshToken);
  } catch (e) {
    // Log but continue — still clear locally even if Google revocation fails
    console.warn('[google-auth] Google token revocation failed:', e.message);
  }

  await pool.query(
    `UPDATE connected_services SET revoked_at = now(), refresh_token = 'revoked' WHERE id = $1`,
    [row.id]
  );
}

module.exports = {
  getDriveOAuth2Client,
  generateDriveAuthUrl,
  exchangeDriveCode,
  verifyDriveIdToken,
  storeTokens,
  getValidToken,
  hasGoogleDriveAuth,
  revokeTokens,
  SERVICE_NAME,
};
