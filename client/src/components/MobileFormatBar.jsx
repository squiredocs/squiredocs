import './MobileFormatBar.css';

/**
 * Simplified toolbar for mobile keyboard format bar.
 * Only includes basic formatting buttons - no dropdowns or complex controls.
 */
export default function MobileFormatBar({ editor }) {
  if (!editor) {
    return null;
  }

  // Prevent focus loss when tapping buttons
  const preventFocusLoss = (e) => {
    e.preventDefault();
  };

  return (
    <div className="mobile-format-bar-buttons" onMouseDown={preventFocusLoss} onTouchStart={preventFocusLoss}>
      <button
        onClick={() => editor.chain().focus().toggleBold().run()}
        className={`mobile-format-btn ${editor.isActive('bold') ? 'is-active' : ''}`}
        title="Bold"
      >
        <strong>B</strong>
      </button>
      <button
        onClick={() => editor.chain().focus().toggleItalic().run()}
        className={`mobile-format-btn ${editor.isActive('italic') ? 'is-active' : ''}`}
        title="Italic"
      >
        <em>I</em>
      </button>
      <button
        onClick={() => editor.chain().focus().toggleUnderline().run()}
        className={`mobile-format-btn ${editor.isActive('underline') ? 'is-active' : ''}`}
        title="Underline"
      >
        <u>U</u>
      </button>
      <button
        onClick={() => editor.chain().focus().toggleStrike().run()}
        className={`mobile-format-btn ${editor.isActive('strike') ? 'is-active' : ''}`}
        title="Strikethrough"
      >
        <s>S</s>
      </button>

      <div className="mobile-format-divider" />

      <button
        onClick={() => editor.chain().focus().toggleHeading({ level: 1 }).run()}
        className={`mobile-format-btn ${editor.isActive('heading', { level: 1 }) ? 'is-active' : ''}`}
        title="Heading 1"
      >
        H1
      </button>
      <button
        onClick={() => editor.chain().focus().toggleHeading({ level: 2 }).run()}
        className={`mobile-format-btn ${editor.isActive('heading', { level: 2 }) ? 'is-active' : ''}`}
        title="Heading 2"
      >
        H2
      </button>

      <div className="mobile-format-divider" />

      <button
        onClick={() => editor.chain().focus().toggleBulletList().run()}
        className={`mobile-format-btn ${editor.isActive('bulletList') ? 'is-active' : ''}`}
        title="Bullet List"
      >
        •
      </button>
      <button
        onClick={() => editor.chain().focus().toggleOrderedList().run()}
        className={`mobile-format-btn ${editor.isActive('orderedList') ? 'is-active' : ''}`}
        title="Numbered List"
      >
        1.
      </button>

      <div className="mobile-format-divider" />

      <button
        onClick={() => editor.chain().focus().unsetAllMarks().run()}
        className="mobile-format-btn"
        title="Clear formatting"
      >
        T<sub>x</sub>
      </button>
    </div>
  );
}
