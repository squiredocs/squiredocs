# Version History Diffs - Part 2: CRDT Client ID Issue

## Summary

The version diff feature is partially working but has a fundamental issue: when CRDT clients merge/sync, items with different client IDs can represent the same content. The y-prosemirror snapshot diff marks these as "added/removed" even when the visible text is unchanged or only slightly changed.

## What's Working

1. **Individual updates approach** - Server sends individual Yjs updates (not merged) to preserve deletion history
2. **Text-identical detection** - Server detects when text content is completely unchanged and sets `textIdentical` flag
3. **Sync-only filtering** - Version history filters out updates that don't change visible text content

## The Remaining Problem

Even when text DOES change, the snapshot diff can show "everything changed" due to CRDT client ID merging. Example from document `cd0eb033-f9f7-4925-85fb-c3b672be83d8`:

- **Clock 190 → 191**: Text grew from 5016 to 6308 chars (1292 chars added)
- **But**: A new client (3345797556) was merged in with 147 content items
- **Result**: Snapshot diff shows all 147 items as "added" instead of just the actual text changes

This happens when:
1. A user works offline and creates local edits
2. On reconnect, their client state merges into the document
3. Their items have different client IDs than existing items
4. Snapshot comparison sees all their items as "new"

## Root Cause Analysis

The y-prosemirror snapshot diff works by comparing which CRDT items exist in each snapshot's state vector. When a new client syncs:
- Their client ID wasn't in the previous snapshot's state vector
- All items from that client appear to be "added"
- Even if those items represent the same text as existing items

## Proposed Solutions

### Option A: ProseMirror-based diffing (Recommended)

Instead of using y-prosemirror's snapshot diff, compute a content-based diff:

1. **Build ProseMirror docs at both clocks** (using Yjs but ignoring snapshots)
2. **Use `prosemirror-changeset`** with `@manuscripts/prosemirror-recreate-steps` to compute differences
3. **Render changes** based on actual content differences, not CRDT items

**Pros**: Clean diffs that match user expectations
**Cons**: Requires additional dependencies and implementation work

**Key resources**:
- [prosemirror-changeset](https://www.npmjs.com/package/prosemirror-changeset) - Converts steps into insertion/deletion spans
- [@manuscripts/prosemirror-recreate-steps](https://www.npmjs.com/package/@manuscripts/prosemirror-recreate-steps) - Recreates steps between two document states
- [ProseMirror discuss: comparing documents](https://discuss.prosemirror.net/t/how-to-compare-2-versions-of-the-same-document/1836)

### Option B: Hybrid approach

1. Detect when snapshot diff would be misleading (many new client items)
2. Fall back to text-based diff display for those cases
3. Keep snapshot diff for "clean" cases

### Option C: Simple text diff

1. Extract plain text from both versions
2. Use a text diff library (like `diff` or `fast-diff`)
3. Display as a simple text diff (loses formatting context)

## Files Changed

### Committed (checkpoint)
- `server/index.js` - Diff endpoint sends individual updates array
- `client/src/hooks/useVersionHistory.js` - Handles new API response format
- `client/src/components/VersionPreview.jsx` - Applies updates individually
- `docs/version-diff-status-update.md` - Initial status doc

### Uncommitted (in working directory)
- `server/index.js` - Added `textIdentical` flag
- `server/version-history.js` - Text-based filtering of sync-only updates
- `client/src/hooks/useVersionHistory.js` - Handles `textIdentical` flag
- `client/src/components/VersionPreview.jsx` - Skips diff when text identical
- `client/src/components/VersionPreview.css` - Notice styling

## Test Document

Use document `cd0eb033-f9f7-4925-85fb-c3b672be83d8` in the GKE database for testing:
- Clock 191: Shows "everything changed" issue (CRDT merge)
- Clocks 206-208: Shows actual full-document changes (case inversion by agent)

## Analysis Scripts

Several analysis scripts were created in `/tmp/` during investigation:
- `analyze-191.js` - Analyzes specific clock
- `analyze-versions.js` - Shows version boundaries after text filtering
- `analyze-diff-191.js` - Analyzes client ID changes
- `content-diff2.js` - Simple text diff demonstration

## Next Steps

1. **Decide on approach** - Option A (ProseMirror-based) is cleanest but most work
2. **If Option A**:
   - Install `prosemirror-changeset` and `@manuscripts/prosemirror-recreate-steps`
   - Create utility to convert Yjs doc to ProseMirror doc at specific clock
   - Implement changeset-based diff rendering
3. **Test thoroughly** with the test document
4. **Commit all changes**

## Relevant Links

- [Yjs Docs: ProseMirror Versioning](https://docs.yjs.dev/ecosystem/editor-bindings/prosemirror)
- [Yjs Community: Diffing snapshots](https://discuss.yjs.dev/t/ydocs-diffing-2-snapshots/2037)
- [ProseMirror Changeset GitHub](https://github.com/ProseMirror/prosemirror-changeset)
- [Yjs Deep Dive Part 4](https://www.tag1.com/blog/yjs-deep-dive-part-4/)
