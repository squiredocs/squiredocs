import React, { useEffect, useMemo, useState } from 'react';
import { useEditor, EditorContent } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import Underline from '@tiptap/extension-underline';
import Link from '@tiptap/extension-link';
import Collaboration from '@tiptap/extension-collaboration';
import * as Y from 'yjs';
import { ySyncPluginKey } from 'y-prosemirror';
import { YChangeMark } from '../extensions/YChangeExtension';
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
 * Read-only preview of a historical version with inline diff visualization.
 *
 * Uses diffData from the server which contains:
 * - fullDoc: The complete document with all history (gc:false)
 * - currentSnapshot: Encoded Y.Snapshot at the current version's clock
 * - previousSnapshot: Encoded Y.Snapshot at the previous clock (for diff)
 */
function VersionPreview({
  diffData,
  versionContent, // Legacy fallback
  selection,
  isLoading = false,
  showDiff = true,
}) {
  const [diffApplied, setDiffApplied] = useState(false);

  // Create the history document and decode snapshots
  // IMPORTANT: We must apply individual updates one-by-one to preserve deleted items.
  // Y.encodeStateAsUpdate() loses deletion history, so we receive individual updates from the server.
  const { historyDoc, snapshot, prevSnapshot } = useMemo(() => {
    // Prefer diffData if available (new API with individual updates)
    if (diffData?.updates && diffData.updates.length > 0) {
      const doc = new Y.Doc({ gc: false });
      try {
        // Apply updates one-by-one to preserve full history including deleted items
        for (const update of diffData.updates) {
          Y.applyUpdate(doc, update);
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

      return { historyDoc: doc, snapshot: currentSnap, prevSnapshot: prevSnap };
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
      return { historyDoc: doc, snapshot: currentSnap, prevSnapshot: Y.emptySnapshot };
    }

    return { historyDoc: null, snapshot: null, prevSnapshot: null };
  }, [diffData, versionContent?.content]);

  // Reset diffApplied when content changes
  useEffect(() => {
    setDiffApplied(false);
  }, [diffData?.updates, diffData?.currentSnapshot, versionContent?.content]);

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

  // Apply snapshot diff when editor and snapshots are ready
  // Skip diff visualization if text content is identical (CRDT sync case)
  useEffect(() => {
    if (editor && snapshot && showDiff && !diffApplied && !textIdentical) {
      const timer = setTimeout(() => {
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
          console.error('Error applying diff snapshots:', e);
        }
      }, 50);
      return () => clearTimeout(timer);
    }
  }, [editor, snapshot, prevSnapshot, showDiff, diffApplied, textIdentical]);

  // Cleanup historyDoc on unmount
  useEffect(() => {
    return () => {
      if (historyDoc) {
        historyDoc.destroy();
      }
    };
  }, [historyDoc]);

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
