---
description: Onboard me to Squire Docs — connect, find a spec in this repo, sync it, and hand back the doc URL.
---
<!-- GENERATED FILE — do not hand-edit. Source of truth: distribution/shared/onboard.md
     Regenerate with: node distribution/publish.mjs -->

# /squire:onboard

Onboard the user to Squire Docs: get them connected, sync the first spec from their repo, and leave them in the repo ⇄ spec ⇄ agent loop. This may be their genuine first run — they may have no Squire Docs account yet — so this flow owns the signup moment, not just the connect moment.

Work the five moves below in order. Move 1 (connect) branches on what you can observe; moves 2–5 run once Squire Docs tools are present.

## Move 1 — Connect check

**Detect the entry state by tool presence alone. Never make a probe call.** For a remote OAuth MCP server, Claude Code does not surface Squire Docs' tools until browser consent completes, and it does so silently — there is no `list_documents` to call and no auth error to catch. So branch on the one thing you can see: whether Squire Docs MCP tools are present in this session.

- **Squire Docs tools are present** (consent already done, or an `sk_sqd_` token is loaded) → skip the walkthrough entirely. Go straight to Move 2.
- **No Squire Docs tools are present** → the user has not connected yet. Run the auth walkthrough below.

Do not try to tell "has an account but never consented" apart from "no account at all." Signing in with Google on the connect page is find-or-create — one path covers both — and the copy says so.

**Command-availability caveat.** `/squire:onboard` ships inside the plugin, and a plugin's commands load separately from — and usually before — its MCP server connects. Two consequences, neither an error: (1) right after install the client may need a restart before this command even appears; (2) once it runs, the Squire Docs tools stay absent until consent, which is exactly the "no tools present" branch above. Tools being absent is a state to coach through, never a failure to report.

### The auth walkthrough

In Claude Code the OAuth exchange belongs to the MCP client, not to you. You cannot complete it for the user; you coach them through the client's own flow, in this order:

1. **Set expectations before anything opens.** Tell the user, before pointing them at any browser: their browser will open Squire Docs' connect page; they sign in with Google, and if they have never used Squire Docs that same click creates their account and connects you — no separate signup step, and no separate approval screen, so you can start creating and syncing docs for them. (A user who already has a Squire Docs account gets one more screen to approve the connection before the tools appear.)

2. **Point at the client's native flow.** Have them run `/mcp`, pick the `squire` server, and complete the browser consent there. The plugin's server entry is already registered — do **not** tell them to run `claude mcp add`.

3. **Remote or sandboxed sessions.** When the browser cannot round-trip to this machine, apply the connect walkthrough exactly:
   - Print the authorization URL bare on its own line — never inside list markup, quotes, or trailing punctuation — so a single click or selection copies it.
   - Before they open it, tell them what happens after they approve: the browser lands on a `localhost` callback page that may show a connection error because this session runs on a remote machine or container, and that this is expected — the approval still succeeded.
   - Tell them to copy the FULL URL from the browser's address bar (`http://localhost:…/callback?code=…`) and paste it back as their next message, and that nothing else is needed.

4. **Reconnect, then continue silently.** After consent — and any restart the client needs to load the now-authorized server — the Squire Docs tools appear. Re-check their presence and flow directly into Move 2. Success needs no ceremony: the next thing the user sees is their spec syncing, not a congratulations.

### Failure ladder

When the walkthrough does not land, coach the matching rung — and **never improvise or invent an auth path.** Every fallback here is standard OAuth or an `sk_sqd_` token; agents route around bespoke flows, so there are no others.

- **The user declines consent** → explain what the access was for (creating and syncing docs on their behalf) and offer to retry via `/mcp` when they are ready.
- **They approved, but the localhost callback errored** → that is expected on a remote session; have them paste the full callback URL back, exactly as in walkthrough step 3.
- **They signed in but closed the tab before approving** → the consent URL is re-openable; offer to retry via `/mcp`.
- **No browser is reachable at all** (headless box, no port forward) → last resort: have them create the account from any browser on any device at squiredocs.com, mint an `sk_sqd_` token in Settings → AI Agent Access, and save it to `~/.squire/token` per the token-handling rules (a `0600` file; never pasted into the conversation). Token auth is fully authenticated — once the tools are present, proceed identically to any connected session.

## Move 2 — Find the spec

With Squire Docs tools present, look for a spec-shaped artifact in the current repo, in this order of precedence:

1. `.kiro/specs/**`
2. `specs/**`
3. `PLAN.md` or `docs/plan.md`
4. `CLAUDE.md`

Offer the best candidate you find and let the user confirm or point you at a different file — do not silently sync the first hit when several exist. If nothing spec-shaped exists, offer to draft a starter spec from the repo's README and structure, and sync that once the user is happy with it.

## Move 3 — Sync it byte-faithfully

Sync the chosen file over the byte channel — never retype its content through a tool parameter, even though you may have read it. Call `import_markdown_file` and run the recipe it returns: a single shell command that claims a token, imports the file over REST, and writes a sync receipt back into the file's frontmatter (you only set its `FILE=` line). The doc is born sync-ready, and the receipt is what lets later runs update this same doc instead of creating a duplicate.

## Move 4 — Deliver the payoff

Print the new doc's URL — the sync receipt states it (`View it at …/d/<docGuid>`); relay that link exactly, never construct a URL of another form. Say what the editor adds: this is where the human reviews and refines the spec, with every edit — human or agent — attributed and revertible. The editor is the payoff inside the loop, not a front door the user has to visit first. What they got for one command is a durable, shared, attributed home for the spec that was sitting untracked in their repo a minute ago.

## Move 5 — Teach the loop

Close by stating the standing behavior now that the skill is installed: you read the spec from the doc before each run and write status and design back after — and teammates and other agents see those attributed edits in the same doc. That is the loop; the doc stays current because the loop keeps it current.

## Re-running onboard

If `/squire:onboard` runs again in a repo whose spec is already synced, prefer updating the existing doc over creating a new one. The sync receipt written into the file's frontmatter identifies the doc — sync into it rather than importing a fresh copy. Create a new doc only when there is no receipt and no existing doc, or when the user explicitly asks for one.
