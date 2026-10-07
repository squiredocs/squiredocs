<!-- source: https://squiredocs.com/d/f4f528c7-ee50-4356-b181-cbfd282ab744
     synced-by: design/sync.mjs — DO NOT HAND-EDIT; amend the Squire doc and re-sync -->

# Proposal: Open Source Launch Messaging

Status: ratified by Sam 2026-10-07 ("Looks good", plus the managed-instance region amendment). Built as feature 062-oss-launch-messaging. The license is not decided, so every license mention in the copy is a placeholder (see D3).

This doc proposes how squiredocs.com describes Squire Docs once the repository is public. It covers the core positioning (what we say the product is), the supporting messages, proposed copy for the landing, pricing, and about pages, and how to test the message cheaply. Copy rules from earlier rounds still apply: "Squire Docs" in full, no em dashes, no PR-review framing, no forever promises, plain statements of limits.

## What changes

The site was written to win hosted sign-ups from spec-driven development (SDD) teams. After launch the goal is free usage of the open source project, by individuals first and then teams. That changes three things:

- **Audience.** The first reader is a developer who already uses Claude Code, Codex, Cursor, or Kiro and wants their agent's output somewhere better than a chat transcript or a scratch file. They may never sign in to squiredocs.com.
- **The ask.** The main action becomes "try it", which can mean the hosted service or a local instance. Both are free.
- **Trust.** Open source answers questions the hosted-only site had to argue for: lock-in, data location, and what happens if the company stops. The copy can state these as facts instead of promises.

SDD stays in the copy as a use case. It is no longer the headline, because the category is narrow, still forming, and we have not seen evidence that the term draws people in.

## The anchor

The headline has to say what the thing is. A developer landing from GitHub or Hacker News decides in a few seconds whether it is an app, a library, or a protocol.

### Options

**A. "Docs your agents can edit with you."** Names the object (documents) and the differentiator (agents are live co-editors, not a chat sidebar). Broad enough for specs, plans, research, and notes. Recommended.

**B. "Where people and AI agents write together."** Same idea, softer. Does not say "docs", so the reader has to infer the object.

**C. "Google Docs for you and your agents."** The fastest to understand. Risks: borrowing another company's trademark in the headline, and it invites a feature comparison we lose on (comments, suggestions, offline). Better as a line in the README or a talk than as the H1.

**D. "The collaboration layer for humans and agents."** Captures the ambition, and "layer" correctly suggests that Squire Docs sits between your agents and your team. But it is abstract: a reader cannot tell what they would install or open, and nobody searches for the phrase. It works as a second-level explanation under a concrete headline.

### Recommendation

Use A as the H1 and D's idea as the explanation underneath it. The one-sentence definition used everywhere (README first line, meta description, GitHub repo description, HN title):

> **Squire Docs is an open source collaborative editor where people and AI agents edit the same documents in real time, with every edit attributed and the content synced to markdown in your repo.**

Short form, for the GitHub "About" field and social cards: "Open source collaborative docs for people and AI agents."

## Supporting messages

Five messages, in priority order. Each section of the landing page maps to one.

1. **Agents are collaborators, not a chat tab.** Your agent connects over MCP, shows up as a named cursor, and edits the document while you watch. You can type in the same paragraph at the same time and both edits survive.
2. **Every edit has an author and can be undone.** Human or agent, each change is attributed and each version can be restored. You can see exactly what the agent changed.
3. **It is markdown, in your repo.** Import any .md file, export any document as .md, and keep a two-way sync with files in a repository. Your docs are not stuck in our database.
4. **Open source, and running in a few minutes.** Ask your agent to set it up: it runs one install command, you click a sign-in link, approve the agent, and you have a local instance with your agent connected. No accounts, API keys, or cloud services needed.
5. **Any agent, any model.** Claude Code, Codex, Cursor, Kiro, Claude Desktop, or anything that speaks MCP. The built-in assistant takes your own key for Anthropic, OpenAI, Google (Gemini), z.ai (GLM), or OpenRouter.

What we deliberately drop from the lead: "Sign in with Google" as a selling point (it is one sign-in method, and local mode does not use it), "batteries included" built-in AI as a headline (local instances have no built-in AI until a key is added), and the copy-paste-loop story from the about page (it describes the 2025 chat-tab problem, not the agent problem).

## Use cases

Replace the SDD-only section with four use cases. SDD becomes the first, not the only one.

- **Specs and design docs.** The spec your team edits and your coding agent implements against, synced to the repo so spec-kit, Kiro, or your own tooling reads the same file.
- **Agent plans and handoffs.** The plan your agent writes before it codes, in a place where you can edit it before saying go, and where the next session (or the next agent) can pick it up.
- **Research and reports.** Long agent output you want to read, mark up, and keep, instead of scrolling a terminal.
- **Team knowledge your agents maintain.** Runbooks, ADRs, and onboarding docs that agents update as the code changes, with a record of who changed what.

## Proposed copy: landing page

**Title tag:** Squire Docs: Open Source Collaborative Docs for People and AI Agents

**Meta description:** Squire Docs is an open source collaborative editor where people and AI agents edit the same documents in real time. Every edit attributed, two-way markdown sync with your repo. Use it free at squiredocs.com or run it yourself.

**Hero**

- H1: Docs your agents can edit with you.
- Sub: Squire Docs is an open source collaborative editor for people and AI agents. Connect Claude Code, Codex, or any MCP agent, watch its edits land live, and keep everything in sync with markdown in your repo.
- Primary CTA: Start free (hosted)
- Secondary CTA: Run it yourself (links to the self-host section or `/self-host`)
- Trust line: Open source ([license]) · Every edit attributed and reversible · Your docs sync to markdown

**Section: Your agent, live in the document** (message 1, with the presence screenshot or a short clip of an agent cursor editing)

**Section: See what changed, undo what you don't want** (message 2, diff highlighting and version history)

**Section: Markdown in, markdown out, synced to your repo** (message 3, keep the current repo-sync copy, it tests well internally and is accurate)

**Section: Run it on your machine** (message 4)

> Tell your agent "set up Squire Docs locally." It runs the install script, prints a sign-in link, and connects itself. Two clicks and you have your own instance on localhost, with no accounts or API keys to configure.
>
> `curl -fsSL https://squiredocs.com/install.sh | sh`
>
> [Read the self-host guide] [View on GitHub]

**Section: What people use it for** (the four use cases)

**Section: Any agent, any model** (message 5, keep the current provider grid)

**Closing CTA:** "Start writing with your agents." Buttons: Start free · Run it yourself.

## Proposed copy: pricing page

The page keeps three columns but changes what they mean:

| Column | Price | What it is |
| --- | --- | --- |
| Hosted | Free during beta | squiredocs.com. Sign in and start. $10 of AI credits a month, or bring your own key. |
| Self-hosted | Free, open source | Run it on your laptop or your own server. Your data stays on your infrastructure. Bring your own key for built-in AI. |
| Managed instance | Custom pricing | A dedicated, single-tenant Squire Docs that we run and support for your organization. Hosted in the cloud region you choose, so your data stays in the country or jurisdiction your data residency rules require. Email us. |

The two current free columns ("Unlimited Docs" and "Bring your own key") merge into "Hosted", since BYOK is a setting, not a plan. The feature table gains a self-hosted column; the rows that change are sign-in (Google on hosted; local sign-in link, with passwords and OIDC coming for teams, on self-hosted) and AI credits (hosted only).

**FAQ changes**

- "Can we run Squire Docs ourselves?" becomes: "Yes. Squire Docs is open source under the [license] license. Install it with one command, or follow the self-host guide. If you want us to run a dedicated instance for you in the cloud region of your choice, email contact@squiredocs.com."
- New: "Is the hosted version the same software?" Answer: "Yes. squiredocs.com runs the same code as the public repository."
- New: "Where can a managed instance run?" Answer: "In the cloud region you choose, including EU regions. Your documents, database, and backups stay in that region, which helps you meet data residency and sovereignty requirements. Email contact@squiredocs.com to discuss your region."
- New: "Do I need an API key to self-host?" Answer: "No. The editor, version history, repo sync, and agent connection work without one, because your own agent brings the AI. Add a key to turn on the built-in assistant and semantic search."
- "Will Squire Docs stay free?" keeps its current answer for hosted, and adds that the open source project is [license] licensed.

## Proposed copy: about page

Replace the copy-paste-loop opening with the agent problem:

- H1: Agents do real work now. They need somewhere to put it.
- Body: Coding agents write plans, specs, and reports, and most of it ends up in a terminal scrollback or a scratch file nobody else can see. Squire Docs gives that work a shared document: you and your team read it, edit it, and correct it while the agent is still working, and every change keeps its author.
- Add a short "Why open source" paragraph: the tool that holds your team's specs and your agents' work should be one you can inspect, run, and keep. It is [license] licensed, the hosted service runs the same code, and 21st Harmonic offers managed instances for teams that want one.

The "What we believe" items mostly survive. Changes: "Trust by design" drops "Google sign-in" and becomes "Your docs, your infrastructure: open source, markdown export, and self-hosting." "Open to any model or agent" stays.

## Proposed copy: shared elements

- **Footer tagline:** "Collaborative docs for people and AI agents" replaces "Write with AI, right in your doc."
- **Nav:** add "GitHub" (with star count once there are some) and "Self-host".
- **Closing CTA band** on every page: "Free. Open source. Run it yourself or use ours." replaces "Free. No Setup. Sign in with Google."

## Testing the message

We have no traffic data that shows which framing works, so we should test cheaply before the launch post rather than after:

- **Show the one-sentence definition to five developers** who use coding agents and ask them to say back what the product is. If they say "a chat app" or "an SDK", the headline is not doing its job.
- **Draft the Show HN title and README first line** in two versions (A and D) and get reactions from a few people before picking. These two lines matter more at launch than the landing page.
- **After launch, track which CTA people use** (Start free versus Run it yourself) and which use-case section they scroll to. That tells us which audience showed up.

## Scope

062 changes the copy of the hosted marketing pages: `client/public/landing.html`, `pricing.html`, and `about.html`, plus the shared marketing footer and closing call-to-action band wherever they appear (`client/public/security.html` and `client/scripts/site-footer.mjs` carry the footer tagline). Meta descriptions, title tags, and Open Graph text on those pages change with the copy.

Out of scope, owned elsewhere:

- Hiding marketing pages on self-hosted instances. Feature 058 already returns 404 for them when `SQUIRE_HOSTED` is off (`server/web-routes.js`, `server/app-shell.js`). 062 does not touch either file.
- The documentation site, the self-hosting guide page, the README, and the `/self-host.md` and `/install.sh` routes. These belong to 060-self-host-distribution.
- New product imagery (see D7), a launch blog post, and the privacy policy.

## Decisions

- **D1. Anchor.** The H1 is "Docs your agents can edit with you." and the one-sentence definition in "Recommendation" is used everywhere a definition appears. Spec-driven development moves from the headline to the first of four use cases. Ratified by Sam 2026-10-07.
- **D2. Pricing structure.** Three columns: Hosted (free during beta), Self-hosted (free, open source), and Managed instance (custom pricing, run by us in the cloud region the customer chooses, for data residency). The two current free columns merge into Hosted. Ratified by Sam 2026-10-07, including the region amendment. The column name "Managed instance" (replacing "Dedicated Instance") is RATIFIED-BY-DEFAULT (Sam pre-authorized, 2026-10-07): it names what the customer pays for now that self-hosting is free.
- **D3. The pages do not name the license.** The license is not decided (AGPL-3.0 with a DCO and MIT are both on the table). The page copy says "open source" and links to the repository, where the LICENSE file names it. The "[license]" placeholders in this doc's proposed copy are dropped in the build, so no page text changes when the license is chosen. Both candidate licenses are OSI-approved, so "open source" is accurate under either. RATIFIED-BY-DEFAULT (Sam pre-authorized, 2026-10-07). If Sam picks a source-available license instead, every "open source" claim needs rewriting.
- **D4. Repository link.** The repository URL is not decided. GitHub links point to `https://github.com/squiredocs` (the organization, which exists today and is the current footer target) and get repointed to the repository at launch. RATIFIED-BY-DEFAULT (Sam pre-authorized, 2026-10-07).
- **D5. The copy ships at launch, not before.** The new copy says Squire Docs is open source and links to the install script, which is false until the repository is public and 060 has shipped. So 062's spec and plan merge to main as usual, but the implementation branch stays unmerged until the launch gate: license chosen, history scrub done, repository public, 060 merged. The merge-queue owner merges it then. RATIFIED-BY-DEFAULT (Sam pre-authorized, 2026-10-07).
- **D6. "Run it yourself" target.** The secondary call to action and the "Run it on your machine" section link to the documentation site's self-hosting page at `/documentation/self-hosting`, which 060 creates. The section also shows the install command `curl -fsSL https://squiredocs.com/install.sh | sh` (ratified D12 of the self-hosting design). RATIFIED-BY-DEFAULT (Sam pre-authorized, 2026-10-07).
- **D7. No new imagery in 062.** The pages reuse existing screenshots. A short clip of an agent cursor editing next to a human cursor is a follow-on. RATIFIED-BY-DEFAULT (Sam pre-authorized, 2026-10-07).
- **D8. Call-to-action weight.** "Start free" stays the dominant button and "Run it yourself" is secondary, matching the earlier pricing rule that the free hosted start is the main action. RATIFIED-BY-DEFAULT (Sam pre-authorized, 2026-10-07); revisit after launch with the CTA click data from "Testing the message".

## Open questions

1. **License.** The copy assumes MIT. If it ends up Apache-2.0, it is a find-and-replace; if it changes to source-available, the "open source" claims need rewriting. _Answered by D3: the pages do not name the license._
2. **Domain for self-host docs.** The design puts `self-host.md` and `install.sh` on squiredocs.com. Should there also be a human-readable `/self-host` page, or does the documentation site cover it? _Answered by D6: 060 builds the human-readable page at /documentation/self-hosting._
3. **Hero visual.** The current hero has no product shot. An agent cursor editing next to a human cursor is the single most convincing image we could show. Worth recording a short loop for launch? _Deferred by D7._
4. **Hosted CTA weight.** Should "Start free" stay the dominant button, or should "Run it yourself" be equal weight now that hosted sign-ups are not the goal? _Defaulted by D8._
5. **Name for the paid tier.** "Managed instance" versus keeping "Dedicated Instance". "Managed" says more about what you pay for now that self-hosting is free. _Defaulted by D2 to "Managed instance"._