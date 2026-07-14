/**
 * Build-side tests for the product documentation site (feature 007).
 *
 * Imports the pure render/validate functions from
 * client/scripts/render-documentation.mjs (mirroring how color-tokens.lint.test.js
 * imports from scripts/check-color-tokens.mjs) and reads the real
 * documentation/*.md sources and the marketing HTML.
 *
 * Sections:
 *   T028 - marketing chrome + Documentation link drift-guard (US2)
 *   T029 - per-page SEO metadata (US3)
 *   T031 - build validation, HTML escaping, heading anchors (US4)
 *   T035 - terminology sweep across sources, rendered pages, labels (Polish)
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  parseFrontmatter,
  validatePages,
  renderBody,
  renderPage,
  render404,
  slugify,
  findTerminologyViolations,
  canonicalUrl,
  CANONICAL_ORIGIN,
} from '../../scripts/render-documentation.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLIENT_DIR = path.resolve(__dirname, '../..');
const REPO_ROOT = path.resolve(CLIENT_DIR, '..');
const DOCS_SRC_DIR = path.join(REPO_ROOT, 'documentation');
const PUBLIC_DIR = path.join(CLIENT_DIR, 'public');

const MARKETING_PAGES = ['landing.html', 'pricing.html', 'about.html'];

// Load and parse the real documentation sources once for the suite.
function loadSourcePages() {
  return fs
    .readdirSync(DOCS_SRC_DIR)
    .filter((f) => f.endsWith('.md'))
    .sort()
    .map((name) => {
      const text = fs.readFileSync(path.join(DOCS_SRC_DIR, name), 'utf8');
      const { frontmatter, body, error } = parseFrontmatter(text);
      return { file: `documentation/${name}`, frontmatter, body, error };
    });
}

function renderedPageFor(page, allPages) {
  return renderPage({
    page: {
      slug: page.frontmatter.slug,
      title: page.frontmatter.title,
      description: page.frontmatter.description,
      bodyHtml: renderBody(page.body),
    },
    allPages,
  });
}

const sourcePages = loadSourcePages();
const allPages = sourcePages.map((p) => ({
  slug: p.frontmatter.slug,
  title: p.frontmatter.title,
  order: p.frontmatter.order,
}));

// --- T028: marketing chrome + Documentation link drift-guard (US2) ----------

describe('marketing chrome and Documentation link (T028, SC-006)', () => {
  for (const file of MARKETING_PAGES) {
    it(`${file} header and footer link to /documentation`, () => {
      const html = fs.readFileSync(path.join(PUBLIC_DIR, file), 'utf8');
      // Header nav link.
      expect(html).toMatch(/<a href="\/documentation" class="landing-nav-link">Documentation<\/a>/);
      // Footer Product-column link.
      expect(html).toMatch(/<li><a href="\/documentation">Documentation<\/a><\/li>/);
    });
  }

  it('the rendered documentation template carries the same header and footer markers as landing.html', () => {
    const landing = fs.readFileSync(path.join(PUBLIC_DIR, 'landing.html'), 'utf8');
    const rendered = renderedPageFor(sourcePages[0], allPages);
    // Structural markers the documentation chrome copies from the marketing chrome.
    const markers = [
      'class="landing-header"',
      'class="landing-logo"',
      'class="landing-logo-text"',
      'class="landing-nav"',
      'href="/login"',
      'href="/signup"',
      'class="landing-footer"',
      '<h4>Product</h4>',
      'class="landing-copyright"',
    ];
    for (const marker of markers) {
      expect(landing, `landing.html missing ${marker}`).toContain(marker);
      expect(rendered, `rendered template missing ${marker}`).toContain(marker);
    }
    // Both carry the Documentation link in header and footer.
    expect(rendered).toContain('<a href="/documentation" class="landing-nav-link">Documentation</a>');
    expect(rendered).toContain('<li><a href="/documentation">Documentation</a></li>');
  });
});

// --- T029: per-page SEO metadata (US3) --------------------------------------

describe('per-page SEO metadata (T029, FR-024..FR-027, SC-006)', () => {
  const rendered = sourcePages.map((p) => ({ page: p, html: renderedPageFor(p, allPages) }));

  it('title and meta description equal the frontmatter and are unique per page', () => {
    const titles = new Set();
    const descriptions = new Set();
    for (const { page, html } of rendered) {
      const title = page.frontmatter.title;
      const description = page.frontmatter.description;
      expect(html).toContain(`<title>${title}</title>`);
      expect(html).toContain(`<meta name="description" content="${description}" />`);
      titles.add(title);
      descriptions.add(description);
    }
    expect(titles.size).toBe(rendered.length);
    expect(descriptions.size).toBe(rendered.length);
  });

  it('each page declares the canonical URL for its slug (index has no slug segment)', () => {
    for (const { page, html } of rendered) {
      const slug = page.frontmatter.slug;
      const expected = canonicalUrl(slug);
      if (slug === 'index') {
        expect(expected).toBe(`${CANONICAL_ORIGIN}/documentation`);
      } else {
        expect(expected).toBe(`${CANONICAL_ORIGIN}/documentation/${slug}`);
      }
      expect(html).toContain(`<link rel="canonical" href="${expected}" />`);
      expect(html).toContain(`<meta property="og:url" content="${expected}" />`);
    }
  });

  it('each page carries the four Open Graph tags and no og:image', () => {
    for (const { page, html } of rendered) {
      expect(html).toContain(`<meta property="og:title" content="${page.frontmatter.title}" />`);
      expect(html).toContain(`<meta property="og:description" content="${page.frontmatter.description}" />`);
      expect(html).toContain('<meta property="og:type" content="website" />');
      expect(html).toMatch(/<meta property="og:url" content="[^"]+" \/>/);
      expect(html).not.toContain('og:image');
    }
  });

  it('each page includes the same Google tag snippet as landing.html', () => {
    const landing = fs.readFileSync(path.join(PUBLIC_DIR, 'landing.html'), 'utf8');
    const gtagMarkers = [
      'https://www.googletagmanager.com/gtag/js?id=G-9HGTDJRJWH',
      "gtag('config', 'G-9HGTDJRJWH');",
      "gtag('config', 'AW-18023084061');",
    ];
    for (const marker of gtagMarkers) {
      expect(landing, `landing.html missing ${marker}`).toContain(marker);
    }
    for (const { html } of rendered) {
      for (const marker of gtagMarkers) {
        expect(html).toContain(marker);
      }
    }
  });
});

// --- T031: build validation, HTML escaping, heading anchors (US4) -----------

describe('build validation (T031, D6/FR-009)', () => {
  const base = { slug: 'ok', title: 'Ok', description: 'Fine', order: 1 };

  it('fails on a missing required field', () => {
    const errors = validatePages([
      { file: 'a.md', frontmatter: { slug: 'a', title: 'A', order: 1 } }, // no description
    ]);
    expect(errors.join('\n')).toMatch(/missing required frontmatter field "description"/);
  });

  it('fails on a duplicate slug', () => {
    const errors = validatePages([
      { file: 'a.md', frontmatter: { ...base, slug: 'dup', order: 1 } },
      { file: 'b.md', frontmatter: { ...base, slug: 'dup', order: 2 } },
    ]);
    expect(errors.join('\n')).toMatch(/duplicate slug "dup"/);
  });

  it('fails on a duplicate order', () => {
    const errors = validatePages([
      { file: 'a.md', frontmatter: { ...base, slug: 'a', order: 7 } },
      { file: 'b.md', frontmatter: { ...base, slug: 'b', order: 7 } },
    ]);
    expect(errors.join('\n')).toMatch(/duplicate order "7"/);
  });

  it('accepts a valid page set (the real sources validate)', () => {
    expect(validatePages(sourcePages)).toEqual([]);
  });
});

describe('markdown rendering (T031, FR-013/FR-028)', () => {
  it('escapes raw HTML in a body instead of emitting it as live markup', () => {
    const html = renderBody('A <script>alert(1)</script> and <b>bold</b> tag.');
    expect(html).not.toContain('<script>');
    expect(html).not.toContain('<b>bold</b>');
    expect(html).toContain('&lt;script&gt;');
    expect(html).toContain('&lt;b&gt;bold&lt;/b&gt;');
  });

  it('gives headings stable, de-duplicated anchor ids', () => {
    const html = renderBody('## Getting set up\n\ntext\n\n## Getting set up\n\nmore');
    expect(html).toContain('id="getting-set-up"');
    expect(html).toContain('id="getting-set-up-1"');
    // slugify is deterministic.
    expect(slugify('Getting Set Up!')).toBe('getting-set-up');
  });

  it('every heading in the real sources gets an id', () => {
    for (const page of sourcePages) {
      const html = renderBody(page.body);
      const headingOpens = html.match(/<h[1-6]\b/g) || [];
      const headingIds = html.match(/<h[1-6] id="/g) || [];
      expect(headingIds.length, `${page.file} has headings without ids`).toBe(headingOpens.length);
    }
  });
});
