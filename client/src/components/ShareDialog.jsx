import React, { useState, useEffect, useRef } from 'react';
import { useAuth } from '../contexts/AuthContext';
import { useMobile } from '../hooks/useMobile';
import { useVisualViewport } from '../hooks/useVisualViewport';
import Avatar from './Avatar';
import './ShareDialog.css';

/** The "✕" glyph used by the dialog close button and the remove/cancel buttons. */
function XIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <path d="M6 18L18 6M6 6l12 12" />
    </svg>
  );
}

function ShareDialog({ docId, docTitle, isOpen, onClose }) {
  const { api, user: currentUser } = useAuth();
  const isMobile = useMobile();
  const viewport = useVisualViewport();
  const [email, setEmail] = useState('');
  const [shareRole, setShareRole] = useState('editor');
  const [users, setUsers] = useState([]);
  const [invites, setInvites] = useState([]);
  const [loading, setLoading] = useState(false);
  const [usersLoading, setUsersLoading] = useState(true);
  const [error, setError] = useState(null);
  const [success, setSuccess] = useState(null);
  const [currentUserRole, setCurrentUserRole] = useState(null);

  // Autocomplete state
  const [suggestions, setSuggestions] = useState([]);
  const [showSuggestions, setShowSuggestions] = useState(false);
  const [highlightIndex, setHighlightIndex] = useState(-1);
  // Set when the user picks a suggestion so the debounced search doesn't reopen.
  const skipSearchRef = useRef(false);

  // Fetch current users when dialog opens
  useEffect(() => {
    if (isOpen && docId) {
      fetchUsers();
    }
  }, [isOpen, docId]);

  // Reset state when dialog closes or role changes
  useEffect(() => {
    if (!isOpen) {
      setEmail('');
      setError(null);
      setSuccess(null);
      setSuggestions([]);
      setShowSuggestions(false);
      setHighlightIndex(-1);
    }
  }, [isOpen]);

  // Set default share role based on current user's role
  useEffect(() => {
    if (currentUserRole === 'viewer') {
      setShareRole('viewer');
    } else {
      setShareRole('editor');
    }
  }, [currentUserRole]);

  // Debounced autocomplete search as the user types
  useEffect(() => {
    if (skipSearchRef.current) {
      skipSearchRef.current = false;
      return;
    }
    const q = email.trim();
    if (q.length < 2) {
      setSuggestions([]);
      setShowSuggestions(false);
      return;
    }
    const timer = setTimeout(async () => {
      try {
        const response = await api.get('/api/users/search', { params: { q, docId } });
        setSuggestions(response.data.users || []);
        setShowSuggestions(true);
        setHighlightIndex(-1);
      } catch (err) {
        console.error('Error searching users:', err);
        setSuggestions([]);
      }
    }, 200);
    return () => clearTimeout(timer);
  }, [email, docId]);

  const fetchUsers = async () => {
    try {
      setUsersLoading(true);
      const response = await api.get(`/api/docs/${docId}/shares`);
      setUsers(response.data.users || []);
      setInvites(response.data.invites || []);
      setCurrentUserRole(response.data.currentUserRole);
    } catch (err) {
      console.error('Error fetching users:', err);
      if (err.response?.status !== 403) {
        setError('Failed to load users');
      }
    } finally {
      setUsersLoading(false);
    }
  };

  const selectSuggestion = (suggestion) => {
    skipSearchRef.current = true;
    setEmail(suggestion.email);
    setSuggestions([]);
    setShowSuggestions(false);
    setHighlightIndex(-1);
  };

  const handleEmailKeyDown = (e) => {
    if (!showSuggestions || suggestions.length === 0) return;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setHighlightIndex((i) => Math.min(i + 1, suggestions.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setHighlightIndex((i) => Math.max(i - 1, 0));
    } else if (e.key === 'Enter' && highlightIndex >= 0) {
      e.preventDefault();
      selectSuggestion(suggestions[highlightIndex]);
    } else if (e.key === 'Escape') {
      setShowSuggestions(false);
    }
  };

  const handleShare = async (e) => {
    e.preventDefault();
    if (!email.trim() || loading) return;

    setLoading(true);
    setError(null);
    setSuccess(null);
    setShowSuggestions(false);

    try {
      const response = await api.post(`/api/docs/${docId}/share`, {
        email: email.trim(),
        role: shareRole
      });
      if (response.data.invite) {
        setSuccess(`Invitation sent to ${response.data.invite.email}`);
      } else {
        setSuccess(`Shared with ${response.data.user.name || email}`);
      }
      setEmail('');
      fetchUsers(); // Refresh the users and invites lists
    } catch (err) {
      console.error('Error sharing document:', err);
      setError(err.response?.data?.error || 'Failed to share document');
    } finally {
      setLoading(false);
    }
  };

  const handleRemoveAccess = async (userId, userName) => {
    if (!confirm(`Remove ${userName}'s access to this document?`)) return;

    try {
      await api.delete(`/api/docs/${docId}/share/${userId}`);
      setUsers(users.filter(u => u.id !== userId));
      setSuccess(`Removed ${userName}'s access`);
    } catch (err) {
      console.error('Error removing access:', err);
      setError(err.response?.data?.error || 'Failed to remove access');
    }
  };

  const handleRemoveInvite = async (inviteEmail) => {
    if (!confirm(`Cancel the invitation to ${inviteEmail}?`)) return;

    try {
      await api.delete(`/api/docs/${docId}/invite`, { data: { email: inviteEmail } });
      setInvites(invites.filter(i => i.email !== inviteEmail));
      setSuccess(`Cancelled invitation to ${inviteEmail}`);
    } catch (err) {
      console.error('Error removing invite:', err);
      setError(err.response?.data?.error || 'Failed to cancel invitation');
    }
  };

  const handleRoleChange = async (userId, newRole) => {
    try {
      await api.put(`/api/docs/${docId}/share/${userId}`, { role: newRole });
      setUsers(users.map(u => u.id === userId ? { ...u, role: newRole } : u));
    } catch (err) {
      console.error('Error changing role:', err);
      setError(err.response?.data?.error || 'Failed to change role');
    }
  };

  const canManage = currentUserRole === 'owner' || currentUserRole === 'editor';

  // On iOS, shift the bottom-sheet above the virtual keyboard
  const mobileKeyboardStyle = (isMobile && viewport?.isKeyboardOpen) ? {
    bottom: `${window.innerHeight - viewport.height - viewport.offsetTop}px`,
    maxHeight: `${viewport.height * 0.8}px`,
  } : {};

  if (!isOpen) return null;

  return (
    <div className="share-dialog-overlay" onClick={onClose}>
      <div className="share-dialog" onClick={e => e.stopPropagation()} style={mobileKeyboardStyle}>
        <div className="share-dialog-header">
          <h2>Share "{docTitle || 'Untitled document'}"</h2>
          <button className="share-dialog-close" onClick={onClose} aria-label="Close">
            <XIcon />
          </button>
        </div>

        <form onSubmit={handleShare} className="share-form">
          <div className="share-input-row">
            <div className="share-input-wrapper">
              <input
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                onKeyDown={handleEmailKeyDown}
                onFocus={() => { if (suggestions.length) setShowSuggestions(true); }}
                onBlur={() => setTimeout(() => setShowSuggestions(false), 150)}
                placeholder="Enter email address"
                className="share-email-input"
                disabled={loading}
                autoComplete="off"
              />
              {showSuggestions && suggestions.length > 0 && (
                <ul className="share-suggestions">
                  {suggestions.map((s, i) => (
                    <li
                      key={s.id}
                      className={`share-suggestion-item${i === highlightIndex ? ' highlighted' : ''}`}
                      onMouseDown={(e) => { e.preventDefault(); selectSuggestion(s); }}
                      onMouseEnter={() => setHighlightIndex(i)}
                    >
                      <Avatar picture={s.picture} name={s.name} className="share-suggestion-avatar" />
                      <div className="share-user-info">
                        <span className="share-user-name">{s.name}</span>
                        <span className="share-user-email">{s.email}</span>
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </div>
            <select
              value={shareRole}
              onChange={(e) => setShareRole(e.target.value)}
              className="share-role-select"
              disabled={loading || currentUserRole === 'viewer'}
            >
              <option value="editor" disabled={currentUserRole === 'viewer'}>Editor</option>
              <option value="viewer">Viewer</option>
            </select>
            <button
              type="submit"
              className="share-submit-btn"
              disabled={!email.trim() || loading}
            >
              {loading ? 'Sharing...' : 'Share'}
            </button>
          </div>
        </form>

        {error && (
          <div className="share-message share-error">
            {error}
          </div>
        )}

        {success && (
          <div className="share-message share-success">
            {success}
          </div>
        )}

        <div className="share-list-section">
          <h3>People with access</h3>
          {usersLoading ? (
            <div className="share-list-loading">Loading...</div>
          ) : (
            <ul className="share-list">
              {users.map((user) => (
                <li key={user.id} className="share-list-item">
                  <Avatar picture={user.picture} name={user.name} className="share-user-avatar" />
                  <div className="share-user-info">
                    <span className="share-user-name">{user.name}</span>
                    <span className="share-user-email">{user.email}</span>
                  </div>
                  {user.role === 'owner' ? (
                    <span className="share-role-badge owner">Owner</span>
                  ) : user.id === currentUser?.id ? (
                    <span className="share-role-badge">{user.role}</span>
                  ) : canManage ? (
                    <div className="share-actions">
                      <select
                        value={user.role}
                        onChange={(e) => handleRoleChange(user.id, e.target.value)}
                        className="share-role-select"
                      >
                        <option value="editor">Editor</option>
                        <option value="viewer">Viewer</option>
                      </select>
                      <button
                        className="share-remove-btn"
                        onClick={() => handleRemoveAccess(user.id, user.name)}
                        aria-label={`Remove ${user.name}'s access`}
                      >
                        <XIcon />
                      </button>
                    </div>
                  ) : (
                    <span className="share-role-badge">{user.role}</span>
                  )}
                </li>
              ))}
            </ul>
          )}

          {!usersLoading && invites.length > 0 && (
            <>
              <h3 className="share-invites-heading">Pending invites</h3>
              <ul className="share-list">
                {invites.map((invite) => (
                  <li key={invite.id} className="share-list-item">
                    <Avatar name={invite.email} className="share-user-avatar" />
                    <div className="share-user-info">
                      <span className="share-user-email">{invite.email}</span>
                    </div>
                    <span className="share-role-badge">{invite.role}</span>
                    <span className="share-role-badge pending">Pending</span>
                    {canManage && (
                      <button
                        className="share-remove-btn"
                        onClick={() => handleRemoveInvite(invite.email)}
                        aria-label={`Cancel invitation to ${invite.email}`}
                      >
                        <XIcon />
                      </button>
                    )}
                  </li>
                ))}
              </ul>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

export default ShareDialog;
