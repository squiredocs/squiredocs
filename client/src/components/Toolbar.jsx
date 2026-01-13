import { useCallback, useState, useRef, useEffect } from 'react';
import './Toolbar.css';
import LinkPreview from './LinkPreview';
import FontFamilyDropdown from './FontFamilyDropdown';
import FontSizeControl from './FontSizeControl';
import LineHeightDropdown from './LineHeightDropdown';
import ColorPickerButton from './ColorPickerButton';
import DropdownWrapper from './DropdownWrapper';
import TableMenu from './TableMenu';

export default function Toolbar({ editor }) {
  const [linkPreview, setLinkPreview] = useState(null);
  const editorContainerRef = useRef(null);

  // Find the editor container to get its position
  useEffect(() => {
    if (editor && editor.view && editor.view.dom) {
      const editorElement = editor.view.dom.closest('.editor-container') || editor.view.dom;
      editorContainerRef.current = editorElement;
    }
  }, [editor]);

  const setLink = useCallback(() => {
    const { from, to } = editor.state.selection;
    const selectedText = editor.state.doc.textBetween(from, to, ' ');
    const previousUrl = editor.getAttributes('link').href;
    
    // If there's already a link, get its text
    let linkText = selectedText;
    if (previousUrl && !selectedText) {
      // Try to get the text of the current link
      const { $from } = editor.state.selection;
      const linkMark = editor.getAttributes('link');
      if (linkMark.href) {
        // Find the text content of the link
        const linkNode = $from.node();
        if (linkNode) {
          linkText = linkNode.textContent || '';
        }
      }
    }

    // Get cursor position for LinkPreview
    const { $from } = editor.state.selection;
    const coords = editor.view.coordsAtPos($from.pos);
    
    setLinkPreview({
      href: previousUrl || '',
      text: linkText || '',
      top: coords.bottom + window.scrollY,
      left: coords.left + window.scrollX,
    });
  }, [editor]);

  const handleLinkEdit = useCallback((text, url) => {
    if (!url || url.trim() === '') {
      // Remove link if URL is empty
      editor.chain().focus().extendMarkRange('link').unsetLink().run();
    } else {
      const { from, to } = editor.state.selection;
      const selectedText = editor.state.doc.textBetween(from, to, ' ');
      
      // If there's selected text, replace it with the new link
      if (selectedText || editor.getAttributes('link').href) {
        // If we're editing an existing link or have selection, replace it
        editor
          .chain()
          .focus()
          .extendMarkRange('link')
          .unsetLink()
          .insertContent(`<a href="${url}">${text || url}</a>`)
          .run();
      } else {
        // No selection - insert new link
        editor
          .chain()
          .focus()
          .insertContent(`<a href="${url}">${text || url}</a>`)
          .run();
      }
    }
    setLinkPreview(null);
  }, [editor]);

  const handleLinkClose = useCallback(() => {
    setLinkPreview(null);
  }, []);

  const handleLinkCopy = useCallback(() => {
    if (linkPreview?.href) {
      navigator.clipboard.writeText(linkPreview.href);
    }
    setLinkPreview(null);
  }, [linkPreview]);

  const handleLinkRemove = useCallback(() => {
    editor.chain().focus().extendMarkRange('link').unsetLink().run();
    setLinkPreview(null);
  }, [editor]);

  const handleLinkOpen = useCallback(() => {
    if (linkPreview?.href) {
      window.open(linkPreview.href, '_blank', 'noopener,noreferrer');
    }
    setLinkPreview(null);
  }, [linkPreview]);

  if (!editor) {
    return null;
  }

  return (
    <div className="toolbar">
      <div className="toolbar-group">
        <button
          onClick={() => editor.chain().focus().toggleBold().run()}
          className={`toolbar-button ${editor.isActive('bold') ? 'is-active' : ''}`}
          title="Bold"
        >
          <strong>B</strong>
        </button>
        <button
          onClick={() => editor.chain().focus().toggleItalic().run()}
          className={`toolbar-button ${editor.isActive('italic') ? 'is-active' : ''}`}
          title="Italic"
        >
          <em>I</em>
        </button>
        <button
          onClick={() => editor.chain().focus().toggleUnderline().run()}
          className={`toolbar-button ${editor.isActive('underline') ? 'is-active' : ''}`}
          title="Underline"
        >
          <u>U</u>
        </button>
        <button
          onClick={() => editor.chain().focus().toggleStrike().run()}
          className={`toolbar-button ${editor.isActive('strike') ? 'is-active' : ''}`}
          title="Strikethrough"
        >
          <s>S</s>
        </button>
        <button
          onClick={() => editor.chain().focus().toggleHighlight().run()}
          className={`toolbar-button ${editor.isActive('highlight') ? 'is-active' : ''}`}
          title="Highlight"
        >
          <span style={{ backgroundColor: '#fff3cd', padding: '2px 4px' }}>H</span>
        </button>
        <button
          onClick={() => editor.chain().focus().toggleSubscript().run()}
          className={`toolbar-button ${editor.isActive('subscript') ? 'is-active' : ''}`}
          title="Subscript"
        >
          X<sub>2</sub>
        </button>
        <button
          onClick={() => editor.chain().focus().toggleSuperscript().run()}
          className={`toolbar-button ${editor.isActive('superscript') ? 'is-active' : ''}`}
          title="Superscript"
        >
          X<sup>2</sup>
        </button>
        <button
          onClick={() => editor.chain().focus().unsetAllMarks().run()}
          className="toolbar-button"
          title="Clear formatting"
        >
          T<sub>x</sub>
        </button>
      </div>

      <div className="toolbar-group">
        <FontFamilyDropdown editor={editor} />
        <FontSizeControl editor={editor} />
        <LineHeightDropdown editor={editor} />
      </div>

      <div className="toolbar-group toolbar-color-group">
        <ColorPickerButton editor={editor} type="text" />
        <ColorPickerButton editor={editor} type="background" />
      </div>

      <div className="toolbar-group">
        <button
          onClick={() => editor.chain().focus().toggleHeading({ level: 1 }).run()}
          className={`toolbar-button ${editor.isActive('heading', { level: 1 }) ? 'is-active' : ''}`}
          title="Heading 1"
        >
          H1
        </button>
        <button
          onClick={() => editor.chain().focus().toggleHeading({ level: 2 }).run()}
          className={`toolbar-button ${editor.isActive('heading', { level: 2 }) ? 'is-active' : ''}`}
          title="Heading 2"
        >
          H2
        </button>
        <button
          onClick={() => editor.chain().focus().toggleHeading({ level: 3 }).run()}
          className={`toolbar-button ${editor.isActive('heading', { level: 3 }) ? 'is-active' : ''}`}
          title="Heading 3"
        >
          H3
        </button>
      </div>

      <div className="toolbar-group">
        <button
          onClick={() => editor.chain().focus().toggleBlockquote().run()}
          className={`toolbar-button ${editor.isActive('blockquote') ? 'is-active' : ''}`}
          title="Blockquote"
        >
          "
        </button>
        <button
          onClick={() => editor.chain().focus().toggleBulletList().run()}
          className={`toolbar-button ${editor.isActive('bulletList') ? 'is-active' : ''}`}
          title="Bullet List"
        >
          •
        </button>
        <button
          onClick={() => editor.chain().focus().toggleOrderedList().run()}
          className={`toolbar-button ${editor.isActive('orderedList') ? 'is-active' : ''}`}
          title="Numbered List"
        >
          1.
        </button>
        <button
          onClick={() => editor.chain().focus().toggleCode().run()}
          className={`toolbar-button ${editor.isActive('code') ? 'is-active' : ''}`}
          title="Code"
        >
          &lt;/&gt;
        </button>
        <button
          onClick={setLink}
          className={`toolbar-button ${editor.isActive('link') ? 'is-active' : ''}`}
          title="Link"
        >
          🔗
        </button>
      </div>

      <div className="toolbar-group">
        <DropdownWrapper
          trigger={() => (
            <button
              className="toolbar-button"
              title="Insert Table"
            >
              ⊞
            </button>
          )}
        >
          {(close) => (
            <TableMenu
              editor={editor}
              onClose={close}
            />
          )}
        </DropdownWrapper>
      </div>

      {editor.isActive('table') && (
        <div className="toolbar-group toolbar-table-controls">
          <button
            onClick={() => editor.chain().focus().addColumnBefore().run()}
            className="toolbar-button toolbar-button-small"
            title="Add column before"
          >
            ← Col
          </button>
          <button
            onClick={() => editor.chain().focus().addColumnAfter().run()}
            className="toolbar-button toolbar-button-small"
            title="Add column after"
          >
            Col →
          </button>
          <button
            onClick={() => editor.chain().focus().deleteColumn().run()}
            className="toolbar-button toolbar-button-small"
            title="Delete column"
          >
            ✕ Col
          </button>
          <button
            onClick={() => editor.chain().focus().addRowBefore().run()}
            className="toolbar-button toolbar-button-small"
            title="Add row before"
          >
            ↑ Row
          </button>
          <button
            onClick={() => editor.chain().focus().addRowAfter().run()}
            className="toolbar-button toolbar-button-small"
            title="Add row after"
          >
            Row ↓
          </button>
          <button
            onClick={() => editor.chain().focus().deleteRow().run()}
            className="toolbar-button toolbar-button-small"
            title="Delete row"
          >
            ✕ Row
          </button>
          <button
            onClick={() => editor.chain().focus().deleteTable().run()}
            className="toolbar-button toolbar-button-small"
            title="Delete table"
          >
            ✕ Table
          </button>
        </div>
      )}

      {linkPreview && (
        <LinkPreview
          href={linkPreview.href}
          text={linkPreview.text}
          top={linkPreview.top}
          left={linkPreview.left}
          onCopy={handleLinkCopy}
          onEdit={handleLinkEdit}
          onRemove={handleLinkRemove}
          onOpen={handleLinkOpen}
          onClose={handleLinkClose}
        />
      )}
    </div>
  );
}

