---
slug: account-and-support
title: Account and support
description: Manage settings, API tokens, and your own AI provider keys in Squire Docs, and get support.
order: 12
---

This page covers the Settings page, API tokens, your own AI provider keys, and how to get help.

## Settings

The Settings page is where you manage your account and everything related to AI access:

- **Account**: your email and an editable display name.
- **AI Usage**: a meter showing your monthly credit usage, any extra credits, and the date your allowance resets.
- **AI provider keys and model**: your own provider keys and the model picker that goes with them (see below).
- **AI Agent Access**: the agents you have authorized, your API tokens, and the MCP endpoint URL with a copy button.

## API tokens

API tokens let a script or an external agent act as you without going through interactive sign-in. Create one on the Settings page under AI Agent Access. Tokens are prefixed `sk_sqd_` (older tokens with the `sqd_` prefix remain valid). Pass a token as a bearer credential in the `Authorization` header; keep the value in a file rather than typing it into commands, since command-line arguments leak into shell history.

**A token's name is its public identity.** While an agent works with your token, collaborators see the token's name on its live cursor, and version history records it as the author. So name a token after the agent that will use it ("Claude Code", "CI Bot") rather than after a task.

Tokens work for both the Model Context Protocol and the REST API, and their access is scoped: reading requires the `documents:read` scope and writing requires `documents:write`. Tokens you create in Settings carry both scopes. A token is stored as a hash, so you see its value once when you create it.

Your token list can also contain short-lived tokens you didn't create: a connected agent can mint a temporary token for itself (expiring within 24 hours), and these appear in the list with their expiry. Revoking is thorough: revoking a token also revokes any tokens it minted, and revoking an agent's access under AI Agent Access revokes everything minted through that connection. See [Agents and MCP](/documentation/agents-and-mcp) and [Markdown](/documentation/markdown) for what tokens can do.

## Your own AI provider keys

By default the AI assistant runs on shared credits with a monthly allowance. You can instead supply your own API key for Anthropic, Gemini, OpenAI, z.ai, or OpenRouter on the Settings page. This is called bring your own key.

Three steps switch it on: add a key, turn on the "Use my key" toggle, and pick a model from the Model dropdown; models become selectable once their provider's key is stored. Requests then run on your key, which lets you use models beyond the shared ones and does not draw down your monthly credits. If the toggle is on but the key or model isn't usable, chat stops with a clear error rather than silently falling back to shared credits. A key is checked against its provider before it is saved, is stored encrypted, and is never shown back to you. See [AI assistant](/documentation/ai-assistant) for how credits work.

## Getting support

Open the user profile menu and click Get Support. This opens the support page at `/support`, where you describe your issue and review your earlier requests. Your request is saved and emailed to the team, with your address set as the reply-to, so a reply reaches you directly.

You can also email [contact@squiredocs.com](mailto:contact@squiredocs.com). For security issues, email [security@squiredocs.com](mailto:security@squiredocs.com); see the [security page](/security) for details.
