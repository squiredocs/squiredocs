import { useState, useEffect, useRef } from 'react';
import './LinkDialog.css';

export default function LinkDialog({ 
  initialText = '', 
  initialUrl = '', 
  onSave, 
  onCancel,
  isOpen 
}) {
  const [text, setText] = useState(initialText);
  const [url, setUrl] = useState(initialUrl);
  const textInputRef = useRef(null);
  const urlInputRef = useRef(null);

  // Update state when props change
  useEffect(() => {
    if (isOpen) {
      setText(initialText);
      setUrl(initialUrl);
      // Focus text input when dialog opens
      setTimeout(() => {
        if (textInputRef.current) {
          textInputRef.current.focus();
          textInputRef.current.select();
        }
      }, 0);
    }
  }, [isOpen, initialText, initialUrl]);

  // Handle escape key
  useEffect(() => {
    if (!isOpen) return;

    const handleKeyDown = (event) => {
      if (event.key === 'Escape') {
        onCancel();
      } else if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
        handleSave();
      }
    };

    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, onCancel]);

  const handleSave = () => {
    if (url.trim()) {
      onSave(text.trim() || url.trim(), url.trim());
    }
  };

  if (!isOpen) {
    return null;
  }

  return (
    <div className="link-dialog-overlay" onClick={onCancel}>
      <div className="link-dialog" onClick={(e) => e.stopPropagation()}>
        <div className="link-dialog-header">
          <h3>Edit Link</h3>
        </div>
        <div className="link-dialog-form">
          <label className="link-dialog-label">
            Link Text
            <input
              ref={textInputRef}
              type="text"
              value={text}
              onChange={(e) => setText(e.target.value)}
              className="link-dialog-input"
              placeholder="Enter link text"
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault();
                  urlInputRef.current?.focus();
                }
              }}
            />
          </label>
          <label className="link-dialog-label">
            URL
            <input
              ref={urlInputRef}
              type="text"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              className="link-dialog-input"
              placeholder="https://example.com"
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  handleSave();
                }
              }}
            />
          </label>
        </div>
        <div className="link-dialog-actions">
          <button 
            onClick={onCancel} 
            className="link-dialog-btn link-dialog-btn--cancel"
          >
            Cancel
          </button>
          <button 
            onClick={handleSave} 
            className="link-dialog-btn link-dialog-btn--save"
            disabled={!url.trim()}
          >
            Save
          </button>
        </div>
      </div>
    </div>
  );
}
