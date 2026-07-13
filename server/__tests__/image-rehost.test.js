/**
 * SSRF + rehost unit tests (feature 002, T022 — SC-004, Principle II).
 *
 * No real network I/O anywhere: DNS and transport are injected fakes. The
 * suite asserts the normative policy in contracts/image-rehost.md — blocked
 * address families, zero connection attempts to blocked addresses (including
 * via redirects), connection pinning (rebind immunity), streaming byte cap,
 * content-type gate, dedup/budget, storage-disabled degradation, and the
 * stability of PolicyError reasons.
 */
const { EventEmitter } = require('events');
const Y = require('yjs');

const documentImages = require('../document-images');
const s3Images = require('../s3-images');
const {
  PolicyError,
  isBlockedAddress,
  safeFetchImage,
  rehostImagesInFragment,
  MAX_UNIQUE_FETCHES,
} = require('../image-rehost');

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

/** Transport fake: records every connection attempt; scripted per-URL. */
function makeTransport(routes) {
  const connections = []; // { href, connectIp }
  const request = async ({ url, connectIp }) => {
    connections.push({ href: url.href, host: url.hostname, connectIp });
    const route = routes[url.href] || routes[url.hostname] || routes['*'];
    if (!route) throw new Error(`no fake route for ${url.href}`);
    if (route.error) throw new Error(route.error);

    const stream = new EventEmitter();
    let destroyed = false;
    const response = {
      statusCode: route.status || 200,
      headers: route.headers || {},
      stream,
      destroy: () => {
        destroyed = true;
      },
    };
    // Emit the body asynchronously, respecting destroy().
    setImmediate(() => {
      const chunks = route.chunks || (route.body ? [route.body] : []);
      for (const chunk of chunks) {
        if (destroyed) return;
        stream.emit('data', Buffer.from(chunk));
      }
      if (!destroyed) stream.emit('end');
    });
    return response;
  };
  return { request, connections };
}

function makeLookup(table) {
  const lookups = [];
  return {
    lookup: async (hostname) => {
      lookups.push(hostname);
      const addresses = table[hostname];
      if (!addresses) throw new Error(`ENOTFOUND ${hostname}`);
      return addresses;
    },
    lookups,
  };
}

const PNG = { 'content-type': 'image/png' };

// ---------------------------------------------------------------------------
// T019 — address validator matrix
// ---------------------------------------------------------------------------

describe('isBlockedAddress', () => {
  const blocked = [
    // IPv4 families (contract §2)
    '0.0.0.0', '0.255.255.255', // unspecified /8
    '10.0.0.1', '10.255.255.255', // RFC 1918
    '100.64.0.1', '100.127.255.255', // CGNAT /10
    '127.0.0.1', '127.99.3.4', // loopback
    '169.254.0.1', '169.254.169.254', // link-local + cloud metadata
    '172.16.0.1', '172.31.255.254', // RFC 1918 /12
    '192.168.1.1', '192.168.255.255', // RFC 1918 /16
    '224.0.0.1', '239.255.255.255', // multicast /4
    '240.0.0.1', '255.255.255.255', // reserved + broadcast
    // IPv6 families
    '::', '::1',
    'fe80::1', 'febf::1', // link-local /10
    'fc00::1', 'fdff::1', // unique-local /7
    'ff02::1', // multicast /8
    '::ffff:127.0.0.1', '::ffff:10.0.0.1', '::ffff:169.254.169.254', // v4-mapped
    '64:ff9b::7f00:1', '64:ff9b::a00:1', // NAT64 of blocked v4 (127.0.0.1 / 10.0.0.1)
    'fe80::1%eth0', // zone index must not bypass
  ];
  for (const ip of blocked) {
    test(`${ip} is blocked`, () => expect(isBlockedAddress(ip)).toBe(true));
  }

  const global = [
    '1.1.1.1', '8.8.8.8', '93.184.216.34', '100.63.255.255', '100.128.0.0',
    '172.15.255.255', '172.32.0.1', '169.253.255.255', '223.255.255.255',
    '2606:4700:4700::1111', '2001:4860:4860::8888',
    '::ffff:8.8.8.8', // v4-mapped GLOBAL passes
    '64:ff9b::808:808', // NAT64 of a global v4 passes
  ];
  for (const ip of global) {
    test(`${ip} passes`, () => expect(isBlockedAddress(ip)).toBe(false));
  }

  test('garbage fails closed', () => {
    expect(isBlockedAddress('not-an-ip')).toBe(true);
    expect(isBlockedAddress('')).toBe(true);
    expect(isBlockedAddress(null)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// T020 — safeFetchImage policy
// ---------------------------------------------------------------------------

describe('safeFetchImage', () => {
  test('fetches a valid image through a pinned connection', async () => {
    const { lookup } = makeLookup({ 'img.example.com': ['93.184.216.34'] });
    const { request, connections } = makeTransport({
      'https://img.example.com/d.png': { headers: PNG, body: 'PNGDATA' },
    });
    const result = await safeFetchImage('https://img.example.com/d.png', { lookup, request });
    expect(result.mimeType).toBe('image/png');
    expect(result.data.toString()).toBe('PNGDATA');
    // Pinned: the socket target is exactly the validated address.
    expect(connections).toEqual([
      { href: 'https://img.example.com/d.png', host: 'img.example.com', connectIp: '93.184.216.34' },
    ]);
  });

  test('non-http(s) schemes are rejected without any I/O', async () => {
    const { lookup, lookups } = makeLookup({});
    const { request, connections } = makeTransport({});
    for (const url of ['ftp://x/y.png', 'file:///etc/passwd', 'data:image/png;base64,AAAA', 'gopher://x']) {
      await expect(safeFetchImage(url, { lookup, request })).rejects.toMatchObject({
        reason: 'bad-scheme',
      });
    }
    expect(lookups).toEqual([]);
    expect(connections).toEqual([]);
  });

  test('hostnames resolving to blocked ranges never get a connection', async () => {
    const cases = {
      'internal.corp': ['10.1.2.3'],
      'meta.evil': ['169.254.169.254'],
      'loop.evil': ['127.0.0.1'],
      'cgnat.evil': ['100.64.9.9'],
      'v6ll.evil': ['fe80::1'],
      'mixed.evil': ['93.184.216.34', '192.168.1.1'], // ANY blocked candidate rejects
    };
    const { lookup } = makeLookup(cases);
    const { request, connections } = makeTransport({ '*': { headers: PNG, body: 'x' } });
    for (const hostname of Object.keys(cases)) {
      await expect(
        safeFetchImage(`http://${hostname}/i.png`, { lookup, request })
      ).rejects.toMatchObject({ reason: 'blocked-address' });
    }
    expect(connections).toEqual([]); // SC-004: zero connections to blocked ranges
  });

  test('literal blocked IPs are rejected, including exotic encodings', async () => {
    const { lookup, lookups } = makeLookup({});
    const { request, connections } = makeTransport({});
    const literals = [
      'http://127.0.0.1/x.png',
      'http://10.0.0.1/x.png',
      'http://169.254.169.254/latest/meta-data',
      'http://[::1]/x.png',
      'http://[fe80::1]/x.png',
      // Exotic IPv4 encodings — the WHATWG URL parser normalizes these to
      // dotted-quad 127.0.0.1 / 0177.… forms before validation (net.isIP).
      'http://0x7f000001/x.png',
      'http://2130706433/x.png',
      'http://0177.0.0.1/x.png',
      'http://127.1/x.png',
    ];
    for (const url of literals) {
      await expect(safeFetchImage(url, { lookup, request })).rejects.toMatchObject({
        reason: 'blocked-address',
      });
    }
    expect(lookups).toEqual([]); // literals never hit DNS
    expect(connections).toEqual([]);
  });

  test('redirect to the metadata address is blocked with zero connections to it (SC-004)', async () => {
    const { lookup } = makeLookup({ 'public.example.com': ['93.184.216.34'] });
    const { request, connections } = makeTransport({
      'https://public.example.com/i.png': {
        status: 302,
        headers: { location: 'http://169.254.169.254/latest/meta-data' },
      },
    });
    await expect(
      safeFetchImage('https://public.example.com/i.png', { lookup, request })
    ).rejects.toMatchObject({ reason: 'blocked-address' });
    // Exactly one connection — to the public host. NONE to 169.254.169.254.
    expect(connections).toHaveLength(1);
    expect(connections[0].connectIp).toBe('93.184.216.34');
  });

  test('redirect hops re-resolve and re-pin; more than 3 hops rejects', async () => {
    const { lookup } = makeLookup({
      'a.example.com': ['1.1.1.1'],
      'b.example.com': ['2.2.2.2'],
    });
    const redirect = (to) => ({ status: 301, headers: { location: to } });
    const { request, connections } = makeTransport({
      'http://a.example.com/1': redirect('http://b.example.com/2'),
      'http://b.example.com/2': { headers: PNG, body: 'ok' },
    });
    const result = await safeFetchImage('http://a.example.com/1', { lookup, request });
    expect(result.data.toString()).toBe('ok');
    expect(connections.map((c) => c.connectIp)).toEqual(['1.1.1.1', '2.2.2.2']);

    // Redirect loop exceeds the cap.
    const loop = makeTransport({ 'http://a.example.com/1': redirect('http://a.example.com/1') });
    await expect(
      safeFetchImage('http://a.example.com/1', { lookup, request: loop.request })
    ).rejects.toMatchObject({ reason: 'too-many-redirects' });
    expect(loop.connections.length).toBe(4); // initial + 3 allowed hops
  });

  test('DNS-rebind shape is immune by construction (pinned connect)', async () => {
    // A rebinding resolver: first answer public, later answers private. The
    // fetch resolves ONCE and pins the socket to the validated address, so
    // the second resolution never happens and the connect target is exactly
    // the checked IP.
    let calls = 0;
    const lookup = async () => (++calls === 1 ? ['93.184.216.34'] : ['10.0.0.1']);
    const { request, connections } = makeTransport({
      'http://rebind.evil/i.png': { headers: PNG, body: 'x' },
    });
    await safeFetchImage('http://rebind.evil/i.png', { lookup, request });
    expect(calls).toBe(1);
    expect(connections).toEqual([
      { href: 'http://rebind.evil/i.png', host: 'rebind.evil', connectIp: '93.184.216.34' },
    ]);
  });

  test('streaming cap aborts mid-body', async () => {
    const { lookup } = makeLookup({ 'big.example.com': ['1.2.3.4'] });
    const chunk = 'x'.repeat(1024);
    const { request } = makeTransport({
      'http://big.example.com/big.png': {
        headers: PNG, // no content-length — must be caught while streaming
        chunks: Array(20).fill(chunk),
      },
    });
    await expect(
      safeFetchImage('http://big.example.com/big.png', { lookup, request, maxBytes: 4096 })
    ).rejects.toMatchObject({ reason: 'too-large' });
  });

  test('over-cap Content-Length rejects before reading the body', async () => {
    const { lookup } = makeLookup({ 'big.example.com': ['1.2.3.4'] });
    const { request } = makeTransport({
      'http://big.example.com/big.png': {
        headers: { ...PNG, 'content-length': String(documentImages.MAX_IMAGE_BYTES + 1) },
        chunks: [],
      },
    });
    await expect(
      safeFetchImage('http://big.example.com/big.png', { lookup, request })
    ).rejects.toMatchObject({ reason: 'too-large' });
  });

  test('disallowed content types reject (params stripped first)', async () => {
    const { lookup } = makeLookup({ 'x.example.com': ['1.2.3.4'] });
    const mk = (ct) => makeTransport({ 'http://x.example.com/f': { headers: { 'content-type': ct }, body: 'x' } });
    for (const ct of ['text/html', 'image/svg+xml', 'application/octet-stream', '']) {
      await expect(
        safeFetchImage('http://x.example.com/f', { lookup, request: mk(ct).request })
      ).rejects.toMatchObject({ reason: 'bad-content-type' });
    }
    // Parameters are stripped before comparison.
    const ok = mk('image/png; charset=binary');
    await expect(
      safeFetchImage('http://x.example.com/f', { lookup, request: ok.request })
    ).resolves.toMatchObject({ mimeType: 'image/png' });
  });

  test('wall-clock timeout aborts the fetch', async () => {
    const { lookup } = makeLookup({ 'slow.example.com': ['1.2.3.4'] });
    const request = ({ signal }) =>
      new Promise((resolve, reject) => {
        // Never responds; only the abort signal ends it.
        signal.addEventListener('abort', () => reject(new Error('aborted')));
      });
    await expect(
      safeFetchImage('http://slow.example.com/i.png', { lookup, request, timeoutMs: 50 })
    ).rejects.toMatchObject({ reason: 'timeout' });
  });

  test('network errors surface as PolicyError network-error', async () => {
    const { lookup } = makeLookup({ 'down.example.com': ['1.2.3.4'] });
    const { request } = makeTransport({ 'http://down.example.com/i.png': { error: 'ECONNREFUSED' } });
    await expect(
      safeFetchImage('http://down.example.com/i.png', { lookup, request })
    ).rejects.toMatchObject({ reason: 'network-error' });
    // Unresolvable hostname too.
    const { request: r2 } = makeTransport({});
    await expect(
      safeFetchImage('http://nxdomain.example.com/i.png', { lookup, request: r2 })
    ).rejects.toMatchObject({ reason: 'network-error' });
  });

  test('PolicyError reasons are the stable contract set', () => {
    const err = new PolicyError('blocked-address', 'x');
    expect(err).toBeInstanceOf(Error);
    expect(err.reason).toBe('blocked-address');
  });
});

// ---------------------------------------------------------------------------
// T021 — rehostImagesInFragment (dedup, budget, degradation, storage-off)
// ---------------------------------------------------------------------------

describe('rehostImagesInFragment', () => {
  let storeSpy;
  let enabledSpy;
  let storedCount;

  beforeEach(() => {
    storedCount = 0;
    enabledSpy = jest.spyOn(s3Images, 'isEnabled').mockReturnValue(true);
    storeSpy = jest.spyOn(documentImages, 'storeImage').mockImplementation(async () => {
      storedCount += 1;
      return { id: `img-${storedCount}`, url: `/api/docs/doc-1/images/img-${storedCount}` };
    });
  });

  afterEach(() => {
    enabledSpy.mockRestore();
    storeSpy.mockRestore();
  });

  function docWithImages(srcs) {
    const doc = new Y.Doc();
    const fragment = doc.getXmlFragment('default');
    doc.transact(() => {
      for (const src of srcs) {
        const img = new Y.XmlElement('image');
        img.setAttribute('src', src);
        img.setAttribute('alt', `alt for ${src.slice(0, 20)}`);
        fragment.insert(fragment.length, [img]);
      }
    });
    return { doc, fragment };
  }

  const okFetch = async () => ({ data: Buffer.from('IMG'), mimeType: 'image/png' });

  test('dedup: 5 references to one URL ⇒ 1 fetch, 1 stored copy, 5 shared srcs', async () => {
    const src = 'https://cdn.example.com/one.png';
    const { fragment } = docWithImages(Array(5).fill(src));
    let fetches = 0;
    const report = await rehostImagesInFragment(fragment, { docId: 'doc-1', userId: 'u1' }, {
      fetchImage: async (...args) => {
        fetches += 1;
        return okFetch(...args);
      },
    });
    expect(fetches).toBe(1);
    expect(storeSpy).toHaveBeenCalledTimes(1);
    expect(report.rehosted).toEqual([{ src, url: '/api/docs/doc-1/images/img-1' }]);
    const srcs = fragment.toArray().map((n) => n.getAttribute('src'));
    expect(srcs).toEqual(Array(5).fill('/api/docs/doc-1/images/img-1'));
  });

  test(`budget: ${MAX_UNIQUE_FETCHES + 1} unique URLs ⇒ ${MAX_UNIQUE_FETCHES} fetches + 1 budget-exhausted degradation`, async () => {
    const srcs = Array.from({ length: MAX_UNIQUE_FETCHES + 1 }, (_, i) => `https://cdn.example.com/${i}.png`);
    const { fragment } = docWithImages(srcs);
    let fetches = 0;
    const report = await rehostImagesInFragment(fragment, { docId: 'doc-1', userId: 'u1' }, {
      fetchImage: async () => {
        fetches += 1;
        return { data: Buffer.from('IMG'), mimeType: 'image/png' };
      },
    });
    expect(fetches).toBe(MAX_UNIQUE_FETCHES);
    expect(report.rehosted).toHaveLength(MAX_UNIQUE_FETCHES);
    expect(report.degraded).toEqual([
      { src: `https://cdn.example.com/${MAX_UNIQUE_FETCHES}.png`, reason: 'budget-exhausted' },
    ]);
  });

  test('storage disabled ⇒ every external degrades, zero fetches', async () => {
    enabledSpy.mockReturnValue(false);
    const { fragment } = docWithImages([
      'https://cdn.example.com/a.png',
      'https://cdn.example.com/b.png',
    ]);
    let fetches = 0;
    const report = await rehostImagesInFragment(fragment, { docId: 'doc-1', userId: 'u1' }, {
      fetchImage: async () => {
        fetches += 1;
        return okFetch();
      },
    });
    expect(fetches).toBe(0);
    expect(report.rehosted).toEqual([]);
    expect(report.degraded.map((d) => d.reason)).toEqual(['storage-disabled', 'storage-disabled']);
    // Degraded to plain links: text = alt, href = original.
    const first = fragment.get(0);
    expect(first.nodeName).toBe('paragraph');
    const delta = first.get(0).toDelta();
    expect(delta[0].attributes.link.href).toBe('https://cdn.example.com/a.png');
  });

  test('PolicyError degrades the node to a plain link with the stable reason', async () => {
    const { fragment } = docWithImages(['https://blocked.example.com/i.png']);
    const report = await rehostImagesInFragment(fragment, { docId: 'doc-1', userId: 'u1' }, {
      fetchImage: async () => {
        throw new PolicyError('blocked-address', 'nope');
      },
    });
    expect(report.degraded).toEqual([
      { src: 'https://blocked.example.com/i.png', reason: 'blocked-address' },
    ]);
    const para = fragment.get(0);
    expect(para.nodeName).toBe('paragraph');
    const delta = para.get(0).toDelta();
    expect(delta[0].insert).toContain('alt for');
    expect(delta[0].attributes.link.href).toBe('https://blocked.example.com/i.png');
  });

  test('per-image failures never fail the pass; successes still land (FR-018)', async () => {
    const { fragment } = docWithImages([
      'https://ok.example.com/a.png',
      'https://down.example.com/b.png',
    ]);
    const report = await rehostImagesInFragment(fragment, { docId: 'doc-1', userId: 'u1' }, {
      fetchImage: async (src) => {
        if (src.includes('down')) throw new PolicyError('network-error', 'down');
        return okFetch();
      },
    });
    expect(report.rehosted).toHaveLength(1);
    expect(report.degraded).toEqual([
      { src: 'https://down.example.com/b.png', reason: 'network-error' },
    ]);
  });

  test('app image URLs are left alone; attribution flows to storeImage', async () => {
    const { fragment } = docWithImages([
      '/api/docs/doc-1/images/existing',
      'https://cdn.example.com/new.png',
    ]);
    await rehostImagesInFragment(fragment, { docId: 'doc-1', userId: 'user-42' }, {
      fetchImage: okFetch,
    });
    expect(fragment.get(0).getAttribute('src')).toBe('/api/docs/doc-1/images/existing');
    expect(storeSpy).toHaveBeenCalledWith(
      expect.objectContaining({ docId: 'doc-1', uploaderId: 'user-42', filename: 'new.png' })
    );
  });

  test('accepts a detached node array (the modify post-pass shape)', async () => {
    const doc = new Y.Doc();
    const fragment = doc.getXmlFragment('default');
    doc.transact(() => {
      const img = new Y.XmlElement('image');
      img.setAttribute('src', 'https://cdn.example.com/tagged.png');
      fragment.insert(0, [img]);
    });
    const report = await rehostImagesInFragment([fragment.get(0)], { docId: 'doc-1', userId: 'u1' }, {
      fetchImage: okFetch,
    });
    expect(report.rehosted).toHaveLength(1);
    expect(fragment.get(0).getAttribute('src')).toBe('/api/docs/doc-1/images/img-1');
  });
});
