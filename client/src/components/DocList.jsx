import React, { useEffect, useState, useRef } from 'react';
import { useAuth } from '../contexts/AuthContext';
import UserProfileBadge from './UserProfileBadge';
import './DocList.css';

function DocList({ onNavigate, user }) {
  const { logout, api } = useAuth();
  const [docs, setDocs] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [creating, setCreating] = useState(false);
  const [openMenuId, setOpenMenuId] = useState(null);
  const [deleting, setDeleting] = useState(null);
  const menuRef = useRef(null);

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

  const handleMenuToggle = (e, docGuid) => {
    e.preventDefault();
    e.stopPropagation();
    setOpenMenuId(openMenuId === docGuid ? null : docGuid);
  };

  const handleDelete = async (e, doc) => {
    e.preventDefault();
    e.stopPropagation();
    
    if (doc.role !== 'owner') return;
    
    const title = doc.title || 'Untitled document';
    if (!window.confirm(`Are you sure you want to delete "${title}"? This action cannot be undone.`)) {
      return;
    }
    
    try {
      setDeleting(doc.docGuid);
      setOpenMenuId(null);
      await api.delete(`/api/docs/${doc.docGuid}`);
      // Remove from local state
      setDocs(docs.filter(d => d.docGuid !== doc.docGuid));
    } catch (err) {
      console.error('Error deleting document:', err);
      setError(err.response?.data?.error || err.message);
    } finally {
      setDeleting(null);
    }
  };

  // Close menu when clicking outside
  useEffect(() => {
    const handleClickOutside = (e) => {
      if (menuRef.current && !menuRef.current.contains(e.target)) {
        setOpenMenuId(null);
      }
    };
    
    if (openMenuId) {
      document.addEventListener('mousedown', handleClickOutside);
      return () => document.removeEventListener('mousedown', handleClickOutside);
    }
  }, [openMenuId]);

  const formatDate = (dateString) => {
    const date = new Date(dateString);
    return date.toLocaleDateString(undefined, {
      year: 'numeric',
      month: 'short',
      day: 'numeric'
    });
  };

  const DocIcon = ({ isSharedWithMe, isSharedByMe }) => {
    const showBadge = isSharedWithMe || isSharedByMe;
    const badgeColor = isSharedWithMe ? "#d1fae5" : "#ede9fe";
    const iconColor = isSharedWithMe ? "#059669" : "#7c3aed";
    const tooltipText = isSharedWithMe ? "Shared with me" : "Shared";
    
    return (
      <div className="doc-icon-wrapper">
        <svg className="doc-icon" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
          <rect x="4" y="2" width="16" height="20" rx="2" fill={isSharedWithMe ? "#059669" : "#7c3aed"}/>
          <rect x="7" y="7" width="10" height="1.5" rx="0.75" fill="white"/>
          <rect x="7" y="10" width="10" height="1.5" rx="0.75" fill="white"/>
          <rect x="7" y="13" width="6" height="1.5" rx="0.75" fill="white"/>
        </svg>
        {showBadge && (
          <div className="share-badge-wrapper">
            <svg className="share-badge" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
              <circle cx="12" cy="12" r="10" fill={badgeColor}/>
              <path d="M14.5 9.5c0 1.1-.9 2-2 2s-2-.9-2-2 .9-2 2-2 2 .9 2 2zM9 9.5c0 .83-.67 1.5-1.5 1.5S6 10.33 6 9.5 6.67 8 7.5 8 9 8.67 9 9.5zM7.5 12c-1.1 0-3 .5-3 1.5v1h4v-1c0-.57.35-1.06.85-1.37-.53-.09-1.17-.13-1.85-.13zM12.5 12c-1.38 0-4 .67-4 2v1.5h8V14c0-1.33-2.62-2-4-2z" fill={iconColor}/>
            </svg>
            <span className="share-badge-tooltip">{tooltipText}</span>
          </div>
        )}
      </div>
    );
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
          <UserProfileBadge user={user} onLogout={logout} />
        </div>
      </header>

      <button className="new-doc-btn" onClick={handleCreateNew} disabled={creating}>
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
          <line x1="12" y1="5" x2="12" y2="19"/>
          <line x1="5" y1="12" x2="19" y2="12"/>
        </svg>
        {creating ? 'Creating...' : 'New document'}
      </button>

      {docs.length === 0 ? (
        <div className="doc-list-empty">
          <p>No documents yet.</p>
          <p>Click "New document" above to create your first one!</p>
        </div>
      ) : (
        <ul className="doc-list">
          {docs.map((doc) => {
            const isOwner = doc.role === 'owner';
            const isDeleting = deleting === doc.docGuid;
            const isSharedWithMe = !isOwner;
            const isSharedByMe = isOwner && doc.shareCount > 1; // > 1 because owner counts as 1
            return (
              <li key={doc.docGuid} className={`doc-list-item ${isSharedWithMe ? 'shared' : ''} ${isDeleting ? 'deleting' : ''}`}>
                <a
                  href={`/d/${doc.docGuid}`}
                  onClick={(e) => {
                    e.preventDefault();
                    if (!isDeleting) onNavigate(doc.docGuid);
                  }}
                  className="doc-link"
                >
                  <DocIcon isSharedWithMe={isSharedWithMe} isSharedByMe={isSharedByMe} />
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
                <div className="doc-menu-wrapper" ref={openMenuId === doc.docGuid ? menuRef : null}>
                  <button 
                    className="doc-menu-btn" 
                    aria-label="More options"
                    onClick={(e) => handleMenuToggle(e, doc.docGuid)}
                  >
                    <svg viewBox="0 0 24 24" fill="currentColor">
                      <circle cx="12" cy="5" r="2"/>
                      <circle cx="12" cy="12" r="2"/>
                      <circle cx="12" cy="19" r="2"/>
                    </svg>
                  </button>
                  {openMenuId === doc.docGuid && (
                    <div className="doc-menu-dropdown">
                      <button
                        className={`doc-menu-item ${!isOwner ? 'disabled' : 'danger'}`}
                        onClick={(e) => handleDelete(e, doc)}
                        disabled={!isOwner}
                      >
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                          <path d="M3 6h18M8 6V4a2 2 0 012-2h4a2 2 0 012 2v2m3 0v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6h14zM10 11v6M14 11v6"/>
                        </svg>
                        Delete
                        {!isOwner && (
                          <span className="menu-hint-wrapper">
                            <span className="menu-hint-icon" tabIndex="0">?</span>
                            <span className="menu-hint-tooltip">Owner only</span>
                          </span>
                        )}
                      </button>
                    </div>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

export default DocList;
