/**
 * SSRF-safe image fetch-and-rehost (feature 002, US4).
 *
 * The ONLY network egress this feature introduces. Normative policy:
 * specs/002-markdown-import-surfaces/contracts/image-rehost.md (constitution
 * Principle V). Consumed by the import module's staged image pass and by
 * modify's post-script pass for `fromMarkdown`-tagged nodes (FR-021).
 *
 * Policy summary (CN-7 / FR-017):
 *  - http/https only; everything else rejected without I/O.
 *  - Every hop (initial + each redirect, max 3): resolve the hostname,
 *    validate ALL candidate addresses against the non-global blocklist, and
 *    PIN the connection to the validated IP (hostname used only for the Host
 *    header / TLS SNI) — no second resolution between check and connect.
 *  - 10 s wall clock per fetch, enforced with an abort.
 *  - Byte cap (existing documentImages.MAX_IMAGE_BYTES) enforced WHILE
 *    streaming, plus an early Content-Length reject.
 *  - Content-Type must be in the existing image MIME allowlist.
 *  - ≤ 20 unique external URLs fetched per import, deduplicated.
 *  - No cookies, no auth, no proxy env, fixed innocuous User-Agent.
 *
 * Pass-level bounds (Sam P-1, 2026-07-13): the whole image pass runs the unique
 * fetches with bounded concurrency (default 4, each still under the full
 * per-fetch SSRF policy above) and under an aggregate wall-clock budget
 * (default 30 s, IMPORT_IMAGE_PASS_BUDGET_MS). When the budget expires, any
 * in-flight fetch is aborted and every not-yet-rehosted image degrades to a
 * plain link, itemized with reason `time-budget-exhausted` (distinct from the
 * 20-unique count budget's `budget-exhausted`).
 *
 * Zero new dependencies: Node core dns/net/http/https only (research R4).
 */
const dns = require('dns');
const net = require('net');
const http = require('http');
const https = require('https');
const path = require('path');
const Y = require('yjs');
const documentImages = require('./document-images');
const s3Images = require('./s3-images');
const { isAppImageUrl } = require('./image-url');
const { findByNodeName } = require('./mcp/sandbox/helpers');

/** Stable, machine-readable failure reasons (contract §Public surface). */
class PolicyError extends Error {
  constructor(reason, message) {
    super(message || reason);
    this.name = 'PolicyError';
    this.reason = reason;
  }
}

const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_REDIRECTS = 3;
const MAX_UNIQUE_FETCHES = 20;
const USER_AGENT = 'SquireDocs-ImageImport/1.0';

/** Aggregate wall-clock budget for the whole image pass (all fetches). */
const DEFAULT_PASS_BUDGET_MS = 30_000;
/** How many unique images the pass fetches in parallel (contract permits 1–4). */
const DEFAULT_CONCURRENCY = 4;

/**
 * Resolve the pass-level time budget: explicit override wins, then
 * IMPORT_IMAGE_PASS_BUDGET_MS, then the 30 s default. An override of 0 is
 * honored (immediate expiry — useful for tests).
 */
function resolvePassBudgetMs(override) {
  if (Number.isFinite(override)) return override;
  const env = parseInt(process.env.IMPORT_IMAGE_PASS_BUDGET_MS, 10);
  if (Number.isFinite(env) && env > 0) return env;
  return DEFAULT_PASS_BUDGET_MS;
}

// ---------------------------------------------------------------------------
// T019 — address validation
// ---------------------------------------------------------------------------

/** Parse a dotted-quad IPv4 string into a 32-bit unsigned int. */
function ipv4ToInt(ip) {
  const parts = ip.split('.').map(Number);
  return (((parts[0] << 24) >>> 0) + (parts[1] << 16) + (parts[2] << 8) + parts[3]) >>> 0;
}

const IPV4_BLOCKED_RANGES = [
  ['0.0.0.0', 8], // unspecified / "this network"
  ['10.0.0.0', 8], // RFC 1918
  ['100.64.0.0', 10], // CGNAT
  ['127.0.0.0', 8], // loopback
  ['169.254.0.0', 16], // link-local (incl. 169.254.169.254 cloud metadata)
  ['172.16.0.0', 12], // RFC 1918
  ['192.168.0.0', 16], // RFC 1918
  ['224.0.0.0', 4], // multicast
  ['240.0.0.0', 4], // reserved (incl. 255.255.255.255 broadcast)
].map(([base, bits]) => ({
  base: ipv4ToInt(base),
  mask: bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0,
}));

function isBlockedIpv4(ip) {
  const value = ipv4ToInt(ip);
  return IPV4_BLOCKED_RANGES.some(({ base, mask }) => (value & mask) >>> 0 === base);
}

/** Expand an IPv6 string (possibly ::-compressed) into 16 bytes, or null. */
function ipv6ToBytes(ip) {
  // Strip zone index (fe80::1%eth0) — the address part is what matters.
  const addr = ip.split('%')[0];
  let head = addr;
  let tail = '';
  if (addr.includes('::')) {
    const [h, t] = addr.split('::');
    head = h;
    tail = t;
  } else if (addr.split(':').length !== 8 && !addr.includes('.')) {
    return null;
  }

  const parseGroups = (s) => (s === '' ? [] : s.split(':'));
  const headGroups = parseGroups(head);
  const tailGroups = parseGroups(tail);

  // An embedded IPv4 tail (::ffff:1.2.3.4) becomes two 16-bit groups.
  const expandV4 = (groups) => {
    const out = [];
    for (const g of groups) {
      if (g.includes('.')) {
        const v = ipv4ToInt(g);
        out.push(((v >>> 16) & 0xffff).toString(16), (v & 0xffff).toString(16));
      } else {
        out.push(g);
      }
    }
    return out;
  };

  const h = expandV4(headGroups);
  const t = expandV4(tailGroups);
  const missing = 8 - h.length - t.length;
  if (missing < 0) return null;
  const groups = [...h, ...Array(missing).fill('0'), ...t];
  if (groups.length !== 8) return null;

  const bytes = [];
  for (const g of groups) {
    const v = parseInt(g, 16);
    if (Number.isNaN(v) || v < 0 || v > 0xffff) return null;
    bytes.push((v >> 8) & 0xff, v & 0xff);
  }
  return bytes;
}

function isBlockedIpv6(ip) {
  const b = ipv6ToBytes(ip);
  if (!b) return true; // unparseable ⇒ fail closed

  const allZero = b.every((x) => x === 0);
  if (allZero) return true; // ::

  const isLoopback = b.slice(0, 15).every((x) => x === 0) && b[15] === 1;
  if (isLoopback) return true; // ::1

  if (b[0] === 0xfe && (b[1] & 0xc0) === 0x80) return true; // fe80::/10 link-local
  if ((b[0] & 0xfe) === 0xfc) return true; // fc00::/7 unique-local
  if (b[0] === 0xff) return true; // ff00::/8 multicast

  // IPv4-mapped ::ffff:a.b.c.d — re-check as IPv4.
  if (b.slice(0, 10).every((x) => x === 0) && b[10] === 0xff && b[11] === 0xff) {
    return isBlockedIpv4(`${b[12]}.${b[13]}.${b[14]}.${b[15]}`);
  }

  // NAT64 64:ff9b::/96 — re-check the embedded IPv4.
  if (
    b[0] === 0x00 && b[1] === 0x64 && b[2] === 0xff && b[3] === 0x9b &&
    b.slice(4, 12).every((x) => x === 0)
  ) {
    return isBlockedIpv4(`${b[12]}.${b[13]}.${b[14]}.${b[15]}`);
  }

  return false;
}

/**
 * Whether an IP address (v4 or v6 string) is blocked for image fetching.
 * Non-global ranges per contracts/image-rehost.md §2; unparseable input is
 * blocked (fail closed).
 */
function isBlockedAddress(ip) {
  const family = net.isIP(ip);
  if (family === 4) return isBlockedIpv4(ip);
  if (family === 6) return isBlockedIpv6(ip);
  return true;
}

// ---------------------------------------------------------------------------
// T020 — SSRF-safe fetch
// ---------------------------------------------------------------------------

/** Default resolver: all candidate addresses for a hostname. */
function defaultLookup(hostname) {
  return new Promise((resolve, reject) => {
    dns.lookup(hostname, { all: true, verbatim: true }, (err, addresses) => {
      if (err) reject(err);
      else resolve(addresses.map((a) => a.address));
    });
  });
}

/**
 * Default transport: one pinned HTTP(S) request. Connects to `connectIp`
 * (the validated address); the URL's hostname is used ONLY for the Host
 * header and TLS SNI/cert verification. Never follows redirects itself.
 * @returns {Promise<{ statusCode, headers, stream, destroy }>}
 */
function defaultRequest({ url, connectIp, signal }) {
  return new Promise((resolve, reject) => {
    const isHttps = url.protocol === 'https:';
    const mod = isHttps ? https : http;
    const options = {
      host: connectIp, // pinned — no re-resolution between check and connect
      port: url.port || (isHttps ? 443 : 80),
      path: `${url.pathname}${url.search}`,
      method: 'GET',
      headers: {
        Host: url.host, // original hostname (+port) for virtual hosting
        'User-Agent': USER_AGENT,
        Accept: 'image/*',
      },
      signal,
      // No proxy env is consulted (node core http ignores it by design),
      // no cookies, no auth headers, no credential forwarding.
    };
    if (isHttps) {
      options.servername = url.hostname; // SNI + certificate verification
    }
    const req = mod.request(options, (res) => {
      resolve({
        statusCode: res.statusCode,
        headers: res.headers,
        stream: res,
        destroy: () => req.destroy(),
      });
    });
    req.on('error', reject);
    req.end();
  });
}

/** Resolve + validate every candidate address; return the pinned IP. */
async function resolveAndValidate(hostname, lookup) {
  // Literal IPs (including exotic encodings — the URL parser normalizes
  // octal/hex/integer IPv4 forms to dotted quad) validate directly.
  const literal = hostname.startsWith('[') ? hostname.slice(1, -1) : hostname;
  if (net.isIP(literal)) {
    if (isBlockedAddress(literal)) {
      throw new PolicyError('blocked-address', `Address ${literal} is not fetchable`);
    }
    return literal;
  }
  let addresses;
  try {
    addresses = await lookup(hostname);
  } catch (err) {
    throw new PolicyError('network-error', `Could not resolve ${hostname}: ${err.message}`);
  }
  if (!addresses || addresses.length === 0) {
    throw new PolicyError('network-error', `No addresses for ${hostname}`);
  }
  // Reject if ANY candidate is non-global (an attacker-controlled resolver
  // must not be able to mix a public decoy with a private target).
  for (const address of addresses) {
    if (isBlockedAddress(address)) {
      throw new PolicyError('blocked-address', `Address ${address} for ${hostname} is not fetchable`);
    }
  }
  return addresses[0];
}

/** Strip parameters from a Content-Type header value. */
function bareContentType(value) {
  return String(value || '').split(';')[0].trim().toLowerCase();
}

/**
 * Fetch one image URL under the full SSRF policy.
 * @param {string} rawUrl
 * @param {object} [opts]
 * @param {number} [opts.maxBytes] - streaming byte cap (default: existing image cap)
 * @param {number} [opts.timeoutMs] - wall clock per fetch
 * @param {number} [opts.maxRedirects]
 * @param {Function} [opts.lookup] - injected resolver (tests)
 * @param {Function} [opts.request] - injected transport (tests)
 * @param {AbortSignal} [opts.signal] - external abort (e.g. the pass-level
 *   time budget); composes with the per-fetch timeout without weakening it.
 * @returns {Promise<{ data: Buffer, mimeType: string }>}
 * @throws {PolicyError}
 */
async function safeFetchImage(rawUrl, opts = {}) {
  const maxBytes = opts.maxBytes ?? documentImages.MAX_IMAGE_BYTES;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxRedirects = opts.maxRedirects ?? DEFAULT_MAX_REDIRECTS;
  const lookup = opts.lookup || defaultLookup;
  const request = opts.request || defaultRequest;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  // Compose an external abort (pass budget) with our own timeout — either one
  // aborting this fetch is treated as a timeout by the loop below.
  const externalSignal = opts.signal;
  let onExternalAbort = null;
  if (externalSignal) {
    if (externalSignal.aborted) controller.abort();
    else {
      onExternalAbort = () => controller.abort();
      externalSignal.addEventListener('abort', onExternalAbort);
    }
  }
  let active = null;

  try {
    let url;
    try {
      url = new URL(rawUrl);
    } catch (e) {
      throw new PolicyError('bad-scheme', `Not a fetchable URL: ${rawUrl}`);
    }

    for (let hop = 0; ; hop++) {
      // 1. Scheme allowlist — every hop (redirect targets included).
      if (url.protocol !== 'http:' && url.protocol !== 'https:') {
        throw new PolicyError('bad-scheme', `Scheme ${url.protocol} is not fetchable`);
      }
      // 2+3. Resolve, validate ALL candidates, pin the connection.
      const connectIp = await resolveAndValidate(url.hostname, lookup);
      if (controller.signal.aborted) throw new PolicyError('timeout', 'Fetch timed out');

      let response;
      try {
        response = await request({ url, connectIp, signal: controller.signal });
      } catch (err) {
        if (controller.signal.aborted) throw new PolicyError('timeout', 'Fetch timed out');
        throw new PolicyError('network-error', `Fetch failed: ${err.message}`);
      }
      active = response;

      // 4. Redirects: revalidate every hop, max 3.
      if ([301, 302, 303, 307, 308].includes(response.statusCode)) {
        response.destroy();
        active = null;
        if (hop >= maxRedirects) {
          throw new PolicyError('too-many-redirects', `More than ${maxRedirects} redirects`);
        }
        const location = response.headers.location;
        if (!location) throw new PolicyError('network-error', 'Redirect without Location');
        url = new URL(location, url); // relative redirects resolve against current
        continue;
      }

      if (response.statusCode !== 200) {
        response.destroy();
        throw new PolicyError('network-error', `HTTP ${response.statusCode}`);
      }

      // 7. Content type against the existing allowlist (params stripped).
      const mimeType = bareContentType(response.headers['content-type']);
      if (!documentImages.ALLOWED_IMAGE_MIME_TYPES.includes(mimeType)) {
        response.destroy();
        throw new PolicyError('bad-content-type', `Content type ${mimeType || '(none)'} is not an allowed image type`);
      }

      // 6. Early Content-Length reject, then the streaming cap.
      const declared = parseInt(response.headers['content-length'], 10);
      if (Number.isFinite(declared) && declared > maxBytes) {
        response.destroy();
        throw new PolicyError('too-large', `Declared size ${declared} exceeds the image cap`);
      }

      const chunks = [];
      let received = 0;
      const data = await new Promise((resolve, reject) => {
        response.stream.on('data', (chunk) => {
          received += chunk.length;
          if (received > maxBytes) {
            response.destroy();
            reject(new PolicyError('too-large', 'Image exceeds the byte cap (aborted mid-stream)'));
            return;
          }
          chunks.push(chunk);
        });
        response.stream.on('end', () => resolve(Buffer.concat(chunks)));
        response.stream.on('error', (err) => {
          if (err instanceof PolicyError) reject(err);
          else if (controller.signal.aborted) reject(new PolicyError('timeout', 'Fetch timed out'));
          else reject(new PolicyError('network-error', `Stream failed: ${err.message}`));
        });
      });
      if (data.length === 0) throw new PolicyError('network-error', 'Empty response body');
      return { data, mimeType };
    }
  } finally {
    clearTimeout(timer);
    if (onExternalAbort) externalSignal.removeEventListener('abort', onExternalAbort);
    if (active) {
      try { active.destroy(); } catch (e) { /* already closed */ }
    }
  }
}

// ---------------------------------------------------------------------------
// T021 — rehost pass over a fragment / node array
// ---------------------------------------------------------------------------

/** Scheme of a src (control/whitespace chars stripped), lowercased or null. */
function schemeOf(src) {
  if (typeof src !== 'string') return null;
  const cleaned = src.replace(/[\u0000-\u0020\u007f\s]+/g, '');
  const m = cleaned.match(/^([a-z][a-z0-9+.-]*):/i);
  return m ? m[1].toLowerCase() : null;
}

/** Truncate long srcs for the report. */
function reportSrc(src) {
  return typeof src === 'string' && src.length > 64 ? `${src.slice(0, 64)}…` : src;
}

/**
 * Replace an image node with its degradation: a paragraph holding the alt
 * text (or the URL) as a plain link — or plain text when the src scheme is
 * not http(s), so a dangerous href is never re-emitted (FR-018/FR-022).
 */
function degradeImageNode(node, { withLink }) {
  const parent = node.parent;
  if (!parent) return;
  const idx = parent.toArray().indexOf(node);
  if (idx < 0) return;
  const src = node.getAttribute('src') || '';
  const alt = node.getAttribute('alt') || '';
  const text = alt || src;
  const para = new Y.XmlElement('paragraph');
  const t = new Y.XmlText();
  if (text) {
    t.insert(0, text);
    if (withLink) t.format(0, text.length, { link: { href: src } });
  }
  para.insert(0, [t]);
  parent.delete(idx, 1);
  parent.insert(idx, [para]);
}

/** Normalize an external URL for dedup purposes. */
function normalizeUrl(src) {
  try {
    return new URL(src).href;
  } catch (e) {
    return src;
  }
}

/** Map a per-fetch error to a stable degradation reason. */
function classifyFetchError(err) {
  if (err instanceof PolicyError) return err.reason;
  if (err && err.status === 413) return 'too-large';
  if (err && err.status === 400) return 'bad-content-type';
  return 'network-error';
}

/**
 * Rehost external http(s) image srcs found on the given image nodes.
 * Mutates node srcs in place (external → app URL) or degrades the node to a
 * plain link. Never throws for per-image failures (FR-018).
 *
 * Unique fetches run with bounded concurrency (default 4) under an aggregate
 * wall-clock budget (default 30 s / IMPORT_IMAGE_PASS_BUDGET_MS). When the
 * budget expires, in-flight fetches are aborted and remaining images degrade
 * with reason `time-budget-exhausted`.
 *
 * @param {Y.XmlFragment|Y.XmlElement[]} target - fragment or just-imported nodes
 * @param {{ docId: string, userId: string }} ctx
 * @param {object} [opts] - test/wiring injection: { fetchImage, fetchOptions,
 *   budgetMs, concurrency }
 * @returns {Promise<{ rehosted: Array<{src, url}>, degraded: Array<{src, reason}> }>}
 */
async function rehostImagesInFragment(target, ctx, opts = {}) {
  const fetchImage = opts.fetchImage || safeFetchImage;
  const budgetMs = resolvePassBudgetMs(opts.budgetMs);
  const concurrency = Number.isFinite(opts.concurrency) ? opts.concurrency : DEFAULT_CONCURRENCY;
  const rehosted = [];
  const degraded = [];

  const imageNodes = Array.isArray(target)
    ? target.flatMap((n) => {
        if (!(n instanceof Y.XmlElement)) return [];
        return n.nodeName === 'image' ? [n] : findByNodeName(n, 'image');
      })
    : findByNodeName(target, 'image');

  // Group external nodes by normalized URL (N references ⇒ 1 fetch, 1 copy).
  const groups = new Map(); // normalized URL -> { src, nodes: [] }
  for (const node of imageNodes) {
    const src = node.getAttribute('src');
    if (isAppImageUrl(src)) continue; // same-doc/cross-doc app URLs: not ours
    const scheme = schemeOf(src);
    if (scheme !== 'http' && scheme !== 'https') {
      // data: never reaches this pass on the import path (rejected earlier);
      // anything else non-http(s) is unfetchable — degrade to plain text.
      degraded.push({ src: reportSrc(src), reason: scheme === 'data' ? 'data-url' : 'bad-scheme' });
      degradeImageNode(node, { withLink: false });
      continue;
    }
    const key = normalizeUrl(src);
    if (!groups.has(key)) groups.set(key, { src, nodes: [] });
    groups.get(key).nodes.push(node);
  }
  if (groups.size === 0) return { rehosted, degraded };

  // Ordered snapshot so the report stays deterministic under concurrency.
  const ordered = [...groups.values()];

  // Storage off ⇒ nothing can be rehosted; degrade everything, fetch nothing.
  const storageEnabled = s3Images.isEnabled();
  if (!storageEnabled) {
    for (const { src, nodes } of ordered) {
      degraded.push({ src: reportSrc(src), reason: 'storage-disabled' });
      for (const node of nodes) degradeImageNode(node, { withLink: true });
    }
    return { rehosted, degraded };
  }

  // Count budget: only the first MAX_UNIQUE_FETCHES unique URLs are eligible to
  // be fetched; the rest degrade with `budget-exhausted` (unchanged).
  const fetchable = ordered.slice(0, MAX_UNIQUE_FETCHES);

  // Pass-level time budget: aborts in-flight fetches and stops the pool from
  // pulling new work once it expires. Per-group outcomes are recorded so the
  // report is assembled in the original order below regardless of completion
  // order. Each fetch keeps its own per-fetch SSRF policy fully intact — the
  // shared signal only ADDS an abort path (validation/pinning are per-call,
  // with no cross-fetch mutable state).
  const budgetController = new AbortController();
  const budgetTimer = setTimeout(() => budgetController.abort(), budgetMs);
  const outcomes = new Map(); // group -> { type:'rehost', url } | { type:'degrade', reason }

  let cursor = 0;
  const worker = async () => {
    for (;;) {
      if (budgetController.signal.aborted) return; // stop taking new work
      const i = cursor++;
      if (i >= fetchable.length) return;
      const group = fetchable[i];
      try {
        const fetchOpts = { ...opts.fetchOptions, signal: budgetController.signal };
        const { data, mimeType } = await fetchImage(group.src, fetchOpts);
        const filename = path.posix.basename(new URL(group.src).pathname) || null;
        const stored = await documentImages.storeImage({
          docId: ctx.docId,
          uploaderId: ctx.userId,
          data,
          mimeType,
          filename,
        });
        for (const node of group.nodes) node.setAttribute('src', stored.url);
        outcomes.set(group, { type: 'rehost', url: stored.url });
      } catch (err) {
        // A fetch that failed because the pass budget expired (its signal
        // aborted mid-flight) is itemized distinctly from a real fetch failure.
        const reason = budgetController.signal.aborted
          ? 'time-budget-exhausted'
          : classifyFetchError(err);
        outcomes.set(group, { type: 'degrade', reason });
        for (const node of group.nodes) degradeImageNode(node, { withLink: true });
      }
    }
  };

  try {
    const poolSize = Math.max(1, Math.min(concurrency, fetchable.length));
    await Promise.all(Array.from({ length: poolSize }, () => worker()));
  } finally {
    clearTimeout(budgetTimer);
  }

  // Assemble the report in original group order (stable, concurrency-agnostic).
  ordered.forEach((group, idx) => {
    if (idx >= MAX_UNIQUE_FETCHES) {
      degraded.push({ src: reportSrc(group.src), reason: 'budget-exhausted' });
      for (const node of group.nodes) degradeImageNode(node, { withLink: true });
      return;
    }
    const outcome = outcomes.get(group);
    if (!outcome) {
      // Never pulled from the queue — the deadline hit before its turn.
      degraded.push({ src: reportSrc(group.src), reason: 'time-budget-exhausted' });
      for (const node of group.nodes) degradeImageNode(node, { withLink: true });
      return;
    }
    if (outcome.type === 'rehost') {
      rehosted.push({ src: reportSrc(group.src), url: outcome.url });
    } else {
      degraded.push({ src: reportSrc(group.src), reason: outcome.reason });
    }
  });

  return { rehosted, degraded };
}

module.exports = {
  PolicyError,
  isBlockedAddress,
  safeFetchImage,
  rehostImagesInFragment,
  MAX_UNIQUE_FETCHES,
  DEFAULT_PASS_BUDGET_MS,
  DEFAULT_CONCURRENCY,
  USER_AGENT,
};
