<!-- source: https://squiredocs.com/d/b4b1673b-6847-4154-a099-3b5077ad4e2f
     synced-by: design/sync.mjs — DO NOT HAND-EDIT; amend the Squire doc and re-sync -->

# Proposal: Plugin Packaging & Marketplace Publishing

**Status: Draft for review.** This doc turns the "Packaging & distribution: publish a Claude Code plugin" and "One server, many storefronts" sections of the [2026-07-21 activation strategy doc](https://squiredocs.com/d/a6e1809e-fcc8-4b26-b45f-970b3ea4f06a) into a buildable design: the artifact set, its source-of-truth layout in the repo, the public mirror repos, the `/squire:onboard` first-run flow, per-channel manifests, the publish process, and the split between pipeline-buildable code and operations only Sam can perform.

**Out of scope** (per the strategy doc): reordering the browser signup funnel (a separate feature), the deferred GitHub App, the ChatGPT app directory, and the Claude Connectors Directory (requires a Team/Enterprise org — revisit when one is justified).

## Design principles

1. **One server, many storefronts.** There is exactly one backend surface: the existing remote MCP server at `https://squiredocs.com/mcp` with OAuth discovery. No channel gets a bespoke server, stdio wrapper, or hosted proxy. What varies per channel is a thin manifest plus shared skill/steering content.
2. **Ground truth lives in this repo; public repos are build artifacts.** Every publishable file is authored under `distribution/` here. Public mirror repos receive generated pushes from a publish script and are never hand-edited — the same discipline as `design/` exports.
3. **Install is the activation event.** Every channel's install path ends with the agent connected (first tool call triggers browser OAuth signup/login — the account exists _because_ the agent connected) and, via the onboard flow, a first spec synced from the user's repo.
4. **The plugin restates the agents.md contract; it never forks it.** The [Squire Agent Surface (MCP)](https://squiredocs.com/d/697456a2-b42b-49b3-ae57-875d3e328809) doc owns the front-door contract — channel rule, token-file handling, OAuth walkthrough guidance. Skill and steering content must agree with it; drift between plugin content and agents.md is a bug, same as agents.md drifting from the implemented surface.

## The shared artifact set

Every channel ships some subset of four things (~90% shared across channels):

- **MCP connection config** pointing at `https://squiredocs.com/mcp` (streamable HTTP). Already exists; zero server work in this design.
- **Skill/steering content** teaching the agent _when_ to reach for Squire in real work: sync the spec from the repo before a run, read the spec at run start, write status/design back after implementing, use the byte channel for file sync, keep tokens in `~/.squire/token` and out of the transcript.
- **An onboarding flow** (`/squire:onboard` as a Claude Code command; folded into steering prose on channels without commands) that performs the first move and lands the user in the repo ⇄ spec ⇄ agent loop.
- **A per-channel manifest** in the ecosystem's native format — the only genuinely per-channel file.

## Repo layout

```
distribution/
  shared/
    skill.md            # canonical "when to use Squire" skill body
    onboard.md          # canonical /squire:onboard flow body
  claude-plugin/        # mirror -> github.com/<org>/squire-plugin
    .claude-plugin/
      plugin.json
      marketplace.json  # own marketplace: /plugin marketplace add <org>/squire-plugin
    .mcp.json
    skills/squire/SKILL.md    # generated from shared/skill.md
    commands/onboard.md       # generated from shared/onboard.md
  mcp-registry/
    server.json         # com.squiredocs/mcp for registry.modelcontextprotocol.io
  kiro-power/           # mirror -> github.com/<org>/squire-kiro-power
  cursor-plugin/        # per cursor.com/marketplace/publish template
  gemini-extension/     # mirror -> repo tagged gemini-cli-extension
  codex-plugin/         # mirror -> git marketplace repo
  publish.mjs           # regenerates bundles from shared/, validates, pushes mirrors
```

Generated files carry a do-not-hand-edit header pointing at `shared/`. Because plugins cannot reference files outside their own directory (they are copied to a cache on install), shared content is physically copied into each bundle by `publish.mjs`; a repo test asserts every bundle matches `shared/` so drift fails CI rather than shipping.

## Channel designs

### 1. Official MCP Registry — wave 1, do first

A `server.json` under the reverse-DNS name `com.squiredocs/mcp` describing the remote server (streamable HTTP endpoint, OAuth). Published with the `mcp-publisher` CLI; identity is proven by GitHub/domain ownership (DNS challenge for the domain namespace) — a one-time Sam op. Subregistries (Smithery, PulseMCP, Glama, Docker Hub, GitHub, Anthropic) mirror the registry, so this single publish is the free baseline coverage everything else builds on.

### 2. Claude Code plugin — wave 1, flagship

- **`plugin.json`** — manifest name `squire` (so commands namespace as `/squire:...`), display name and description say "Squire Docs" in the honest-confident marketing voice, semver version.
- **`.mcp.json`** — the remote server entry. A plugin install places the config where the client reads it at next startup, which retires the in-session connect caveat for this path: no hand-run `claude mcp add`, no config-file-the-client-never-reads failure mode. OAuth consent still happens in the browser on the first tool call.
- **`skills/squire/SKILL.md`** — generated from `shared/skill.md`.
- **`commands/onboard.md`** — generated from `shared/onboard.md`, invoked as `/squire:onboard`.
- **Own marketplace, day one, no review:** `.claude-plugin/marketplace.json` in the same public repo; users run `/plugin marketplace add <org>/squire-plugin` then `/plugin install squire`. This one-liner goes on the site, the docs, and agents.md.
- **Community directory, submitted same week:** `claude plugin validate` runs as a publish.mjs preflight; submission via the Console form (free individual account, no Team plan) is a Sam op. Approved plugins are pinned to a commit SHA in `anthropics/claude-plugins-community`, their CI bumps the pin on push, and the public catalog (claude.com/plugins) syncs nightly.
- The `plugin-dev` plugin in the official directory ships scaffolding and validators — start from those rather than hand-rolling.

### First-run onboarding: the /squire:onboard flow

This is the design answer to the strategy doc's open question "what does an agent-first first-run look like end to end" — where first-run means genuinely first: the flagship user has **no Squire account** when the command runs. The flow therefore owns the signup moment, not just the connect moment.

**Entry states.** The command begins with a cheap probe (`list_documents` limit 1) and branches on the only two states it can observe:

- **Authenticated** (OAuth consent done, or an `sk_sqd_` token in place) → skip straight to "Find the spec."
- **Not authenticated** → run the auth walkthrough below. The agent cannot distinguish "has an account but never consented" from "no account at all" — and never needs to: Google sign-in on the consent page is find-or-create, so one script covers both. The copy just has to say so.

**The auth walkthrough — the client owns the flow; the agent's job is coaching.** In Claude Code the OAuth exchange belongs to the MCP client, not the agent. The probe fails with an auth-required error, and the agent then coaches, in this order:

1. **Set expectations before anything opens:** "Your browser will open Squire Docs' connect page. Sign in with Google — if you've never used Squire Docs, that same click creates your account; there is no separate signup step. Then approve the connection so I can create and sync docs for you."
2. **Point at the client's native flow:** run `/mcp`, pick `squire`, complete the browser flow. The plugin's `.mcp.json` is already registered, so there is no `claude mcp add` and no restart choreography.
3. **Remote/sandboxed sessions:** apply the Agent Surface doc's OAuth walkthrough guidance verbatim — authorization URL bare on its own line, the expected localhost-callback error, the copy-the-full-callback-URL paste-back instruction.
4. **Re-probe and continue silently.** When the user says it's done, retry the probe and flow directly into "Find the spec" — success needs no ceremony; the next thing the user sees should be their spec syncing.

**What happens server-side today (verified against code 2026-07-21) and what this design changes:**

- **Verified working already:** an account-less user completes the whole chain today — `/authorize` shows "Sign in with Google" carrying a validated same-origin `returnTo`, the login page forwards it, Google sign-in is `findOrCreateUser` (the account is created mid-flow), and the round-trip lands back on consent with all OAuth parameters intact. No new auth machinery is needed — the 008/009 lesson stands.
- **Change — the consent page becomes a first-run surface.** Its unauthenticated state currently reads "Sign in required — please sign in to authorize this application": existing-account framing, zero product pitch. New framing: "Continue with Google" (sign-in and account creation are the same click, and the copy says so), plus one line each for what Squire Docs is (the durable, attributed spec layer for agentic development), what the agent is asking to do, and that every agent edit is attributed and revertible. For the beachhead ICP this page IS the first impression of the product.
- **Change — agent-first accounts deliberately skip the browser welcome doc.** Verified: the consent `returnTo` branch returns before welcome-doc seeding, so accounts born through consent get no welcome doc — today by accident. This design keeps that behavior and makes it load-bearing: the first synced spec IS the welcome; a seeded browser welcome doc would be a competing terminal artifact of exactly the kind the strategy doc indicts. Verify at implement time that no client surface misbehaves for accounts with a null welcome doc.
- **Change — record signup provenance.** Stamp accounts created during a consent round-trip (D5: `signup_source` = `agent_oauth` vs `browser`) so activation metrics can finally separate agent-first users from browser one-shots — the instrumentation the strategy doc's `onboarded_at` critique calls for. Redefining `onboarded_at` itself stays with the strategy doc; this design only guarantees the data exists from day one.
- **Change — the Agent Surface doc's OAuth walkthrough guidance gains the signup line** ("signing in with Google creates the account if none exists") when this ships — that doc owns the front-door contract, so the amendment lands there, not as drift.

**Failure ladder** — coach, never improvise auth (the 008/009 lesson: agents route around bespoke flows, so every fallback is standard OAuth or an `sk_sqd_` token):

- **User declines consent** → explain what the access was for; offer to retry via `/mcp`.
- **Approved, but the localhost callback errored** (remote session) → expected; paste-back per the walkthrough guidance.
- **Signed in but never approved / closed the tab** → the consent URL is re-openable; retry via `/mcp`.
- **No browser reachable at all** (headless box, no port forward) → last resort: create the account from any browser on any device at squiredocs.com, mint an `sk_sqd_` token in Settings → AI Agent Access, save it to `~/.squire/token` per the token-handling rules. The command treats token auth as fully authenticated and proceeds identically.

**The five moves** (the walkthrough above is move one):

1. **Connect check** — entry states + auth walkthrough above.
2. **Find the spec.** Look for spec-shaped artifacts in the current repo, in order: `.kiro/specs/**`, `specs/**`, `PLAN.md` / `docs/plan.md`, `CLAUDE.md`. Offer the best candidate; if none, offer to draft a starter spec from the README and repo structure.
3. **Sync it byte-faithfully.** `import_markdown_file` (frontmatter=true), run the returned recipe so the doc is born sync-ready with a receipt written back; the channel rule binds here like everywhere else — never retype file content.
4. **Deliver the payoff.** Print the new doc URL and say what the editor adds: the human reviews and refines there, with every edit attributed human-vs-agent and revertible. The editor is the payoff inside the loop, not the front door.
5. **Teach the loop.** Close with the standing behavior now that the skill is installed: the agent reads the spec before each run and writes status/design back after — and teammates and other agents see attributed edits in the same doc.

### 3. Kiro Powers — wave 2

A Power: MCP config + `POWER.md` steering in a public repo with an "Add to Kiro" button on our site. Steering content is generated from `shared/` but reframed Kiro-native — hosting the `.kiro/specs` files these users already generate, made collaborative with attribution and history, is the hero move. Kiro users are pre-qualified spec-driven ICP. The featured-partner track is a Sam op.

### 4. Cursor Marketplace — wave 2

Plugin bundle (MCP + skills + rules) per the cursor.com/marketplace/publish template and docs. Verified-listing review; exact requirements live behind the publish portal and get confirmed before the wave-2 build (open question below).

### 5. Gemini CLI extension — wave 3

`gemini-extension.json` + skill content in a public repo carrying the `gemini-cli-extension` topic; the gallery crawler lists it automatically. No review, no cost.

### 6. OpenAI Codex — wave 3

`.codex-plugin/plugin.json` + skills + `.mcp.json` as a git-hosted marketplace now (plus the community codex-marketplace.com meanwhile); submit to the official directory when its self-serve opening ("coming soon") actually opens.

### 7. MCP aggregators — wave 3, one afternoon, ops-only

Smithery CLI publish, PulseMCP form (it also auto-ingests the registry weekly), Glama `glama.json`, mcp.so submit button. No new artifacts beyond the registry entry — batch these in a single sitting.

## Website and docs surface

- **agents.md** — the Claude Code path leads with the plugin install one-liner as the recommended route; the raw `claude mcp add` one-liner stays for every other MCP client. This amends the agents.md contract, which the Agent Surface doc owns — the amendment lands there when this ships, never as silent drift.
- **/documentation/agents-and-mcp** — gains a per-ecosystem install section mirroring the same one-liners.
- **Landing page** — a "works with your coding agent" block with the install one-liners, in the honest-confident voice.

## Publish and release process

- **Versioning:** semver in `plugin.json` and mirrored manifests; bump on any change to shared content or manifests.
- **`node distribution/publish.mjs`****:** regenerate bundles from `shared/`, run validations (`claude plugin validate` where the CLI is available; JSON-shape checks always), then commit-and-push each mirror repo with a generated message referencing the source commit.
- **Updates propagate** via each ecosystem's own git-pull mechanism; the community directory's CI bumps its SHA pin on push.
- **Channel status ledger:** the table at the bottom of this doc tracks each channel from Not started through Listed — update it as submissions land; this doc is the ground truth for distribution state.

## Pipeline-buildable vs Sam-only ops

**The pipeline builds:** the entire `distribution/` tree, the shared skill/onboard content, `publish.mjs` plus the drift tests, the consent-page first-run state and signup-provenance stamping (app changes in this repo), and the agents.md / documentation / landing-page updates — everything up to "ready to submit."

**Sam-only ops (external identity and accounts):**

- Create the public GitHub org and mirror repos (D1) and grant push access.
- DNS challenge for `mcp-publisher` domain verification; run the first registry publish.
- Console form submission for the community directory; Kiro / Cursor / aggregator account submissions.

## Decisions for Sam

- **D1 — Public GitHub org name.** Default: `squiredocs`. The app repo lives under personal accounts; public plugin repos should live under a product-named org.
- **D2 — Plugin naming.** Default: manifest name `squire` (command ergonomics: `/squire:onboard`), display name and all listing copy "Squire Docs" per the product-name standard. Short manifest names are namespacing, not user-facing copy.
- **D3 — Wave 1 scope.** Default: MCP Registry publish + own Claude marketplace + community-directory submission in the first build; Kiro + Cursor as wave 2; Gemini, Codex, and the aggregators as wave 3.
- **D4 — Mirror strategy.** Default: one public repo per ecosystem, generated pushes only. Rejected: a single public monorepo (Gemini's crawler and Kiro's Add-to button expect manifests at repo root; per-repo keeps each storefront's contract clean). Rejected: authoring directly in the public repos (splits ground truth and moves the pipeline outside its own repo).
- **D5 — Signup provenance.** Default: a `signup_source` column on users (`browser` default; `agent_oauth` when the account is created during a consent returnTo round-trip), stamped at account creation. Cheap to record now, impossible to backfill later.

## Open questions

- Cursor verified-listing requirements (docs live behind the publish portal) — confirm before the wave-2 build.
- Confirm the community directory accepts plugins whose MCP server requires account signup on first use (expected yes — remote OAuth servers are the standard pattern — verify at submission).
- Codex official directory timing — watch, submit when self-serve opens.
- Marketplace naming: names impersonating Anthropic are blocked; `squire`/`squiredocs` are safe, but confirm any additional naming constraints at submission time.

## Channel status

| Channel | Wave | Status |
| --- | --- | --- |
| Official MCP Registry | 1 | Not started |
| Claude Code plugin (own marketplace) | 1 | Not started |
| Claude community directory | 1 | Not started |
| Kiro Powers | 2 | Not started |
| Cursor Marketplace | 2 | Not started |
| Gemini CLI extensions | 3 | Not started |
| OpenAI Codex | 3 | Not started |
| MCP aggregators (Smithery, PulseMCP, Glama, mcp.so) | 3 | Not started |