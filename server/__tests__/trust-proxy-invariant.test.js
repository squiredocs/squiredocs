/**
 * Feature 034 (T018, FR-006) — the invariant that makes every captured address
 * meaningful.
 *
 * `req.ip` is only the true client address because server/index.js sets
 * `trust proxy` to a fixed NUMERIC hop count (feature 010 FR-014/RD-5): Express
 * walks exactly that many entries back from the right of X-Forwarded-For, so a
 * client cannot prepend a forged address and be believed. Switching that to
 * blanket `trust proxy true` would make Express take the LEFTMOST forwarded
 * value — fully attacker-controlled — which would silently turn every value in
 * users.signup_ip / users.last_login_ip and the whole auth_events trail into
 * forgeable text, and the rate limiter's per-IP key with it.
 *
 * This is deliberately a source-level assertion rather than a runtime one:
 * booting index.js pulls in the entire server. The cost of the check is that it
 * must be updated if the setting legitimately moves — which is exactly the
 * conversation it exists to force.
 */
const fs = require('fs');
const path = require('path');

describe('trust proxy invariant (FR-006)', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'index.js'), 'utf8');

  test('trust proxy is set from a numeric TRUST_PROXY_HOPS expression', () => {
    expect(source).toMatch(
      /app\.set\(\s*['"]trust proxy['"]\s*,\s*Number\(\s*process\.env\.TRUST_PROXY_HOPS/
    );
  });

  test('trust proxy is never set to blanket true (or any non-numeric literal)', () => {
    const settings = source.match(/app\.set\(\s*['"]trust proxy['"]\s*,[^)]*\)/g) || [];
    expect(settings).toHaveLength(1);
    for (const setting of settings) {
      expect(setting).not.toMatch(/,\s*true\s*\)/);
      expect(setting).not.toMatch(/,\s*['"]/); // no string preset ('loopback', etc.)
      expect(setting).toMatch(/Number\(/);
    }
  });

  test('the capture extractor never reads a forwarding header itself', () => {
    const extractor = fs.readFileSync(
      path.join(__dirname, '..', 'auth', 'auth-context.js'),
      'utf8'
    );
    // Mentioning it in the explanatory comment is fine; reading it is not.
    const code = extractor.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '');
    expect(code).not.toMatch(/x-forwarded-for/i);
    expect(code).not.toMatch(/forwarded/i);
  });
});
