/**
 * SSRF-hardened web fetch with HTML-to-text extraction.
 *
 * Security pipeline:
 *   1. URL validation (scheme, no userinfo, non-empty host)
 *   2. IP literal check (for URLs with raw IPs instead of hostnames)
 *   3. Fetch via SSRF-safe undici dispatcher — custom DNS lookup rejects
 *      private IPs at connection time, covering all redirect hops and
 *      eliminating DNS-rebinding TOCTOU
 *   4. Content-type allowlist
 */
const dns = require('dns');
const { Agent } = require('undici');
const { load } = require('cheerio');

const FETCH_TIMEOUT_MS = 15_000;
const MAX_BODY_BYTES = 500 * 1024; // 500 KB
const MAX_TEXT_CHARS = 80_000;

const ALLOWED_CONTENT_TYPES = [
  'text/html',
  'text/plain',
  'application/json',
  'application/xml',
  'text/xml',
  'application/xhtml+xml',
];

// ---------------------------------------------------------------------------
// URL validation
// ---------------------------------------------------------------------------

function validateUrl(urlString) {
  let parsed;
  try {
    parsed = new URL(urlString);
  } catch {
    throw new Error('Invalid URL');
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('Only http and https URLs are allowed');
  }
  if (parsed.username || parsed.password) {
    throw new Error('URLs with credentials are not allowed');
  }
  if (!parsed.hostname) {
    throw new Error('URL has no hostname');
  }
  return parsed;
}

// ---------------------------------------------------------------------------
// Private / reserved IP detection
// ---------------------------------------------------------------------------

function isPrivateIp(ip) {
  // Strip square brackets (URL.hostname wraps IPv6 in brackets)
  if (ip.startsWith('[') && ip.endsWith(']')) {
    ip = ip.slice(1, -1);
  }

  // IPv4-mapped IPv6 — extract the v4 portion (dotted-decimal form)
  const v4MappedDotted = ip.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i);
  if (v4MappedDotted) return isPrivateIp(v4MappedDotted[1]);

  // IPv4-mapped IPv6 — hex form (e.g. ::ffff:7f00:1)
  // Node.js normalizes ::ffff:127.0.0.1 to ::ffff:7f00:1
  const v4MappedHex = ip.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i);
  if (v4MappedHex) {
    const hi = parseInt(v4MappedHex[1], 16);
    const lo = parseInt(v4MappedHex[2], 16);
    const a = (hi >> 8) & 0xff;
    const b = hi & 0xff;
    const c = (lo >> 8) & 0xff;
    const d = lo & 0xff;
    return isPrivateIp(`${a}.${b}.${c}.${d}`);
  }

  // IPv6 checks
  if (ip === '::1') return true;
  if (/^f[cd][0-9a-f]{2}:/i.test(ip)) return true;   // fc00::/7 (ULA)
  if (/^fe[89ab][0-9a-f]:/i.test(ip)) return true;    // fe80::/10 (link-local)
  if (ip === '::') return true;

  // IPv4 checks
  const parts = ip.split('.').map(Number);
  if (parts.length !== 4 || parts.some((p) => Number.isNaN(p))) return false;

  const [a, b] = parts;
  if (a === 0) return true;                            // 0.0.0.0/8
  if (a === 10) return true;                           // 10.0.0.0/8
  if (a === 127) return true;                          // 127.0.0.0/8
  if (a === 169 && b === 254) return true;             // 169.254.0.0/16
  if (a === 172 && b >= 16 && b <= 31) return true;    // 172.16.0.0/12
  if (a === 192 && b === 168) return true;             // 192.168.0.0/16
  if (a === 100 && b >= 64 && b <= 127) return true;   // 100.64.0.0/10 (CGNAT)

  return false;
}

// ---------------------------------------------------------------------------
// SSRF-safe undici dispatcher
//
// Validates resolved IPs at connection time, eliminating the DNS-rebinding
// TOCTOU that exists when DNS is checked separately from the fetch.
// Every connection — including redirect hops — goes through this lookup.
// ---------------------------------------------------------------------------

const ssrfSafeAgent = new Agent({
  connect: {
    lookup: (hostname, opts, callback) => {
      dns.promises.lookup(hostname, { all: true }).then((addresses) => {
        for (const { address } of addresses) {
          if (isPrivateIp(address)) {
            return callback(new Error('URL points to a blocked address'));
          }
        }
        callback(null, addresses);
      }).catch(callback);
    },
  },
});

// ---------------------------------------------------------------------------
// Size-limited body reader
// ---------------------------------------------------------------------------

async function readLimitedBody(response) {
  const chunks = [];
  let total = 0;

  const reader = response.body.getReader();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.length;
      if (total > MAX_BODY_BYTES) {
        throw new Error('Response body exceeds size limit');
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  return Buffer.concat(chunks).toString('utf-8');
}

// ---------------------------------------------------------------------------
// HTML → text extraction (cheerio)
// ---------------------------------------------------------------------------

function htmlToText(html) {
  const $ = load(html);

  // Remove non-content elements
  $('script, style, nav, footer, aside, svg, noscript, iframe, form').remove();

  // Prefer article/main if present
  let root = $('article').first();
  if (!root.length) root = $('main').first();
  if (!root.length) root = $('body');

  // Convert headings to # prefixed lines
  root.find('h1, h2, h3, h4, h5, h6').each((_, el) => {
    const level = parseInt(el.tagName[1], 10);
    const prefix = '#'.repeat(level) + ' ';
    $(el).replaceWith('\n' + prefix + $(el).text().trim() + '\n');
  });

  // Convert list items to "- " lines
  root.find('li').each((_, el) => {
    $(el).replaceWith('\n- ' + $(el).text().trim());
  });

  // Get text content, collapse whitespace
  let text = root.text();
  text = text.replace(/[ \t]+/g, ' ');          // collapse horizontal whitespace
  text = text.replace(/\n{3,}/g, '\n\n');        // collapse excessive newlines
  return text.trim();
}

// ---------------------------------------------------------------------------
// Content extraction dispatcher
// ---------------------------------------------------------------------------

function extractContent(body, contentType) {
  const ct = contentType.toLowerCase();

  if (ct.includes('html') || ct.includes('xhtml')) {
    return htmlToText(body);
  }
  if (ct.includes('json')) {
    try {
      return JSON.stringify(JSON.parse(body), null, 2);
    } catch {
      return body;
    }
  }
  // plain text, xml — use as-is
  return body;
}

// ---------------------------------------------------------------------------
// Main fetch function
// ---------------------------------------------------------------------------

async function webFetch(url) {
  const parsed = validateUrl(url);

  // IP literals bypass the dispatcher's DNS lookup, so check directly
  const host = parsed.hostname;
  if (/^\d+\.\d+\.\d+\.\d+$/.test(host) || host.includes(':')) {
    if (isPrivateIp(host)) {
      throw new Error('URL points to a blocked address');
    }
  }

  // Fetch with timeout + SSRF-safe dispatcher.
  // The dispatcher validates DNS at connection time for every hop
  // (including redirects), eliminating DNS-rebinding TOCTOU.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  let response;
  try {
    response = await fetch(parsed.href, {
      signal: controller.signal,
      redirect: 'follow',
      dispatcher: ssrfSafeAgent,
      headers: {
        'User-Agent': 'node',
        'Accept': 'text/html, application/json, text/plain, application/xml, */*',
      },
    });
  } finally {
    clearTimeout(timer);
  }

  // Content-type check
  const rawContentType = response.headers.get('content-type') || '';
  const contentType = rawContentType.split(';')[0].trim().toLowerCase();
  if (!ALLOWED_CONTENT_TYPES.includes(contentType)) {
    throw new Error(`Unsupported content type: ${contentType}`);
  }

  // Read body with size limit
  const body = await readLimitedBody(response);

  // Extract text content
  let content = extractContent(body, contentType);

  // Truncate if needed
  let truncated = false;
  if (content.length > MAX_TEXT_CHARS) {
    content = content.slice(0, MAX_TEXT_CHARS);
    truncated = true;
  }

  return { content, contentType, url: response.url, truncated };
}

module.exports = { webFetch, isPrivateIp, validateUrl };
