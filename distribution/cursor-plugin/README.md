<!-- GENERATED FILE — do not hand-edit. Source of truth: distribution/publish.mjs
     Regenerate with: node distribution/publish.mjs -->
# Squire Docs — Cursor plugin

Squire Docs is the durable, attributed spec layer for spec-driven development. This plugin connects Cursor to your team's Squire Docs documents over MCP, and adds a spec-loop rule and a skill that keep your repo's spec files and the shared doc in sync, both directions.

## What installing this does

- **Registers the Squire Docs MCP server** (`mcp.json`) at `https://squiredocs.com/mcp`, so Cursor's agent can list, read, create, share, and edit your documents and work with version history.
- **Adds the `squire-spec-loop` rule** (`rules/squire-spec-loop.mdc`) — an Agent-Requested rule that reminds the agent to sync before a run, read the spec from the doc, and write status back after.
- **Adds the `squire` skill** (`skills/squire/SKILL.md`) — the full working-with-Squire-Docs guidance: the standing loop, the REST byte channel for file content, and the `sk_sqd_` token-handling rules.

## First use: signing in

The server uses OAuth. On the first tool call Cursor opens your browser to sign in — Squire Docs supports Dynamic Client Registration, so there are no client IDs or secrets to set by hand. Signing in with Google is find-or-create: if you do not have a Squire Docs account yet, that same click creates it and connects Cursor, with no separate signup step. Reading requires the `documents:read` scope and writing requires `documents:write`; the agent only ever acts within the roles your account has granted.

## Where the ground truth lives

This bundle is generated from the Squire Docs source repository — do not hand-edit it or open pull requests against this mirror. Fixes land upstream and are regenerated here. The plugin itself is MIT-licensed; the hosted Squire Docs service it connects to is a paid product.
