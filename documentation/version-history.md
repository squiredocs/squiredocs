---
slug: version-history
title: Version history
description: Automatic versions, named versions, diffs, and non-destructive restore in Squire Docs.
order: 6
---

Every document keeps a full version history. Open it with the History button. This page covers how versions are formed, how to name them, how diffs work, and how restore behaves.

## How versions are formed

Edits are grouped into versions automatically. Consecutive edits within a five-minute window become one version. When editing pauses for more than five minutes, the next edit starts a new version. This keeps each keystroke from becoming its own version while still saving meaningful checkpoints.

Each edit records who made it, whether a person or an AI agent. A version lists all of its contributors with their avatar colors, and edits made by an agent are labeled with the agent's name.

## Named versions

You can give any version a name, such as "Final draft" or "Before refactor". A named version stores a snapshot so it loads instantly, and it stands out in the timeline.

## Navigating the timeline

The version history panel has three levels:

1. **Month**: versions grouped by calendar month.
2. **Version**: the automatic or named versions, using the five-minute grouping.
3. **Sub-versions**: open a version to see its edits grouped more finely, at a ten-second threshold.

## Diffs

Version history shows what changed between versions. Both versions are converted to markdown and compared, then the differences are shown in the document with insertions highlighted in green and deletions in red.

When the text is the same but the formatting changed, for example a span turned bold, the diff shows a "Formatting changes only" notice and highlights the affected spans. You can turn diff highlighting off to read the plain document at that version.

## Restoring a version

Restoring is non-destructive. It creates a new version that holds the older content, rather than deleting the versions that came after it. The full history stays intact, and everyone editing the document sees the restored content right away.
