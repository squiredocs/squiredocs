/**
 * Route tests for the static blog.
 *
 * mountBlogRoutes is mounted on a bare Express app pointed at a fixture
 * directory of a few fake built posts plus index.html and 404.html, so the test
 * is hermetic and needs no full client build and no database. A sentinel
 * app.get('*') stands in for the app-shell catch-all so we can prove the blog
 * routes run before it and an unknown slug never falls through.
 *
 * Patterned on documentation-routes.test.js.
 */
const request = require('supertest');
const express = require('express');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { mountBlogRoutes } = require('../blog-routes');

const APP_SHELL = 'THE-APP-SHELL-SENTINEL';
const SECRET = 'TOP-SECRET-OUTSIDE-BLOG';

let tmpRoot;
let blogDistDir;
let app;

beforeAll(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'blog-routes-'));
  blogDistDir = path.join(tmpRoot, 'blog');
  fs.mkdirSync(blogDistDir, { recursive: true });

  // A file OUTSIDE the blog dir that a traversal attempt must never reach.
  fs.writeFileSync(path.join(tmpRoot, 'secret.html'), `<html>${SECRET}</html>`);

  // Fixture built posts.
  fs.writeFileSync(path.join(blogDistDir, 'index.html'), '<html><body>BLOG INDEX PAGE</body></html>');
  fs.writeFileSync(path.join(blogDistDir, 'why-i-built-squire-docs.html'), '<html><body>WHY POST</body></html>');
  fs.writeFileSync(path.join(blogDistDir, 'sharing-specs-with-product-managers.html'), '<html><body>SHARING POST</body></html>');
  fs.writeFileSync(
    path.join(blogDistDir, '404.html'),
    '<html><body>Not found. <a href="/blog">Go to the blog index</a>.</body></html>'
  );

  app = express();
  mountBlogRoutes(app, blogDistDir);
  // Stand-in for the app-shell catch-all; blog routes must win first.
  app.get('*', (req, res) => res.status(200).send(APP_SHELL));
});

afterAll(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

describe('blog routes', () => {
  test('serves the index publicly with no auth (200)', async () => {
    const res = await request(app).get('/blog');
    expect(res.status).toBe(200);
    expect(res.text).toContain('BLOG INDEX PAGE');
  });

  test('serves a known slug publicly with no auth (200)', async () => {
    const res = await request(app).get('/blog/why-i-built-squire-docs');
    expect(res.status).toBe(200);
    expect(res.text).toContain('WHY POST');
  });

  test('/blog/index permanently redirects to /blog (301)', async () => {
    const res = await request(app).get('/blog/index');
    expect(res.status).toBe(301);
    expect(res.headers.location).toBe('/blog');
  });

  test('trailing slash on the index redirects to /blog (301)', async () => {
    const res = await request(app).get('/blog/');
    expect(res.status).toBe(301);
    expect(res.headers.location).toBe('/blog');
  });

  test('trailing slash on a slug redirects to the canonical slug (301)', async () => {
    const res = await request(app).get('/blog/sharing-specs-with-product-managers/');
    expect(res.status).toBe(301);
    expect(res.headers.location).toBe('/blog/sharing-specs-with-product-managers');
  });

  test('unknown slug returns a styled 404 linking to the index, not the app shell', async () => {
    const res = await request(app).get('/blog/no-such-post');
    expect(res.status).toBe(404);
    expect(res.text).toContain('href="/blog"');
    expect(res.text).not.toContain(APP_SHELL);
  });

  test('nested path returns a styled 404, not the app shell', async () => {
    const res = await request(app).get('/blog/a/b');
    expect(res.status).toBe(404);
    expect(res.text).toContain('href="/blog"');
    expect(res.text).not.toContain(APP_SHELL);
  });

  test('a traversal-shaped path selects nothing outside the fixture dir', async () => {
    const res = await request(app).get('/blog/%2e%2e%2f%2e%2e%2fsecret');
    expect(res.status).toBe(404);
    expect(res.text).not.toContain(SECRET);
    expect(res.text).not.toContain(APP_SHELL);
  });

  test('a bare unknown segment matching a filename outside the set cannot be served', async () => {
    const res = await request(app).get('/blog/secret');
    expect(res.status).toBe(404);
    expect(res.text).not.toContain(SECRET);
  });
});
