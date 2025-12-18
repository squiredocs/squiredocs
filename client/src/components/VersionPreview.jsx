import React, { useEffect, useMemo } from 'react';
import { useEditor, EditorContent } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import Underline from '@tiptap/extension-underline';
import Link from '@tiptap/extension-link';
import Collaboration from '@tiptap/extension-collaboration';
import * as Y from 'yjs';
import './EditorCommon.css';
import './VersionPreview.css';

/**
 * Read-only preview of a historical version
 */
function VersionPreview({
  versionContent,
  selectedVersion,
  isLoading = false,
}) {

  // Create a temporary Y.Doc for the version content
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

  // Editor extensions (read-only, no collaboration cursors)
  // Always include base extensions to ensure valid schema
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

    // Add collaboration extension when we have a ydoc
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
      <div className="version-preview">
        <div className="version-preview-loading">Loading version...</div>
      </div>
    );
  }

  if (!versionContent || !selectedVersion) {
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
      <div className="editor-common-container version-preview-content">
        {editor ? (
          <EditorContent editor={editor} className="editor-common-content" />
        ) : (
          <div className="version-preview-loading">Loading version...</div>
        )}
      </div>

      {selectedVersion.authors && selectedVersion.authors.length > 0 && (
        <div className="version-preview-authors">
          <span className="version-preview-authors-label">Contributors:</span>
          {selectedVersion.authors.map((author, i) => (
            <span
              key={author.id || i}
              className="version-preview-author"
              style={{ color: author.color }}
            >
              {author.name || 'Unknown'}
              {i < selectedVersion.authors.length - 1 && ', '}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

export default VersionPreview;
