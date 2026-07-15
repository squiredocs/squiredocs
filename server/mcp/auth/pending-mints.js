/**
 * Pending token mints for create_access_token's claim delivery.
 *
 * The tool stores the mint parameters here under the SHA-256 of a one-shot
 * claim secret and returns only the claim recipe; GET /api/tokens/claim
 * (server/api/token-claim.js) redeems it and mints the token at claim time.
 * An unclaimed entry expires in Redis without ever creating a token, and no
 * plaintext secret or token is ever at rest.
 */
const crypto = require('crypto');
const { getRedisClient } = require('../../redis');

const CLAIM_TTL_SECONDS = 300;
const KEY_PREFIX = 'mint-claim:';

function hashSecret(secret) {
  return crypto.createHash('sha256').update(secret).digest('hex');
}

/**
 * Store mint parameters and return the one-shot claim secret (the only copy —
 * only its hash is kept). The `sqc_` prefix distinguishes a claim secret from
 * a real `sk_sqd_` token in transcripts and logs.
 * @param {object} params - { userId, name, scopes, ttlSeconds,
 *   mintedByDelegationId, mintedByApiTokenId }
 * @returns {Promise<string>} claim secret
 */
async function createPendingMint(params) {
  const secret = `sqc_${crypto.randomBytes(32).toString('base64url')}`;
  const key = KEY_PREFIX + hashSecret(secret);
  await getRedisClient().set(key, JSON.stringify(params), 'EX', CLAIM_TTL_SECONDS, 'NX');
  return secret;
}

// Atomic GET+DEL so two concurrent claims can never both redeem. GETDEL
// requires Redis >= 6.2; this Lua form works everywhere ioredis does.
const REDEEM_LUA =
  "local v = redis.call('GET', KEYS[1]) " +
  "if v then redis.call('DEL', KEYS[1]) end " +
  'return v';

/**
 * One-shot redemption: returns the stored mint parameters and destroys the
 * entry, or null for an unknown, expired, or already-claimed secret.
 * @param {string} secret - Claim secret from the Authorization header
 * @returns {Promise<object|null>}
 */
async function redeemPendingMint(secret) {
  if (typeof secret !== 'string' || secret.length < 20 || secret.length > 128) {
    return null;
  }
  const key = KEY_PREFIX + hashSecret(secret);
  const value = await getRedisClient().eval(REDEEM_LUA, 1, key);
  return value ? JSON.parse(value) : null;
}

module.exports = {
  CLAIM_TTL_SECONDS,
  createPendingMint,
  redeemPendingMint,
};
