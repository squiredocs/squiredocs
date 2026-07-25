/**
 * Feature 034 (T004) — authContext unit tests. Pure: NO database, no pool, no
 * express. A plain object literal stands in for the request, which is the point
 * of keeping the extractor pure and synchronous (contract C1).
 */
const { authContext, MAX_USER_AGENT_LENGTH } = require('../auth-context');

const reqWith = (overrides = {}) => ({ headers: {}, ...overrides });

describe('authContext', () => {
  describe('ip extraction', () => {
    test('passes an IPv4 address through verbatim', () => {
      expect(authContext(reqWith({ ip: '203.0.113.7' })).ip).toBe('203.0.113.7');
    });

    test('passes an IPv6 address through verbatim', () => {
      expect(authContext(reqWith({ ip: '2001:db8::1' })).ip).toBe('2001:db8::1');
    });

    test('accepts the ::ffff: dual-stack form Express produces', () => {
      expect(authContext(reqWith({ ip: '::ffff:127.0.0.1' })).ip).toBe('::ffff:127.0.0.1');
    });

    test('falls back to req.socket.remoteAddress when req.ip is absent', () => {
      const req = reqWith({ socket: { remoteAddress: '198.51.100.9' } });
      expect(authContext(req).ip).toBe('198.51.100.9');
    });

    test('prefers req.ip over the socket address (proxy-resolved wins)', () => {
      const req = reqWith({ ip: '203.0.113.7', socket: { remoteAddress: '10.0.0.1' } });
      expect(authContext(req).ip).toBe('203.0.113.7');
    });

    test.each([
      ['undefined', undefined],
      ['empty string', ''],
      ["rate-limit.js's 'unknown' sentinel", 'unknown'],
      // net.isIP() ACCEPTS this one (returns 6) but Postgres `inet` rejects it,
      // so the extractor needs its own zone-ID guard — regression coverage for
      // exactly the "throws inside the auth statement" hazard FR-008 forbids.
      ['zone-suffixed IPv6', 'fe80::1%eth0'],
      ['hostname', 'collab-postgres'],
      ['non-string', 12345],
    ])('yields null for %s', (_label, value) => {
      expect(authContext(reqWith({ ip: value })).ip).toBeNull();
    });

    test('never returns the string "unknown" even when the socket supplies it', () => {
      const req = reqWith({ socket: { remoteAddress: 'unknown' } });
      expect(authContext(req).ip).toBeNull();
    });

    test('ignores X-Forwarded-For entirely (FR-006 — req.ip is the only source)', () => {
      const req = reqWith({ headers: { 'x-forwarded-for': '9.9.9.9' } });
      expect(authContext(req).ip).toBeNull();
    });
  });

  describe('user-agent extraction', () => {
    test('trims the header value', () => {
      const req = reqWith({ headers: { 'user-agent': '  Mozilla/5.0 (X11)  ' } });
      expect(authContext(req).userAgent).toBe('Mozilla/5.0 (X11)');
    });

    test('yields null when the header is absent', () => {
      expect(authContext(reqWith()).userAgent).toBeNull();
    });

    test('yields null (not a placeholder) for a whitespace-only header', () => {
      const req = reqWith({ headers: { 'user-agent': '   ' } });
      expect(authContext(req).userAgent).toBeNull();
    });

    test('truncates a 600-char user-agent to exactly 512 chars (FR-007)', () => {
      const long = 'A'.repeat(600);
      const { userAgent } = authContext(reqWith({ headers: { 'user-agent': long } }));
      expect(userAgent).toHaveLength(MAX_USER_AGENT_LENGTH);
      expect(userAgent).toBe('A'.repeat(512));
    });

    test('leaves a 512-char user-agent untouched (boundary)', () => {
      const exact = 'B'.repeat(512);
      expect(authContext(reqWith({ headers: { 'user-agent': exact } })).userAgent).toBe(exact);
    });

    test('MAX_USER_AGENT_LENGTH is 512', () => {
      expect(MAX_USER_AGENT_LENGTH).toBe(512);
    });
  });

  describe('robustness (FR-008 — never throws)', () => {
    test('authContext(null) yields an all-null pair', () => {
      expect(authContext(null)).toEqual({ ip: null, userAgent: null });
    });

    test('authContext(undefined) yields an all-null pair', () => {
      expect(authContext(undefined)).toEqual({ ip: null, userAgent: null });
    });

    test('authContext({}) yields an all-null pair', () => {
      expect(authContext({})).toEqual({ ip: null, userAgent: null });
    });

    test('a malformed req (headers not an object) does not throw', () => {
      expect(() => authContext({ headers: 'nope', ip: null })).not.toThrow();
      expect(authContext({ headers: 'nope' })).toEqual({ ip: null, userAgent: null });
    });
  });

  test('a fully populated request yields both values', () => {
    const req = reqWith({ ip: '203.0.113.7', headers: { 'user-agent': 'Squire/1.0' } });
    expect(authContext(req)).toEqual({ ip: '203.0.113.7', userAgent: 'Squire/1.0' });
  });
});
