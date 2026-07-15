/**
 * Unit tests for login-service primitives (feature 008).
 *
 * These cover the pure generation / hashing / validation helpers — no DB. The
 * DB-backed flow (create/getStatus/approve/claim) is exercised end-to-end in
 * login-flow.test.js and the store in pending-authorizations.test.js.
 */
const crypto = require('crypto');
const loginService = require('../../auth/login-service');
const {
  USER_CODE_ALPHABET,
  USER_CODE_LENGTH,
  HANDLE_PREFIX,
  AGENT_NAME_MAX_LENGTH,
} = require('../../auth/login-constants');

describe('login-service primitives', () => {
  describe('generateHandle / hashHandle', () => {
    test('handle carries the sqlh_ prefix and ≥128 bits of entropy', () => {
      const handle = loginService.generateHandle();
      expect(handle.startsWith(HANDLE_PREFIX)).toBe(true);
      const body = handle.slice(HANDLE_PREFIX.length);
      // 32 random bytes → 43 base64url chars.
      expect(body.length).toBe(43);
      expect(body).toMatch(/^[A-Za-z0-9_-]+$/);
    });

    test('handles are unique across many draws', () => {
      const seen = new Set();
      for (let i = 0; i < 1000; i += 1) seen.add(loginService.generateHandle());
      expect(seen.size).toBe(1000);
    });

    test('hashHandle is SHA-256 hex and matches a reference digest', () => {
      const handle = 'sqlh_example';
      const expected = crypto.createHash('sha256').update(handle).digest('hex');
      expect(loginService.hashHandle(handle)).toBe(expected);
      expect(loginService.hashHandle(handle)).toMatch(/^[0-9a-f]{64}$/);
    });
  });

  describe('generateUserCode', () => {
    test('code is 8 chars from the consonant alphabet, grouped XXXX-XXXX', () => {
      for (let i = 0; i < 500; i += 1) {
        const { code, display } = loginService.generateUserCode();
        expect(code.length).toBe(USER_CODE_LENGTH);
        for (const ch of code) {
          expect(USER_CODE_ALPHABET.includes(ch)).toBe(true);
        }
        expect(display).toMatch(/^[BCDFGHJKLMNPQRSTVWXZ]{4}-[BCDFGHJKLMNPQRSTVWXZ]{4}$/);
        expect(display.replace('-', '')).toBe(code);
      }
    });

    test('rejection sampling only ever emits alphabet characters (no bias leak)', () => {
      const counts = {};
      for (let i = 0; i < 2000; i += 1) {
        for (const ch of loginService.generateUserCode().code) {
          counts[ch] = (counts[ch] || 0) + 1;
        }
      }
      // Every observed character must be in the alphabet, and every alphabet
      // character should appear at least once across 16k draws.
      expect(Object.keys(counts).every((ch) => USER_CODE_ALPHABET.includes(ch))).toBe(true);
      for (const ch of USER_CODE_ALPHABET) {
        expect(counts[ch]).toBeGreaterThan(0);
      }
    });
  });

  describe('normalizeCode / hashCode', () => {
    test('normalization is case-insensitive and strips hyphens/whitespace', () => {
      expect(loginService.normalizeCode('wdjb-mjht')).toBe('WDJBMJHT');
      expect(loginService.normalizeCode('WDJB MJHT')).toBe('WDJBMJHT');
      expect(loginService.normalizeCode(' wdjbmjht ')).toBe('WDJBMJHT');
      expect(loginService.normalizeCode('w-d j b-m j h t')).toBe('WDJBMJHT');
    });

    test('hashCode agrees across equivalent inputs and is SHA-256 hex', () => {
      const a = loginService.hashCode(loginService.normalizeCode('wdjb-mjht'));
      const b = loginService.hashCode(loginService.normalizeCode('WDJB-MJHT'));
      const c = loginService.hashCode(loginService.normalizeCode('WDJBMJHT'));
      expect(a).toBe(b);
      expect(a).toBe(c);
      expect(a).toMatch(/^[0-9a-f]{64}$/);
    });
  });

  describe('validateAgentName', () => {
    test('accepts a normal name and trims it', () => {
      expect(loginService.validateAgentName('  Claude Code  ')).toBe('Claude Code');
    });

    test('accepts a full-length 100-char name', () => {
      const name = 'a'.repeat(AGENT_NAME_MAX_LENGTH);
      expect(loginService.validateAgentName(name)).toBe(name);
    });

    test('accepts a hostile-but-legal name verbatim (rendered inert downstream)', () => {
      const hostile = '<img src=x onerror=alert(1)>';
      expect(loginService.validateAgentName(hostile)).toBe(hostile);
    });

    test('rejects empty / whitespace-only', () => {
      expect(() => loginService.validateAgentName('')).toThrow(/Invalid parameters for tool 'login'/);
      expect(() => loginService.validateAgentName('   ')).toThrow(/must not be empty/);
    });

    test('rejects names longer than 100 chars', () => {
      expect(() => loginService.validateAgentName('a'.repeat(101))).toThrow(/100 characters or fewer/);
    });

    test('rejects control characters', () => {
      expect(() => loginService.validateAgentName('bad\x00name')).toThrow(/control characters/);
      expect(() => loginService.validateAgentName('line\nbreak')).toThrow(/control characters/);
      expect(() => loginService.validateAgentName('tab\ttab')).toThrow(/control characters/);
    });

    test('rejects non-string input', () => {
      expect(() => loginService.validateAgentName(42)).toThrow(/must be a string/);
      expect(() => loginService.validateAgentName(null)).toThrow(/must be a string/);
    });
  });

  describe('timingSafeEqualHex', () => {
    test('true for identical digests', () => {
      const d = crypto.createHash('sha256').update('x').digest('hex');
      expect(loginService.timingSafeEqualHex(d, d)).toBe(true);
    });

    test('false for different digests of equal length', () => {
      const a = crypto.createHash('sha256').update('a').digest('hex');
      const b = crypto.createHash('sha256').update('b').digest('hex');
      expect(loginService.timingSafeEqualHex(a, b)).toBe(false);
    });

    test('false for mismatched lengths and non-strings', () => {
      expect(loginService.timingSafeEqualHex('abcd', 'ab')).toBe(false);
      expect(loginService.timingSafeEqualHex('', '')).toBe(false);
      expect(loginService.timingSafeEqualHex(null, 'ab')).toBe(false);
    });
  });
});
