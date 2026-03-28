import React, { useMemo } from 'react';
import { useEditor, EditorContent } from '@tiptap/react';
import { getBaseExtensions } from '../extensions/editorExtensions';
import './EditorCommon.css';
import './VersionPreview.css';

/**
 * Read-only preview of a historical version with inline diff visualization.
 *
 * The server returns a ProseMirror document with diffInsert/diffDelete marks
 * baked into the content. Diff visibility is toggled purely via CSS.
 */
function VersionPreview({
  diffData,
  selection,
  isLoading = false,
  showDiff = true,
}) {
  // Editor extensions (read-only, no collaboration needed)
  const extensions = useMemo(() => [
    ...getBaseExtensions({ openLinksOnClick: true }),
  ], []);

  // Initialize editor with document content from server
  const editor = useEditor({
    extensions,
    editable: false,
    content: diffData?.document || null,
  }, [extensions, diffData?.document]);

  // Check if text is identical (skip diff visualization)
  const textIdentical = diffData?.meta?.textIdentical || false;

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
      <div className={`editor-common-container version-preview-content${!showDiff ? ' no-diff' : ''}`}>
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
