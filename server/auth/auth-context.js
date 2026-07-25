/**
 * Auth capture context extraction (feature 034 — abuse signals, contract C1).
 *
 * The SINGLE place a request is turned into the `{ ip, userAgent }` pair that
 * gets stored. Nothing else in the codebase may derive a capture pair: one
 * extractor means one truncation rule, one validation rule, and one place to
 * audit when the trust model changes.
 *
 * Two rules are load-bearing:
 *
 *  1. MUST NOT read `X-Forwarded-For` (or any forwarding header) directly.
 *     The address comes from Express's `req.ip`, which is only trustworthy
 *     because `server/index.js` sets `trust proxy` to a fixed NUMERIC hop count
 *     (feature 010 FR-014/RD-5; feature 034 FR-006). Reading the header
 *     ourselves would reintroduce exactly the spoofing hole that setting exists
 *     to close, and would make every captured address attacker-controlled.
 *
 *  2. MUST NOT emit `server/rate-limit.js`'s `clientIp()` `'unknown'` sentinel,
 *     or any other non-address string. That value is fine as a rate-limit bucket
 *     key but is NOT a valid `inet` literal — writing it would raise
 *     "invalid input syntax for type inet" INSIDE the auth statement, which is
 *     precisely what FR-008 forbids. Anything that fails `net.isIP()` becomes
 *     `null` here, before it can ever reach a bind parameter.
 *
 * Pure, synchronous, no I/O, no logging, and never throws — a null or malformed
 * `req` yields `{ ip: null, userAgent: null }`.
 */
const net = require('node:net');

/**
 * FR-007: hard bound on the stored user-agent, applied exactly once, here, so
 * BOTH storage locations (users.*_user_agent and auth_events.user_agent) receive
 * the already-bounded value. Real-world UAs are well under 300 chars; 512 keeps
 * the whole fingerprint with headroom.
 */
const MAX_USER_AGENT_LENGTH = 512;

/**
 * Derive the storable capture pair from a request.
 *
 * @param {import('express').Request} req
 * @returns {{ ip: string|null, userAgent: string|null }}
 */
function authContext(req) {
  return { ip: extractIp(req), userAgent: extractUserAgent(req) };
}

/**
 * The proxy-resolved client address, or null when it is unavailable or is not a
 * literal IP address (missing, '', 'unknown', zone-suffixed like 'fe80::1%eth0').
 * @param {*} req
 * @returns {string|null}
 */
function extractIp(req) {
  const candidate = req?.ip || req?.socket?.remoteAddress || null;
  if (typeof candidate !== 'string') return null;
  // Node's net.isIP ACCEPTS a zone-suffixed link-local address ('fe80::1%eth0'
  // → 6) but Postgres `inet` rejects it ("invalid input syntax for type inet"),
  // so isIP alone is not a sufficient gate for this column. A link-local address
  // is worthless as an abuse signal anyway — drop the whole value rather than
  // strip the zone.
  if (candidate.includes('%')) return null;
  // net.isIP returns 0 for anything that is not a bare IPv4/IPv6 literal.
  return net.isIP(candidate) === 0 ? null : candidate;
}

/**
 * The User-Agent header, trimmed, truncated to MAX_USER_AGENT_LENGTH, or null
 * when the header is absent or empty (never a placeholder string — spec US3
 * acceptance 1 requires absent, not 'unknown').
 * @param {*} req
 * @returns {string|null}
 */
function extractUserAgent(req) {
  const raw = req?.headers?.['user-agent'];
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  return trimmed.length > MAX_USER_AGENT_LENGTH
    ? trimmed.slice(0, MAX_USER_AGENT_LENGTH)
    : trimmed;
}

module.exports = { authContext, MAX_USER_AGENT_LENGTH };
