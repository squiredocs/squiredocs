import React, { useMemo } from 'react';
import { useEditor, EditorContent } from '@tiptap/react';
import { getBaseExtensions } from '../extensions/editorExtensions';
import { contributorTitle, contributorName, contributorColor } from '../utils/contributors';
import './EditorCommon.css';
import './VersionPreview.css';

/**
 * Read-only preview of a historical version with inline diff visualization.
 *
 * The server returns a ProseMirror document with diffInsert/diffDelete marks
 * baked into the content, plus an unmarked `currentDocument`.
 *
 * Toggling highlights SWAPS WHICH DOCUMENT IS RENDERED — it is not a CSS-only
 * switch (the header claimed that until 042, FR-016). `content` is in the
 * useEditor dependency array, so each toggle tears the TipTap editor down and
 * rebuilds it. One consequence is pinned in VersionPreview.characterization.test.jsx:
 * when the server sent no `currentDocument`, "highlights off" falls back to the
 * diff-annotated document, which still renders with diff styling.
 */
function VersionPreview({
  diffData,
  // Preview/diff load failure (feature 041, FR-006). A failed load used to fall
  // through to the "Select a version to preview" placeholder, which claims
  // nothing is selected when something is — and hides the failure entirely.
  diffError = null,
  selection,
  isLoading = false,
  showDiff = true,
}) {
  // Editor extensions (read-only, no collaboration needed)
  const extensions = useMemo(() => [
    ...getBaseExtensions({ openLinksOnClick: true }),
  ], []);

  // Show diff-annotated doc or plain current doc based on toggle
  const content = showDiff
    ? (diffData?.document || null)
    : (diffData?.currentDocument || diffData?.document || null);

  // Initialize editor with document content from server
  const editor = useEditor({
    extensions,
    editable: false,
    content,
  }, [extensions, content]);

  // Check if text is identical (skip diff visualization)
  const textIdentical = diffData?.meta?.textIdentical || false;
  const formattingOnly = diffData?.meta?.formattingOnly || false;
  const diffFailed = diffData?.meta?.diffFailed || false;

  if (isLoading) {
    return (
      <div className="version-preview">
        <div className="version-preview-loading">Loading version...</div>
      </div>
    );
  }

  if (diffError) {
    return (
      <div className="version-preview">
        <div className="version-preview-error" role="alert">
          <p>Couldn't load this version's preview.</p>
          <p className="version-preview-error-detail">{diffError}</p>
          <p className="version-preview-error-detail">Select the version again to retry.</p>
        </div>
      </div>
    );
  }

  // The placeholder means exactly one thing: nothing is selected (FR-006).
  if (!selection) {
    return (
      <div className="version-preview">
        <div className="version-preview-empty">
          <p>Select a version to preview</p>
        </div>
      </div>
    );
  }

  // Selected, no error, no data yet — the load is still in flight (the hook
  // sets isLoadingContent a tick later). Never claim emptiness here.
  if (!diffData) {
    return (
      <div className="version-preview">
        <div className="version-preview-loading">Loading version...</div>
      </div>
    );
  }

  return (
    <div className="version-preview">
      {diffFailed && (
        <div className="version-preview-notice">
          Diff highlighting unavailable for this version
        </div>
      )}
      {textIdentical && !diffFailed && (
        <div className="version-preview-notice">
          {formattingOnly ? 'Formatting changes only' : 'No visible text changes (sync update only)'}
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
              // Feature 045 (FR-004): the synced contribution is not a person.
              // This footer used to render it as one more comma-separated name
              // in an identity colour, so the same entry the list marked as
              // "not a person" read here as a contributor. The rules come from
              // utils/contributors, shared with the list.
              className={author.isSynced
                ? 'version-preview-author version-preview-author-synced'
                : 'version-preview-author'}
              style={author.isSynced ? undefined : { color: contributorColor(author) }}
              title={contributorTitle(author)}
            >
              {author.isSynced && (
                <span className="version-preview-author-dot-synced" aria-hidden="true" />
              )}
              {contributorName(author)}
              {i < selection.authors.length - 1 && ', '}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

export default VersionPreview;
