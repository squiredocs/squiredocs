import React, { useState, useEffect } from 'react';
import { useAuth } from '../contexts/AuthContext';
import './ShareDialog.css';

function ShareDialog({ docId, isOpen, onClose }) {
  const { api } = useAuth();
  const [email, setEmail] = useState('');
  const [users, setUsers] = useState([]);
  const [loading, setLoading] = useState(false);
  const [usersLoading, setUsersLoading] = useState(true);
  const [error, setError] = useState(null);
  const [success, setSuccess] = useState(null);
  const [currentUserRole, setCurrentUserRole] = useState(null);

  // Fetch current users when dialog opens
  useEffect(() => {
    if (isOpen && docId) {
      fetchUsers();
    }
  }, [isOpen, docId]);

  // Reset state when dialog closes
  useEffect(() => {
    if (!isOpen) {
      setEmail('');
      setError(null);
      setSuccess(null);
    }
  }, [isOpen]);

  const fetchUsers = async () => {
    try {
      setUsersLoading(true);
      const response = await api.get(`/api/docs/${docId}/shares`);
      setUsers(response.data.users || []);
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

  const handleShare = async (e) => {
    e.preventDefault();
    if (!email.trim() || loading) return;

    setLoading(true);
    setError(null);
    setSuccess(null);

    try {
      const response = await api.post(`/api/docs/${docId}/share`, { 
        email: email.trim(),
        role: 'editor' // Default to editor role
      });
      setSuccess(`Shared with ${response.data.user.name || email}`);
      setEmail('');
      fetchUsers(); // Refresh the users list
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

  const handleRoleChange = async (userId, newRole) => {
    try {
      await api.put(`/api/docs/${docId}/share/${userId}`, { role: newRole });
      setUsers(users.map(u => u.id === userId ? { ...u, role: newRole } : u));
    } catch (err) {
      console.error('Error changing role:', err);
      setError(err.response?.data?.error || 'Failed to change role');
    }
  };

  const isOwner = currentUserRole === 'owner';

  if (!isOpen) return null;

  return (
    <div className="share-dialog-overlay" onClick={onClose}>
      <div className="share-dialog" onClick={e => e.stopPropagation()}>
        <div className="share-dialog-header">
          <h2>Share document</h2>
          <button className="share-dialog-close" onClick={onClose} aria-label="Close">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        <form onSubmit={handleShare} className="share-form">
          <div className="share-input-row">
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="Enter email address"
              className="share-email-input"
              disabled={loading}
            />
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
                  <div className="share-user-avatar">
                    {user.picture ? (
                      <img src={user.picture} alt={user.name} referrerPolicy="no-referrer" />
                    ) : (
                      <span>{user.name?.charAt(0).toUpperCase() || '?'}</span>
                    )}
                  </div>
                  <div className="share-user-info">
                    <span className="share-user-name">{user.name}</span>
                    <span className="share-user-email">{user.email}</span>
                  </div>
                  {user.role === 'owner' ? (
                    <span className="share-role-badge owner">Owner</span>
                  ) : isOwner ? (
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
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                          <path d="M6 18L18 6M6 6l12 12" />
                        </svg>
                      </button>
                    </div>
                  ) : (
                    <span className="share-role-badge">{user.role}</span>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
}

export default ShareDialog;
