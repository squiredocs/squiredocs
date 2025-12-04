import React, { useEffect, useState } from 'react';
import Editor from './Editor';
import Toolbar from './Toolbar';
import UserList from './UserList';
import ConnectionStatus from './ConnectionStatus';
import { useYjs } from '../hooks/useYjs';
import './EditorView.css';

function EditorView({ docGuid, onNavigateHome }) {
  const { ydoc, provider, awareness, connected, synced, users, docTitle, setDocTitle } = useYjs(docGuid);
  const [editor, setEditor] = useState(null);
  const [userName, setUserName] = useState(() => {
    const stored = localStorage.getItem('userName');
    return stored || `User ${Math.floor(Math.random() * 1000)}`;
  });
  const [userColor] = useState(() => {
    const stored = localStorage.getItem('userColor');
    return stored || `#${Math.floor(Math.random() * 16777215).toString(16)}`;
  });

  useEffect(() => {
    if (userName) {
      localStorage.setItem('userName', userName);
    }
  }, [userName]);

  useEffect(() => {
    if (userColor) {
      localStorage.setItem('userColor', userColor);
    }
  }, [userColor]);

  useEffect(() => {
    if (awareness) {
      awareness.setLocalStateField('user', {
        name: userName,
        color: userColor
      });
    }
  }, [awareness, userName, userColor]);

  if (!ydoc || !provider || !synced) {
    return (
      <div className="app-loading">
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
            <input
              type="text"
              value={userName}
              onChange={(e) => setUserName(e.target.value)}
              className="user-name-input"
              placeholder="Your name"
            />
            <ConnectionStatus connected={connected} />
          </div>
        </div>
      </header>
      <div className="app-body">
        <aside className="app-sidebar">
          <UserList users={users} />
        </aside>
        <main className="app-main">
          <Toolbar editor={editor} />
          <Editor 
            ydoc={ydoc} 
            provider={provider}
            awareness={awareness} 
            userName={userName} 
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

