# Promotion notes: 062-oss-launch-messaging

Records relaxations consciously accepted during this feature's pipeline, deploy
preconditions, and pre-existing defects found but deliberately not fixed. Later
phases append here.

## Spec phase (2026-10-07)

- **No relaxations introduced by the spec.** It encodes the ratified design
  ("Proposal: Open Source Launch Messaging", D1 to D8, with D3 amended to name
  MIT) plus the RATIFIED-BY-DEFAULT decisions in `clarifications-needed.md`
  (RBD-062-1 to RBD-062-15).

- **Merge-queue precondition (D5, FR-042).** The implementation branch stays
  unmerged until the launch gate: history scrub done, repository public at
  `https://github.com/squiredocs`, feature 060 merged so
  `/documentation/self-hosting` and `/install.sh` resolve, and a `LICENSE` file
  (MIT) in the repository. The spec and plan merge as usual. Until the gate
  opens, the new copy's "open source" and install claims are false.

- **Repository URL repoint (D4).** Every GitHub link points at the organization.
  When the repository name is decided, the links and the copy-rules test's
  expected URL change together.

- **Claims Sam confirms before the gate opens** (not verifiable from the
  repository; see the spec's Assumptions): same code as the public repository;
  MIT license and LICENSE file; managed instances in the customer's chosen
  cloud region including EU, with documents, database, and backups kept there;
  dedicated single-tenant managed instances run and supported by us.

- **Follow-ons (not this feature):**
  1. `client/src/components/LoginPage.jsx` sign-in subtitle still reads "Write
     with AI, right in your doc" (RBD-062-1).
  2. Header nav of the documentation and blog renderers
     (`client/scripts/render-documentation.mjs`, `client/scripts/render-blog.mjs`)
     lacks the new "GitHub" and "Self-host" links (RBD-062-2).
  3. A short clip or screenshot of an agent cursor editing next to a human
     cursor for landing section 1 (D7, RBD-062-11).
  4. GitHub star count in the nav once there are stars (RBD-062-2).
  5. If the team-mode amendment (061) is ratified and shipped, the self-hosted
     sign-in cell in the pricing table may add passwords and OIDC (RBD-062-7).

- **Pre-existing defects noticed, not fixed here:** none in the code paths this
  feature touches. The current landing page contains one literal em dash in
  prose (line 247) and bare "Squire" in prose (line 214, "Design in Squire");
  both are removed by the rewrite rather than fixed in place.

## Plan phase (2026-10-07)

- **No relaxations introduced by the plan.** New defaults RBD-062-16 (MIT link
  rule made mechanical), RBD-062-17 (`.landing-btn.outline` promoted to
  `marketing.css`, `.landing-install-cmd` added), RBD-062-18 (nav width
  fallback) are in `clarifications-needed.md`.

- **Footer task is isolated for the 060 rebase.** The tagline and Self-host
  footer link are one task (T027, its own commit when committed) touching only
  `client/scripts/site-footer.mjs` plus the `npm run sync:footer` restamp.
  Because the gate requires 060 merged first, the merge-queue owner rebases this
  branch onto 060 and keeps, trims, or drops that commit, then re-runs
  `npm run sync:footer` and `npm run test:client`. The copy-rules test asserts
  every stamped footer matches `FOOTER`, so a stale restamp fails.

- **Gate checklist for the merge-queue owner** (the "mayor" session): history
  scrub done; repository public at `https://github.com/squiredocs`; MIT
  `LICENSE` present; 060 merged and `/documentation/self-hosting` and
  `/install.sh` resolve on the target environment; Sam has confirmed the
  unverifiable claims in the spec's Assumptions. Then rebase, run
  `quickstart.md` section 1, merge.

- **Not run at plan time:** `sync-footer.mjs --check` is not wired into CI and
  this feature does not add it; the copy-rules test's sync assertion covers the
  same drift inside `npm run test:client`.

## Implementation phase (2026-10-07)

- **Relaxations.** One: landing section 1 does not repeat the hero screenshot
  (T009 asked for `hero-screenshot.png` inside the section; the hero directly
  above already shows it). Recorded as RBD-062-22. New defaults RBD-062-20
  (case-sensitive "Dedicated Instance" rule, needed so the verbatim FR-019
  answer passes), RBD-062-21 (nav breakpoint 960px), and RBD-062-23
  (presentation choices) are in `clarifications-needed.md`.

- **T029 nav result.** With GitHub and Self-host added, the header wrapped to
  a second row from 481px to about 930px on all four pages. The fallback
  class `landing-nav-link-wide` now hides the two links at 960px and below;
  measured afterwards, the header matches main at every width (it already
  wrapped between 481px and about 700px on main, unchanged here). Above 960px
  all eight items fit on one row.

- **T035 claims audit.** Every factual sentence on the three pages maps to the
  spec's verified list, a ratified design decision, or an RBD. Additions
  checked during implementation: the hosted "$10 of AI credits a month for
  the built-in assistant" step (verified list); "Keys encrypted at rest" for
  Self-hosted (RBD-062-8) is backed by the self-hosting design's "Generated
  secrets" (the entrypoint generates `API_KEY_ENCRYPTION_KEY` on first boot).
  No claim was added to the "cannot verify" list.

- **T036 style judgment calls.** Kept as design or retained copy: "show you
  exactly what the agent changed" (design message 2), "instead of scrolling a
  terminal" (design use case), the about card "The document is the interface"
  (FR-024 says it may stay; its "not the other way around" is the only
  not-X-but-Y construction left), and the pricing FAQ "no export fee and no
  lock-in" (retained answer). Rewritten: the section 6 intro, which first said
  the built-in assistant "runs on the provider you choose" (not true of the
  hosted default), now says it "works with five AI providers".

- **Visual pass (T037).** Screenshots of landing, pricing, about at 375, 768,
  1280px and security and a documentation page at 375 and 1280px, light theme
  only (the marketing pages have no dark theme). "Start free" is filled dark
  and "Run it yourself" is an outline button in the hero and the closing card
  (D8). The install command scrolls inside its block at 375px. The comparison
  table scrolls inside `.pricing-compare` on phones. Footers show the new
  tagline and Self-host link, including the documentation page.

- **For Sam before the gate (visual):**
  1. `screenshot-versionhistory.png`, now shown in landing section 2 per
     RBD-062-11, is a real capture whose document text and assistant names
     read "HeroDocs" (an earlier product name). It is legible at desktop width.
     Replace it with a fresh capture, or drop the image from section 2, before
     launch.
  2. The landing H1 wraps "you." onto its own line at 1280px. Copy is fixed by
     FR-003; a tighter `max-width` on the headline is a possible follow-on.

- **Pre-existing defects noticed, not fixed here:** at 375px every marketing
  page (and the documentation pages) scrolls horizontally by about 28px
  because the footer's three link columns do not fit (the same 403px
  `scrollWidth` on main). The footer is the isolated T027 region and its
  layout is out of this feature's scope. The 375px header also wraps the
  "Sign In" and "Sign Up" labels onto two lines, as on main.

- **Hand-off.** The branch `062-oss-launch-messaging` is held unmerged per D5
  and FR-042. Gate checklist (unchanged from the plan phase): history scrub
  done; repository public at `https://github.com/squiredocs`; MIT `LICENSE`
  present; 060 merged and `/documentation/self-hosting` and `/install.sh`
  resolve on the target environment; Sam has confirmed the unverifiable
  claims in the spec's Assumptions. At merge time the merge-queue owner
  rebases onto main after 060, resolves `site-footer.mjs` by keeping,
  trimming, or dropping the isolated footer commit ("Change the footer tagline
  and add a Self-host footer link (overlaps feature 060)") and re-running
  `npm run sync:footer`, repoints the GitHub links and `GITHUB_ORG_URL` in
  `client/scripts/check-copy-rules.mjs` if the repository name is decided
  (D4), re-runs quickstart.md section 1, and merges.

## Review phase (2026-10-07)

Post-implementation review (Fable, read-only) found no HIGH defects. Dispositions:

Fixed on the branch:

- MEDIUM, pricing FAQ "Add a key to turn on the built-in assistant and semantic search" conflated two keys. Design amended (f4f528c7) and copy changed to "Add your own key in Settings to turn on the built-in assistant. Semantic search turns on when the server has a Google AI key."
- LOW, "Run it on your machine" omitted the Docker prerequisite. Design amended; copy now opens "With Docker installed, tell your agent...".
- LOW, scanner false negatives: `SquireDocs` (case-sensitive, so the squiredocs.com domain still passes), `LGPL` and `GPLv3`, and "spec-driven" in `<meta name="description">`. Fixture cases added.
- LOW, the trust-strip test block ended at the next HTML comment; it now ends at the next `<section`.
- LOW, the pricing table's not-included en dashes had no accessible text; each now carries `role="img" aria-label="Not included"`.
- LOW, the inline critical CSS lacked the 960px rule hiding the two new nav links, so the nav could wrap before marketing.css loaded. Added to all four pages.
- Editorial: "priced per organization" changed to "priced on request" (matches the card); "not the other way around" cut from the about card; "exactly" cut from the diff sentence; the landing H1 gets `text-wrap: balance` so "you." no longer sits alone at 1280px.

Gate items for Sam and the merge-queue owner (not fixed in 062):

- RESOLVED 2026-10-07: Sam confirmed Codex works and keeps it in the copy; the Agents & MCP guide still needs a Codex section (mayor tracking for 060 or a follow-on). Original note: Codex is named as a supported agent (hero, "Any agent, any model", pricing, about), and the "See the Agents & MCP Guide for setup" link leads to a guide with no Codex section. Before launch, either add Codex setup to `documentation/agents-and-mcp.md` (060 or a follow-on) or drop Codex from the setup sentence.
- Confirm 060's documentation page frontmatter is exactly `slug: self-hosting`; every "Run it yourself" button and the footer Self-host link depend on it.
- "Tell your agent 'set up Squire Docs locally'" works without hunting only where the agent can find `self-host.md`: the Claude Code plugin's onboarding skill (self-hosting D9), the README, or the docs site. Agents without the plugin rely on those being discoverable.
- `screenshot-versionhistory.png` (landing section 2) shows the old "HeroDocs" name; recapture before launch.
- Pre-existing on main, not caused by 062: every marketing page scrolls horizontally at 375px (footer columns about 403px wide) and the header Sign In / Sign Up labels wrap at 375px.
- Kept as is: "There's no export fee and no lock-in." (retained pricing FAQ line), and "Any agent, any model" heading over a five-provider list (design wording).
