import React, { useEffect, useState, useRef } from 'react';
import { useAuth } from '../contexts/AuthContext';
import UserProfileBadge from './UserProfileBadge';
import ShareDialog from './ShareDialog';
import { shouldUseBrowserLinkBehavior } from '../utils/linkBehavior';
import Logo from './Logo';
import './DocList.css';
import './MenuCommon.css';

/**
 * Generate UUID v4
 * Fallback for environments where crypto.randomUUID() is not available
 * Exported for testing
 */
export function generateUUID() {
  // Try native crypto.randomUUID first (requires secure context)
  if (typeof crypto !== 'undefined' && crypto.randomUUID) {
    return crypto.randomUUID();
  }

  // Fallback: generate UUID v4 manually
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function(c) {
    const r = Math.random() * 16 | 0;
    const v = c === 'x' ? r : (r & 0x3 | 0x8);
    return v.toString(16);
  });
}

function DocList({ onNavigate, onNavigateToSettings, user }) {
  const { logout, api } = useAuth();
  const [docs, setDocs] = useState([]);
  const [loading, setLoading] = useState(true);

  // Fire Google Ads sign-up conversion event for new users
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (params.get('signup') === '1') {
      if (typeof gtag === 'function') {
        gtag('event', 'conversion', {
          'send_to': 'AW-977363147/wzKYCLj5pPwbEMvBhdID',
          'value': 1.0,
          'currency': 'USD'
        });
      }
      // Clean up the URL
      window.history.replaceState({}, '', '/docs');
    }
  }, []);
  const [error, setError] = useState(null);
  const [creating, setCreating] = useState(false);
  const [openMenuId, setOpenMenuId] = useState(null);
  const [deleting, setDeleting] = useState(null);
  const [shareDialogOpen, setShareDialogOpen] = useState(false);
  const [shareDocId, setShareDocId] = useState(null);
  const [shareDocTitle, setShareDocTitle] = useState(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [filter, setFilter] = useState('all');
  const menuRef = useRef(null);
  const searchTimeoutRef = useRef(null);

  useEffect(() => {
    document.title = 'Documents - Squire Docs';
    fetchDocs();

    return () => {
      document.title = 'Squire Docs';
    };
  }, []);

  // Debounced search effect
  useEffect(() => {
    // Clear any existing timeout
    if (searchTimeoutRef.current) {
      clearTimeout(searchTimeoutRef.current);
    }

    // Debounce search requests by 300ms
    searchTimeoutRef.current = setTimeout(() => {
      fetchDocs();
    }, 300);

    return () => {
      if (searchTimeoutRef.current) {
        clearTimeout(searchTimeoutRef.current);
      }
    };
  }, [searchQuery, filter]);

  const fetchDocs = async () => {
    try {
      // Build query params
      const params = new URLSearchParams();
      if (searchQuery.trim()) {
        params.set('search', searchQuery.trim());
      }
      if (filter !== 'all') {
        params.set('filter', filter);
      }
      const queryString = params.toString();
      const url = queryString ? `/api/docs?${queryString}` : '/api/docs';

      // Use the authenticated API client
      const response = await api.get(url);
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
      const newGuid = generateUUID();

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

  const handleShare = (e, docGuid, docTitle) => {
    e.preventDefault();
    e.stopPropagation();
    setShareDocId(docGuid);
    setShareDocTitle(docTitle);
    setShareDialogOpen(true);
    setOpenMenuId(null);
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

  const formatDateTime = (dateString) => {
    const date = new Date(dateString);
    const dateStr = date.toLocaleDateString(undefined, {
      year: 'numeric',
      month: 'short',
      day: 'numeric'
    });
    const timeStr = date.toLocaleTimeString(undefined, {
      hour: 'numeric',
      minute: '2-digit'
    });
    return `${dateStr} at ${timeStr}`;
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
      <>
        <header className="app-header">
          <div className="app-header-content">
            <div className="app-header-left">
              <button
                className="back-btn"
                onClick={fetchDocs}
                title="Refresh documents"
              >
                <Logo />
              </button>
              <h1>Documents</h1>
            </div>
            <div className="app-header-right">
              <UserProfileBadge user={user} onLogout={logout} onNavigateToSettings={onNavigateToSettings} />
            </div>
          </div>
        </header>
        <div className="doc-list-container">
          <div className="doc-list-loading">
            <div className="loading-spinner"></div>
            Loading documents...
          </div>
        </div>
      </>
    );
  }

  if (error) {
    return (
      <>
        <header className="app-header">
          <div className="app-header-content">
            <div className="app-header-left">
              <h1>Documents</h1>
            </div>
            <div className="app-header-right">
              <UserProfileBadge user={user} onLogout={logout} onNavigateToSettings={onNavigateToSettings} />
            </div>
          </div>
        </header>
        <div className="doc-list-container">
          <div className="doc-list-error">
            <p>Error: {error}</p>
            <button onClick={fetchDocs}>Try Again</button>
          </div>
        </div>
      </>
    );
  }

  return (
    <>
      <header className="app-header">
        <div className="app-header-content">
          <div className="app-header-left">
            <button
              className="back-btn"
              onClick={fetchDocs}
              title="Refresh documents"
            >
              <Logo />
            </button>
            <h1>Documents</h1>
          </div>
          <div className="app-header-right">
            <UserProfileBadge user={user} onLogout={logout} onNavigateToSettings={onNavigateToSettings} />
          </div>
        </div>
      </header>

      <div className="doc-list-container">
      <div className="doc-list-toolbar">
        <button className="new-doc-btn" onClick={handleCreateNew} disabled={creating}>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
            <line x1="12" y1="5" x2="12" y2="19"/>
            <line x1="5" y1="12" x2="19" y2="12"/>
          </svg>
          {creating ? 'Creating...' : 'New document'}
        </button>

        <div className="doc-list-search-filter">
          <div className="doc-list-search">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <circle cx="11" cy="11" r="8"/>
              <path d="M21 21l-4.35-4.35"/>
            </svg>
            <input
              type="text"
              placeholder="Search documents..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
            />
            {searchQuery && (
              <button
                className="doc-list-search-clear"
                onClick={() => setSearchQuery('')}
                aria-label="Clear search"
              >
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <line x1="18" y1="6" x2="6" y2="18"/>
                  <line x1="6" y1="6" x2="18" y2="18"/>
                </svg>
              </button>
            )}
          </div>

          <select
            className="doc-list-filter"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
          >
            <option value="all">All documents</option>
            <option value="owned">Owned by me</option>
            <option value="shared_with_me">Shared with me</option>
          </select>
        </div>
      </div>

      {docs.length === 0 ? (
        <div className="doc-list-empty">
          {searchQuery || filter !== 'all' ? (
            <>
              <p>No documents found.</p>
              <p>Try adjusting your search or filter.</p>
            </>
          ) : (
            <>
              <p>No documents yet.</p>
              <p>Click "New document" above to create your first one!</p>
            </>
          )}
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
                    // Allow standard browser behaviors (Cmd+Click, Ctrl+Click, middle-click, etc.)
                    if (shouldUseBrowserLinkBehavior(e)) {
                      return; // Let the browser handle it
                    }

                    // Prevent navigation if deleting
                    if (isDeleting) {
                      e.preventDefault();
                      return;
                    }

                    // For normal clicks, use SPA navigation
                    e.preventDefault();
                    onNavigate(doc.docGuid);
                  }}
                  className="doc-link"
                >
                  <DocIcon isSharedWithMe={isSharedWithMe} isSharedByMe={isSharedByMe} />
                  <div className="doc-info">
                    <span className="doc-title">
                      {doc.title || 'Untitled document'}
                    </span>
                    <span className="doc-meta">
                      <span className="doc-date">Opened {formatDateTime(doc.updatedAt)}</span>
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
                        className="doc-menu-item"
                        onClick={(e) => handleShare(e, doc.docGuid, doc.title || 'Untitled document')}
                      >
                        <svg viewBox="0 0 24 24" fill="currentColor">
                          <path d="M16 11c1.66 0 2.99-1.34 2.99-3S17.66 5 16 5c-1.66 0-3 1.34-3 3s1.34 3 3 3zm-8 0c1.66 0 2.99-1.34 2.99-3S9.66 5 8 5C6.34 5 5 6.34 5 8s1.34 3 3 3zm0 2c-2.33 0-7 1.17-7 3.5V19h14v-2.5c0-2.33-4.67-3.5-7-3.5zm8 0c-.29 0-.62.02-.97.05 1.16.84 1.97 1.97 1.97 3.45V19h6v-2.5c0-2.33-4.67-3.5-7-3.5z"/>
                        </svg>
                        Share
                      </button>
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

      {/* Share dialog */}
      {shareDocId && (
        <ShareDialog
          docId={shareDocId}
          docTitle={shareDocTitle}
          isOpen={shareDialogOpen}
          onClose={() => {
            setShareDialogOpen(false);
            setShareDocId(null);
            setShareDocTitle(null);
          }}
        />
      )}
      </div>
    </>
  );
}

export default DocList;
