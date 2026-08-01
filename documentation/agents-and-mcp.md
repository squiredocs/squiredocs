---
slug: agents-and-mcp
title: Agents and MCP
description: Connect external AI agents to Squire Docs over the Model Context Protocol, authenticate with OAuth or API tokens, and see how agent edits are attributed.
order: 9
---

External AI agents, such as Claude Code, Cursor, Kiro, and Claude Desktop, can connect to Squire Docs over the Model Context Protocol (MCP) and edit your documents alongside you. This page covers connecting, authenticating, what an agent can do, and how its edits are attributed.

## Connecting

The MCP endpoint is:

```
https://squiredocs.com/mcp
```

### Claude Code: install the plugin (recommended)

The quickest path for Claude Code is the Squire Docs plugin. Inside Claude Code, add the marketplace and install it:

```
/plugin marketplace add squiredocs/squire-plugin
/plugin install squire
```

This registers the MCP server where Claude Code reads it at startup (no `claude mcp add` step) and adds the `/squire:onboard` command, which walks you from connecting through syncing your first spec, along with a skill that teaches the agent the Squire Docs spec loop and how to handle tokens safely. Claude Code loads plugins at startup, so after installing you may need to restart it before `/squire:onboard` appears. OAuth sign-in still happens in your browser on the first tool call, and signing in with Google creates your Squire Docs account if you do not have one yet.

### Claude Code and other Claude command-line clients: raw one-liner

If you would rather not use the plugin, add the server directly. Run this in a terminal, not from inside a running agent session:

```
claude mcp add --transport http squire https://squiredocs.com/mcp && claude mcp login squire
```

This registers the server and completes the sign-in right from the terminal. An MCP client loads its server configuration at startup, so if you add the server from inside a running session, that session will not see it. To pick an in-progress agent conversation back up afterward, exit it first and append `&& claude --continue` to the command above; it resumes the conversation with the server connected.

### Cursor: Add to Cursor

If you use Cursor, the quickest path is the Add to Cursor deeplink, which registers the Squire Docs MCP server in Cursor:

[Add to Cursor](cursor://anysphere.cursor-deeplink/mcp/install?name=squire-docs&config=eyJ1cmwiOiJodHRwczovL3NxdWlyZWRvY3MuY29tL21jcCJ9)

That connects the MCP server; Cursor runs the browser OAuth sign-in on the first tool call, and signing in with Google creates your Squire Docs account if you do not have one yet. The full Squire Docs plugin (the spec-loop rule and the skill alongside the MCP server) is published at [github.com/squiredocs/squire-cursor-plugin](https://github.com/squiredocs/squire-cursor-plugin) and arrives through the Cursor marketplace once it is listed.

### Kiro: import the Power

For [Kiro](https://kiro.dev), AWS's spec-driven agentic IDE, install the Squire Docs Power from its repository: [github.com/squiredocs/squire-kiro-power](https://github.com/squiredocs/squire-kiro-power). In Kiro, open the Powers panel, choose **Add Custom Power**, then **Import power from GitHub**, paste the repo URL, and install. The Power registers the MCP server and adds Kiro-native steering that hosts the `.kiro/specs` files you already generate as a shared, attributed, two-way-synced Squire Docs document.

You can also add Squire Docs to Kiro by hand, without the Power: add it to the `mcpServers` block of your MCP config, `.kiro/settings/mcp.json` in a workspace, or `~/.kiro/settings/mcp.json` to make it available in every project:

```json
{
  "mcpServers": {
    "squire": {
      "url": "https://squiredocs.com/mcp"
    }
  }
}
```

Kiro hot-reloads the file when you save it and walks you through the OAuth sign-in in your browser on first use, with no client IDs or secrets to set by hand. Squire Docs pairs naturally with Kiro's spec-driven workflow: keep the spec Kiro plans and implements against as a living Squire Docs document your team edits together, and every change Kiro makes is attributed and reversible alongside everyone else's.

For any MCP-native client, point it at the endpoint above. The client's built-in OAuth discovery handles the rest through the standard chain, so you do not need to configure client IDs, secrets, or extra URLs by hand.

The agent-facing instructions live at [/agents.md](/agents.md), which agents can read directly.

## Authentication

There are two ways for an agent to authenticate:

- **OAuth 2.0**: the standard interactive path. The MCP client walks you through authorizing from your signed-in account.
- **API tokens**: personal access tokens, prefixed `sk_sqd_` (older `sqd_` tokens remain valid), created from the Settings page under AI Agent Access. Pass a token as a bearer credential in the `Authorization` header. Tokens work for both MCP and the REST API.

A token's name is what your collaborators see: it labels the agent's live cursor and is recorded as the author in version history, so name tokens after the agent that will use them. Access is scoped. Reading requires the `documents:read` scope and writing requires `documents:write`. An agent connected over MCP that has no token can mint a temporary one for itself with the `create_access_token` tool, scoped no higher than its own grant and expiring within 24 hours; the mint returns a one-time claim recipe rather than exposing the raw token to the model.

Everything is revocable from Settings under AI Agent Access: you can revoke any token or disconnect any authorized agent, and revoking also revokes whatever that token or connection minted.

## What an agent can do

An agent works through a set of tools: it can list, create, read, and share documents, edit them, work with version history, and search. Editing is done with the `modify` tool, which runs a TypeScript script against the document. Agents call `get_tool_documentation` for the full scripting reference before writing their first script. Beyond editing, an agent can import a markdown file byte-for-byte with `import_markdown_file`, undo and redo its own edits with the `undo` and `redo` tools, and list, compare, name, and restore versions with the version-history tools.

An agent only ever acts within the roles you have granted. It can reach a document only if your account can, and its writes require the editor role, the same as a person's.

## How agent edits are attributed

An agent is a collaborator, not a hidden write path. While an agent works on a document, it appears as a live cursor named "AgentName (UserName)". The agent name comes from the token's name, or from the client's own name when it connected over OAuth. Its edits flow through the same path as human edits, each edit is attributed to the agent by name, and it shows up in version history alongside everyone else's. There is no separate, unattributed way for an agent to change a document.

This includes imports: when an agent imports or syncs markdown over the REST API, anyone watching the document sees the agent arrive in presence, sees a brief highlight over what changed, and sees it leave. Repository sync pushes announce themselves under the fixed name "Repo Sync".

## Moving markdown over the REST API

With an `sk_sqd_` token you can export a document as markdown over plain HTTP, with no MCP client. Keep the token in a file, never on the command line, where it would leak into shell history:

```
curl -H "Authorization: Bearer $(cat ~/.squire/token)" \
  "https://squiredocs.com/api/docs/<docId>/export?format=markdown" -o doc.md
```

The full REST reference, covering import and sync as well as export, is available to agents via `get_tool_documentation({ tool: "rest_api" })`. For import and two-way sync from a human's point of view, see [Markdown](/documentation/markdown).
