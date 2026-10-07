import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import fs from 'fs';
import path from 'path';
import { createRequire } from 'module';
import {
  parseFrontmatter,
  renderBody,
  renderPage,
  render404,
} from './scripts/render-documentation.mjs';
import {
  parseFrontmatter as parseBlogFrontmatter,
  renderBody as renderBlogBody,
  renderPostPage as renderBlogPostPage,
  renderIndexPage as renderBlogIndexPage,
  render404 as renderBlog404,
} from './scripts/render-blog.mjs';

// Feature 058 (RBD-058-28): the dev server mirrors the server's hosted gating.
// SQUIRE_HOSTED comes from the dev pod's environment (the app-dev pod sets it
// to "true", so development keeps looking like the hosted service). Unset it to
// see the self-hosted shell: no marketing or blog pages, no analytics tag.
const SQUIRE_HOSTED = String(process.env.SQUIRE_HOSTED || '').toLowerCase() === 'true';

// Inject the same instance flag (and, hosted only, the Google tag) the server
// injects into the built shell. Dev only: the built dist/index.html must stay
// un-injected, because the server renders it per instance at mount.
function appShellPlugin() {
  const require = createRequire(import.meta.url);
  const { renderAppShell } = require('../server/app-shell.js');
  return {
    name: 'squire-app-shell',
    apply: 'serve',
    transformIndexHtml(html) {
      return renderAppShell(html, { hosted: SQUIRE_HOSTED });
    },
  };
}

// Serve static marketing pages in dev mode (matches Express production behavior)
const STATIC_PAGES = {
  '/': 'landing.html',
  '/index.html': 'landing.html',
  '/pricing': 'pricing.html',
  '/about': 'about.html',
  '/security': 'security.html',
};

function staticPagesPlugin() {
  return {
    name: 'serve-static-pages',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const pathname = req.url.split('?')[0];
        const page = STATIC_PAGES[pathname];
        if (page) {
          const pagePath = path.resolve(__dirname, 'public', page);
          if (fs.existsSync(pagePath)) {
            res.setHeader('Content-Type', 'text/html');
            res.end(fs.readFileSync(pagePath, 'utf-8'));
            return;
          }
        }
        next();
      });
    }
  };
}

// Serve the product documentation pages in dev by rendering the markdown
// sources on request (feature 007, FR-019). This mirrors production routing:
// same index redirect, trailing-slash redirect, unknown-slug 404, and
// nested-path 404, but rendered fresh from documentation/*.md so a content edit
// shows on browser refresh with no build (SC-005). Reuses the exact render
// module the build uses, so dev and build cannot diverge.
function documentationPagesPlugin() {
  const DOCS_SRC_DIR = path.resolve(__dirname, '../documentation');

  function loadPages() {
    const files = fs
      .readdirSync(DOCS_SRC_DIR)
      .filter((f) => f.endsWith('.md'))
      .sort();
    return files.map((name) => {
      const text = fs.readFileSync(path.join(DOCS_SRC_DIR, name), 'utf-8');
      const { frontmatter, body, error } = parseFrontmatter(text);
      return { name, frontmatter, body, error };
    });
  }

  return {
    name: 'serve-documentation-pages',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const pathname = req.url.split('?')[0];
        if (pathname !== '/documentation' && !pathname.startsWith('/documentation/')) {
          return next();
        }

        const redirect = (location) => {
          res.statusCode = 301;
          res.setHeader('Location', location);
          res.end();
        };

        let pages;
        try {
          pages = loadPages();
        } catch (err) {
          res.statusCode = 500;
          res.setHeader('Content-Type', 'text/plain');
          res.end(`Documentation source error: ${err.message}`);
          return;
        }
        const valid = pages.filter((p) => !p.error && p.frontmatter && p.frontmatter.slug);
        const allPages = valid.map((p) => ({
          slug: p.frontmatter.slug,
          title: p.frontmatter.title,
          order: p.frontmatter.order,
        }));
        const bySlug = new Map(valid.map((p) => [p.frontmatter.slug, p]));

        const send404 = () => {
          res.statusCode = 404;
          res.setHeader('Content-Type', 'text/html');
          res.end(render404({ allPages }));
        };

        const servePage = (page) => {
          if (page.error) {
            res.statusCode = 500;
            res.setHeader('Content-Type', 'text/plain');
            res.end(`Documentation page "${page.name}" is invalid: ${page.error}`);
            return;
          }
          res.setHeader('Content-Type', 'text/html');
          res.end(
            renderPage({
              page: {
                slug: page.frontmatter.slug,
                title: page.frontmatter.title,
                description: page.frontmatter.description,
                bodyHtml: renderBody(page.body),
              },
              allPages,
            })
          );
        };

        // GET /documentation -> the index page.
        if (pathname === '/documentation') {
          const index = bySlug.get('index') || pages.find((p) => p.name === 'index.md');
          if (!index) return send404();
          return servePage(index);
        }

        // pathname starts with '/documentation/'.
        const rest = pathname.slice('/documentation/'.length);
        if (rest === '') {
          // '/documentation/' -> 301 /documentation
          return redirect('/documentation');
        }
        if (rest.includes('/')) {
          const parts = rest.split('/');
          if (parts.length === 2 && parts[1] === '') {
            // '/documentation/<slug>/' -> 301 /documentation/<slug>
            return parts[0] === 'index'
              ? redirect('/documentation')
              : redirect(`/documentation/${parts[0]}`);
          }
          // nested path -> 404
          return send404();
        }
        if (rest === 'index') {
          // '/documentation/index' -> 301 /documentation
          return redirect('/documentation');
        }
        const page = bySlug.get(rest);
        if (!page) return send404();
        return servePage(page);
      });
    },
  };
}

// Serve the static blog in dev by rendering blog/*.md on request. Mirrors
// production routing (index, trailing-slash redirect, unknown-slug and
// nested-path 404) and reuses the exact render module the build uses, so a
// content edit shows on browser refresh with no build and dev cannot diverge
// from production.
function blogPagesPlugin() {
  const BLOG_SRC_DIR = path.resolve(__dirname, '../blog');

  function loadPosts() {
    const files = fs
      .readdirSync(BLOG_SRC_DIR)
      .filter((f) => f.endsWith('.md'))
      .sort();
    return files.map((name) => {
      const text = fs.readFileSync(path.join(BLOG_SRC_DIR, name), 'utf-8');
      const { frontmatter, body, error } = parseBlogFrontmatter(text);
      return { name, frontmatter, body, error };
    });
  }

  return {
    name: 'serve-blog-pages',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const pathname = req.url.split('?')[0];
        if (pathname !== '/blog' && !pathname.startsWith('/blog/')) {
          return next();
        }

        const redirect = (location) => {
          res.statusCode = 301;
          res.setHeader('Location', location);
          res.end();
        };

        let posts;
        try {
          posts = loadPosts();
        } catch (err) {
          res.statusCode = 500;
          res.setHeader('Content-Type', 'text/plain');
          res.end(`Blog source error: ${err.message}`);
          return;
        }
        const valid = posts.filter((p) => !p.error && p.frontmatter && p.frontmatter.slug);
        const summaries = valid.map((p) => ({
          slug: p.frontmatter.slug,
          title: p.frontmatter.title,
          description: p.frontmatter.description,
          date: p.frontmatter.date,
          author: p.frontmatter.author,
        }));
        const bySlug = new Map(valid.map((p) => [p.frontmatter.slug, p]));

        const send404 = () => {
          res.statusCode = 404;
          res.setHeader('Content-Type', 'text/html');
          res.end(renderBlog404({}));
        };

        const servePost = (post) => {
          res.setHeader('Content-Type', 'text/html');
          res.end(
            renderBlogPostPage({
              post: {
                slug: post.frontmatter.slug,
                title: post.frontmatter.title,
                description: post.frontmatter.description,
                date: post.frontmatter.date,
                author: post.frontmatter.author,
                bodyHtml: renderBlogBody(post.body),
              },
            })
          );
        };

        // GET /blog -> the index page.
        if (pathname === '/blog') {
          res.setHeader('Content-Type', 'text/html');
          res.end(renderBlogIndexPage({ posts: summaries }));
          return;
        }

        // pathname starts with '/blog/'.
        const rest = pathname.slice('/blog/'.length);
        if (rest === '') {
          return redirect('/blog');
        }
        if (rest.includes('/')) {
          const parts = rest.split('/');
          if (parts.length === 2 && parts[1] === '') {
            return parts[0] === 'index'
              ? redirect('/blog')
              : redirect(`/blog/${parts[0]}`);
          }
          return send404();
        }
        if (rest === 'index') {
          return redirect('/blog');
        }
        const post = bySlug.get(rest);
        if (!post) return send404();
        return servePost(post);
      });
    },
  };
}

export default defineConfig({
  plugins: [
    // Marketing pages and the blog exist only on the hosted service.
    ...(SQUIRE_HOSTED ? [staticPagesPlugin()] : []),
    documentationPagesPlugin(),
    ...(SQUIRE_HOSTED ? [blogPagesPlugin()] : []),
    appShellPlugin(),
    react(),
  ],
  server: {
    host: process.env.VITE_HOST || '0.0.0.0',
    port: 5173,
    strictPort: false,
    // HMR disabled - doesn't work reliably through k8s tunnel
    // Manual refresh required after code changes
    hmr: false,
    // Client source imports from ../shared (svg-sanitizer), which sits outside
    // the Vite root; without this the dev server refuses to serve it.
    fs: {
      allow: ['..'],
    },
    proxy: {
      '^/s($|/)': {
        target: 'ws://localhost:3001',
        ws: true,
        changeOrigin: true
      },
      '/api': {
        target: 'http://localhost:3001',
        changeOrigin: true
      },
      '^/auth/': {
        target: 'http://localhost:3001',
        changeOrigin: true
      },
      '/mcp': {
        target: 'http://localhost:3001',
        changeOrigin: true
      },
      '/oauth-callback': {
        target: 'http://localhost:3001',
        changeOrigin: true
      },
      // Feature 060: the self-host runbook and install script, served verbatim
      // by the backend on every instance.
      '^/(self-host\\.md|install\\.sh)$': {
        target: 'http://localhost:3001',
        changeOrigin: true
      }
    }
  },
  build: {
    outDir: 'dist',
    rollupOptions: {
      output: {
        manualChunks: {
          mermaid: ['mermaid'],
        },
      },
    },
  },
});

