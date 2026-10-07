# Implementation Plan: Open Source Launch Messaging

**Branch**: `062-oss-launch-messaging` | **Date**: 2026-10-07 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `specs/062-oss-launch-messaging/spec.md`

**Design ground truth**: "Proposal: Open Source Launch Messaging" (Squire doc
`f4f528c7-ee50-4356-b181-cbfd282ab744`, ratified 2026-10-07, D1 to D8, D3
amended to name MIT); `design/self-hosting-local-mode.md` (D1 to D12) for
self-hosting claims; Sam's writing style guide (Squire doc
`887930a2-b5ed-4a64-9c36-5c4d0ae3c3fb`) for prose.

## Summary

Rewrite the copy of `client/public/landing.html`, `pricing.html`, and
`about.html`, add "GitHub" and "Self-host" to the header nav of those three
pages and `security.html`, change the shared footer tagline (and add a
"Self-host" footer link) in `client/scripts/site-footer.mjs`, and add a
copy-rules scan test that keeps the launch copy rules (FR-030 to FR-038) from
regressing. Everything is static HTML and one pure ES module plus its Vitest
test. No server code, routes, migrations, or React.

The implementation branch ships at the launch gate (D5, FR-042): it is built and
verified now, then held unmerged until the merge-queue owner (the "mayor"
session) merges it after the repository is public and feature 060 has merged.
The spec, plan, and tasks merge to main as usual.

## Technical Context

**Language/Version**: HTML5 and CSS (static pages); JavaScript ES modules on Node.js 22 for the checker and test

**Primary Dependencies**: None new. Vitest (existing client test runner); the existing `client/scripts/site-footer.mjs` and `sync-footer.mjs`

**Storage**: N/A

**Testing**: Vitest in `client/` (`npm run test:client` from the root, wired into the root `npm test` and `.github/workflows/test.yml`). New suite `client/src/__tests__/marketing-copy-rules.test.js`; existing `client/src/__tests__/documentation-build.test.js` must stay green; Jest suites `server/__tests__/web-routes.test.js` and `hosted-parity.test.js` re-run once as a sanity check (they serve stub pages)

**Target Platform**: Static pages served by the Express app on squiredocs.com (hosted mode only; 058 already returns 404 for them when `SQUIRE_HOSTED` is off)

**Project Type**: Web application (marketing pages within the existing client package)

**Performance Goals**: N/A (copy change; no new assets, scripts, or requests)

**Constraints**: Copy rules FR-030 to FR-039; existing layout, CSS classes, and screenshots reused (D7); "Start free" dominant over "Run it yourself" (D8); no edits to `server/`, `documentation/`, `README.md`, the documentation and blog renderers' headers, or new routes (FR-041); branch held unmerged until the launch gate (FR-042)

**Scale/Scope**: 4 HTML pages (3 rewritten, 1 nav-only), 1 footer source, 1 shared stylesheet (two small rules), 1 new checker module, 1 new test file

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

| Principle | Assessment |
| --- | --- |
| I. Documentation Reflects Reality | PASS. `README.md`, `docs/dev.md`, and `documentation/*.md` contain none of the strings this feature changes (checked: "Write with AI", "Unlimited Docs", "Dedicated Instance", footer sync). The marketing pages are user-facing copy, not developer documentation. The new test follows the existing script-plus-test pattern and needs no dev-guide entry. The README's launch content belongs to 060. |
| II. Test-Backed Changes | PASS. The copy rules become a Vitest suite (US5) with violation fixtures for each rule, plus launch-copy anchor assertions and a footer-sync assertion. Existing suites over these pages stay green (FR-043). No backend tests are added, so the Jest isolation invariant is not engaged. |
| III. Trunk-Based Solo Workflow | PASS with a recorded release constraint. The branch is held until the launch gate because the copy is false before it (D5). This is the design's decision, not process for its own sake: it prevents shipping "open source" and an install command that 404s. |
| IV. Collaboration-Safe Document Operations | N/A. No document mutation. The copy describes attribution and undo accurately and drops PR-review framing (FR-036), consistent with provenance as a product invariant. |
| V. Secure by Default | PASS. No new ingestion surface, endpoint, or script. The install command is displayed as text, not executed. No inline JavaScript is added. |
| VI. Design Docs Are Ground Truth | PASS. Copy derives from the ratified design; gaps are ledgered as RBD-062-1 to RBD-062-18 in `clarifications-needed.md`. Claims the repository cannot verify are listed in the spec and in `promotion-notes.md` for Sam before the gate. |
| VII. Horizontally Scalable App Pods | N/A. Static files only. |

**Post-design re-check (after Phase 1)**: unchanged. The design adds two CSS
rules to `marketing.css` and a pure checker module; neither touches a governed
area.

## Project Structure

### Documentation (this feature)

```text
specs/062-oss-launch-messaging/
├── spec.md                    # Feature spec (committed)
├── clarifications-needed.md   # RBD ledger (RBD-062-1..18)
├── promotion-notes.md         # Launch-gate precondition, follow-ons
├── checklists/requirements.md
├── plan.md                    # This file
├── research.md                # Phase 0: R1..R7
├── quickstart.md              # Phase 1: validation guide
└── tasks.md                   # Phase 2 (/speckit-tasks)
```

`data-model.md` and `contracts/` are not produced. The feature has no data,
no API, and no external interface; the spec's "Key Entities" (marketing page,
shared footer, copy rule) are fully described there. The checker module's
interface is three exports, defined in research R1 and R3.

### Source Code (repository root)

```text
client/
├── public/
│   ├── landing.html        # rewritten: head meta, hero, trust strip, 6 sections, closing band, nav
│   ├── pricing.html        # rewritten: meta, hero, 3 cards, comparison table, FAQ, closing band, nav
│   ├── about.html          # rewritten: meta, hero, prose, "Why open source", belief cards, closing band, nav
│   ├── security.html       # nav links only (footer restamped by sync)
│   └── marketing.css       # + .landing-btn.outline (copied from pricing inline), + .landing-install-cmd
├── scripts/
│   ├── site-footer.mjs     # tagline + "Self-host" <li> (isolated task; see "Feature 060 overlap")
│   └── check-copy-rules.mjs  # NEW: pure checker (rules, stripHtmlComments, findCopyRuleViolations)
└── src/__tests__/
    ├── marketing-copy-rules.test.js  # NEW
    └── documentation-build.test.js   # unchanged; must stay green
```

**Structure Decision**: All work stays inside the existing `client` package.
The checker lives beside the two existing scan scripts in `client/scripts/` and
its test beside their tests in `client/src/__tests__/`, so it runs in the
existing client suite with no config change (research R1).

## Design

### Copy-rules test (`marketing-copy-rules.test.js`)

Four `describe` blocks:

1. **Checker catches each rule** (US5 scenario 2, SC-004). For each fixture in
   User Story 5 (bare "Squire", em dash and `&mdash;`, "honestly", "free
   forever", "pull request", "GLM" without "z.ai (", "AGPL"), plus "ever" vs
   "every", an `&mdash;` inside an HTML comment (must pass), and a clean
   sentence (must pass), assert the expected rule fires or does not.
2. **Scanned sources are clean** (US5 scenario 1, FR-030 to FR-038). Run
   `findCopyRuleViolations` on landing, pricing, and about (stamped footer
   block removed first, research R2) with `requireMit: true`, and on `FOOTER`
   with `requireMit: false`. Report
   failures as `file: rule "match"` lines so a failing run names the offending
   text (Development Workflow: LLM-friendly output).
3. **Footer is the single source** (FR-026, FR-027). For the four static pages,
   `syncFooterIntoHtml(html) === html`; `FOOTER` contains the new tagline once,
   the `https://github.com/squiredocs` GitHub link, and the
   `/documentation/self-hosting` Self-host link; no file under
   `client/public/*.html` or `site-footer.mjs` contains a retired string
   (SC-003).
4. **Launch copy anchors** (US1 to US4 independent tests). Load-bearing strings
   only, to avoid freezing every sentence: landing title/og/twitter title, H1,
   trust items in order, hero CTA hrefs and labels, install command verbatim,
   section headings in FR-006 order; pricing's three plan names and prices in
   order, card hrefs, the sign-in row cells; about H1 and "Why open source";
   closing band heading, subtext, and both hrefs on the three pages; nav
   GitHub and Self-host links after Blog and before Sign In on all four pages.
   The organization URL is one constant shared with the checker, so the D4
   repoint is a one-line test change.

### Existing assertions that must stay true (FR-029, FR-043)

See research R4. In short: never edit the
`<a href="/documentation" class="landing-nav-link">Documentation</a>` line or
the footer's Documentation `<li>`; keep the landing structural markers; write
"self-host guide" or "Documentation", never "the docs" or "docs site".

### Page work

- **Landing** (FR-001 to FR-013): replace head meta; replace the hero copy and
  the single Google CTA card with a two-button CTA row (`landing-btn google`
  "Start free" to `/signup`, `landing-btn outline` "Run it yourself" to
  `/documentation/self-hosting`), keeping `hero-screenshot.png`; replace the
  trust strip with three items; rebuild the body as the six FR-006 sections
  reusing `landing-section`, `landing-section-title`, `landing-section-text`,
  `landing-usecases-grid`/`landing-usecase-card`, `landing-intro-layout`, and
  `landing-steps-grid`, with `screenshot-versionhistory.png` in section 2 and
  `mobile-diagram.png` kept in "Any agent, any model" (RBD-062-11, RBD-062-13);
  alternate the `#f9fafb` background as today; closing band per FR-028.
- **Pricing** (FR-014 to FR-020): meta (RBD-062-15), hero (RBD-062-14), three
  cards (the Hosted card keeps `featured`), comparison table per RBD-062-8 with
  `&ndash;` markers, FAQ per FR-019 and RBD-062-5, closing band.
- **About** (FR-021 to FR-025): meta and hero (RBD-062-15), prose opening,
  "Why open source" paragraph with the MIT link, belief cards per FR-024 and
  RBD-062-6, closing band.
- **Header nav** (FR-029, RBD-062-2, RBD-062-18): insert
  `<a href="https://github.com/squiredocs" class="landing-nav-link">GitHub</a>`
  and `<a href="/documentation/self-hosting" class="landing-nav-link">Self-host</a>`
  after Blog on all four pages.
- **Styles** (RBD-062-17): copy `.landing-btn.outline` and its hover rule from
  `pricing.html` into `marketing.css`; add `.landing-install-cmd`.

### Feature 060 overlap (footer)

`site-footer.mjs` may also be edited by feature 060. The footer change is one
isolated task (its own commit when the branch is committed; T027): edit the tagline line and add one `<li>` for
Self-host after GitHub, then run `npm run sync:footer` in `client/`. No other
task touches `site-footer.mjs` or hand-edits a stamped footer. Because the
launch gate requires 060 merged first, 062 always lands second and is rebased
onto 060. At that rebase the merge-queue owner either keeps the commit, trims
it (060 already added Self-host or changed the tagline), or drops it, then
re-runs `npm run sync:footer` and the client suite. The footer-sync assertion
in the copy-rules test catches a stale restamp either way.

### Release constraint (D5, FR-042)

No flag or code mechanism. The implementation is completed and verified on its
branch, then handed to the merge-queue owner with the gate checklist recorded
in `promotion-notes.md`: history scrub done; repository public at
`https://github.com/squiredocs`; MIT `LICENSE` in the repository; 060 merged
with `/documentation/self-hosting` and `/install.sh` resolving; Sam has
confirmed the claims listed as unverifiable in the spec. At merge time: rebase
onto main, re-run the quickstart gates, merge. If the repository URL has been
decided by then, repoint the GitHub links and the test constant in the same
change (D4).

## Complexity Tracking

No constitution violations. Nothing to justify.
