import { useEffect, useRef } from 'react';
import './TableContextMenu.css';

export default function TableContextMenu({ editor, position, onClose }) {
  const menuRef = useRef(null);

  // Close on click outside
  useEffect(() => {
    const handleClickOutside = (e) => {
      if (menuRef.current && !menuRef.current.contains(e.target)) {
        onClose();
      }
    };

    const handleEscape = (e) => {
      if (e.key === 'Escape') {
        onClose();
      }
    };

    document.addEventListener('mousedown', handleClickOutside);
    document.addEventListener('keydown', handleEscape);

    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
      document.removeEventListener('keydown', handleEscape);
    };
  }, [onClose]);

  const handleAction = (action) => {
    action();
    onClose();
  };

  // Adjust position to keep menu in viewport
  const adjustedPosition = { ...position };
  if (menuRef.current) {
    const rect = menuRef.current.getBoundingClientRect();
    if (position.x + rect.width > window.innerWidth) {
      adjustedPosition.x = window.innerWidth - rect.width - 8;
    }
    if (position.y + rect.height > window.innerHeight) {
      adjustedPosition.y = window.innerHeight - rect.height - 8;
    }
  }

  return (
    <div
      ref={menuRef}
      className="table-context-menu"
      style={{ top: adjustedPosition.y, left: adjustedPosition.x }}
    >
      <button
        className="table-context-menu-item"
        onClick={() => handleAction(() => editor.chain().focus().addRowBefore().run())}
      >
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <line x1="12" y1="5" x2="12" y2="19" />
          <line x1="5" y1="12" x2="19" y2="12" />
        </svg>
        Insert row above
      </button>
      <button
        className="table-context-menu-item"
        onClick={() => handleAction(() => editor.chain().focus().addRowAfter().run())}
      >
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <line x1="12" y1="5" x2="12" y2="19" />
          <line x1="5" y1="12" x2="19" y2="12" />
        </svg>
        Insert row below
      </button>
      <button
        className="table-context-menu-item"
        onClick={() => handleAction(() => editor.chain().focus().addColumnBefore().run())}
      >
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <line x1="12" y1="5" x2="12" y2="19" />
          <line x1="5" y1="12" x2="19" y2="12" />
        </svg>
        Insert column left
      </button>
      <button
        className="table-context-menu-item"
        onClick={() => handleAction(() => editor.chain().focus().addColumnAfter().run())}
      >
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <line x1="12" y1="5" x2="12" y2="19" />
          <line x1="5" y1="12" x2="19" y2="12" />
        </svg>
        Insert column right
      </button>

      <div className="table-context-menu-divider" />

      <button
        className="table-context-menu-item danger"
        onClick={() => handleAction(() => editor.chain().focus().deleteRow().run())}
      >
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <path d="M3 6h18M8 6V4a2 2 0 012-2h4a2 2 0 012 2v2m3 0v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6h14z" />
        </svg>
        Delete row
      </button>
      <button
        className="table-context-menu-item danger"
        onClick={() => handleAction(() => editor.chain().focus().deleteColumn().run())}
      >
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <path d="M3 6h18M8 6V4a2 2 0 012-2h4a2 2 0 012 2v2m3 0v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6h14z" />
        </svg>
        Delete column
      </button>
      <button
        className="table-context-menu-item danger"
        onClick={() => handleAction(() => editor.chain().focus().deleteTable().run())}
      >
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <path d="M3 6h18M8 6V4a2 2 0 012-2h4a2 2 0 012 2v2m3 0v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6h14z" />
        </svg>
        Delete table
      </button>
    </div>
  );
}
