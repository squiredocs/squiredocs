<!-- source: https://squiredocs.com/d/247d3036-14c5-4f6e-adc6-b90f36cc80d8
     synced-by: design/sync.mjs — DO NOT HAND-EDIT; amend the Squire doc and re-sync -->

# Squire Product Documentation Site

The documentation site is a set of public web pages under `/documentation/` on squiredocs.com that explain what Squire Docs is and how to use it. Pages are written as markdown files in the repo, rendered to static HTML at build time, and served the same way as the existing marketing pages (landing, pricing, about). No sign-in is required to read them.

## Terminology

The product name collides with a common word for product documentation, so usage is standardized:

- "docs" and "documents" mean Squire documents: the collaborative artifacts users create and edit in the product.
- "documentation" and "product documentation" mean written material about the product, such as the pages on this site.

"Docs" is never used to mean product documentation. This rule applies to the documentation site, UI copy, the marketing pages, and design docs going forward. Existing app UI copy and marketing copy are audited for violations as part of this feature, and violations are fixed (Sam, 2026-07-14).

The documentation index page opens with a product description that settles the distinction for the reader, close to: "Squire Docs is collaborative documents for spec-driven development teams. This site is the documentation for using the product."

## Page sources

- Pages are markdown files under `documentation/` at the repo root, one file per page.
- Each file carries YAML frontmatter with `slug`, `title`, `description` (used as the meta description), and `order` (sidebar position). The index page uses slug `index`.
- Page content follows the [Writing Style Guide](https://squiredocs.com/d/887930a2-b5ed-4a64-9c36-5c4d0ae3c3fb).
- Documentation describes current behavior. A feature that changes user-visible behavior updates the affected pages in the same change, the same rule README.md follows.
- Division of labor with README.md: the documentation site owns user-facing feature descriptions; README.md narrows to developer and operator material over time. Both stay accurate when behavior changes (Sam, 2026-07-14).

## Build and serving

- A build script renders each markdown file into a complete HTML page from a shared template: the marketing header, a documentation sidebar listing every page in order, the page body, and a footer. Output goes to `client/dist/documentation/<slug>.html`, with the index at `client/dist/documentation/index.html`.
- The script runs as part of the client build (`npm run build`). Markdown is parsed at build time only; production serves static files and parses nothing at request time.
- The renderer does not pass raw HTML through; pages are plain markdown. The content is first-party, so the import-surface policy for untrusted markdown (constitution Principle V) does not apply here.
- Express serves `GET /documentation` and `GET /documentation/<slug>` from the generated files, alongside the existing marketing routes. An unknown slug under `/documentation/` returns a 404 page that links to the documentation index; it does not fall through to the app shell.
- The Vite dev server renders documentation pages on request through a middleware, so a content edit shows up on refresh without a build step. This mirrors how the marketing pages are served in dev.

## Information architecture

Twelve pages. Each documents user-visible behavior, with request examples (curl) only where a user needs them, such as export and tokens.

1. `index`, Overview: the product description and a guide to the rest of the documentation. The opening description settles the docs vs documentation distinction; the page carries no separate wording section (Sam, 2026-07-14).
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

## Navigation

- The marketing header on the landing, pricing, and about pages gains a "Documentation" link. Documentation pages use the same header.
- The sidebar lists all pages in order and highlights the current page. On narrow screens the sidebar collapses behind a toggle.
- The signed-in app links to the documentation: a "Documentation" item in the user profile menu, next to "Get Support", opens /documentation in a new tab (Sam, 2026-07-14).

## SEO and analytics

- Each page sets its title and meta description from frontmatter, a canonical URL of the form `https://squiredocs.com/documentation/<slug>`, and Open Graph tags.
- Each page includes the same Google tag snippet as the marketing pages.
- The site ships without a sitemap.xml; pages are indexable and reachable through links (Sam, 2026-07-14).

## Appearance

Documentation pages match the marketing pages: light theme, styled by `marketing.css` plus documentation-specific rules. The app's dark mode applies to the signed-in app, not to these public pages.