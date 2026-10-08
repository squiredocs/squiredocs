---
slug: squire-docs-vs-google-docs-notion-proof
title: Squire Docs vs. Google Docs vs. Notion vs. Proof
description: A direct comparison of four ways people and AI edit the same document, and the one question that separates them: does the document live in your repository?
date: 2026-07-12
author: Sam Goldstein
---

Four tools now let a person and an AI edit the same document: Google Docs, Notion, Proof, and Squire Docs. They look similar from a distance. The differences that matter show up on two questions: how precisely can an agent edit the document, and does that document live in your repository. This post compares the four, including where each one is the better choice.

## Where each tool comes from

The four tools were built for different jobs, and that origin explains most of what they do well.

**Google Docs** is the standard for people writing together. It was built for human collaboration years before agents could write.

**Notion** is a workspace and database. Documents are one part of a larger system of pages, tasks, and structured data.

**Proof** is a new editor from Every, built on the assumption that agents do most of the writing and humans collaborate around them. It is open source and agent-first.

**Squire Docs** is built for spec-driven development. The document syncs both directions with a markdown file in your repository that your team and your coding agents edit together.

## The comparison

| | Squire Docs | Google Docs | Notion | Proof |
|---|---|---|---|---|
| Two-way sync to repo markdown | Yes | No | No | No |
| Agent edits inside the document | Agent-first, node-level | Prompt-based, coarse | Via MCP, page-level | Agent-first, precise |
| Real-time human editing | Yes | Best in class | Yes | Yes |
| Open source and self-hostable | Yes, MIT | No | No | Yes |
| Human vs. agent attribution | Per edit, human or agent | Version history, built for humans | Page-level, last edited by | Character-level provenance |
| Connect any MCP coding agent | Yes, MCP and REST | No | Yes, official MCP | Via its own HTTP bridge |

The top two rows carry most of the weight: whether the document syncs to your repository, and how precisely an agent can edit it. The rest follows from those.

## Google Docs

Google Docs is the best tool for people writing together. If your document is written and reviewed entirely by humans, it is hard to beat.

Its gap is agents. The AI help is prompt-based: you ask for a change and it rewrites a span of text. A third-party coding agent cannot open a Google Doc and make a one-line change the way it edits a source file. Attribution is built around human editors and version history, not around telling agent edits apart from yours. And a Google Doc is not a file in your repository. You can export markdown, but it is a one-way, lossy copy, not a sync.

## Notion

Notion added an official MCP server, so a coding agent can now read and edit Notion pages, including markdown edits. If your team already runs on Notion, that is real and useful.

The real limits are granularity and location. Notion's hosted MCP edits at the page level: to change part of a page it loads the whole page, modifies it, and writes it back. That is coarser than changing one node and leaving the rest untouched. Attribution is page-level, last edited by, not a fine record of which agent changed which sentence. And like Google Docs, a Notion page is not a markdown file in your repository. It lives in the Notion workspace.

## Proof

Proof is the closest tool to Squire Docs in spirit, and it deserves credit. It is agent-first, it tracks provenance down to the character with a colored gutter for human and AI authorship, it offers track-changes suggestions you accept or reject, and it is open source under a permissive license. It is built for the same documents we care about: bug reports, product requirements, implementation plans, and memos. If you want a free, open-source, agent-first editor to draft in, Proof is a strong choice.

The difference is the repository. Proof is a standalone editor: you write in it and share a link. It does not sync the document to a markdown file in your codebase, and agents connect through its own HTTP bridge. Proof makes the document a great place for agents to write. Squire Docs makes the document the same file your agents already build from.

## Squire Docs

Squire Docs is built for spec-driven development, where the document that drives the work belongs in the repository. Two-way markdown sync keeps a Squire Docs document and a file in your repo as the same content: edit either side and the other follows, so your spec is both the file your coding agent implements against and a document your product manager can open in a browser. Agents edit it surgically over the Model Context Protocol or a REST API, changing the specific node they mean to change the way they edit a line of code, and every edit is attributed to a person or an agent.

Its main trade-off is focus. Like Proof, Squire Docs is open source under the MIT license, and you can run it yourself for free with one command ([self-hosting guide](/documentation/self-hosting)). It is opinionated about the repository: two-way sync is the whole point, so if your documents do not belong in a codebase, most of what sets it apart does not apply, and one of the other three is the better fit.

## Which one to pick

This is not a case where one tool wins every row.

- Writing and reviewing with people, no agents in the loop: **Google Docs**.
- Your knowledge base already lives in Notion and you want agents to reach it: **Notion** with its MCP.
- You want a free, open-source, agent-first editor to draft in: **Proof**.
- Your specs live in your repository and need to stay editable by both your team and your coding agents: **Squire Docs**.

The question that sorts them is the one we started with. If the document that drives your software should live in the repository and still be editable by the people and the agents who shape it, that is the job Squire Docs is built for.
