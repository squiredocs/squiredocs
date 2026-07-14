# Clarifications Ledger: 007-documentation-site

Design ground truth is `design/product-documentation-site.md`. Each entry below covers a point the design document leaves open. Decisions carry the best default and are marked RATIFIED-BY-DEFAULT (Sam pre-authorized, 2026-07-14). Gaps are material silences that need a design-doc amendment or an explicit call from Sam; they are flagged, not decided.

## Decisions

### D1: Canonical URL and route for the index page

- **Question**: The index page's slug is `index` and its output file is `index.html`. What is its canonical URL, and what happens on a request for `/documentation/index`?
- **Chosen default**: The canonical URL is `https://squiredocs.com/documentation`. Requests for `/documentation/index` permanently redirect to `/documentation`.
- **Rationale**: One canonical URL per page avoids duplicate-content indexing. `/documentation` is the address Sam's directive names and the address the header link uses.
- RATIFIED-BY-DEFAULT (Sam pre-authorized, 2026-07-14)

### D2: Trailing-slash handling

- **Question**: Sam's directive says "under /documentation/" while the design document names the routes `GET /documentation` and `GET /documentation/<slug>`. How are trailing-slash requests handled?
- **Chosen default**: `/documentation/` permanently redirects to `/documentation`. `/documentation/<slug>/` permanently redirects to `/documentation/<slug>`. Canonical URLs have no trailing slash.
- **Rationale**: The design document's route list is the more specific statement, and it uses no trailing slashes. Redirecting rather than 404ing keeps hand-typed URLs working.
- RATIFIED-BY-DEFAULT (Sam pre-authorized, 2026-07-14)

### D3: Which footer, and a footer Documentation link

- **Question**: The design document says each rendered page includes "a footer" without saying which one, and says the header gains a Documentation link without mentioning the footer.
- **Chosen default**: Documentation pages reuse the existing marketing footer. The footer's Product column (currently Pricing, About, Agents, Sign Up, Sign In) gains a "Documentation" link on the marketing pages and the documentation pages.
- **Rationale**: The pages are specified to look and serve like the marketing pages; reusing the marketing footer is the smallest consistent reading. A Product-column link matches how every other public page is cross-linked there.
- RATIFIED-BY-DEFAULT (Sam pre-authorized, 2026-07-14)

### D4: 404 page form and path safety

- **Question**: The design document requires a 404 page linking to the documentation index for unknown slugs but does not describe the page or say what happens for nested or traversal-shaped paths.
- **Chosen default**: The 404 page is built from the same shared template (marketing header, link to the documentation index), served with HTTP status 404. Any path under `/documentation/` that is not exactly a known slug, including nested paths like `/documentation/a/b` and traversal attempts, gets this same response. Request paths can never select a file outside the generated documentation output.
- **Rationale**: A styled 404 keeps the visitor on the public site. Treating "not exactly a known slug" as 404 is the simplest rule that closes path traversal by construction.
- RATIFIED-BY-DEFAULT (Sam pre-authorized, 2026-07-14)

### D5: Open Graph tag set, no og:image

- **Question**: The design document requires "Open Graph tags" without listing them.
- **Chosen default**: Each page carries `og:title`, `og:description`, `og:type` (`website`), and `og:url` matching the canonical URL. No `og:image`.
- **Rationale**: This matches the existing marketing pages: `landing.html` ships exactly these four properties and no `og:image`. Adding imagery the marketing pages lack would be new design work the design document did not ask for.
- RATIFIED-BY-DEFAULT (Sam pre-authorized, 2026-07-14)

### D6: Frontmatter validation fails the build

- **Question**: The design document defines required frontmatter (`slug`, `title`, `description`, `order`) but not what happens when a file is invalid.
- **Chosen default**: The build fails with an error naming the file and the problem when any page is missing a required field, duplicates another page's `slug`, or duplicates another page's `order`.
- **Rationale**: A silently dropped or misordered page is a content defect nobody would notice until a visitor did. Failing the build is the only gate that runs on every change.
- RATIFIED-BY-DEFAULT (Sam pre-authorized, 2026-07-14)

### D7: Markdown feature set for page bodies

- **Question**: The design document says pages are "plain markdown" with no raw HTML pass-through, but does not enumerate supported constructs.
- **Chosen default**: Headings, paragraphs, bold, italic, inline code, links, ordered and unordered lists, fenced code blocks, blockquotes, tables, and images referencing first-party static assets. No Mermaid rendering on documentation pages. The initial twelve pages are text plus fenced code examples (curl); screenshots may be added later as static assets.
- **Rationale**: This is the set the twelve pages' content actually needs, including curl examples for export and tokens. Mermaid on static pages would drag the app's rendering stack into the marketing surface for no specified need.
- RATIFIED-BY-DEFAULT (Sam pre-authorized, 2026-07-14)

### D8: Terminology rule enforcement scope in this feature

- **Question**: The design document says the docs/documentation rule "applies to the documentation site, UI copy, the marketing pages, and design docs going forward." Does this feature audit existing app UI copy?
- **Chosen default**: This feature enforces the rule on everything it ships or touches: documentation content, page names, sidebar and link labels, and the marketing header and footer changes. It does not audit or rewrite existing app UI copy.
- **Rationale**: "Going forward" reads as a standard for new and touched copy, not a retroactive sweep. An app-wide copy audit is a separately scoped effort (see Gap G1).
- RATIFIED-BY-DEFAULT (Sam pre-authorized, 2026-07-14)

### D9: Heading anchors, no in-page table of contents

- **Question**: The design document specifies the sidebar but says nothing about linking to sections within a page.
- **Chosen default**: Section headings get stable anchor ids so support replies and other pages can deep-link to a section. No per-page table of contents and no per-section sidebar entries.
- **Rationale**: Anchor ids are near-free at render time and make twelve fairly long pages linkable. A section-level navigation layer is real design work the design document did not ask for.
- RATIFIED-BY-DEFAULT (Sam pre-authorized, 2026-07-14)

### D10: Search engine indexing posture

- **Question**: The design document specifies SEO metadata but says nothing about robots or a sitemap, and the repo ships neither today.
- **Chosen default**: Documentation pages are indexable (no robots restrictions added). No sitemap work in this feature.
- **Rationale**: The SEO section (canonical URLs, meta descriptions, Open Graph) only makes sense for indexable pages. The site has no sitemap today; introducing one is a separate decision (see Gap G2).
- RATIFIED-BY-DEFAULT (Sam pre-authorized, 2026-07-14)

## Gaps (flagged, not decided)

### G1: Retroactive terminology audit of existing app UI copy

The design document extends the docs/documentation rule to "UI copy" but does not say whether existing signed-in app copy should be audited and corrected now. D8 scopes this feature to the copy it ships or touches. Whether to run an app-wide audit (and marketing-page audit beyond the surfaces this feature touches) needs Sam's call or a design-doc amendment.

### G2: Sitemap for the public site

The public site (landing, pricing, about, and now thirteen documentation URLs counting the index) has no sitemap.xml. The design document is silent. Worth a decision once the documentation pages exist, since they are the pages a sitemap would help most.

### G3: Entry point from the signed-in app

The design document adds a Documentation link only to the marketing header. It does not say whether signed-in users should be able to reach the documentation from inside the app (for example from the user menu, near "Get Support"). No in-app link is added in this feature; flagging because signed-in users are the most likely readers of pages like `agents-and-mcp` and `markdown`.

### G4: Documentation versus README overlap policy

The design document makes documentation pages follow the same keep-current rule as `README.md`, which means two prose descriptions of most features will now exist (README for developers, documentation for users). It does not say whether README should eventually slim down or point at the documentation. No change to README is made in this feature (and this agent is barred from editing it); the long-term relationship needs a call.
