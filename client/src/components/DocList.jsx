import React, { useEffect, useState } from 'react';
import { useAuth } from '../contexts/AuthContext';
import UserProfileBadge from './UserProfileBadge';
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
      day: 'numeric'
    });
  };

  const DocIcon = () => (
    <svg className="doc-icon" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
      <rect x="4" y="2" width="16" height="20" rx="2" fill="#7c3aed"/>
      <rect x="7" y="7" width="10" height="1.5" rx="0.75" fill="white"/>
      <rect x="7" y="10" width="10" height="1.5" rx="0.75" fill="white"/>
      <rect x="7" y="13" width="6" height="1.5" rx="0.75" fill="white"/>
    </svg>
  );

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
          <UserProfileBadge user={user} onLogout={logout} />
        </div>
      </header>

      {docs.length === 0 ? (
        <div className="doc-list-empty">
          <p>No documents yet.</p>
          <p>Tap + to create your first document!</p>
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
                <DocIcon />
                <div className="doc-info">
                  <span className="doc-title">
                    {doc.title || 'Untitled document'}
                  </span>
                  <span className="doc-date">
                    {formatDate(doc.updatedAt)}
                  </span>
                </div>
              </a>
              <button className="doc-menu-btn" aria-label="More options">
                <svg viewBox="0 0 24 24" fill="currentColor">
                  <circle cx="12" cy="5" r="2"/>
                  <circle cx="12" cy="12" r="2"/>
                  <circle cx="12" cy="19" r="2"/>
                </svg>
              </button>
            </li>
          ))}
        </ul>
      )}

      <button className="fab-create-doc" onClick={handleCreateNew} aria-label="Create new document">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
          <line x1="12" y1="5" x2="12" y2="19"/>
          <line x1="5" y1="12" x2="19" y2="12"/>
        </svg>
      </button>
    </div>
  );
}

export default DocList;
