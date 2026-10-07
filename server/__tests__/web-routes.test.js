/**
 * Feature 058 (T043, FR-023/024/029/035): the production server/web-routes.js
 * on a self-hosted instance (SQUIRE_HOSTED unset), against a temp client build
 * whose index.html is the real client/index.html.
 */
const request = require('supertest');
const express = require('express');
const { _resetInstanceConfigForTests } = require('../instance-config');
const { mountWebRoutes, buildCspDirectives, oldDomainRedirect } = require('../web-routes');
const { createClientBuildFixture } = require('./helpers/web-fixture');

let fixture;
let app;
const savedHosted = process.env.SQUIRE_HOSTED;
const savedAppUrl = process.env.APP_URL;

beforeAll(() => {
  delete process.env.SQUIRE_HOSTED;
  process.env.APP_URL = 'http://localhost:3910';
  _resetInstanceConfigForTests();
  fixture = createClientBuildFixture();
  app = express();
  app.use(oldDomainRedirect);
  mountWebRoutes(app, { clientBuildPath: fixture.dir });
});

afterAll(() => {
  fixture.cleanup();
  if (savedHosted === undefined) delete process.env.SQUIRE_HOSTED;
  else process.env.SQUIRE_HOSTED = savedHosted;
  if (savedAppUrl === undefined) delete process.env.APP_URL;
  else process.env.APP_URL = savedAppUrl;
  _resetInstanceConfigForTests();
});

describe('hosted-only paths are 404', () => {
  test.each([
    '/pricing', '/about', '/security', '/blog', '/blog/', '/blog/some-post', '/privacy', '/terms',
    '/landing.html', '/pricing.html', '/about.html', '/security.html', '/blog.css',
  ])('%s', async (p) => {
    const res = await request(app).get(p);
    expect(res.status).toBe(404);
    expect(res.headers['content-type']).toMatch(/^text\/plain/);
    expect(res.text).toBe('Not found');
  });
});

describe('the app shell', () => {
  test.each(['/', '/index.html', '/docs', '/d/3f1a2b4c-1111-2222-3333-444455556666'])('%s serves the self-hosted shell', async (p) => {
    const res = await request(app).get(p);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe('text/html; charset=utf-8');
    expect(res.headers['cache-control']).toBe('public, max-age=0');
    expect(res.text).toContain('<script>window.__SQUIRE_INSTANCE__={"hosted":false}</script>');
    expect(res.text).not.toContain('googletagmanager');
    expect(res.text).not.toContain('LANDING PAGE');
    expect(res.text).toContain('<div id="root"></div>');
  });

  test('static assets still serve', async () => {
    const res = await request(app).get('/assets/app.js');
    expect(res.status).toBe(200);
    expect(res.text).toBe('console.log(1)');
  });
});

test('documentation still serves', async () => {
  const res = await request(app).get('/documentation/agents-and-mcp');
  expect(res.status).toBe(200);
  expect(res.text).toContain('AGENTS AND MCP');
});

test('/agents.md names the request origin, never squiredocs.com', async () => {
  const res = await request(app).get('/agents.md').set('Host', 'localhost:3910');
  expect(res.status).toBe(200);
  expect(res.headers['content-type']).toBe('text/markdown; charset=utf-8');
  expect(res.text).not.toContain('squiredocs.com');
  expect(res.text).toContain('http://localhost:3910/mcp');
});

test('CSP has no Google source in any directive when not hosted', () => {
  const directives = buildCspDirectives({ hosted: false, storage: { cspImageSources: () => [] } });
  const all = Object.values(directives).flat().join(' ');
  // googleusercontent.com stays: it serves Google sign-in profile pictures,
  // not analytics.
  expect(all).not.toMatch(/googletagmanager|google-analytics|analytics\.google|doubleclick|googleadservices|gstatic|www\.google\.com/i);
  expect(directives.imgSrc).toEqual(["'self'", 'data:', 'https://*.googleusercontent.com']);
  expect(directives.scriptSrc).toEqual(["'self'", "'unsafe-inline'", "'unsafe-eval'"]);
  expect(directives.connectSrc).toEqual(["'self'", 'ws:', 'wss:']);
});

describe('old-domain redirect', () => {
  test('does not redirect when not hosted', async () => {
    const res = await request(app).get('/docs').set('Host', 'herodocs.xyz');
    expect(res.status).toBe(200);
  });

  test('redirects when hosted', async () => {
    process.env.SQUIRE_HOSTED = 'true';
    _resetInstanceConfigForTests();
    try {
      const res = await request(app).get('/docs?x=1').set('Host', 'heradocs.com');
      expect(res.status).toBe(301);
      expect(res.headers.location).toBe('https://squiredocs.com/docs?x=1');
    } finally {
      delete process.env.SQUIRE_HOSTED;
      _resetInstanceConfigForTests();
    }
  });
});
