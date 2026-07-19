---
slug: spec-driven-development-with-claude-and-speckit
title: Spec-driven development with Claude, Squire Docs, and Spec Kit
description: How we combine Claude, Squire Docs, and Spec Kit into a design-to-merged pipeline where the written spec is the source of truth and agents implement against it.
date: 2026-06-21
author: Sam Goldstein
---

Spec-driven development is a way of building software where a written specification is the source of truth and a coding agent implements against it. This post describes the pipeline we use to build Squire Docs itself. It combines three tools: Claude does the work, Squire Docs holds the specs, and Spec Kit provides the structure that turns a rough idea into an executable plan.

We call the workflow "the pipeline." Here is what it does at a high level.

## The three tools

**Claude** is the coding agent. It writes the spec, drafts the plan, implements the tasks, and reviews the result. Different stages run at different model sizes, matched to how much judgment each stage needs.

**Squire Docs** holds the design. Every feature traces back to a design document, and those documents live in Squire Docs, not in a static file that goes stale. The design is the ground truth the whole pipeline answers to. When we change a design, we change it in Squire Docs first, then bring the code to match.

**Spec Kit** provides the scaffolding. It is an open framework that breaks a feature into a repeatable sequence: specify, plan, tasks, then implement. Each step has a template, so the same rough idea becomes a clear spec, a technical plan, and a concrete task list in a predictable shape.

## How a feature moves through the pipeline

The design document comes first and stays authoritative. Code, specs, and old assumptions all lose to it. If the design is silent on something, that silence becomes a flagged question, not a decision an agent makes on its own.

From there a feature moves through stages:

1. **Spec.** An agent turns the design into a specification: what the feature does, in the user's terms, with acceptance criteria.
2. **Plan and tasks.** Another agent produces the technical plan and breaks it into an ordered task list, then checks the three artifacts against each other for consistency. Serious inconsistencies stop the line before any code is written.
3. **Implement.** An agent works through the tasks on its own branch, in an isolated copy of the repository, committing as it goes. Several features can be in flight at once, as long as they do not touch the same code.
4. **Merge.** Each finished branch merges back one at a time, and the full test suite, database migrations, and build all have to pass in the real repository before it counts as done.
5. **Review.** A separate agent reviews the merged change adversarially, looking hardest at the things that would hurt most if wrong: permission checks, data integrity, then correctness. It has to name a real file and a concrete failing scenario, not a vague worry.
6. **Fix.** Findings get fixed the same day, and the reasoning behind each decision is recorded so the history explains itself later.

A human stays in the loop between stages. The agents do the work; a person decides what moves forward.

## Why the spec being a living document matters

The part that makes this hold together is that the spec is not a file someone wrote once and forgot. It is a Squire Docs document that syncs to the repository as markdown.

That means the same spec a coding agent implements against is a document a product manager can open and edit in a browser. When the PM changes an acceptance criterion, the change is attributed and it flows back to the repository. The agent picks up the current spec, not a copy that drifted out of date three commits ago.

Spec-driven development is only as good as the spec. Keeping the spec somewhere both your team and your agents can edit it, without copying it back and forth, is what keeps the whole loop synchronized.

## Getting started

You do not need our exact pipeline to start. The core idea is portable: write the spec down clearly, keep it somewhere your agent and your teammates can both edit, and let the agent implement against it. Spec Kit gives you the templates, Claude does the work, and Squire Docs keeps the spec live for both sides. Start with one feature and one document, and grow the workflow from there.
