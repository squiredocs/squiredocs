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
 *  3. MUST NOT store an unroutable address. Discovered in prod 2026-07-26: every
 *     capture was `10.42.0.1`, the k3s pod-network gateway. Traefik replaces
 *     `X-Forwarded-For` with the peer address unless the peer is in its
 *     `forwardedHeaders.trustedIPs`, and behind klipper-lb the peer is always an
 *     in-cluster address — so CloudFront's viewer IP was discarded before Express
 *     ever saw it, and no `trust proxy` hop count could have recovered it. Storing
 *     that value is WORSE than storing nothing: it is identical for every user, so
 *     it would make the whole user base look like one shared-IP cluster and defeat
 *     the exact correlation this capture exists for. Unroutable ⇒ null, plus one
 *     warning per process naming the misconfiguration.
 *
 * Synchronous, never throws, no I/O — a null or malformed `req` yields
 * `{ ip: null, userAgent: null }`. The single warning is the one exception to the
 * no-logging rule, and it is deliberate: a silent null here looks identical to
 * "user has no capture yet", which is how this went unnoticed until the data was
 * inspected by hand.
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
  if (net.isIP(candidate) === 0) return null;
  if (isUnroutable(candidate)) {
    warnUnroutableOnce(candidate, req);
    return null;
  }
  return candidate;
}

/**
 * Whether an address can never belong to an internet client — loopback, private
 * (RFC1918), link-local, carrier-grade NAT, IPv6 unique-local, or unspecified.
 * Reaching one of these means the request's real origin was lost upstream.
 * @param {string} ip A value already known to be a bare IP literal.
 * @returns {boolean}
 */
function isUnroutable(ip) {
  // An IPv4-mapped IPv6 address ('::ffff:10.42.0.1') carries a v4 address and
  // must be judged as one, not by its v6 prefix.
  const lower = ip.toLowerCase();
  const bare = lower.startsWith('::ffff:') ? lower.slice('::ffff:'.length) : lower;

  if (net.isIP(bare) === 4) {
    const [a, b] = bare.split('.').map(Number);
    if (a === 0 || a === 127) return true;              // unspecified, loopback
    if (a === 10) return true;                          // RFC1918
    if (a === 172 && b >= 16 && b <= 31) return true;   // RFC1918
    if (a === 192 && b === 168) return true;            // RFC1918
    if (a === 169 && b === 254) return true;            // link-local
    if (a === 100 && b >= 64 && b <= 127) return true;  // CGNAT (RFC6598)
    return false;
  }

  if (bare === '::' || bare === '::1') return true;     // unspecified, loopback
  if (/^fe[89ab]/.test(bare)) return true;              // fe80::/10 link-local
  if (/^f[cd]/.test(bare)) return true;                 // fc00::/7 unique-local
  return false;
}

/** Once per process — this is a deployment misconfiguration, not a per-request event. */
let warnedUnroutable = false;
function warnUnroutableOnce(candidate, req) {
  if (warnedUnroutable) return;
  warnedUnroutable = true;
  // Deliberately does NOT read the forwarding header to report the chain, even
  // though that would be the handier diagnostic: rule 1 above is enforced by a
  // source-level test (server/__tests__/trust-proxy-invariant.test.js) precisely
  // because "this module never touches forwarding headers" is checkable without
  // judgement. Softening it to "…except for logging" is how the line erodes. The
  // chain is available where it belongs — the ingress logs.
  console.warn(
    `[AuthCapture] Resolved client address "${candidate}" is unroutable, so no sign-in origin is `
    + 'being stored (socket peer: '
    + `${typeof req?.socket?.remoteAddress === 'string' ? req.socket.remoteAddress : 'unknown'}). `
    // NB: this string deliberately avoids the words the invariant test greps for
    // (see the comment above) — it must not read like this module inspects proxy
    // headers, because it does not.
    + 'Expected in local dev (no proxy in front of the app); in a deployment it means the ingress '
    + 'is not preserving the viewer address — check the ingress proxy-header trust list '
    + '(Traefik: trustedIPs on the entrypoint) and that TRUST_PROXY_HOPS matches the chain that '
    + 'survives it.',
  );
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
