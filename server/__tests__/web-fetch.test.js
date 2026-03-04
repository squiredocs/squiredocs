/**
 * web-fetch.js unit tests
 * Tests URL validation, private IP detection, content extraction,
 * and SSRF protection (including DNS-rebinding resistance via dispatcher).
 */
const { isPrivateIp, validateUrl, webFetch } = require('../api/web-fetch');

// ---------------------------------------------------------------------------
// validateUrl
// ---------------------------------------------------------------------------

describe('validateUrl', () => {
  it('accepts http URLs', () => {
    const parsed = validateUrl('http://example.com');
    expect(parsed.hostname).toBe('example.com');
  });

  it('accepts https URLs', () => {
    const parsed = validateUrl('https://example.com/path?q=1');
    expect(parsed.hostname).toBe('example.com');
  });

  it('rejects non-http protocols', () => {
    expect(() => validateUrl('ftp://example.com')).toThrow('Only http and https');
    expect(() => validateUrl('file:///etc/passwd')).toThrow('Only http and https');
    expect(() => validateUrl('javascript:alert(1)')).toThrow('Only http and https');
  });

  it('rejects URLs with userinfo credentials', () => {
    expect(() => validateUrl('http://user:pass@example.com')).toThrow('credentials');
    expect(() => validateUrl('http://user@example.com')).toThrow('credentials');
  });

  it('rejects invalid URLs', () => {
    expect(() => validateUrl('not a url')).toThrow('Invalid URL');
    expect(() => validateUrl('')).toThrow('Invalid URL');
  });
});

// ---------------------------------------------------------------------------
// isPrivateIp — IPv4
// ---------------------------------------------------------------------------

describe('isPrivateIp — IPv4', () => {
  it('blocks loopback (127.0.0.0/8)', () => {
    expect(isPrivateIp('127.0.0.1')).toBe(true);
    expect(isPrivateIp('127.255.255.255')).toBe(true);
  });

  it('blocks 10.0.0.0/8', () => {
    expect(isPrivateIp('10.0.0.1')).toBe(true);
    expect(isPrivateIp('10.255.255.255')).toBe(true);
  });

  it('blocks 172.16.0.0/12', () => {
    expect(isPrivateIp('172.16.0.1')).toBe(true);
    expect(isPrivateIp('172.31.255.255')).toBe(true);
    expect(isPrivateIp('172.15.255.255')).toBe(false);
    expect(isPrivateIp('172.32.0.0')).toBe(false);
  });

  it('blocks 192.168.0.0/16', () => {
    expect(isPrivateIp('192.168.0.1')).toBe(true);
    expect(isPrivateIp('192.168.255.255')).toBe(true);
  });

  it('blocks link-local / cloud metadata (169.254.0.0/16)', () => {
    expect(isPrivateIp('169.254.169.254')).toBe(true);
    expect(isPrivateIp('169.254.0.1')).toBe(true);
  });

  it('blocks CGNAT (100.64.0.0/10)', () => {
    expect(isPrivateIp('100.64.0.1')).toBe(true);
    expect(isPrivateIp('100.127.255.255')).toBe(true);
    expect(isPrivateIp('100.63.255.255')).toBe(false);
    expect(isPrivateIp('100.128.0.0')).toBe(false);
  });

  it('blocks 0.0.0.0/8', () => {
    expect(isPrivateIp('0.0.0.0')).toBe(true);
    expect(isPrivateIp('0.255.255.255')).toBe(true);
  });

  it('allows public IPs', () => {
    expect(isPrivateIp('8.8.8.8')).toBe(false);
    expect(isPrivateIp('1.1.1.1')).toBe(false);
    expect(isPrivateIp('93.184.216.34')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// isPrivateIp — IPv6
// ---------------------------------------------------------------------------

describe('isPrivateIp — IPv6', () => {
  it('blocks loopback ::1', () => {
    expect(isPrivateIp('::1')).toBe(true);
  });

  it('blocks ULA (fc00::/7)', () => {
    expect(isPrivateIp('fc00::1')).toBe(true);
    expect(isPrivateIp('fd12:3456::1')).toBe(true);
  });

  it('blocks link-local (fe80::/10)', () => {
    expect(isPrivateIp('fe80::1')).toBe(true);
  });

  it('blocks unspecified address (::)', () => {
    expect(isPrivateIp('::')).toBe(true);
  });

  it('allows public IPv6', () => {
    expect(isPrivateIp('2607:f8b0:4004:800::200e')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// isPrivateIp — IPv4-mapped IPv6
// ---------------------------------------------------------------------------

describe('isPrivateIp — IPv4-mapped IPv6', () => {
  it('blocks dotted-decimal form (::ffff:127.0.0.1)', () => {
    expect(isPrivateIp('::ffff:127.0.0.1')).toBe(true);
    expect(isPrivateIp('::ffff:10.0.0.1')).toBe(true);
    expect(isPrivateIp('::ffff:169.254.169.254')).toBe(true);
    expect(isPrivateIp('::ffff:192.168.1.1')).toBe(true);
  });

  it('blocks hex form (::ffff:7f00:1) — Node.js normalized format', () => {
    expect(isPrivateIp('::ffff:7f00:1')).toBe(true);     // 127.0.0.1
    expect(isPrivateIp('::ffff:a9fe:a9fe')).toBe(true);   // 169.254.169.254
    expect(isPrivateIp('::ffff:c0a8:1')).toBe(true);      // 192.168.0.1
    expect(isPrivateIp('::ffff:a00:1')).toBe(true);        // 10.0.0.1
    expect(isPrivateIp('::ffff:ac10:1')).toBe(true);       // 172.16.0.1
    expect(isPrivateIp('::ffff:6440:1')).toBe(true);       // 100.64.0.1
  });

  it('allows public IPs in hex form', () => {
    expect(isPrivateIp('::ffff:808:808')).toBe(false);     // 8.8.8.8
  });
});

// ---------------------------------------------------------------------------
// isPrivateIp — square brackets (URL.hostname format)
// ---------------------------------------------------------------------------

describe('isPrivateIp — square brackets from URL.hostname', () => {
  it('strips brackets and correctly blocks private IPv6', () => {
    expect(isPrivateIp('[::1]')).toBe(true);
    expect(isPrivateIp('[fc00::1]')).toBe(true);
    expect(isPrivateIp('[fe80::1]')).toBe(true);
  });

  it('strips brackets and correctly blocks IPv4-mapped hex form', () => {
    expect(isPrivateIp('[::ffff:7f00:1]')).toBe(true);
    expect(isPrivateIp('[::ffff:a9fe:a9fe]')).toBe(true);
    expect(isPrivateIp('[::ffff:c0a8:1]')).toBe(true);
  });

  it('strips brackets and allows public IPv6', () => {
    expect(isPrivateIp('[2607:f8b0:4004:800::200e]')).toBe(false);
  });

  it('matches URL.hostname output for all private IPv6 forms', () => {
    // These are the exact strings Node.js URL.hostname produces
    const privateUrls = [
      'http://[::1]/',
      'http://[::ffff:7f00:1]/',       // 127.0.0.1
      'http://[::ffff:a9fe:a9fe]/',     // 169.254.169.254
      'http://[fc00::1]/',
      'http://[fe80::1]/',
    ];
    for (const urlStr of privateUrls) {
      const hostname = new URL(urlStr).hostname;
      expect(isPrivateIp(hostname)).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// webFetch — SSRF protection integration tests
// ---------------------------------------------------------------------------

describe('webFetch — SSRF protection', () => {
  it('rejects URLs with non-http schemes', async () => {
    await expect(webFetch('ftp://example.com')).rejects.toThrow('Only http and https');
  });

  it('rejects URLs with credentials', async () => {
    await expect(webFetch('http://user:pass@example.com')).rejects.toThrow('credentials');
  });

  it('blocks IPv4 loopback literals', async () => {
    await expect(webFetch('http://127.0.0.1/')).rejects.toThrow('blocked address');
  });

  it('blocks IPv4 private literals', async () => {
    await expect(webFetch('http://10.0.0.1/')).rejects.toThrow('blocked address');
    await expect(webFetch('http://192.168.1.1/')).rejects.toThrow('blocked address');
    await expect(webFetch('http://172.16.0.1/')).rejects.toThrow('blocked address');
  });

  it('blocks cloud metadata IP literal', async () => {
    await expect(webFetch('http://169.254.169.254/')).rejects.toThrow('blocked address');
  });

  it('blocks IPv6 loopback literal', async () => {
    await expect(webFetch('http://[::1]/')).rejects.toThrow('blocked address');
  });

  it('blocks IPv6 private literals', async () => {
    await expect(webFetch('http://[fc00::1]/')).rejects.toThrow('blocked address');
    await expect(webFetch('http://[fe80::1]/')).rejects.toThrow('blocked address');
  });

  it('blocks IPv4-mapped IPv6 private literals (hex form)', async () => {
    await expect(webFetch('http://[::ffff:7f00:1]/')).rejects.toThrow('blocked address');
    await expect(webFetch('http://[::ffff:a9fe:a9fe]/')).rejects.toThrow('blocked address');
  });

  it('blocks hostnames that resolve to private IPs via dispatcher', async () => {
    // 'localhost' resolves to 127.0.0.1 — the dispatcher's lookup should block it
    await expect(webFetch('http://localhost/')).rejects.toThrow();
  });
});

// ---------------------------------------------------------------------------
// webFetch — successful fetch
// ---------------------------------------------------------------------------

describe('webFetch — content extraction', () => {
  it('fetches and extracts text from a public URL', async () => {
    const result = await webFetch('https://example.com');
    expect(result.content).toContain('Example Domain');
    expect(result.contentType).toBe('text/html');
    expect(result.url).toMatch(/example\.com/);
    expect(result.truncated).toBe(false);
  }, 15_000);
});
