# Clarifications Ledger: 062-oss-launch-messaging

Per Constitution VI, unanswered product decisions get the best default,
recorded here. Work never blocks on the maintainer, and nothing is decided
silently. All entries below: **RATIFIED-BY-DEFAULT (Sam pre-authorized,
2026-10-07)** unless later overturned.

Ground truth: "Proposal: Open Source Launch Messaging" (Squire doc
`f4f528c7-ee50-4356-b181-cbfd282ab744`, ratified, D1 to D8; D3 amended the
same day to name MIT) and `design/self-hosting-local-mode.md` (ratified, D1 to
D12) for every self-hosting claim. Sam's writing style guide (Squire doc
`887930a2-b5ed-4a64-9c36-5c4d0ae3c3fb`) governs the prose.

---

## RBD-062-1 - The sign-in page subtitle carries the old tagline

**Question**: `client/src/components/LoginPage.jsx` renders "Write with AI,
right in your doc" as the sign-in page subtitle. The design's scope lists the
marketing pages and the footer "wherever it appears". Is the sign-in page in
scope?

**Why it matters**: After launch the footer says "Collaborative docs for people
and AI agents" while the page a visitor lands on after "Start free" still says
the old line. Changing it, though, touches the application shell that 059
renders from the instance's providers and that self-hosted instances show too.

**Default chosen**: Out of scope for 062. Recorded as a follow-on in
`promotion-notes.md`. The copy-rules scan does not cover `LoginPage.jsx`.

**Rationale**: The design names the files it changes and lists the application
as out of scope by omission. The sign-in page is owned by the identity work
(059, 061) and is shown on self-hosted instances where "Collaborative docs for
people and AI agents" may or may not be the right subtitle. A one-line follow-on
is cheaper than a scope dispute in the merge queue.

---

## RBD-062-2 - Nav additions: which pages, and no star count

**Question**: The design says "Nav: add GitHub (with star count once there are
some) and Self-host." Which pages get the links, and how is the star count
shown?

**Why it matters**: The header nav is copied into each static page and into the
documentation and blog renderers separately. A star count needs a script or an
API call the pages do not have today.

**Default chosen**: "GitHub" (to `https://github.com/squiredocs`) and
"Self-host" (to `/documentation/self-hosting`) are added to the header nav of
the four static marketing pages (landing, pricing, about, security), placed
after "Blog" and before "Sign In". No star count. The documentation and blog
renderers' headers are not changed by this feature (the documentation site is
060's and the design lists it out of scope); the drift is recorded as a
follow-on in `promotion-notes.md`.

**Rationale**: Security is already touched by the footer sync and shares the
marketing chrome, so leaving its nav different would be a visible
inconsistency on four pages that look identical. A star count is a new
mechanism (client-side fetch of the GitHub API or a badge image) and the design
itself defers it ("once there are some").

---

## RBD-062-3 - Footer gains a "Self-host" link

**Question**: The design changes the footer tagline. Should the footer Product
column also link to the self-hosting guide?

**Why it matters**: The footer is the one place that appears on every page,
including documentation and blog pages whose nav this feature does not touch.

**Default chosen**: Yes. "Self-host" (to `/documentation/self-hosting`) is added
to the footer Product column after "GitHub". GitHub stays at
`https://github.com/squiredocs` (D4).

**Rationale**: It gives documentation and blog visitors the self-host path
without touching the renderers' headers, and the design's shared-elements list
pairs GitHub and Self-host as the two new links.

---

## RBD-062-4 - Em-dash rule and the comparison table's "not included" glyph

**Question**: The pricing table marks excluded features with `&mdash;`. The
footer sync marker is an HTML comment containing a literal em dash. Does the
no-em-dash rule cover these?

**Why it matters**: A scan that flags the marker comment forces a change to
`site-footer.mjs`'s marker and a re-stamp of every page for a string nobody
reads. A scan that ignores entities lets em dashes back in through `&mdash;`.

**Default chosen**: The scan strips HTML comments first, then fails on U+2014
and on `&mdash;`. The comparison table's excluded cells switch to a marker that
is not an em dash (implementation picks; a short text such as "No" or an en dash
with an accessible label are both acceptable). The footer marker comment is
left alone.

**Rationale**: The rule is about copy readers see. The marker is build
tooling. The table glyph is rendered to readers and read aloud by assistive
tech as "em dash", so it falls under the rule.

---

## RBD-062-5 - "No forever promises": the banned list and the retained "always yours" sentences

**Question**: The design says "no forever promises" and keeps the current
answer to "Will Squire Docs stay free?", which ends "your documents are always
yours". The landing and about pages also say "always yours". Which words does
the scan ban, and do those sentences survive?

**Why it matters**: "always" is the word the rule exists to catch. Keeping it
because the design said "keep the current answer" would make the scan lie.

**Default chosen**: The scan bans "forever", "always free", "free forever",
"never charge", and the standalone word "ever" (word-bounded so "every" passes).
"always" alone is not banned (it has ordinary uses), but the three retained
"always yours" sentences are reworded to state the mechanism: "Every doc exports
as portable .md at any time." (landing card), "and your documents export as
markdown at any time" (pricing FAQ), and the about card already becomes "Your
docs, your infrastructure: open source, markdown export, and self-hosting."
per the design.

**Rationale**: Sam's style guide rule 9 ("do not overstate") and the design's
"plain statements of limits" both point at saying what the export mechanism is
rather than promising ownership forever. The design's "keep its current answer"
is about the hosted-pricing substance (free during beta, notice before any
change), which survives.

---

## RBD-062-6 - PR-review framing: the banned list, and "approve the agent"

**Question**: The rule "no PR-review/approval framing" has no word list. The
design's own message 4 says "approve the agent", meaning the OAuth consent
click. The about page currently says "Agent output gets reviewed like a
collaborator's work".

**Why it matters**: Banning "approve" would ban the design's copy. Not banning
"review" lets the about card through.

**Default chosen**: The scan bans "pull request", the standalone token "PR"/"PRs",
"code review", "for approval", "for review", "reviewed like", and "review the
agent". "approve"/"approval" alone are allowed; the only permitted sense is
approving an agent's connection (consent), which review catches (FR-039). The
"Agent work is accountable work" card is reworded to: "Each edit is attributed
to whoever made it, human or agent, and can be undone through version history."

**Rationale**: The framing the rule targets is the idea that agent edits are
submitted and wait for a human gate. Attribution plus undo is the actual
mechanism (Constitution IV), so the card states that instead.

---

## RBD-062-7 - "Passwords and OIDC coming for teams" is omitted from the pricing table

**Question**: The design's pricing section says the self-hosted sign-in row
reads "local sign-in link, with passwords and OIDC coming for teams". The
team-mode amendment in `design/authentication-and-sharing.md` is proposed, not
ratified, and its build (061) "can follow launch".

**Why it matters**: A pricing page promising a sign-in method that has no
ratified design overstates (style guide rule 9) and could be false at launch.

**Default chosen**: The self-hosted sign-in cell reads "Sign-in link minted by
your instance" with no roadmap clause. If the amendment is ratified and 061 has
shipped before the launch gate opens, the implementer may append "or passwords
and OIDC for teams" to that cell in the same change, without reopening this
spec.

**Rationale**: Constitution VI makes the ratified design win over the proposed
one; the launch-messaging design's clause depends on the unratified companion.
Omitting a roadmap sentence costs nothing; including a false one costs trust.

---

## RBD-062-8 - Comparison table rows and marks

**Question**: The design says the table "gains a self-hosted column; the rows
that change are sign-in and AI credits". The other rows (built-in AI on Claude
models, keys encrypted at rest, single-tenant, managed by us or self-hosted)
need per-column values the design does not give.

**Why it matters**: The old rows describe the old plans; several are false for
a self-hosted column as written ("Built-in AI agent on Anthropic's Claude
models" needs a key on self-hosted).

**Default chosen**: Columns: Hosted, Self-hosted, Managed instance. Rows and
marks (check = included, marker = not included):

| Row | Hosted | Self-hosted | Managed |
| --- | --- | --- | --- |
| Real-time collaboration: people and agents edit together, conflict-free | yes | yes | yes |
| Version history: every change attributed and reversible | yes | yes | yes |
| Connect agents like Claude Code, Codex, Cursor, and Kiro over MCP | yes | yes | yes |
| Import and export markdown: your docs round-trip as portable .md | yes | yes | yes |
| Two-way sync with the markdown files in your repo | yes | yes | yes |
| Built-in assistant with your own key: Anthropic, Google (Gemini), OpenAI, z.ai (GLM), or OpenRouter | yes | yes | yes |
| Keys encrypted at rest with AES-256-GCM; remove your key at any time | yes | yes | yes |
| $10 of AI credits every month | yes | no | no |
| Sign-in | Sign in with Google | Sign-in link minted by your instance | Sign in with Google |
| Runs on your own infrastructure | no | yes | no |
| Single-tenant: your own isolated instance and database | no | yes | yes |
| Hosted in the cloud region you choose | no | no | yes |
| Run and supported by us | yes | no | yes |

**Rationale**: Each cell is true today or by ratified design: credits are
hosted-only (058 `SQUIRE_HOSTED`); the self-hosted sign-in is the claim link
(059); the managed instance runs the same code as hosted so its sign-in is
Google today; "Runs on Anthropic's Claude models" is replaced by the
bring-your-own-key row because a self-hosted instance has no built-in AI until
a key is added (design, "AI features without keys"). The managed column's
"Sign in with Google" is the honest default; if a managed customer gets OIDC
after 061, that cell changes then.

---

## RBD-062-9 - Scan coverage: which files

**Question**: Which files does the copy-rules test scan?

**Why it matters**: `security.html` receives the new footer but its body copy
is not rewritten (it still describes Google sign-in as the authentication
method, which is true of the hosted service). `LoginPage.jsx` carries the old
tagline (RBD-062-1).

**Default chosen**: The scan covers `client/public/landing.html`,
`client/public/pricing.html`, `client/public/about.html`, and the `FOOTER`
string exported by `client/scripts/site-footer.mjs`. `security.html` is checked
only for the footer tagline and nav links (FR-026, FR-029). HTML comments are
stripped before any rule runs.

**Rationale**: The rules were written for the rewritten copy. Extending them to
the security page would force an unplanned rewrite of a page the design leaves
alone; the footer string is covered at its source so every page that imports it
is covered too.

---

## RBD-062-10 - Hero and closing band: Google-branded button

**Question**: The current "Start free" buttons carry the Google glyph and sit
under "No setup. Sign in with Google." The design drops the sign-in method from
the lead. Does the button lose the glyph?

**Why it matters**: The glyph is itself a "sign in with Google" message, but
removing it is a presentation change the design does not ask for.

**Default chosen**: The copy requirements remove the sign-in-method text and add
the secondary "Run it yourself" button. Whether the primary button keeps the
Google glyph is left to the implementer; either satisfies the spec. The
recommended default is to drop the glyph so the two buttons read as a pair
("Start free" / "Run it yourself") rather than one branded and one plain.

**Rationale**: The design's intent is that the sign-in method stops being a
selling point. A glyph is weaker than a sentence, so the spec does not force
it, but the pair of plain buttons is the cleaner reading of D8.

---

## RBD-062-11 - Imagery for the first two landing sections (D7)

**Question**: The design places "the presence screenshot or a short clip of an
agent cursor editing" in section 1 and diff highlighting plus version history in
section 2. D7 says no new imagery. No file under `client/public/` is a presence
screenshot.

**Why it matters**: A section that promises a live agent cursor with no image
is weaker, but recording one is a follow-on the design defers.

**Default chosen**: Section 1 reuses `hero-screenshot.png` (its alt text already
describes a live collaborator editing with inline diffs) and the hero keeps it
too if the layout needs an image there; section 2 reuses
`screenshot-versionhistory.png`. The landing page's existing
`mobile-diagram.png` stays in the "Any agent, any model" section as today.
Alt text is rewritten to match the new section copy and the copy rules. The
agent-cursor clip is recorded as a follow-on in `promotion-notes.md`.

**Rationale**: D7 is ratified; these are the only existing images that show
the two mechanisms. Flagged because the design names an asset that does not
exist.

---

## RBD-062-12 - Managed-instance mailto subject

**Question**: The current card links to
`mailto:contact@squiredocs.com?subject=Dedicated%20instance`. The plan is
renamed.

**Default chosen**: `mailto:contact@squiredocs.com?subject=Managed%20instance`.
The "Where can a managed instance run?" FAQ links to the same address with no
subject, as the design's text does.

**Rationale**: Keeps the inbox filter working under the new name.

---

## RBD-062-13 - Section order and the "Any agent, any model" link

**Question**: The design lists the landing sections but not where the existing
`/documentation/agents-and-mcp` link lives after the reorder.

**Default chosen**: The six sections appear in the design's order (FR-006). The
"Any agent, any model" section keeps the "Agents & MCP Guide" link to
`/documentation/agents-and-mcp` and the provider list. Background shading
alternates as today.

**Rationale**: The design says "keep the current provider grid"; the link is
part of it.

---

## RBD-062-14 - Pricing hero copy

**Question**: The design rewrites the cards and FAQ but not the pricing hero
("Simple pricing while we're in beta" / "Every account includes AI credits each
month. No credit card needed.").

**Default chosen**: H1 "Use ours free, or run your own." Subline: "Squire Docs
is free during public beta on squiredocs.com, and free to self-host as open
source software. Managed instances are priced per organization. No credit card
needed."

**Rationale**: Leads with what it is (style guide rule 1), names all three
columns in one breath, and keeps the no-card statement that is still true.

---

## RBD-062-15 - Pricing and about page meta text

**Question**: The design gives the landing page's title and meta description
but not the pricing or about page's.

**Default chosen**: Pricing keeps the title "Pricing | Squire Docs"; meta
description: "Squire Docs is free during public beta on squiredocs.com, with
$10 of AI credits a month or your own API key. Self-host it free as open source
software, or ask us for a managed instance in the cloud region you choose."
`og:description`: "Free during beta, free to self-host, or a managed instance
in the cloud region you choose." About keeps the title "About | Squire Docs";
meta description: "Coding agents write plans, specs, and reports. Squire Docs
gives that work a shared, attributed document your team edits with the agent.
Open source, MIT licensed, built by 21st Harmonic." `og:description`: "Why
Squire Docs exists: a shared document for the work your agents do, with every
change attributed. Open source under the MIT license." The about hero subline
is "Squire Docs gives the work your agents do a shared document your team can
read, edit, and correct."

**Rationale**: Derived from the design's about H1 and body and the pricing
table so the meta text and the page agree. Each passes the copy rules.

---

## RBD-062-16 - Which "MIT" mentions must link to the repository

**Question**: FR-037 says every "MIT" mention that is a license statement must
link to `https://github.com/squiredocs`. A scan cannot tell a license statement
from any other use, and the about page's meta description (RBD-062-15) says
"MIT licensed" inside an attribute, where a link is impossible.

**Why it matters**: Without a mechanical reading, the link half of FR-037 is
review-only and can regress silently.

**Default chosen** (plan phase): Every case-sensitive, word-bounded "MIT" in
the page body (after `<head>` and HTML comments are removed) must sit inside an
`<a href="https://github.com/squiredocs">` element. The checker removes those
anchors' contents and then requires zero remaining body "MIT" tokens. "MIT" in
`<head>` meta text is exempt. Each of landing, pricing, and about must still
contain at least one "MIT".

**Rationale**: On these pages every body use of "MIT" is a license statement
(trust line, FAQ, the added "stay free" sentence, "Why open source"), so
"every body MIT is linked" is the literal reading and is testable.

---

## RBD-062-17 - Secondary button and install-command presentation

**Question**: The spec says reuse existing button classes, but landing and
about have no secondary button style, and no marketing page styles a code
element for the install command.

**Why it matters**: D8 needs "Run it yourself" visibly secondary, and an
unstyled `curl` line in body text is hard to read and overflows on phones.

**Default chosen** (plan phase): Copy the existing `.landing-btn.outline` rule
and its hover rule from `pricing.html`'s inline styles into
`client/public/marketing.css`, and use it for every "Run it yourself" button
(primary stays `.landing-btn.google`). Add one `.landing-install-cmd` rule
(monospace, light gray background from the existing palette, rounded corners,
`overflow-x: auto`) for a `<pre><code>` block. No copy-to-clipboard button.

**Rationale**: `.outline` has shipped on the live pricing page, so it is an
existing component. A clipboard button needs JavaScript the pages do not have
and the design does not ask for. `marketing.css` is outside the color-token lint
(`client/src/**/*.css` only).

---

## RBD-062-18 - Header nav width with two more links

**Question**: Adding "GitHub" and "Self-host" makes six text links plus two
buttons. Below 480px the existing CSS already hides all `.landing-nav-link`
elements, but between 481px and 768px the row may wrap or overflow.

**Why it matters**: A broken header on tablets undercuts the launch, and the
spec says no layout regressions beyond copy.

**Default chosen** (plan phase): The new links use `class="landing-nav-link"`
so they hide below 480px with the others. The implementer checks 481px to
768px; if the row wraps or overflows, the two new links get an extra class
(`landing-nav-link-wide`) hidden below 768px in `marketing.css`. The footer
carries both links at every width (FR-027), so nothing becomes unreachable.

**Rationale**: Smallest change that keeps the header intact without
restructuring the nav into a menu, which the design does not ask for.

---

## RBD-062-19 - About page "Open to any model or agent" card opening

**Question**: The card currently opens "A built-in agent on Anthropic's Claude
models". Keep it, or reword?

**Why it matters**: The built-in assistant needs a key, so a fresh self-hosted
instance has none, and the design drops built-in AI as a lead message.
Leading with it on the about page contradicts both.

**Default chosen** (analyze follow-up, orchestrator): Reword the card to lead
with connecting any MCP agent (Claude Code, Codex, Cursor, Kiro, Claude
Desktop) and bringing your own key from Anthropic, Google (Gemini), OpenAI,
z.ai (GLM), or OpenRouter. The hosted built-in assistant may follow as a
second sentence scoped to squiredocs.com. Provider order matches FR-017
(analyze LOW: FR-012 order aligned to it).

**Rationale**: Keeps every claim true on both hosted and self-hosted, and
matches supporting message 5 in the design.

RATIFIED-BY-DEFAULT (Sam pre-authorized, 2026-10-07)
