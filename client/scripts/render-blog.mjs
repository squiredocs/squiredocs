/**
 * render-blog.mjs — the pure render library for the static blog.
 *
 * Mirrors render-documentation.mjs: no side effects, so a post renders
 * identically at build time and in any test. It parses post frontmatter,
 * validates the post set, renders markdown bodies to HTML, and wraps each post
 * (and the index) in a template that reuses the marketing header/footer chrome
 * and the documentation prose styles.
 *
 * The blog is intentionally simple: static markdown at the repo root under
 * blog/ is parsed only here, at build time, and written to
 * client/dist/blog/<slug>.html plus index.html and 404.html. There is no
 * database, no runtime markdown parsing, and no new server dependency.
 *
 * Exports:
 *   parseFrontmatter(text)          -> { frontmatter, body, error }
 *   validatePosts(posts)            -> string[] (errors; empty = OK)
 *   sortPosts(posts)                -> posts sorted newest-first
 *   renderBody(markdown)            -> HTML string (html:false)
 *   renderPostPage({ post })        -> full HTML document
 *   renderIndexPage({ posts })      -> full HTML index document
 *   render404({})                   -> full 404 HTML document
 *   formatDate(iso)                 -> "July 19, 2026"
 */
import MarkdownIt from 'markdown-it';

export const CANONICAL_ORIGIN = 'https://squiredocs.com';

// The five allowed frontmatter keys. `date` is an ISO date (YYYY-MM-DD).
const REQUIRED_FIELDS = ['slug', 'title', 'description', 'date', 'author'];
const SLUG_RE = /^[a-z0-9-]+$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

const MONTHS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

// --- Frontmatter parsing -----------------------------------------------------

/**
 * Parse a post file's YAML-ish frontmatter. Strict and scalar-only: the file
 * must open with a `---` fence, contain only the known keys, each a single-line
 * scalar. Returns { frontmatter, body, error }.
 */
export function parseFrontmatter(text) {
  const frontmatter = {};
  const normalized = String(text).replace(/^﻿/, '');
  const lines = normalized.split(/\r?\n/);

  if (lines[0].trim() !== '---') {
    return { frontmatter, body: normalized, error: 'missing frontmatter block (file must open with a --- fence)' };
  }

  let i = 1;
  let closed = false;
  const seen = new Set();
  for (; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim() === '---') {
      i++; // consume the closing fence
      closed = true;
      break;
    }
    if (line.trim() === '') continue; // tolerate blank lines inside the block
    const colon = line.indexOf(':');
    if (colon === -1) {
      return { frontmatter, body: '', error: `malformed frontmatter line (no key: value): "${line}"` };
    }
    const key = line.slice(0, colon).trim();
    let value = line.slice(colon + 1).trim();
    if (!REQUIRED_FIELDS.includes(key)) {
      return { frontmatter, body: '', error: `unknown frontmatter key "${key}"` };
    }
    if (seen.has(key)) {
      return { frontmatter, body: '', error: `repeated frontmatter key "${key}"` };
    }
    seen.add(key);
    // Strip matching surrounding quotes on a scalar value.
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    frontmatter[key] = value;
  }

  if (!closed) {
    return { frontmatter, body: '', error: 'unterminated frontmatter block (no closing --- fence)' };
  }

  const body = lines.slice(i).join('\n');
  return { frontmatter, body, error: null };
}

// --- Post-set validation -----------------------------------------------------

/**
 * Validate the whole post set. Each post is { file, frontmatter, error } where
 * `error` is the parseFrontmatter error (or null). Returns an array of
 * human-readable error strings; an empty array means the set is valid.
 */
export function validatePosts(posts) {
  const errors = [];
  const slugCounts = new Map();

  for (const post of posts) {
    const file = post.file || '(unknown file)';
    if (post.error) {
      errors.push(`${file}: ${post.error}`);
      continue;
    }
    const fm = post.frontmatter || {};

    for (const field of REQUIRED_FIELDS) {
      const v = fm[field];
      if (v === undefined || v === null || (typeof v === 'string' && v.trim() === '')) {
        errors.push(`${file}: missing required frontmatter field "${field}"`);
      }
    }
    if (typeof fm.slug === 'string' && fm.slug !== '' && !SLUG_RE.test(fm.slug)) {
      errors.push(`${file}: invalid slug "${fm.slug}" (must match ${SLUG_RE})`);
    }
    // Reserved output filenames: the build writes index.html and 404.html.
    if (fm.slug === '404' || fm.slug === 'index') {
      errors.push(`${file}: slug "${fm.slug}" is reserved`);
    }
    if (typeof fm.date === 'string' && fm.date !== '' && !DATE_RE.test(fm.date)) {
      errors.push(`${file}: invalid date "${fm.date}" (must be YYYY-MM-DD)`);
    }
    if (typeof fm.slug === 'string' && fm.slug !== '') {
      slugCounts.set(fm.slug, (slugCounts.get(fm.slug) || 0) + 1);
    }
  }

  for (const [slug, count] of slugCounts) {
    if (count > 1) errors.push(`duplicate slug "${slug}" used by ${count} posts`);
  }

  return errors;
}

/** Sort posts newest-first by date, breaking ties by slug for determinism. */
export function sortPosts(posts) {
  return [...posts].sort((a, b) => {
    if (a.date !== b.date) return a.date < b.date ? 1 : -1;
    return a.slug < b.slug ? -1 : 1;
  });
}

/** Format an ISO date (YYYY-MM-DD) as "July 19, 2026". Parsed by hand to keep
 *  the output independent of the build machine's timezone. */
export function formatDate(iso) {
  const m = DATE_RE.test(String(iso)) ? String(iso).split('-') : null;
  if (!m) return String(iso);
  const [y, mo, d] = m;
  return `${MONTHS[parseInt(mo, 10) - 1]} ${parseInt(d, 10)}, ${y}`;
}

// --- Markdown rendering (html:false) -----------------------------------------

const md = new MarkdownIt({ html: false, linkify: false, typographer: false });

/** Render a markdown body to an HTML fragment (no surrounding page chrome). */
export function renderBody(markdown) {
  return md.render(String(markdown || ''));
}

// --- Shared page template ----------------------------------------------------

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

const escapeAttr = escapeHtml;

// The Google tag snippet, identical to the marketing pages.
const GOOGLE_TAG = `  <!-- Google tag (gtag.js) -->
  <script async src="https://www.googletagmanager.com/gtag/js?id=G-9HGTDJRJWH"></script>
  <script>
    window.dataLayer = window.dataLayer || [];
    function gtag(){dataLayer.push(arguments);}
    gtag('js', new Date());
    gtag('config', 'G-9HGTDJRJWH');
    gtag('config', 'AW-18023084061');
  </script>`;

// The marketing header, structurally identical to landing.html, with the "Blog"
// nav link marked active.
const HEADER = `    <header class="landing-header">
      <div class="landing-header-content">
        <a href="/" class="landing-logo">
          <svg class="landing-logo-icon" width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <rect x="4" y="2" width="16" height="20" rx="2" ry="2" />
            <path d="M7.5 7.5h8" stroke-width="1" />
            <path d="M13.5 5.5l2.5 2-2.5 2" stroke-width="1" />
            <path d="M7.5 12h8" stroke-width="1" />
            <path d="M7.5 16.5h8" stroke-width="1" />
          </svg>
          <span class="landing-logo-text">Squire Docs</span>
        </a>
        <nav class="landing-nav">
          <a href="/pricing" class="landing-nav-link">Pricing</a>
          <a href="/about" class="landing-nav-link">About</a>
          <a href="/documentation" class="landing-nav-link">Documentation</a>
          <a href="/blog" class="landing-nav-link active">Blog</a>
          <a href="/login" class="landing-nav-btn">Sign In</a>
          <a href="/signup" class="landing-nav-btn primary">Sign Up</a>
        </nav>
      </div>
    </header>`;

// The marketing footer, reused from landing.html, with the "Blog" link added to
// the Product column.
const FOOTER = `    <footer class="landing-footer">
      <div class="landing-footer-content">
        <div class="landing-footer-top">
          <div class="landing-footer-brand">
            <a href="/" class="landing-footer-logo">
              <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <rect x="4" y="2" width="16" height="20" rx="2" ry="2" />
                <path d="M7.5 7.5h8" stroke-width="1" />
                <path d="M13.5 5.5l2.5 2-2.5 2" stroke-width="1" />
                <path d="M7.5 12h8" stroke-width="1" />
                <path d="M7.5 16.5h8" stroke-width="1" />
              </svg>
              <span>Squire Docs</span>
            </a>
            <p class="landing-footer-tagline">Write with AI, right in your doc</p>
          </div>
          <div class="landing-footer-links">
            <div class="landing-footer-column">
              <h4>Product</h4>
              <ul>
                <li><a href="/pricing">Pricing</a></li>
                <li><a href="/about">About</a></li>
                <li><a href="/documentation">Documentation</a></li>
                <li><a href="/blog">Blog</a></li>
                <li><a href="/agents.md">Agents</a></li>
                <li><a href="/signup">Sign Up</a></li>
                <li><a href="/login">Sign In</a></li>
              </ul>
            </div>
            <div class="landing-footer-column">
              <h4>Legal</h4>
              <ul>
                <li><a href="/privacy">Privacy Policy</a></li>
                <li><a href="/terms">Terms of Service</a></li>
              </ul>
            </div>
            <div class="landing-footer-column">
              <h4>Contact</h4>
              <ul>
                <li><a href="mailto:contact@squiredocs.com">contact@squiredocs.com</a></li>
              </ul>
            </div>
          </div>
        </div>
        <div class="landing-footer-bottom">
          <p class="landing-copyright">&copy; 2026 21st Harmonic LLC</p>
        </div>
      </div>
    </footer>`;

// The shared bottom call-to-action, reused from the marketing pages.
const CTA = `    <section class="landing-section cta">
      <div class="landing-section-content">
        <h2 class="landing-section-title">Ready to write with your agents?</h2>
        <div class="landing-signup-card">
          <p class="landing-signup-subtext">Free. No setup. Sign in with Google.</p>
          <a href="/signup" class="landing-btn google">
            <svg class="google-icon" width="20" height="20" viewBox="0 0 24 24">
              <path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 0 1-2.2 3.32v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.1z"/>
              <path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"/>
              <path fill="#FBBC05" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18A10.96 10.96 0 0 0 1 12c0 1.77.42 3.45 1.18 4.93l3.66-2.84z"/>
              <path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"/>
            </svg>
            Start free
          </a>
        </div>
      </div>
    </section>`;

/** Canonical URL for a blog slug. */
export function canonicalUrl(slug, origin = CANONICAL_ORIGIN) {
  return slug === 'index' ? `${origin}/blog` : `${origin}/blog/${slug}`;
}

function pageHead({ title, description, canonical, noindex }) {
  const seoTags = noindex
    ? `  <meta name="robots" content="noindex" />`
    : `  <link rel="canonical" href="${escapeAttr(canonical)}" />
  <meta property="og:url" content="${escapeAttr(canonical)}" />`;
  return `<head>
${GOOGLE_TAG}
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>${escapeHtml(title)}</title>
  <meta name="description" content="${escapeAttr(description)}" />
${seoTags}
  <meta property="og:title" content="${escapeAttr(title)}" />
  <meta property="og:description" content="${escapeAttr(description)}" />
  <meta property="og:type" content="article" />
  <link rel="icon" type="image/svg+xml" href="/favicon.svg" />
  <link rel="stylesheet" href="/marketing.css" />
  <link rel="stylesheet" href="/documentation.css" />
  <link rel="stylesheet" href="/blog.css" />
</head>`;
}

/**
 * Render a complete HTML document for one post.
 * `post` is { slug, title, description, date, author, bodyHtml }.
 */
export function renderPostPage({ post, canonicalOrigin = CANONICAL_ORIGIN }) {
  const canonical = canonicalUrl(post.slug, canonicalOrigin);
  return `<!DOCTYPE html>
<html lang="en">
${pageHead({ title: `${post.title} | Squire Docs Blog`, description: post.description, canonical })}
<body>
  <div class="blog-page">
${HEADER}
    <main class="blog-main">
      <article class="blog-post">
        <a href="/blog" class="blog-back">&larr; Blog</a>
        <h1 class="blog-post-title">${escapeHtml(post.title)}</h1>
        <p class="blog-post-meta">${escapeHtml(formatDate(post.date))} &middot; ${escapeHtml(post.author)}</p>
        <div class="documentation-content">
${post.bodyHtml}
        </div>
      </article>
    </main>
${CTA}
${FOOTER}
  </div>
</body>
</html>
`;
}

/**
 * Render the blog index listing every post, newest first.
 * `posts` is [{ slug, title, description, date, author }].
 */
export function renderIndexPage({ posts, canonicalOrigin = CANONICAL_ORIGIN }) {
  const sorted = sortPosts(posts);
  const items = sorted
    .map(
      (p) => `          <li class="blog-list-item">
            <p class="blog-list-date">${escapeHtml(formatDate(p.date))}</p>
            <h2 class="blog-list-title"><a href="/blog/${escapeAttr(p.slug)}">${escapeHtml(p.title)}</a></h2>
            <p class="blog-list-desc">${escapeHtml(p.description)}</p>
          </li>`
    )
    .join('\n');
  return `<!DOCTYPE html>
<html lang="en">
${pageHead({
    title: 'Blog | Squire Docs',
    description: 'Writing on spec-driven development, coding agents, and collaborative docs from the team building Squire Docs.',
    canonical: canonicalUrl('index', canonicalOrigin),
  })}
<body>
  <div class="blog-page">
${HEADER}
    <main class="blog-main">
      <header class="blog-index-header">
        <h1>Blog</h1>
        <p>Writing on spec-driven development, coding agents, and collaborative docs from the team building Squire Docs.</p>
      </header>
      <ul class="blog-list">
${items}
      </ul>
    </main>
${CTA}
${FOOTER}
  </div>
</body>
</html>
`;
}

/** Render the styled 404 page from the same chrome. */
export function render404({ canonicalOrigin = CANONICAL_ORIGIN } = {}) {
  return `<!DOCTYPE html>
<html lang="en">
${pageHead({ title: 'Post not found | Squire Docs Blog', description: 'The blog post you asked for does not exist.', noindex: true })}
<body>
  <div class="blog-page">
${HEADER}
    <main class="blog-main">
      <article class="blog-post">
        <h1 class="blog-post-title">Post not found</h1>
        <p class="documentation-content">The blog post you asked for does not exist. <a href="/blog">Go to the blog index</a>.</p>
      </article>
    </main>
${FOOTER}
  </div>
</body>
</html>
`;
}
