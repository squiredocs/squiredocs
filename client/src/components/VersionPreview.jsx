import React, { useEffect, useMemo, useState, useCallback } from 'react';
import { useEditor, EditorContent } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import Underline from '@tiptap/extension-underline';
import Link from '@tiptap/extension-link';
import Collaboration from '@tiptap/extension-collaboration';
import * as Y from 'yjs';
import { ySyncPluginKey } from 'y-prosemirror';
import { YChangeMark } from '../extensions/YChangeExtension';
import { DiffDecorationExtension, applyDiffDecorations } from '../extensions/DiffDecorationExtension';
import { yDocToProseMirrorDoc, computeDocumentDiff } from '../utils/contentDiff';
import './EditorCommon.css';
import './VersionPreview.css';

/**
 * Minimal PermanentUserData implementation for y-prosemirror snapshot diff.
 * y-prosemirror's _renderSnapshot requires permanentUserData to avoid null errors.
 */
class MinimalPermanentUserData {
  constructor() {
    this.dss = new Map();
  }

  getUserByClientId(clientId) {
    return 'Unknown';
  }

  getUserByDeletedId(id) {
    return 'Unknown';
  }
}

const minimalPermanentUserData = new MinimalPermanentUserData();

/**
 * Determine if we should use content-based diffing.
 * We use content-based diff when:
 * 1. Text content is NOT identical (there are actual changes to show)
 * 2. There's a previousSnapshot available for comparison
 *
 * Content-based diff avoids the CRDT client ID issue where y-prosemirror
 * shows "everything changed" when different client IDs merge.
 */
function shouldUseContentDiff(diffData) {
  // If text is identical, no diff needed
  if (diffData?.textIdentical) {
    return false;
  }
  // Use content diff when we have updates and snapshots
  return !!(diffData?.updates?.length > 0 && diffData?.previousSnapshot);
}

/**
 * Read-only preview of a historical version with inline diff visualization.
 *
 * Uses diffData from the server which contains:
 * - updates: Array of individual Yjs updates (preserves deletion history)
 * - currentSnapshot: Encoded Y.Snapshot at the current version's clock
 * - previousSnapshot: Encoded Y.Snapshot at the previous clock (for diff)
 * - textIdentical: Flag indicating no visible text change (sync-only)
 *
 * Diff strategies:
 * 1. Content-based diff (preferred): Uses prosemirror-changeset to compare actual content.
 *    Avoids the CRDT client ID issue where y-prosemirror shows "everything changed".
 * 2. y-prosemirror snapshot diff (fallback): Uses CRDT-level comparison.
 */
function VersionPreview({
  diffData,
  versionContent, // Legacy fallback
  selection,
  isLoading = false,
  showDiff = true,
}) {
  const [diffApplied, setDiffApplied] = useState(false);
  const [useContentDiff, setUseContentDiff] = useState(false);
  const [contentDiffChanges, setContentDiffChanges] = useState([]);

  // Create the history document and decode snapshots
  // IMPORTANT: We must apply individual updates one-by-one to preserve deleted items.
  // Y.encodeStateAsUpdate() loses deletion history, so we receive individual updates from the server.
  const { historyDoc, currentYDoc, previousYDoc, snapshot, prevSnapshot } = useMemo(() => {
    // Prefer diffData if available (new API with individual updates)
    if (diffData?.updates && diffData.updates.length > 0) {
      const doc = new Y.Doc({ gc: false });
      // Also build separate docs for content-based diff
      const prevDoc = new Y.Doc({ gc: false });
      const currDoc = new Y.Doc({ gc: false });

      try {
        // Apply updates one-by-one to preserve full history including deleted items
        for (const update of diffData.updates) {
          Y.applyUpdate(doc, update);
          Y.applyUpdate(currDoc, update);
        }

        // Build previous doc if we have a previousSnapshot
        if (diffData.previousSnapshot) {
          // Decode previous snapshot to find how many updates to apply
          const prevSnap = Y.decodeSnapshot(diffData.previousSnapshot);
          // Apply updates up to the previous state
          // The snapshot contains the state vector, so we need to build up to that state
          for (const update of diffData.updates) {
            const tempDoc = new Y.Doc();
            Y.applyUpdate(tempDoc, update);
            const updateSv = Y.encodeStateVector(tempDoc);
            tempDoc.destroy();

            // Apply all updates (we'll use the snapshot to render the correct view)
            Y.applyUpdate(prevDoc, update);
          }
        }
      } catch (e) {
        console.error('Error applying updates:', e);
      }

      const currentSnap = diffData.currentSnapshot
        ? Y.decodeSnapshot(diffData.currentSnapshot)
        : Y.snapshot(doc);

      const prevSnap = diffData.previousSnapshot
        ? Y.decodeSnapshot(diffData.previousSnapshot)
        : Y.emptySnapshot;

      return {
        historyDoc: doc,
        currentYDoc: currDoc,
        previousYDoc: prevDoc,
        snapshot: currentSnap,
        prevSnapshot: prevSnap,
      };
    }

    // Legacy fallback using versionContent
    if (versionContent?.content) {
      const doc = new Y.Doc({ gc: false });
      try {
        Y.applyUpdate(doc, versionContent.content);
      } catch (e) {
        console.error('Error applying version content:', e);
      }
      const currentSnap = Y.snapshot(doc);
      return {
        historyDoc: doc,
        currentYDoc: null,
        previousYDoc: null,
        snapshot: currentSnap,
        prevSnapshot: Y.emptySnapshot,
      };
    }

    return { historyDoc: null, currentYDoc: null, previousYDoc: null, snapshot: null, prevSnapshot: null };
  }, [diffData, versionContent?.content]);

  // Reset diffApplied when content changes
  useEffect(() => {
    setDiffApplied(false);
    setContentDiffChanges([]);
    setUseContentDiff(shouldUseContentDiff(diffData));
  }, [diffData?.updates, diffData?.currentSnapshot, versionContent?.content, diffData]);

  // Editor extensions (read-only, no collaboration cursors)
  const extensions = useMemo(() => {
    const baseExtensions = [
      StarterKit.configure({
        history: false,
      }),
      Underline,
      Link.configure({
        openOnClick: true,
      }),
      // YChangeMark renders the ychange attribute to DOM for CSS styling
      YChangeMark,
      // DiffDecorationExtension for content-based diff decorations
      DiffDecorationExtension,
    ];

    if (historyDoc) {
      baseExtensions.push(
        Collaboration.configure({
          document: historyDoc,
          field: 'default',
        })
      );
    }

    return baseExtensions;
  }, [historyDoc]);

  const editor = useEditor({
    extensions,
    editable: false,
  }, [extensions]);

  // Check if text is identical (skip diff visualization for CRDT sync artifacts)
  const textIdentical = diffData?.textIdentical || false;

  // Compute content-based diff when editor is ready
  // Compares the document at previousSnapshot to the document at currentSnapshot
  const computeContentBasedDiff = useCallback(() => {
    if (!editor || !editor.schema || !historyDoc) {
      return null;
    }

    try {
      // We need both snapshots to create docs at specific points in time
      if (!diffData?.currentSnapshot || !diffData?.previousSnapshot) {
        return null;
      }

      // Decode snapshots
      const currentSnap = Y.decodeSnapshot(diffData.currentSnapshot);
      const previousSnap = Y.decodeSnapshot(diffData.previousSnapshot);

      // Create docs at both snapshot points using the history doc
      // Y.createDocFromSnapshot returns a doc representing state at that snapshot
      const currFromSnapshot = Y.createDocFromSnapshot(historyDoc, currentSnap);
      const prevFromSnapshot = Y.createDocFromSnapshot(historyDoc, previousSnap);

      // Convert to ProseMirror docs
      const oldPmDoc = yDocToProseMirrorDoc(prevFromSnapshot, editor.schema);
      const newPmDoc = yDocToProseMirrorDoc(currFromSnapshot, editor.schema);

      // Cleanup Yjs docs
      currFromSnapshot.destroy();
      prevFromSnapshot.destroy();

      if (!oldPmDoc || !newPmDoc) {
        return null;
      }

      // Compute the diff between the two ProseMirror documents
      const changes = computeDocumentDiff(oldPmDoc, newPmDoc);
      return changes;
    } catch (error) {
      console.error('[VersionPreview] Error computing content diff:', error);
      return null;
    }
  }, [editor, diffData, historyDoc]);

  // Apply diff when editor and data are ready
  useEffect(() => {
    if (!editor || !showDiff || diffApplied || textIdentical) {
      return;
    }

    const timer = setTimeout(() => {
      // Try content-based diff first if applicable
      if (useContentDiff) {
        const changes = computeContentBasedDiff();
        if (changes && changes.length > 0) {
          setContentDiffChanges(changes);
          applyDiffDecorations(editor, changes);
          setDiffApplied(true);
          return;
        }
        // Fall through to y-prosemirror if content diff fails
      }

      // Fall back to y-prosemirror snapshot diff
      if (snapshot) {
        try {
          editor.view.dispatch(
            editor.view.state.tr.setMeta(ySyncPluginKey, {
              snapshot,
              prevSnapshot: prevSnapshot || Y.emptySnapshot,
              permanentUserData: minimalPermanentUserData,
            })
          );
          setDiffApplied(true);
        } catch (e) {
          console.error('Error applying y-prosemirror diff snapshots:', e);
        }
      }
    }, 100);

    return () => clearTimeout(timer);
  }, [editor, snapshot, prevSnapshot, showDiff, diffApplied, textIdentical, useContentDiff, computeContentBasedDiff]);

  // Cleanup historyDoc on unmount
  useEffect(() => {
    return () => {
      if (historyDoc) {
        historyDoc.destroy();
      }
      if (currentYDoc) {
        currentYDoc.destroy();
      }
      if (previousYDoc) {
        previousYDoc.destroy();
      }
    };
  }, [historyDoc, currentYDoc, previousYDoc]);

  if (isLoading) {
    return (
      <div className="version-preview">
        <div className="version-preview-loading">Loading version...</div>
      </div>
    );
  }

  if (!diffData && !versionContent) {
    return (
      <div className="version-preview">
        <div className="version-preview-empty">
          <p>Select a version to preview</p>
        </div>
      </div>
    );
  }

  return (
    <div className="version-preview">
      {textIdentical && (
        <div className="version-preview-notice">
          No visible text changes (sync update only)
        </div>
      )}
      <div className="editor-common-container version-preview-content">
        {editor ? (
          <EditorContent editor={editor} className="editor-common-content" />
        ) : (
          <div className="version-preview-loading">Loading version...</div>
        )}
      </div>

      {selection?.authors && selection.authors.length > 0 && (
        <div className="version-preview-authors">
          <span className="version-preview-authors-label">Contributors:</span>
          {selection.authors.map((author, i) => (
            <span
              key={author.id || i}
              className="version-preview-author"
              style={{ color: author.color }}
            >
              {author.name || 'Unknown'}
              {i < selection.authors.length - 1 && ', '}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

export default VersionPreview;
