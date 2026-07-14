/**
 * Tests for the authorize-link shortener (design: agent-surface-mcp,
 * "Authorize-link shortener" amendment, Sam 2026-07-14).
 *
 * POST /mcp/auth/shorten accepts only same-path /mcp/auth/authorize URLs and
 * GET /mcp/auth/a/:code 302-redirects to a target rebuilt on this origin.
 * Runs against the in-memory fallback store (no REDIS_HOST in the test env).
 */
const request = require('supertest');
const express = require('express');
const shortLinks = require('../mcp/auth/short-links');
const { closeRedis } = require('../redis');

afterAll(async () => {
  // short-links opens the shared redis client when REDIS_HOST is set;
  // close it so jest can exit cleanly.
  await closeRedis();
});

const AUTHORIZE_QS =
  '?response_type=code&client_id=client_abc123&code_challenge=xyz' +
  '&code_challenge_method=S256&redirect_uri=http%3A%2F%2Flocalhost%3A3118%2Fcallback' +
  '&state=st_1&scope=documents%3Aread+documents%3Awrite';

describe('authorize-link shortener', () => {
  let app;

  beforeAll(() => {
    app = express();
    app.use(express.json());
    // The full oauth-router pulls in DB-backed flow handlers; mount just the
    // shortener routes with the same handler wiring as oauth-router.js.
    const { buildBaseUrl } = require('../url');
    app.post('/mcp/auth/shorten', async (req, res) => {
      const result = await shortLinks.createShortLink(req.body?.url);
      if (!result) return res.status(400).json({ error: 'invalid_url' });
      res.json({
        shortUrl: `${buildBaseUrl(req)}/mcp/auth/a/${result.code}`,
        expiresAt: result.expiresAt.toISOString(),
        expiresInSeconds: shortLinks.TTL_SECONDS,
      });
    });
    app.get('/mcp/auth/a/:code', async (req, res) => {
      const target = await shortLinks.resolveShortLink(req.params.code);
      if (!target) return res.status(404).send('expired');
      res.redirect(302, target);
    });
  });

  test('shortens a valid authorize URL and redirects to the same-origin path', async () => {
    const url = `https://squiredocs.com/mcp/auth/authorize${AUTHORIZE_QS}`;
    const shortened = await request(app)
      .post('/mcp/auth/shorten')
      .send({ url })
      .expect(200);

    expect(shortened.body.shortUrl).toMatch(/\/mcp\/auth\/a\/[A-Za-z0-9_-]{8}$/);
    expect(shortened.body.expiresInSeconds).toBe(600);

    const code = shortened.body.shortUrl.split('/').pop();
    const redirect = await request(app).get(`/mcp/auth/a/${code}`).expect(302);
    expect(redirect.headers.location).toBe(`/mcp/auth/authorize${AUTHORIZE_QS}`);
  });

  test('discards the submitted host — target is origin-relative even for foreign hosts', async () => {
    const shortened = await request(app)
      .post('/mcp/auth/shorten')
      .send({ url: `https://evil.example.com/mcp/auth/authorize${AUTHORIZE_QS}` })
      .expect(200);

    const code = shortened.body.shortUrl.split('/').pop();
    const redirect = await request(app).get(`/mcp/auth/a/${code}`).expect(302);
    // Relative redirect: resolves against whichever origin served it, never evil.example.com.
    expect(redirect.headers.location).toBe(`/mcp/auth/authorize${AUTHORIZE_QS}`);
  });

  test('short links are reusable within the TTL (not single-use)', async () => {
    const shortened = await request(app)
      .post('/mcp/auth/shorten')
      .send({ url: `https://squiredocs.com/mcp/auth/authorize${AUTHORIZE_QS}` })
      .expect(200);
    const code = shortened.body.shortUrl.split('/').pop();
    await request(app).get(`/mcp/auth/a/${code}`).expect(302);
    await request(app).get(`/mcp/auth/a/${code}`).expect(302);
  });

  test.each([
    ['non-authorize path', 'https://squiredocs.com/mcp/auth/token?x=1'],
    ['path prefix trick', 'https://squiredocs.com/mcp/auth/authorize/../../etc'],
    ['not a URL', 'not a url at all'],
    ['non-http scheme', 'javascript:alert(1)'],
    ['missing url field', undefined],
  ])('rejects %s with 400', async (_label, url) => {
    await request(app).post('/mcp/auth/shorten').send({ url }).expect(400);
  });

  test('rejects URLs over the length cap', async () => {
    const url =
      'https://squiredocs.com/mcp/auth/authorize?state=' + 'x'.repeat(2100);
    await request(app).post('/mcp/auth/shorten').send({ url }).expect(400);
  });

  test('unknown and malformed codes 404', async () => {
    await request(app).get('/mcp/auth/a/nosuchcd').expect(404);
    await request(app).get('/mcp/auth/a/%2e%2e%2fetc').expect(404);
  });
});
