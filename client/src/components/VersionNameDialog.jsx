import React, { useState, useEffect, useRef } from 'react';
import './VersionHistoryPanel.css';

/**
 * Styled in-app text-input dialog for naming / renaming a version (024/US2).
 * Replaces window.prompt. Follows the app's ShareDialog overlay conventions:
 * backdrop click and Escape dismiss, inner card stops propagation.
 *
 * Props: { isOpen, mode: 'name'|'rename', initialValue, onConfirm(trimmedName),
 *          onCancel, busy, error }
 */
function VersionNameDialog({ isOpen, mode = 'name', initialValue = '', onConfirm, onCancel, busy = false, error = null }) {
  const [value, setValue] = useState(initialValue);
  const inputRef = useRef(null);
  const isRename = mode === 'rename';

  // Reset the field whenever the dialog (re)opens and focus/select for quick edit.
  useEffect(() => {
    if (isOpen) {
      setValue(initialValue || '');
      // Focus after the input has mounted; select existing text for rename.
      requestAnimationFrame(() => {
        const el = inputRef.current;
        if (el) {
          el.focus();
          if (isRename) el.select();
        }
      });
    }
  }, [isOpen, initialValue, isRename]);

  if (!isOpen) return null;

  const trimmed = value.trim();
  const canConfirm = trimmed.length > 0 && !busy;

  const submit = (e) => {
    if (e) e.preventDefault();
    if (!canConfirm) return;
    onConfirm(trimmed);
  };

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
      <form
        className="version-dialog"
        onClick={(e) => e.stopPropagation()}
        onSubmit={submit}
      >
        <h3>{isRename ? 'Rename version' : 'Name this version'}</h3>
        <input
          ref={inputRef}
          type="text"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          disabled={busy}
          placeholder="Version name"
          aria-label={isRename ? 'Rename version' : 'Name this version'}
        />
        {error && <div className="version-dialog-error" role="alert">{error}</div>}
        <div className="version-dialog-actions">
          <button type="button" onClick={onCancel} disabled={busy}>
            Cancel
          </button>
          <button type="submit" disabled={!canConfirm}>
            {busy ? 'Saving…' : 'Save'}
          </button>
        </div>
      </form>
    </div>
  );
}

export default VersionNameDialog;
