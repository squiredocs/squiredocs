import React, { useState, useMemo, useEffect, useRef } from 'react';
import * as Y from 'yjs';
import { ySyncPluginKey, relativePositionToAbsolutePosition } from '@tiptap/y-tiptap';
import Editor from './Editor';
import Toolbar from './Toolbar';
import MobileActionBar from './MobileActionBar';
import UserProfileBadge from './UserProfileBadge';
import ShareDialog from './ShareDialog';
import VersionHistoryPanel from './VersionHistoryPanel';
import VersionPreview from './VersionPreview';
import { useYjs } from '../hooks/useYjs';
import { useVersionHistory } from '../hooks/useVersionHistory';
import { useAuth } from '../contexts/AuthContext';
import { useMobile } from '../hooks/useMobile';
import { usePreventPageScroll } from '../hooks/usePreventPageScroll';
import { shouldUseBrowserLinkBehavior } from '../utils/linkBehavior';
import { generateColorFromId } from '../utils/colorUtils';
import Logo from './Logo';
import './EditorView.css';
import './MenuCommon.css';

/**
 * Format timestamp for version history header
 */
function formatVersionTimestamp(timestamp) {
  const date = new Date(timestamp);
  const options = {
    month: 'long',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  };
  return date.toLocaleString(undefined, options);
}

function EditorView({ docGuid, onNavigateHome, onNavigateToVersions, onNavigateToSettings, onNavigateToAdmin, showVersionHistory = false, user, aiPanel }) {
  const { logout, api, accessToken, isAuthenticated, refreshAccessToken } = useAuth();

  // Generate user color deterministically from user ID
  const userColor = useMemo(() => {
    return user?.id ? generateColorFromId(user.id) : '#4a90e2';
  }, [user?.id]);

  // Complete user info for collaboration
  const collaborationUser = useMemo(() => user ? ({
    name: user.name || 'Anonymous',
    email: user.email,
    picture: user.picture,
    color: userColor
  }) : null, [user, userColor]);

  const { ydoc, provider, awareness, connected, connectionState, synced, users, docTitle, setDocTitle, forceReconnect, reconnectCount, authError } = useYjs(docGuid, accessToken, collaborationUser);

  // Debounce banner visibility to prevent flashing during quick state transitions
  const [debouncedBanner, setDebouncedBanner] = useState(null);
  useEffect(() => {
    // Determine what banner should show
    let targetBanner = null;
    if (authError) {
      targetBanner = 'authError';
    } else if (connectionState === 'disconnected') {
      targetBanner = 'disconnected';
    } else if (connectionState === 'connecting') {
      targetBanner = 'connecting';
    } else if (connectionState === 'connected' && !synced) {
      targetBanner = 'syncing';
    }

    // If transitioning to "no banner" or "connected", clear immediately
    if (!targetBanner) {
      setDebouncedBanner(null);
      return;
    }

    // If banner should show, debounce by 500ms to prevent flashing
    const timer = setTimeout(() => setDebouncedBanner(targetBanner), 500);
    return () => clearTimeout(timer);
  }, [authError, connectionState, synced]);

  const [editor, setEditor] = useState(null);
  const [shareDialogOpen, setShareDialogOpen] = useState(false);
  const [userRole, setUserRole] = useState(null);
  const [docInfoLoaded, setDocInfoLoaded] = useState(false);
  const [showLabelsCallback, setShowLabelsCallback] = useState(null);
  const [openMenuId, setOpenMenuId] = useState(null);
  const [deleting, setDeleting] = useState(false);
  const [showDiffHighlights, setShowDiffHighlights] = useState(true);
  const menuRef = useRef(null);
  const isMobile = useMobile();

  // Prevent page-level scrolling on mobile (disabled when AI panel is open)
  usePreventPageScroll({ disabled: aiPanel?.isOpen });

  // Filter out current user from the users list
  const displayUsers = React.useMemo(() => {
    return users.filter(u => u.id !== awareness?.clientID);
  }, [users, awareness?.clientID]);

  // Handle clicking on a user avatar to jump to their cursor
  const handleUserAvatarClick = (userId) => {
    if (!awareness || !editor || !ydoc) {
      return;
    }

    // Get the y-prosemirror sync state
    const ystate = ySyncPluginKey.getState(editor.state);
    if (!ystate || !ystate.binding) {
      console.log('[Jump] y-prosemirror binding not ready');
      return;
    }

    // Get the user's cursor position from awareness
    const states = awareness.getStates();

    for (const [clientId, state] of states.entries()) {
      if (clientId === userId && state.cursor) {
        try {
          // Convert JSON cursor positions to relative positions, then to absolute
          const relAnchor = Y.createRelativePositionFromJSON(state.cursor.anchor);
          const relHead = Y.createRelativePositionFromJSON(state.cursor.head);

          // Convert to absolute ProseMirror positions
          const anchor = relativePositionToAbsolutePosition(
            ydoc,
            ystate.type,
            relAnchor,
            ystate.binding.mapping
          );

          const head = relativePositionToAbsolutePosition(
            ydoc,
            ystate.type,
            relHead,
            ystate.binding.mapping
          );

          if (anchor !== null && head !== null) {
            // Move cursor to the beginning of their selection (anchor position)
            // Don't select text - just place cursor there
            editor.commands.focus();
            editor.commands.setTextSelection(anchor);

            // Scroll the cursor position into view
            editor.commands.scrollIntoView();

            // Show cursor labels
            if (showLabelsCallback) {
              showLabelsCallback();
            }
          }
        } catch (err) {
          console.error('[Jump] Error jumping to cursor:', err);
        }
        break;
      }
    }
  };

  // Version history hook
  const {
    versions,
    hierarchicalVersions,
    selection, // Unified: version or clock update (with isClock: true)
    versionContent,
    previousVersionContent, // For diff visualization (legacy)
    diffData, // { fullDoc, currentSnapshot, previousSnapshot } for proper diff
    totalEdits,
    isLoading: versionHistoryLoading,
    selectVersion,
    restoreVersion,
    createNamedVersion,
    renameVersion,
    deleteNamedVersion,
    clearSelection,
    // Hierarchical drill-down
    versionUpdates,
    loadingVersionUpdates,
    loadUpdatesForVersion,
    selectUpdate,
  } = useVersionHistory(showVersionHistory ? docGuid : null);

  // Auto-select current version when opening version history
  useEffect(() => {
    // Only auto-select if nothing is selected
    if (showVersionHistory && versions.length > 0 && !selection) {
      // Select the current (most recent) version
      const currentVersion = versions.find(v => v.isCurrent) || versions[0];
      if (currentVersion) {
        selectVersion(currentVersion);
      }
    }
  }, [showVersionHistory, versions, selection, selectVersion]);

  const handleOpenVersionHistory = () => {
    onNavigateToVersions(docGuid);
  };

  const handleCloseVersionHistory = () => {
    window.history.back();
  };

  const handleMenuToggle = (e) => {
    e.preventDefault();
    e.stopPropagation();
    setOpenMenuId(openMenuId ? null : 'tools');
  };

  const handleMenuItemClick = (e, callback) => {
    e.preventDefault();
    e.stopPropagation();
    setOpenMenuId(null);
    callback();
  };

  const handleDelete = async (e) => {
    e.preventDefault();
    e.stopPropagation();

    if (userRole !== 'owner') return;

    const title = docTitle || 'Untitled document';
    if (!window.confirm(`Are you sure you want to delete "${title}"? This action cannot be undone.`)) {
      return;
    }

    try {
      setDeleting(true);
      setOpenMenuId(null);
      await api.delete(`/api/docs/${docGuid}`);
      // Navigate back to document list after successful deletion
      onNavigateHome();
    } catch (err) {
      console.error('Error deleting document:', err);
      alert(err.response?.data?.error || 'Failed to delete document');
    } finally {
      setDeleting(false);
    }
  };

  // Fetch document info to determine user's role
  useEffect(() => {
    const fetchDocInfo = async () => {
      try {
        const response = await api.get(`/api/docs/${docGuid}`);
        setUserRole(response.data.role);
      } catch (err) {
        // If document doesn't exist yet, we'll create it when they edit
        if (err.response?.status === 404 || err.response?.status === 403) {
          // Try to create the document (establishes ownership)
          try {
            const createResponse = await api.post('/api/docs', { docId: docGuid });
            setUserRole(createResponse.data.role);
          } catch (createErr) {
            console.error('Error creating document:', createErr);
          }
        }
      } finally {
        setDocInfoLoaded(true);
      }
    };

    if (docGuid) {
      fetchDocInfo();
    }
  }, [docGuid, api]);


  // Update HTML title when document title changes
  useEffect(() => {
    const title = docTitle || 'Untitled document';
    document.title = `${title} - Squire Docs`;

    return () => {
      document.title = 'Squire Docs';
    };
  }, [docTitle]);

  // Auth error handling: auto-refresh token or redirect to login
  useEffect(() => {
    if (!authError) return;

    if (isAuthenticated) {
      // Token expired but user is authenticated - try to refresh
      refreshAccessToken().catch(() => {
        window.location.href = '/login';
      });
    } else {
      // Not authenticated - redirect to login
      const timer = setTimeout(() => {
        window.location.href = '/login';
      }, 2000);
      return () => clearTimeout(timer);
    }
  }, [authError, isAuthenticated, refreshAccessToken]);

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

  // Version history mode - dedicated full-screen view
  if (showVersionHistory) {
    return (
      <>
        <header className="app-header version-history-header">
          <div className="app-header-content">
            <div className="app-header-left">
              <a
                href={`/d/${docGuid}`}
                className="version-history-back-btn"
                onClick={(e) => {
                  // Allow standard browser behaviors (Cmd+Click, Ctrl+Click, middle-click, etc.)
                  if (shouldUseBrowserLinkBehavior(e)) {
                    return; // Let the browser handle it
                  }

                  // For normal clicks, go back in history
                  e.preventDefault();
                  handleCloseVersionHistory();
                }}
                title="Back to document"
              >
                <svg viewBox="0 0 24 24" fill="currentColor" width="24" height="24">
                  <path d="M20 11H7.83l5.59-5.59L12 4l-8 8 8 8 1.41-1.41L7.83 13H20v-2z" />
                </svg>
              </a>
              <div className="version-history-title">
                {selection?.name || (selection && formatVersionTimestamp(selection.timestamp)) || 'Version history'}
              </div>
            </div>
            <div className="app-header-right">
              {selection && !selection.isCurrent && userRole !== 'viewer' && (
                <button
                  className="restore-version-btn"
                  onClick={async () => {
                    if (window.confirm('Restore this version? A new version will be created with the restored content.')) {
                      const success = await restoreVersion(selection.id);
                      if (success) {
                        // Reload the page to see the restored content
                        window.location.reload();
                      }
                    }
                  }}
                >
                  Restore this version
                </button>
              )}
            </div>
          </div>
        </header>

        <div className="version-history-inner">
          <div className="version-history-main">
            <VersionPreview
              diffData={diffData}
              versionContent={versionContent}
              selection={selection}
              isLoading={versionHistoryLoading}
              showDiff={showDiffHighlights}
            />
          </div>

          <VersionHistoryPanel
            docGuid={docGuid}
            isOpen={true}
            onClose={handleCloseVersionHistory}
            onSelectVersion={selectVersion}
            selection={selection}
            hierarchicalVersions={hierarchicalVersions}
            totalEdits={totalEdits}
            isLoading={versionHistoryLoading}
            onCreateNamedVersion={createNamedVersion}
            onRenameVersion={renameVersion}
            onDeleteVersion={deleteNamedVersion}
            onRestoreVersion={restoreVersion}
            userRole={userRole}
            // Hierarchical drill-down props
            onSelectUpdate={selectUpdate}
            onLoadUpdates={loadUpdatesForVersion}
            versionUpdates={versionUpdates}
            loadingVersionUpdates={loadingVersionUpdates}
            // Diff highlighting toggle
            showDiffHighlights={showDiffHighlights}
            onToggleDiffHighlights={setShowDiffHighlights}
          />
        </div>
      </>
    );
  }

  // Normal editor mode
  return (
    <>
      {debouncedBanner === 'authError' && (
        <div className="sync-banner sync-banner--error" style={{ backgroundColor: '#dc2626', color: 'white' }}>
          {isAuthenticated ? (
            <>
              Connection failed
              <button
                onClick={() => refreshAccessToken().catch(() => window.location.href = '/login')}
                style={{ marginLeft: '12px', padding: '4px 12px', cursor: 'pointer', fontSize: '13px' }}
              >
                Retry
              </button>
            </>
          ) : (
            'Session expired - Redirecting to login...'
          )}
        </div>
      )}
      {debouncedBanner === 'disconnected' && (
        <div className="sync-banner sync-banner--disconnected">
          Offline
          <button
            onClick={forceReconnect}
            style={{ marginLeft: '12px', padding: '4px 12px', cursor: 'pointer', fontSize: '13px' }}
          >
            Retry
          </button>
        </div>
      )}
      {debouncedBanner === 'connecting' && (
        <div className="sync-banner sync-banner--connecting">
          {reconnectCount > 0 ? `Reconnecting... (${reconnectCount})` : 'Connecting...'}
        </div>
      )}
      {debouncedBanner === 'syncing' && (
        <div className="sync-banner">Syncing...</div>
      )}
      <header className={`app-header${isMobile ? ' mobile' : ''}`}>
        <div className="app-header-content">
          <div className="app-header-left">
            <a
              href="/docs"
              className="back-btn"
              onClick={(e) => {
                // Allow standard browser behaviors (Cmd+Click, Ctrl+Click, middle-click, etc.)
                if (shouldUseBrowserLinkBehavior(e)) {
                  return; // Let the browser handle it
                }

                // For normal clicks, use SPA navigation
                e.preventDefault();
                onNavigateHome();
              }}
              title="Documents Home"
            >
              <Logo />
            </a>
            <textarea
              value={docTitle}
              onChange={(e) => {
                setDocTitle(e.target.value);
                // Auto-resize textarea
                e.target.style.height = 'auto';
                e.target.style.height = e.target.scrollHeight + 'px';
              }}
              onFocus={(e) => {
                // If title is empty, populate from first line of document
                if (!docTitle && editor) {
                  const text = editor.getText();
                  const firstLine = text.split('\n')[0].trim().slice(0, 75);
                  if (firstLine) {
                    setDocTitle(firstLine);
                    // Need to wait for state update before selecting
                    setTimeout(() => e.target.select(), 0);
                    return;
                  }
                }
                e.target.select();
              }}
              onKeyDown={(e) => {
                if (e.key === 'Tab' && !e.shiftKey) {
                  e.preventDefault();
                  if (editor) {
                    editor.commands.focus();
                  }
                }
                // Prevent Enter key from creating new lines
                if (e.key === 'Enter') {
                  e.preventDefault();
                }
              }}
              className="app-title-input"
              placeholder="Document title"
              spellCheck={false}
              readOnly={userRole === 'viewer'}
              rows={1}
              wrap="soft"
              ref={(el) => {
                if (el) {
                  // Initial resize
                  el.style.height = 'auto';
                  el.style.height = el.scrollHeight + 'px';
                }
              }}
            />
          </div>
          <div className="app-header-right">
            {/* Active collaborators (excluding current user) - show fewer on mobile */}
            {displayUsers.length > 0 && (
              <div style={{ display: 'flex', alignItems: 'center', marginRight: 8 }}>
                {displayUsers
                  .slice(0, isMobile ? 2 : 5)
                  .map((u, i) => (
                    <div
                      key={u.id}
                      className="user-avatar"
                      style={{
                        width: 32,
                        height: 32,
                        borderRadius: '50%',
                        marginLeft: i === 0 ? 0 : -8,
                        overflow: u.isAgent ? 'visible' : 'hidden',
                        boxShadow: `0 0 0 2px ${u.color || '#7c3aed'}`,
                        zIndex: 5 - i,
                        position: 'relative',
                        flexShrink: 0,
                        background: '#fff',
                        cursor: 'pointer'
                      }}
                      title={u.name}
                      onClick={() => handleUserAvatarClick(u.id)}
                    >
                      {u.isAgent ? (
                        // Agent avatar with delegating user overlay
                        <>
                          <div style={{
                            width: '100%',
                            height: '100%',
                            display: 'flex',
                            alignItems: 'center',
                            justifyContent: 'center',
                            fontSize: 20,
                            background: 'rgba(255, 255, 255, 0.9)',
                            borderRadius: '50%',
                            overflow: 'hidden'
                          }}>
                            🤖
                          </div>
                          {/* Delegating user's avatar overlay */}
                          <div style={{
                            position: 'absolute',
                            bottom: -3,
                            right: -3,
                            width: 16,
                            height: 16,
                            borderRadius: '50%',
                            border: `2px solid ${u.color || '#7c3aed'}`,
                            overflow: 'hidden',
                            background: '#fff',
                            boxShadow: '0 1px 3px rgba(0,0,0,0.2)'
                          }}>
                            {u.picture ? (
                              <img
                                src={u.picture}
                                alt=""
                                referrerPolicy="no-referrer"
                                style={{
                                  width: '100%',
                                  height: '100%',
                                  objectFit: 'cover',
                                  objectPosition: 'center center',
                                  display: 'block'
                                }}
                              />
                            ) : (
                              <div style={{
                                width: '100%',
                                height: '100%',
                                display: 'flex',
                                alignItems: 'center',
                                justifyContent: 'center',
                                fontSize: 7,
                                fontWeight: 600,
                                color: '#fff',
                                background: u.color || '#7c3aed'
                              }}>
                                {u.name?.charAt(0).toUpperCase() || '?'}
                              </div>
                            )}
                          </div>
                        </>
                      ) : u.picture ? (
                        <img
                          src={u.picture}
                          alt={u.name}
                          referrerPolicy="no-referrer"
                          style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }}
                        />
                      ) : (
                        <div style={{
                          width: '100%',
                          height: '100%',
                          display: 'flex',
                          alignItems: 'center',
                          justifyContent: 'center',
                          color: '#fff',
                          fontSize: 14,
                          fontWeight: 600,
                          background: u.color || '#7c3aed'
                        }}>
                          {u.name?.charAt(0).toUpperCase() || '?'}
                        </div>
                      )}
                    </div>
                  ))}
                {displayUsers.length > (isMobile ? 2 : 5) && (
                  <div style={{
                    width: 32,
                    height: 32,
                    borderRadius: '50%',
                    background: '#666',
                    color: '#fff',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    fontSize: 11,
                    fontWeight: 600,
                    marginLeft: -8,
                    boxShadow: '0 0 0 2px #fff'
                  }}>
                    +{displayUsers.length - (isMobile ? 2 : 5)}
                  </div>
                )}
              </div>
            )}
            {/* Tools menu - contains Share, History, and Source buttons */}
            {docInfoLoaded && userRole && (
              <div className="tools-menu-wrapper" ref={menuRef}>
                <button
                  className="tools-menu-btn"
                  aria-label="More options"
                  onClick={handleMenuToggle}
                  title="More options"
                >
                  <svg viewBox="0 0 24 24" fill="currentColor">
                    <circle cx="12" cy="5" r="2"/>
                    <circle cx="12" cy="12" r="2"/>
                    <circle cx="12" cy="19" r="2"/>
                  </svg>
                </button>
                {openMenuId === 'tools' && (
                  <div className="tools-menu-dropdown">
                    <button
                      className="tools-menu-item"
                      onClick={(e) => handleMenuItemClick(e, () => setShareDialogOpen(true))}
                      title="Share document"
                    >
                      <svg viewBox="0 0 24 24" fill="currentColor">
                        <path d="M16 11c1.66 0 2.99-1.34 2.99-3S17.66 5 16 5c-1.66 0-3 1.34-3 3s1.34 3 3 3zm-8 0c1.66 0 2.99-1.34 2.99-3S9.66 5 8 5C6.34 5 5 6.34 5 8s1.34 3 3 3zm0 2c-2.33 0-7 1.17-7 3.5V19h14v-2.5c0-2.33-4.67-3.5-7-3.5zm8 0c-.29 0-.62.02-.97.05 1.16.84 1.97 1.97 1.97 3.45V19h6v-2.5c0-2.33-4.67-3.5-7-3.5z"/>
                      </svg>
                      <span>Share</span>
                    </button>
                    {!isMobile && (
                      <a
                        href={`/d/${docGuid}/versions`}
                        className="tools-menu-item"
                        onClick={(e) => {
                          // Allow standard browser behaviors (Cmd+Click, Ctrl+Click, middle-click, etc.)
                          if (shouldUseBrowserLinkBehavior(e)) {
                            return; // Let the browser handle it
                          }

                          // For normal clicks, use SPA navigation
                          handleMenuItemClick(e, handleOpenVersionHistory);
                        }}
                        title="Version history"
                      >
                        <svg viewBox="0 0 24 24" fill="currentColor">
                          <path d="M13 3a9 9 0 0 0-9 9H1l3.89 3.89.07.14L9 12H6c0-3.87 3.13-7 7-7s7 3.13 7 7-3.13 7-7 7c-1.93 0-3.68-.79-4.94-2.06l-1.42 1.42A8.954 8.954 0 0 0 13 21a9 9 0 0 0 0-18zm-1 5v5l4.28 2.54.72-1.21-3.5-2.08V8H12z"/>
                        </svg>
                        <span>History</span>
                      </a>
                    )}
                    <button
                      className="tools-menu-item"
                      onClick={(e) => handleMenuItemClick(e, () => window.print())}
                      title="Print or save as PDF"
                    >
                      <svg viewBox="0 0 24 24" fill="currentColor">
                        <path d="M19 8H5c-1.66 0-3 1.34-3 3v6h4v4h12v-4h4v-6c0-1.66-1.34-3-3-3zm-3 11H8v-5h8v5zm3-7c-.55 0-1-.45-1-1s.45-1 1-1 1 .45 1 1-.45 1-1 1zm-1-9H6v4h12V3z"/>
                      </svg>
                      <span>Print</span>
                    </button>
                    <button
                      className="tools-menu-item"
                      onClick={(e) => handleMenuItemClick(e, aiPanel.toggle)}
                      title={aiPanel.isOpen ? 'Close chat panel' : 'Open chat panel'}
                    >
                      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <path d="M12 2l2.09 6.26L20 10l-5.91 1.74L12 18l-2.09-6.26L4 10l5.91-1.74L12 2z" />
                        <path d="M5 19l1.5-3L10 15" opacity="0.6" />
                        <path d="M19 19l-1.5-3L14 15" opacity="0.6" />
                      </svg>
                      <span>{aiPanel.isOpen ? 'Close chat panel' : 'Open chat panel'}</span>
                    </button>
                    <button
                      className={`tools-menu-item ${userRole !== 'owner' ? 'disabled' : 'danger'}`}
                      onClick={handleDelete}
                      disabled={userRole !== 'owner' || deleting}
                      title={userRole !== 'owner' ? 'Only the owner can delete this document' : 'Delete document'}
                    >
                      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                        <path d="M3 6h18M8 6V4a2 2 0 012-2h4a2 2 0 012 2v2m3 0v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6h14zM10 11v6M14 11v6"/>
                      </svg>
                      <span>{deleting ? 'Deleting...' : 'Delete'}</span>
                      {userRole !== 'owner' && (
                        <span className="menu-hint-wrapper">
                          <span className="menu-hint-icon" tabIndex="0">?</span>
                          <span className="menu-hint-tooltip">Owner only</span>
                        </span>
                      )}
                    </button>
                  </div>
                )}
              </div>
            )}
            {!isMobile && <UserProfileBadge user={user} onLogout={logout} onNavigateToSettings={onNavigateToSettings} onNavigateToAdmin={onNavigateToAdmin} />}
          </div>
        </div>
      </header>
      {/* Desktop toolbar - below the header */}
      {userRole !== 'viewer' && !isMobile && <div className="editor-toolbar"><Toolbar editor={editor} /></div>}
      {/* Mobile toolbar - full width rows below the header */}
      {userRole !== 'viewer' && isMobile && <div className="editor-toolbar"><MobileActionBar editor={editor} /></div>}
      <main className="app-main">
        {userRole === 'viewer' && (
          <div className="view-only-banner">
            <svg viewBox="0 0 24 24" fill="currentColor" width="16" height="16">
              <path d="M12 4.5C7 4.5 2.73 7.61 1 12c1.73 4.39 6 7.5 11 7.5s9.27-3.11 11-7.5c-1.73-4.39-6-7.5-11-7.5zM12 17c-2.76 0-5-2.24-5-5s2.24-5 5-5 5 2.24 5 5-2.24 5-5 5zm0-8c-1.66 0-3 1.34-3 3s1.34 3 3 3 3-1.34 3-3-1.34-3-3-3z"/>
            </svg>
            View only
          </div>
        )}
        <Editor
          ydoc={ydoc}
          provider={provider}
          awareness={awareness}
          onEditorReady={setEditor}
          onShowLabelsReady={(callback) => setShowLabelsCallback(() => callback)}
          editable={userRole !== 'viewer'}
          synced={synced}
        />
      </main>

      {/* Share dialog */}
      <ShareDialog
        docId={docGuid}
        docTitle={docTitle}
        isOpen={shareDialogOpen}
        onClose={() => setShareDialogOpen(false)}
      />

    </>
  );
}

export default EditorView;
