---
slug: sharing-specs-with-product-managers
title: Sharing specs with product managers for review
description: When specs live in the repo, getting a PM's review means copying the spec out and reconciling changes back by hand. Squire Docs removes the copy.
date: 2026-07-19
author: Sam Goldstein
---

When your specs live in the repository, getting a product manager's review is harder than it should be. The spec is a markdown file next to the code. The PM does not work in the repository. So the spec has to leave the repository to be reviewed, and then the review has to find its way back. That round trip is where feedback gets lost and where the two copies drift apart. Squire Docs removes the round trip by making the spec one document both sides edit.

## The friction

Say an engineer writes a spec as `specs/checkout-redesign/spec.md` and needs the PM to weigh in. Today that usually goes one of a few ways, and each one leaks.

**Copy it into a document.** The engineer pastes the spec into a shared doc and sends a link. The PM edits and comments there. Now there are two copies. Someone has to read the PM's version and hand-merge the changes back into the repository file. Anything missed in that merge is simply lost, and from that point the doc and the repo disagree.

**Send a pull request.** The engineer opens a PR with the spec and asks the PM to review it there. Most PMs do not want to review prose inside a code review tool, and commenting on a diff is an awkward way to reshape requirements. Participation drops.

**Move it to chat.** The engineer pastes highlights into Slack and collects reactions. Feedback arrives as scattered messages with no structure, and the spec itself never actually changes. The engineer becomes a transcriptionist.

In every version the same thing goes wrong. The spec and the review live in different places, and a person has to carry changes between them by hand. That person forgets things, and the copies drift.

## How Squire Docs removes it

In Squire Docs the spec is a single document with two-way markdown sync to your repository. It is the file in your repo and the document your PM opens in a browser. They are the same thing, not two copies.

The review flow becomes direct:

- **Share a link.** The PM opens the spec in their browser. No repository access, no local setup, no export.
- **They edit the actual spec.** Comments and edits land on the real document, not a copy. When the PM rewrites an acceptance criterion, they have rewritten the spec, not left a note asking someone else to.
- **Every change is attributed.** You can see which requirements the PM shaped and which the engineer wrote, so review is a record, not a guess.
- **It syncs back through your coding agent.** The reconciled spec returns to the repository as markdown with no hand-merge — a job your coding agent does in one step, as the next section shows.

## What you tell the agent

You do not run the sync yourself. You tell the coding agent already working in your repo, in plain language, and it does it. Set it up once by giving the agent a scoped API token; after that the workflow is just prompts:

- **Create the shared doc:** "Push `specs/checkout-redesign/spec.md` up to Squire Docs and give me the share link." The agent uploads the file and hands back a link to send your PM.
- **Pull the PM's review back:** "Sync the checkout spec down before you start." The agent reads the current document and updates the repo file, so your build sees exactly what the PM last edited.
- **Send your own edits up:** "Push my spec changes up to Squire Docs." The agent's edits land as attributed changes that merge with whatever the PM did in the browser, instead of overwriting it.

Under the hood that is a GET to read the document and a PUT to push edits back, against a token scoped to your documents — but you never have to think about it. The agent lives in the repo, so keeping the file and the document in sync is a one-line request, and the version your PM reviews and the version your build reads never drift.

## Why this changes the review, not just the tooling

When the spec has to leave the repository to be reviewed, the engineer owns it and the PM visits. The PM's role shrinks to leaving comments that someone else decides whether to apply. When the spec is a shared document both people edit, the PM is a co-author. They can fix the requirement themselves, and the fix is real the moment they make it.

This was never really about copy-paste time. It is about who can change the spec. When it lives only in the repo, the PM can suggest, and someone else decides what to keep. When it is a shared document, what the PM edits is the spec itself, already sitting in the file your agents build from.
