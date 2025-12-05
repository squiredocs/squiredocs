import React, { useEffect, useState, useMemo } from 'react';
import Editor from './Editor';
import Toolbar from './Toolbar';
import UserList from './UserList';
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

  // Set awareness state with authenticated user info
  useEffect(() => {
    if (awareness && user) {
      awareness.setLocalStateField('user', {
        name: user.name,
        email: user.email,
        picture: user.picture,
        color: userColor
      });
    }
  }, [awareness, user, userColor]);

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
        <aside className="app-sidebar">
          <UserList users={users} currentUserId={awareness?.clientID} />
        </aside>
        <main className="app-main">
          <Toolbar editor={editor} />
          <Editor 
            ydoc={ydoc} 
            provider={provider}
            awareness={awareness} 
            userName={user?.name || 'Anonymous'} 
            userColor={userColor}
            synced={synced}
            onEditorReady={setEditor}
          />
        </main>
      </div>
    </div>
  );
}

export default EditorView;
