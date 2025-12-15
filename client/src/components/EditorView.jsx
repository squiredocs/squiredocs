import React, { useState, useMemo, useEffect } from 'react';
import Editor from './Editor';
import Toolbar from './Toolbar';
import MobileActionBar from './MobileActionBar';
import UserProfileBadge from './UserProfileBadge';
import ShareDialog from './ShareDialog';
import { useYjs } from '../hooks/useYjs';
import { useAuth } from '../contexts/AuthContext';
import { useMobile } from '../hooks/useMobile';
import { useVisualViewport } from '../hooks/useVisualViewport';
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

function EditorView({ docGuid, onNavigateHome, user }) {
  const { logout, api, accessToken } = useAuth();
  const { ydoc, provider, awareness, connected, synced, users, docTitle, setDocTitle } = useYjs(docGuid, accessToken);
  const [editor, setEditor] = useState(null);
  const [shareDialogOpen, setShareDialogOpen] = useState(false);
  const [userRole, setUserRole] = useState(null);
  const [docInfoLoaded, setDocInfoLoaded] = useState(false);
  const isMobile = useMobile();
  const visualViewport = useVisualViewport();

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

  // Generate user color deterministically from user ID
  const userColor = useMemo(() => {
    return user?.id ? generateColorFromId(user.id) : '#4a90e2';
  }, [user?.id]);

  // Complete user info for collaboration
  const collaborationUser = useMemo(() => ({
    name: user?.name || 'Anonymous',
    email: user?.email,
    picture: user?.picture,
    color: userColor
  }), [user, userColor]);

  // Update HTML title when document title changes
  useEffect(() => {
    const title = docTitle || 'Untitled document';
    document.title = `${title} - HeroDocs`;
    
    return () => {
      document.title = 'HeroDocs';
    };
  }, [docTitle]);

  return (
    <div className="app">
      {!connected && (
        <div className="sync-banner sync-banner--disconnected">Offline</div>
      )}
      {connected && !synced && (
        <div className="sync-banner">Syncing...</div>
      )}
      <header className="app-header">
        <div className="app-header-content">
          <div className="app-header-left">
            <button 
              className="back-btn" 
              onClick={onNavigateHome}
              title="Documents Home"
            >
              <svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" width="56" height="56">
                <rect x="4" y="2" width="16" height="20" rx="2" fill="#7c3aed"/>
                <rect x="7" y="7" width="10" height="1.5" rx="0.75" fill="white"/>
                <rect x="7" y="10" width="10" height="1.5" rx="0.75" fill="white"/>
                <rect x="7" y="13" width="6" height="1.5" rx="0.75" fill="white"/>
              </svg>
            </button>
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
            {users.filter(u => u.id !== awareness?.clientID).length > 0 && (
              <div style={{ display: 'flex', alignItems: 'center', marginRight: 8 }}>
                {users
                  .filter(u => u.id !== awareness?.clientID)
                  .slice(0, 5)
                  .map((u, i) => (
                    <div
                      key={u.id}
                      style={{
                        width: 32,
                        height: 32,
                        borderRadius: '50%',
                        marginLeft: i === 0 ? 0 : -8,
                        overflow: 'hidden',
                        boxShadow: `0 0 0 2px ${u.color || '#667eea'}`,
                        zIndex: 5 - i,
                        position: 'relative',
                        flexShrink: 0,
                        background: '#fff'
                      }}
                      title={u.name}
                    >
                      {u.picture ? (
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
                {users.filter(u => u.id !== awareness?.clientID).length > 5 && (
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
            <UserProfileBadge user={user} onLogout={logout} />
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
            user={collaborationUser}
            onEditorReady={setEditor}
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
