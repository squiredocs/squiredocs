# Research: 062-oss-launch-messaging

The feature is static copy plus one scan test. There were no NEEDS CLARIFICATION
items in the technical context; the questions below are the implementation
choices the spec leaves open, each resolved against the current code.

## R1. Where the copy-rules checker and its test live

- **Decision**: Pure checker module at `client/scripts/check-copy-rules.mjs`
  (exports the rule list, `stripHtmlComments(text)`, and
  `findCopyRuleViolations(text, { requireMit })` returning
  `{ rule, match, index }[]`). Test at
  `client/src/__tests__/marketing-copy-rules.test.js`.
- **Rationale**: This mirrors the two existing script-plus-test pairs:
  `scripts/check-color-tokens.mjs` with `color-tokens.lint.test.js`, and
  `scripts/render-documentation.mjs` (exports `findTerminologyViolations`)
  with `documentation-build.test.js`. Vitest's default include picks up
  `client/src/**/__tests__/*.test.js`, so the test runs in `npm run test:client`,
  the root `npm test`, and CI (`.github/workflows/test.yml` runs
  `npm run test:client`) with no config change. The checker sits under
  `client/scripts/`, outside the directories the terminology sweep walks
  (`client/src` minus `__tests__`, and `client/public`), so its pattern list is
  not itself scanned. The test file sits under `__tests__`, which the sweep
  skips, so its violation fixtures (em dashes, "free forever") are safe there.
- **Alternatives considered**: Extending `documentation-build.test.js`
  (rejected: that file is feature 007's documentation-site suite, and the copy
  rules are a separate concern with their own fixtures). A Jest test under
  `server/__tests__` (rejected: the files are client assets and the client suite
  already reads them). A standalone `npm run lint:copy` CLI (deferred: YAGNI;
  the test is the gate, and a CLI can wrap the same exports later).

## R2. How the scan reads the files

- **Decision**: Read each of `landing.html`, `pricing.html`, `about.html` as
  raw text and import `FOOTER` from `client/scripts/site-footer.mjs`. For each
  page, first remove the stamped footer block (from `<!-- site-footer:start`
  through `<!-- site-footer:end -->`), then strip the remaining `<!-- ... -->`
  comments, then run every rule over the whole remaining text, including
  `<head>`, attributes, and the inline `<style>` and `<script>` blocks.
  `FOOTER` is scanned once at its source. No DOM parsing.
- **Rationale**: FR-031 requires the em-dash rule to cover title, meta, and
  attribute text, so the scan cannot be limited to visible text. A prototype
  run of the rules over the current four pages (2026-10-07) found no hits inside
  `<style>` or `<script>` blocks, and the only hits were in prose this feature
  rewrites (landing: four bare "Squire", one em dash, one bare "GLM"; pricing:
  seven `&mdash;` table cells; about: "reviewed like" and a bare "z.ai"). The
  footer marker comment's em dash is stripped with the other comments
  (RBD-062-4). Removing the stamped footer from the page scans avoids reporting
  one footer defect four times and lets each page's scan pass as soon as that
  page is rewritten, independent of the footer task; the footer-sync assertion
  (R5) guarantees the stamped copies equal the scanned `FOOTER`. Raw-text regex keeps the checker a pure function of a string,
  which is what the fixture tests need.
- **Alternatives considered**: jsdom `DOMParser` text extraction (rejected:
  drops attribute text that FR-031 covers, and ties the checker to the test
  environment).

## R3. The rule patterns

- **Decision** (all applied after comment stripping):
  - FR-030 bare name: `/\bSquire\b(?! Docs)/g` (case-sensitive, so the
    lowercase hostnames `squiredocs.com` and `github.com/squiredocs` never
    match).
  - FR-031 em dash: `/—|&mdash;|&#8212;|&#x2014;/gi`.
  - FR-032: `/\bhonest(ly)?\b/gi`.
  - FR-033: `/\bforever\b|\balways free\b|\bnever charge\b|\bever\b/gi`
    ("free forever" is caught by `\bforever\b`; `\bever\b` does not match
    "every", "never", or "however").
  - FR-035: `/(?<!z\.ai \()\bGLM\b|\bz\.ai\b(?! \(GLM\))/g`.
  - FR-036: `/\bpull requests?\b|\bPRs?\b|\bcode review\b|\bfor approval\b|\bfor review\b|\breviewed like\b|\breview the agent\b/gi`.
  - FR-037 other licenses: `/\bA?GPL\b|\bApache\b|\bBSD\b|\bMPL\b/gi`; and,
    with `requireMit`, at least one `\bMIT\b` (case-sensitive), plus the link
    rule in RBD-062-16.
  - FR-038 retired strings: literal, case-insensitive substring checks for
    "Write with AI, right in your doc", "Free. No Setup. Sign in with Google.",
    "Unlimited Docs", "Dedicated Instance", "Batteries included", "ChatGPT";
    plus "spec-driven" inside `<title>`, `og:title`, `twitter:title`, or any
    `<h1>` to `<h4>` element.
- **Rationale**: Each pattern is the literal reading of its FR. The numeric
  entity forms of the em dash are added so the rule cannot be bypassed by a
  different encoding of the same character.
- **Alternatives considered**: Banning "always" outright (rejected by
  RBD-062-5).

## R4. Keeping documentation-build.test.js green (FR-029, FR-043)

- **Decision**: The implementation preserves these exact strings, which the
  existing suite asserts:
  - On landing, pricing, about: `<a href="/documentation" class="landing-nav-link">Documentation</a>`
    byte-for-byte. Pricing and about mark their own page with
    `landing-nav-link active`; the Documentation link carries no `active` class
    on any of the three, so the regex keeps matching. New nav links are inserted
    as separate `<a>` elements after Blog and do not touch that line.
  - The footer's `<li><a href="/documentation">Documentation</a></li>` (comes
    from `FOOTER`; the footer task adds a line, it does not edit this one).
  - Structural markers on landing: `class="landing-header"`,
    `class="landing-logo"`, `class="landing-logo-text"`, `class="landing-nav"`,
    `href="/login"`, `href="/signup"`, `class="landing-footer"`,
    `<h4>Product</h4>`, `class="landing-copyright"`.
  - The terminology sweep over `client/public`: new copy says "self-host
    guide", "Documentation", or "the self-hosting page", never "self-host
    docs", "the docs", "read the docs", or "docs site". The pattern
    `(view|browse|see|check|read|visit|consult|open) (the|our)? docs` means
    "Read the self-host guide" is safe and "Read the docs" is not.
- **Rationale**: These are the only assertions in the client suite over the
  marketing pages. `server/__tests__/web-routes.test.js` and
  `hosted-parity.test.js` serve stub pages and do not read copy.
- **Verification**: `npm run test:client` (whole client suite) after every page
  task, plus the two server suites once at the end.

## R5. Footer propagation and the feature 060 overlap

- **Decision**: The footer change (tagline line, plus one new `<li>` for
  "Self-host" after "GitHub") is one isolated task that edits only
  `client/scripts/site-footer.mjs` and then runs `npm run sync:footer` (in
  `client/`), which restamps the four static pages. No page task edits the
  footer region by hand. The copy-rules test asserts the footer is in sync:
  for each of the four pages, `syncFooterIntoHtml(html) === html`.
- **Rationale**: Feature 060 may also edit `site-footer.mjs`. The launch gate
  (D5, FR-042) requires 060 merged before this implementation merges, so 062 is
  always the second to land and its branch is rebased onto 060 at merge time.
  Keeping the footer edit in its own commit means the rebase either applies it
  cleanly, or (if 060 already changed the tagline or added a Self-host link)
  the merge-queue owner drops or trims that one commit and re-runs
  `npm run sync:footer`. The sync assertion catches a hand-edited footer or a
  forgotten restamp; nothing in CI runs `sync-footer.mjs --check` today, and
  `npm run build` restamps silently.
- **Alternatives considered**: Wiring `sync-footer.mjs --check` into CI
  (rejected: a workflow change outside this feature's scope; the test gives the
  same guarantee inside the existing suite).

## R6. Secondary button, install command, and table marker presentation

- **Decision**:
  - Secondary "Run it yourself" buttons use the existing `.landing-btn.outline`
    style (today defined only in `pricing.html`'s inline `<style>`). The rule is
    copied into `client/public/marketing.css` so landing and about can use it
    (RBD-062-17). Landing's inline critical CSS carries no button rules today
    (the hero buttons sit below the screenshot), so it is not changed. The primary "Start free" button keeps `.landing-btn.google`'s
    dark filled style (D8: dominant).
  - The install command renders as `<pre class="landing-install-cmd"><code>curl -fsSL https://squiredocs.com/install.sh | sh</code></pre>`
    with a small rule in `marketing.css` (monospace, light gray background,
    horizontal scroll on narrow screens). No copy-to-clipboard button
    (RBD-062-17).
  - Pricing comparison "not included" cells change from `&mdash;` to
    `&ndash;` inside the existing `.pricing-dash` span (RBD-062-4 left the
    marker to implementation; the en dash keeps the current visual).
- **Rationale**: Reuses existing classes and palette (spec Edge Cases: "reuse
  existing section components and button classes"). `marketing.css` and
  `client/public` are outside the color-token lint, which scans only
  `client/src/**/*.css`.
- **Alternatives considered**: A new `.landing-btn.secondary` class (rejected:
  `.outline` already exists and has been on the live pricing page). Text "No"
  in excluded cells (acceptable per RBD-062-4, but changes the table's look).

## R7. Release constraint (D5, FR-042)

- **Decision**: No code mechanism (no feature flag, no date check). The
  implementation branch is held unmerged and the merge-queue owner (the
  "mayor" session) merges it when the launch gate opens. The spec, plan, and
  tasks merge to main as usual. The tasks file ends with a hand-off task that
  records the gate checklist in `promotion-notes.md` rather than merging.
- **Rationale**: The design's D5 says this explicitly. A flag would add server
  code to a copy feature and would still ship false claims in the static files.
- **Rebase expectation**: Because the branch waits, `main` will move under
  it. The pages are only touched by this feature and 060's footer edit, so the
  expected conflicts are limited to `site-footer.mjs` and the four stamped
  footers (resolved by R5).
