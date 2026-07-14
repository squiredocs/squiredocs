/**
 * Route tests for the product documentation site (feature 007, US1 / T023).
 *
 * mountDocumentationRoutes is mounted on a bare Express app pointed at a fixture
 * directory of a few fake built pages plus a 404.html, so the test is hermetic
 * and needs no full client build and no database. A sentinel app.get('*') stands
 * in for the app-shell catch-all so we can prove the documentation routes run
 * before it and an unknown slug never falls through (FR-016, SC-003).
 *
 * Contract: specs/007-documentation-site/contracts/documentation-routes.md.
 */
const request = require('supertest');
const express = require('express');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { mountDocumentationRoutes } = require('../documentation-routes');

const APP_SHELL = 'THE-APP-SHELL-SENTINEL';
const SECRET = 'TOP-SECRET-OUTSIDE-DOCS';

let tmpRoot;
let docsDistDir;
let app;

beforeAll(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'doc-routes-'));
  docsDistDir = path.join(tmpRoot, 'documentation');
  fs.mkdirSync(docsDistDir, { recursive: true });

  // A file OUTSIDE the documentation dir that a traversal attempt must never reach.
  fs.writeFileSync(path.join(tmpRoot, 'secret.html'), `<html>${SECRET}</html>`);

  // Fixture built pages.
  fs.writeFileSync(path.join(docsDistDir, 'index.html'), '<html><body>INDEX PAGE</body></html>');
  fs.writeFileSync(path.join(docsDistDir, 'getting-started.html'), '<html><body>GETTING STARTED PAGE</body></html>');
  fs.writeFileSync(path.join(docsDistDir, 'editing.html'), '<html><body>EDITING PAGE</body></html>');
  fs.writeFileSync(
    path.join(docsDistDir, '404.html'),
    '<html><body>Not found. <a href="/documentation">Go to the documentation index</a>.</body></html>'
  );

  app = express();
  mountDocumentationRoutes(app, docsDistDir);
  // Stand-in for the app-shell catch-all; documentation routes must win first.
  app.get('*', (req, res) => res.status(200).send(APP_SHELL));
});

afterAll(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

describe('documentation routes', () => {
  test('serves the index publicly with no auth (200)', async () => {
    const res = await request(app).get('/documentation');
    expect(res.status).toBe(200);
    expect(res.text).toContain('INDEX PAGE');
  });

  test('serves a known slug publicly with no auth (200)', async () => {
    const res = await request(app).get('/documentation/getting-started');
    expect(res.status).toBe(200);
    expect(res.text).toContain('GETTING STARTED PAGE');
  });

  test('/documentation/index permanently redirects to /documentation (301, SC-001)', async () => {
    const res = await request(app).get('/documentation/index');
    expect(res.status).toBe(301);
    expect(res.headers.location).toBe('/documentation');
  });

  test('trailing slash on the index redirects to /documentation (301)', async () => {
    const res = await request(app).get('/documentation/');
    expect(res.status).toBe(301);
    expect(res.headers.location).toBe('/documentation');
  });

  test('trailing slash on a slug redirects to the canonical slug (301)', async () => {
    const res = await request(app).get('/documentation/editing/');
    expect(res.status).toBe(301);
    expect(res.headers.location).toBe('/documentation/editing');
  });

  test('unknown slug returns a styled 404 linking to the index, not the app shell (SC-003)', async () => {
    const res = await request(app).get('/documentation/no-such-page');
    expect(res.status).toBe(404);
    expect(res.text).toContain('href="/documentation"');
    expect(res.text).not.toContain(APP_SHELL);
  });

  test('nested path returns a styled 404, not the app shell', async () => {
    const res = await request(app).get('/documentation/a/b');
    expect(res.status).toBe(404);
    expect(res.text).toContain('href="/documentation"');
    expect(res.text).not.toContain(APP_SHELL);
  });

  test('a traversal-shaped path selects nothing outside the fixture dir (FR-017)', async () => {
    const res = await request(app).get('/documentation/%2e%2e%2f%2e%2e%2fsecret');
    expect(res.status).toBe(404);
    expect(res.text).not.toContain(SECRET);
    expect(res.text).not.toContain(APP_SHELL);
  });

  test('a bare unknown segment matching a filename outside the set cannot be served', async () => {
    // "secret" (the file one level up) is not in the known-slug set, so even by
    // name it resolves to the styled 404, never the file's contents.
    const res = await request(app).get('/documentation/secret');
    expect(res.status).toBe(404);
    expect(res.text).not.toContain(SECRET);
  });
});
