import React, { useEffect, useState } from 'react';
import { useAuth } from '../contexts/AuthContext';
import UserProfileBadge from './UserProfileBadge';
import './DocList.css';

function DocList({ onNavigate, user }) {
  const { logout, api } = useAuth();
  const [docs, setDocs] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [creating, setCreating] = useState(false);

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

  const handleCreateNew = async () => {
    if (creating) return;
    
    try {
      setCreating(true);
      // Generate a new UUID
      const newGuid = crypto.randomUUID();
      
      // Create the document on the server (establishes ownership)
      await api.post('/api/docs', { docId: newGuid });
      
      // Navigate to the new document
      onNavigate(newGuid);
    } catch (err) {
      console.error('Error creating document:', err);
      setError(err.response?.data?.error || err.message);
    } finally {
      setCreating(false);
    }
  };

  const formatDate = (dateString) => {
    const date = new Date(dateString);
    return date.toLocaleDateString(undefined, {
      year: 'numeric',
      month: 'short',
      day: 'numeric'
    });
  };

  const DocIcon = ({ isShared }) => (
    <div className="doc-icon-wrapper">
      <svg className="doc-icon" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
        <rect x="4" y="2" width="16" height="20" rx="2" fill={isShared ? "#059669" : "#7c3aed"}/>
        <rect x="7" y="7" width="10" height="1.5" rx="0.75" fill="white"/>
        <rect x="7" y="10" width="10" height="1.5" rx="0.75" fill="white"/>
        <rect x="7" y="13" width="6" height="1.5" rx="0.75" fill="white"/>
      </svg>
      {isShared && (
        <svg className="shared-badge" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
          <circle cx="12" cy="12" r="10" fill="#059669"/>
          <path d="M16 12C16 14.2091 14.2091 16 12 16C9.79086 16 8 14.2091 8 12C8 9.79086 9.79086 8 12 8" stroke="white" strokeWidth="2" strokeLinecap="round"/>
          <path d="M12 8V6M12 6L10 8M12 6L14 8" stroke="white" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
        </svg>
      )}
    </div>
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
          {docs.map((doc) => {
            const isOwner = doc.role === 'owner';
            return (
              <li key={doc.docGuid} className={`doc-list-item ${!isOwner ? 'shared' : ''}`}>
                <a
                  href={`/d/${doc.docGuid}`}
                  onClick={(e) => {
                    e.preventDefault();
                    onNavigate(doc.docGuid);
                  }}
                  className="doc-link"
                >
                  <DocIcon isShared={!isOwner} />
                  <div className="doc-info">
                    <span className="doc-title">
                      {doc.title || 'Untitled document'}
                    </span>
                    <span className="doc-meta">
                      {!isOwner ? (
                        <span className="shared-by">Shared by {doc.ownerName}</span>
                      ) : (
                        <span className="doc-date">{formatDate(doc.updatedAt)}</span>
                      )}
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
            );
          })}
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
