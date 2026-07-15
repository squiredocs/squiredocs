/**
 * MCP API Tokens
 *
 * Personal access tokens for MCP API access.
 * Tokens are opaque strings prefixed with `sk_sqd_` (the sk_ marker makes
 * them recognizable to secret scanners), stored as SHA-256 hashes. Tokens
 * issued before the prefix change carry the legacy `sqd_` prefix and remain
 * valid — verification is by hash, so only the prefix guard needs to accept
 * both.
 */
const crypto = require('crypto');

let pool = null;

const TOKEN_PREFIX = 'sk_sqd_';
const LEGACY_TOKEN_PREFIXES = ['sqd_'];
const TOKEN_RANDOM_BYTES = 30;
const MAX_TOKENS_PER_USER = 25;
const DEFAULT_SCOPES = ['documents:read', 'documents:write'];

// Temporary tokens minted by the create_access_token MCP tool.
const MINTED_TOKEN_DEFAULT_TTL_SECONDS = 3600;
const MINTED_TOKEN_MIN_TTL_SECONDS = 60;
const MINTED_TOKEN_MAX_TTL_SECONDS = 86400;
const MAX_MINTED_PER_MINTER = 5;

/**
 * Whether a string looks like an API token (current or legacy prefix).
 * Shared by every auth chain that gates on the prefix before hitting the DB.
 */
function isApiToken(token) {
  return (
    typeof token === 'string' &&
    (token.startsWith(TOKEN_PREFIX) ||
      LEGACY_TOKEN_PREFIXES.some((p) => token.startsWith(p)))
  );
}

/**
 * Initialize with database pool
 */
function init(dbPool) {
  pool = dbPool;
}

/**
 * Generate a new API token string
 * Format: sk_sqd_ + 40 chars of base64url-encoded random bytes
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
 * @param {Date|string} options.expiresAt - Expiry (must be in the future); omit for a non-expiring token
 * @param {string} options.mintedByDelegationId - Delegation that minted this token (create_access_token)
 * @param {string} options.mintedByApiTokenId - Parent API token that minted this token (create_access_token)
 * @param {object} options.client - Optional pg client to run on (for a caller-managed
 *   transaction — e.g. the MCP login claim, which mints the credential and marks the
 *   authorization claimed atomically, rolling back the claim if the mint hits the cap).
 *   Defaults to the module pool.
 * @returns {{ token: string, record: object }} Plaintext token (returned only once) and DB record
 */
async function createToken(
  userId,
  name,
  { scopes, expiresAt, mintedByDelegationId, mintedByApiTokenId, client } = {}
) {
  if (!name || !name.trim()) {
    throw new Error('Token name is required');
  }
  if (name.length > 255) {
    throw new Error('Token name must be 255 characters or less');
  }
  let expiry = null;
  if (expiresAt !== undefined && expiresAt !== null) {
    expiry = expiresAt instanceof Date ? expiresAt : new Date(expiresAt);
    if (Number.isNaN(expiry.getTime()) || expiry.getTime() <= Date.now()) {
      throw new Error('expiresAt must be a valid timestamp in the future');
    }
  }

  const executor = client || pool;

  // Enforce max tokens per user
  const countResult = await executor.query(
    'SELECT COUNT(*)::int AS count FROM mcp_api_tokens WHERE user_id = $1 AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > NOW())',
    [userId]
  );
  if (countResult.rows[0].count >= MAX_TOKENS_PER_USER) {
    throw new Error(`Maximum of ${MAX_TOKENS_PER_USER} active tokens per user`);
  }

  const token = generateTokenString();
  const tokenHash = hashToken(token);
  const tokenPrefix = token.substring(0, TOKEN_PREFIX.length + 4); // sk_sqd_ + first 4 random chars
  const tokenScopes = scopes || DEFAULT_SCOPES;

  const result = await executor.query(
    `INSERT INTO mcp_api_tokens
       (user_id, name, token_prefix, token_hash, scopes, expires_at,
        minted_by_delegation_id, minted_by_api_token_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     RETURNING id, user_id, name, token_prefix, scopes, created_at, last_used_at, expires_at,
               minted_by_delegation_id, minted_by_api_token_id`,
    [
      userId,
      name.trim(),
      tokenPrefix,
      tokenHash,
      tokenScopes,
      expiry,
      mintedByDelegationId || null,
      mintedByApiTokenId || null,
    ]
  );

  return { token, record: result.rows[0] };
}

/**
 * Verify a plaintext API token
 * @param {string} plaintextToken - The full token string
 * @returns {object|null} Token record or null if invalid
 */
async function verifyToken(plaintextToken) {
  if (!isApiToken(plaintextToken)) {
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
 * Count a user's active (unrevoked, unexpired) tokens. Mirrors the cap query in
 * createToken. Used by the MCP login approval to pre-check the per-user token
 * cap at the consent page (D7) so approval fails there with an actionable
 * message instead of only failing later at mint time.
 * @param {string} userId - User UUID
 * @returns {Promise<number>}
 */
async function countActiveTokens(userId) {
  const result = await pool.query(
    'SELECT COUNT(*)::int AS count FROM mcp_api_tokens WHERE user_id = $1 AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > NOW())',
    [userId]
  );
  return result.rows[0].count;
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
 * Get a token record by id (no hash). Used by create_access_token for the
 * no-chaining check on PAT principals.
 * @param {string} tokenId - Token UUID
 * @returns {object|null}
 */
async function getTokenById(tokenId) {
  const result = await pool.query(
    `SELECT id, user_id, name, token_prefix, scopes, created_at, revoked_at, expires_at,
            minted_by_delegation_id, minted_by_api_token_id
     FROM mcp_api_tokens
     WHERE id = $1`,
    [tokenId]
  );
  return result.rows[0] || null;
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
  if (result.rows.length === 0) {
    return false;
  }
  // Cascade to tokens this one minted via create_access_token. One level is
  // complete: minted tokens cannot mint, so no chains exist.
  const cascaded = await revokeMintedTokens({ apiTokenId: tokenId });
  if (cascaded > 0) {
    console.log(`[api-tokens] revoked ${cascaded} minted token(s) of parent ${tokenId}`);
  }
  return true;
}

/**
 * Revoke all active tokens minted by the given minter (delegation or parent
 * token). Called from the delegation-revocation paths and revokeToken.
 * @param {object} minter
 * @param {string} [minter.delegationId]
 * @param {string} [minter.apiTokenId]
 * @returns {number} Count of tokens revoked
 */
async function revokeMintedTokens({ delegationId, apiTokenId } = {}) {
  if (!delegationId && !apiTokenId) {
    return 0;
  }
  const result = await pool.query(
    `UPDATE mcp_api_tokens
     SET revoked_at = NOW()
     WHERE revoked_at IS NULL
       AND (($1::uuid IS NOT NULL AND minted_by_delegation_id = $1)
         OR ($2::uuid IS NOT NULL AND minted_by_api_token_id = $2))
     RETURNING id`,
    [delegationId || null, apiTokenId || null]
  );
  return result.rows.length;
}

/**
 * Keep a minter's active minted tokens under the cap by revoking the oldest
 * beyond max - 1, so the mint about to happen lands at <= max. Bounds the
 * footprint of agents minting in a loop without introducing a new error mode.
 * @param {object} minter - { delegationId } or { apiTokenId }
 * @param {number} max - Maximum active minted tokens per minter
 * @returns {number} Count of tokens revoked to make room
 */
async function enforceMinterCap({ delegationId, apiTokenId } = {}, max = MAX_MINTED_PER_MINTER) {
  if (!delegationId && !apiTokenId) {
    return 0;
  }
  const result = await pool.query(
    `UPDATE mcp_api_tokens
     SET revoked_at = NOW()
     WHERE id IN (
       SELECT id FROM mcp_api_tokens
       WHERE revoked_at IS NULL
         AND (expires_at IS NULL OR expires_at > NOW())
         AND (($1::uuid IS NOT NULL AND minted_by_delegation_id = $1)
           OR ($2::uuid IS NOT NULL AND minted_by_api_token_id = $2))
       ORDER BY created_at DESC
       OFFSET $3
     )
     RETURNING id`,
    [delegationId || null, apiTokenId || null, Math.max(0, max - 1)]
  );
  return result.rows.length;
}

module.exports = {
  init,
  isApiToken,
  createToken,
  verifyToken,
  countActiveTokens,
  listUserTokens,
  getTokenById,
  revokeToken,
  revokeMintedTokens,
  enforceMinterCap,
  TOKEN_PREFIX,
  LEGACY_TOKEN_PREFIXES,
  MAX_TOKENS_PER_USER,
  MINTED_TOKEN_DEFAULT_TTL_SECONDS,
  MINTED_TOKEN_MIN_TTL_SECONDS,
  MINTED_TOKEN_MAX_TTL_SECONDS,
  MAX_MINTED_PER_MINTER,
};
