# Research: Product Documentation Site (007)

Phase 0 output. Every technical unknown from the plan is resolved here with a
decision, a rationale, and the alternatives that were rejected. Product-level
decisions (canonical URLs, footer choice, OG tag set, and so on) are already
settled in `clarifications-needed.md` (D1 through D10) and are not repeated here.

## R1: Markdown renderer

**Decision**: Add `markdown-it` as a devDependency of the client
(`client/package.json`), configured with `{ html: false }`.

**Rationale**:
- `html: false` is the exact behavior FR-013 and D7 require: raw HTML in a
  source file is escaped and emitted as text, never as live markup. This is a
  first-class option, not a post-processing step, so raw HTML cannot leak
  through by accident.
- The default preset already renders the full D7 construct set: headings,
  paragraphs, bold, italic, inline code, links, ordered and unordered lists,
  fenced code blocks, blockquotes, tables, and images. No plugins are needed for
  the twelve pages' content.
- It runs at build time only, so it never enters the server or the client
  runtime bundle. It stays a devDependency.
- It is small, dependency-light, and actively maintained.

**Alternatives considered**:
- `marked`: passes raw HTML through by default and offers no built-in option to
  escape it. Preventing HTML pass-through would require a custom lexer or a
  post-sanitize pass, which is more code and a weaker guarantee than
  `html: false`.
- The in-house registry-driven markdown pipeline (constitution Technology
  constraint): that pipeline serializes the Yjs/ProseMirror document model to
  markdown and back for the product's documents. It does not render arbitrary
  markdown files to standalone HTML pages, so it does not fit this job. Using a
  build-only third-party renderer for static marketing-adjacent pages does not
  touch the single-registry rule (Principle IV), which governs the document
  format pipeline, not static page rendering. Recorded so the divergence is
  explicit.

## R2: YAML frontmatter parsing and validation

**Decision**: Parse frontmatter with a small, strict, scalar-only parser written
in the render module. It accepts a `---` fenced block at the top of the file
containing only the four keys `slug`, `title`, `description`, `order`, each a
single-line scalar. `order` must parse as an integer. Anything else (an unknown
key, a missing key, a non-integer order, a repeated key) is a validation error.

**Rationale**:
- The four fields are simple scalars, so a full YAML engine is not required.
- A strict parser is the validation. It rejects malformed frontmatter by
  construction, which is exactly what D6 and FR-009 ask the build to do.
- It keeps the new-dependency footprint at one (the renderer), matching the
  plan's "one small library" constraint.

**Alternatives considered**:
- `js-yaml`: already present in the repo root `node_modules` and resolvable from
  client scripts by Node's upward module resolution. Rejected as the primary
  choice because relying on an implicitly hoisted root dependency from the
  client build is fragile, and because a permissive YAML parser would accept
  shapes (nested maps, anchors, multi-line scalars) that the strict validator
  would then have to reject anyway. It remains a low-cost fallback if the
  frontmatter grammar ever needs to grow.

## R3: Heading anchor ids (D9 / FR-028)

**Decision**: Generate anchor ids in a custom markdown-it heading renderer rule.
Slugs are GitHub-style: lowercase, spaces to hyphens, non-alphanumerics
dropped, with a numeric suffix (`-1`, `-2`) to de-duplicate collisions within a
page. Ids are attached to every heading below the page title.

**Rationale**: Stable, deep-linkable ids at near-zero render cost, no extra
dependency. A separate anchor plugin (`markdown-it-anchor`) would add a second
dependency for roughly fifteen lines of slugging logic. No in-page table of
contents and no per-section sidebar entries (D9).

## R4: Shared template and where it lives

**Decision**: The shared template is code in the render module
(`client/scripts/render-documentation.mjs`), not a checked-in HTML partial. It
emits a complete document per page: the Google tag snippet, per-page metadata
(title, description, canonical, Open Graph), the `/marketing.css` and
`/documentation.css` stylesheet links, the marketing header (with the new
Documentation link), the sidebar, the rendered body, and the marketing footer.

**Rationale**:
- The marketing pages are full standalone HTML files
  (`client/public/landing.html`), not composable partials. The header and footer
  markup is copied into the template function verbatim so documentation pages
  render byte-consistent chrome. A drift-guard test (see R8) keeps the copied
  header and footer in agreement with `landing.html`.
- Documentation-specific styling (sidebar, two-column layout, prose width, the
  mobile toggle) lives in a new `client/public/documentation.css`. Placing it in
  `client/public` means Vite copies it to `client/dist/documentation.css`
  automatically, and the server serves it exactly like `marketing.css`. No
  manual copy step.

## R5: Build wiring and output

**Decision**: A Node ESM CLI, `client/scripts/build-documentation.mjs`, reads
`documentation/*.md` at the repo root, validates the full page set, renders each
page plus a `404.html` through the shared template, and writes
`client/dist/documentation/`. It is wired into the client build as
`"build": "vite build && node scripts/build-documentation.mjs"`.

**Rationale**:
- Vite empties `dist` at the start of its build (`emptyOutDir` default), so the
  documentation build must run after `vite build`, not before.
- Running it inside `client`'s `npm run build` satisfies FR-010 ("run as part of
  the client build") without changing the root build script, which already
  delegates to `cd client && npm run build`.
- Markdown is parsed only here, at build time (FR-012). The output is static
  HTML files with no markdown left to parse at request time.

## R6: Production serving (Express)

**Decision**: Extract the documentation routes into
`server/documentation-routes.js` (CommonJS, no markdown, no new dependency),
mounted from `server/index.js` inside the existing
`if (fs.existsSync(clientBuildPath))` block, before the `app.get('*')` app-shell
catch-all. At mount time it reads `client/dist/documentation/` once and builds a
Set of known slugs from the `<slug>.html` files (excluding `index.html` and
`404.html`). Routes, in order:

1. `GET /documentation`: serve `index.html`. If the request path has a trailing
   slash, 301 redirect to `/documentation` (D2).
2. `GET /documentation/:slug`:
   - `slug === 'index'` -> 301 redirect to `/documentation` (D1).
   - trailing slash -> 301 redirect to `/documentation/:slug` (D2).
   - slug in the known set -> serve `<slug>.html`.
   - otherwise -> serve `404.html` with HTTP status 404.
3. `GET /documentation/*` (nested or traversal-shaped paths) -> serve `404.html`
   with HTTP status 404 (D4, FR-016, FR-017).

**Rationale**:
- The known-slug Set closes path traversal by construction: a request path can
  only ever select a fixed `<slug>.html` filename from the set, never a
  caller-supplied path. `..`, encoded separators, and nested segments all fall
  to the 404 route (FR-017, D4).
- Registering before the catch-all is what stops an unknown slug from falling
  through to the app shell (FR-016, Edge Cases).
- 301 (permanent) redirects match D1 and D2; canonical URLs carry no trailing
  slash.
- No markdown parsing, no template rendering, no auth, no database, no new
  runtime dependency at request time. This stays inside the constraints the plan
  sets ("no new runtime dependencies in the server, no auth changes").
- If `client/dist/documentation/` is absent (fresh checkout, misbuild), the
  mount reads an empty slug set and the routes still respond without crashing;
  the existing "build the client first" branch already covers the wider missing
  build case (Edge Cases).

## R7: Development serving (Vite middleware)

**Decision**: Add a documentation middleware to `client/vite.config.js`,
alongside `staticPagesPlugin`. It intercepts `/documentation` and
`/documentation/<slug>`, imports the render module, reads the source markdown
from `../documentation`, renders on the fly, and returns the HTML. It applies the
same index redirect, trailing-slash redirect, unknown-slug 404, and nested-path
404 semantics as production, so dev and production behave the same. HMR is
disabled in this repo, so a browser refresh after an edit is the expected loop
(FR-019, SC-005).

**Rationale**: Mirrors how the marketing pages are already served in dev
(`staticPagesPlugin`) and reuses the exact render module the build uses, so a
page cannot render one way in dev and another at build time.

## R8: Tests

**Decision**: Follow the two established repo patterns.

1. **Server routes** (Jest + supertest, `server/__tests__/documentation-routes.test.js`):
   mount `mountDocumentationRoutes` on a bare Express app pointed at a fixture
   directory of a few fake built pages plus a `404.html`. Assert: public 200 for
   the index and a known slug with no auth; 301 for `/documentation/index` and
   for trailing-slash paths; 404 (status and a body linking to the index) for an
   unknown slug and for a nested path; and that a traversal-shaped path cannot
   select a file outside the fixture directory. Using a fixture dir keeps the
   test hermetic and independent of a full client build.
2. **Render and validation** (Vitest, `client/src/__tests__/documentation-build.test.js`,
   importing pure functions from `client/scripts/render-documentation.mjs`,
   mirroring how `color-tokens.lint.test.js` imports from
   `scripts/check-color-tokens.mjs`): assert frontmatter validation fails on a
   missing field, a duplicate slug, and a duplicate order (D6, FR-009); assert
   raw HTML in a body is escaped, not emitted (FR-013); assert headings get
   stable anchor ids (FR-028); and run the terminology scan over the real
   `documentation/` sources and the rendered output, asserting zero uses of
   "docs" meaning product documentation (FR-001, SC-002).
3. **Chrome drift-guard** (Vitest): assert the template's rendered header and
   footer contain the same structural markers as `client/public/landing.html`
   (logo, nav actions, footer Product column), the same style as the existing
   `agents-md-claims.test.js` drift-guard.

**Terminology check as a build gate**: the terminology scan is also run inside
`build-documentation.mjs` and fails the build on a violation. It is cheap and it
enforces FR-001 on every build, not only in the test suite. The scan targets the
`documentation/` sources, the rendered bodies, the sidebar labels, and the new
header and footer link labels. It does not scan the wider marketing pages (D8:
this feature does not audit existing copy) and it does not flag the product name
"Squire Docs" or the words "document"/"documents"/"docs" used to mean Squire
documents; it flags "docs" used to mean product documentation.

## R9: Mobile sidebar toggle (FR-023, SC-007)

**Decision**: Implement the narrow-screen sidebar as a native `<details>`
disclosure (a `<summary>` toggle plus the page list), forced open on wide
viewports via CSS and collapsible on narrow ones. No JavaScript.

**Rationale**: A `<details>` element is keyboard- and screen-reader-accessible
with no script, which keeps the pages fully static (SC-004) and dependency-free.
Content stays in a single readable column at 375 px with no horizontal scroll
(SC-007).

## Constitution alignment notes

- Principle I (docs reflect reality): this feature creates an ongoing obligation
  (FR-006) that behavior changes update the affected documentation page. It does
  not edit `README.md` or `docs/dev.md` (the plan agent is barred from those, and
  Gap G4 flags the long-term README/documentation overlap for a separate call).
- Principle IV (single format registry): untouched. The build-only renderer does
  not render the product document model; see R1.
- Principle V (secure by default): the documentation content is first-party, so
  the untrusted-markdown import-surface policy does not apply (design doc; FR-013
  note). `html: false` plus the traversal-proof slug set are the relevant
  hardening.
- Principle VI (design docs are ground truth): all defaults are recorded in
  `clarifications-needed.md`; the four open gaps (G1 through G4) are flagged
  there, not decided here.
