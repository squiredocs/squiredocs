#!/usr/bin/env node
/**
 * build-blog.mjs — render the static blog.
 *
 * Reads blog/*.md at the repo root, validates the whole post set, renders every
 * post plus the index and a 404 page through the shared render module, and
 * writes client/dist/blog/<slug>.html, index.html, and 404.html.
 *
 * Wired into the client build after build-documentation.mjs, so it runs once
 * Vite has emptied dist. Markdown is parsed only here, at build time.
 *
 * Exits non-zero with the offending file and problem on any validation failure.
 * Patterned on build-documentation.mjs.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  parseFrontmatter,
  validatePosts,
  renderBody,
  renderPostPage,
  renderIndexPage,
  render404,
} from './render-blog.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BLOG_SRC_DIR = path.resolve(__dirname, '../../blog');
const OUT_DIR = path.resolve(__dirname, '../dist/blog');

/** Read and parse every blog/*.md file. */
export function loadPosts(srcDir = BLOG_SRC_DIR) {
  if (!fs.existsSync(srcDir)) {
    throw new Error(`blog source directory not found: ${srcDir}`);
  }
  const files = fs
    .readdirSync(srcDir)
    .filter((f) => f.endsWith('.md'))
    .sort();
  return files.map((name) => {
    const file = path.join('blog', name);
    const text = fs.readFileSync(path.join(srcDir, name), 'utf8');
    const { frontmatter, body, error } = parseFrontmatter(text);
    return { file, frontmatter, body, error };
  });
}

function fail(messages) {
  console.error('build-blog — FAILED:\n');
  for (const m of messages) console.error(`  ${m}`);
  console.error('\nFix the offending blog source(s) and rebuild.');
  process.exit(1);
}

export function build({ srcDir = BLOG_SRC_DIR, outDir = OUT_DIR } = {}) {
  const posts = loadPosts(srcDir);

  if (posts.length === 0) {
    fail(['no blog/*.md source files found']);
  }

  const validationErrors = validatePosts(posts);
  if (validationErrors.length > 0) {
    fail(validationErrors);
  }

  const summaries = posts.map((p) => ({
    slug: p.frontmatter.slug,
    title: p.frontmatter.title,
    description: p.frontmatter.description,
    date: p.frontmatter.date,
    author: p.frontmatter.author,
  }));

  fs.mkdirSync(outDir, { recursive: true });

  for (const p of posts) {
    const bodyHtml = renderBody(p.body);
    const html = renderPostPage({
      post: {
        slug: p.frontmatter.slug,
        title: p.frontmatter.title,
        description: p.frontmatter.description,
        date: p.frontmatter.date,
        author: p.frontmatter.author,
        bodyHtml,
      },
    });
    fs.writeFileSync(path.join(outDir, `${p.frontmatter.slug}.html`), html, 'utf8');
  }

  fs.writeFileSync(path.join(outDir, 'index.html'), renderIndexPage({ posts: summaries }), 'utf8');
  fs.writeFileSync(path.join(outDir, '404.html'), render404({}), 'utf8');

  console.log(
    `build-blog — OK: wrote ${posts.length} post(s) + index.html + 404.html to ${path.relative(process.cwd(), outDir)}`
  );
  return { count: posts.length, outDir };
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  build();
}
