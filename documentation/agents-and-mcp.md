---
slug: agents-and-mcp
title: Agents and MCP
description: Connect external AI agents to Squire Docs over the Model Context Protocol, authenticate with OAuth or API tokens, and see how agent edits are attributed.
order: 9
---

External AI agents, such as Claude Code, Codex, and Claude Desktop, can connect to Squire Docs over the Model Context Protocol (MCP) and edit your documents alongside you. This page covers connecting, authenticating, what an agent can do, and how its edits are attributed.

## Connecting

The MCP endpoint is:

```
https://squiredocs.com/mcp
```

For Claude Code and other Claude command-line clients, run this in a terminal, not from inside a running agent session:

```
claude mcp add --transport http squire https://squiredocs.com/mcp
```

An MCP client loads its server configuration at startup. If you add the server from inside a running session, that session will not see it. Add it in a separate terminal, then start a new session.

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
