import React, { useEffect, useState } from 'react';
import { useAuth } from '../contexts/AuthContext';
import CreateSpaceDialog from './CreateSpaceDialog';
import './MoveToSpaceDialog.css';

/**
 * Move a document into a space, out of one, or between two (feature 053, D7).
 *
 * Only spaces where the caller is an editor or an owner are offered, because
 * those are the only valid targets — showing a space you cannot move into would
 * be an invitation to a refusal. "My Docs (personal)" is always offered, since
 * moving out has a weaker rule than moving in.
 *
 * The server's refusal text is surfaced VERBATIM rather than replaced by a
 * generic message: the three reasons a move can be refused (not the document's
 * owner / not an editor of the target / curation may only target personal) are
 * genuinely different, and only the server knows which applies.
 */
function MoveToSpaceDialog({ docId, docTitle, currentSpaceId, isOpen, onClose, onMoved }) {
  const { api } = useAuth();
  const [spaces, setSpaces] = useState([]);
  const [loading, setLoading] = useState(true);
  const [moving, setMoving] = useState(false);
  const [error, setError] = useState(null);
  const [showCreate, setShowCreate] = useState(false);

  useEffect(() => {
    if (!isOpen) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    api.get('/api/spaces')
      .then((res) => {
        if (cancelled) return;
        const all = res.data.spaces || [];
        // Only editor-or-owner memberships are valid move-in targets (FR-011).
        setSpaces(all.filter((s) => s.role === 'editor' || s.role === 'owner'));
      })
      .catch((err) => {
        if (!cancelled) setError(err.response?.data?.error || err.message);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => { cancelled = true; };
  }, [isOpen, docId]);

  const move = async (targetSpaceId) => {
    if (moving) return;
    setMoving(true);
    setError(null);
    try {
      const res = await api.put(`/api/docs/${docId}/space`, { spaceId: targetSpaceId });
      onMoved?.(res.data);
      onClose();
    } catch (err) {
      setError(err.response?.data?.error || err.message);
    } finally {
      setMoving(false);
    }
  };

  if (!isOpen) return null;

  return (
    <div className="move-space-overlay" onClick={onClose}>
      <div className="move-space-dialog" onClick={(e) => e.stopPropagation()}>
        <div className="move-space-header">
          <h2>Move "{docTitle || 'Untitled document'}"</h2>
          <button className="move-space-close" onClick={onClose} aria-label="Close">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        <p className="move-space-hint">
          Everyone in a space can see the documents in it. Direct shares stay exactly as they are.
        </p>

        {error && <div className="move-space-error">{error}</div>}

        {loading ? (
          <div className="move-space-loading">Loading spaces...</div>
        ) : (
          <ul className="move-space-list">
            <li>
              <button
                className={`move-space-option${!currentSpaceId ? ' current' : ''}`}
                onClick={() => move(null)}
                disabled={moving || !currentSpaceId}
              >
                <span className="move-space-name">My Docs (personal)</span>
                {!currentSpaceId && <span className="move-space-current-tag">Current</span>}
              </button>
            </li>
            {spaces.map((space) => (
              <li key={space.id}>
                <button
                  className={`move-space-option${space.id === currentSpaceId ? ' current' : ''}`}
                  onClick={() => move(space.id)}
                  disabled={moving || space.id === currentSpaceId}
                >
                  <span className="move-space-name">{space.name}</span>
                  <span className="move-space-meta">
                    {space.memberCount} {space.memberCount === 1 ? 'member' : 'members'}
                  </span>
                  {space.id === currentSpaceId && <span className="move-space-current-tag">Current</span>}
                </button>
              </li>
            ))}
            {spaces.length === 0 && (
              <li className="move-space-empty">
                You are not an editor or owner of any space yet.
              </li>
            )}
            <li>
              <button
                className="move-space-option move-space-create"
                onClick={() => setShowCreate(true)}
                disabled={moving}
              >
                <span className="move-space-name">+ New space…</span>
              </button>
            </li>
          </ul>
        )}

        {/* Create-then-move: a space created from here is immediately the
            move target — that is what opening this dialog asked for. */}
        <CreateSpaceDialog
          isOpen={showCreate}
          onClose={() => setShowCreate(false)}
          onCreated={(created) => {
            setSpaces((prev) => [...prev, created]);
            move(created.id);
          }}
        />
      </div>
    </div>
  );
}

export default MoveToSpaceDialog;
