# Tasks: Product Documentation Site

**Feature**: 007-documentation-site | **Input**: `plan.md`, `research.md`, `data-model.md`, `contracts/documentation-routes.md`, `quickstart.md`, `spec.md`

**Workflow**: trunk (`main`); the orchestrator commits. Tests are included (requested by the spec's acceptance scenarios and success criteria).

**Content-source rule (FR-004)**: every content page task names its source sections in `README.md` and `design/`. Behavior that neither source describes must be verified against the product or omitted, never invented.

**Story legend**: US1 public readable docs (P1); US2 found from marketing pages (P2); US3 search-engine indexable (P2); US4 maintainer authoring loop (P3); US5 in-app entry point (FR-030, Sam-ratified G3). The FR-031 terminology sweep (Sam-ratified G1) is cross-cutting (Polish phase).

---

## Phase 1: Setup

- [X] T001 Add `markdown-it` to `devDependencies` in `client/package.json` and run `cd client && npm install`; confirm it does not enter the runtime bundle (build-only).
- [X] T002 [P] Create `client/public/documentation.css` with the base documentation layout: two-column page (sidebar + content), prose width and typography consistent with `marketing.css`, sidebar list styles, and current-page highlight. Light theme only (FR-029). (Responsive/mobile rules are added in T024.)
- [X] T003 Update the `build` script in `client/package.json` to `vite build && node scripts/build-documentation.mjs` so the documentation build runs as part of `npm run build`, after Vite empties `dist` (FR-010, research R5).

## Phase 2: Foundational (blocking prerequisites for all stories)

- [X] T004 Create `client/scripts/render-documentation.mjs` exporting `parseFrontmatter(text)` and `validatePages(pages)`: strict scalar frontmatter parser (only `slug`, `title`, `description`, `order`; `order` integer) and set validation that returns errors for missing field, malformed frontmatter, duplicate slug, duplicate order, and invalid slug shape `^[a-z0-9-]+$` (data-model.md; D6/FR-009).
- [X] T005 In `client/scripts/render-documentation.mjs`, add `renderBody(markdown)` using `markdown-it` configured `{ html: false }` (raw HTML escaped, never emitted — FR-013) over the D7 construct set, and `slugify`/heading-anchor logic giving every heading a stable, de-duplicated anchor id (D9/FR-028, research R3).
- [X] T006 In `client/scripts/render-documentation.mjs`, add the shared template `renderPage({ page, allPages, canonicalOrigin })`: Google tag snippet identical to `client/public/landing.html` (FR-027); `<head>` title + meta description from frontmatter (FR-024); `<link rel="canonical">` and Open Graph `og:title`/`og:description`/`og:type`=website/`og:url` with no `og:image` (D1/D5/FR-025/FR-026); `/marketing.css` and `/documentation.css` links (FR-029); marketing header with the "Documentation" link and sign-in/sign-up actions (FR-020); sidebar of all pages in `order` with the current page marked `aria-current="page"` inside a `<details>` disclosure (FR-022/FR-023, research R9); rendered body; marketing footer with the Product-column "Documentation" link (D3/FR-021). (data-model.md Shared page template).
- [X] T007 In `client/scripts/render-documentation.mjs`, add `render404({ allPages, canonicalOrigin })` (same template, body links to the documentation index — D4/FR-016) and `findTerminologyViolations(text)` that flags "docs" used to mean product documentation while allowing "docs"/"documents" meaning Squire documents and the product name "Squire Docs" (FR-001, research R8).
- [X] T008 Create `client/scripts/build-documentation.mjs` (ESM CLI, patterned on `client/scripts/check-color-tokens.mjs`): read `documentation/*.md` at the repo root, run `validatePages` and the terminology gate (fail the build with the file name and problem on any violation — D6/FR-009/FR-001), render every page plus `404.html` via the render module, and write `client/dist/documentation/<slug>.html`, `index.html`, and `404.html` (FR-011/FR-012, contracts build section).
- [X] T009 Create `server/documentation-routes.js` exporting `mountDocumentationRoutes(app, docsDistDir)` (CommonJS, no markdown, no new dependency): read `docsDistDir` once into a known-slug Set (excluding `index.html`, `404.html`); register `GET /documentation`, `GET /documentation/:slug`, and `GET /documentation/*` with the status codes, 301 canonical redirects, styled 404, and traversal-proof behavior in `contracts/documentation-routes.md` (FR-015/FR-016/FR-017/FR-018, D1/D2/D4).
- [X] T010 Mount the documentation routes in `server/index.js` by calling `mountDocumentationRoutes(app, path.join(clientBuildPath, 'documentation'))` inside the `if (fs.existsSync(clientBuildPath))` block, immediately before `app.get('*')`, so unknown slugs never fall through to the app shell (FR-016). Handle the missing-directory case without crashing (Edge Cases).

**Checkpoint**: the render pipeline, build, and production serving exist. Stories below can proceed.

## Phase 3: User Story 1 - Public, readable documentation (P1)

**Goal**: twelve public, accurate, non-stub pages reachable from the sidebar with no sign-in. **Independent test**: request `/documentation` and each `/documentation/<slug>` with no auth; every page loads and the index opens with the disambiguating product description.

Content pages (each writes `documentation/<slug>.md` with frontmatter `slug`/`title`/`description`/`order` and a body following the Writing Style Guide; curl examples only where a user needs them — FR-004/FR-005):

- [X] T011 [P] [US1] `documentation/index.md` (order 1): product description opening close to FR-002, the terminology note, and a guide to the rest of the documentation. Sources: `design/product-documentation-site.md`, `design/index.md`, README "Features".
- [X] T012 [P] [US1] `documentation/getting-started.md` (order 2): signing in with Google, the welcome document, creating and finding documents. Sources: README "Onboarding / Welcome Flow", "Features", "UI/UX Features" (Document List, Editor Interface); `design/authentication-and-sharing.md`.
- [X] T013 [P] [US1] `documentation/editing.md` (order 3): rich-text formatting, headings, lists and task lists, code, links. Sources: README "Editor Interface", "Hierarchical Document Editing"; `design/document-model-format-pipeline.md`, `design/collaboration-core.md`.
- [X] T014 [P] [US1] `documentation/images-and-diagrams.md` (order 4): inserting images, Mermaid diagram blocks, SVG blocks, copy and paste behavior. Sources: `design/media-and-diagram-blocks.md`; README copy/paste (screenshots).
- [X] T015 [P] [US1] `documentation/collaboration-and-sharing.md` (order 5): real-time editing, presence, offline editing, Owner/Editor/Viewer roles, sharing, invitations. Sources: `design/collaboration-core.md`, `design/authentication-and-sharing.md`; README "Document Roles", "Sharing Interface".
- [X] T016 [P] [US1] `documentation/version-history.md` (order 6): automatic versions, named versions, diffs, restore. Sources: README "Version History" (How It Works, UI Navigation, Restoring Versions, Diff Highlighting).
- [X] T017 [P] [US1] `documentation/ai-assistant.md` (order 7): chat panel and chat-centric mode, adding a selection to chat, image upload, inline diffs and undo, credits, bring-your-own-key. Sources: `design/in-app-ai-assistant.md`; README "In-App AI Assistant" (How It Works, Usage Limits, Display Modes, View Toggle).
- [X] T018 [P] [US1] `documentation/search.md` (order 8): content search across documents combining full-text and semantic matching. Sources: `design/content-search.md`.
- [X] T019 [P] [US1] `documentation/agents-and-mcp.md` (order 9): connecting external agents over MCP, OAuth and API tokens, what agents can do, how agent edits are attributed; curl examples where a user needs them. Sources: `design/agent-surface-mcp.md`; README "AI Agent Integration (Model Context Protocol)"; `client/public/agents.md`.
- [X] T020 [P] [US1] `documentation/markdown.md` (order 10): export (flavors, frontmatter, bundles), import (create, append, replace), two-way repo sync; curl examples for export and API endpoints. Sources: `design/markdown-import-two-way-sync.md`; README "Markdown Import Surfaces", "Two-Way Sync", "API Endpoints".
- [X] T021 [P] [US1] `documentation/appearance.md` (order 11): the Light, Dark, and System theme settings. Sources: `design/ui-theming-dark-mode.md`.
- [X] T022 [P] [US1] `documentation/account-and-support.md` (order 12): settings, API tokens, bring-your-own-key API keys, getting support (contact@squiredocs.com / `/support`). Sources: README "Configuration" (Environment Variables, MCP OAuth Secrets), BYOK; `design/authentication-and-sharing.md`.
- [X] T023 [US1] Add `server/__tests__/documentation-routes.test.js` (Jest + supertest, fixture `docsDistDir`): assert public 200 for `/documentation` and a known slug with no auth, 301 for `/documentation/index` (SC-001), 404 with a body linking to the index for an unknown slug and that it does not render the app shell (SC-003), and that a traversal-shaped path selects nothing outside the fixture dir (FR-017). (research R8, contracts route table.)

## Phase 4: User Story 2 - Found from the marketing pages (P2)

**Goal**: the marketing pages link to the documentation and documentation pages carry the same chrome; the sidebar collapses on narrow screens. **Independent test**: each marketing header links to `/documentation`; a documentation page shows the same header; at 375 px the sidebar toggle reveals the full page list.

- [X] T024 [US2] Add responsive rules to `client/public/documentation.css`: at narrow widths the `<details>` sidebar collapses behind its toggle and the content reads in one column with no horizontal scroll; force the sidebar open on wide viewports (FR-023, SC-007, research R9).
- [X] T025 [P] [US2] Add a "Documentation" link (`href="/documentation"`) to the header nav and the footer Product column of `client/public/landing.html` (FR-020, FR-021, D3).
- [X] T026 [P] [US2] Add the same header and footer "Documentation" link to `client/public/pricing.html`.
- [X] T027 [P] [US2] Add the same header and footer "Documentation" link to `client/public/about.html`.
- [X] T028 [US2] Add a chrome/link test to `client/src/__tests__/documentation-build.test.js`: assert each marketing page's header and footer link to `/documentation` (SC-006) and that the rendered documentation template's header and footer carry the same structural markers as `client/public/landing.html` (drift-guard, research R8).

## Phase 5: User Story 3 - Indexable by search engines (P2)

**Goal**: each page has per-page SEO metadata and the marketing analytics tag. **Independent test**: fetch each page's HTML and assert unique title, meta description, canonical, Open Graph tags, and the Google tag snippet.

- [X] T029 [US3] Add an SEO test to `client/src/__tests__/documentation-build.test.js`: render each page and assert the `<title>` and meta description equal the frontmatter and are unique per page, the canonical URL is `https://squiredocs.com/documentation/<slug>` (index `https://squiredocs.com/documentation`), the four Open Graph tags are present with no `og:image`, and the Google tag snippet matches `client/public/landing.html` (FR-024 through FR-027, SC-006). If any assertion fails, complete the corresponding template output in `render-documentation.mjs` (T006).

## Phase 6: User Story 4 - Maintainer authoring loop (P3)

**Goal**: edit a markdown file, refresh, see the change in dev; the build validates frontmatter and never emits raw HTML. **Independent test**: edit in dev and see the change on refresh; run the build and confirm one static HTML file per page; confirm invalid frontmatter fails the build.

- [X] T030 [US4] Add the documentation dev middleware to `client/vite.config.js` alongside `staticPagesPlugin`: intercept `/documentation` and `/documentation/<slug>`, render from `../documentation/*.md` through `render-documentation.mjs` on request, and apply the same index redirect, trailing-slash redirect, unknown-slug 404, and nested-path 404 as production (FR-019, SC-005, contracts dev-parity).
- [X] T031 [US4] Add build-validation tests to `client/src/__tests__/documentation-build.test.js`: `validatePages` fails on a missing required field, a duplicate `slug`, and a duplicate `order` (D6/FR-009); `renderBody` escapes raw HTML rather than emitting it (FR-013); headings receive stable anchor ids (FR-028). (research R8.)

## Phase 7: User Story 5 - In-app entry point (G3, Sam-ratified, P2)

**Goal**: signed-in users reach the documentation from the user menu. **Independent test**: open the user profile menu and confirm a "Documentation" item near "Get Support" opens `/documentation` in a new tab and reads correctly in Light and Dark themes.

- [X] T032 [US5] Add a "Documentation" item to the user profile menu in `client/src/components/UserProfileBadge.jsx`, near the "Get Support" item, opening `/documentation` in a new tab (`target="_blank"`, `rel="noopener"`). Follow the existing `user-menu-item` markup and styling and use the dark-mode color tokens per `design/ui-theming-dark-mode.md` (FR-030, G3).
- [X] T033 [US5] Add a component test (Vitest, `client/src/__tests__/`) asserting the user menu renders a "Documentation" item linking to `/documentation` and opening in a new tab (FR-030).

## Phase 8: Polish & cross-cutting (FR-031 terminology audit)

- [X] T034 Terminology audit (FR-031, G1): sweep user-facing copy in `client/src/**` (component labels, buttons, menu items, headings, empty states) and the marketing pages (`client/public/landing.html`, `pricing.html`, `about.html`) for "docs" used to mean product documentation, and fix each label to use "documentation"/"product documentation". Do NOT rename the `/docs` document-list route path or change "docs"/"documents" meaning Squire documents or the product name "Squire Docs" (FR-031). Record the surfaces swept.
- [X] T035 Extend the terminology test in `client/src/__tests__/documentation-build.test.js` to scan the documentation sources, the rendered pages, the sidebar and link labels, and the audited copy from T034, asserting zero uses of "docs" meaning product documentation (FR-001, FR-031, SC-002).
- [X] T036 Run `cd client && npm run build` and confirm `client/dist/documentation/` holds `index.html`, `404.html`, and twelve `<slug>.html` files, each a complete self-contained page (SC-004, US4 acceptance 2).
- [X] T037 Run the full suites: `npm run test:server` (serially) and `npm run test:client`; confirm the new route, render, validation, SEO, drift-guard, terminology, and menu tests pass (constitution II).
- [X] T038 Walk `quickstart.md` scenarios US1 through US5 plus the edge-case curls (404, nested, traversal, index redirect) and the 375 px responsive check; record results.

## Dependencies

- Setup (T001-T003) before everything.
- Foundational (T004-T010) blocks all user stories. Within it: T004 -> T005 -> T006 -> T007 (same file, sequential); T008 depends on T004-T007; T009 -> T010; T008 and T009 are independent of each other.
- US1 content pages (T011-T022) depend on the template (T006) and can then run in parallel [P]. T023 depends on T009-T010.
- US2 (T024-T028) depends on T006 (template) and the marketing pages; T025-T027 are parallel [P]. T028 depends on T025-T027.
- US3 (T029) depends on T006.
- US4 (T030-T031) depends on T004-T007. T030 depends on the render module.
- US5 (T032-T033) depends only on the route existing (T010) for the link target; otherwise independent of US1-US4 and can run in parallel with them.
- Polish (T034-T038): T034 before T035; T036-T038 last (need all prior tasks).

## Parallel execution examples

- After T006, launch the twelve content pages together: T011, T012, T013, T014, T015, T016, T017, T018, T019, T020, T021, T022 (all `[P]`, distinct files).
- After T006, the three marketing-page edits run together: T025, T026, T027.
- US5 (T032-T033) can proceed in parallel with the US1 content work once T010 lands.

## Implementation strategy

MVP is User Story 1 (P1): the render pipeline (T004-T008), production serving
(T009-T010), the twelve content pages (T011-T022), and the route test (T023).
That delivers public, readable, accurate documentation. US2 and US3 (both P2)
make it discoverable and indexable; US5 (P2, G3) adds the in-app entry point;
US4 (P3) hardens the authoring loop; Phase 8 runs the G1 terminology audit and
the final verification.
