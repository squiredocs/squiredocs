# Implementation Plan: Product Documentation Site

**Branch**: `main` (trunk workflow; the orchestrator commits, no feature branch) | **Date**: 2026-07-14 | **Spec**: `specs/007-documentation-site/spec.md`

**Input**: Feature specification from `specs/007-documentation-site/spec.md`

**Design ground truth**: `design/product-documentation-site.md` (constitution Principle VI). **Decision ledger**: `specs/007-documentation-site/clarifications-needed.md`.

## Summary

Add a public product documentation site under `/documentation/` on
squiredocs.com. Twelve pages are markdown files under `documentation/` at the
repo root. A build-time Node script renders each file to a complete static HTML
page through a shared template (marketing header, sidebar, body, marketing
footer, per-page SEO metadata, Google tag). Express serves the generated files
publicly alongside the existing marketing routes, with a styled 404, canonical
redirects, and no path traversal. In development, a Vite middleware renders the
same pages on request so an edit shows up on refresh with no build. The
technical approach reuses the existing marketing serving pattern
(`staticPagesPlugin` in dev, static files from `client/dist` in production) and
adds exactly one build-only dependency, `markdown-it`.

## Scope amendments from Sam's gap rulings (2026-07-14)

Sam ruled on the four gaps flagged in `clarifications-needed.md`. These are
Sam-ratified (not RATIFIED-BY-DEFAULT) and change scope relative to the spec as
first drafted:

- **G1 RESOLVED, audit IN scope (now spec FR-031)**: a retroactive terminology
  sweep of existing app UI copy, the marketing pages (landing, pricing, about),
  and other user-facing strings is now part of this feature. This supersedes
  ledger D8; the spec has been updated to match (line 22 and FR-031). The sweep
  fixes uses of "docs" meaning product documentation. It does not rename the
  `/docs` document-list route path (that path is the document list, not a
  documentation reference) and it leaves "docs"/"documents" meaning Squire
  documents and the product name "Squire Docs" as they are. Copy labels are the
  target, not route paths. (Tasks in Phase 8.)
- **G2 RESOLVED, out of scope**: no `sitemap.xml` in this feature. Confirms D10.
- **G3 RESOLVED, in-app link IN scope (now spec FR-030)**: the signed-in app
  gains a "Documentation" item in the user profile menu
  (`client/src/components/UserProfileBadge.jsx`), near "Get Support", opening
  `/documentation` in a new tab. Because it is in-app UI it uses the dark-mode
  color tokens per `design/ui-theming-dark-mode.md`. (Tasks in Phase 7, User
  Story 5.)
- **G4 RESOLVED**: `README.md` narrows to developer and operator material over
  time; the documentation site owns user-facing feature descriptions. No README
  rewrite and no README tasks in this feature (README and docs edits are handled
  in the merge queue per the operating overrides).

## Technical Context

**Language/Version**: Node.js 22+ (build script and server, both existing).
Client is ESM (`"type": "module"`); server is CommonJS.

**Primary Dependencies**: New: `markdown-it` (client devDependency, build-time
only). Existing: Express (serving), Vite (dev middleware and client build),
React 18 (only for the one in-app menu item, G3). No new server runtime
dependency.

**Storage**: None. Pages are markdown files under `documentation/`; rendered
output is static HTML under `client/dist/documentation/`. No database, no
migration.

**Testing**: Jest + supertest for the server routes
(`server/__tests__/`); Vitest for the render module and validation
(`client/src/__tests__/`), matching the existing `color-tokens.lint.test.js`
pattern.

**Target Platform**: Public web (same hosting as the marketing pages).

**Project Type**: Web application (existing client + server monorepo).

**Performance Goals**: Static file serving in production (no per-request
markdown parsing, FR-012). Dev edit visible on refresh within 5 seconds
(SC-005).

**Constraints**: No auth on documentation routes (FR-015). No path traversal
(FR-017). Raw HTML never emitted as live markup (FR-013). Light theme only; the
app's dark mode does not affect these pages (FR-029). No new server runtime
dependency, no database migration, no auth change.

**Scale/Scope**: Twelve documentation pages plus a 404 page. Three marketing
pages gain a header and footer link. One in-app menu item (G3). A bounded
terminology sweep of existing app and marketing copy (G1).

## Constitution Check

*GATE: evaluated before Phase 0 and re-checked after design. No violations.*

- **I. Documentation Reflects Reality**: This feature creates an ongoing
  obligation (FR-006) that user-visible behavior changes update the affected
  documentation page, the same rule README follows. The plan does not edit
  `README.md` or `docs/dev.md` (G4; the plan agent is barred from them). PASS.
- **II. Test-Backed Changes**: Server route tests and render/validation tests
  are planned (R8). No format-registry change, so the round-trip suite is not
  affected. Backend tests run serially (existing config). PASS.
- **III. Trunk-Based Solo Workflow**: Work stays on `main`; the orchestrator
  commits. No new ceremony. PASS.
- **IV. Collaboration-Safe Document Operations**: Not touched. The build-only
  markdown renderer does not render the product document model and does not
  enter the format registry (research R1). PASS.
- **V. Secure by Default**: Documentation content is first-party, so the
  untrusted-markdown import policy does not apply (design doc; FR-013 note). The
  relevant hardening is `html: false` (no raw HTML pass-through) and the
  traversal-proof known-slug set (FR-017). No new ingestion surface. PASS.
- **VI. Design Docs Are Ground Truth**: `design/product-documentation-site.md`
  is the source; every default is recorded in `clarifications-needed.md`; the
  four gaps are now resolved by Sam and recorded there as Sam-ratified. PASS.

No entries in Complexity Tracking.

## Project Structure

### Documentation (this feature)

```text
specs/007-documentation-site/
├── plan.md              # This file
├── research.md          # Phase 0 output
├── data-model.md        # Phase 1 output
├── quickstart.md        # Phase 1 output
├── contracts/
│   └── documentation-routes.md   # Route + build contract
├── clarifications-needed.md      # Decision ledger (D1-D10) + Sam gap rulings (G1-G4)
└── tasks.md             # Phase 2 output (/speckit-tasks)
```

### Source Code (repository root)

```text
documentation/                         # NEW: twelve markdown page sources (repo root)
├── index.md
├── getting-started.md
├── editing.md
├── images-and-diagrams.md
├── collaboration-and-sharing.md
├── version-history.md
├── ai-assistant.md
├── search.md
├── agents-and-mcp.md
├── markdown.md
├── appearance.md
└── account-and-support.md

client/
├── scripts/
│   ├── render-documentation.mjs       # NEW: pure render library (frontmatter parse,
│   │                                  #      validate, markdown render, slugger, template,
│   │                                  #      404, terminology scan) — reused by build + dev + tests
│   └── build-documentation.mjs        # NEW: CLI, reads documentation/*.md, validates,
│   │                                  #      writes client/dist/documentation/
│   └── check-color-tokens.mjs         # existing (pattern to follow)
├── public/
│   └── documentation.css              # NEW: sidebar/layout/prose styles (copied to dist by Vite)
├── vite.config.js                     # MODIFIED: add documentation dev middleware
├── package.json                       # MODIFIED: add markdown-it devDep; build runs doc build
├── public/landing.html                # MODIFIED: header + footer Documentation link (G1 label scope)
├── public/pricing.html                # MODIFIED: header + footer Documentation link
├── public/about.html                  # MODIFIED: header + footer Documentation link
└── src/
    ├── components/UserProfileBadge.jsx        # MODIFIED (G3): in-app Documentation menu item
    └── __tests__/documentation-build.test.js  # NEW: render + validation + terminology + drift-guard

server/
├── documentation-routes.js            # NEW: mountDocumentationRoutes(app, docsDir) — CommonJS
├── index.js                           # MODIFIED: mount doc routes before app.get('*')
└── __tests__/documentation-routes.test.js     # NEW: public/404/redirect/traversal route tests
```

**Structure Decision**: Reuse the existing web-app monorepo layout. The render
logic is a build-time client script (matching `check-color-tokens.mjs`); the
serving logic is an extracted CommonJS server module mounted from
`server/index.js`; the dev loop is a Vite middleware next to the existing
`staticPagesPlugin`. Documentation-specific CSS lives in `client/public` so Vite
copies it to `dist` and the server serves it exactly like `marketing.css`.

## Phase 0: Research

Complete. See `research.md`. Key decisions: `markdown-it` with `html: false` as
the one new (build-only) dependency (R1); a strict scalar frontmatter parser
that doubles as validation (R2); custom heading-anchor slugging with no extra
dependency (R3); a code-based shared template with a chrome drift-guard against
`landing.html` (R4, R8); build wired as `vite build && node
scripts/build-documentation.mjs` (R5); traversal-proof known-slug Express routes
before the catch-all (R6); a Vite dev middleware reusing the render module (R7);
a `<details>` mobile sidebar with no JS (R9). No NEEDS CLARIFICATION remain.

## Phase 1: Design & Contracts

Complete. See `data-model.md` (Documentation page and Shared page template
entities, frontmatter validation rules) and
`contracts/documentation-routes.md` (the route table with status codes,
redirects, and the 404/traversal behavior, plus the build input/output
contract). `quickstart.md` gives the runnable validation scenarios that prove
each user story.

Post-design Constitution re-check: no change, no violations.

## Complexity Tracking

No violations to justify.
