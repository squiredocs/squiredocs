/**
 * MCP API Tokens
 *
 * Personal access tokens for MCP API access.
 * Tokens are opaque strings prefixed with `sqd_`, stored as SHA-256 hashes.
 */
const crypto = require('crypto');

let pool = null;

const TOKEN_PREFIX = 'sqd_';
const TOKEN_RANDOM_BYTES = 30;
const MAX_TOKENS_PER_USER = 25;
const DEFAULT_SCOPES = ['documents:read', 'documents:write'];

/**
 * Initialize with database pool
 */
function init(dbPool) {
  pool = dbPool;
}

/**
 * Generate a new API token string
 * Format: sqd_ + 40 chars of base64url-encoded random bytes
 */
function generateTokenString() {
  const randomBytes = crypto.randomBytes(TOKEN_RANDOM_BYTES);
  return TOKEN_PREFIX + randomBytes.toString('base64url');
}

/**
 * Hash a token for storage/lookup
 */
function hashToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

/**
 * Create a new API token for a user
 * @param {string} userId - User UUID
 * @param {string} name - Human-readable token name
 * @param {object} options
 * @param {string[]} options.scopes - Token scopes
 * @returns {{ token: string, record: object }} Plaintext token (returned only once) and DB record
 */
async function createToken(userId, name, { scopes } = {}) {
  if (!name || !name.trim()) {
    throw new Error('Token name is required');
  }
  if (name.length > 255) {
    throw new Error('Token name must be 255 characters or less');
  }

  // Enforce max tokens per user
  const countResult = await pool.query(
    'SELECT COUNT(*)::int AS count FROM mcp_api_tokens WHERE user_id = $1 AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > NOW())',
    [userId]
  );
  if (countResult.rows[0].count >= MAX_TOKENS_PER_USER) {
    throw new Error(`Maximum of ${MAX_TOKENS_PER_USER} active tokens per user`);
  }

  const token = generateTokenString();
  const tokenHash = hashToken(token);
  const tokenPrefix = token.substring(0, 8); // sqd_ + first 4 random chars
  const tokenScopes = scopes || DEFAULT_SCOPES;

  const result = await pool.query(
    `INSERT INTO mcp_api_tokens (user_id, name, token_prefix, token_hash, scopes)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING id, user_id, name, token_prefix, scopes, created_at, last_used_at, expires_at`,
    [userId, name.trim(), tokenPrefix, tokenHash, tokenScopes]
  );

  return { token, record: result.rows[0] };
}

/**
 * Verify a plaintext API token
 * @param {string} plaintextToken - The full token string
 * @returns {object|null} Token record or null if invalid
 */
async function verifyToken(plaintextToken) {
  if (!plaintextToken || !plaintextToken.startsWith(TOKEN_PREFIX)) {
    return null;
  }

  const tokenHash = hashToken(plaintextToken);

  const result = await pool.query(
    `SELECT id, user_id, name, token_prefix, scopes, created_at, last_used_at, expires_at
     FROM mcp_api_tokens
     WHERE token_hash = $1
       AND revoked_at IS NULL
       AND (expires_at IS NULL OR expires_at > NOW())`,
    [tokenHash]
  );

  if (result.rows.length === 0) {
    return null;
  }

  const record = result.rows[0];

  // Update last_used_at (fire-and-forget)
  pool.query(
    'UPDATE mcp_api_tokens SET last_used_at = NOW() WHERE id = $1',
    [record.id]
  ).catch(err => console.error('Failed to update last_used_at:', err));

  return record;
}

/**
 * List active tokens for a user (never returns hash)
 * @param {string} userId - User UUID
 * @returns {object[]} Token records
 */
async function listUserTokens(userId) {
  const result = await pool.query(
    `SELECT id, name, token_prefix, scopes, created_at, last_used_at, expires_at
     FROM mcp_api_tokens
     WHERE user_id = $1
       AND revoked_at IS NULL
       AND (expires_at IS NULL OR expires_at > NOW())
     ORDER BY created_at DESC`,
    [userId]
  );
  return result.rows;
}

/**
 * Revoke a token
 * @param {string} tokenId - Token UUID
 * @param {string} userId - User UUID (ownership check)
 * @returns {boolean} Whether the token was found and revoked
 */
async function revokeToken(tokenId, userId) {
  const result = await pool.query(
    `UPDATE mcp_api_tokens
     SET revoked_at = NOW()
     WHERE id = $1 AND user_id = $2 AND revoked_at IS NULL
     RETURNING id`,
    [tokenId, userId]
  );
  return result.rows.length > 0;
}

module.exports = {
  init,
  createToken,
  verifyToken,
  listUserTokens,
  revokeToken,
  TOKEN_PREFIX,
  MAX_TOKENS_PER_USER,
};
