# Quickstart: Product Documentation Site (007)

Runnable validation scenarios that prove each user story. Commands run inside
the Minikube `app-dev` pod (see `docs/dev.md`). Paths are repo-relative.

## Prerequisites

- `markdown-it` installed as a client devDependency (`cd client && npm install`).
- Twelve page files present under `documentation/`.

## Build the documentation

```bash
cd client && npm run build
ls dist/documentation/           # expect index.html, 404.html, and one <slug>.html per page
```

Confirms FR-010, FR-011, and SC-004 (every page prebuilt). Deleting the
`documentation/*.md` sources after this build does not change what is served.

## US1 - Public, readable documentation (P1)

```bash
# With the built client and the server running, no auth:
curl -s -o /dev/null -w '%{http_code}\n' http://localhost:3001/documentation          # 200
for s in index getting-started editing images-and-diagrams collaboration-and-sharing \
         version-history ai-assistant search agents-and-mcp markdown appearance \
         account-and-support; do
  curl -s -o /dev/null -w "$s %{http_code}\n" "http://localhost:3001/documentation/$s"
done
```

`index` returns 301 to `/documentation`; every other slug returns 200 with no
sign-in prompt (SC-001). The index body opens with the product description that
disambiguates documents from documentation (FR-002). A terminology scan of the
rendered pages finds zero uses of "docs" meaning product documentation (SC-002),
enforced by the build gate and the Vitest terminology test.

## US2 - Found from the marketing pages (P2)

```bash
grep -o 'href="/documentation"' client/public/landing.html client/public/pricing.html client/public/about.html
```

Each marketing header and the footer Product column link to `/documentation`
(FR-020, FR-021, SC-006). A documentation page carries the same header and
footer. At a 375 px viewport the sidebar collapses behind the `<details>` toggle
and content reads with no horizontal scroll (FR-023, SC-007) — verify in a
browser or with the responsive check.

## US3 - Indexable by search engines (P2)

```bash
curl -s http://localhost:3001/documentation/search | \
  grep -E '<title>|name="description"|rel="canonical"|og:(title|description|type|url)|googletagmanager'
```

Each page has a title, meta description, and canonical URL unique to it, the four
Open Graph tags (no `og:image`), and the same Google tag snippet as
`landing.html` (FR-024 through FR-027, SC-006).

## US4 - Maintainer authoring loop (P3)

```bash
# Dev server running (npm run dev). Edit a page, then refresh the browser:
#   the change appears within 5 seconds, no build command (SC-005, FR-019).
```

Validate build-time guards:
- A page missing a required frontmatter field, or a duplicate `slug`, or a
  duplicate `order`, fails the build with a message naming the file (FR-009).
- A source body containing raw HTML renders the markup escaped, not live
  (FR-013). Both are covered by `client/src/__tests__/documentation-build.test.js`.

Edge cases:
```bash
curl -s -o /dev/null -w '%{http_code}\n' http://localhost:3001/documentation/no-such-page   # 404
curl -s -o /dev/null -w '%{http_code}\n' http://localhost:3001/documentation/a/b            # 404
curl -s -o /dev/null -w '%{http_code}\n' 'http://localhost:3001/documentation/../secret'    # 404, no traversal
curl -s -o /dev/null -w '%{redirect_url}\n' http://localhost:3001/documentation/index       # /documentation
```

Covered by `server/__tests__/documentation-routes.test.js`.

## US5 - In-app entry point (G3, Sam-ratified)

Sign in, open the user profile menu (`UserProfileBadge`), and confirm a
"Documentation" item near "Get Support" opens `/documentation` in a new tab. The
item uses the dark-mode color tokens, so it reads correctly in Light and Dark
themes.

## Terminology audit (G1, Sam-ratified)

```bash
# Sweep app + marketing user-facing copy for "docs" meaning product documentation.
# The /docs route path (document list) is NOT a violation; labels are the target.
```

Fix any label that uses "docs" to mean product documentation. Verified by the
terminology test over the surfaces this feature ships and the audited copy.
