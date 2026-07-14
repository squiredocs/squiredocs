# Feature Specification: Product Documentation Site

**Feature Branch**: `main` (trunk workflow; the orchestrator commits, no feature branch)

**Created**: 2026-07-14

**Status**: Draft

**Input**: User description: "A public product documentation site under /documentation/ on squiredocs.com. Pages are markdown files in the repo, rendered to static HTML at build time, served like the existing marketing pages. Design ground truth: design/product-documentation-site.md."

**Design ground truth**: `design/product-documentation-site.md` (constitution Principle VI). Where this spec and that document disagree, the design document wins.

**Decision ledger**: `specs/007-documentation-site/clarifications-needed.md` records every default chosen where the design document is silent.

## Terminology Standard *(product-wide copy requirement)*

The product name collides with a common word for product documentation. This feature adopts and enforces the standard from the design document:

- "docs" and "documents" mean Squire documents: the collaborative artifacts users create and edit in the product.
- "documentation" and "product documentation" mean written material about the product, such as the pages this feature adds.

"Docs" is never used to mean product documentation. The rule applies to all content this feature ships: documentation page content, page names and titles, sidebar labels, header and footer link labels, and any marketing page copy this feature touches. The rule also applies to product copy going forward; a retroactive audit of existing app UI copy is out of scope for this feature (ledger D8).

## User Scenarios & Testing *(mandatory)*

### User Story 1 - A visitor reads the documentation without signing in (Priority: P1)

A prospective or current user opens `https://squiredocs.com/documentation` in a browser, with no account or session. They see an index page that opens with a product description settling the docs/documentation distinction, close to: "Squire Docs is collaborative documents for spec-driven development teams. This site is the documentation for using the product." From the index they reach any of the twelve documentation pages through the sidebar and read complete, accurate material about the product.

**Why this priority**: this is the feature. Public, readable, accurate documentation is the entire value; everything else supports it.

**Independent Test**: with no authentication, request `/documentation` and each `/documentation/<slug>`; every page loads, renders styled content, and the index opens with the disambiguating product description.

**Acceptance Scenarios**:

1. **Given** a browser with no session or cookies, **When** the visitor opens `/documentation`, **Then** the index page loads with no sign-in prompt or redirect, and its first body content is the product description that disambiguates "documents" from "documentation".
2. **Given** the index page, **When** the visitor clicks any entry in the sidebar, **Then** the corresponding page loads at `/documentation/<slug>` and the sidebar highlights that page as current.
3. **Given** any of the twelve pages, **When** the visitor reads it, **Then** the content describes current product behavior (consistent with `README.md` and the `design/` documents) and follows the Writing Style Guide.
4. **Given** any documentation page, **When** the visitor searches its text for "docs" used to mean product documentation, **Then** there are zero occurrences; "docs" and "documents" appear only meaning Squire documents.

---

### User Story 2 - A visitor finds the documentation from the marketing pages (Priority: P2)

A visitor on the landing, pricing, or about page sees a "Documentation" link in the marketing header and follows it to the documentation index. On a documentation page, the same marketing header is present, so the visitor can move between documentation, pricing, about, sign in, and sign up without dead ends.

**Why this priority**: the documentation only earns traffic if the marketing pages link to it; the shared header makes the public site feel like one site.

**Independent Test**: load `/`, `/pricing`, and `/about`; each header contains a link labeled "Documentation" that resolves to `/documentation`. Load any documentation page; the same header is present.

**Acceptance Scenarios**:

1. **Given** the landing, pricing, or about page, **When** the visitor looks at the header, **Then** it contains a "Documentation" link that navigates to `/documentation`.
2. **Given** any documentation page, **When** the visitor looks at the header, **Then** it is the same marketing header, including the "Documentation" link and the sign-in and sign-up actions.
3. **Given** a phone-sized viewport on a documentation page, **When** the page loads, **Then** the sidebar is collapsed behind a toggle, the content is readable, and the toggle opens the full page list.

---

### User Story 3 - A search engine indexes the documentation (Priority: P2)

A search engine crawls the documentation pages and gets, on each page, a unique title, a meta description, a canonical URL of the form `https://squiredocs.com/documentation/<slug>`, and Open Graph tags. Traffic to the pages is measured by the same Google tag as the marketing pages.

**Why this priority**: public documentation is also an acquisition surface; without per-page metadata the pages cannot rank or unfurl correctly.

**Independent Test**: fetch each page's HTML and assert the presence and per-page uniqueness of title, meta description, canonical link, and Open Graph tags, plus the Google tag snippet used by the marketing pages.

**Acceptance Scenarios**:

1. **Given** any documentation page, **When** its HTML is fetched, **Then** the document title and meta description match that page's frontmatter `title` and `description`.
2. **Given** any documentation page, **When** its HTML is fetched, **Then** it contains a canonical link `https://squiredocs.com/documentation/<slug>` (the index canonical is `https://squiredocs.com/documentation`, ledger D1) and Open Graph tags (ledger D5).
3. **Given** any documentation page, **When** its HTML is fetched, **Then** it contains the same Google tag snippet as `client/public/landing.html`.

---

### User Story 4 - A maintainer edits a page as a markdown file (Priority: P3)

A maintainer (Sam or an agent) adds or changes documentation by editing a markdown file under `documentation/` at the repo root. In development, the change is visible on browser refresh with no build step. In production, the page was rendered to a static file at build time, so serving it involves no markdown parsing.

**Why this priority**: the authoring loop is what keeps the documentation accurate over time, but it has no user-facing value until stories 1 to 3 exist.

**Independent Test**: edit a markdown file in dev and confirm the change appears on refresh; run the client build and confirm a static HTML file per page exists under the build output; confirm the production server serves those files as-is.

**Acceptance Scenarios**:

1. **Given** a running dev server, **When** the maintainer edits a page's markdown file and refreshes the browser, **Then** the updated content renders without running a build.
2. **Given** the client build has run, **When** the output is inspected, **Then** `client/dist/documentation/` contains one complete HTML file per page (`<slug>.html`, index at `index.html`), each with the shared header, sidebar, body, and footer.
3. **Given** a page source containing raw HTML markup, **When** the page is rendered, **Then** the markup is not emitted as live HTML (no raw HTML pass-through).
4. **Given** a page file with a missing required frontmatter field or a slug that duplicates another page's, **When** the build runs, **Then** the build fails with an error naming the file and the problem (ledger D6).

---

### Edge Cases

- Unknown slug: `GET /documentation/no-such-page` returns HTTP 404 with a styled page that links to the documentation index. It must not fall through to the app shell (which would show the signed-in app or its loading state).
- Nested or malformed paths under `/documentation/` (for example `/documentation/a/b`, `/documentation/../secret`) get the same 404 treatment; path input can never select a file outside the generated documentation output (ledger D4).
- `/documentation/` with a trailing slash and `/documentation/index` both resolve to the index's canonical URL rather than serving duplicate content (ledger D1, D2).
- A signed-in user visiting `/documentation` sees the same public page as everyone else: light theme, marketing header, no app chrome, and the app's dark mode setting has no effect.
- A page's `order` collides with another page's: the build fails rather than rendering an ambiguous sidebar (ledger D6).
- Narrow screens: the sidebar collapses behind a toggle; content remains readable without horizontal scrolling.
- The client build directory is absent (fresh dev checkout, production misconfiguration): the server's existing "build the client first" behavior applies; documentation routes must not crash the server.

## Requirements *(mandatory)*

### Functional Requirements

**Terminology**

- **FR-001**: All content shipped by this feature (documentation page content, page titles and names, sidebar labels, header and footer link labels, and any marketing copy it touches) MUST use "documentation" or "product documentation" for material about the product, and MUST NOT use "docs" for that meaning. "docs" and "documents" MUST be used only to mean Squire documents.
- **FR-002**: The documentation index page MUST open with a product description that disambiguates the two meanings, close to: "Squire Docs is collaborative documents for spec-driven development teams. This site is the documentation for using the product."

**Information architecture and content**

- **FR-003**: The site MUST consist of exactly twelve pages with these slugs and scopes (from the design document):
  1. `index`: the product description, the terminology note, and a guide to the rest of the documentation.
  2. `getting-started`: signing in with Google, the welcome document, creating and finding documents.
  3. `editing`: rich-text formatting, headings, lists and task lists, code, links.
  4. `images-and-diagrams`: inserting images, Mermaid diagram blocks, SVG blocks, and copy and paste behavior.
  5. `collaboration-and-sharing`: real-time editing, presence, offline editing, the Owner, Editor, and Viewer roles, sharing, and invitations.
  6. `version-history`: automatic versions, named versions, diffs, and restore.
  7. `ai-assistant`: the chat panel and chat-centric mode, adding a selection to chat, image upload, inline diffs and undo, credits, and bring-your-own-key.
  8. `search`: content search across documents, combining full-text and semantic matching.
  9. `agents-and-mcp`: connecting external agents over MCP, OAuth and API tokens, what agents can do, and how agent edits are attributed.
  10. `markdown`: export (flavors, frontmatter, bundles), import (create, append, replace), and two-way repo sync.
  11. `appearance`: the Light, Dark, and System theme settings.
  12. `account-and-support`: settings, API tokens, bring-your-own-key API keys, and getting support.
- **FR-004**: Page content MUST describe current product behavior, sourced from `README.md` and the `design/` documents. Behavior neither source describes MUST be verified against the product or omitted, never invented. Each page MUST cover its full scope listed in FR-003 (comprehensive coverage, not stubs).
- **FR-005**: Page content MUST follow the Writing Style Guide. Request examples (curl) MUST appear only where a user needs them to act, such as markdown export and API tokens.
- **FR-006**: Content changes that alter user-visible behavior MUST update the affected documentation pages in the same change, the same rule `README.md` follows (design document; constitution Principle I). The spec records this as an ongoing obligation the feature creates.

**Page sources**

- **FR-007**: Each page MUST be a markdown file under `documentation/` at the repo root, one file per page.
- **FR-008**: Each file MUST carry YAML frontmatter with `slug`, `title`, `description` (used as the meta description), and `order` (sidebar position). The index page uses slug `index`.
- **FR-009**: The build MUST fail with an error naming the file and the problem when a page is missing a required frontmatter field, duplicates another page's `slug`, or duplicates another page's `order` (ledger D6).

**Build-time rendering**

- **FR-010**: A build step, run as part of the client build, MUST render each markdown file into a complete HTML page from a shared template containing the marketing header, a documentation sidebar listing every page in `order`, the page body, and a footer (footer choice: ledger D3).
- **FR-011**: Build output MUST be `client/dist/documentation/<slug>.html`, with the index at `client/dist/documentation/index.html`.
- **FR-012**: Markdown MUST be parsed at build time only. In production, serving a documentation page MUST NOT involve markdown parsing or template rendering at request time.
- **FR-013**: The renderer MUST NOT pass raw HTML from page sources through to output. Raw HTML in a source file is escaped or dropped, never emitted as live markup. (The content is first-party, so the constitution Principle V import-surface policy for untrusted markdown does not apply; this rule exists to keep pages plain markdown.)
- **FR-014**: The rendered markdown feature set is the standard constructs listed in ledger D7. Mermaid rendering is not required on documentation pages.

**Serving**

- **FR-015**: The server MUST serve `GET /documentation` and `GET /documentation/<slug>` publicly, with no authentication, session, or cookies required, alongside the existing marketing routes.
- **FR-016**: A request for an unknown slug under `/documentation/` MUST return HTTP status 404 with a styled page that links to the documentation index. It MUST NOT fall through to the app shell.
- **FR-017**: Request paths MUST NOT be able to select any file outside the generated documentation output (no path traversal; nested paths get the 404 treatment) (ledger D4).
- **FR-018**: `/documentation/` (trailing slash) and `/documentation/index` MUST resolve to the index's canonical URL, `https://squiredocs.com/documentation`, via permanent redirect (ledger D1, D2).
- **FR-019**: In development, the dev server MUST render documentation pages on request through middleware, so a content edit shows up on browser refresh without a build step, mirroring how the marketing pages are served in dev.

**Navigation**

- **FR-020**: The marketing header on the landing, pricing, and about pages MUST gain a link labeled "Documentation" that navigates to `/documentation`. Documentation pages MUST use the same header.
- **FR-021**: The marketing footer's Product column MUST gain the same "Documentation" link, and documentation pages MUST reuse the marketing footer (ledger D3).
- **FR-022**: The sidebar MUST list all twelve pages in `order` and highlight the current page.
- **FR-023**: On narrow screens the sidebar MUST collapse behind a toggle; page content MUST remain readable without horizontal scrolling.

**SEO and analytics**

- **FR-024**: Each page MUST set its document title and meta description from its frontmatter `title` and `description`.
- **FR-025**: Each page MUST declare a canonical URL of the form `https://squiredocs.com/documentation/<slug>`; the index canonical is `https://squiredocs.com/documentation` (ledger D1).
- **FR-026**: Each page MUST carry Open Graph tags: `og:title`, `og:description`, `og:type`, and `og:url` matching the canonical URL. No `og:image` is required (ledger D5).
- **FR-027**: Each page MUST include the same Google tag snippet as the marketing pages (`client/public/landing.html`).
- **FR-028**: Page headings below the title MUST carry stable anchor ids so sections can be deep-linked (ledger D9).

**Appearance**

- **FR-029**: Documentation pages MUST match the marketing pages: light theme, styled by `marketing.css` plus documentation-specific rules. The app's Light/Dark/System theme setting MUST NOT affect these pages.

### Key Entities

- **Documentation page**: one unit of product documentation. Attributes: `slug` (URL segment and output filename; unique), `title` (page name, document title, sidebar label), `description` (meta description), `order` (sidebar position; unique), and a markdown body. Source of truth is one markdown file under `documentation/`; the rendered form is one static HTML file.
- **Shared page template**: the frame every rendered page shares: marketing header, sidebar (all pages in order, current page highlighted), page body, footer, per-page metadata (title, description, canonical, Open Graph, analytics snippet).

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: A visitor with no account can open the documentation index and reach any of the twelve pages in one click from the sidebar; all thirteen requests (index plus twelve slugs, where index is one of the twelve) succeed without any sign-in prompt.
- **SC-002**: All twelve pages exist, are non-stub (each covers every scope item listed for it in FR-003), and a terminology scan of the rendered pages, the sidebar, and the new header and footer labels finds zero uses of "docs" meaning product documentation.
- **SC-003**: Requesting ten unknown slugs under `/documentation/` yields ten HTTP 404 responses, each rendering a page with a working link to the documentation index, and none rendering the app shell.
- **SC-004**: Every page is fully rendered before deployment: after a production build, serving any documentation page reads only prebuilt files, and deleting the markdown sources from a deployed image would not change what is served.
- **SC-005**: In development, a content edit is visible after only a browser refresh, with no build command, within 5 seconds.
- **SC-006**: Each page's fetched HTML has a title, meta description, and canonical URL unique to that page, Open Graph tags, and the marketing Google tag snippet; the landing, pricing, and about headers each link to `/documentation`.
- **SC-007**: On a 375 px wide viewport, every page is readable without horizontal scrolling and the full page list is reachable through the sidebar toggle.

## Assumptions

- The existing marketing serving pattern (static files from the client build in production, dev-server middleware in dev) extends to the documentation pages; no new hosting or infrastructure is involved.
- Documentation pages are static and identical for every visitor; nothing on them is personalized, so public caching is acceptable.
- The twelve-page set is fixed for this feature. Adding a page later means adding a markdown file with frontmatter; the sidebar and index derive from the file set, so no page list is maintained by hand anywhere else.
- Sam pre-authorized defaults for decisions the design document leaves open (2026-07-14). Every such default is recorded in `clarifications-needed.md` as RATIFIED-BY-DEFAULT; material silences in the design document are flagged there as gaps, not resolved ad hoc.
- The Writing Style Guide referenced by the design document governs page prose; its rules (plain words, lead with what a thing is, no em dashes, and so on) are applied to all page content.
- `/privacy` and `/terms` remain served by the app shell as today; this feature does not change them.
