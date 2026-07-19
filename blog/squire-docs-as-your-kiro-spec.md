---
slug: squire-docs-as-your-kiro-spec
title: Using a Squire doc as your Kiro spec
description: A short tutorial for keeping your Kiro spec as a living Squire document, so your PM can edit it and your agent can read it, with two-way markdown sync to the repo.
date: 2026-07-17
author: Sam Goldstein
---

Kiro is an agentic IDE that builds features from a spec. Instead of prompting an agent freely, you write a specification first, and Kiro works through it. By default that spec lives as static markdown files in your repository, under a `.kiro/specs/<feature>/` folder: `requirements.md`, `design.md`, and `tasks.md`.

This tutorial shows how to keep the requirements as a living Squire document instead of a static file. The document stays editable by your whole team, syncs to the repository as markdown, and gives Kiro the same file it expects. You get the spec-driven workflow Kiro is built for, without the spec being a file only engineers can touch.

## Why put the spec in Squire

The Kiro spec files are plain markdown in the repo. That is good for the agent and good for version control. It is not good for the people who should shape the requirements but do not work in a code editor.

Keeping the requirements in Squire fixes that without giving up the file. A Squire document syncs both ways to a markdown file in your repository. Your product manager edits the document in a browser, their changes are attributed, and the markdown Kiro reads stays current.

## Step 1: Create the spec document

Create a new document in Squire for your feature and name it for the feature, for example "Bulk export requirements."

Write the requirements the way Kiro expects them. Kiro uses user stories with acceptance criteria in EARS form, the Easy Approach to Requirements Syntax, where each criterion reads as "When [condition], the system shall [behavior]." A requirement looks like this:

> **User story:** As an account owner, I want to export all my documents at once, so that I can keep an offline backup.
>
> **Acceptance criteria:**
> - When the owner requests an export, the system shall produce a single archive of every document they own.
> - When an export is in progress, the system shall show its status until it completes.

Keep one document per feature, matching one `.kiro/specs/<feature>/` folder.

## Step 2: Share it with your team for input

Share the document with the people who should shape the requirements: your PM, a designer, whoever owns the outcome. They can read, comment, and edit directly in the browser. You do not have to translate their feedback out of a comment thread and back into the spec by hand, because they are editing the spec.

Because every edit is attributed, you can see which requirements came from whom when you review.

## Step 3: Sync the document to your repo

Export the document to the path Kiro reads. Squire syncs documents to markdown over a simple HTTP call with an API token, so you can write the current version straight to `.kiro/specs/bulk-export/requirements.md`.

Do this whenever the requirements change. The markdown file and the Squire document hold the same content, so Kiro always sees what your team last agreed on.

## Step 4: Let Kiro take it from requirements to design and tasks

Point Kiro at the feature and let it work. It reads `requirements.md` and generates the design and the task list, then implements against them.

When Kiro or a review turns up a requirement that needs to change, change it back in the Squire document, re-sync, and let the team see the update. The document stays the single place the requirements live, and the repository copy follows it.

## The result

Your Kiro spec is now a document your whole team can edit, not a file only the engineers can reach. The requirements stay in one place, synced to the repository, readable by your agent and open to the people who should own them. That is the same idea Kiro is built on, spec first, extended so the spec belongs to everyone who has a stake in it.
