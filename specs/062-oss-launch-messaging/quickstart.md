# Quickstart: validating 062-oss-launch-messaging

All commands run in the app-dev pod from the repository root (or the
worktree root), per `docs/dev.md`.

## 1. Automated gates

```bash
# Copy rules, footer sync, launch-copy anchors, retired strings (new suite)
cd client && npx vitest run src/__tests__/marketing-copy-rules.test.js

# Existing suite over the same pages (FR-029, FR-043)
cd client && npx vitest run src/__tests__/documentation-build.test.js

# Whole client suite (what CI runs)
npm run test:client

# The two server suites FR-043 names (stub pages; must stay green)
npm run test:server -- server/__tests__/web-routes.test.js server/__tests__/hosted-parity.test.js

# Footer stamped from the single source
cd client && node scripts/sync-footer.mjs --check
```

Expected: every command exits 0. The copy-rules suite reports zero violations
on landing, pricing, about, and `FOOTER`, and at least one violation for each
User Story 5 fixture.

## 2. Retired strings (SC-003)

```bash
grep -rn -e "Write with AI, right in your doc" -e "Free. No Setup. Sign in with Google." \
  -e "Unlimited Docs" -e "Dedicated Instance" client/public client/scripts/site-footer.mjs
```

Expected: no output.

## 3. Visual pass (manual, D7/D8)

Start the dev server (see `docs/dev.md`) and open `/`, `/pricing`, `/about`,
`/security` at desktop width, about 600px, and 375px:

- Landing hero: H1, subheadline, "Start free" (dark, filled) clearly dominant
  over "Run it yourself" (outline). Trust strip shows three items.
- Landing sections appear in the FR-006 order; the install command is readable
  and scrolls horizontally on a phone instead of overflowing.
- Pricing: three cards (Hosted, Self-hosted, Managed instance), the
  comparison table with three columns and en dash markers, the FAQ entries.
- About: new H1, opening paragraph, "Why open source", four belief cards.
- Header nav on all four pages: Pricing, About, Documentation, Blog, GitHub,
  Self-host, Sign In, Sign Up; no wrapping or overflow between 481px and 768px
  (RBD-062-18).
- Footer on all four pages and on one `/documentation/*` page: tagline
  "Collaborative docs for people and AI agents", Product column has GitHub and
  Self-host.

Links to `/documentation/self-hosting` and `/install.sh` return 404 until
feature 060 merges. That is expected before the launch gate (D5) and is not a
defect of this branch.

## 4. Launch gate (merge-queue owner)

Before merging the implementation branch, confirm the checklist in
`promotion-notes.md` ("Merge-queue precondition"): history scrub done,
repository public, MIT `LICENSE` present, 060 merged and its
`/documentation/self-hosting` and `/install.sh` resolve, Sam has confirmed the
unverifiable claims. Then rebase onto main, re-run section 1, and merge.
