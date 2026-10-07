/**
 * buildBaseUrl canonicalizes the CloudFront origin host back to the public
 * origin. Regression guard for the `app.squiredocs.com` leak: the server sits
 * behind CloudFront, which forwards to its origin with `Host: app.squiredocs.com`,
 * and that internal hostname must never appear in the URLs the server emits
 * (MCP tool `url` fields, token-claim URLs, OAuth issuer, share links, the
 * in-app assistant system prompt).
 */
const { buildBaseUrl } = require('../url');
const { _resetInstanceConfigForTests } = require('../instance-config');

// The hosted deploy sets APP_URL=https://squiredocs.com (feature 058, FR-036),
// and PUBLIC_ORIGIN defaults to it. Each block sets its own origin config.
function withEnv(vars) {
  const saved = {};
  beforeEach(() => {
    for (const [k, v] of Object.entries(vars)) {
      saved[k] = process.env[k];
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    _resetInstanceConfigForTests();
  });
  afterEach(() => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    _resetInstanceConfigForTests();
  });
}

function fakeReq(host, protocol = 'http') {
  return {
    get: (h) => (h.toLowerCase() === 'host' ? host : undefined),
    protocol,
  };
}

describe('buildBaseUrl — canonical public origin', () => {
  withEnv({ APP_URL: 'https://squiredocs.com', PUBLIC_ORIGIN: undefined });

  it('rewrites the CloudFront origin host to the public origin', () => {
    expect(buildBaseUrl(fakeReq('app.squiredocs.com'))).toBe('https://squiredocs.com');
  });

  it('matches the origin host case-insensitively and ignores a :port suffix', () => {
    expect(buildBaseUrl(fakeReq('App.SquireDocs.com:443'))).toBe('https://squiredocs.com');
  });

  it('leaves the public apex host as https', () => {
    expect(buildBaseUrl(fakeReq('squiredocs.com'))).toBe('https://squiredocs.com');
  });

  it('does not rewrite unrelated subdomains that merely contain the origin label', () => {
    // Only the exact origin alias is canonicalized; a real other subdomain
    // keeps its own host (and https, since it is a squiredocs.com host).
    expect(buildBaseUrl(fakeReq('staging.squiredocs.com'))).toBe('https://staging.squiredocs.com');
  });

  it('leaves local/dev hosts untouched (protocol from req.protocol)', () => {
    expect(buildBaseUrl(fakeReq('localhost:3001'))).toBe('http://localhost:3001');
  });
});

describe('buildBaseUrl — PUBLIC_ORIGIN defaults to APP_URL (feature 058, FR-013)', () => {
  describe('PUBLIC_ORIGIN unset', () => {
    withEnv({ APP_URL: 'http://localhost:3910', PUBLIC_ORIGIN: undefined });

    it('maps an alias host to APP_URL', () => {
      expect(buildBaseUrl(fakeReq('app.squiredocs.com'))).toBe('http://localhost:3910');
    });

    it('leaves non-alias hosts unchanged', () => {
      expect(buildBaseUrl(fakeReq('docs.example.com', 'https'))).toBe('https://docs.example.com');
      expect(buildBaseUrl(fakeReq('localhost:3910'))).toBe('http://localhost:3910');
    });
  });

  describe('PUBLIC_ORIGIN set', () => {
    withEnv({ APP_URL: 'http://localhost:3910', PUBLIC_ORIGIN: 'https://public.example.com' });

    it('the explicit value wins for alias hosts', () => {
      expect(buildBaseUrl(fakeReq('app.squiredocs.com'))).toBe('https://public.example.com');
    });

    it('non-alias hosts are still unchanged', () => {
      expect(buildBaseUrl(fakeReq('localhost:3910'))).toBe('http://localhost:3910');
    });
  });
});
