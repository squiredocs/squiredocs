import React, { useEffect, useState, useMemo } from 'react';
import Editor from './Editor';
import Toolbar from './Toolbar';
import ConnectionStatus from './ConnectionStatus';
import { useYjs } from '../hooks/useYjs';
import { useAuth } from '../contexts/AuthContext';
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
  const { logout } = useAuth();
  const { ydoc, provider, awareness, connected, synced, users, docTitle, setDocTitle } = useYjs(docGuid);
  const [editor, setEditor] = useState(null);

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

  if (!ydoc || !provider || !synced) {
    return (
      <div className="app-loading">
        <div className="loading-spinner"></div>
        <div>Loading editor... {!synced ? '(syncing...)' : ''}</div>
      </div>
    );
  }

  return (
    <div className="app">
      <header className="app-header">
        <div className="app-header-content">
          <div className="app-header-left">
            <button 
              className="back-btn" 
              onClick={onNavigateHome}
              title="Back to documents"
            >
              ←
            </button>
            <input
              type="text"
              value={docTitle}
              onChange={(e) => setDocTitle(e.target.value)}
              className="app-title-input"
              placeholder="Document title"
              spellCheck={false}
            />
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
            <div className="user-profile">
              {user?.picture ? (
                <img 
                  src={user.picture} 
                  alt={user.name} 
                  className="user-avatar"
                  referrerPolicy="no-referrer"
                />
              ) : (
                <div className="user-avatar-placeholder">
                  {user?.name?.charAt(0).toUpperCase() || '?'}
                </div>
              )}
              <span className="user-name">{user?.name || 'User'}</span>
            </div>
            <button className="logout-btn" onClick={logout}>
              Logout
            </button>
            <ConnectionStatus connected={connected} />
          </div>
        </div>
      </header>
      <div className="app-body">
        <main className="app-main">
          <Toolbar editor={editor} />
          <Editor 
            ydoc={ydoc} 
            provider={provider}
            awareness={awareness} 
            user={collaborationUser}
            synced={synced}
            onEditorReady={setEditor}
          />
        </main>
      </div>
    </div>
  );
}

export default EditorView;
