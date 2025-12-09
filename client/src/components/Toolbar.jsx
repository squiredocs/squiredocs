import { useCallback, useState } from 'react';
import './Toolbar.css';
import LinkDialog from './LinkDialog';

export default function Toolbar({ editor }) {
  const [linkDialogOpen, setLinkDialogOpen] = useState(false);
  const [linkDialogText, setLinkDialogText] = useState('');
  const [linkDialogUrl, setLinkDialogUrl] = useState('');

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

    setLinkDialogText(linkText || '');
    setLinkDialogUrl(previousUrl || '');
    setLinkDialogOpen(true);
  }, [editor]);

  const handleLinkSave = useCallback((text, url) => {
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
    setLinkDialogOpen(false);
  }, [editor]);

  const handleLinkCancel = useCallback(() => {
    setLinkDialogOpen(false);
  }, []);

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
      <LinkDialog
        isOpen={linkDialogOpen}
        initialText={linkDialogText}
        initialUrl={linkDialogUrl}
        onSave={handleLinkSave}
        onCancel={handleLinkCancel}
      />
    </div>
  );
}

