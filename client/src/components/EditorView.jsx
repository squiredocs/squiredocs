import React, { useState, useMemo, useEffect } from 'react';
import * as Y from 'yjs';
import { ySyncPluginKey, relativePositionToAbsolutePosition } from 'y-prosemirror';
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
import { useVisualViewport } from '../hooks/useVisualViewport';
import { shouldUseBrowserLinkBehavior } from '../utils/linkBehavior';
import './EditorView.css';

/**
 * Generate a deterministic color from a string (user ID)
 */
function generateColorFromId(id) {
  let hash = 0;
  for (let i = 0; i < id.length; i++) {
    const char = id.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash = hash & hash; // Convert to 32bit integer
  }

  // Generate a HSL color with good saturation and lightness for visibility
  const hue = Math.abs(hash) % 360;
  return `hsl(${hue}, 70%, 45%)`;
}

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

/**
 * Prettify HTML with proper indentation
 */
function prettifyHTML(html) {
  let formatted = '';
  let indent = 0;
  const tab = '  ';

  // Split by tags
  html.split(/(<[^>]+>)/g).forEach(part => {
    if (!part.trim()) return;

    // Closing tag
    if (part.match(/^<\/\w/)) {
      indent = Math.max(0, indent - 1);
      formatted += tab.repeat(indent) + part + '\n';
    }
    // Self-closing tag or text content
    else if (part.match(/\/>$/) || !part.match(/^</)) {
      formatted += tab.repeat(indent) + part + '\n';
    }
    // Opening tag
    else {
      formatted += tab.repeat(indent) + part + '\n';
      indent++;
    }
  });

  return formatted.trim();
}

/**
 * Format document block structure with indexes
 * Shows elementIndex (for MCP API) and character offsets
 * Only shows top-level elements to match xmlFragment.get(elementIndex) behavior
 */
/**
 * Get text content from a Yjs node
 */
function getTextContent(node) {
  if (node instanceof Y.XmlText) {
    return node.toString();
  } else if (node instanceof Y.XmlElement) {
    let text = '';
    for (let i = 0; i < node.length; i++) {
      const child = node.get(i);
      text += getTextContent(child);
    }
    return text;
  }
  return '';
}

/**
 * Get attributes from a Yjs node
 */
function getNodeAttributes(node) {
  if (!(node instanceof Y.XmlElement)) return null;

  const attrs = {};
  const level = node.getAttribute('level');
  if (level !== undefined) attrs.level = level;

  const language = node.getAttribute('language');
  if (language !== undefined) attrs.language = language;

  const start = node.getAttribute('start');
  if (start !== undefined) attrs.start = start;

  const type = node.getAttribute('type');
  if (type !== undefined) attrs.type = type;

  return Object.keys(attrs).length > 0 ? attrs : null;
}

/**
 * Format block structure for debugging
 * Uses Yjs document directly (same source as server-side MCP tools)
 */
function formatBlocks(ydoc) {
  const xmlFragment = ydoc.get('default', Y.XmlFragment);
  let output = 'Block Structure (for MCP API)\n';
  output += '─'.repeat(70) + '\n\n';

  const state = { elementIndex: 0 };
  let cumulativeOffset = 0;

  function formatNode(node, depth = 0, topLevelOffset = 0, absoluteOffset = 0) {
    const indent = '  '.repeat(depth);
    const textContent = getTextContent(node);
    const textLength = textContent.length;

    let result = '';

    // Only top-level blocks get an elementIndex
    if (depth === 0) {
      const preview = textContent ? ` "${textContent.slice(0, 50)}${textContent.length > 50 ? '...' : ''}"` : '';
      const endPos = absoluteOffset + textLength; // Exclusive end position
      const attrs = getNodeAttributes(node);
      const attrsStr = attrs ? ` ${JSON.stringify(attrs)}` : '';

      result += `${indent}[${state.elementIndex}] <${node.nodeName}>${attrsStr} offsets:${absoluteOffset}-${endPos}${preview}\n`;
      state.elementIndex++;

      // Process children
      if (node.length > 0) {
        let childOffset = 0;
        for (let i = 0; i < node.length; i++) {
          const child = node.get(i);
          if (child instanceof Y.XmlElement) {
            result += formatNode(child, depth + 1, childOffset, absoluteOffset + childOffset);
            childOffset += getTextContent(child).length;
          }
        }
      }
    } else {
      // Nested blocks show offset within TOP-LEVEL element
      const preview = textContent ? ` "${textContent.slice(0, 40)}${textContent.length > 40 ? '...' : ''}"` : '';
      const endPos = topLevelOffset + textLength; // Exclusive end position
      const attrs = getNodeAttributes(node);
      const attrsStr = attrs ? ` ${JSON.stringify(attrs)}` : '';

      result += `${indent}  ↳ <${node.nodeName}>${attrsStr} offsets:${topLevelOffset}-${endPos}${preview}\n`;

      // Process children
      if (node.length > 0) {
        let childOffset = topLevelOffset;
        for (let i = 0; i < node.length; i++) {
          const child = node.get(i);
          if (child instanceof Y.XmlElement) {
            result += formatNode(child, depth + 1, childOffset, absoluteOffset + (childOffset - topLevelOffset));
            childOffset += getTextContent(child).length;
          }
        }
      }
    }

    return result;
  }

  for (let i = 0; i < xmlFragment.length; i++) {
    const node = xmlFragment.get(i);
    if (node instanceof Y.XmlElement) {
      output += formatNode(node, 0, 0, cumulativeOffset);
      cumulativeOffset += getTextContent(node).length;
    }
  }

  if (state.elementIndex === 0) {
    return 'No block elements found';
  }

  output += '\n' + '─'.repeat(70) + '\n';
  output += `Total top-level elements: ${state.elementIndex}\n\n`;
  output += 'Usage with MCP API:\n';
  output += '  - elementIndex: Use the [N] value (top-level only)\n';
  output += '  - textOffset: Use any value in the offset range shown\n';
  output += '  - Nested items (↳) are inside their parent element\n';

  return output;
}

/**
 * Get depth of a node in the document tree
 */
function getDepth(node, doc) {
  let depth = 0;
  let current = node;
  while (current && current !== doc) {
    depth++;
    current = current.parent;
  }
  return depth;
}

function EditorView({ docGuid, onNavigateHome, onNavigateToVersions, onNavigateToSettings, showVersionHistory = false, user }) {
  const { logout, api, accessToken, isAuthenticated } = useAuth();

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
  const [editor, setEditor] = useState(null);
  const [shareDialogOpen, setShareDialogOpen] = useState(false);
  const [sourceModalOpen, setSourceModalOpen] = useState(false);
  const [sourceFormat, setSourceFormat] = useState('json');
  const [userRole, setUserRole] = useState(null);
  const [docInfoLoaded, setDocInfoLoaded] = useState(false);
  const [showLabelsCallback, setShowLabelsCallback] = useState(null);
  const isMobile = useMobile();
  const visualViewport = useVisualViewport();

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
            // Create selection range
            editor.commands.focus();
            editor.commands.setTextSelection({ from: anchor, to: head });

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
    groupedVersions,
    selectedVersion,
    versionContent,
    totalEdits,
    isLoading: versionHistoryLoading,
    selectVersion,
    restoreVersion,
    createNamedVersion,
    renameVersion,
    deleteNamedVersion,
    clearSelection,
  } = useVersionHistory(showVersionHistory ? docGuid : null);

  // Auto-select current version when opening version history
  useEffect(() => {
    if (showVersionHistory && versions.length > 0 && !selectedVersion) {
      // Select the current (most recent) version
      const currentVersion = versions.find(v => v.isCurrent) || versions[0];
      if (currentVersion) {
        selectVersion(currentVersion);
      }
    }
  }, [showVersionHistory, versions, selectedVersion, selectVersion]);

  const handleOpenVersionHistory = () => {
    onNavigateToVersions(docGuid);
  };

  const handleCloseVersionHistory = () => {
    window.history.back();
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
    document.title = `${title} - HeroDocs`;

    return () => {
      document.title = 'HeroDocs';
    };
  }, [docTitle]);

  // FIX 6: Session expired redirect to login
  // When auth error is detected and user is not authenticated, redirect to login
  useEffect(() => {
    console.log('[EditorView] Auth state check:', { authError, isAuthenticated, accessToken: !!accessToken });
    if (authError && !isAuthenticated) {
      console.log('[EditorView] Auth error detected, redirecting to login in 1 second...');
      // Small delay to ensure state is settled and logs are visible
      const timer = setTimeout(() => {
        console.log('[EditorView] Redirecting to /login');
        window.location.href = '/login';
      }, 1000);
      return () => clearTimeout(timer);
    }
  }, [authError, isAuthenticated, accessToken]);

  // Version history mode - dedicated full-screen view
  if (showVersionHistory) {
    return (
      <div className="app version-history-mode">
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
                {selectedVersion?.name || (selectedVersion && formatVersionTimestamp(selectedVersion.timestamp)) || 'Version history'}
              </div>
            </div>
            <div className="app-header-right">
              {selectedVersion && !selectedVersion.isCurrent && userRole !== 'viewer' && (
                <button
                  className="restore-version-btn"
                  onClick={async () => {
                    if (window.confirm('Restore this version? A new version will be created with the restored content.')) {
                      const success = await restoreVersion(selectedVersion.id);
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

        <div className="version-history-container">
          <div className="version-history-main">
            <VersionPreview
              versionContent={versionContent}
              selectedVersion={selectedVersion}
              isLoading={versionHistoryLoading}
            />
          </div>

          <VersionHistoryPanel
            docGuid={docGuid}
            isOpen={true}
            onClose={handleCloseVersionHistory}
            onSelectVersion={selectVersion}
            selectedVersion={selectedVersion}
            groupedVersions={groupedVersions}
            totalEdits={totalEdits}
            isLoading={versionHistoryLoading}
            onCreateNamedVersion={createNamedVersion}
            onRenameVersion={renameVersion}
            onDeleteVersion={deleteNamedVersion}
            onRestoreVersion={restoreVersion}
            userRole={userRole}
          />
        </div>
      </div>
    );
  }

  // Normal editor mode
  return (
    <div className="app">
      {authError && (
        <div className="sync-banner sync-banner--error" style={{ backgroundColor: '#dc2626', color: 'white' }}>
          ❌ Session expired - Redirecting to login...
        </div>
      )}
      {!authError && connectionState === 'disconnected' && (
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
      {!authError && connectionState === 'connecting' && (
        <div className="sync-banner sync-banner--connecting">
          {reconnectCount > 0 ? `Reconnecting... (${reconnectCount})` : 'Connecting...'}
        </div>
      )}
      {!authError && connectionState === 'connected' && !synced && (
        <div className="sync-banner">Syncing...</div>
      )}
      <header className="app-header">
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
              <svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" width="56" height="56">
                <rect x="4" y="2" width="16" height="20" rx="2" fill="#7c3aed"/>
                <rect x="7" y="7" width="10" height="1.5" rx="0.75" fill="white"/>
                <rect x="7" y="10" width="10" height="1.5" rx="0.75" fill="white"/>
                <rect x="7" y="13" width="6" height="1.5" rx="0.75" fill="white"/>
              </svg>
            </a>
            <div className="title-toolbar-stack">
              <input
                type="text"
                value={docTitle}
                onChange={(e) => setDocTitle(e.target.value)}
                onFocus={(e) => e.target.select()}
                onKeyDown={(e) => {
                  if (e.key === 'Tab' && !e.shiftKey) {
                    e.preventDefault();
                    if (editor) {
                      editor.commands.focus();
                    }
                  }
                }}
                className="app-title-input"
                placeholder="Document title"
                spellCheck={false}
                readOnly={userRole === 'viewer'}
              />
              {userRole !== 'viewer' && !isMobile && <Toolbar editor={editor} />}
              {userRole !== 'viewer' && isMobile && <MobileActionBar editor={editor} />}
            </div>
          </div>
          <div className="app-header-right">
            {/* Active collaborators (excluding current user) */}
            {displayUsers.length > 0 && (
              <div style={{ display: 'flex', alignItems: 'center', marginRight: 8 }}>
                {displayUsers
                  .slice(0, 5)
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
                        boxShadow: `0 0 0 2px ${u.color || '#667eea'}`,
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
                            border: `2px solid ${u.color || '#667eea'}`,
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
                                background: u.color || '#667eea'
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
                          background: u.color || 'linear-gradient(135deg, #667eea 0%, #764ba2 100%)'
                        }}>
                          {u.name?.charAt(0).toUpperCase() || '?'}
                        </div>
                      )}
                    </div>
                  ))}
                {displayUsers.length > 5 && (
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
                    +{users.filter(u => u.id !== awareness?.clientID).length - 5}
                  </div>
                )}
              </div>
            )}
            {/* History button - shown to anyone with access */}
            {docInfoLoaded && userRole && (
              <a
                href={`/d/${docGuid}/versions`}
                className="history-btn"
                onClick={(e) => {
                  // Allow standard browser behaviors (Cmd+Click, Ctrl+Click, middle-click, etc.)
                  if (shouldUseBrowserLinkBehavior(e)) {
                    return; // Let the browser handle it
                  }

                  // For normal clicks, use SPA navigation
                  e.preventDefault();
                  handleOpenVersionHistory();
                }}
                title="Version history"
              >
                <svg viewBox="0 0 24 24" fill="currentColor">
                  <path d="M13 3a9 9 0 0 0-9 9H1l3.89 3.89.07.14L9 12H6c0-3.87 3.13-7 7-7s7 3.13 7 7-3.13 7-7 7c-1.93 0-3.68-.79-4.94-2.06l-1.42 1.42A8.954 8.954 0 0 0 13 21a9 9 0 0 0 0-18zm-1 5v5l4.28 2.54.72-1.21-3.5-2.08V8H12z"/>
                </svg>
                <span>History</span>
              </a>
            )}
            {/* Source button - debugging feature to view raw document */}
            {docInfoLoaded && userRole && (
              <button
                className="source-btn"
                onClick={() => setSourceModalOpen(true)}
                title="View raw document source"
              >
                <svg viewBox="0 0 24 24" fill="currentColor">
                  <path d="M9.4 16.6L4.8 12l4.6-4.6L8 6l-6 6 6 6 1.4-1.4zm5.2 0l4.6-4.6-4.6-4.6L16 6l6 6-6 6-1.4-1.4z"/>
                </svg>
                <span>Source</span>
              </button>
            )}
            {/* Share button - shown to anyone with access */}
            {docInfoLoaded && userRole && (
              <button
                className="share-btn"
                onClick={() => setShareDialogOpen(true)}
                title="Share document"
              >
                <svg viewBox="0 0 24 24" fill="currentColor">
                  <path d="M16 11c1.66 0 2.99-1.34 2.99-3S17.66 5 16 5c-1.66 0-3 1.34-3 3s1.34 3 3 3zm-8 0c1.66 0 2.99-1.34 2.99-3S9.66 5 8 5C6.34 5 5 6.34 5 8s1.34 3 3 3zm0 2c-2.33 0-7 1.17-7 3.5V19h14v-2.5c0-2.33-4.67-3.5-7-3.5zm8 0c-.29 0-.62.02-.97.05 1.16.84 1.97 1.97 1.97 3.45V19h6v-2.5c0-2.33-4.67-3.5-7-3.5z"/>
                </svg>
                <span>Share</span>
              </button>
            )}
            <UserProfileBadge user={user} onLogout={logout} onNavigateToSettings={onNavigateToSettings} />
          </div>
        </div>
      </header>
      <div className="app-body">
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
      </div>

      {/* Share dialog */}
      <ShareDialog
        docId={docGuid}
        docTitle={docTitle}
        isOpen={shareDialogOpen}
        onClose={() => setShareDialogOpen(false)}
      />

      {/* Source modal - debugging feature */}
      {sourceModalOpen && (
        <div className="modal-overlay" onClick={() => setSourceModalOpen(false)}>
          <div className="source-modal" onClick={(e) => e.stopPropagation()}>
            <div className="source-modal-header">
              <h2>Document Source</h2>
              <div className="source-format-tabs">
                <button
                  className={`source-format-tab ${sourceFormat === 'json' ? 'active' : ''}`}
                  onClick={() => setSourceFormat('json')}
                >
                  JSON
                </button>
                <button
                  className={`source-format-tab ${sourceFormat === 'html' ? 'active' : ''}`}
                  onClick={() => setSourceFormat('html')}
                >
                  HTML
                </button>
                <button
                  className={`source-format-tab ${sourceFormat === 'blocks' ? 'active' : ''}`}
                  onClick={() => setSourceFormat('blocks')}
                >
                  Blocks
                </button>
                <button
                  className={`source-format-tab ${sourceFormat === 'text' ? 'active' : ''}`}
                  onClick={() => setSourceFormat('text')}
                >
                  Text
                </button>
              </div>
              <button
                className="source-modal-close"
                onClick={() => setSourceModalOpen(false)}
                title="Close"
              >
                <svg viewBox="0 0 24 24" fill="currentColor" width="24" height="24">
                  <path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/>
                </svg>
              </button>
            </div>
            <div className="source-modal-content">
              <pre>
                {!editor ? 'Loading...' :
                  sourceFormat === 'json' ? JSON.stringify(editor.getJSON(), null, 2) :
                  sourceFormat === 'html' ? prettifyHTML(editor.getHTML()) :
                  sourceFormat === 'blocks' ? formatBlocks(ydoc) :
                  editor.getText()}
              </pre>
            </div>
          </div>
        </div>
      )}

      {/* Mobile format bar at bottom - only shows when keyboard is active */}
      {userRole !== 'viewer' && isMobile && visualViewport?.isKeyboardOpen && (
        <div
          className="mobile-format-bar-container"
          style={{
            position: 'fixed',
            top: visualViewport.offsetTop,
            left: 0,
            right: 0,
            height: visualViewport.height,
            pointerEvents: 'none',
          }}
        >
          <div className="mobile-format-bar" style={{ pointerEvents: 'auto' }}>
            <Toolbar editor={editor} />
          </div>
        </div>
      )}
    </div>
  );
}

export default EditorView;
