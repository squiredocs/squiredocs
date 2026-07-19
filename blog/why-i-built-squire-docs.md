---
slug: why-i-built-squire-docs
title: Why I built Squire Docs
description: Specs and design docs are where software decisions get made, but the tools split humans from their coding agents. Squire Docs is one place where both write together.
date: 2026-06-14
author: Sam Goldstein
---

Squire Docs is a collaborative editor where engineers, product managers, and coding agents write the same document together. Every edit is attributed, and the document syncs both ways to markdown in your repository. I built it because the document is where software decisions actually get made, and no existing tool let a human and an agent edit that document as equals.

![Engineers, product managers, and coding agents editing one shared document as equals, with the document syncing both ways to the markdown file in your repository.](/blog-shared-document-two-way-sync.svg)

## The problem I kept hitting

I write software with coding agents now. The agent reads a design doc, proposes a plan, and edits code against it. That loop works well when the code and the spec are both text the agent can read and change precisely.

It breaks at the document. A coding agent can make a one-line change to a source file, leave the rest untouched, and show you the diff. Point that same agent at a design doc in a typical editor and it does something cruder. It rewrites a whole section, drops the formatting, and erases who wrote what. The precision it has over code disappears the moment the work moves into prose.

So the spec ends up in one of two places, and both cost something.

Keep the spec in the repository as a markdown file. Your agent reads and writes it cleanly, and it is versioned next to the code. But the people who should shape that spec, product managers and designers and anyone who does not live in a code editor, cannot easily touch it. Review happens by copy and paste.

Keep the spec in a shared document tool instead. Now everyone can edit it, but the agent's edits are coarse, changes are hard to attribute, and getting the result back into the repository is a manual reconciliation you do by hand every time.

You are forced to choose between a spec your agents can work with and a spec your team can work with. I did not want to choose.

## What Squire Docs does differently

Squire Docs holds one document that serves both sides.

**Agents make surgical edits.** An agent changes the specific part of the document it means to change and leaves the rest alone, the same way it edits a line of code. It does not replace the document to fix a sentence.

**Humans and agents edit at the same time.** The editing is real-time and collaborative. You can watch an agent revise a section while a colleague comments on the one above it.

**Every edit is attributed.** You can see who changed what, whether the author was a person or an agent. Nothing lands anonymously.

**The document syncs both ways to your repository.** The spec is a Squire Docs document your PM can open in a browser and a markdown file that lives in your repo. Edit either side and the other follows. The repository copy and the working copy stay the same file.

## Why it matters now

Spec-driven development has become a mainstream way to build software. The idea is simple: write down what you want clearly enough that a coding agent can execute against it, then let it. The written spec is the interface between what a person intends and what an agent builds.

That makes the document the most important artifact in the workflow, and it deserves a tool built for the job. It should be precise enough for an agent and open enough for the whole team. Squire Docs is my attempt at that tool, and we build Squire Docs itself this way, with the design docs living in Squire Docs and agents editing them alongside us.

If your specs live in the repo and the people who should edit them do not, that is the gap I built this to close.
