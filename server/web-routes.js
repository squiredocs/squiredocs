/**
 * Web routes: CSP directives, the old-domain redirect, marketing and legal
 * pages, the blog, documentation, static files, /agents.md, and the
 * application shell (feature 058, research R9/R10, RBD-058-5/-6/-27).
 *
 * Mounted by server/index.js and by the tests, so both exercise this one
 * implementation. Hosted (SQUIRE_HOSTED=true) mounts exactly the routes the
 * hosted service always had, in the same order; the only change there is that
 * the shell (index.html) is now served with the injected instance flag and
 * Google tag instead of the raw file. Not hosted mounts documentation, a 404
 * for every hosted-only path (and its static-file variant), an /agents.md that
 * names this instance instead of squiredocs.com, static files, and the shell.
 */
const path = require('path');
const fs = require('fs');
const express = require('express');
const { getInstanceConfig } = require('./instance-config');
const { renderAppShell } = require('./app-shell');
const { buildBaseUrl } = require('./url');
const { mountDocumentationRoutes } = require('./documentation-routes');
const { mountBlogRoutes } = require('./blog-routes');

const HOSTED_ORIGIN = 'https://squiredocs.com';

const GOOGLE_SCRIPT_SRC = ['https://www.googletagmanager.com', 'https://googleads.g.doubleclick.net', 'https://www.googleadservices.com'];
const GOOGLE_IMG_SRC = ['https://www.googletagmanager.com', 'https://googleads.g.doubleclick.net', 'https://www.google.com', 'https://*.gstatic.com'];
const GOOGLE_CONNECT_SRC = ['https://www.google-analytics.com', 'https://*.google-analytics.com', 'https://*.analytics.google.com', 'https://www.google.com', 'https://googleads.g.doubleclick.net'];

/**
 * helmet CSP directives. Hosted: byte-identical to the pre-058 policy. Not
 * hosted: no Google Tag Manager / Ads / Analytics source anywhere. img-src
 * carries the image storage origin only for the S3 driver (the local driver's
 * raw routes are same-origin).
 * @param {{ hosted: boolean, storage: { cspImageSources(): string[] } }} opts
 */
function buildCspDirectives({ hosted, storage }) {
  const g = (list) => (hosted ? list : []);
  return {
    defaultSrc: ["'self'"],
    scriptSrc: ["'self'", "'unsafe-inline'", "'unsafe-eval'", ...g(GOOGLE_SCRIPT_SRC)],
    styleSrc: ["'self'", "'unsafe-inline'"],
    // Image storage origin(s) so the browser can load presigned document-image URLs.
    imgSrc: ["'self'", 'data:', 'https://*.googleusercontent.com', ...g(GOOGLE_IMG_SRC), ...storage.cspImageSources()],
    connectSrc: ["'self'", 'ws:', 'wss:', ...g(GOOGLE_CONNECT_SRC)],
    fontSrc: ["'self'"],
    objectSrc: ["'none'"],
    frameAncestors: ["'none'"],
  };
}

/**
 * Redirect the retired domains to squiredocs.com. Hosted only (FR-029): a
 * self-hosted instance never redirects anywhere. Evaluated per request.
 */
function oldDomainRedirect(req, res, next) {
  if (!getInstanceConfig().hosted) return next();
  const host = req.get('host');
  if (host === 'herodocs.xyz' || host === 'heradocs.com') {
    return res.redirect(301, `${HOSTED_ORIGIN}${req.originalUrl}`);
  }
  next();
}

/** express.static headers, unchanged from the pre-058 inline block. */
function staticSetHeaders(clientBuildPath) {
  return (res, filePath) => {
    // marketing.css is render-blocking for the static marketing pages and
    // isn't fingerprinted; a short TTL avoids a revalidation round trip on
    // every page view without pinning stale styles for long after a deploy.
    if (filePath.endsWith('marketing.css')) {
      res.setHeader('Cache-Control', 'public, max-age=300');
    }
    // Root-level blog assets (blog.css, blog-*.svg — exactly what the /blog*
    // CloudFront path pattern matches) and the self-hosted /vendor/* bundles
    // are static, edge-cached, and invalidated on every hosted deploy. Mirror the blog HTML's header (blog-routes.js):
    // cache hard at the shared edge, short browser max-age so a deploy's
    // edge invalidation actually reaches readers.
    const rel = path.relative(clientBuildPath, filePath);
    if (
      (rel.startsWith('blog') && !rel.includes(path.sep)) ||
      rel.startsWith(`vendor${path.sep}`)
    ) {
      res.setHeader('Cache-Control', 'public, max-age=3600, s-maxage=31536000');
    }
  };
}

/** Paths that exist only on the hosted service (404 when not hosted). */
const HOSTED_ONLY_EXACT = new Set([
  '/pricing', '/about', '/security', '/privacy', '/terms', '/blog',
  '/landing.html', '/pricing.html', '/about.html', '/security.html',
]);

function isHostedOnlyPath(p) {
  const lower = p.toLowerCase().replace(/\/+$/, '') || '/';
  if (HOSTED_ONLY_EXACT.has(lower)) return true;
  if (lower.startsWith('/blog/')) return true;
  // Root-level blog assets (blog.css, blog-*.svg).
  if (/^\/blog[^/]*$/.test(lower)) return true;
  return false;
}

/** The repository root: the same relative layout in development and in /app. */
const REPO_ROOT = path.join(__dirname, '..');

/**
 * The self-host runbook and install script, served verbatim on every instance
 * (feature 060, FR-013, FR-021, RBD-060-2, contracts/served-routes.md). Both
 * files are read once at mount; a missing file leaves its route unmounted.
 * No substitution, no input: the bytes are the repository's.
 * @param {import('express').Express} app
 * @param {{ repoRoot?: string }} [opts]
 */
function mountDistributionRoutes(app, { repoRoot = REPO_ROOT } = {}) {
  const routes = [
    ['/self-host.md', 'AGENTS.md', 'text/markdown; charset=utf-8'],
    ['/install.sh', path.join('distribution', 'self-host', 'install.sh'), 'text/x-shellscript; charset=utf-8'],
  ];
  for (const [route, rel, type] of routes) {
    const file = path.join(repoRoot, rel);
    if (!fs.existsSync(file)) continue;
    const body = fs.readFileSync(file);
    app.get(route, (req, res) => {
      res.set('Content-Type', type);
      res.set('Cache-Control', 'public, max-age=300');
      res.send(body);
    });
  }
}

/** The sentinel the self-hosted documentation variant uses for this instance's origin. */
const ORIGIN_SENTINEL = '__SQUIRE_ORIGIN__';

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * The origin to show in self-hosted documentation pages. A configured origin
 * (APP_URL or CLIENT_URL) always wins, so a caching reverse proxy in front of
 * the instance can never store a page carrying a client-chosen Host (review
 * finding M5, RBD-060-39). Only on the localhost default is the request's own
 * origin used (as /agents.md does), and only when it parses as a plain http(s)
 * origin. HTML-escaped either way (research R11, Constitution V).
 */
function safeOrigin(req) {
  const { appUrl, appUrlSource } = getInstanceConfig();
  let origin = null;
  if (appUrlSource === 'default') {
    try {
      const candidate = buildBaseUrl(req);
      const u = new URL(candidate);
      // The URL parser accepts quotes and other markup in a host; a real host is
      // a DNS name or IP literal with an optional port.
      const plainHost = /^(?:[a-z0-9.-]+|\[[0-9a-f:.]+\])(?::\d{1,5})?$/.test(u.host);
      if ((u.protocol === 'http:' || u.protocol === 'https:') && plainHost && u.origin === candidate) origin = candidate;
    } catch {
      origin = null;
    }
  }
  if (!origin) origin = new URL(appUrl).origin;
  return escapeHtml(origin);
}

/**
 * Mount the web routes on `app`. Reads the client shell once.
 * @param {import('express').Express} app
 * @param {{ clientBuildPath: string, repoRoot?: string, storage?: object }} opts
 */
function mountWebRoutes(app, { clientBuildPath, repoRoot = REPO_ROOT }) {
  // Before the client-build check and the hosted split: every instance kind,
  // with or without a client build, serves these two files identically.
  mountDistributionRoutes(app, { repoRoot });

  const indexPath = path.join(clientBuildPath, 'index.html');
  if (!fs.existsSync(clientBuildPath) || !fs.existsSync(indexPath)) {
    // In development, serve a message if frontend isn't built
    app.get('*', (req, res) => {
      res.send(`
      <html>
        <body>
          <h1>Server is running</h1>
          <p>Please build the client first: <code>cd client && npm run build</code></p>
          <p>Or run in development mode: <code>npm run dev</code></p>
        </body>
      </html>
    `);
    });
    return;
  }

  const { hosted } = getInstanceConfig();
  const shellHtml = renderAppShell(fs.readFileSync(indexPath, 'utf8'), { hosted });
  const sendShell = (req, res) => {
    res.set('Content-Type', 'text/html; charset=utf-8');
    res.set('Cache-Control', 'public, max-age=0');
    res.send(shellHtml);
  };
  const staticFiles = express.static(clientBuildPath, {
    // No directory index: `/` and `/index.html` are the injected shell, so no
    // path ever serves the raw index.html.
    index: false,
    setHeaders: staticSetHeaders(clientBuildPath),
  });

  if (hosted) {
    // Serve static marketing pages (matches Vite dev plugin behavior)
    app.get('/', (req, res) => {
      res.sendFile(path.join(clientBuildPath, 'landing.html'));
    });

    app.get('/pricing', (req, res) => {
      res.sendFile(path.join(clientBuildPath, 'pricing.html'));
    });

    app.get('/about', (req, res) => {
      res.sendFile(path.join(clientBuildPath, 'about.html'));
    });

    app.get('/security', (req, res) => {
      res.sendFile(path.join(clientBuildPath, 'security.html'));
    });

    // Serve the product documentation site (feature 007). Mounted BEFORE
    // express.static: the static middleware treats dist/documentation as a
    // directory and would 301 the canonical /documentation to /documentation/
    // (and serve the trailing-slash form directly), inverting the D1/D2
    // redirects. Mounted before the app-shell catch-all so an unknown slug
    // returns a styled 404 instead of falling through to the app (FR-016).
    // Reads the generated files once at mount time; a missing directory is
    // handled without crashing (Edge Cases).
    mountDocumentationRoutes(app, path.join(clientBuildPath, 'documentation'));

    // Serve the static blog. Mounted BEFORE express.static (same reasoning as the
    // documentation routes: the static middleware would 301 the canonical /blog to
    // /blog/ and invert the redirects) and before the app-shell catch-all so an
    // unknown slug returns a styled 404 instead of falling through to the app.
    mountBlogRoutes(app, path.join(clientBuildPath, 'blog'));

    app.get('/index.html', sendShell);
    // /agents.md is served verbatim by the static middleware.
    app.use(staticFiles);

    // Serve React app for all other routes
    app.get('*', sendShell);
    return;
  }

  // ── Not hosted ──────────────────────────────────────────────────────────
  // The self-hosted documentation variant (feature 060, FR-030 to FR-032):
  // no analytics, no canonical URL, filtered header and footer, and instance
  // URLs carrying a sentinel that becomes this instance's origin per request.
  // The _self-hosted directory is never addressable by URL: nested paths under
  // /documentation are the documentation 404 on both instance kinds.
  mountDocumentationRoutes(app, path.join(clientBuildPath, 'documentation', '_self-hosted'), {
    transformHtml: (html, req) => html.split(ORIGIN_SENTINEL).join(safeOrigin(req)),
  });

  app.use((req, res, next) => {
    if ((req.method === 'GET' || req.method === 'HEAD') && isHostedOnlyPath(req.path)) {
      return res.status(404).type('text/plain').send('Not found');
    }
    next();
  });

  // /agents.md names this instance, not the hosted service (FR-035). The file
  // in the repository keeps the hosted URLs (the drift guard test reads it).
  const agentsPath = path.join(clientBuildPath, 'agents.md');
  const agentsMd = fs.existsSync(agentsPath) ? fs.readFileSync(agentsPath, 'utf8') : null;
  if (agentsMd !== null) {
    app.get('/agents.md', (req, res) => {
      res.set('Content-Type', 'text/markdown; charset=utf-8');
      res.send(agentsMd.split(HOSTED_ORIGIN).join(buildBaseUrl(req)));
    });
  }

  app.get(['/', '/index.html'], sendShell);
  app.use(staticFiles);
  app.get('*', sendShell);
}

module.exports = {
  buildCspDirectives, oldDomainRedirect, mountWebRoutes, mountDistributionRoutes, isHostedOnlyPath, safeOrigin,
  HOSTED_ORIGIN, ORIGIN_SENTINEL,
};
