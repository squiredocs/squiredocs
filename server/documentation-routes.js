/**
 * documentation-routes.js — public serving for the product documentation site
 * (feature 007).
 *
 * mountDocumentationRoutes(app, docsDistDir) registers the /documentation routes
 * on an existing Express app. It reads docsDistDir once at mount time and builds
 * a Set of known slugs from the <slug>.html files (excluding index.html and
 * 404.html). Requests select a fixed <slug>.html filename from that Set only, so
 * caller input is never concatenated into a filesystem path: path traversal is
 * closed by construction (FR-017, D4).
 *
 * No markdown parsing, no template rendering, no authentication, no database,
 * and no new runtime dependency (express is already used by the server). This
 * mounts before the app.get('*') app-shell catch-all so an unknown slug returns
 * a styled 404 instead of falling through to the app (FR-016).
 *
 * Contract: specs/007-documentation-site/contracts/documentation-routes.md.
 */
const express = require('express');
const fs = require('fs');
const path = require('path');

/**
 * Read the known slug set from a built documentation directory.
 * Excludes index.html and 404.html. Missing directory -> empty set.
 */
function readKnownSlugs(docsDistDir) {
  const slugs = new Set();
  let entries;
  try {
    entries = fs.readdirSync(docsDistDir);
  } catch {
    return slugs; // directory absent: empty set, routes still respond
  }
  for (const name of entries) {
    if (!name.endsWith('.html')) continue;
    if (name === 'index.html' || name === '404.html') continue;
    slugs.add(name.slice(0, -'.html'.length));
  }
  return slugs;
}

/**
 * Mount the documentation routes on `app`. `docsDistDir` is the directory of
 * generated documentation HTML (client/dist/documentation).
 *
 * Without `transformHtml` (the hosted service) files are sent with sendFile,
 * unchanged. With it (feature 060, self-hosted instances), every page is read
 * once at mount into memory and sent as `transformHtml(html, req)`, which
 * fills in the request's origin (contracts/served-routes.md). Routing is the
 * same either way.
 * @param {import('express').Express} app
 * @param {string} docsDistDir
 * @param {{ transformHtml?: (html: string, req: import('express').Request) => string }} [opts]
 */
function mountDocumentationRoutes(app, docsDistDir, { transformHtml } = {}) {
  const knownSlugs = readKnownSlugs(docsDistDir);

  let cache = null;
  if (transformHtml) {
    cache = new Map();
    for (const name of [...knownSlugs].map((s) => `${s}.html`).concat(['index.html', '404.html'])) {
      const filePath = path.join(docsDistDir, name);
      if (fs.existsSync(filePath)) cache.set(name, fs.readFileSync(filePath, 'utf8'));
    }
  }

  // Serve a built file, or a plain 404 if the file is absent (e.g. the
  // documentation was never built).
  const sendFileOr404 = (req, res, fileName, status = 200) => {
    if (cache) {
      const html = cache.get(fileName);
      if (html === undefined) {
        res.status(404).type('html').send('<h1>Not found</h1>');
        return;
      }
      res.status(status).set('Content-Type', 'text/html; charset=utf-8').send(transformHtml(html, req));
      return;
    }
    const filePath = path.join(docsDistDir, fileName);
    if (!fs.existsSync(filePath)) {
      res.status(404).type('html').send('<h1>Not found</h1>');
      return;
    }
    res.status(status).sendFile(filePath);
  };

  const send404 = (req, res) => sendFileOr404(req, res, '404.html', 404);

  // A strict router so /documentation and /documentation/ are distinct and can
  // be handled differently (serve vs. permanent redirect), matching the route
  // contract. Case-sensitive so /Documentation is not served here and falls
  // through to the app shell, exactly as it does in dev (route contract: dev
  // and prod must not diverge). The app's own routing settings are left
  // untouched.
  const router = express.Router({ strict: true, caseSensitive: true });

  // GET /documentation -> index.html
  router.get('/documentation', (req, res) => {
    sendFileOr404(req, res, 'index.html');
  });

  // GET /documentation/ (trailing slash) -> 301 /documentation (D2)
  router.get('/documentation/', (req, res) => {
    res.redirect(301, '/documentation');
  });

  // GET /documentation/:slug
  router.get('/documentation/:slug', (req, res) => {
    const { slug } = req.params;
    if (slug === 'index') {
      // /documentation/index canonicalizes to /documentation (D1)
      res.redirect(301, '/documentation');
      return;
    }
    if (knownSlugs.has(slug)) {
      sendFileOr404(req, res, `${slug}.html`);
      return;
    }
    send404(req, res);
  });

  // GET /documentation/:slug/ (trailing slash) -> 301 /documentation/:slug (D2)
  router.get('/documentation/:slug/', (req, res) => {
    const { slug } = req.params;
    if (slug === 'index') {
      res.redirect(301, '/documentation');
      return;
    }
    res.redirect(301, `/documentation/${slug}`);
  });

  // GET /documentation/* (nested or traversal-shaped paths) -> 404 (D4, FR-017)
  router.get('/documentation/*', (req, res) => {
    send404(req, res);
  });

  app.use(router);
}

module.exports = { mountDocumentationRoutes, readKnownSlugs };
