/**
 * buildBaseUrl canonicalizes the CloudFront origin host back to the public
 * origin. Regression guard for the `app.squiredocs.com` leak: the server sits
 * behind CloudFront, which forwards to its origin with `Host: app.squiredocs.com`,
 * and that internal hostname must never appear in the URLs the server emits
 * (MCP tool `url` fields, token-claim URLs, OAuth issuer, share links, the
 * in-app assistant system prompt).
 */
const { buildBaseUrl } = require('../url');

function fakeReq(host, protocol = 'http') {
  return {
    get: (h) => (h.toLowerCase() === 'host' ? host : undefined),
    protocol,
  };
}

describe('buildBaseUrl — canonical public origin', () => {
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
