import React from 'react';
import './VersionHistoryPanel.css';

/**
 * Styled in-app confirmation dialog for restore / remove-name (024/US2).
 * Replaces window.confirm. Only an explicit confirm performs the action;
 * backdrop click, Escape, and Cancel dismiss without side effects.
 *
 * Props: { isOpen, title, message, confirmLabel, onConfirm, onCancel, busy, error }
 */
function VersionConfirmDialog({ isOpen, title, message, confirmLabel = 'Confirm', onConfirm, onCancel, busy = false, error = null }) {
  if (!isOpen) return null;

  const handleKeyDown = (e) => {
    if (e.key === 'Escape' && !busy) {
      e.preventDefault();
      onCancel();
    }
  };

  return (
    <div
      className="version-dialog-overlay"
      onClick={() => { if (!busy) onCancel(); }}
      onKeyDown={handleKeyDown}
    >
      <div
        className="version-dialog"
        onClick={(e) => e.stopPropagation()}
        role="alertdialog"
        aria-label={title}
      >
        {title && <h3>{title}</h3>}
        {message && <p className="version-dialog-message">{message}</p>}
        {error && <div className="version-dialog-error" role="alert">{error}</div>}
        <div className="version-dialog-actions">
          <button type="button" onClick={onCancel} disabled={busy}>
            Cancel
          </button>
          <button type="button" onClick={onConfirm} disabled={busy}>
            {busy ? 'Working…' : confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}

export default VersionConfirmDialog;
