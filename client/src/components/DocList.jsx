import React, { useEffect, useState } from 'react';
import { useAuth } from '../contexts/AuthContext';
import './DocList.css';

function DocList({ onNavigate, user }) {
  const { logout, api } = useAuth();
  const [docs, setDocs] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  useEffect(() => {
    fetchDocs();
  }, []);

  const fetchDocs = async () => {
    try {
      setLoading(true);
      // Use the authenticated API client
      const response = await api.get('/api/docs');
      setDocs(response.data.docs || []);
    } catch (err) {
      console.error('Error fetching docs:', err);
      setError(err.response?.data?.error || err.message);
    } finally {
      setLoading(false);
    }
  };

  const handleCreateNew = () => {
    // Generate a new UUID and navigate to it
    const newGuid = crypto.randomUUID();
    onNavigate(newGuid);
  };

  const formatDate = (dateString) => {
    const date = new Date(dateString);
    return date.toLocaleDateString(undefined, {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit'
    });
  };

  if (loading) {
    return (
      <div className="doc-list-container">
        <header className="doc-list-header">
          <h1>Documents</h1>
          <div className="doc-list-header-right">
            <UserProfileBadge user={user} onLogout={logout} />
          </div>
        </header>
        <div className="doc-list-loading">
          <div className="loading-spinner"></div>
          Loading documents...
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="doc-list-container">
        <header className="doc-list-header">
          <h1>Documents</h1>
          <div className="doc-list-header-right">
            <UserProfileBadge user={user} onLogout={logout} />
          </div>
        </header>
        <div className="doc-list-error">
          <p>Error: {error}</p>
          <button onClick={fetchDocs}>Try Again</button>
        </div>
      </div>
    );
  }

  return (
    <div className="doc-list-container">
      <header className="doc-list-header">
        <h1>Documents</h1>
        <div className="doc-list-header-right">
          <button className="create-doc-btn" onClick={handleCreateNew}>
            + New Document
          </button>
          <UserProfileBadge user={user} onLogout={logout} />
        </div>
      </header>

      {docs.length === 0 ? (
        <div className="doc-list-empty">
          <p>No documents yet.</p>
          <p>Create your first document to get started!</p>
        </div>
      ) : (
        <ul className="doc-list">
          {docs.map((doc) => (
            <li key={doc.docGuid} className="doc-list-item">
              <a
                href={`/d/${doc.docGuid}`}
                onClick={(e) => {
                  e.preventDefault();
                  onNavigate(doc.docGuid);
                }}
                className="doc-link"
              >
                <span className="doc-title">
                  {doc.title || 'Untitled Document'}
                </span>
                <span className="doc-date">
                  {formatDate(doc.updatedAt)}
                </span>
              </a>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/**
 * User profile badge component
 */
function UserProfileBadge({ user, onLogout }) {
  const [showMenu, setShowMenu] = useState(false);

  return (
    <div className="user-profile-badge">
      <button 
        className="user-profile-trigger"
        onClick={() => setShowMenu(!showMenu)}
        aria-expanded={showMenu}
      >
        {user?.picture ? (
          <img 
            src={user.picture} 
            alt={user.name} 
            className="user-avatar-small"
            referrerPolicy="no-referrer"
          />
        ) : (
          <div className="user-avatar-placeholder-small">
            {user?.name?.charAt(0).toUpperCase() || '?'}
          </div>
        )}
      </button>
      
      {showMenu && (
        <>
          <div className="user-menu-backdrop" onClick={() => setShowMenu(false)} />
          <div className="user-menu">
            <div className="user-menu-header">
              <div className="user-menu-name">{user?.name || 'User'}</div>
              <div className="user-menu-email">{user?.email || ''}</div>
            </div>
            <div className="user-menu-divider" />
            <button className="user-menu-item" onClick={onLogout}>
              Sign out
            </button>
          </div>
        </>
      )}
    </div>
  );
}

export default DocList;
