# Version Diff Implementation Status Update

## Overview

This document tracks the implementation of inline diff visualization in the version history panel using y-prosemirror's built-in snapshot diff feature. The goal is to show what changed between versions with green highlighting for additions and red strikethrough for deletions.

## Current Status: Fix Applied - Ready for Testing

The core bug has been identified and fixed. All tests pass (252 tests). The implementation is ready for end-to-end UI testing.

### Root Cause (Identified and Fixed)

The original implementation used `Y.encodeStateAsUpdate(fullDoc)` to send the document to the client. **This was the bug.** Even with `gc:false`, `encodeStateAsUpdate()` only captures the current state - it loses deleted items and their history. Without deleted items, snapshot diffs show everything as added/removed instead of showing actual changes.

### The Fix

Instead of sending a merged update, the server now sends **individual updates array** from the database. The client applies these one-by-one, preserving the full history including deleted items that are required for proper diff visualization.

## What's Been Implemented

### Server-Side

1. **Endpoint: `/api/docs/:docId/history/diff`** (`server/index.js`)
   - **Fixed**: Now returns individual updates array instead of merged fullDoc
   - Query params: `currentClock` (required), `previousClock` (optional)
   - Returns: `{ updates: [...], currentSnapshot, previousSnapshot }`
   - Updates are sent as individual arrays to preserve deletion history

2. **`getYDocWithHistory` method** (`server/postgres-persistence.js`)
   - Creates a Y.Doc with `gc: false` to preserve deleted items
   - Applies all stored updates in order to reconstruct full history

### Client-Side

1. **`YChangeExtension.js`** (`client/src/extensions/YChangeExtension.js`)
   - Custom TipTap mark that renders `ychange` attributes to the DOM
   - Required because y-prosemirror sets attributes that TipTap doesn't natively understand

2. **`useVersionHistory.js` updates** (`client/src/hooks/useVersionHistory.js`)
   - **Fixed**: `diffData` state now contains `{ updates: [...], currentSnapshot, previousSnapshot }`
   - `loadDiffData` converts update arrays to Uint8Array for client-side processing
   - Updated `selectVersion` to use the new diff API

3. **`VersionPreview.jsx` rewrite** (`client/src/components/VersionPreview.jsx`)
   - **Fixed**: Now applies updates one-by-one instead of single merged update
   - Creates Y.Doc with `gc: false` and applies individual updates sequentially
   - This preserves deleted items needed for proper diff highlighting
   - Decodes snapshots using `Y.decodeSnapshot()`
   - Dispatches snapshot transaction with `ySyncPluginKey`
   - Includes `MinimalPermanentUserData` class to avoid null errors

4. **CSS styling** (`client/src/components/VersionPreview.css`)
   ```css
   [ychange="added"] { background-color: rgba(46, 160, 67, 0.3); }
   [ychange="removed"] { text-decoration: line-through; color: #d73a49; }
   ```

## Key Technical Insights

### Why the Original Approach Failed

The initial implementation tried to:
1. Reconstruct separate Y.Doc instances for current and previous versions
2. Create snapshots from these separate documents
3. Compare them using y-prosemirror's snapshot diff

**Problem**: y-prosemirror's snapshot diff requires both snapshots to reference items in the **SAME** document with full history. When you reconstruct separate documents, they have different client IDs and item structures, making comparison meaningless.

### The Correct Approach

Based on research from the Yjs community and official demos:

1. **Single Document**: Maintain ONE Y.Doc with complete version history (`gc: false`)
2. **Snapshots are Lightweight**: A snapshot is just a state vector + delete set, not a full document
3. **Both Snapshots Same Doc**: Both current and previous snapshots must be created from the same document instance
4. **Server Returns Full History**: The diff endpoint returns the full document with all updates, plus encoded snapshots at specific clock positions

### permanentUserData Requirement

y-prosemirror's `_renderSnapshot` function calls `permanentUserData.getUserByClientId()` even when `permanentUserData` is null, causing a TypeError. The solution is to provide a minimal implementation:

```javascript
class MinimalPermanentUserData {
  constructor() { this.dss = new Map(); }
  getUserByClientId(clientId) { return 'Unknown'; }
  getUserByDeletedId(id) { return 'Unknown'; }
}
```

## Files Modified

| File | Changes |
|------|---------|
| `server/index.js` | Added `/api/docs/:docId/history/diff` endpoint |
| `server/postgres-persistence.js` | Added `getYDocWithHistory()` method |
| `client/src/hooks/useVersionHistory.js` | Added `diffData` state and `loadDiffData()` |
| `client/src/components/VersionPreview.jsx` | Rewrote to use diffData with proper snapshot handling |
| `client/src/components/EditorView.jsx` | Updated to pass `diffData` prop |
| `client/src/extensions/YChangeExtension.js` | Created for rendering ychange marks |
| `client/src/components/VersionPreview.css` | Added diff styling |

## Known Issues

1. ~~**Test Failures**: Tests have been updated to match the new API~~ **RESOLVED**
2. **End-to-End Testing**: The complete flow needs verification in the UI

## Next Steps

1. ~~Run and fix any failing tests~~ **COMPLETED**
2. Test the implementation in the browser:
   - Create a document with some content
   - Make edits (add text, delete text)
   - Open version history panel
   - Select a version and verify diff highlighting appears correctly
3. If diff still shows everything as changed, investigate:
   - Verify the full document has all history (check clock values)
   - Verify snapshots are being created at correct clock positions
   - Add debug logging to trace snapshot creation and application

## References

- [y-prosemirror GitHub Issue #60](https://github.com/yjs/y-prosemirror/issues/60) - Known issue with snapshot diff
- [Yjs Versioning Demo](https://github.com/yjs/yjs-demos/tree/main/versioning) - Official versioning implementation
- [y-prosemirror sync plugin source](https://github.com/yjs/y-prosemirror/blob/master/src/plugins/sync-plugin.js) - Reference for snapshot handling

## Architecture Diagram

```
┌─────────────────────────────────────────────────────────────────┐
│                         Client                                   │
│  ┌─────────────────┐    ┌──────────────────────────────────┐   │
│  │ useVersionHistory│───▶│ loadDiffData(currentClock,      │   │
│  │                 │    │              previousClock)       │   │
│  └─────────────────┘    └──────────────────────────────────┘   │
│           │                           │                         │
│           ▼                           ▼                         │
│  ┌─────────────────┐    ┌──────────────────────────────────┐   │
│  │ diffData state  │    │ GET /api/docs/:id/history/diff   │   │
│  │ {fullDoc,       │    │ ?currentClock=X&previousClock=Y  │   │
│  │  currentSnapshot│    └──────────────────────────────────┘   │
│  │  prevSnapshot}  │                  │                         │
│  └─────────────────┘                  │                         │
│           │                           │                         │
│           ▼                           │                         │
│  ┌─────────────────────────────────┐  │                         │
│  │ VersionPreview                  │  │                         │
│  │ - Creates Y.Doc from fullDoc    │  │                         │
│  │ - Decodes snapshots             │  │                         │
│  │ - Dispatches to ySyncPluginKey  │  │                         │
│  └─────────────────────────────────┘  │                         │
└───────────────────────────────────────┼─────────────────────────┘
                                        │
                                        ▼
┌─────────────────────────────────────────────────────────────────┐
│                         Server                                   │
│  ┌─────────────────────────────────────────────────────────┐   │
│  │ /api/docs/:id/history/diff endpoint                      │   │
│  │ 1. Load full Y.Doc with gc:false (all history)          │   │
│  │ 2. Create snapshot at currentClock                       │   │
│  │ 3. Create snapshot at previousClock                      │   │
│  │ 4. Return encoded: {fullDoc, currentSnapshot, prevSnap}  │   │
│  └─────────────────────────────────────────────────────────┘   │
│                              │                                   │
│                              ▼                                   │
│  ┌─────────────────────────────────────────────────────────┐   │
│  │ postgres-persistence.js                                  │   │
│  │ getYDocWithHistory() - returns Y.Doc with all updates   │   │
│  └─────────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────┘
```
