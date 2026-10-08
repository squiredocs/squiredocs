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

// --- T035: terminology sweep (FR-001, FR-031, SC-002) ------------------------

describe('terminology: "docs" never means product documentation (T035)', () => {
  const violationsIn = (label, text) =>
    findTerminologyViolations(text).map((hit) => `${label}: "${hit}"`);

  it('detects the violation phrasings it exists to catch', () => {
    expect(findTerminologyViolations('Read the docs on our docs site.')).not.toHaveLength(0);
    expect(findTerminologyViolations('See the product docs for details.')).not.toHaveLength(0);
    // The product name and Squire-document meanings are not violations.
    expect(findTerminologyViolations('Squire Docs is collaborative documents.')).toHaveLength(0);
    expect(findTerminologyViolations('Share your docs with the team.')).toHaveLength(0);
  });

  it('documentation sources (bodies, titles, descriptions) are clean', () => {
    const all = [];
    for (const page of sourcePages) {
      all.push(...violationsIn(`${page.file} body`, page.body));
      all.push(...violationsIn(`${page.file} title`, page.frontmatter.title || ''));
      all.push(...violationsIn(`${page.file} description`, page.frontmatter.description || ''));
    }
    expect(all, all.join('\n')).toHaveLength(0);
  });

  it('rendered pages (including sidebar and link labels) and the 404 are clean', () => {
    const all = [];
    for (const page of sourcePages) {
      all.push(...violationsIn(page.file, renderedPageFor(page, allPages)));
    }
    all.push(...violationsIn('404.html', render404({ allPages })));
    expect(all, all.join('\n')).toHaveLength(0);
  });

  it('the header and footer link label is "Documentation", never "Docs"', () => {
    const rendered = renderedPageFor(sourcePages[0], allPages);
    for (const html of [
      rendered,
      ...MARKETING_PAGES.map((f) => fs.readFileSync(path.join(PUBLIC_DIR, f), 'utf8')),
    ]) {
      expect(html).toContain('href="/documentation" class="landing-nav-link">Documentation<');
      expect(html).not.toMatch(/href="\/documentation"[^>]*>\s*Docs\s*</);
    }
  });

  it('audited app and marketing copy stays clean (T034 sweep gate)', () => {
    // The T034 sweep found zero violations in client/src and client/public;
    // this keeps the audited surfaces clean going forward. JSX/HTML string
    // scanning at phrase level: the patterns in findTerminologyViolations only
    // flag "docs" meaning product documentation, so the product name
    // "Squire Docs", "Google Docs", and docs-as-Squire-documents all pass.
    const surfaces = [];
    const walk = (dir) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        // Test files are not user-facing copy, and this file itself carries
        // deliberate violation examples as fixtures.
        if (entry.isDirectory()) {
          if (entry.name === 'node_modules' || entry.name === '__tests__') continue;
          walk(full);
        } else if (/\.(jsx?|html|md)$/.test(entry.name) && !/\.test\.jsx?$/.test(entry.name)) {
          surfaces.push(full);
        }
      }
    };
    walk(path.join(CLIENT_DIR, 'src'));
    walk(PUBLIC_DIR);
    const all = [];
    for (const file of surfaces) {
      const text = fs.readFileSync(file, 'utf8');
      all.push(...violationsIn(path.relative(CLIENT_DIR, file), text));
    }
    expect(all, all.join('\n')).toHaveLength(0);
  });
});

// --- Feature 060: the self-hosting page (T038, FR-029, FR-040, RBD-060-9) ---

describe('the self-hosting page (060 T038)', () => {
  const page = sourcePages.find((p) => p.frontmatter.slug === 'self-hosting');

  it('exists with its slug, title, description, and order 10 right after Agents and MCP', () => {
    expect(page, 'documentation/self-hosting.md').toBeTruthy();
    expect(page.error).toBeNull();
    expect(page.frontmatter.title).toBe('Self-hosting');
    expect(page.frontmatter.description).toBe(
      'Run your own Squire Docs instance with Docker Compose, sign in with a claim link, and connect your agent.'
    );
    expect(page.frontmatter.order).toBe(10);
    const sorted = [...allPages].sort((a, b) => a.order - b.order).map((p) => p.slug);
    expect(sorted.indexOf('self-hosting')).toBe(sorted.indexOf('agents-and-mcp') + 1);
    expect(sorted.slice(-3)).toEqual(['markdown', 'appearance', 'account-and-support']);
  });

  it('covers the required topics in order', () => {
    const headings = [...page.body.matchAll(/^## (.+)$/gm)].map((m) => m[1]);
    expect(headings).toEqual([
      'Prerequisites',
      'Install with one command',
      'What the install script does',
      'Sign in with a claim link',
      'Connect your agent',
      'Without an API key',
      'Configuration',
      'Upgrading',
      'Backing up',
      'Stopping safely',
      'Exposing an instance',
      'Windows',
      'Getting help',
    ]);
    const b = page.body;
    expect(b).toContain('Docker Compose 2.24 or later');
    expect(b).toContain('curl -fsSL https://squiredocs.com/install.sh | sh -s --');
    expect(b).toContain('./squire claim-link');
    expect(b).toContain('docker compose logs app');
    expect(b).toContain('claude mcp add --transport http squire-local http://localhost:3910/mcp');
    expect(b).toMatch(/SQUIRE_PORT/);
    expect(b).toContain('token create');
    expect(b).toContain('GOOGLE_GENERATIVE_AI_API_KEY');
    for (const s of ['SMTP_HOST', 'S3_IMAGE_BUCKET', 'APP_URL', '.env']) expect(b).toContain(s);
    expect(b).toMatch(/set `SQUIRE_VERSION` in `\.env` to the new release/);
    expect(b).toContain('docker compose pull && docker compose up -d --wait');
    for (const v of ['squire-data', 'postgres-data', 'redis-data']) expect(b).toContain(v);
    expect(b).toMatch(/encryption key/);
    expect(b).toContain('docker compose down -v');
    expect(b).toContain('docker compose exec app squire');
    expect(b).toContain('https://squiredocs.com/self-host.md');
    expect(b).toMatch(/https:\/\/github\.com\/[^/\s)]+\/[^/\s)]+/);
    expect(b).toContain('security@squiredocs.com');
  });

  it('states the FR-040 TLS rule', () => {
    expect(page.body).toMatch(/Plain HTTP is supported only on localhost/);
    expect(page.body).toMatch(/TLS-terminating proxy/);
    expect(page.body).toMatch(/https `APP_URL`/);
  });

  it('names no feature that does not exist and never says bare "Squire"', () => {
    expect(page.body).not.toMatch(/password/i);
    expect(page.body).not.toMatch(/OIDC/i);
    const prose = page.body
      .replace(/```[\s\S]*?```/g, '')
      .replace(/`[^`\n]*`/g, '')
      .replace(/\]\([^)]*\)/g, ']')
      .replace(/https?:\/\/\S+/g, '');
    expect(prose.match(/\bSquire\b(?! Docs)/g)).toBeNull();
    expect(page.body).not.toContain('—');
  });
});

// --- Feature 060: build output for both variants (T033) ---------------------

describe('build output: hosted and self-hosted directories (060 T033)', () => {
  it('writes every page, index, and 404 to both directories and passes the output checks', async () => {
    const { build, checkBuildOutput, SELF_HOSTED_SUBDIR } = await import('../../scripts/build-documentation.mjs');
    const os = await import('node:os');
    const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'docs-build-'));
    try {
      build({ srcDir: DOCS_SRC_DIR, outDir });
      const expected = [...sourcePages.map((p) => `${p.frontmatter.slug}.html`), '404.html'].sort();
      const hosted = fs.readdirSync(outDir).filter((f) => f.endsWith('.html')).sort();
      const variant = fs.readdirSync(path.join(outDir, SELF_HOSTED_SUBDIR)).sort();
      expect(hosted).toEqual(expected);
      expect(variant).toEqual(expected);
      expect(checkBuildOutput(outDir)).toEqual([]);
      for (const f of hosted) {
        expect(fs.readFileSync(path.join(outDir, f), 'utf8')).not.toContain('__SQUIRE_ORIGIN__');
        const v = fs.readFileSync(path.join(outDir, SELF_HOSTED_SUBDIR, f), 'utf8');
        expect(v).not.toContain('googletagmanager');
        expect(v).not.toContain('rel="canonical"');
        expect(v).not.toContain('og:url');
      }
      expect(fs.readFileSync(path.join(outDir, SELF_HOSTED_SUBDIR, 'agents-and-mcp.html'), 'utf8')).toContain(
        '__SQUIRE_ORIGIN__/mcp'
      );

      // The checks catch a sentinel in a hosted page and a tag in a variant page.
      fs.writeFileSync(path.join(outDir, 'editing.html'), 'x __SQUIRE_ORIGIN__ x');
      fs.writeFileSync(path.join(outDir, SELF_HOSTED_SUBDIR, 'editing.html'), '<link rel="canonical" href="x">');
      const errors = checkBuildOutput(outDir);
      expect(errors.some((e) => e.includes('documentation/editing.html') && e.includes('__SQUIRE_ORIGIN__'))).toBe(true);
      expect(errors.some((e) => e.includes('_self-hosted/editing.html') && e.includes('rel="canonical"'))).toBe(true);
    } finally {
      fs.rmSync(outDir, { recursive: true, force: true });
    }
  });
});
