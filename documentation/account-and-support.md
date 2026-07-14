---
slug: account-and-support
title: Account and support
description: Manage settings, API tokens, and your own AI provider keys in Squire Docs, and get support.
order: 12
---

This page covers the Settings page, API tokens, your own AI provider keys, and how to get help.

## Settings

The Settings page is where you manage the AI agents you have authorized, your API tokens, and your own AI provider keys.

## API tokens

API tokens let a script or an external agent act as you without going through interactive sign-in. Create one on the Settings page under AI Agent Access. Tokens are prefixed `sk_sqd_`. Pass a token as a bearer credential (`Authorization: Bearer sk_sqd_...`).

Tokens work for both the Model Context Protocol and the REST API, and their access is scoped: reading requires the `documents:read` scope and writing requires `documents:write`. A token is stored as a hash, so you see its value once when you create it. See [Agents and MCP](/documentation/agents-and-mcp) and [Markdown](/documentation/markdown) for what tokens can do.

## Your own AI provider keys

By default the AI assistant runs on shared credits with a monthly allowance. You can instead supply your own API key for Anthropic, Google, OpenAI, z.ai, or OpenRouter on the Settings page. This is called bring your own key.

When you add your own key, the assistant uses it, which lets you use models beyond the shared ones and does not draw down your monthly credits. A key is checked against its provider before it is saved, is stored encrypted, and is never shown back to you. See [AI assistant](/documentation/ai-assistant) for how credits work.

## Getting support

Open the user profile menu and click Get Support. This opens the support page at `/support`, where you describe your issue and review your earlier requests. Your request is saved and emailed to the team, with your address set as the reply-to, so a reply reaches you directly.

You can also email [contact@squiredocs.com](mailto:contact@squiredocs.com).
