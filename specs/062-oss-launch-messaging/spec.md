# Feature Specification: Open Source Launch Messaging

**Feature Branch**: `062-oss-launch-messaging`

**Created**: 2026-10-07

**Status**: Draft

**Input**: User description: "062-oss-launch-messaging: rewrite the copy of the hosted marketing pages (landing, pricing, about) plus the shared marketing footer tagline and closing call-to-action band for the open source launch, per the ratified design 'Proposal: Open Source Launch Messaging' (Squire doc f4f528c7, D1 to D8). The pages describe Squire Docs as an open source collaborative editor for people and AI agents, offer 'Start free' (hosted) and 'Run it yourself' (self-hosted) side by side, restructure pricing into Hosted / Self-hosted / Managed instance, and name the MIT license. The implementation ships at the launch gate, not before."

## Ground truth and scope

The design document "Proposal: Open Source Launch Messaging" (Squire doc `f4f528c7-ee50-4356-b181-cbfd282ab744`, ratified by Sam 2026-10-07, Decisions D1 to D8) is ground truth for this feature (Constitution VI). `design/self-hosting-local-mode.md` (ratified, D1 to D12) is ground truth for every factual claim the new copy makes about self-hosting: the install command, the sign-in link, the port, and which features work without an API key. Sam's writing style guide (Squire doc `887930a2-b5ed-4a64-9c36-5c4d0ae3c3fb`) governs the prose. Where the design is silent, the choice is recorded in `clarifications-needed.md` as RATIFIED-BY-DEFAULT. Nothing is decided silently.

**In scope (the design's Scope section):**

- The copy of `client/public/landing.html`, `client/public/pricing.html`, and `client/public/about.html`: headlines, body text, section structure, calls to action, title tags, meta descriptions, Open Graph and Twitter card text.
- The shared marketing footer tagline (`client/scripts/site-footer.mjs`, stamped into the four static pages including `client/public/security.html` by the existing footer sync) and the closing call-to-action band on every page that has one (landing, pricing, about).
- The header navigation of the four static marketing pages (landing, pricing, about, security): two new links, "GitHub" and "Self-host" (RBD-062-2).
- A copy-rules test that scans the changed pages for the rules in FR-030 to FR-038, so the rules outlive this feature.

**Out of scope, owned elsewhere:**

- Hiding marketing pages on self-hosted instances (`server/web-routes.js`, `server/app-shell.js`; feature 058). This feature does not touch either file.
- The documentation site content (`documentation/*.md`), the self-hosting guide page at `/documentation/self-hosting`, the README, and the `/self-host.md` and `/install.sh` routes (feature 060). This feature links to these targets and does not create them.
- The header of the rendered documentation and blog pages (`client/scripts/render-documentation.mjs`, `client/scripts/render-blog.mjs`) (RBD-062-2, follow-on).
- The sign-in page subtitle in `client/src/components/LoginPage.jsx`, which carries the old tagline inside the application rather than the marketing site (RBD-062-1, follow-on).
- New product imagery (D7), a GitHub star count in the nav (RBD-062-2), a launch blog post, the privacy policy, and the security page's own body copy.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - A developer landing from GitHub understands what Squire Docs is and how to try it (Priority: P1)

A developer who uses Claude Code, Codex, Cursor, or Kiro arrives at squiredocs.com from the repository, a Show HN post, or a search. Within the first screen they learn that Squire Docs is an open source collaborative editor where people and AI agents edit the same documents in real time, that it is MIT licensed, and that they can either start free on the hosted service or run it on their own machine. They can find the one-line install command and a link to the self-hosting guide and the repository without scrolling past the self-host section.

**Why this priority**: The headline and the two calls to action are the whole point of the launch rewrite (D1, D8). Everything else on the page supports them.

**Independent Test**: Load `landing.html` and read the title tag, H1, subheadline, trust line, primary and secondary buttons, and the "Run it on your machine" section. Each must match the requirements below. The copy-rules scan passes on the file.

**Acceptance Scenarios**:

1. **Given** the landing page, **When** a visitor reads the hero, **Then** the H1 is "Docs your agents can edit with you.", the subheadline says Squire Docs is an open source collaborative editor for people and AI agents and names Claude Code, Codex, and MCP, and the trust line reads "Open source (MIT) · Every edit attributed and reversible · Your docs sync to markdown".
2. **Given** the hero, **When** the visitor looks for an action, **Then** a primary "Start free" button leads to sign-up and a visually secondary "Run it yourself" button leads to `/documentation/self-hosting`, with the primary button dominant (D8).
3. **Given** the "Run it on your machine" section, **When** the visitor reads it, **Then** it shows the install command `curl -fsSL https://squiredocs.com/install.sh | sh` verbatim, explains that the agent runs the install script, prints a sign-in link, and connects itself, and offers "Read the self-host guide" (to `/documentation/self-hosting`) and "View on GitHub" (to `https://github.com/squiredocs`) links.
4. **Given** the page's `<head>`, **When** a crawler or social card reads it, **Then** the title is "Squire Docs: Open Source Collaborative Docs for People and AI Agents", the meta description is the design's meta description, and the Open Graph and Twitter descriptions carry the one-sentence definition or its short form.
5. **Given** the hero and trust strip, **When** the visitor reads them, **Then** no text presents "Sign in with Google", "batteries included" built-in AI, or Anthropic's models as a selling point.

---

### User Story 2 - A visitor comparing options finds the right column on the pricing page (Priority: P1)

A visitor who wants to know what it costs sees three columns: Hosted (free during beta), Self-hosted (free, open source), and Managed instance (custom pricing). They can tell which column gives them AI credits, which keeps their data on their own infrastructure, which lets them pick a cloud region for data residency, and how sign-in works on each. The FAQ answers whether they can run it themselves, whether the hosted version is the same software, where a managed instance can run, whether self-hosting needs an API key, and whether it will stay free.

**Why this priority**: D2 restructures the offer itself. A pricing page that still shows "Unlimited Docs" and "Bring your own key" as separate plans contradicts the landing page.

**Independent Test**: Load `pricing.html`, read the three cards, the comparison table, and the FAQ entries. Each must match the requirements below. The copy-rules scan passes on the file.

**Acceptance Scenarios**:

1. **Given** the plan cards, **When** the visitor reads them, **Then** exactly three cards appear, named "Hosted", "Self-hosted", and "Managed instance", with prices "Free during beta", "Free, open source", and "Custom pricing", and descriptions matching the design's table (the hosted card mentions $10 of AI credits a month or bring your own key; the self-hosted card says data stays on your infrastructure and built-in AI needs your own key; the managed card says a dedicated single-tenant instance run and supported by us in the cloud region you choose for data residency).
2. **Given** the cards, **When** the visitor looks for an action, **Then** Hosted leads to sign-up ("Start free"), Self-hosted leads to `/documentation/self-hosting` ("Run it yourself"), and Managed instance leads to an email to contact@squiredocs.com.
3. **Given** the comparison table, **When** the visitor reads the sign-in row, **Then** the hosted column says Google, the self-hosted column says a sign-in link minted by your instance, and the AI credits row is marked for hosted only.
4. **Given** the FAQ, **When** the visitor expands "Can we run Squire Docs ourselves?", **Then** the answer says Squire Docs is open source under the MIT license, can be installed with one command or by following the self-host guide, and that a dedicated instance in the cloud region of their choice is available by emailing contact@squiredocs.com.
5. **Given** the FAQ, **When** the visitor reads it, **Then** it also contains "Is the hosted version the same software?" (yes, squiredocs.com runs the same code as the public repository), "Where can a managed instance run?" (the cloud region you choose, including EU regions; documents, database, and backups stay in that region), and "Do I need an API key to self-host?" (no; the editor, version history, repo sync, and agent connection work without one; a key turns on the built-in assistant and semantic search).
6. **Given** the FAQ entry "Will Squire Docs stay free?", **When** the visitor reads it, **Then** it keeps the current hosted answer and adds that the open source project is MIT licensed.
7. **Given** the whole page, **When** searched for the old plan names, **Then** "Unlimited Docs", "Bring your own key" as a plan name, and "Dedicated Instance" do not appear.

---

### User Story 3 - A visitor reading the about page understands the problem and why it is open source (Priority: P2)

A visitor opens the about page to learn why Squire Docs exists. The opening states the agent problem (agents write plans, specs, and reports that end up in terminal scrollback or scratch files) and how Squire Docs gives that work a shared, attributed document. A short "Why open source" paragraph says the tool should be one you can inspect, run, and keep; that it is MIT licensed; that the hosted service runs the same code; and that 21st Harmonic offers managed instances.

**Why this priority**: The about page is the second-level explanation. It matters less than the landing and pricing pages but the current copy-paste-loop story contradicts the new positioning.

**Independent Test**: Load `about.html`, read the H1, the opening prose, the "Why open source" paragraph, and the four "What we believe" cards. Each must match the requirements below. The copy-rules scan passes on the file.

**Acceptance Scenarios**:

1. **Given** the about hero, **When** the visitor reads it, **Then** the H1 is "Agents do real work now. They need somewhere to put it." and the copy-paste-loop story ("You know the ritual...") is gone.
2. **Given** the prose section, **When** the visitor reads it, **Then** the body paragraph from the design (coding agents write plans, specs, and reports; most of it ends up in a terminal scrollback or a scratch file; Squire Docs gives that work a shared document; every change keeps its author) appears, followed by a "Why open source" paragraph that says it is MIT licensed, links to the repository, says the hosted service runs the same code, and says 21st Harmonic offers managed instances.
3. **Given** the "What we believe" cards, **When** the visitor reads them, **Then** "Trust by design" reads "Your docs, your infrastructure: open source, markdown export, and self-hosting." with no mention of Google sign-in, "Open to any model or agent" stays, and no card frames agent edits as something submitted for review or approval.

---

### User Story 4 - Every page carries the same launch tagline and closing call to action (Priority: P2)

Whatever page a visitor is on (landing, pricing, about, security, documentation, blog), the footer tagline reads "Collaborative docs for people and AI agents", and on the pages that have a closing call-to-action band the band says "Start writing with your agents." with the subtext "Free. Open source. Run it yourself or use ours." and both buttons.

**Why this priority**: The footer is generated from one source and stamped into every page; a stale tagline anywhere undercuts the launch message.

**Independent Test**: Grep the repository for the old strings "Write with AI, right in your doc" and "Free. No Setup. Sign in with Google." in `client/public/*.html` and `client/scripts/site-footer.mjs`; none remain. The rendered documentation and blog templates carry the new tagline because they import the same footer.

**Acceptance Scenarios**:

1. **Given** `site-footer.mjs` and the four static pages, **When** the footer sync runs, **Then** every footer tagline reads "Collaborative docs for people and AI agents" and the footer Product column contains "GitHub" (to `https://github.com/squiredocs`) and "Self-host" (to `/documentation/self-hosting`).
2. **Given** the closing band on landing, pricing, and about, **When** the visitor reaches it, **Then** the heading is "Start writing with your agents.", the subtext is "Free. Open source. Run it yourself or use ours.", a primary "Start free" button leads to sign-up, a secondary "Run it yourself" button leads to `/documentation/self-hosting`, and the "Questions? Email us. A human answers." line stays.
3. **Given** the header nav on the four static pages, **When** the visitor reads it, **Then** it contains "GitHub" and "Self-host" links in addition to Pricing, About, Documentation, Blog, Sign In, and Sign Up, and the Documentation link is unchanged.

---

### User Story 5 - The copy rules are enforced by a test, not by memory (Priority: P3)

A maintainer or agent editing any of the changed pages later gets a failing test if they introduce an em dash, a bare "Squire", the word "honest", a forever promise, PR-review framing, a provider list that names GLM without "z.ai", a license other than MIT, or the retired taglines.

**Why this priority**: The rules came from several rounds of feedback and are easy to break in a one-line edit. The test turns them into a gate.

**Independent Test**: Run the copy-rules test against the changed pages: it passes on the new copy and fails when a fixture string containing each forbidden pattern is injected.

**Acceptance Scenarios**:

1. **Given** the copy-rules test, **When** it runs against `landing.html`, `pricing.html`, `about.html`, and the footer source, **Then** it passes.
2. **Given** a copy of a page with "Squire" (not followed by "Docs") inserted into prose, an em dash inserted, "honestly" inserted, "free forever" inserted, "pull request" inserted, "GLM" without "z.ai (" inserted, or "AGPL" inserted, **When** the test's checker runs on that text, **Then** it reports each violation.

---

### Edge Cases

- **Launch gate (D5)**: the copy claims Squire Docs is open source and links to `/install.sh`, `/documentation/self-hosting`, and the repository. None of these is true or resolvable until the repository is public and feature 060 has merged. The implementation branch therefore stays unmerged until the launch gate (license chosen: done, MIT; history scrub done; repository public; 060 merged). This is a release constraint on the merge queue, not a code mechanism. The spec and plan merge to main as usual.
- **Links to pages that do not exist yet**: `/documentation/self-hosting`, `/install.sh`, and `/self-host.md` do not exist in this branch. The implementation must not create them (060 owns them) and must not add fallbacks or redirects for them.
- **Repository URL (D4)**: the repository name is not decided. Every GitHub link points to the organization `https://github.com/squiredocs`. Repointing to the repository at launch is a find-and-replace on one URL; the test asserts the organization URL, so that replacement must update the test in the same change.
- **Footer propagation**: the footer is imported by the documentation and blog renderers, so the new tagline and "Self-host" link appear on those pages too. That is intended (the design says "wherever they appear"). Their header nav is not changed by this feature.
- **The footer sync marker comment** contains an em dash inside an HTML comment (quoted verbatim from the existing marker: `<!-- site-footer:start (generated from scripts/site-footer.mjs — edit there ...`). It is a build marker, not copy. The copy-rules scan strips HTML comments before checking, and the marker is left alone so the footer sync keeps working.
- **Comparison-table "not included" glyph**: the current table marks excluded features with `&mdash;`. The em-dash rule covers the rendered entity too, so the table switches to a marker that is not an em dash (RBD-062-4).
- **Existing terminology gate**: the documentation-build test already fails any marketing copy that uses "docs" to mean product documentation. New copy must say "self-host guide" or "Documentation", never "self-host docs" or "the docs".
- **No `aria`/visual regressions beyond copy**: the pages keep their existing layout, CSS classes, and screenshots (D7). Where a section is renamed or reordered, the existing section components are reused.
- **Google button branding**: the hero and closing band drop the "Sign in with Google" text. Whether the "Start free" button keeps the Google glyph is a presentation choice left to implementation; the copy requirements do not depend on it.

## Requirements *(mandatory)*

### Functional Requirements

**Landing page (D1, D6, D7, D8)**

- **FR-001**: The landing page title tag MUST be "Squire Docs: Open Source Collaborative Docs for People and AI Agents", and its `og:title` and `twitter:title` MUST match it.
- **FR-002**: The landing page meta description MUST be: "Squire Docs is an open source collaborative editor where people and AI agents edit the same documents in real time. Every edit attributed, two-way markdown sync with your repo. Use it free at squiredocs.com or run it yourself." The `og:description` and `twitter:description` MUST be either that text or the short form "Open source collaborative docs for people and AI agents."
- **FR-003**: The hero H1 MUST be "Docs your agents can edit with you." and the subheadline MUST be: "Squire Docs is an open source collaborative editor for people and AI agents. Connect Claude Code, Codex, or any MCP agent, watch its edits land live, and keep everything in sync with markdown in your repo."
- **FR-004**: The hero MUST show two calls to action: a primary button labeled "Start free" linking to `/signup`, and a secondary button labeled "Run it yourself" linking to `/documentation/self-hosting`. The primary button MUST be visually dominant (D8). The hero MUST NOT contain the text "No setup. Sign in with Google." or any other sentence presenting the sign-in method as a benefit.
- **FR-005**: The trust strip MUST contain exactly three items, in order: "Open source (MIT)", "Every edit attributed and reversible", "Your docs sync to markdown". The "Open source (MIT)" item MUST link to `https://github.com/squiredocs`. The current items about Anthropic's models, Google sign-in, and encrypted API keys MUST be removed from the strip.
- **FR-006**: The landing page MUST present these sections in this order after the hero and trust strip, each mapping to one supporting message of the design: (1) "Your agent, live in the document", (2) "See what changed, undo what you don't want", (3) "Markdown in, markdown out, synced to your repo", (4) "Run it on your machine", (5) "What people use it for", (6) "Any agent, any model", followed by the closing call-to-action band.
- **FR-007**: Section (1) MUST state that an agent connects over MCP, appears as a named cursor, and edits the document while you watch, and that two parties can type in the same paragraph at the same time with both edits surviving. It MUST reuse an existing screenshot (RBD-062-11); no new imagery.
- **FR-008**: Section (2) MUST state that every change, human or agent, is attributed and that each version can be restored, and that you can see exactly what the agent changed (diff highlighting and version history).
- **FR-009**: Section (3) MUST keep the current repo-sync copy (import any markdown, export .md, two-way sync with the files in your repo, push merges like an edit from an offline collaborator with attribution intact, GFM task lists, tables, and mermaid diagrams render natively) and its three cards, with the retained "always yours" sentence reworded per FR-034.
- **FR-010**: Section (4) MUST contain the paragraph: "Tell your agent \"set up Squire Docs locally.\" It runs the install script, prints a sign-in link, and connects itself. Two clicks and you have your own instance on localhost, with no accounts or API keys to configure." It MUST show the command `curl -fsSL https://squiredocs.com/install.sh | sh` verbatim in a code element, and MUST offer two links: "Read the self-host guide" to `/documentation/self-hosting` and "View on GitHub" to `https://github.com/squiredocs`.
- **FR-011**: Section (5) MUST present exactly four use cases with these headings and the design's descriptions: "Specs and design docs" (synced to the repo so spec-kit, Kiro, or your own tooling reads the same file), "Agent plans and handoffs", "Research and reports", "Team knowledge your agents maintain". Spec-driven development MUST appear only within the first use case, not in any heading, the title tag, or the meta description.
- **FR-012**: Section (6) MUST list the agents "Claude Code, Codex, Cursor, Kiro, Claude Desktop, or anything that speaks MCP" and the providers "Anthropic, Google (Gemini), OpenAI, z.ai (GLM), or OpenRouter" for the built-in assistant's own-key option, keep the link to `/documentation/agents-and-mcp`, and MUST NOT describe the built-in assistant as "batteries included" or "ready the moment you open a doc".
- **FR-013**: The landing page MUST NOT contain the current headline "Your specs live in the repo.", the section title "For spec-driven engineering teams", the section title "Collaborative Docs for Spec-Driven Development", or the sentence "Use Claude, ChatGPT, Gemini, GLM, or any agent right inside your document."

**Pricing page (D2)**

- **FR-014**: The pricing page MUST show exactly three plan cards, in order: "Hosted" priced "Free during beta", "Self-hosted" priced "Free, open source", and "Managed instance" priced "Custom pricing". The names "Unlimited Docs", "Bring your own key" (as a plan name), and "Dedicated Instance" MUST NOT appear anywhere on the page.
- **FR-015**: The card descriptions MUST carry the design's content: Hosted: squiredocs.com, sign in and start, $10 of AI credits a month, or bring your own key. Self-hosted: run it on your laptop or your own server, your data stays on your infrastructure, bring your own key for built-in AI. Managed instance: a dedicated, single-tenant Squire Docs that we run and support for your organization, hosted in the cloud region you choose so your data stays in the country or jurisdiction your data residency rules require, email us.
- **FR-016**: Card actions: Hosted MUST link to `/signup` with the label "Start free"; Self-hosted MUST link to `/documentation/self-hosting` with the label "Run it yourself"; Managed instance MUST link to `mailto:contact@squiredocs.com` with a subject naming the managed instance.
- **FR-017**: The comparison table MUST have the three plan columns in the same order as the cards and the rows and marks defined in RBD-062-8. In particular the sign-in row MUST read "Sign in with Google" for Hosted, "Sign-in link minted by your instance" for Self-hosted, and "Sign in with Google" for Managed instance; the "$10 of AI credits every month" row MUST be marked for Hosted only; the bring-your-own-key row MUST list "Anthropic, Google (Gemini), OpenAI, z.ai (GLM), or OpenRouter" and be marked for all three; a "Runs on your own infrastructure" row MUST be marked for Self-hosted only; a "Hosted in the cloud region you choose" row MUST be marked for Managed instance only.
- **FR-018**: The pricing hero MUST be rewritten so it no longer describes a single hosted plan (current: "Simple pricing while we're in beta" / "Every account includes AI credits each month"). Default copy is in RBD-062-14.
- **FR-019**: The FAQ MUST contain, in addition to the retained entries ("What happens when my credits run out?", "Do I need a credit card?", "What happens to my documents if I stop using Squire Docs?"), these entries with these answers:
  - "Can we run Squire Docs ourselves?": "Yes. Squire Docs is open source under the MIT license. Install it with one command, or follow the self-host guide. If you want us to run a dedicated instance for you in the cloud region of your choice, email contact@squiredocs.com." The words "MIT license" MUST link to `https://github.com/squiredocs` and "self-host guide" MUST link to `/documentation/self-hosting`.
  - "Is the hosted version the same software?": "Yes. squiredocs.com runs the same code as the public repository."
  - "Where can a managed instance run?": "In the cloud region you choose, including EU regions. Your documents, database, and backups stay in that region, which helps you meet data residency and sovereignty requirements. Email contact@squiredocs.com to discuss your region."
  - "Do I need an API key to self-host?": "No. The editor, version history, repo sync, and agent connection work without one, because your own agent brings the AI. Add your own key in Settings to turn on the built-in assistant. Semantic search turns on when the server has a Google AI key."
  - "Will Squire Docs stay free?": the current hosted answer, with one added sentence stating that the open source project is MIT licensed.
- **FR-020**: The pricing page title MUST stay "Pricing | Squire Docs"; its meta description and `og:description` MUST describe the three options (hosted free during beta with $10 of AI credits a month, self-hosted free and open source, managed instances in the cloud region you choose) and MUST NOT mention "Dedicated" instances (RBD-062-15).

**About page**

- **FR-021**: The about hero H1 MUST be "Agents do real work now. They need somewhere to put it." The hero subline, the title ("About | Squire Docs"), meta description, and `og:description` MUST derive from the new positioning and MUST NOT mention the copy-paste loop, "chat tab", or "engineering leaders" (RBD-062-15).
- **FR-022**: The prose section MUST open with: "Coding agents write plans, specs, and reports, and most of it ends up in a terminal scrollback or a scratch file nobody else can see. Squire Docs gives that work a shared document: you and your team read it, edit it, and correct it while the agent is still working, and every change keeps its author." The four current paragraphs beginning "You know the ritual" MUST be removed.
- **FR-023**: The prose section MUST include a "Why open source" paragraph stating that the tool that holds your team's specs and your agents' work should be one you can inspect, run, and keep; that it is MIT licensed (linking to `https://github.com/squiredocs`); that the hosted service runs the same code; and that 21st Harmonic offers managed instances for teams that want one.
- **FR-024**: The "What we believe" grid MUST keep four cards. "Trust by design" MUST read "Your docs, your infrastructure: open source, markdown export, and self-hosting." and MUST NOT mention Google sign-in. "Open to any model or agent" MUST stay, MUST list the provider "z.ai (GLM)" (currently bare "z.ai"), and MUST NOT open with the hosted-only built-in agent; it leads with connecting any MCP agent and bringing your own key (RBD-062-19). "Agent work is accountable work" MUST be reworded to remove "gets reviewed like a collaborator's work, never pasted over anonymously" (FR-036). "The document is the interface" MAY stay as is.
- **FR-025**: The "Who's behind it" section and its contact card MUST stay.

**Shared elements (footer, nav, closing band)**

- **FR-026**: The footer tagline in `client/scripts/site-footer.mjs` MUST be "Collaborative docs for people and AI agents", and the footer sync MUST be run so `landing.html`, `pricing.html`, `about.html`, and `security.html` carry it. The string "Write with AI, right in your doc" MUST NOT remain in any file under `client/public/` or in `site-footer.mjs`.
- **FR-027**: The footer Product column MUST keep "GitHub" pointing to `https://github.com/squiredocs` and MUST gain a "Self-host" link to `/documentation/self-hosting` (RBD-062-3).
- **FR-028**: The closing call-to-action band on landing, pricing, and about MUST have the heading "Start writing with your agents.", the subtext "Free. Open source. Run it yourself or use ours.", a primary "Start free" button to `/signup`, a secondary "Run it yourself" button to `/documentation/self-hosting`, and the retained line "Questions? Email us. A human answers." The string "Free. No Setup. Sign in with Google." MUST NOT remain anywhere under `client/public/`.
- **FR-029**: The header nav on landing, pricing, about, and security MUST gain a "GitHub" link to `https://github.com/squiredocs` and a "Self-host" link to `/documentation/self-hosting`, placed after "Blog" and before "Sign In", and MUST keep the existing `<a href="/documentation" class="landing-nav-link">Documentation</a>` link byte-for-byte (the documentation-build test asserts it). No star count (RBD-062-2).

**Copy rules (testable; enforced by a scan over `landing.html`, `pricing.html`, `about.html`, and the `FOOTER` string in `site-footer.mjs`, with HTML comments stripped first)**

- **FR-030**: The product name MUST appear as "Squire Docs" in prose. The scan MUST fail on any occurrence of the word "Squire" (capital S, word-bounded) not immediately followed by " Docs", excluding URLs and hostnames (`squiredocs.com`, `github.com/squiredocs`), and excluding HTML comments.
- **FR-031**: No em dash MAY appear: the scan MUST fail on the character U+2014 and on the entity `&mdash;` anywhere outside HTML comments, including title, meta, and attribute text.
- **FR-032**: The words "honest" and "honestly" (case-insensitive, word-bounded) MUST NOT appear.
- **FR-033**: No forever promise MAY appear: the scan MUST fail on "forever", "always free", "free forever", "never charge", and the standalone word "ever" (case-insensitive, word-bounded; "every" does not match) (RBD-062-5).
- **FR-034**: The retained sentences "Your content is always yours and up to date." (landing) and "your documents are always yours" (pricing FAQ) and "your documents always yours to export" (about) MUST be reworded to state the mechanism instead of a promise, for example "Every doc exports as portable .md at any time." (RBD-062-5).
- **FR-035**: Every occurrence of "GLM" MUST be preceded by "z.ai (" and every occurrence of "z.ai" MUST be followed by " (GLM)", so the provider is always listed as "z.ai (GLM)".
- **FR-036**: No PR-review or approval framing of agent edits MAY appear: the scan MUST fail on "pull request", the standalone token "PR" or "PRs", "code review", "for approval", "for review", "reviewed like", and "review the agent" (case-insensitive). The word "approve" is allowed only in the sense of approving an agent's connection (OAuth consent), as in the design's message 4 (RBD-062-6).
- **FR-037**: The only license named on the changed pages MUST be MIT: the scan MUST fail on "AGPL", "GPL", "Apache", "BSD", and "MPL" (word-bounded, case-insensitive), and MUST require at least one occurrence of "MIT" on each of landing, pricing, and about (D3). Every "MIT" mention that is a license statement MUST link to `https://github.com/squiredocs`.
- **FR-038**: The retired strings "Write with AI, right in your doc", "Free. No Setup. Sign in with Google.", "spec-driven" in a heading or title, "Unlimited Docs", "Dedicated Instance", "Batteries included", and "ChatGPT" MUST NOT appear in the scanned files.
- **FR-039**: The new copy MUST follow the style guide: each section opens by stating what the thing is or does; no metaphors or flourishes; no sentence that describes what the product is not before saying what it is; no absolute words that overstate ("never", "always", "costs nothing") unless literally true; sentences carrying more than two ideas are split. This is a review requirement, checked at adversarial review, not by the scan.

**Claims and release constraints**

- **FR-040**: Every factual claim in the new copy MUST be true at launch and traceable to the codebase or a ratified design decision. The verified list and the unverifiable business claims are recorded in the Assumptions section; the implementation MUST NOT add claims beyond the design's copy without adding them to that list.
- **FR-041**: The implementation MUST NOT modify `server/web-routes.js`, `server/app-shell.js`, anything under `documentation/`, `README.md`, the documentation or blog renderers' headers, or add routes for `/self-host.md`, `/install.sh`, or `/documentation/self-hosting`.
- **FR-042 (release constraint, D5)**: The implementation branch MUST NOT be merged to main before the launch gate: MIT `LICENSE` file present (added by 060), history scrub done, repository public under `https://github.com/squiredocs`, feature 060 merged (so `/documentation/self-hosting` and `/install.sh` resolve). The spec and plan merge as usual. This is recorded in `promotion-notes.md` as a merge-queue precondition.
- **FR-043**: All existing tests over these pages MUST keep passing: `client/src/__tests__/documentation-build.test.js` (Documentation nav and footer link assertions, header and footer structural markers, the terminology sweep over `client/public/`), `server/__tests__/web-routes.test.js`, and `server/__tests__/hosted-parity.test.js` (both use stub pages and do not assert copy).

### Key Entities

This feature has no data model. The "entities" are the copy surfaces:

- **Marketing page**: one of `landing.html`, `pricing.html`, `about.html`, `security.html`; carries a title, meta description, Open Graph text, header nav, body sections, an optional closing call-to-action band, and the shared footer.
- **Shared footer**: the single `FOOTER` string in `site-footer.mjs`, stamped into the four static pages and imported by the documentation and blog renderers.
- **Copy rule**: a pattern the scan checks (FR-030 to FR-038), with the set of files it applies to and the HTML-comment exclusion.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: A reader shown only the landing hero (H1, subheadline, trust line) can state in one sentence that Squire Docs is an open source collaborative document editor for people and AI agents, and can name both ways to try it (hosted free, run it yourself). Checked with the design's five-developer read-back test before the launch post; fewer than two of five describing it as "a chat app" or "an SDK" passes.
- **SC-002**: A visitor can reach the install command and the self-host guide link from the landing page in one scroll and zero clicks, and from the pricing page in one click (the Self-hosted card).
- **SC-003**: Zero occurrences of the retired strings ("Write with AI, right in your doc", "Free. No Setup. Sign in with Google.", "Unlimited Docs", "Dedicated Instance") remain under `client/public/` or in `site-footer.mjs`.
- **SC-004**: The copy-rules scan reports zero violations on the four scanned sources and reports at least one violation for each injected fixture in User Story 5.
- **SC-005**: All three existing suites that touch these pages pass unchanged (FR-043), and the terminology sweep in `documentation-build.test.js` reports zero violations.
- **SC-006**: Every factual claim in the new copy maps to a line in the Assumptions "Claims verified" list or to a ratified design decision; the "Claims not verifiable from the repository" list is reviewed by Sam before the launch gate opens.
- **SC-007**: After launch, the hosted sign-up and the "Run it yourself" click-through are both measurable from the existing analytics tag (the two buttons link to distinct destinations), so the D8 weighting can be revisited with data.

## Assumptions

### Decisions inherited from the design (binding)

- D1 anchor, D2 pricing structure, D3 MIT named on the pages, D4 organization URL, D5 ships at launch, D6 "Run it yourself" target and install command, D7 no new imagery, D8 CTA weight.

### Claims verified against the repository or ratified designs

- "$10 of AI credits a month" on hosted: `migrations/1784000000000_raise-default-ai-credit.js` sets `users.ai_credit_cents` default to 1000 (hosted only per feature 058's `SQUIRE_HOSTED` gating).
- "Add a key to turn on the built-in assistant and semantic search" and "semantic search is off without a key": `server/search.js` falls back to full-text when `GOOGLE_GENERATIVE_AI_API_KEY` is unset; `design/self-hosting-local-mode.md` "AI features without keys".
- "The editor, version history, repo sync, and agent connection work without one [an API key]" and "no accounts, API keys, or cloud services needed": `design/self-hosting-local-mode.md` Goals and "AI features without keys".
- Install command `curl -fsSL https://squiredocs.com/install.sh | sh`: self-hosting design D12 (ratified).
- "Prints a sign-in link", "two clicks": self-hosting design "Sign-in links" and D2 (claim link Continue plus the consent Approve); feature 059 built the links.
- "Sign in with Google" on hosted: today's only hosted provider (`design/authentication-and-sharing.md`; 059 keeps the hosted service in team mode with Google).
- Provider list "Anthropic, OpenAI, Google (Gemini), z.ai (GLM), OpenRouter": labels in `server/api/ai-providers.js`.
- Agents "Claude Code, Codex, Cursor, Kiro, Claude Desktop": `documentation/agents-and-mcp.md` (Add to Cursor deeplink), features 032/033 (Claude plugin, Kiro Power, Cursor plugin).
- "Shows up as a named cursor", "type in the same paragraph at the same time and both edits survive", "every edit attributed", "each version can be restored", "see exactly what the agent changed": presence (015, 037), CRDT collaboration, version history with restore, inline diff highlighting (022), all live in production.
- "Import any .md, export .md, two-way sync with your repo": retained copy, markdown sync features.
- "Keys encrypted at rest": `server/crypto.js` uses AES-256-GCM (retained where kept).

### Claims the repository cannot verify (business or launch-gated; Sam to confirm before the launch gate)

- "squiredocs.com runs the same code as the public repository": true by the self-hosting design's goal and D8 (hosted-only code stays in the repository behind `SQUIRE_HOSTED`), but only checkable once the repository is public.
- "MIT licensed": Sam's decision 2026-10-07 (design D3). There is no `LICENSE` file in the repository yet; adding one is part of the launch gate, not this feature.
- "Hosted in the cloud region you choose, including EU regions; documents, database, and backups stay in that region": a managed-service commitment ratified by Sam in the region amendment. The current hardened cluster is single-region; nothing in the repository provisions a per-customer region. This is a sales promise, not a product mechanism.
- "A dedicated, single-tenant Squire Docs that we run and support": business commitment, as today's "Dedicated Instance" card already claimed.
- "with passwords and OIDC coming for teams" (design's pricing table note): depends on the team-mode amendment in `design/authentication-and-sharing.md`, which is proposed and not ratified (feature 061, "can follow launch"). Omitted from the page copy by default (RBD-062-6).
- "the presence screenshot" (design, section 1): no presence screenshot exists under `client/public/`. The section reuses an existing image (RBD-062-11).
- GitHub star count in the nav: deferred; requires a script or API call the pages do not have today (RBD-062-2).

### Other assumptions

- `/documentation/self-hosting` is the human-readable self-host page created by feature 060; this feature only links to it.
- The pages keep their existing CSS, layout, and screenshot assets; the implementation reuses existing section components and button classes. The Google glyph on the "Start free" button is a presentation choice, not a copy requirement.
- The footer sync (`npm run sync:footer`, also run by `npm run build`) is the mechanism that propagates the tagline; the implementation runs it rather than editing the four footers by hand.
- No Open Graph image is added (none exists today; the documentation-build test asserts no `og:image` on documentation pages, and the marketing pages follow the same convention).
- The design's "Testing the message" section (five-developer read-back, Show HN title A/B, post-launch CTA tracking) is launch-process work for Sam, not implementation work; SC-001 and SC-007 record it so the result has a home.
