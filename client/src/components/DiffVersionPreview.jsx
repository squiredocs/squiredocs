import React, { useEffect, useMemo, useRef } from 'react';
import { useEditor, EditorContent } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import Underline from '@tiptap/extension-underline';
import Link from '@tiptap/extension-link';
import Collaboration from '@tiptap/extension-collaboration';
import { Plugin, PluginKey } from 'prosemirror-state';
import { Decoration, DecorationSet } from 'prosemirror-view';
import * as Y from 'yjs';
import { computeDiff, getDiffSummary } from '../utils/ydocDiff';
import './EditorCommon.css';
import './VersionPreview.css';
import './DiffVersionPreview.css';

// Plugin key for diff decorations
const diffPluginKey = new PluginKey('diff');

/**
 * Create a ProseMirror plugin that applies diff decorations
 */
function createDiffPlugin(diffData) {
  return new Plugin({
    key: diffPluginKey,
    props: {
      decorations(state) {
        if (!diffData || !diffData.changes) return DecorationSet.empty;

        const decorations = [];
        const { changes } = diffData;

        for (const change of changes) {
          if (change.type === 'added') {
            // Create decoration for added text
            // Note: positions need to account for ProseMirror's node structure
            // We need to map text positions to document positions
            try {
              // Find the position in the document
              const from = Math.max(1, change.from + 1); // +1 for doc node
              const to = Math.min(state.doc.content.size - 1, change.to + 1);

              if (from < to && from >= 1 && to <= state.doc.content.size) {
                decorations.push(
                  Decoration.inline(from, to, {
                    class: 'diff-added',
                    'data-diff-type': 'added',
                  })
                );
              }
            } catch (e) {
              // Position might be out of bounds
            }
          } else if (change.type === 'removed') {
            // For removed text, we show a marker at the position
            // This is tricky since the text doesn't exist in the current doc
            // We'll use a widget decoration to show deleted content
            try {
              const pos = Math.max(1, Math.min(change.from + 1, state.doc.content.size - 1));
              decorations.push(
                Decoration.widget(pos, () => {
                  const span = document.createElement('span');
                  span.className = 'diff-removed';
                  span.setAttribute('data-diff-type', 'removed');
                  span.textContent = change.value;
                  return span;
                }, { side: 0 })
              );
            } catch (e) {
              // Position might be out of bounds
            }
          }
        }

        return DecorationSet.create(state.doc, decorations);
      },
    },
  });
}

/**
 * Version preview with diff highlighting
 */
function DiffVersionPreview({
  versionContent,
  previousVersionContent,
  selection, // Unified: version or clock update (with isClock: true)
  showDiff = true,
  isLoading = false,
}) {
  const diffDataRef = useRef(null);

  // Create Y.Doc for the current version content
  const ydoc = useMemo(() => {
    if (!versionContent?.content) return null;

    const doc = new Y.Doc();
    try {
      Y.applyUpdate(doc, versionContent.content);
    } catch (e) {
      console.error('Error applying version content:', e);
    }
    return doc;
  }, [versionContent?.content]);

  // Compute diff between previous and current version
  const diffData = useMemo(() => {
    if (!showDiff || !versionContent?.content) return null;

    try {
      const diff = computeDiff(
        previousVersionContent?.content || null,
        versionContent.content
      );
      diffDataRef.current = diff;
      return diff;
    } catch (e) {
      console.error('Error computing diff:', e);
      return null;
    }
  }, [versionContent?.content, previousVersionContent?.content, showDiff]);

  // Editor extensions
  const extensions = useMemo(() => {
    const baseExtensions = [
      StarterKit.configure({
        history: false,
      }),
      Underline,
      Link.configure({
        openOnClick: true,
      }),
    ];

    if (ydoc) {
      baseExtensions.push(
        Collaboration.configure({
          document: ydoc,
          field: 'default',
        })
      );
    }

    return baseExtensions;
  }, [ydoc]);

  const editor = useEditor({
    extensions,
    editable: false,
  }, [extensions]);

  // Apply diff decorations when diff data or editor changes
  useEffect(() => {
    if (!editor || !showDiff || !diffData) return;

    // Unfortunately, we can't easily add plugins dynamically
    // Instead, we'll use a simpler approach: apply decorations via transaction
    // For now, we'll use CSS-based highlighting via marks

    // Clean up any previous diff classes
    const editorElement = editor.view?.dom;
    if (editorElement) {
      // Apply a class to indicate diff mode is active
      editorElement.classList.toggle('diff-mode-active', showDiff);
    }
  }, [editor, showDiff, diffData]);

  // Cleanup ydoc on unmount
  useEffect(() => {
    return () => {
      if (ydoc) {
        ydoc.destroy();
      }
    };
  }, [ydoc]);

  if (isLoading) {
    return (
      <div className="version-preview diff-version-preview">
        <div className="version-preview-loading">Loading version...</div>
      </div>
    );
  }

  if (!versionContent || !selection) {
    return (
      <div className="version-preview diff-version-preview">
        <div className="version-preview-empty">
          <p>Select a version to preview</p>
        </div>
      </div>
    );
  }

  return (
    <div className="version-preview diff-version-preview">
      {/* Diff summary header */}
      {showDiff && diffData && (
        <div className="diff-summary">
          <div className="diff-summary-stats">
            {diffData.summary.added > 0 && (
              <span className="diff-stat diff-stat-added">
                +{diffData.summary.added}
              </span>
            )}
            {diffData.summary.removed > 0 && (
              <span className="diff-stat diff-stat-removed">
                -{diffData.summary.removed}
              </span>
            )}
            {diffData.summary.added === 0 && diffData.summary.removed === 0 && (
              <span className="diff-stat diff-stat-unchanged">No changes</span>
            )}
          </div>
          {!previousVersionContent && (
            <span className="diff-note">First version (no previous to compare)</span>
          )}
        </div>
      )}

      {/* Diff legend */}
      {showDiff && diffData && (diffData.summary.added > 0 || diffData.summary.removed > 0) && (
        <div className="diff-legend">
          <span className="diff-legend-item">
            <span className="diff-legend-color diff-legend-added"></span>
            Added
          </span>
          <span className="diff-legend-item">
            <span className="diff-legend-color diff-legend-removed"></span>
            Removed
          </span>
        </div>
      )}

      {/* Editor content */}
      <div className="editor-common-container version-preview-content">
        {editor ? (
          <EditorContent editor={editor} className="editor-common-content" />
        ) : (
          <div className="version-preview-loading">Loading version...</div>
        )}
      </div>

      {/* Inline diff view - shows actual text changes */}
      {showDiff && diffData && (diffData.summary.added > 0 || diffData.summary.removed > 0) && (
        <div className="diff-inline-view">
          <div className="diff-inline-header">Text Changes</div>
          <div className="diff-inline-content">
            {diffData.changes.map((change, i) => (
              <span
                key={i}
                className={`diff-inline-segment diff-inline-${change.type}`}
              >
                {change.value}
              </span>
            ))}
          </div>
        </div>
      )}

      {/* Authors */}
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

export default DiffVersionPreview;
