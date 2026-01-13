import { useCallback, useState, useEffect } from 'react';
import { yUndoPluginKey } from '@tiptap/y-tiptap';
import './MobileActionBar.css';

export default function MobileActionBar({ editor }) {
  const [canUndo, setCanUndo] = useState(false);
  const [canRedo, setCanRedo] = useState(false);
  const [canIndent, setCanIndent] = useState(false);
  const [canOutdent, setCanOutdent] = useState(false);
  const [formatMenuOpen, setFormatMenuOpen] = useState(false);

  // Update button states when editor selection changes
  useEffect(() => {
    if (!editor) return;

    const updateState = () => {
      // Check if indent/outdent commands can be executed
      // sinkListItem only works if there's a previous sibling to nest under
      // liftListItem only works if the item is nested (not at top level of list)
      try {
        setCanIndent(editor.can().sinkListItem('listItem'));
        setCanOutdent(editor.can().liftListItem('listItem'));
      } catch {
        setCanIndent(false);
        setCanOutdent(false);
      }

      // Check undo/redo availability from yUndoPlugin (added by Collaboration extension)
      try {
        const undoPluginState = yUndoPluginKey.getState(editor.state);
        if (undoPluginState?.undoManager) {
          setCanUndo(undoPluginState.undoManager.undoStack.length > 0);
          setCanRedo(undoPluginState.undoManager.redoStack.length > 0);
        }
      } catch {
        // Plugin may not be ready yet
      }
    };

    // Update on selection and transaction changes
    editor.on('selectionUpdate', updateState);
    editor.on('transaction', updateState);
    updateState();

    return () => {
      editor.off('selectionUpdate', updateState);
      editor.off('transaction', updateState);
    };
  }, [editor]);

  const handleUndo = useCallback(() => {
    editor?.commands.undo();
  }, [editor]);

  const handleRedo = useCallback(() => {
    editor?.commands.redo();
  }, [editor]);

  const handleIndent = useCallback(() => {
    // sinkListItem moves the current item into a nested list under the previous sibling
    // This only works if there's a previous sibling item
    if (editor?.can().sinkListItem('listItem')) {
      editor.chain().focus().sinkListItem('listItem').run();
    }
  }, [editor]);

  const handleOutdent = useCallback(() => {
    // liftListItem moves the item up one nesting level
    // At top level, this will remove it from the list - check if we can lift first
    if (editor?.can().liftListItem('listItem')) {
      editor.chain().focus().liftListItem('listItem').run();
    }
  }, [editor]);

  if (!editor) {
    return null;
  }

  return (
    <div className="mobile-action-bar">
      <button
        onClick={handleUndo}
        className="mobile-action-button"
        disabled={!canUndo}
        title="Undo"
        aria-label="Undo"
      >
        <svg viewBox="0 0 24 24" fill="currentColor" width="20" height="20">
          <path d="M12.5 8c-2.65 0-5.05.99-6.9 2.6L2 7v9h9l-3.62-3.62c1.39-1.16 3.16-1.88 5.12-1.88 3.54 0 6.55 2.31 7.6 5.5l2.37-.78C21.08 11.03 17.15 8 12.5 8z"/>
        </svg>
      </button>
      <button
        onClick={handleRedo}
        className="mobile-action-button"
        disabled={!canRedo}
        title="Redo"
        aria-label="Redo"
      >
        <svg viewBox="0 0 24 24" fill="currentColor" width="20" height="20">
          <path d="M18.4 10.6C16.55 8.99 14.15 8 11.5 8c-4.65 0-8.58 3.03-9.96 7.22L3.9 16c1.05-3.19 4.05-5.5 7.6-5.5 1.95 0 3.73.72 5.12 1.88L13 16h9V7l-3.6 3.6z"/>
        </svg>
      </button>
      <div className="mobile-action-divider" />
      <button
        onClick={handleOutdent}
        className="mobile-action-button"
        disabled={!canOutdent}
        title="Decrease indent"
        aria-label="Decrease indent"
      >
        <svg viewBox="0 0 24 24" fill="currentColor" width="20" height="20">
          <path d="M11 17h10v-2H11v2zm-8-5l4 4V8l-4 4zm0 9h18v-2H3v2zM3 3v2h18V3H3zm8 6h10V7H11v2zm0 4h10v-2H11v2z"/>
        </svg>
      </button>
      <button
        onClick={handleIndent}
        className="mobile-action-button"
        disabled={!canIndent}
        title="Increase indent"
        aria-label="Increase indent"
      >
        <svg viewBox="0 0 24 24" fill="currentColor" width="20" height="20">
          <path d="M3 21h18v-2H3v2zM3 8v8l4-4-4-4zm8 9h10v-2H11v2zM3 3v2h18V3H3zm8 6h10V7H11v2zm0 4h10v-2H11v2z"/>
        </svg>
      </button>
      <div className="mobile-action-divider" />
      <button
        onClick={() => setFormatMenuOpen(!formatMenuOpen)}
        className={`mobile-action-button ${formatMenuOpen ? 'active' : ''}`}
        title="Format"
        aria-label="Format menu"
      >
        <strong>A</strong>
      </button>

      {formatMenuOpen && (
        <div className="mobile-format-menu">
          <div className="mobile-format-row">
            <button
              onClick={() => editor.chain().focus().toggleBold().run()}
              className={`mobile-format-button ${editor.isActive('bold') ? 'active' : ''}`}
            >
              <strong>B</strong>
            </button>
            <button
              onClick={() => editor.chain().focus().toggleItalic().run()}
              className={`mobile-format-button ${editor.isActive('italic') ? 'active' : ''}`}
            >
              <em>I</em>
            </button>
            <button
              onClick={() => editor.chain().focus().toggleUnderline().run()}
              className={`mobile-format-button ${editor.isActive('underline') ? 'active' : ''}`}
            >
              <u>U</u>
            </button>
            <button
              onClick={() => editor.chain().focus().toggleStrike().run()}
              className={`mobile-format-button ${editor.isActive('strike') ? 'active' : ''}`}
            >
              <s>S</s>
            </button>
            <button
              onClick={() => editor.chain().focus().toggleHighlight().run()}
              className={`mobile-format-button ${editor.isActive('highlight') ? 'active' : ''}`}
            >
              <span style={{ backgroundColor: '#fff3cd', padding: '2px' }}>H</span>
            </button>
          </div>
          <div className="mobile-format-row">
            <button
              onClick={() => editor.chain().focus().toggleHeading({ level: 1 }).run()}
              className={`mobile-format-button ${editor.isActive('heading', { level: 1 }) ? 'active' : ''}`}
            >
              H1
            </button>
            <button
              onClick={() => editor.chain().focus().toggleHeading({ level: 2 }).run()}
              className={`mobile-format-button ${editor.isActive('heading', { level: 2 }) ? 'active' : ''}`}
            >
              H2
            </button>
            <button
              onClick={() => editor.chain().focus().toggleHeading({ level: 3 }).run()}
              className={`mobile-format-button ${editor.isActive('heading', { level: 3 }) ? 'active' : ''}`}
            >
              H3
            </button>
            <button
              onClick={() => editor.chain().focus().toggleBlockquote().run()}
              className={`mobile-format-button ${editor.isActive('blockquote') ? 'active' : ''}`}
            >
              "
            </button>
          </div>
          <div className="mobile-format-row">
            <button
              onClick={() => editor.chain().focus().toggleBulletList().run()}
              className={`mobile-format-button ${editor.isActive('bulletList') ? 'active' : ''}`}
            >
              •
            </button>
            <button
              onClick={() => editor.chain().focus().toggleOrderedList().run()}
              className={`mobile-format-button ${editor.isActive('orderedList') ? 'active' : ''}`}
            >
              1.
            </button>
            <button
              onClick={() => editor.chain().focus().toggleCode().run()}
              className={`mobile-format-button ${editor.isActive('code') ? 'active' : ''}`}
            >
              &lt;/&gt;
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
