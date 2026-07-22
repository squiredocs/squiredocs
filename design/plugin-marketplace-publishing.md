<!-- source: https://squiredocs.com/d/b4b1673b-6847-4154-a099-3b5077ad4e2f
     synced-by: design/sync.mjs — DO NOT HAND-EDIT; amend the Squire doc and re-sync -->

# Squire Docs Plugin Packaging & Marketplace Publishing

Status: Design ratified 2026-07-21 — ready for the pipeline. This doc turns the "Packaging & distribution: publish a Claude Code plugin" and "One server, many storefronts" sections of the [2026-07-21 activation strategy doc](https://squiredocs.com/d/a6e1809e-fcc8-4b26-b45f-970b3ea4f06a) into a buildable design: the artifact set, its source-of-truth layout in the repo, the public mirror repos, the `/squire:onboard` first-run flow, per-channel manifests, the publish process, and the split between pipeline-buildable code and operations only Sam can perform.

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
- **`.mcp.json`** — the remote server entry. A plugin install writes the config where the client reads it at startup, which removes the `claude mcp add` failure mode (config landing in a file the client never reads). The client still loads the plugin at startup, so a restart after install may be needed — see the onboarding command-availability caveat. OAuth consent still happens in the browser on the first tool call.
- **`skills/squire/SKILL.md`** — generated from `shared/skill.md`.
- **`commands/onboard.md`** — generated from `shared/onboard.md`, invoked as `/squire:onboard`.
- **Own marketplace, day one, no review:** `.claude-plugin/marketplace.json` in the same public repo; users run `/plugin marketplace add <org>/squire-plugin` then `/plugin install squire`. This one-liner goes on the site, the docs, and agents.md.
- **Community directory, submitted same week:** the JSON-schema validation runs as a publish.mjs preflight; submission via the Console form (free individual account, no Team plan) is a Sam op. Approved plugins are pinned to a commit SHA in `anthropics/claude-plugins-community`, their CI bumps the pin on push, and the public catalog (claude.com/plugins) syncs nightly.
- The `plugin-dev` plugin in the official directory ships scaffolding and validators — start from those rather than hand-rolling.
- **Official Claude directory** (`claude-plugins-official`) is earned, not applied for — curated at Anthropic’s discretion, with community-directory traction the realistic route. Out of scope to build; noted as a downstream outcome, and if listed it unlocks in-product install prompts.

### First-run onboarding: the /squire:onboard flow

This is the design answer to the strategy doc's open question "what does an agent-first first-run look like end to end" — where first-run means genuinely first: the flagship user has **no Squire account** when the command runs. The flow therefore owns the signup moment, not just the connect moment.

**Entry states — detect by tool presence, not a probe call.** For a remote OAuth MCP server, Claude Code does not surface the server's tools until browser consent completes, and it does so silently — there is no `list_documents` to call and no auth error to catch (anthropics/claude-code #11585, #26917). So the command branches on what the agent _can_ observe: whether Squire Docs MCP tools are present in the session at all.

- **Squire tools present** (consent already done, or an `sk_sqd_` token loaded) → skip straight to "Find the spec."
- **No Squire tools present** → the user hasn't connected or authorized yet; run the auth walkthrough below. The agent never has to tell "has an account but never consented" apart from "no account at all" — Google sign-in on the consent page is find-or-create, so one path covers both; the copy just says so.

**Command-availability caveat (M5).** `/squire:onboard` ships _inside_ the plugin, and a plugin's commands load separately from — and usually before — its MCP server connects. Two consequences: (1) right after install the client may need a restart before the command itself appears — the install one-liner and its docs say so; (2) even once the command runs, the MCP tools stay absent until consent, which is exactly the "no Squire tools present" branch above, not an error to catch. "No `claude mcp add`" is the win the plugin delivers; "no restart at all" was overstated.

**The auth walkthrough — the client owns the flow; the agent coaches.** In Claude Code the OAuth exchange belongs to the MCP client, not the agent. Seeing no Squire tools, the agent coaches, in order:

1. **Set expectations before anything opens:** "Your browser will open Squire Docs' connect page. Sign in with Google — if you've never used Squire Docs, that same click creates your account; there is no separate signup step. Then approve the connection so I can create and sync docs for you."
2. **Point at the client's native flow:** run `/mcp`, pick `squire`, complete the browser consent. The plugin's `.mcp.json` is already registered — no `claude mcp add`.
3. **Remote/sandboxed sessions:** apply the Agent Surface doc's OAuth walkthrough guidance verbatim — authorization URL bare on its own line, the expected localhost-callback error, the copy-the-full-callback-URL paste-back instruction.
4. **Reconnect, then re-check tool presence and continue silently.** After consent (and any restart the client needs to load the now-authorized server), the Squire tools appear; flow directly into "Find the spec" — success needs no ceremony, the next thing the user sees is their spec syncing.

**What happens server-side today (verified against code 2026-07-21) and what this design changes:**

- **Verified working already:** an account-less user completes the whole chain today — `/authorize` shows "Sign in with Google" carrying a validated same-origin `returnTo`, the login page forwards it, Google sign-in is `findOrCreateUser` (the account is created mid-flow), and the round-trip lands back on consent carrying the OAuth parameters (subject to the length budget below). No brand-new auth machinery is needed — the 008/009 lesson stands.
- **Change — the consent page becomes a first-run surface.** Its unauthenticated state currently reads "Sign in required — please sign in to authorize this application": existing-account framing, zero product pitch. New framing: "Continue with Google" (sign-in and account creation are the same click, and the copy says so), plus one line each for what Squire Docs is (the durable, attributed spec layer for agentic development), what the agent is asking to do, and that every agent edit is attributed and revertible. For the beachhead ICP this page IS the first impression of the product.
- **Change — agent-first accounts deliberately skip the browser welcome doc.** Verified: the consent `returnTo` branch returns before welcome-doc seeding, so accounts born through consent get no welcome doc — today by accident. This design keeps that behavior and makes it load-bearing: the first synced spec IS the welcome; a seeded browser welcome doc would be a competing terminal artifact of exactly the kind the strategy doc indicts. Verify at implement time that no client surface misbehaves for accounts with a null welcome doc.
- **Change — record signup provenance.** Stamp accounts created during a consent round-trip (D5: `signup_source` = `agent_oauth` vs `browser`) so activation metrics can finally separate agent-first users from browser one-shots — the instrumentation the strategy doc's `onboarded_at` critique calls for. Redefining `onboarded_at` itself stays with the strategy doc; this design only guarantees the data exists from day one.
- **Change — the Agent Surface doc's OAuth walkthrough guidance gains the signup line** ("signing in with Google creates the account if none exists") when this ships — that doc owns the front-door contract, so the amendment lands there, not as drift.
- **Change — verify the returnTo length budget (M4).** The same-origin `returnTo` guard caps the value at 512 chars (`server/auth/routes.js`). A real Claude Code authorize URL carries the PKCE `code_challenge`, `state`, `redirect_uri`, and client id, and may exceed it — in which case the cookie is silently dropped and the post-login round-trip loses its OAuth params, so the agent never receives its code. Measure a real authorize URL at implement time; if it is near the cap, raise the limit (still same-origin-validated) or carry the OAuth params server-side rather than in `returnTo`.

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

#### Amendment (2026-07-22, ratified by Sam): collapse first-run to a single consent screen

Sam’s first production onboarding walk surfaced that a genuine first-run user passes through **three** Squire screens before the agent connects (evidence: [3-screen capture](https://squiredocs.com/d/7228531b-6ebe-43fa-9e94-08c6b863d876)): (1) the “Connect to Squire Docs” first-run surface, (2) the generic /login “Welcome Back” page (a second Google button, with returning-user copy shown to a brand-new user), and (3) the OAuth ConsentCard (“Authorize Claude Code… Approve/Deny”). For the beachhead flow this is two redundant steps. This amendment collapses true first-run to ONE Squire screen (plus Google’s own sign-in, which is not ours to remove).

The single screen is the existing “Connect to Squire Docs” first-run surface — which already names the agent, states what it will do, and the attribution/revocability promise, so it already IS an informed-consent surface. Two changes remove the other screens:

- **Kill screen 2.** The first-run “Continue with Google” links to /login today; point it straight at the Google OAuth entry (`/auth/google?returnTo=…`, the path login() already uses). No /login hop, and the misapplied “Welcome Back / Don’t have an account?” copy disappears for first-run.
- **Fold screen 3 into screen 1.** When the Google leg returns and the account was created in THIS authorize round-trip, `completePostAuth` mints the authorization code inline and redirects to the agent’s callback — no ConsentCard. Naturally scoped to just-created accounts because it keys off `user.isNew`.
- **Enrich screen 1 copy.** Since it becomes the only consent surface, spell out the grant it now stands in for: read + create/edit/delete of documents, and the “revoke anytime in Settings → AI Agent Access” line currently only on the card. Honest, barely longer.

**Security floor (load-bearing — this is consent-bypass territory).** The inline auto-issue fires ONLY when both hold: the account is `user.isNew` (created seconds ago in this very flow, so it holds zero documents — the ConsentCard protects nothing), AND the return carries the OAuth parameters of THIS authorize request (client_id, redirect_uri, PKCE code_challenge, state), validated and matched. Never for a pre-authenticated or pre-existing account — else a phishing authorize-URL could mint a token against a victim’s real documents the instant they signed in. PKCE and redirect_uri validation are unchanged (reuse handleAuthorize’s validation); the delegation is still recorded, attributed, and revocable exactly as an explicit approve.

- **Existing accounts keep the explicit ConsentCard.** They have data to protect and no created-in-this-flow safety, so a returning user connecting a new agent still sees screen 1 → consent. Net: first-run = 1 screen; returning-user reconnect = 2. The security value lives exactly where the screen is kept.
- **Provenance unchanged.** signup_source=agent_oauth is still stamped at creation; the welcome-doc skip is unchanged.
- **Scope.** Converges as feature 031-first-run-consent-collapse. Amends the ratified M2/030 consent-page design here and the OAuth consent contract in the Authentication & Sharing doc; the auto-issue path gets an adversarial security review pass. A fast-follow — does not reopen M2 sign-off.
- **Redirect-breadth tightening — RATIFIED by Sam 2026-07-22.** The post-merge adversarial review escalated the flagged redirect breadth to a real remote login-CSRF token-theft vector: an attacker could link a first-run victim to an /authorize URL carrying an attacker-controlled HTTPS redirect, and the victim’s account-creating sign-in would auto-issue a code delivered server-side to the attacker. Fix (applied): the auto-issue path is now LOCALHOST-ONLY — a non-localhost redirect_uri fails closed to the explicit consent card (where a human eyeballs the URL). This lands the code on the victim’s own machine, collapsing the remote blast radius to near-zero, and breaks no legitimate first-run client (Claude Code and terminal agents use a localhost loopback). The explicit-consent path’s redirect rules stay unchanged.

### 3. Kiro Powers — wave 2

A Power: MCP config + `POWER.md` steering in a public repo with an "Add to Kiro" button on our site. Steering content is generated from `shared/` but reframed Kiro-native — hosting the `.kiro/specs` files these users already generate, made collaborative with attribution and history, is the hero move. Kiro users are pre-qualified spec-driven ICP. The Powers registry submission (kiro.dev/powers/submit) and the featured-partner track are Sam ops.

### 4. Cursor Marketplace — wave 2

Plugin bundle (MCP + skills + rules) per the cursor.com/marketplace/publish template and docs. Verified-listing review; exact requirements live behind the publish portal and get confirmed before the wave-2 build (open question below).

### 5. Gemini CLI extension — wave 3

`gemini-extension.json` + skill content in a public repo carrying the `gemini-cli-extension` topic; the gallery crawler lists it automatically. No review, no cost.

### 6. OpenAI Codex — wave 3

`.codex-plugin/plugin.json` + skills + `.mcp.json` as a git-hosted marketplace now (plus the community codex-marketplace.com meanwhile); submit to the official directory when its self-serve opening ("coming soon") actually opens.

### 7. MCP aggregators — wave 3, one afternoon, ops-only

Smithery CLI publish, PulseMCP form (it also auto-ingests the registry weekly), Glama `glama.json`, mcp.so submit button. No new artifacts beyond the registry entry — batch these in a single sitting. The Docker MCP Catalog is a separate curated submission (not just a registry mirror) — it joins this batch.

## Website and docs surface

- **agents.md** — the Claude Code path leads with the plugin install one-liner as the recommended route; the raw `claude mcp add` one-liner stays for every other MCP client. This amends the agents.md contract, which the Agent Surface doc owns — the amendment lands there when this ships, never as silent drift.
- **/documentation/agents-and-mcp** — gains a per-ecosystem install section mirroring the same one-liners.
- **Landing page** — a "works with your coding agent" block with the install one-liners, in the honest-confident voice.

## Publish and release process

- **Versioning:** semver in `plugin.json` and mirrored manifests; bump on any change to shared content or manifests.
- **`node distribution/publish.mjs`**: regenerate bundles from `shared/`, validate each bundle against the manifest JSON schemas (the authoritative gate) and run the plugin-dev validator agent where available — there is no first-party `claude plugin validate` CLI verb to depend on — then commit-and-push each mirror repo with a generated message referencing the source commit.
- **Updates propagate** via each ecosystem's own git-pull mechanism; the community directory's CI bumps its SHA pin on push.
- **Channel status ledger:** the table at the bottom of this doc tracks each channel from Not started through Listed — update it as submissions land; this doc is the ground truth for distribution state.

## Repeatable first-run testing

The first-run flow has to be cheap to run dozens of times while the coaching is tuned — without burning real Google or Claude accounts. Two verified facts make that possible:

- **A "new Squire user" is just a missing users row.** Account creation is `findOrCreateUser` at sign-in, so hard-deleting a user row (docs, delegations, tokens cascading with it) makes the next sign-in a genuine first-run — same Google identity, brand-new account. One real Google account yields unlimited prod-shaped first-runs; the only thing not re-exercised is Google's own first-consent screen, which is outside our control anyway.
- **The client's auth state lives in its config dir, not the Claude account.** Claude Code with a scratch `CLAUDE_CONFIG_DIR` is a client that has never seen the plugin or the server: no cached MCP OAuth tokens, no marketplace, no plugin. Zero additional Claude accounts needed. Caveat (M6): this holds on Linux, where credentials live under the config dir; on macOS Claude Code stores OAuth credentials in the system Keychain, which a scratch config dir does not clear — so fully-pristine rehearsals run in the Linux dev pod (or add a Keychain-purge step on a Mac).

Three test tiers, cheapest first:

1. **Backend integration tests** (no human, in the suite): the consent returnTo round-trip with account creation, `signup_source` stamping, the deliberate welcome-doc skip, and the null-welcome-doc client contract.
2. **Headless OAuth-chain driver** (no human, scripted): walks the real chain against the dev server — 401 → protected-resource metadata → AS metadata → dynamic client registration → PKCE authorize → consent → token — with both browser legs (sign-in _and_ consent-approval) driven by the dev endpoints below. Proves the machinery end to end on every change without a browser.
3. **Unattended in-pod rehearsal** (no human — the tuning loop): a harness creates a scratch `CLAUDE_CONFIG_DIR`, adds `distribution/claude-plugin` as a local-path marketplace (no publishing), installs the plugin with its MCP endpoint pointed at the dev server (M3 indirection below), mints a fresh synthetic user, and drives Claude Code non-interactively (`claude -p`, or a scripted user-simulator on an interactive session). A synthetic user has no real browser, so the harness completes consent through the dev **auto-approve** endpoint (option A) — which lets the _entire_ flow run unattended: connect coaching, find-spec, byte-channel sync, payoff, teach-loop. Each transcript is graded against the coaching contract as a checklist (signup-creates-account line before the browser step, bare URL on its own line, silent reconnect, byte-channel sync, doc URL delivered, loop taught). Running in the pod is a feature: the localhost callback naturally fails, exercising the remote paste-back branch by default.

**Human self-test path (Sam, in production).** The synthetic harness tunes the flow; a human walking the real thing in prod is the acceptance gate before any publish. The self-test uses `selftest@example.com` — one of Sam's Google accounts, deliberately empty — as a disposable first-run identity. One command resets _only that account_ to first-run (the production single-account reset below), then Sam runs `/squire:onboard` in a real Claude Code on his laptop, signs in as that account through a real browser against production, and walks the flow as a genuine new user. This exercises the two things no synthetic path can: Google's real consent screen and a real browser round-trip against prod, macOS Keychain and all. He re-runs it as often as he likes — each reset makes the next sign-in first-run again. This is the human half of M2's exit.

**Dev-server support to build — gating is fail-closed, positive-flag only.** All of these live behind an explicit positive `ENABLE_DEV_ENDPOINTS` flag, never a `NODE_ENV !== 'production'` negative. (The 2026-07-21 lesson: `NODE_ENV` is unset in prod, so negative-gated dev routes were reachable in production.) These endpoints are session-forgery and mass-delete primitives — they default OFF and exist only in the dev/staging overlay. The one exception is the production single-account reset below: deliberately prod-enabled, but neutered by a hardcoded single-email allowlist so its blast radius is one dataless account, not the fleet.

- **Fresh-user faucet.** Extend `POST /auth/dev-login`: `fresh: true` mints `test+<nonce>@test.local` instead of the fixed dev user, plus a browser mode that sets session cookies and honors a validated `returnTo` — standing in for Google on the consent page's sign-in leg. Composing this with the React consent path (`AuthorizePage` → `/login` → `AuthContext.devLogin`, which today posts no body) needs a small client change to forward `fresh`/nonce and hit the browser-mode endpoint — that client change is scoped into M1, not assumed.
- **Consent auto-approve (option A).** A dev-only endpoint that, for a synthetic session, completes the `/authorize` **Approve** step and mints the agent's authorization code without a browser click — the piece that lets tier-3 rehearsals finish OAuth in-pod. Same positive flag; synthetic-session-only.
- **User reset.** Hard-deletes a user row and everything hanging off it (docs, delegations, registered clients, tokens) so the identity is first-run again. Two scopes: (1) _synthetic wipe_ — dev/staging only, behind `ENABLE_DEV_ENDPOINTS`, targeting the `test+<nonce>@test.local` users the faucet minted; never in prod. (2) _production single-account reset_ — the human self-test’s one prod-enabled capability: an endpoint whose target allowlist is a hardcoded compile-time constant of exactly one address, `selftest@example.com` (a dataless throwaway), still behind admin auth. It can reset that one account and nothing else — no free-form user id, no wildcard, no config-driven list. Even reachable in prod its worst case is resetting one empty account, which is why a single hardcoded email — not a pattern — is the guard. And since reset is a hard-delete, a mis-target is recoverable, not permanent: a user can be restored from a database backup (a heavy, last-resort point-in-time restore, not a routine undo) — so the failure floor is recovery, not irreversible loss.
- The existing `dev-onboarding-reset` stays for the browser-first welcome flow; it is not sufficient here because first-run means no account at all.

**MCP endpoint indirection (M3).** The shipped `.mcp.json` hardcodes `https://squiredocs.com/mcp` and the drift test asserts each bundle matches `shared/`. So the endpoint URL becomes an env-indirected field the harness overrides for dev, and that single field is exempt from the drift assertion. Verify at implement time that Claude Code's `.mcp.json` supports env interpolation; if it does not, the harness templates a throwaway copy rather than mutating the shipped bundle.

**The sign-off test matrix:** fresh user (happy path) · existing account, never consented · already connected (straight to sync) · declined consent · abandoned tab · remote paste-back · headless token fallback · repo containing `.kiro/specs` / `specs/` / `CLAUDE.md` / nothing spec-shaped.

## Build milestones

Milestone-gated per Sam (2026-07-21); each exits with HITL sign-off before the next starts:

1. **M1 — Test mechanism.** The faucet, the wipe, the headless chain driver, the rehearsal harness and its transcript checklist. Exit: one command produces a pristine first-run environment in a couple of minutes, demonstrated end to end; HITL remains only where a browser inherently is.
2. **M2 — Plugin logic.** `shared/skill.md`, `shared/onboard.md`, and the first-run coaching, iterated against the M1 harness. Exit: clean rehearsal transcripts across the full test matrix, with Sam's sign-off on both mechanics and tone.** — DONE + SIGNED OFF (Sam, 2026-07-22): built as specs/030-plugin-logic; the prod first-run walk spawned the ratified first-run consent collapse (specs/031-first-run-consent-collapse), also merged + security-reviewed. Deploy of 030+031 to prod is a Sam op, owed before any publish.**
3. **M3 — Packaging and distro wrappers.** Manifests, mirror repos, `publish.mjs` + drift tests, wave-1 submissions per D3. Exit: JSON-schema validation green (plugin-dev validator agent clean), mirrors pushed, submission checklist handed to Sam.** — IN PROGRESS (2026-07-22): wave-1 build specced as specs/032-packaging-distribution (distribution/ tree, real claude-plugin bundle, mcp-registry server.json, publish.mjs + drift tests, website/agents.md install one-liners). Waves 2/3 are follow-on features. Publishing/pushing/submissions remain Sam ops, gated on the 030+031 prod deploy.**

The channel waves (D3) live inside M3. Nothing is published before M2's sign-off — the marketplaces' first impression should be the tuned flow, not the draft.

## Pipeline-buildable vs Sam-only ops

**The pipeline builds:** the entire `distribution/` tree, the shared skill/onboard content, `publish.mjs` plus the drift tests, the consent-page first-run state and signup-provenance stamping (app changes in this repo), and the agents.md / documentation / landing-page updates — everything up to "ready to submit."

**Sam-only ops (external identity and accounts):**

- Create the public GitHub org and mirror repos (D1) and grant push access._ [org created 2026-07-21; repos + access owed]_
- DNS challenge for `mcp-publisher` domain verification; run the first registry publish._ [Sam, 2026-07-21: will grant temporary Route 53 access so the orchestrator can set the TXT record when M3 reaches this step — the challenge itself need not be hands-on]_
- Console form submission for the community directory; Kiro / Cursor / aggregator account submissions.

## Decisions for Sam

- **D1 — Public GitHub org name.** Default: `squiredocs`. The app repo lives under personal accounts; public plugin repos should live under a product-named org.** DONE (Sam, 2026-07-21): **the `squiredocs` org exists on GitHub (verified via API; empty). Mirror repos + push access still owed at M3.
- **D2 — Plugin naming.** Default: manifest name `squire` (command ergonomics: `/squire:onboard`), display name and all listing copy "Squire Docs" per the product-name standard. Short manifest names are namespacing, not user-facing copy.
- **D3 — Wave 1 scope.** Default: MCP Registry publish + own Claude marketplace + community-directory submission in the first build; Kiro + Cursor as wave 2; Gemini, Codex, and the aggregators as wave 3.
- **D4 — Mirror strategy.** Default: one public repo per ecosystem, generated pushes only. Rejected: a single public monorepo (Gemini's crawler and Kiro's Add-to button expect manifests at repo root; per-repo keeps each storefront's contract clean). Rejected: authoring directly in the public repos (splits ground truth and moves the pipeline outside its own repo).
- **D5 — Signup provenance.** Default: a `signup_source` column on users (`browser` default; `agent_oauth` when the account is created during a consent returnTo round-trip), stamped at account creation. Cheap to record now, impossible to backfill later.
- **D6 — Production testing + single-account reset.** Ratified by Sam (2026-07-21): the human self-test runs against production using `selftest@example.com` (an empty throwaway Google account). The only prod-enabled reset targets that one hardcoded address; the synthetic faucet, consent auto-approve, and synthetic wipe stay dev/staging-only. Real prod Google + browser onboarding is the true acceptance test; a single hardcoded email keeps the reset safe even in prod, and DB backups make any mis-target recoverable.

## Open questions

- Cursor verified-listing requirements (docs live behind the publish portal) — confirm before the wave-2 build.
- Confirm the community directory accepts plugins whose MCP server requires account signup on first use (expected yes — remote OAuth servers are the standard pattern — verify at submission).
- Codex official directory timing — watch, submit when self-serve opens.
- Marketplace naming: names impersonating Anthropic are blocked; `squire`/`squiredocs` are safe, but confirm any additional naming constraints at submission time.

## Channel status

| Channel | Wave | Status |
| --- | --- | --- |
| Official MCP Registry | 1 | Mirror repo LIVE (squiredocs/squire-mcp-registry, v1.0.1 + LICENSE). Domain-verification **DNS challenge DONE + verified live 2026-07-22** (apex TXT v=MCPv1 ed25519, SPF preserved). Remaining: mcp-publisher CLI login + publish server.json to registry.modelcontextprotocol.io (Sam go; private key at distribution/.mcp-publisher-key). |
| Claude Code plugin (own marketplace) | 1 | **LIVE 2026-07-22** — squiredocs/squire-plugin published (own marketplace). Install: /plugin marketplace add squiredocs/squire-plugin then /plugin install squire. v1.0.0. |
| Claude community directory | 1 | Not started |
| Kiro Powers | 2 | Not started |
| Cursor Marketplace | 2 | Not started |
| Gemini CLI extensions | 3 | Not started |
| OpenAI Codex | 3 | Not started |
| MCP aggregators (Smithery, PulseMCP, Glama, mcp.so, Docker MCP Catalog) | 3 | Not started |