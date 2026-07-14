---
slug: search
title: Search
description: Search your Squire Docs documents by content, combining full-text and semantic matching.
order: 8
---

The search box on the document list finds documents by their contents, not just their titles. This page covers how it matches and what it returns.

## How matching works

Search combines two methods and blends their results:

- **Full-text matching** finds documents that contain your search words, and highlights matching snippets.
- **Semantic matching** finds documents that are about what you searched for, even when they use different wording.

Blending the two means you can find a document by the exact words in it or by its topic. If semantic matching is not available on the server, search falls back to full-text matching on its own.

## What you can search

Search covers the title and body of each document. Results are always limited to documents you can access: search never surfaces a document you do not have a role on.

The document list search reads document contents. External agents can run the same content search through the `list_documents` tool. See [Agents and MCP](/documentation/agents-and-mcp).

## Keeping the index current

After you edit a document, its search entry updates on its own a short time later, so searches reflect recent edits without any action from you.
