---
name: "squire-docs"
displayName: "Squire Docs — collaborative specs"
description: "The durable, attributed spec layer for spec-driven development — two-way sync between your .kiro/specs files and a live Squire Docs document your team edits together."
keywords: ["specs","spec-driven","kiro-specs","requirements","design","review","attribution","version-history","squire","docs"]
author: "Squire Docs"
version: "1.0.0"
---
<!-- GENERATED FILE — do not hand-edit. Source of truth: distribution/publish.mjs
     Regenerate with: node distribution/publish.mjs -->
# Squire Docs

## Overview

Squire Docs is the durable, attributed spec layer for spec-driven development. The requirements, design, and status your team works from live in a Squire Docs document where every edit — human or agent — is attributed and revertible, and teammates and other agents all see the same doc. This Power connects Kiro to that document over MCP and holds the loop that keeps your `.kiro/specs` files and the shared doc in sync, both directions.

## When to Use This Power

Reach for Squire Docs when a spec in this workspace should be reviewable in a place a teammate — a product manager, a designer, another agent — can edit; when you want the spec Kiro plans and implements against to be a living document your whole team signs off on; or when you and the user are iterating together on a requirements or design doc. Kiro's spec-driven workflow is a natural fit: the `.kiro/specs` files you already generate become a shared, attributed, two-way-synced Squire Docs document.

## Onboarding

First run in a workspace: get connected, sync the first spec, and hand back the doc URL.

1. **Connect.** The `squire-docs` MCP server uses OAuth — Kiro opens your browser to sign in on the first tool call. Signing in with Google is find-or-create: if you do not have a Squire Docs account yet, that same click creates it and connects Kiro, with no separate signup step. (See MCP Configuration below.)
2. **Find the spec.** Look for a spec-shaped artifact in this workspace, in order of precedence: `.kiro/specs/**`, then `specs/**`, then `PLAN.md` or `docs/plan.md`, then `CLAUDE.md`. Offer the best candidate and let the user confirm; if nothing spec-shaped exists, offer to draft a starter spec from the repo's README and structure.
3. **Sync it byte-faithfully.** Move the chosen file over Squire Docs' REST byte channel — never retype its content through a tool parameter, even after you have read it. Call `import_markdown_file` and run the recipe it returns: one shell command that claims a token, imports the file over REST (frontmatter preserved), and writes a sync receipt back into the file. You only set its `FILE=` line. Whole-file sync is for authoring, importing, and bulk updates like this one; for a small targeted edit later, especially to a doc someone is actively editing or a damaged node, prefer `modify`.
4. **Deliver the payoff.** Print the new doc's URL exactly as the sync receipt states it (`View it at …/d/<docGuid>`). The editor is where the human reviews and refines the spec, every edit attributed and revertible — the payoff inside the loop, not a front door the user must visit first.
5. **Teach the loop.** State the standing behavior: read the spec from the doc before each run, write status and design back after. The loop is detailed in `steering/specs-sync-workflow.md`.

## Available Steering Files

- `steering/working-with-squire-docs.md` — what a Squire Docs document is: two-way sync, attribution, revertibility, and why hosting your `.kiro/specs` there is the hero move.
- `steering/specs-sync-workflow.md` — the standing sync loop, the REST byte channel for file content, and the `sk_sqd_` token-handling rules.

## When to Load Steering Files

- When syncing a spec into Squire Docs, or setting up the workspace for the first time → load `steering/specs-sync-workflow.md`.
- When explaining what the shared document gives the team, or deciding whether to host a spec there → load `steering/working-with-squire-docs.md`.
- When moving file content or a token in or out of Squire Docs → load `steering/specs-sync-workflow.md` (the byte channel and token rules).

## Available MCP Servers

- `squire-docs` — the Squire Docs MCP server at `https://squiredocs.com/mcp`. It exposes tools to list, create, read, share, and edit documents, work with version history, and mint scoped access tokens. Agents call `get_tool_documentation` for the full scripting reference before writing their first `modify` script.

## MCP Configuration

The `mcp.json` in this Power registers the server:

```json
{
  "mcpServers": {
    "squire-docs": {
      "type": "http",
      "url": "https://squiredocs.com/mcp",
      "disabled": false,
      "autoApprove": []
    }
  }
}
```

Authentication is automatic: Squire Docs supports Dynamic Client Registration, so Kiro self-registers and runs the browser OAuth flow on first use — there are no client IDs or secrets to set by hand, which is why this config carries no `oauth` block. Reading requires the `documents:read` scope and writing requires `documents:write`; an agent only ever acts within the roles your account has granted.

## License and Support

- This Power is licensed **MIT** — you are free to fork and adapt the Power itself. The hosted Squire Docs service it connects to is a paid product, not open source.
- Privacy policy: https://squiredocs.com/privacy
- Support: hello@squiredocs.com
