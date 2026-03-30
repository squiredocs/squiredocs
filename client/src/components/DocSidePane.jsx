import React, { useState, useMemo, useCallback } from 'react';
import Editor from './Editor';
import { useYjs } from '../hooks/useYjs';
import { useAuth } from '../contexts/AuthContext';
import { generateColorFromId } from '../utils/colorUtils';
import './DocSidePane.css';

function DocSidePane({ docGuid, user, onClose, onOpenFull }) {
  const { accessToken } = useAuth();
  const [editor, setEditor] = useState(null);

  const userColor = useMemo(() => {
    return user?.id ? generateColorFromId(user.id) : '#4a90e2';
  }, [user?.id]);

  const collaborationUser = useMemo(() => user ? ({
    name: user.name || 'Anonymous',
    email: user.email,
    picture: user.picture,
    color: userColor,
  }) : null, [user, userColor]);

  const { ydoc, provider, awareness, synced, docTitle } = useYjs(docGuid, accessToken, collaborationUser);

  const handleOpenFull = useCallback((e) => {
    e.preventDefault();
    onOpenFull(docGuid);
  }, [docGuid, onOpenFull]);

  return (
    <aside className="doc-side-pane">
      <div className="doc-side-pane-header">
        <span className="doc-side-pane-title">{docTitle || 'Untitled'}</span>
        <div className="doc-side-pane-actions">
          <a href={`/d/${docGuid}`} className="doc-side-pane-open-full" onClick={handleOpenFull} title="Open in full editor">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M18 13v6a2 2 0 01-2 2H5a2 2 0 01-2-2V8a2 2 0 012-2h6" />
              <polyline points="15 3 21 3 21 9" />
              <line x1="10" y1="14" x2="21" y2="3" />
            </svg>
          </a>
          <button className="doc-side-pane-close" onClick={onClose} title="Close document" aria-label="Close document">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </div>
      </div>
      <div className="doc-side-pane-editor">
        <Editor
          ydoc={ydoc}
          awareness={awareness}
          provider={provider}
          onEditorReady={setEditor}
          editable={true}
          synced={synced}
        />
      </div>
    </aside>
  );
}

export default DocSidePane;
