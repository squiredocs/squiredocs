# Contract: Documentation routes and build (007)

Two contracts: the HTTP route table the server exposes, and the build
input/output contract.

## HTTP routes

Public, no authentication, no session, no cookies (FR-015). Registered by
`mountDocumentationRoutes(app, docsDistDir)` from `server/documentation-routes.js`,
inside the existing `if (fs.existsSync(clientBuildPath))` block in
`server/index.js`, **before** the `app.get('*')` app-shell catch-all. At mount
time the module reads `docsDistDir` once and builds a Set of known slugs from
the `<slug>.html` files, excluding `index.html` and `404.html`.

| Method + path | Condition | Response |
|---------------|-----------|----------|
| `GET /documentation` | no trailing slash | 200, `index.html` |
| `GET /documentation/` | trailing slash | 301 -> `/documentation` (D2) |
| `GET /documentation/:slug` | `slug === 'index'` | 301 -> `/documentation` (D1) |
| `GET /documentation/:slug/` | trailing slash | 301 -> `/documentation/:slug` (D2) |
| `GET /documentation/:slug` | slug in known set | 200, `<slug>.html` |
| `GET /documentation/:slug` | slug not in known set | 404, `404.html` |
| `GET /documentation/:a/:b...` | nested path | 404, `404.html` (D4, FR-016) |

Rules:
- Redirects are HTTP 301 (permanent). Canonical URLs carry no trailing slash
  (D1, D2, FR-018).
- The 404 response body is the styled `404.html` (shared template, links to the
  documentation index) served with status 404. It must never fall through to the
  app shell (FR-016, Edge Cases).
- A request path can only ever select a fixed `<slug>.html` filename from the
  known-slug Set. Caller input is never concatenated into a filesystem path, so
  `..`, encoded separators, and nested segments cannot escape `docsDistDir`
  (FR-017, D4). They all resolve to the 404 route.
- No markdown parsing or template rendering happens at request time (FR-012).
- If `docsDistDir` is absent, the known-slug Set is empty and the routes still
  respond (404 for slugs) without crashing the server (Edge Cases).

### Development parity (Vite middleware, FR-019)

The `client/vite.config.js` documentation middleware serves the same paths with
the same status codes and redirects, but renders each page on request from the
`documentation/*.md` sources through the render module, so a content edit shows
up on refresh with no build (SC-005). Dev and production must not diverge in
routing behavior.

## Build contract

`client/scripts/build-documentation.mjs`, run by `npm run build` in `client`
after `vite build`:

**Input**: `documentation/*.md` at the repo root, each with `slug`, `title`,
`description`, `order` frontmatter and a markdown body.

**Validation**: the full page-set validation from `data-model.md` (missing
field, malformed frontmatter, duplicate slug, duplicate order, invalid slug
shape, terminology violation). Any failure prints the file and problem and exits
non-zero (D6, FR-009).

**Rendering** (via `render-documentation.mjs`, shared with the dev middleware):
- Markdown parsed with `markdown-it` configured `{ html: false }`, so raw HTML
  in a source is escaped and never emitted as live markup (FR-013).
- Construct set: headings, paragraphs, bold, italic, inline code, links, ordered
  and unordered lists, fenced code blocks, blockquotes, tables, and images to
  first-party static assets (D7). No Mermaid rendering (D7, FR-014).
- Every heading below the title gets a stable, de-duplicated anchor id (D9,
  FR-028).
- Each page is wrapped in the shared template (`data-model.md`, Shared page
  template).

**Output**: `client/dist/documentation/<slug>.html` (index at
`index.html`) plus `client/dist/documentation/404.html` (FR-011, D4). Each file
is a complete, self-contained HTML page with header, sidebar, body, footer, and
metadata (US4 acceptance 2). No markdown remains to parse at request time
(FR-012, SC-004).
