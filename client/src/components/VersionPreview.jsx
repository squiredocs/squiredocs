import React, { useEffect, useMemo, useState, useRef } from 'react';
import { useEditor, EditorContent } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import Link from '@tiptap/extension-link';
import Underline from '@tiptap/extension-underline';
import { DiffDecorationExtension, applyDiffDecorations, clearDiffDecorations } from '../extensions/DiffDecorationExtension';
import './EditorCommon.css';
import './VersionPreview.css';

/**
 * Read-only preview of a historical version with inline diff visualization.
 *
 * Receives pre-computed diff data from the server:
 * - document: ProseMirror JSON of the document at currentClock
 * - changes: Array of {type, fromB, toB, deleted} for decorations
 * - meta: {previousClock, currentClock, textIdentical}
 *
 * The server handles all Yjs document reconstruction and diff computation,
 * so this component just renders the document and applies decorations.
 */
function VersionPreview({
  diffData,
  selection,
  isLoading = false,
  showDiff = true,
}) {
  const [diffApplied, setDiffApplied] = useState(false);

  // Ref for race condition prevention
  const versionCounterRef = useRef(0);

  // Editor extensions (read-only, no collaboration needed)
  const extensions = useMemo(() => [
    StarterKit.configure({
      undoRedo: false, // Disable built-in undo/redo
      link: false, // Disable built-in Link, we configure it separately below
      underline: false // Disable built-in Underline, we configure it separately below
    }),
    Link.configure({
      openOnClick: true, // Allow default link behavior in preview
    }),
    Underline,
    DiffDecorationExtension,
  ], []);

  // Initialize editor with document content from server
  const editor = useEditor({
    extensions,
    editable: false,
    content: diffData?.document || null,
  }, [extensions, diffData?.document]);

  // Check if text is identical (skip diff visualization)
  const textIdentical = diffData?.meta?.textIdentical || false;

  // Clear decorations and reset state when selection changes or showDiff is toggled off
  // This ensures decorations are properly reapplied when switching between items
  useEffect(() => {
    if (editor) {
      clearDiffDecorations(editor);
    }
    setDiffApplied(false);
  }, [selection?.id, editor, showDiff]);

  // Apply diff decorations when editor is ready and we have changes
  useEffect(() => {
    if (!editor || !showDiff || diffApplied || textIdentical) {
      return;
    }

    // Increment version counter to detect stale callbacks
    const currentVersion = ++versionCounterRef.current;

    // Small delay to ensure editor is fully initialized
    const timer = setTimeout(() => {
      // Skip if version changed while waiting
      if (currentVersion !== versionCounterRef.current) {
        return;
      }

      if (diffData?.changes && diffData.changes.length > 0) {
        applyDiffDecorations(editor, diffData.changes);
      }
      setDiffApplied(true);
    }, 50);

    return () => clearTimeout(timer);
  }, [editor, diffData?.changes, showDiff, diffApplied, textIdentical]);

  if (isLoading) {
    return (
      <div className="version-preview">
        <div className="version-preview-loading">Loading version...</div>
      </div>
    );
  }

  if (!diffData) {
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
