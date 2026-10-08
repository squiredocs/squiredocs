/**
 * blog-routes.js — public serving for the static blog.
 *
 * mountBlogRoutes(app, blogDistDir) registers the /blog routes on an existing
 * Express app. It reads blogDistDir once at mount time and builds a Set of known
 * slugs from the <slug>.html files (excluding index.html and 404.html).
 * Requests select a fixed <slug>.html filename from that Set only, so caller
 * input is never concatenated into a filesystem path: path traversal is closed
 * by construction.
 *
 * No markdown parsing, no template rendering, no authentication, no database.
 * Mounted before the app.get('*') app-shell catch-all so an unknown slug returns
 * a styled 404 instead of falling through to the app.
 *
 * Patterned on documentation-routes.js.
 */
const express = require('express');
const fs = require('fs');
const path = require('path');

/**
 * Read the known slug set from a built blog directory.
 * Excludes index.html and 404.html. Missing directory -> empty set.
 */
function readKnownSlugs(blogDistDir) {
  const slugs = new Set();
  let entries;
  try {
    entries = fs.readdirSync(blogDistDir);
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
 * Mount the blog routes on `app`. `blogDistDir` is the directory of generated
 * blog HTML (client/dist/blog).
 */
function mountBlogRoutes(app, blogDistDir) {
  const knownSlugs = readKnownSlugs(blogDistDir);

  // Serve a built file, or a plain 404 if the file is absent (e.g. the blog was
  // never built).
  const sendFileOr404 = (res, fileName, status = 200) => {
    const filePath = path.join(blogDistDir, fileName);
    if (!fs.existsSync(filePath)) {
      res.status(404).type('html').send('<h1>Not found</h1>');
      return;
    }
    if (status === 200) {
      // Blog pages are static, identical for every visitor, and rebuilt on every
      // deploy (which invalidates /blog* at the edge on the hosted service). Cache
      // hard at the shared CloudFront edge via a long s-maxage (honored by the
      // hosted edge's Managed-CachingOptimized behavior), while keeping the browser
      // max-age short so a deploy's edge invalidation actually reaches readers —
      // invalidation clears the edge, not already-cached browsers.
      res.setHeader('Cache-Control', 'public, max-age=3600, s-maxage=31536000');
    }
    res.status(status).sendFile(filePath);
  };

  const send404 = (res) => sendFileOr404(res, '404.html', 404);

  // Strict, case-sensitive router so /blog and /blog/ are distinct and can be
  // handled differently (serve vs. permanent redirect), matching how the
  // documentation routes behave. The app's own routing settings are untouched.
  const router = express.Router({ strict: true, caseSensitive: true });

  // GET /blog -> index.html
  router.get('/blog', (req, res) => {
    sendFileOr404(res, 'index.html');
  });

  // GET /blog/ (trailing slash) -> 301 /blog
  router.get('/blog/', (req, res) => {
    res.redirect(301, '/blog');
  });

  // GET /blog/:slug
  router.get('/blog/:slug', (req, res) => {
    const { slug } = req.params;
    if (slug === 'index') {
      // /blog/index canonicalizes to /blog
      res.redirect(301, '/blog');
      return;
    }
    if (knownSlugs.has(slug)) {
      sendFileOr404(res, `${slug}.html`);
      return;
    }
    send404(res);
  });

  // GET /blog/:slug/ (trailing slash) -> 301 /blog/:slug
  router.get('/blog/:slug/', (req, res) => {
    const { slug } = req.params;
    if (slug === 'index') {
      res.redirect(301, '/blog');
      return;
    }
    res.redirect(301, `/blog/${slug}`);
  });

  // GET /blog/* (nested or traversal-shaped paths) -> 404
  router.get('/blog/*', (req, res) => {
    send404(res);
  });

  app.use(router);
}

module.exports = { mountBlogRoutes, readKnownSlugs };
