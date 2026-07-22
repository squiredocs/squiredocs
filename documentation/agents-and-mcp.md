---
slug: agents-and-mcp
title: Agents and MCP
description: Connect external AI agents to Squire Docs over the Model Context Protocol, authenticate with OAuth or API tokens, and see how agent edits are attributed.
order: 9
---

External AI agents, such as Claude Code, Kiro, Codex, and Claude Desktop, can connect to Squire Docs over the Model Context Protocol (MCP) and edit your documents alongside you. This page covers connecting, authenticating, what an agent can do, and how its edits are attributed.

## Connecting

The MCP endpoint is:

```
https://squiredocs.com/mcp
```

### Claude Code — install the plugin (recommended)

The quickest path for Claude Code is the Squire Docs plugin. In a terminal, not from inside a running agent session, add the marketplace and install it:

```
/plugin marketplace add squiredocs/squire-plugin
/plugin install squire
```

This registers the MCP server where Claude Code reads it at startup — no `claude mcp add` step — and adds the `/squire:onboard` command, which walks you from connecting through syncing your first spec. Claude Code loads plugins at startup, so after installing you may need to restart it before `/squire:onboard` appears. OAuth sign-in still happens in your browser on the first tool call, and signing in with Google creates your Squire Docs account if you do not have one yet.

### Claude Code and other Claude command-line clients — raw one-liner

If you would rather not use the plugin, add the server directly. Run this in a terminal, not from inside a running agent session:

```
claude mcp add --transport http squire https://squiredocs.com/mcp && claude mcp login squire
```

This registers the server and completes the sign-in right from the terminal. An MCP client loads its server configuration at startup, so if you add the server from inside a running session, that session will not see it. To pick an in-progress agent conversation back up afterward, exit it first and append `&& claude --continue` to the command above — it resumes the conversation with the server connected.

For [Kiro](https://kiro.dev), AWS's spec-driven agentic IDE, add Squire to the `mcpServers` block of your MCP config — `.kiro/settings/mcp.json` in a workspace, or `~/.kiro/settings/mcp.json` to make it available in every project:

```json
{
  "mcpServers": {
    "squire": {
      "url": "https://squiredocs.com/mcp"
    }
  }
}
```

Kiro hot-reloads the file when you save it and walks you through the OAuth sign-in in your browser on first use — no client IDs or secrets to set by hand. Squire pairs naturally with Kiro's spec-driven workflow: keep the spec Kiro plans and implements against as a living Squire document your team edits together, and every change Kiro makes is attributed and reversible alongside everyone else's.

For any MCP-native client, point it at the endpoint above. The client's built-in OAuth discovery handles the rest through the standard chain, so you do not need to configure client IDs, secrets, or extra URLs by hand.

The agent-facing instructions live at [/agents.md](/agents.md), which agents can read directly.

## Authentication

There are two ways for an agent to authenticate:

- **OAuth 2.0**: the standard interactive path. The MCP client walks you through authorizing from your signed-in account.
- **API tokens**: personal access tokens, prefixed `sk_sqd_`, created from the Settings page under AI Agent Access. Pass a token as a bearer credential (`Authorization: Bearer sk_sqd_...`). Tokens work for both MCP and the REST API.

Access is scoped. Reading requires the `documents:read` scope and writing requires `documents:write`. An agent connected over MCP that has no token can mint a temporary one for itself, scoped no higher than its own grant and expiring within 24 hours.

## What an agent can do

An agent works through a set of tools: it can list, create, read, and share documents, edit them, work with version history, and search. Editing is done with the `modify` tool, which runs a TypeScript script against the document. Agents call `get_tool_documentation` for the full scripting reference before writing their first script.

An agent only ever acts within the roles you have granted. It can reach a document only if your account can, and its writes require the editor role, the same as a person's.

## How agent edits are attributed

An agent is a collaborator, not a hidden write path. While an agent works on a document, it appears as a live cursor named "AgentName (UserName)". Its edits flow through the same path as human edits, each edit is attributed to the agent by name, and it shows up in version history alongside everyone else's. There is no separate, unattributed way for an agent to change a document.

## Moving markdown over the REST API

With an `sk_sqd_` token you can export a document as markdown over plain HTTP, with no MCP client:

```
curl -H "Authorization: Bearer sk_sqd_..." \
  "https://squiredocs.com/api/docs/<docId>/export?format=markdown" -o doc.md
```

For import and two-way repository sync, see [Markdown](/documentation/markdown).
