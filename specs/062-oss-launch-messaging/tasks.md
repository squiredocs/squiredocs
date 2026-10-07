---
description: "Task list for 062-oss-launch-messaging"
---

# Tasks: Open Source Launch Messaging

**Input**: Design documents from `specs/062-oss-launch-messaging/`

**Prerequisites**: plan.md, spec.md, research.md, quickstart.md (no data-model.md or contracts/: the feature has no data or API; see plan.md)

**Tests**: Requested. User Story 5 is the copy-rules test itself, and every page story's "Independent Test" says the copy-rules scan passes on its file. Each story writes its assertions first, watches them fail, then rewrites the copy.

**Release constraint (D5, FR-042)**: This branch is implemented and verified, then held unmerged. The merge-queue owner (the "mayor" session) merges it at the launch gate. No task in this file merges anything.

**Ground truth**: design "Proposal: Open Source Launch Messaging" (Squire doc `f4f528c7-ee50-4356-b181-cbfd282ab744`) for copy; `clarifications-needed.md` RBD-062-1 to RBD-062-18 for defaults; Sam's style guide (Squire doc `887930a2-b5ed-4a64-9c36-5c4d0ae3c3fb`) for prose. Copy the exact strings from spec.md's FRs; do not paraphrase them.

**Never edit** (FR-041): `server/web-routes.js`, `server/app-shell.js`, anything under `documentation/`, `README.md`, `client/scripts/render-documentation.mjs`, `client/scripts/render-blog.mjs`, `client/src/components/LoginPage.jsx`. Never add routes or files for `/self-host.md`, `/install.sh`, or `/documentation/self-hosting`.

**Keep byte-for-byte** (FR-029, FR-043, research R4): `<a href="/documentation" class="landing-nav-link">Documentation</a>` in each page's nav; the footer's `<li><a href="/documentation">Documentation</a></li>`; the landing structural markers listed in research R4. Never write "the docs", "docs site", "read the docs", or "self-host docs" (the terminology sweep fails); write "self-host guide" or "Documentation".

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependency on an incomplete task)
- **[Story]**: Which user story the task belongs to (US1 to US5)

All commands run in the app-dev pod. Client test commands run from `client/`.

---

## Phase 1: Setup

**Purpose**: Record the green baseline the feature must preserve.

- [X] T001 Run `npm run test:client` (repo root) and `node scripts/sync-footer.mjs --check` (in `client/`); confirm both pass on the untouched branch and note the client test count, so any later failure in `client/src/__tests__/documentation-build.test.js` is attributable to this feature

---

## Phase 2: Foundational (blocking prerequisites)

**Purpose**: The checker module every story's scan uses, its rule fixtures, and the two shared styles the page rewrites need.

**Blocks**: all user story phases.

- [X] T002 Create `client/scripts/check-copy-rules.mjs` per research R1 to R3: export `GITHUB_REPO_URL = 'https://github.com/squiredocs'`; `COPY_RULES` (one entry per FR-030 to FR-038 with an id such as `bare-squire`, `em-dash`, `honest`, `forever`, `glm-label`, `pr-framing`, `other-license`, `retired-string`, `spec-driven-heading`, and the regexes in research R3); `stripStampedFooter(html)` (removes `<!-- site-footer:start` through `<!-- site-footer:end -->`); `stripHtmlComments(text)`; and `findCopyRuleViolations(text, { requireMit })` returning `{ rule, match, index }[]`. With `requireMit: true`, add a `mit-missing` violation when no case-sensitive `\bMIT\b` appears, and an `mit-unlinked` violation for every body `\bMIT\b` (after removing `<head>...</head>`) that is not inside an `<a href="https://github.com/squiredocs"...>...</a>` element (RBD-062-16). Pure functions only: no file I/O at import time, no dependencies. Add a header comment naming the spec FRs and saying a repository-URL repoint (D4) changes `GITHUB_REPO_URL` and the pages together
- [X] T003 Create `client/src/__tests__/marketing-copy-rules.test.js` with a header comment (mirroring `documentation-build.test.js`) and the first describe block, "checker catches each rule" (plan.md Design, block 1): one `it` per User Story 5 fixture asserting the named rule fires (bare "Squire" in prose; a literal U+2014; `&mdash;`; "honestly"; "free forever"; standalone "ever"; "pull request"; "PRs"; "reviewed like"; "GLM" without "z.ai ("; bare "z.ai"; "AGPL"; "Apache"; "Unlimited Docs"; "ChatGPT"; "spec-driven" inside an `<h2>`; an unlinked body "MIT"; a page with no "MIT"), plus must-pass cases ("every", "Squire Docs", `squiredocs.com`, `github.com/squiredocs`, "z.ai (GLM)", an `&mdash;` inside an HTML comment, a stamped-footer block containing an em dash, a linked `<a href="https://github.com/squiredocs">MIT license</a>`, "MIT" only in a `<meta>` description plus one linked body "MIT", and "approve the agent"). Failure messages list `rule "match"` pairs. Run `npx vitest run src/__tests__/marketing-copy-rules.test.js`; it must pass (depends on T002)
- [X] T004 [P] In `client/public/marketing.css`, add the `.landing-btn.outline` and `.landing-btn.outline:hover` rules copied verbatim from `client/public/pricing.html`'s inline `<style>`, and a `.landing-install-cmd` rule for a `<pre><code>` block: monospace font stack, background `#f3f4f6`, text `#1f2937`, `border: 1px solid #e5e7eb`, `border-radius: 8px`, padding about `1rem 1.25rem`, `overflow-x: auto`, `text-align: left`, `max-width: 640px`, centered with auto margins (RBD-062-17). Leave `pricing.html`'s inline copy of `.outline` in place. Do not change any existing rule

**Checkpoint**: The checker and its fixtures pass; page stories can start in parallel.

---

## Phase 3: User Story 1 - A developer understands what Squire Docs is and how to try it (Priority: P1) MVP

**Goal**: `client/public/landing.html` carries the launch positioning (FR-001 to FR-013) and its closing band (FR-028).

**Independent Test**: The landing assertions and the landing copy-rules scan in `marketing-copy-rules.test.js` pass; `documentation-build.test.js` stays green.

### Tests for User Story 1

- [X] T005 [US1] In `client/src/__tests__/marketing-copy-rules.test.js`, add an `it` under a "scanned sources are clean" describe that reads `client/public/landing.html`, applies `stripStampedFooter`, and expects zero `findCopyRuleViolations(..., { requireMit: true })`; and a "landing launch copy" describe asserting: the exact `<title>`, `og:title`, `twitter:title` (FR-001); the meta description (FR-002) and `og:description`/`twitter:description` equal to it or to the short form; the H1 and subheadline text (FR-003); a `/signup` link labeled "Start free" with class `landing-btn google` and a `/documentation/self-hosting` link labeled "Run it yourself" with class `landing-btn outline`, both in the hero (FR-004); the three trust items in order, the first inside a link to `GITHUB_REPO_URL` (FR-005); the six section headings in FR-006 order; the install command verbatim inside `<code>` and the two section 4 links (FR-010); the four use-case headings (FR-011); the agent and provider lists and the `/documentation/agents-and-mcp` link (FR-012); absence of every FR-013 string and of "No setup. Sign in with Google."; the closing band heading, subtext, both buttons, and the "A human answers." line (FR-028). Run it and confirm it fails (copy not yet rewritten)

### Implementation for User Story 1

- [X] T006 [US1] Replace the landing `<head>` text in `client/public/landing.html`: `<title>`, meta description, `og:title`, `og:description`, `twitter:title`, `twitter:description` per FR-001 and FR-002 (use the short form "Open source collaborative docs for people and AI agents." for `og:description` and `twitter:description`). Leave the gtag snippet, `og:type`, `og:url`, `twitter:card`, and the inline critical CSS unchanged
- [X] T007 [US1] Rewrite the landing hero in `client/public/landing.html` (FR-003, FR-004, RBD-062-10): new H1 (single line, drop the `<br>`), new subheadline, keep the `hero-screenshot.png` block with alt text rewritten to pass the copy rules, and replace the `landing-signup-card` (and its "No setup. Sign in with Google." heading) with a CTA row inside `landing-hero-cta`: `<a href="/signup" class="landing-btn google">Start free</a>` (drop the Google glyph, RBD-062-10 recommended default) followed by `<a href="/documentation/self-hosting" class="landing-btn outline">Run it yourself</a>`
- [X] T008 [US1] Replace the trust strip items in `client/public/landing.html` with exactly three `landing-trust-item` entries in FR-005 order, reusing existing SVG icons; wrap the "Open source (MIT)" item's text in `<a href="https://github.com/squiredocs">` styled to inherit color (an inline `style="color: inherit"` or the existing link look is acceptable). Remove the Anthropic, Google sign-in, and encrypted-keys items
- [X] T009 [US1] Replace the landing body sections 1 to 3 in `client/public/landing.html` (FR-006 to FR-009, FR-034, RBD-062-11), reusing existing section markup: (1) "Your agent, live in the document" in a `landing-intro-layout` with `hero-screenshot.png` (FR-007 requires an existing screenshot; `screenshot-mcp.png` is outdated and must not be used), stating MCP connection, named cursor, watching edits land, and both concurrent edits surviving; (2) "See what changed, undo what you don't want" with `screenshot-versionhistory.png`, stating every change is attributed, each version can be restored, and diff highlighting shows what the agent changed; (3) "Markdown in, markdown out, synced to your repo" keeping the current repo-sync paragraph and its three cards, with "Your content is always yours and up to date." replaced by "Every doc exports as portable .md at any time." and "Squire" in the third card changed to "Squire Docs". Alternate `style="background: #f9fafb;"` as today
- [X] T010 [US1] Replace the remaining landing body sections in `client/public/landing.html` (FR-006, FR-010 to FR-013, RBD-062-13): (4) "Run it on your machine" with the FR-010 paragraph verbatim, `<pre class="landing-install-cmd"><code>curl -fsSL https://squiredocs.com/install.sh | sh</code></pre>`, and links "Read the self-host guide" (`/documentation/self-hosting`) and "View on GitHub" (`https://github.com/squiredocs`); (5) "What people use it for" with the four FR-011 cards and the design's descriptions (spec-driven development mentioned only inside the first card's text); (6) "Any agent, any model" keeping `mobile-diagram.png` and the `/documentation/agents-and-mcp` "Agents &amp; MCP Guide" link, with the FR-012 agent list and provider list and no "Batteries included" card. Delete the old "Connects to your favorite AI", "For spec-driven engineering teams", "Every edit has an author, even the agent's", and "Collaborative Docs for Spec-Driven Development" sections, which removes the prose em dash and bare "Squire" noted in promotion-notes.md
- [X] T011 [US1] Rewrite the landing closing band in `client/public/landing.html` (FR-028): heading "Start writing with your agents.", `<p class="landing-signup-subtext">Free. Open source. Run it yourself or use ours.</p>`, then `/signup` "Start free" (`landing-btn google`, no glyph) and `/documentation/self-hosting` "Run it yourself" (`landing-btn outline`) side by side, and keep the "Questions? Email us. A human answers." line unchanged
- [X] T012 [US1] Run `npx vitest run src/__tests__/marketing-copy-rules.test.js src/__tests__/documentation-build.test.js` in `client/`; fix copy until both pass. Read the rewritten landing copy once against the style guide (FR-039)

**Checkpoint**: The landing page is launch-ready on its own (MVP).

---

## Phase 4: User Story 2 - A visitor finds the right pricing column (Priority: P1)

**Goal**: `client/public/pricing.html` shows Hosted / Self-hosted / Managed instance (FR-014 to FR-020) and the new closing band (FR-028).

**Independent Test**: The pricing assertions and pricing copy-rules scan pass; `documentation-build.test.js` stays green.

### Tests for User Story 2

- [X] T013 [US2] In `client/src/__tests__/marketing-copy-rules.test.js`, add the pricing `it` to "scanned sources are clean" and a "pricing launch copy" describe asserting: title "Pricing | Squire Docs"; meta and `og:description` equal to RBD-062-15 and free of "Dedicated" (FR-020); the RBD-062-14 hero H1; exactly three `pricing-card` elements whose `<h2>` and `pricing-price` are Hosted / Free during beta, Self-hosted / Free, open source, Managed instance / Custom pricing, in order (FR-014); card links `/signup` "Start free", `/documentation/self-hosting` "Run it yourself", and `mailto:contact@squiredocs.com?subject=Managed%20instance` (FR-016, RBD-062-12); the comparison header order and the sign-in row cells (FR-017); the five new or changed FAQ `<summary>` questions and the exact "Can we run Squire Docs ourselves?", "Is the hosted version the same software?", "Where can a managed instance run?", and "Do I need an API key to self-host?" answers, with the MIT and self-host guide links (FR-019); absence of "Unlimited Docs", "Dedicated Instance", and a "Bring your own key" plan heading; the closing band (FR-028). Run it and confirm it fails

### Implementation for User Story 2

- [X] T014 [P] [US2] Replace the pricing `<head>` text and hero in `client/public/pricing.html`: keep `<title>Pricing | Squire Docs</title>` and `og:title`; set meta description and `og:description` (and `twitter:description` if present) to RBD-062-15; set the `pricing-hero` H1 and paragraph to RBD-062-14 (FR-018, FR-020)
- [X] T015 [US2] Replace the three plan cards in `client/public/pricing.html` (FR-014 to FR-016): Hosted (keeps `featured`, badge "Public beta"), Self-hosted (badge "Open source"), Managed instance (badge "Teams and organizations"), with prices and descriptions from FR-015 and the design's table, and actions `<a href="/signup" class="landing-btn google">Start free</a>`, `<a href="/documentation/self-hosting" class="landing-btn outline">Run it yourself</a>`, `<a href="mailto:contact@squiredocs.com?subject=Managed%20instance" class="landing-btn outline">Email us</a>`. Drop the Google glyph from the Hosted button to match the landing page (RBD-062-10)
- [X] T016 [US2] Rebuild the comparison table in `client/public/pricing.html` (FR-017, RBD-062-8, RBD-062-4): header columns Hosted, Self-hosted, Managed instance; the thirteen rows and marks exactly as RBD-062-8's table, with included cells `<span class="pricing-check">&#10003;</span>`, excluded cells `<span class="pricing-dash">&ndash;</span>`, and the Sign-in row as plain text cells. No `&mdash;` remains
- [X] T017 [US2] Rewrite the pricing FAQ in `client/public/pricing.html` (FR-019, RBD-062-5): keep "What happens when my credits run out?", "Do I need a credit card?", and "What happens to my documents if I stop using Squire Docs?" answers as they are (they pass the rules); change "Will Squire Docs stay free?" to end "and your documents export as markdown at any time." plus one sentence "The open source project is <a href=\"https://github.com/squiredocs\">MIT licensed</a>."; replace "Can we run Squire Docs ourselves?" with the FR-019 answer (MIT license and self-host guide linked); add "Is the hosted version the same software?", "Where can a managed instance run?", and "Do I need an API key to self-host?" with the FR-019 answers, `contact@squiredocs.com` as a `mailto:` link
- [X] T018 [US2] Rewrite the pricing closing band in `client/public/pricing.html` exactly as T011 (FR-028)
- [X] T019 [US2] Run `npx vitest run src/__tests__/marketing-copy-rules.test.js src/__tests__/documentation-build.test.js` in `client/`; fix until green. Style-guide read of the new pricing copy (FR-039)

**Checkpoint**: Landing and pricing agree on the offer.

---

## Phase 5: User Story 3 - The about page explains the problem and why it is open source (Priority: P2)

**Goal**: `client/public/about.html` carries the agent-problem story, "Why open source", and the revised beliefs (FR-021 to FR-025), plus the closing band (FR-028).

**Independent Test**: The about assertions and about copy-rules scan pass; `documentation-build.test.js` stays green.

### Tests for User Story 3

- [X] T020 [US3] In `client/src/__tests__/marketing-copy-rules.test.js`, add the about `it` to "scanned sources are clean" and an "about launch copy" describe asserting: title "About | Squire Docs"; meta and `og:description` equal RBD-062-15 and contain none of "copy-paste", "chat tab", "engineering leaders" (FR-021); the H1 and hero subline; the FR-022 opening paragraph verbatim and absence of "You know the ritual"; a "Why open source" paragraph containing an MIT link to `GITHUB_REPO_URL`, "same code", and "21st Harmonic" (FR-023); four `about-principles-grid` cards with the FR-024 "Trust by design" text, "z.ai (GLM)", and the RBD-062-6 "Agent work is accountable work" text; the "Open to any model or agent" card not starting with "A built-in agent" (RBD-062-19); the "Who's behind it" section (FR-025); the closing band (FR-028). Run it and confirm it fails

### Implementation for User Story 3

- [X] T021 [P] [US3] Replace the about `<head>` text and hero in `client/public/about.html` (FR-021, RBD-062-15): keep title and `og:title` "About | Squire Docs"; set meta description and `og:description` (and `twitter:description` if present); H1 "Agents do real work now. They need somewhere to put it." (a `<br>` after the first sentence is acceptable); hero subline from RBD-062-15
- [X] T022 [US3] Replace the `about-prose` paragraphs in `client/public/about.html` (FR-022, FR-023): the FR-022 paragraph verbatim, then a "Why open source" paragraph (lead with a `<strong>Why open source.</strong>` run-in or a short `<h3>`) stating the tool that holds your team's specs and your agents' work should be one you can inspect, run, and keep; it is <a href="https://github.com/squiredocs">MIT licensed</a>; the hosted service runs the same code; and 21st Harmonic offers managed instances for teams that want one. Remove all four current paragraphs, including the "engineering leaders" one
- [X] T023 [US3] Update the "What we believe" cards in `client/public/about.html` (FR-024, RBD-062-6): "The document is the interface" unchanged unless it fails a rule; "Agent work is accountable work" body becomes "Each edit is attributed to whoever made it, human or agent, and can be undone through version history."; "Open to any model or agent" is reworded per RBD-062-19 (leads with connecting any MCP agent and bring-your-own-key providers "Anthropic, Google (Gemini), OpenAI, z.ai (GLM), or OpenRouter"; the hosted built-in assistant only as a second sentence scoped to squiredocs.com) with no forbidden word; "Trust by design" body becomes "Your docs, your infrastructure: open source, markdown export, and self-hosting." Keep the "Who's behind it" section and contact card unchanged (FR-025)
- [X] T024 [US3] Rewrite the about closing band in `client/public/about.html` exactly as T011 (FR-028)
- [X] T025 [US3] Run `npx vitest run src/__tests__/marketing-copy-rules.test.js src/__tests__/documentation-build.test.js` in `client/`; fix until green. Style-guide read of the new about copy (FR-039)

**Checkpoint**: All three rewritten pages pass their scans.

---

## Phase 6: User Story 4 - Same tagline, nav, and closing band everywhere (Priority: P2)

**Goal**: The footer source and its four stamped copies carry the new tagline and Self-host link (FR-026, FR-027); the header nav on four pages gains GitHub and Self-host (FR-029); the closing band is identical on the three pages (FR-028).

**Independent Test**: The footer and nav assertions pass, `node scripts/sync-footer.mjs --check` passes, and the retired-string grep in quickstart.md section 2 prints nothing.

### Tests for User Story 4

- [X] T026 [US4] In `client/src/__tests__/marketing-copy-rules.test.js`, add: an `it` under "scanned sources are clean" for `FOOTER` (imported from `../../scripts/site-footer.mjs`) with `requireMit: false`; a "footer is the single source" describe asserting `syncFooterIntoHtml(html) === html` for landing, pricing, about, and security, that `FOOTER` contains `<p class="landing-footer-tagline">Collaborative docs for people and AI agents</p>`, `<li><a href="https://github.com/squiredocs">GitHub</a></li>` followed by `<li><a href="/documentation/self-hosting">Self-host</a></li>`, and that no `client/public/*.html` file and not `site-footer.mjs` contains "Write with AI, right in your doc", "Free. No Setup. Sign in with Google.", "Unlimited Docs", or "Dedicated Instance" (FR-026, FR-028, SC-003); a "header nav" describe asserting, for the four pages, that the `landing-nav` element contains in order the Blog link, `<a href="https://github.com/squiredocs" class="landing-nav-link`, `<a href="/documentation/self-hosting" class="landing-nav-link`, then `href="/login"`, and still contains the exact Documentation link (FR-029); and a closing-band consistency `it` asserting the three pages' `landing-section cta` blocks share the same heading, subtext, button hrefs, and contact line (FR-028). Run it and confirm the footer and nav parts fail

### Implementation for User Story 4

- [X] T027 [US4] ISOLATED FOOTER TASK (one commit, touches only `client/scripts/site-footer.mjs` plus the four restamped pages): in `FOOTER`, change the tagline to "Collaborative docs for people and AI agents" and insert `<li><a href="/documentation/self-hosting">Self-host</a></li>` immediately after the GitHub `<li>` (FR-026, FR-027, RBD-062-3). Do not touch `FOOTER_START` (its em dash is a build marker, RBD-062-4) or any other line. Then run `npm run sync:footer` in `client/` to restamp `landing.html`, `pricing.html`, `about.html`, `security.html`; never hand-edit a stamped footer. Keep this change separable from every other task: if commits are made on this branch, it is its own commit with a message naming feature 060; if not, its whole diff is the `site-footer.mjs` hunk plus the stamped-footer regions, which `npm run sync:footer` regenerates. Either way the merge-queue owner can keep, trim, or drop it when rebasing onto 060 (plan.md "Feature 060 overlap")
- [X] T028 [US4] Add the two header nav links to `client/public/landing.html`, `client/public/pricing.html`, `client/public/about.html`, and `client/public/security.html`: insert `<a href="https://github.com/squiredocs" class="landing-nav-link">GitHub</a>` and `<a href="/documentation/self-hosting" class="landing-nav-link">Self-host</a>` on new lines directly after each page's Blog link and before Sign In. Do not alter any existing nav line (FR-029, RBD-062-2)
- [X] T029 [US4] Check the header at 481px, 600px, and 768px widths on the four pages (dev server or Playwright in the pod). If the nav wraps or overflows, add class `landing-nav-link-wide` to the two new links on all four pages and a `@media (max-width: 768px) { .landing-nav-link-wide { display: none; } }` rule in `client/public/marketing.css` (RBD-062-18); otherwise change nothing and note the result in `promotion-notes.md`
- [X] T030 [US4] Run `npx vitest run src/__tests__/marketing-copy-rules.test.js src/__tests__/documentation-build.test.js` and `node scripts/sync-footer.mjs --check` in `client/`; fix until green

**Checkpoint**: Every page and the rendered documentation and blog footers carry the launch tagline.

---

## Phase 7: User Story 5 - The copy rules are enforced by a test (Priority: P3)

**Goal**: The scan proves it catches regressions on the real pages, not only on isolated fixtures (US5 scenario 2, SC-004).

**Independent Test**: `npx vitest run src/__tests__/marketing-copy-rules.test.js` passes, and each injected-fixture case reports its violation.

- [X] T031 [US5] In `client/src/__tests__/marketing-copy-rules.test.js`, add an "injected regressions are caught" describe: for each of landing, pricing, and about, and for each User Story 5 fixture ("Squire" alone in prose, a U+2014, "honestly", "free forever", "pull request", "GLM" without "z.ai (", "AGPL"), insert the fixture into a `<p>` just before `</main>` (or before the closing band if no `<main>`) of an in-memory copy of the real page and assert `findCopyRuleViolations` reports at least one violation with the expected rule id, while the unmodified page reports zero. Also assert that removing every GitHub link wrapper from an in-memory copy of pricing makes `mit-unlinked` fire (RBD-062-16)
- [X] T032 [US5] Run `npx vitest run src/__tests__/marketing-copy-rules.test.js` in `client/`; confirm the suite summary is one line on success (the client reporter is `script/vitest-llm-reporter.mjs` when run via `npm run test:client`) and that failure output names file, rule, and matched text

**Checkpoint**: The rules outlive this feature.

---

## Phase 8: Polish and hand-off

- [X] T033 Run quickstart.md section 1 in full: `npm run test:client` (repo root), `npm run test:server -- server/__tests__/web-routes.test.js server/__tests__/hosted-parity.test.js`, and `node scripts/sync-footer.mjs --check` (in `client/`); all green (FR-043, SC-005)
- [X] T034 Run the quickstart.md section 2 retired-string grep over `client/public` and `client/scripts/site-footer.mjs`; expect no output (SC-003)
- [X] T035 Claims audit (FR-040, SC-006): read every factual sentence on landing, pricing, and about and map it to a line in spec.md "Claims verified" or "Claims the repository cannot verify", or to a design decision. Any claim with no mapping is either removed or added to spec.md's Assumptions and to `specs/062-oss-launch-messaging/promotion-notes.md` for Sam
- [X] T036 Style pass (FR-039): read the three pages against the style guide checklist (lead with what it is; no "not X but Y"; no metaphors; no overstating absolutes such as "never", "always", "costs nothing"; split sentences carrying three ideas). Record any judgment call in `specs/062-oss-launch-messaging/promotion-notes.md`
- [X] T037 Visual pass per quickstart.md section 3 at desktop, about 600px, and 375px on `/`, `/pricing`, `/about`, `/security`, and one `/documentation/*` page: primary button visibly dominant (D8), install command readable and scrolls rather than overflows, comparison table readable, footer shows the new tagline and Self-host link
- [X] T038 Scope guard (FR-041): `git diff --name-only main...HEAD` lists only `client/public/{landing,pricing,about,security}.html`, `client/public/marketing.css`, `client/scripts/site-footer.mjs`, `client/scripts/check-copy-rules.mjs`, `client/src/__tests__/marketing-copy-rules.test.js`, and files under `specs/062-oss-launch-messaging/`
- [X] T039 Append an "Implementation phase" section to `specs/062-oss-launch-messaging/promotion-notes.md`: relaxations (if any), the T029 nav result, the T035 claims list changes, and the hand-off: branch held unmerged per D5/FR-042 with the gate checklist from the plan phase section; the merge-queue owner rebases onto main after 060 merges, resolves `site-footer.mjs` per plan.md "Feature 060 overlap", repoints GitHub links and `GITHUB_REPO_URL` if the repository name is decided (D4), re-runs quickstart.md section 1, and merges. Do not merge

---

## Dependencies and execution order

### Phase dependencies

- **Setup (T001)**: none.
- **Foundational (T002 to T004)**: after T001. T003 depends on T002. T004 is independent of both. Blocks every story.
- **US1 (T005 to T012)**, **US2 (T013 to T019)**, **US3 (T020 to T025)**: each after Phase 2. Page edits are in different files, so the three stories can proceed in parallel, but their test tasks (T005, T013, T020) all edit `marketing-copy-rules.test.js` and must be serialized.
- **US4 (T026 to T030)**: after Phase 2. T027 and T028 restamp or edit the same page files as US1 to US3, so run US4 after the page stories (or serialize file by file). T027 is self-contained so it can be rebased or dropped (plan.md).
- **US5 (T031, T032)**: after US1 to US3 (it injects into the real rewritten pages) and after US4's T026 (same test file).
- **Polish (T033 to T039)**: after all stories.

### Within each story

Test task first and confirmed failing, then head/hero, then body, then closing band, then the run task.

### Parallel opportunities

- T004 alongside T002/T003.
- Once Phase 2 is done: T006 to T011 (landing.html), T014 to T018 (pricing.html), and T021 to T024 (about.html) can run in three parallel streams, after the three test tasks land one at a time.
- T027 and T028 touch the same four pages (footer region versus nav region) and run one after the other.

### Parallel example after Phase 2

```text
Stream A: T005 → T006 → T007 → T008 → T009 → T010 → T011 → T012   (landing.html)
Stream B: (after T005 lands) T013 → T014 → T015 → T016 → T017 → T018 → T019   (pricing.html)
Stream C: (after T013 lands) T020 → T021 → T022 → T023 → T024 → T025   (about.html)
Then:     T026 → T027 → T028 → T029 → T030 → T031 → T032 → T033..T039
```

## Implementation strategy

- **MVP**: Phases 1 to 3 (checker plus landing). The landing page is the launch's first impression and carries the anchor (D1) and the CTA pair (D8).
- **Incremental**: add pricing (US2), then about (US3), then the shared footer and nav (US4), then the injected-regression proofs (US5). Each story ends green on the client suite.
- **Release**: nothing ships before the launch gate. The completed branch is handed to the merge-queue owner per T039.
