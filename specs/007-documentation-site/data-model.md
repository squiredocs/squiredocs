# Data Model: Product Documentation Site (007)

There is no database in this feature. The "data" is the set of markdown page
files and the frontmatter each carries. This document defines the two entities
from the spec and the validation rules the build enforces.

## Entity: Documentation page

One unit of product documentation. Source of truth is one markdown file under
`documentation/` at the repo root. The rendered form is one static HTML file
under `client/dist/documentation/`.

| Field | Type | Required | Rule |
|-------|------|----------|------|
| `slug` | string | yes | URL segment and output filename. Must match `^[a-z0-9-]+$`. Unique across all pages. The index page uses `index`. |
| `title` | string | yes | Page name. Used as the document `<title>`, the sidebar label, and the on-page heading. |
| `description` | string | yes | Used as the `<meta name="description">` and `og:description`. |
| `order` | integer | yes | Sidebar position. Unique across all pages. |
| body | markdown | yes | The page content, below the title. Plain markdown only (D7). |

**Derived at render time**:
- Output path: `client/dist/documentation/<slug>.html` (index at
  `client/dist/documentation/index.html`), FR-011.
- Canonical URL: `https://squiredocs.com/documentation/<slug>`; the index
  canonical is `https://squiredocs.com/documentation` (D1, FR-025).
- Heading anchor ids: GitHub-style slugs, de-duplicated within the page (D9,
  FR-028).

### Validation rules (build fails on any, D6 / FR-009)

The build reads all page files, then validates the set as a whole. On any
failure it prints an error naming the offending file and the problem, and exits
non-zero:

1. **Missing required field**: any of `slug`, `title`, `description`, `order`
   absent or empty.
2. **Malformed frontmatter**: no `---` fenced block, an unknown key, a repeated
   key, or an `order` that is not an integer.
3. **Duplicate slug**: two pages share a `slug`.
4. **Duplicate order**: two pages share an `order`.
5. **Invalid slug shape**: `slug` does not match `^[a-z0-9-]+$`.
6. **Terminology violation** (FR-001, and G1 for the copy this feature ships):
   a source body, a title, a sidebar label, or a rendered page uses "docs" to
   mean product documentation.

The page set for this feature is fixed at twelve (FR-003). The sidebar and the
index are derived from the file set, so no page list is maintained by hand
anywhere else (spec Assumptions).

## Entity: Shared page template

The frame every rendered page shares. It is code in
`client/scripts/render-documentation.mjs`, not a checked-in HTML partial. It
produces, in order:

1. The Google tag snippet, identical to `client/public/landing.html` (FR-027).
2. Per-page `<head>` metadata: `<title>` and `<meta name="description">` from
   frontmatter (FR-024); `<link rel="canonical">` (FR-025); Open Graph tags
   `og:title`, `og:description`, `og:type` (`website`), `og:url` matching the
   canonical, and no `og:image` (D5, FR-026).
3. Stylesheet links: `/marketing.css` and `/documentation.css` (FR-029).
4. The marketing header, including the new "Documentation" link and the sign-in
   and sign-up actions, structurally identical to `landing.html` (FR-020).
5. The sidebar: all twelve pages listed in `order`, the current page marked with
   `aria-current="page"` and an active class (FR-022). On narrow screens the
   sidebar is a `<details>` disclosure behind a toggle (FR-023, R9).
6. The rendered page body.
7. The marketing footer, reused from `landing.html`, whose Product column gains
   the "Documentation" link (D3, FR-021).

The 404 page is rendered from this same template with a body that links to the
documentation index (D4, FR-016).
