---
slug: squire-docs-as-your-kiro-spec
title: Using a Squire Docs document as your Kiro spec
description: A short tutorial for keeping your Kiro spec as a living Squire Docs document, so your PM can edit it and your agent can read it, with two-way markdown sync to the repo.
date: 2026-06-28
author: Sam Goldstein
---

Kiro is an agentic IDE that builds features from a spec. Instead of prompting an agent freely, you write a specification first, and Kiro works through it. By default that spec lives as static markdown files in your repository, under a `.kiro/specs/<feature>/` folder: `requirements.md`, `design.md`, and `tasks.md`.

This tutorial shows how to keep the requirements as a living Squire Docs document instead of a static file. The document stays editable by your whole team, syncs to the repository as markdown, and gives Kiro the same file it expects. You get the spec-driven workflow Kiro is built for, without the spec being a file only engineers can touch.

## Why put the spec in Squire Docs

The Kiro spec files are plain markdown in the repo. That is good for the agent and good for version control. It is not good for the people who should shape the requirements but do not work in a code editor.

Keeping the requirements in Squire Docs fixes that without giving up the file. A Squire Docs document syncs both ways to a markdown file in your repository. Your product manager edits the document in a browser, their changes are attributed, and the markdown Kiro reads stays current.

## Step 1: Create the spec document

Create a new document in Squire Docs for your feature and name it for the feature, for example "Bulk export requirements."

Write the requirements the way Kiro expects them. Kiro uses user stories with acceptance criteria in EARS form, the Easy Approach to Requirements Syntax, where each criterion reads as "When [condition], the system shall [behavior]." A requirement looks like this:

> **User story:** As an account owner, I want to export all my documents at once, so that I can keep an offline backup.
>
> **Acceptance criteria:**
> - When the owner requests an export, the system shall produce a single archive of every document they own.
> - When an export is in progress, the system shall show its status until it completes.

Keep one document per feature, matching one `.kiro/specs/<feature>/` folder.

If the requirements already exist as a file — Kiro scaffolds a `requirements.md`, or you drafted one in the repo — don't retype it into the editor. Squire Docs imports markdown over a single HTTP call, so an existing file goes straight up into a new, shareable document. And you don't have to make that call yourself: ask Kiro.

> "Import `.kiro/specs/bulk-export/requirements.md` into Squire Docs and give me the share link."

Kiro has your API token, uploads the file, and hands back a document you can share.

## Step 2: Share it with your team for input

Share the document with the people who should shape the requirements: your PM, a designer, whoever owns the outcome. They can read, comment, and edit directly in the browser. You do not have to translate their feedback out of a comment thread and back into the spec by hand, because they are editing the spec.

Because every edit is attributed, you can see which requirements came from whom when you review.

## Step 3: Keep the document and the repo in sync

The Squire Docs document and `.kiro/specs/bulk-export/requirements.md` are two views of the same content. Keeping them together is a job you hand to Kiro, not one you do by hand. Set it up once by creating an API token under **Settings → API Tokens** and giving it to Kiro; after that the sync is just prompts:

- **Pull the team's edits down:** "Sync the requirements doc down before you start." Kiro reads the current document and updates `.kiro/specs/bulk-export/requirements.md`, so it builds against what your team last agreed on.
- **Push your own edits up:** "Push my requirements changes up to Squire Docs." Kiro sends the file up as attributed changes that merge with whatever your team edited in the browser, instead of overwriting it.

Under the hood that is a GET to read the document and a PUT to push edits back, against a token scoped to your documents — but you never have to think about it. Kiro lives in the repo, so keeping the file and the document in sync is a one-line request.

## Step 4: Let Kiro take it from requirements to design and tasks

Point Kiro at the feature and let it work. It reads `requirements.md` and generates the design and the task list, then implements against them.

When Kiro or a review turns up a requirement that needs to change, change it in the Squire Docs document and ask Kiro to sync it down before the next run. The team sees the update in the document, the repository copy follows, and the requirements stay in one place instead of drifting between a file and a doc.

## The result

Your Kiro spec is now a document your whole team can edit, not a file only the engineers can reach. The requirements stay in one place, synced to the repository, readable by your agent and open to the people who should own them. That is the same idea Kiro is built on, spec first, extended so the spec belongs to everyone who has a stake in it.
