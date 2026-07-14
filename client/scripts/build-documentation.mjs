#!/usr/bin/env node
/**
 * build-documentation.mjs — render the product documentation site (feature 007).
 *
 * Reads documentation/*.md at the repo root, validates the whole page set,
 * enforces the terminology gate, renders every page plus a 404 page through the
 * shared render module, and writes client/dist/documentation/<slug>.html,
 * index.html, and 404.html.
 *
 * Wired into the client build as `vite build && node
 * scripts/build-documentation.mjs`, so it runs after Vite has emptied dist.
 * Markdown is parsed only here, at build time (FR-012).
 *
 * Exits non-zero with the offending file and problem on any validation or
 * terminology failure (D6 / FR-009 / FR-001). Patterned on check-color-tokens.mjs.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  parseFrontmatter,
  validatePages,
  renderBody,
  renderPage,
  render404,
  findTerminologyViolations,
} from './render-documentation.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DOCS_SRC_DIR = path.resolve(__dirname, '../../documentation');
const OUT_DIR = path.resolve(__dirname, '../dist/documentation');

/**
 * Read and parse every documentation/*.md file. Returns an array of
 * { file, slug, title, description, order, body, error }.
 */
export function loadPages(srcDir = DOCS_SRC_DIR) {
  if (!fs.existsSync(srcDir)) {
    throw new Error(`documentation source directory not found: ${srcDir}`);
  }
  const files = fs
    .readdirSync(srcDir)
    .filter((f) => f.endsWith('.md'))
    .sort();
  return files.map((name) => {
    const file = path.join('documentation', name);
    const text = fs.readFileSync(path.join(srcDir, name), 'utf8');
    const { frontmatter, body, error } = parseFrontmatter(text);
    return { file, frontmatter, body, error };
  });
}

/**
 * Run the terminology gate over the page sources (bodies + titles + slugs).
 * Returns an array of error strings.
 */
export function terminologyErrors(pages) {
  const errors = [];
  for (const page of pages) {
    const fm = page.frontmatter || {};
    const surfaces = [
      ['body', page.body || ''],
      ['title', fm.title || ''],
      ['description', fm.description || ''],
    ];
    for (const [where, text] of surfaces) {
      const hits = findTerminologyViolations(text);
      for (const hit of hits) {
        errors.push(`${page.file}: "${hit}" in ${where} uses "docs" to mean product documentation (use "documentation")`);
      }
    }
  }
  return errors;
}

function fail(messages) {
  console.error('build-documentation — FAILED:\n');
  for (const m of messages) console.error(`  ${m}`);
  console.error('\nFix the offending documentation source(s) and rebuild.');
  process.exit(1);
}

export function build({ srcDir = DOCS_SRC_DIR, outDir = OUT_DIR } = {}) {
  const pages = loadPages(srcDir);

  if (pages.length === 0) {
    fail(['no documentation/*.md source files found']);
  }

  // Structural + set validation (D6 / FR-009).
  const validationErrors = validatePages(pages);
  // Terminology gate (FR-001).
  const termErrors = terminologyErrors(pages);
  const allErrors = [...validationErrors, ...termErrors];
  if (allErrors.length > 0) {
    fail(allErrors);
  }

  // All pages valid: render.
  const allPages = pages.map((p) => ({
    slug: p.frontmatter.slug,
    title: p.frontmatter.title,
    order: p.frontmatter.order,
  }));

  fs.mkdirSync(outDir, { recursive: true });

  for (const p of pages) {
    const bodyHtml = renderBody(p.body);
    const html = renderPage({
      page: {
        slug: p.frontmatter.slug,
        title: p.frontmatter.title,
        description: p.frontmatter.description,
        bodyHtml,
      },
      allPages,
    });
    // Terminology gate over the rendered body too (catches anything the source
    // scan structure missed).
    const renderedHits = findTerminologyViolations(bodyHtml);
    if (renderedHits.length > 0) {
      fail(renderedHits.map((h) => `${p.file}: "${h}" appears in rendered output`));
    }
    fs.writeFileSync(path.join(outDir, `${p.frontmatter.slug}.html`), html, 'utf8');
  }

  // Styled 404 page (D4 / FR-016).
  fs.writeFileSync(path.join(outDir, '404.html'), render404({ allPages }), 'utf8');

  console.log(
    `build-documentation — OK: wrote ${pages.length} page(s) + 404.html to ${path.relative(process.cwd(), outDir)}`
  );
  return { count: pages.length, outDir };
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  build();
}
