/**
 * Feature 060 (T031, FR-030 to FR-033, SC-005, RBD-060-8/-24/-25/-30): the
 * hosted documentation output is byte-identical to the pre-060 output, and
 * the self-hosted variant drops analytics and canonical URLs, filters the
 * header and footer by one href rule derived from the single FOOTER, and marks
 * instance URLs with the origin sentinel.
 */
import { describe, it, expect } from 'vitest';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import {
  parseFrontmatter,
  renderBody,
  renderPage,
  render404,
  keepSelfHostedHref,
  filterNavHtml,
  filterFooter,
  renderVariantBody,
  ORIGIN_SENTINEL,
  HOSTED_ONLY_PATHS,
} from '../../scripts/render-documentation.mjs';
import { FOOTER } from '../../scripts/site-footer.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '../../..');
const DOCS_SRC_DIR = path.join(REPO_ROOT, 'documentation');
const GOLDEN = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures/documentation-hosted-golden.json'), 'utf8'));
const require = createRequire(import.meta.url);

const sourcePages = fs
  .readdirSync(DOCS_SRC_DIR)
  .filter((f) => f.endsWith('.md'))
  .sort()
  .map((name) => parseFrontmatter(fs.readFileSync(path.join(DOCS_SRC_DIR, name), 'utf8')));
const allPages = sourcePages.map((p) => ({ slug: p.frontmatter.slug, title: p.frontmatter.title, order: p.frontmatter.order }));

const sha = (s) => crypto.createHash('sha256').update(s, 'utf8').digest('hex');
const pageArgs = (p) => ({
  slug: p.frontmatter.slug,
  title: p.frontmatter.title,
  description: p.frontmatter.description,
  bodyHtml: renderBody(p.body),
});
const render = (p, variant, pages = allPages) =>
  renderPage({ page: pageArgs(p), allPages: pages, ...(variant ? { variant } : {}) });

describe('hosted output is byte-identical to the recorded golden hashes (RBD-060-30)', () => {
  // The golden set predates the self-hosting page, so render without it.
  const prePages = sourcePages.filter((p) => p.frontmatter.slug !== 'self-hosting');
  const preAll = allPages.filter((p) => p.slug !== 'self-hosting');

  it('covers every pre-060 page and the 404', () => {
    expect(Object.keys(GOLDEN.hashes).sort()).toEqual(
      [...prePages.map((p) => `${p.frontmatter.slug}.html`), '404.html'].sort()
    );
  });

  for (const p of prePages) {
    it(`${p.frontmatter.slug}.html`, () => {
      expect(sha(render(p, undefined, preAll))).toBe(GOLDEN.hashes[`${p.frontmatter.slug}.html`]);
      expect(sha(render(p, 'hosted', preAll))).toBe(GOLDEN.hashes[`${p.frontmatter.slug}.html`]);
    });
  }

  it('404.html', () => {
    expect(sha(render404({ allPages: preAll }))).toBe(GOLDEN.hashes['404.html']);
    expect(sha(render404({ allPages: preAll, variant: 'hosted' }))).toBe(GOLDEN.hashes['404.html']);
  });

  it('variant "hosted" equals the default for every current page', () => {
    for (const p of sourcePages) expect(render(p, 'hosted')).toBe(render(p));
  });

  it('an unknown variant is refused', () => {
    expect(() => render(sourcePages[0], 'staging')).toThrow(/unknown documentation variant/);
  });
});

describe('self-hosted pages (FR-030, FR-031)', () => {
  const rendered = sourcePages.map((p) => ({ slug: p.frontmatter.slug, html: render(p, 'self-hosted') }));
  rendered.push({ slug: '404', html: render404({ allPages, variant: 'self-hosted' }) });

  it('carry no Google tag, no canonical, and no og:url, but keep the other Open Graph tags', () => {
    for (const { slug, html } of rendered) {
      expect(html, slug).not.toContain('googletagmanager');
      expect(html, slug).not.toContain('gtag(');
      expect(html, slug).not.toContain('rel="canonical"');
      expect(html, slug).not.toContain('og:url');
      expect(html, slug).toContain('og:title');
      expect(html, slug).toContain('og:type');
    }
    expect(rendered.find((r) => r.slug === '404').html).toContain('<meta name="robots" content="noindex" />');
  });

  it('header keeps only Documentation and Sign In', () => {
    const html = rendered[0].html;
    const nav = html.slice(html.indexOf('<nav class="landing-nav">'), html.indexOf('</nav>'));
    const hrefs = [...nav.matchAll(/href="([^"]*)"/g)].map((m) => m[1]);
    expect(hrefs).toEqual(['/documentation', '/login']);
  });

  it('name no squiredocs.com instance URL and keep emails and distribution URLs', () => {
    for (const { slug, html } of rendered) {
      expect(html, slug).not.toMatch(/https:\/\/squiredocs\.com\/(mcp|api\/)/);
      // Every remaining squiredocs.com href is a hosted policy page or a distribution file.
      for (const m of html.matchAll(/href="https:\/\/squiredocs\.com([^"]*)"/g)) {
        expect(['/security', '/privacy', '/install.sh', '/self-host.md'], `${slug}: ${m[1]}`).toContain(m[1]);
      }
      // No relative link to a path the instance does not serve.
      for (const m of html.matchAll(/href="(\/[^"]*)"/g)) {
        expect(keepSelfHostedHref(m[1]), `${slug}: ${m[1]}`).toBe(true);
      }
    }
    const support = rendered.find((r) => r.slug === 'account-and-support').html;
    expect(support).toContain('href="mailto:security@squiredocs.com"');
    expect(support).toContain('href="https://squiredocs.com/security"');
    expect(rendered.find((r) => r.slug === 'search').html).toContain('href="https://squiredocs.com/privacy"');
    const selfHosting = rendered.find((r) => r.slug === 'self-hosting');
    if (selfHosting) {
      expect(selfHosting.html).toContain('https://squiredocs.com/install.sh');
      expect(selfHosting.html).toContain('https://squiredocs.com/self-host.md');
    }
  });

  it('mark the instance URLs in markdown.md and agents-and-mcp.md with the sentinel', () => {
    const count = (slug) => rendered.find((r) => r.slug === slug).html.split(`${ORIGIN_SENTINEL}/`).length - 1;
    expect(count('markdown')).toBe(5);
    expect(count('agents-and-mcp')).toBeGreaterThanOrEqual(4);
  });
});

describe('keepSelfHostedHref and HOSTED_ONLY_PATHS (RBD-060-25)', () => {
  it('drops mailto, /signup, hosted-only paths, and /blog/...', () => {
    for (const h of ['mailto:contact@squiredocs.com', 'MAILTO:x@y', '/signup', '/signup/', '/pricing', '/About', '/blog',
      '/blog/', '/blog/a-post', '/security', '/privacy', '/terms/', '/privacy#ai']) {
      expect(keepSelfHostedHref(h), h).toBe(false);
    }
  });

  it('keeps everything else, including hrefs it has never seen', () => {
    for (const h of ['/', '/documentation', '/documentation/self-hosting', '/login', '/agents.md',
      'https://github.com/squiredocs', 'https://squiredocs.com/pricing', '/some-new-page', '#top', '/blogger']) {
      expect(keepSelfHostedHref(h), h).toBe(true);
    }
  });

  it('agrees with the server isHostedOnlyPath for every listed path', () => {
    const { isHostedOnlyPath } = require(path.join(REPO_ROOT, 'server/web-routes.js'));
    for (const p of HOSTED_ONLY_PATHS) {
      expect(isHostedOnlyPath(p), p).toBe(true);
      expect(isHostedOnlyPath(`${p}/`), `${p}/`).toBe(true);
    }
    expect(isHostedOnlyPath('/blog/x')).toBe(true);
    expect(isHostedOnlyPath('/documentation')).toBe(false);
    expect(isHostedOnlyPath('/login')).toBe(false);
  });
});

describe('filterFooter (FR-031, FR-032)', () => {
  const hrefsOf = (html) => [...html.matchAll(/href="([^"]*)"/g)].map((m) => m[1]);

  it('keeps Documentation, Agents, GitHub, Sign In, the brand, and the copyright from today\'s FOOTER', () => {
    const f = filterFooter(FOOTER);
    expect(hrefsOf(f)).toEqual(['/', '/documentation', '/agents.md', 'https://github.com/squiredocs', '/login']);
    expect(f).toContain('<span>Squire Docs</span>');
    expect(f).toContain('class="landing-footer-tagline"');
    expect(f).toContain('&copy; 2026 21st Harmonic LLC');
    expect(f).toContain('<h4>Product</h4>');
  });

  it('drops Pricing, About, Blog, Sign Up, Privacy, Terms, the mailto, and the emptied columns', () => {
    const f = filterFooter(FOOTER);
    for (const gone of ['/pricing', '/about', '/blog', '/signup', '/privacy', '/terms', 'mailto:']) {
      expect(f).not.toContain(`href="${gone}`);
    }
    expect(f).not.toContain('<h4>Legal</h4>');
    expect(f).not.toContain('<h4>Contact</h4>');
    expect(f.match(/landing-footer-column/g)).toHaveLength(1);
  });

  it('a 062-shaped FOOTER keeps the new tagline and the Self-host link', () => {
    const shaped = FOOTER
      .replace('Write with AI, right in your doc', 'Living specs for you and your agents. Open source.')
      .replace(
        '                <li><a href="/agents.md">Agents</a></li>\n',
        '                <li><a href="/agents.md">Agents</a></li>\n                <li><a href="/documentation/self-hosting">Self-host</a></li>\n'
      );
    expect(shaped).toContain('/documentation/self-hosting');
    const f = filterFooter(shaped);
    expect(f).toContain('Living specs for you and your agents. Open source.');
    expect(f).toContain('<li><a href="/documentation/self-hosting">Self-host</a></li>');
    expect(f).not.toContain('href="/pricing"');
  });

  it('is derived from the FOOTER, not a second footer: the hosted footer is untouched', () => {
    expect(filterFooter(FOOTER)).not.toBe(FOOTER);
    const hosted = render(sourcePages[0]);
    expect(hosted).toContain(FOOTER);
  });
});

describe('filterNavHtml', () => {
  it('drops whole lines for anchors alone on a line and unwraps inline ones', () => {
    const html = '  <a href="/pricing" class="x">Pricing</a>\n  <a href="/login">Sign In</a>\n<p>See <a href="/blog">the blog</a>.</p>\n';
    expect(filterNavHtml(html)).toBe('  <a href="/login">Sign In</a>\n<p>See the blog.</p>\n');
  });
});

describe('renderVariantBody (RBD-060-24)', () => {
  const body = [
    '<pre><code>https://squiredocs.com/mcp\n</code></pre>',
    '<p>curl &quot;https://squiredocs.com/api/docs/x/export&quot;</p>',
    '<p><a href="/security">security page</a> and <a href="/privacy">privacy policy</a> and <a href="/documentation/markdown">Markdown</a></p>',
    '<p><a href="mailto:security@squiredocs.com">security@squiredocs.com</a></p>',
    '<p>https://squiredocs.com/install.sh and https://squiredocs.com/self-host.md and https://github.com/squiredocs</p>',
  ].join('\n');

  it('hosted returns the body unchanged', () => {
    expect(renderVariantBody(body, 'hosted')).toBe(body);
    expect(renderVariantBody(body)).toBe(body);
  });

  it('self-hosted marks instance URLs and absolutizes hosted-only links, and nothing else', () => {
    expect(renderVariantBody(body, 'self-hosted')).toBe([
      `<pre><code>${ORIGIN_SENTINEL}/mcp\n</code></pre>`,
      `<p>curl &quot;${ORIGIN_SENTINEL}/api/docs/x/export&quot;</p>`,
      '<p><a href="https://squiredocs.com/security">security page</a> and <a href="https://squiredocs.com/privacy">privacy policy</a> and <a href="/documentation/markdown">Markdown</a></p>',
      '<p><a href="mailto:security@squiredocs.com">security@squiredocs.com</a></p>',
      '<p>https://squiredocs.com/install.sh and https://squiredocs.com/self-host.md and https://github.com/squiredocs</p>',
    ].join('\n'));
  });
});
