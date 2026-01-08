# Version History Diffs - Part 2: CRDT Client ID Issue

## Summary

The version diff feature has been enhanced with content-based diffing to fix the CRDT client ID issue where y-prosemirror snapshot diffs show "everything changed" when different client IDs merge.

## Solution Implemented: Content-Based Diffing (Option A)

Instead of relying solely on y-prosemirror's CRDT-level snapshot diff, we now use **prosemirror-changeset** with **@manuscripts/prosemirror-recreate-steps** to compute content-aware diffs.

### How It Works

1. **Build ProseMirror docs at both clocks** using `Y.createDocFromSnapshot()` and `yXmlFragmentToProseMirrorRootNode()`
2. **Compute steps** between the two docs using `recreateTransform()` from prosemirror-recreate-steps
3. **Convert to changes** using `ChangeSet.create().addSteps()` from prosemirror-changeset
4. **Apply decorations** to highlight insertions (green) and deletions (red strikethrough)

### Diff Strategy Selection

The VersionPreview component now uses a two-tier strategy:

1. **Content-based diff (preferred)**: Used when there are actual text changes and a previous snapshot is available. Compares ProseMirror document content, ignoring CRDT internals.

2. **y-prosemirror snapshot diff (fallback)**: Used when content diff fails or returns no changes. Still useful for cases where CRDT-level comparison is appropriate.

3. **Skip diff**: When `textIdentical` flag is set (pure sync updates with no visible changes).

## Files Changed

### New Files
- `client/src/utils/contentDiff.js` - Core content diffing utilities:
  - `yDocToProseMirrorDoc()` - Converts Yjs doc to ProseMirror doc
  - `computeDocumentDiff()` - Computes changes between two PM docs
  - `createDiffDecorations()` - Creates decoration set for changes

- `client/src/extensions/DiffDecorationExtension.js` - TipTap extension for managing diff decorations:
  - `DiffDecorationExtension` - ProseMirror plugin for decoration state
  - `applyDiffDecorations()` - Helper to apply changes to editor

### Modified Files
- `client/src/components/VersionPreview.jsx` - Updated to use content-based diffing:
  - Added `useContentDiff` state to track diff strategy
  - Added `computeContentBasedDiff()` callback
  - Falls back to y-prosemirror if content diff fails

- `client/src/components/VersionPreview.css` - Added styles for content-based diff:
  - `.diff-insert` - Green background for insertions
  - `.diff-delete` - Red strikethrough for deletions
  - `.diff-delete-marker` - Widget marker for deletion position

- `package.json` - Added `@manuscripts/prosemirror-recreate-steps` dependency

## The Original Problem

When CRDT clients merge/sync, items with different client IDs can represent the same content. The y-prosemirror snapshot diff marks these as "added/removed" even when the visible text is unchanged or only slightly changed.

Example from document `cd0eb033-f9f7-4925-85fb-c3b672be83d8`:
- **Clock 190 → 191**: Text grew from 5016 to 6308 chars (1292 chars added)
- **But**: A new client was merged in with 147 content items
- **Result with old approach**: Snapshot diff shows all 147 items as "added"
- **Result with new approach**: Only the actual 1292 chars of new content are highlighted

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                     VersionPreview                          │
├─────────────────────────────────────────────────────────────┤
│  1. Receive diffData (updates[], snapshots)                │
│  2. Build historyDoc (gc:false, all updates applied)        │
│  3. Check shouldUseContentDiff()                            │
│                                                             │
│  Content-based path:                                        │
│  ├─ Y.createDocFromSnapshot() for previous state            │
│  ├─ yDocToProseMirrorDoc() for both states                  │
│  ├─ recreateTransform() to get steps                        │
│  ├─ ChangeSet.addSteps() to get change ranges               │
│  └─ applyDiffDecorations() to highlight changes             │
│                                                             │
│  Fallback path (y-prosemirror):                             │
│  └─ dispatch ySyncPluginKey meta with snapshot pair         │
└─────────────────────────────────────────────────────────────┘
```

## Test Document

Use document `cd0eb033-f9f7-4925-85fb-c3b672be83d8` in the GKE database for testing:
- Clock 191: Previously showed "everything changed" issue (CRDT merge)
- Clocks 206-208: Shows actual full-document changes (case inversion by agent)

## Relevant Links

- [prosemirror-changeset](https://github.com/ProseMirror/prosemirror-changeset) - Converts steps into insertion/deletion spans
- [@manuscripts/prosemirror-recreate-steps](https://gitlab.com/mpapp-public/prosemirror-recreate-steps) - Recreates steps between two document states
- [ProseMirror discuss: comparing documents](https://discuss.prosemirror.net/t/how-to-compare-2-versions-of-the-same-document/1836)
- [Yjs Docs: ProseMirror Versioning](https://docs.yjs.dev/ecosystem/editor-bindings/prosemirror)
