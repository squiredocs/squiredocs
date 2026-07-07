import { useCallback, useState, useEffect } from 'react';
import { yUndoPluginKey } from '@tiptap/y-tiptap';
import './MobileActionBar.css';

/**
 * Mobile toolbar - single row with:
 * - Undo/Redo always visible on the left
 * - Indent/Outdent visible when in list context
 * - Format tools scrollable on the right
 */
export default function MobileActionBar({ editor }) {
  const [canUndo, setCanUndo] = useState(false);
  const [canRedo, setCanRedo] = useState(false);
  const [canIndent, setCanIndent] = useState(false);
  const [canOutdent, setCanOutdent] = useState(false);
  const [inListContext, setInListContext] = useState(false);

  // Update button states when editor selection changes
  useEffect(() => {
    if (!editor) return;

    const updateState = () => {
      // Check if indent/outdent commands can be executed
      try {
        const canSink = editor.can().sinkListItem('listItem');
        const canLift = editor.can().liftListItem('listItem');
        setCanIndent(canSink);
        setCanOutdent(canLift);
        // Show indent/outdent buttons when in a list (either action is possible)
        setInListContext(canSink || canLift);
      } catch {
        setCanIndent(false);
        setCanOutdent(false);
        setInListContext(false);
      }

      // Check undo/redo availability from yUndoPlugin
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
    if (editor?.can().sinkListItem('listItem')) {
      editor.chain().focus().sinkListItem('listItem').run();
    }
  }, [editor]);

  const handleOutdent = useCallback(() => {
    if (editor?.can().liftListItem('listItem')) {
      editor.chain().focus().liftListItem('listItem').run();
    }
  }, [editor]);

  // Prevent focus loss when tapping buttons
  const preventFocusLoss = (e) => {
    e.preventDefault();
  };

  if (!editor) {
    return null;
  }

  return (
    <div className="mobile-action-bar" onMouseDown={preventFocusLoss} onTouchStart={preventFocusLoss}>
      {/* Fixed left section: Undo/Redo */}
      <div className="mobile-toolbar-fixed">
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
        {/* Indent/Outdent - only visible when in list context */}
        {inListContext && (
          <>
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
          </>
        )}
        <div className="mobile-action-divider" />
      </div>

      {/* Scrollable format section */}
      <div className="mobile-toolbar-scroll">
        {/* Text formatting */}
        <button
          onClick={() => editor.chain().focus().toggleBold().run()}
          className={`mobile-format-btn ${editor.isActive('bold') ? 'is-active' : ''}`}
          title="Bold"
          aria-label="Bold"
        >
          <strong>B</strong>
        </button>
        <button
          onClick={() => editor.chain().focus().toggleItalic().run()}
          className={`mobile-format-btn ${editor.isActive('italic') ? 'is-active' : ''}`}
          title="Italic"
          aria-label="Italic"
        >
          <em>I</em>
        </button>
        <button
          onClick={() => editor.chain().focus().toggleUnderline().run()}
          className={`mobile-format-btn ${editor.isActive('underline') ? 'is-active' : ''}`}
          title="Underline"
          aria-label="Underline"
        >
          <u>U</u>
        </button>
        <button
          onClick={() => editor.chain().focus().toggleStrike().run()}
          className={`mobile-format-btn ${editor.isActive('strike') ? 'is-active' : ''}`}
          title="Strikethrough"
          aria-label="Strikethrough"
        >
          <s>S</s>
        </button>
        <button
          onClick={() => editor.chain().focus().toggleSubscript().run()}
          className={`mobile-format-btn ${editor.isActive('subscript') ? 'is-active' : ''}`}
          title="Subscript"
          aria-label="Subscript"
        >
          X<sub>2</sub>
        </button>
        <button
          onClick={() => editor.chain().focus().toggleSuperscript().run()}
          className={`mobile-format-btn ${editor.isActive('superscript') ? 'is-active' : ''}`}
          title="Superscript"
          aria-label="Superscript"
        >
          X<sup>2</sup>
        </button>
        <button
          onClick={() => editor.chain().focus().unsetAllMarks().run()}
          className="mobile-format-btn"
          title="Clear formatting"
          aria-label="Clear formatting"
        >
          T<sub>x</sub>
        </button>
        <div className="mobile-action-divider" />
        {/* Headings */}
        <button
          onClick={() => editor.chain().focus().toggleHeading({ level: 1 }).run()}
          className={`mobile-format-btn ${editor.isActive('heading', { level: 1 }) ? 'is-active' : ''}`}
          title="Heading 1"
          aria-label="Heading 1"
        >
          H1
        </button>
        <button
          onClick={() => editor.chain().focus().toggleHeading({ level: 2 }).run()}
          className={`mobile-format-btn ${editor.isActive('heading', { level: 2 }) ? 'is-active' : ''}`}
          title="Heading 2"
          aria-label="Heading 2"
        >
          H2
        </button>
        <button
          onClick={() => editor.chain().focus().toggleHeading({ level: 3 }).run()}
          className={`mobile-format-btn ${editor.isActive('heading', { level: 3 }) ? 'is-active' : ''}`}
          title="Heading 3"
          aria-label="Heading 3"
        >
          H3
        </button>
        <div className="mobile-action-divider" />
        {/* Block elements and lists */}
        <button
          onClick={() => editor.chain().focus().toggleBlockquote().run()}
          className={`mobile-format-btn ${editor.isActive('blockquote') ? 'is-active' : ''}`}
          title="Blockquote"
          aria-label="Blockquote"
        >
          "
        </button>
        <button
          onClick={() => editor.chain().focus().toggleBulletList().run()}
          className={`mobile-format-btn ${editor.isActive('bulletList') ? 'is-active' : ''}`}
          title="Bullet List"
          aria-label="Bullet List"
        >
          •
        </button>
        <button
          onClick={() => editor.chain().focus().toggleOrderedList().run()}
          className={`mobile-format-btn ${editor.isActive('orderedList') ? 'is-active' : ''}`}
          title="Numbered List"
          aria-label="Numbered List"
        >
          1.
        </button>
        <button
          onClick={() => editor.chain().focus().toggleCode().run()}
          className={`mobile-format-btn ${editor.isActive('code') ? 'is-active' : ''}`}
          title="Code"
          aria-label="Code"
        >
          &lt;/&gt;
        </button>
        <button
          onClick={() => {
            const previousUrl = editor.getAttributes('link').href;
            const url = window.prompt('Enter URL:', previousUrl || 'https://');
            if (url === null) return; // Cancelled
            if (url === '') {
              editor.chain().focus().extendMarkRange('link').unsetLink().run();
            } else {
              editor.chain().focus().extendMarkRange('link').setLink({ href: url }).run();
            }
          }}
          className={`mobile-format-btn ${editor.isActive('link') ? 'is-active' : ''}`}
          title="Link"
          aria-label="Link"
        >
          🔗
        </button>
        <button
          onClick={() => editor.chain().focus().insertMermaid().run()}
          className={`mobile-format-btn ${editor.isActive('mermaid') ? 'is-active' : ''}`}
          title="Insert Mermaid diagram"
          aria-label="Insert Mermaid diagram"
        >
          ◇
        </button>
        <button
          onClick={() => editor.chain().focus().insertSvg().run()}
          className={`mobile-format-btn ${editor.isActive('svg') ? 'is-active' : ''}`}
          title="Insert SVG image"
          aria-label="Insert SVG image"
        >
          ⬡
        </button>
      </div>
    </div>
  );
}
