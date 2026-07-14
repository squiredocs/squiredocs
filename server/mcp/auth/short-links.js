/**
 * Authorize-link shortener.
 *
 * The raw PKCE authorize URL is ~500 characters and wraps across terminal
 * lines, where vanilla terminals (no OSC 8) can neither click nor cleanly
 * select it. Agents shorten it via POST /mcp/auth/shorten and hand the user
 * a short link served by GET /mcp/auth/a/:code.
 *
 * Only this origin's /mcp/auth/authorize URLs can be shortened, and the
 * stored redirect target is rebuilt from our own origin plus the submitted
 * query string — the submitted host is discarded — so the redirect can
 * never leave the origin regardless of input.
 *
 * Codes are reusable until expiry: a single-use link would be burned by
 * browser prefetchers before the user's real click.
 */
const crypto = require('crypto');
const { getRedisClient, isRedisEnabled } = require('../../redis');

const TTL_SECONDS = 600;
const CODE_BYTES = 6; // 8 base64url chars
const MAX_URL_LENGTH = 2048;
const AUTHORIZE_PATH = '/mcp/auth/authorize';
const REDIS_PREFIX = 'mcp:shortlink:';

// Fallback for single-process dev/test runs without Redis.
const memoryStore = new Map();

function pruneMemoryStore() {
  const now = Date.now();
  for (const [code, entry] of memoryStore) {
    if (entry.expiresAt <= now) memoryStore.delete(code);
  }
}

/**
 * Validate a submitted authorize URL and return the same-origin path+query
 * to store, or null if the URL is not shortenable.
 */
function toRelativeAuthorizeUrl(url) {
  if (typeof url !== 'string' || url.length > MAX_URL_LENGTH) return null;
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
  if (parsed.pathname !== AUTHORIZE_PATH) return null;
  return AUTHORIZE_PATH + parsed.search;
}

/**
 * Store a short link for an authorize URL.
 * @returns {{ code: string, expiresAt: Date } | null} null if url is invalid
 */
async function createShortLink(url) {
  const target = toRelativeAuthorizeUrl(url);
  if (!target) return null;

  const code = crypto.randomBytes(CODE_BYTES).toString('base64url');
  const expiresAt = new Date(Date.now() + TTL_SECONDS * 1000);

  if (isRedisEnabled()) {
    await getRedisClient().set(REDIS_PREFIX + code, target, 'EX', TTL_SECONDS);
  } else {
    pruneMemoryStore();
    memoryStore.set(code, { target, expiresAt: expiresAt.getTime() });
  }
  return { code, expiresAt };
}

/**
 * Resolve a short code to its stored same-origin path+query.
 * @returns {string | null} null if unknown or expired
 */
async function resolveShortLink(code) {
  if (typeof code !== 'string' || !/^[A-Za-z0-9_-]{1,32}$/.test(code)) {
    return null;
  }
  if (isRedisEnabled()) {
    return await getRedisClient().get(REDIS_PREFIX + code);
  }
  pruneMemoryStore();
  return memoryStore.get(code)?.target ?? null;
}

module.exports = { createShortLink, resolveShortLink, TTL_SECONDS };
