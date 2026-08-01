---
slug: version-history
title: Version history
description: Automatic versions, named versions, diffs, and non-destructive restore in Squire Docs.
order: 6
---

Every document keeps a full version history. Open it from the three-dot menu in the editor, under History, on any device including phones. This page covers how versions are formed, how to name them, how diffs work, and how restore behaves.

## How versions are formed

Edits are grouped into versions automatically. Consecutive edits become one version as long as no more than five minutes pass between them; when editing pauses for longer, the next edit starts a new version. Only edits that visibly change the document count; background synchronization that changes nothing is filtered out. This keeps each keystroke from becoming its own version while still saving meaningful checkpoints.

Each edit records who made it, whether a person or an AI agent. A version lists its contributors, each with a colored dot, and edits made by an agent are labeled with the agent's name.

## Named versions

You can give any version a name, such as "Final draft" or "Before refactor", and later rename it or remove the name. A named version stands out in the timeline, and a filter at the top of the panel can narrow the timeline to named versions only.

Anyone with access to the document can name versions, including viewers. Restoring, by contrast, requires the editor role.

## Navigating the timeline

The version history panel has three levels:

1. **Month**: versions grouped by calendar month.
2. **Version**: the automatic or named versions, using the five-minute grouping.
3. **Sub-versions**: open a version to see its edits grouped more finely, at a ten-second threshold. Long versions show their most recent edits first, with a count of how many the version holds in total.

## Diffs

Version history shows what changed between versions. Both versions are converted to markdown and compared, then the differences are shown in the document with insertions highlighted in green and deletions in red. Within a changed line, the specific words that changed get a stronger highlight, so a one-word edit in a long paragraph is easy to spot. On very large changes the word-level emphasis steps back to whole-line highlighting.

When the text is the same but only formatting changed, for example a span turned bold, the diff shows a "Formatting changes only" notice instead. You can turn diff highlighting off at any time to read the plain document at that version.

## Restoring a version

Restoring is non-destructive. It creates a new version that holds the older content, rather than deleting the versions that came after it. The full history stays intact, and everyone editing the document sees the restored content right away. Restoring requires the editor role, and a confirmation dialog explains what will happen before anything changes. In the rare case that the document is still syncing between servers, a restore is refused with a message to retry in a moment rather than restoring the wrong content.

Restore is different from undo. Undo precisely reverses your own most recent edit while preserving everyone else's later work; restore brings the whole document back to a point in time. An undo is itself recorded in version history as a new edit, attributed to whoever performed it. Connected agents get the same version tools you have: they can list, compare, name, and restore versions over MCP, and every such action is attributed. See [Agents and MCP](/documentation/agents-and-mcp).
