import { useEffect, useRef, useState } from 'react';
import './LinkPreview.css';

export default function LinkPreview({ href, text, top, left, onCopy, onEdit, onRemove, onOpen, onClose }) {
  const ref = useRef(null);
  // Start in edit mode if href is empty (creating new link)
  const [isEditing, setIsEditing] = useState(!href || href.trim() === '');
  const [editText, setEditText] = useState(text || '');
  const [editUrl, setEditUrl] = useState(href || '');

  // Sync edit state with props when not editing
  useEffect(() => {
    if (!isEditing) {
      setEditText(text);
      setEditUrl(href);
    }
  }, [text, href, isEditing]);

  // Close when clicking outside
  useEffect(() => {
    const handleClickOutside = (event) => {
      if (ref.current && !ref.current.contains(event.target)) {
        onClose();
      }
    };

    // Delay adding listener to avoid immediate close from the click that opened it
    const timer = setTimeout(() => {
      document.addEventListener('mousedown', handleClickOutside);
    }, 0);

    return () => {
      clearTimeout(timer);
      document.removeEventListener('mousedown', handleClickOutside);
    };
  }, [onClose]);

  // Close on escape
  useEffect(() => {
    const handleKeyDown = (event) => {
      if (event.key === 'Escape') {
        if (isEditing) {
          // Always close when in edit mode and escape is pressed
          onClose();
        } else {
          onClose();
        }
      }
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [onClose, isEditing]);

  // Get favicon URL
  const getFaviconUrl = (url) => {
    try {
      const urlObj = new URL(url);
      return `https://www.google.com/s2/favicons?domain=${urlObj.hostname}&sz=32`;
    } catch {
      return null;
    }
  };

  const faviconUrl = getFaviconUrl(href);

  const handleSave = () => {
    if (editUrl.trim()) {
      onEdit(editText, editUrl);
    }
  };

  if (isEditing) {
    return (
      <div
        ref={ref}
        className="link-preview link-preview--editing"
        style={{ top, left }}
      >
        <div className="link-edit-form">
          <label className="link-edit-label">
            Text
            <input
              type="text"
              value={editText}
              onChange={(e) => setEditText(e.target.value)}
              className="link-edit-input"
              autoFocus
            />
          </label>
          <label className="link-edit-label">
            URL
            <input
              type="text"
              value={editUrl}
              onChange={(e) => setEditUrl(e.target.value)}
              className="link-edit-input"
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  handleSave();
                }
              }}
            />
          </label>
        </div>
        <div className="link-edit-actions">
          <button 
            type="button"
            onClick={onClose}
            className="link-edit-btn link-edit-btn--cancel"
          >
            Cancel
          </button>
          <button 
            type="button"
            onClick={handleSave} 
            className="link-edit-btn link-edit-btn--save"
            disabled={!editUrl.trim()}
          >
            Apply
          </button>
        </div>
      </div>
    );
  }

  return (
    <div
      ref={ref}
      className="link-preview"
      style={{ top, left }}
    >
      {faviconUrl && (
        <img src={faviconUrl} alt="" className="link-preview-favicon" />
      )}
      <a
        href={href}
        className="link-preview-url"
        onClick={(e) => {
          e.preventDefault();
          onOpen();
        }}
        title={href}
      >
        {href}
      </a>
      <div className="link-preview-actions">
        <button onClick={onCopy} title="Copy link" className="link-preview-btn">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <rect x="9" y="9" width="13" height="13" rx="2" ry="2"/>
            <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>
          </svg>
        </button>
        <button onClick={() => setIsEditing(true)} title="Edit link" className="link-preview-btn">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/>
            <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/>
          </svg>
        </button>
        <button onClick={onRemove} title="Remove link" className="link-preview-btn">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M15 7h3a5 5 0 0 1 0 10h-3m-6 0H6a5 5 0 0 1 0-10h3"/>
            <line x1="8" y1="12" x2="16" y2="12"/>
            <line x1="4" y1="4" x2="20" y2="20"/>
          </svg>
        </button>
      </div>
    </div>
  );
}
