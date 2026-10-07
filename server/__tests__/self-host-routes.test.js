/**
 * Feature 060 (T018, T035, FR-013, FR-021, FR-030, contracts/served-routes.md):
 * /self-host.md and /install.sh are the repository's bytes on every instance,
 * and a not-hosted instance serves the self-hosted documentation variant with
 * the request origin filled in, validated, and escaped.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const request = require('supertest');
const express = require('express');
const { _resetInstanceConfigForTests } = require('../instance-config');
const { mountWebRoutes, mountDistributionRoutes } = require('../web-routes');
const { createClientBuildFixture } = require('./helpers/web-fixture');

const REPO = path.join(__dirname, '../..');
const AGENTS = fs.readFileSync(path.join(REPO, 'AGENTS.md'));
const INSTALL = fs.readFileSync(path.join(REPO, 'distribution/self-host/install.sh'));

const saved = { SQUIRE_HOSTED: process.env.SQUIRE_HOSTED, APP_URL: process.env.APP_URL };
let fixture;

function setEnv(hosted) {
  if (hosted) process.env.SQUIRE_HOSTED = 'true';
  else delete process.env.SQUIRE_HOSTED;
  process.env.APP_URL = 'http://localhost:3910';
  _resetInstanceConfigForTests();
}

function appFor(hosted, clientBuildPath = fixture.dir) {
  setEnv(hosted);
  const app = express();
  mountWebRoutes(app, { clientBuildPath });
  return app;
}

beforeAll(() => {
  fixture = createClientBuildFixture();
});

afterAll(() => {
  fixture.cleanup();
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  _resetInstanceConfigForTests();
});

/** supertest buffers text/* as a string; read raw bytes instead. */
function getRaw(app, p, host) {
  const req = request(app).get(p).buffer(true).parse((res, cb) => {
    const chunks = [];
    res.on('data', (c) => chunks.push(c));
    res.on('end', () => cb(null, Buffer.concat(chunks)));
  });
  return host ? req.set('Host', host) : req;
}

describe.each([['hosted', true], ['not hosted', false]])('%s instance', (_label, hosted) => {
  let app;
  beforeAll(() => {
    app = appFor(hosted);
  });

  test('/self-host.md is AGENTS.md byte for byte', async () => {
    const res = await getRaw(app, '/self-host.md');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe('text/markdown; charset=utf-8');
    expect(res.headers['cache-control']).toBe('public, max-age=300');
    expect(Buffer.isBuffer(res.body)).toBe(true);
    expect(res.body.equals(AGENTS)).toBe(true);
  });

  test('/install.sh is distribution/self-host/install.sh byte for byte', async () => {
    const res = await getRaw(app, '/install.sh');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe('text/x-shellscript; charset=utf-8');
    expect(res.headers['cache-control']).toBe('public, max-age=300');
    expect(res.body.equals(INSTALL)).toBe(true);
  });

  test('a hostile Host header changes nothing', async () => {
    for (const p of ['/self-host.md', '/install.sh']) {
      const res = await getRaw(app, p, 'evil.example');
      expect(res.status).toBe(200);
      expect(res.body.equals(p === '/install.sh' ? INSTALL : AGENTS)).toBe(true);
    }
  });

  test('HEAD is supported', async () => {
    const res = await request(app).head('/install.sh');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe('text/x-shellscript; charset=utf-8');
  });

  test('/agents.md behavior is unchanged', async () => {
    const real = fs.readFileSync(path.join(fixture.dir, 'agents.md'), 'utf8');
    const res = await request(app).get('/agents.md').set('Host', 'localhost:3910');
    expect(res.status).toBe(200);
    if (hosted) {
      expect(res.text).toBe(real);
    } else {
      expect(res.text).toBe(real.split('https://squiredocs.com').join('http://localhost:3910'));
    }
  });

  test('/documentation/_self-hosted paths are the documentation 404', async () => {
    for (const p of ['/documentation/_self-hosted', '/documentation/_self-hosted/index.html', '/documentation/_self-hosted/agents-and-mcp.html']) {
      const res = await request(app).get(p);
      expect(res.status).toBe(404);
      expect(res.text).toMatch(/DOCS 404/);
    }
  });
});

test('the routes work without a client build', async () => {
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'squire-no-client-'));
  try {
    for (const hosted of [true, false]) {
      const app = appFor(hosted, path.join(empty, 'missing'));
      const res = await getRaw(app, '/self-host.md');
      expect(res.status).toBe(200);
      expect(res.body.equals(AGENTS)).toBe(true);
      const sh = await getRaw(app, '/install.sh');
      expect(sh.body.equals(INSTALL)).toBe(true);
    }
  } finally {
    fs.rmSync(empty, { recursive: true, force: true });
  }
});

test('a missing source file leaves its route unmounted', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'squire-repo-'));
  try {
    fs.writeFileSync(path.join(root, 'AGENTS.md'), 'runbook');
    const app = express();
    mountDistributionRoutes(app, { repoRoot: root });
    app.use((req, res) => res.status(404).send('fell through'));
    expect((await request(app).get('/self-host.md')).text).toBe('runbook');
    const res = await request(app).get('/install.sh');
    expect(res.status).toBe(404);
    expect(res.text).toBe('fell through');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe('not hosted: the self-hosted documentation variant', () => {
  let app;
  beforeAll(() => {
    app = appFor(false);
  });

  test('pages carry the request origin in place of the sentinel', async () => {
    const res = await request(app).get('/documentation/agents-and-mcp').set('Host', 'localhost:3910');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe('text/html; charset=utf-8');
    expect(res.text).toContain('AGENTS AND MCP SELF-HOSTED');
    expect(res.text).toContain('<code>http://localhost:3910/mcp</code>');
    expect(res.text).toContain('href="http://localhost:3910/api/docs"');
    expect(res.text).not.toContain('__SQUIRE_ORIGIN__');

    const index = await request(app).get('/documentation').set('Host', 'localhost:4000');
    expect(index.text).toContain('SELF-HOSTED DOCS INDEX http://localhost:4000/mcp');
  });

  test('unknown slugs get the self-hosted 404', async () => {
    const res = await request(app).get('/documentation/nope');
    expect(res.status).toBe(404);
    expect(res.text).toContain('SELF-HOSTED DOCS 404');
  });

  test.each([
    'evil.example"><script>alert(1)</script>',
    "x'onmouseover='alert(1)",
    'a b',
    'user@host',
    'host/path',
    '[::1',
  ])('a hostile Host (%s) never appears unescaped and falls back to APP_URL', async (host) => {
    const res = await request(app).get('/documentation/agents-and-mcp').set('Host', host);
    expect(res.status).toBe(200);
    expect(res.text).not.toContain('<script>alert');
    expect(res.text).not.toContain("'onmouseover=");
    expect(res.text).not.toContain('__SQUIRE_ORIGIN__');
    expect(res.text).toContain('<code>http://localhost:3910/mcp</code>');
  });
});

describe('hosted: documentation is served from the hosted directory untouched', () => {
  test('pages are the hosted files', async () => {
    const app = appFor(true);
    const res = await request(app).get('/documentation/agents-and-mcp');
    expect(res.status).toBe(200);
    expect(res.text).toBe('<html><body>AGENTS AND MCP</body></html>');
  });
});
