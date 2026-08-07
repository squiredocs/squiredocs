import React, { useEffect, useRef, useState } from 'react';
import { useAuth } from '../contexts/AuthContext';
import './CreateSpaceDialog.css';

/**
 * Create a space (feature 053). Opened from the document list's space scope
 * selector — the entry point the rest of the spaces UI assumes exists (the
 * move dialog's empty state points here).
 *
 * On success the caller receives the created space (server shape: role
 * 'owner', memberCount 1) and decides where to go next; the DocList navigates
 * to the new space's settings page, where inviting members lives.
 */
function CreateSpaceDialog({ isOpen, onClose, onCreated }) {
  const { api } = useAuth();
  const [name, setName] = useState('');
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState(null);
  const inputRef = useRef(null);

  useEffect(() => {
    if (isOpen) {
      setName('');
      setError(null);
      // Focus after the dialog paints.
      requestAnimationFrame(() => inputRef.current?.focus());
    }
  }, [isOpen]);

  const create = async (e) => {
    e?.preventDefault();
    const trimmed = name.trim();
    if (!trimmed || creating) return;
    setCreating(true);
    setError(null);
    try {
      const res = await api.post('/api/spaces', { name: trimmed });
      onCreated?.(res.data.space);
      onClose();
    } catch (err) {
      // Surface the server's refusal verbatim (name rules live server-side).
      setError(err.response?.data?.error || err.message);
    } finally {
      setCreating(false);
    }
  };

  if (!isOpen) return null;

  return (
    <div className="create-space-overlay" onClick={onClose}>
      <div className="create-space-dialog" onClick={(e) => e.stopPropagation()}>
        <div className="create-space-header">
          <h2>New space</h2>
          <button className="create-space-close" onClick={onClose} aria-label="Close">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        <form className="create-space-body" onSubmit={create}>
          <p className="create-space-hint">
            A space is a shared home for documents. Invite teammates at a role and
            every document you move in is theirs to work on at that role.
          </p>

          {error && <div className="create-space-error">{error}</div>}

          <label className="create-space-label" htmlFor="create-space-name">Name</label>
          <input
            id="create-space-name"
            ref={inputRef}
            type="text"
            maxLength={100}
            placeholder="e.g. Platform Team"
            value={name}
            onChange={(e) => setName(e.target.value)}
            disabled={creating}
          />

          <div className="create-space-actions">
            <button type="button" className="create-space-cancel" onClick={onClose} disabled={creating}>
              Cancel
            </button>
            <button type="submit" className="create-space-submit" disabled={creating || !name.trim()}>
              {creating ? 'Creating...' : 'Create space'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

export default CreateSpaceDialog;
