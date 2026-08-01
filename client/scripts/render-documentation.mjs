/**
 * render-documentation.mjs — the pure render library for the product
 * documentation site (feature 007).
 *
 * This module has no side effects: it parses page frontmatter, validates the
 * page set, renders markdown bodies to HTML, and wraps each page in the shared
 * template. The build CLI (build-documentation.mjs), the Vite dev middleware,
 * and the Vitest tests all import from here, so a page renders identically in
 * dev, at build time, and in the tests.
 *
 * Exports:
 *   parseFrontmatter(text)                     -> { frontmatter, body, error }
 *   validatePages(pages)                       -> string[] (errors; empty = OK)
 *   slugify(text)                              -> anchor id
 *   renderBody(markdown)                       -> HTML string (html:false)
 *   renderPage({ page, allPages, canonicalOrigin }) -> full HTML document
 *   render404({ allPages, canonicalOrigin })   -> full 404 HTML document
 *   findTerminologyViolations(text)            -> string[] (matched phrases)
 *
 * Design ground truth: design/product-documentation-site.md. Contracts:
 * specs/007-documentation-site/{data-model,contracts/documentation-routes}.md.
 */
import MarkdownIt from 'markdown-it';

export const CANONICAL_ORIGIN = 'https://squiredocs.com';

// The four allowed frontmatter keys (data-model.md). `order` must be an integer.
const REQUIRED_FIELDS = ['slug', 'title', 'description', 'order'];
const SLUG_RE = /^[a-z0-9-]+$/;

// --- Frontmatter parsing (R2) ------------------------------------------------

/**
 * Parse a page file's YAML-ish frontmatter. Strict and scalar-only: the file
 * must open with a `---` fence, contain only the four known keys, each a
 * single-line scalar, with `order` an integer. Anything else is an error.
 *
 * Returns { frontmatter, body, error }. On a structural problem `error` is a
 * string and `frontmatter` holds whatever parsed so far. On success `error` is
 * null.
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
    if (key === 'order') {
      if (!/^-?\d+$/.test(value)) {
        return { frontmatter, body: '', error: `frontmatter "order" must be an integer, got "${value}"` };
      }
      frontmatter.order = parseInt(value, 10);
    } else {
      frontmatter[key] = value;
    }
  }

  if (!closed) {
    return { frontmatter, body: '', error: 'unterminated frontmatter block (no closing --- fence)' };
  }

  const body = lines.slice(i).join('\n');
  return { frontmatter, body, error: null };
}

// --- Page-set validation (D6 / FR-009) --------------------------------------

/**
 * Validate the whole page set. Each page is { file, frontmatter, error } where
 * `error` is the parseFrontmatter error (or null). Returns an array of
 * human-readable error strings naming the offending file and problem; an empty
 * array means the set is valid.
 */
export function validatePages(pages) {
  const errors = [];
  const slugCounts = new Map();
  const orderCounts = new Map();

  for (const page of pages) {
    const file = page.file || '(unknown file)';
    if (page.error) {
      errors.push(`${file}: ${page.error}`);
      continue;
    }
    const fm = page.frontmatter || {};

    // Missing / empty required fields.
    for (const field of REQUIRED_FIELDS) {
      const v = fm[field];
      if (v === undefined || v === null || (typeof v === 'string' && v.trim() === '')) {
        errors.push(`${file}: missing required frontmatter field "${field}"`);
      }
    }
    // Invalid slug shape.
    if (typeof fm.slug === 'string' && fm.slug !== '' && !SLUG_RE.test(fm.slug)) {
      errors.push(`${file}: invalid slug "${fm.slug}" (must match ${SLUG_RE})`);
    }
    // Reserved output filenames: the build writes 404.html itself, so an
    // authored page with that slug would be silently overwritten.
    if (fm.slug === '404') {
      errors.push(`${file}: slug "404" is reserved for the not-found page`);
    }
    if (typeof fm.slug === 'string' && fm.slug !== '') {
      slugCounts.set(fm.slug, (slugCounts.get(fm.slug) || 0) + 1);
    }
    if (Number.isInteger(fm.order)) {
      orderCounts.set(fm.order, (orderCounts.get(fm.order) || 0) + 1);
    }
  }

  for (const [slug, count] of slugCounts) {
    if (count > 1) errors.push(`duplicate slug "${slug}" used by ${count} pages`);
  }
  for (const [order, count] of orderCounts) {
    if (count > 1) errors.push(`duplicate order "${order}" used by ${count} pages`);
  }

  return errors;
}

// --- Markdown rendering (R1 / R3, html:false) --------------------------------

/**
 * GitHub-style anchor slug: lowercase, non-alphanumerics dropped (spaces and
 * hyphens kept, spaces then collapsed to hyphens).
 */
export function slugify(text) {
  return String(text)
    .toLowerCase()
    .trim()
    .replace(/[^\w\s-]/g, '') // drop punctuation; keep word chars, spaces, hyphens
    .replace(/[\s_]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '');
}

// A single markdown-it instance. `html: false` escapes any raw HTML in a source
// body instead of emitting it as live markup (FR-013). `linkify: false` keeps
// bare URLs as plain text unless written as explicit markdown links.
const md = new MarkdownIt({ html: false, linkify: false, typographer: false });

// Give every heading a stable, de-duplicated anchor id (D9 / FR-028).
md.core.ruler.push('documentation_heading_anchors', (state) => {
  const counts = Object.create(null);
  for (let i = 0; i < state.tokens.length; i++) {
    const tok = state.tokens[i];
    if (tok.type !== 'heading_open') continue;
    const inline = state.tokens[i + 1];
    const raw = inline && inline.type === 'inline' ? inline.content : '';
    let base = slugify(raw) || 'section';
    let id = base;
    if (counts[base] === undefined) {
      counts[base] = 0;
    } else {
      counts[base] += 1;
      id = `${base}-${counts[base]}`;
    }
    tok.attrSet('id', id);
  }
});

/** Render a markdown body to an HTML fragment (no surrounding page chrome). */
export function renderBody(markdown) {
  return md.render(String(markdown || ''));
}

// --- Terminology gate (FR-001 / R8) -----------------------------------------

// Phrases where "docs" clearly means product documentation, not Squire
// documents. Matching is case-insensitive and word-bounded. The product name
// "Squire Docs" and "docs"/"documents" meaning the user's Squire documents are
// deliberately NOT matched (they carry no documentation-site meaning).
const TERMINOLOGY_PATTERNS = [
  /\bdocs\s+site\b/gi,
  /\bdocs\s+pages?\b/gi,
  /\bproduct\s+docs\b/gi,
  /\bread\s+the\s+docs\b/gi,
  /\bhelp\s+docs\b/gi,
  /\bdocumentation\s+docs\b/gi,
  /\bapi\s+docs\b/gi,
  /\buser\s+docs\b/gi,
  /\bonline\s+docs\b/gi,
  /\b(?:view|browse|see|check|read|visit|consult|open)\s+(?:the\s+|our\s+)?docs\b/gi,
  /\bdocs\s+(?:for|about|on)\s+(?:using|setup|getting)\b/gi,
  /\bin\s+the\s+docs\b/gi,
];

/**
 * Return the list of matched phrases where "docs" is used to mean product
 * documentation. An empty array means no violation.
 */
export function findTerminologyViolations(text) {
  const found = [];
  const s = String(text);
  for (const re of TERMINOLOGY_PATTERNS) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(s)) !== null) {
      found.push(m[0].replace(/\s+/g, ' ').trim());
    }
  }
  return found;
}

// --- Shared page template (R4 / data-model.md) ------------------------------

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function escapeAttr(s) {
  return escapeHtml(s);
}

// The Google tag snippet, identical to client/public/landing.html (FR-027).
const GOOGLE_TAG = `  <!-- Google tag (gtag.js) -->
  <script async src="https://www.googletagmanager.com/gtag/js?id=G-9HGTDJRJWH"></script>
  <script>
    window.dataLayer = window.dataLayer || [];
    function gtag(){dataLayer.push(arguments);}
    gtag('js', new Date());
    gtag('config', 'G-9HGTDJRJWH');
    gtag('config', 'AW-18023084061');
  </script>`;

// The marketing header, structurally identical to landing.html, with the new
// "Documentation" nav link (FR-020).
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
          <a href="/blog" class="landing-nav-link">Blog</a>
          <a href="/login" class="landing-nav-btn">Sign In</a>
          <a href="/signup" class="landing-nav-btn primary">Sign Up</a>
        </nav>
      </div>
    </header>`;

// The marketing footer, reused from landing.html, with the "Documentation" link
// added to the Product column (D3 / FR-021).
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
                <li><a href="https://github.com/squiredocs">GitHub</a></li>
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

/** Canonical URL for a slug. The index page canonicalizes to /documentation. */
export function canonicalUrl(slug, origin = CANONICAL_ORIGIN) {
  return slug === 'index' ? `${origin}/documentation` : `${origin}/documentation/${slug}`;
}

/** Build the sidebar: every page in `order`, current page marked. */
function renderSidebar(allPages, currentSlug) {
  const sorted = [...allPages].sort((a, b) => a.order - b.order);
  const items = sorted
    .map((p) => {
      const href = p.slug === 'index' ? '/documentation' : `/documentation/${p.slug}`;
      const current = p.slug === currentSlug;
      const attrs = current
        ? ` class="documentation-nav-current" aria-current="page"`
        : '';
      return `            <li><a href="${escapeAttr(href)}"${attrs}>${escapeHtml(p.title)}</a></li>`;
    })
    .join('\n');
  // Rendered open: author CSS cannot reveal a closed <details> (browsers hide
  // the content at the rendering layer, not via display), so desktop relies on
  // the open attribute and the inline script collapses it on narrow viewports.
  return `      <aside class="documentation-sidebar">
        <details class="documentation-nav" open>
          <summary class="documentation-nav-toggle">Documentation</summary>
          <ul class="documentation-nav-list">
${items}
          </ul>
        </details>
        <script>(function () { var d = document.currentScript.previousElementSibling; if (window.matchMedia('(max-width: 899px)').matches) { d.removeAttribute('open'); } })();</script>
      </aside>`;
}

/**
 * Render a complete HTML document for one page.
 *
 * `page` is { slug, title, description, bodyHtml } (bodyHtml already rendered).
 * `allPages` is [{ slug, title, order }] for the sidebar.
 */
export function renderPage({ page, allPages, canonicalOrigin = CANONICAL_ORIGIN }) {
  const canonical = canonicalUrl(page.slug, canonicalOrigin);
  const title = page.title;
  const description = page.description;
  const sidebar = renderSidebar(allPages, page.slug);
  // The 404 page (noindex) gets no canonical or og:url: a canonical pointing
  // at a URL that itself 404s is wrong metadata on every unknown-slug response.
  const seoTags = page.noindex
    ? `  <meta name="robots" content="noindex" />`
    : `  <link rel="canonical" href="${escapeAttr(canonical)}" />
  <meta property="og:url" content="${escapeAttr(canonical)}" />`;
  return `<!DOCTYPE html>
<html lang="en">
<head>
${GOOGLE_TAG}
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>${escapeHtml(title)}</title>
  <meta name="description" content="${escapeAttr(description)}" />
${seoTags}
  <meta property="og:title" content="${escapeAttr(title)}" />
  <meta property="og:description" content="${escapeAttr(description)}" />
  <meta property="og:type" content="website" />
  <link rel="icon" type="image/svg+xml" href="/favicon.svg" />
  <link rel="stylesheet" href="/marketing.css" />
  <link rel="stylesheet" href="/documentation.css" />
</head>
<body>
  <div class="documentation-page">
${HEADER}
    <main class="documentation-layout">
${sidebar}
      <article class="documentation-content">
        <h1>${escapeHtml(title)}</h1>
${page.bodyHtml}
      </article>
    </main>
${FOOTER}
  </div>
</body>
</html>
`;
}

/**
 * Render the styled 404 page from the same template (D4 / FR-016). Its body
 * links back to the documentation index.
 */
export function render404({ allPages, canonicalOrigin = CANONICAL_ORIGIN }) {
  const bodyHtml = `        <p>The documentation page you asked for does not exist.</p>
        <p><a href="/documentation">Go to the documentation index</a>.</p>`;
  return renderPage({
    page: {
      slug: '404',
      title: 'Page not found',
      description: 'The documentation page you asked for does not exist.',
      bodyHtml,
      noindex: true,
    },
    allPages,
    canonicalOrigin,
  });
}
