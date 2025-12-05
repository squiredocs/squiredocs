import { useEditor, EditorContent } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import Underline from '@tiptap/extension-underline';
import Collaboration from '@tiptap/extension-collaboration';
import CollaborationCursor from '@tiptap/extension-collaboration-cursor';
import { useMemo, useEffect, useRef, useCallback } from 'react';
import './Editor.css';

// Create cursor element with label
function renderCursor(user) {
  const cursor = document.createElement('span');
  cursor.classList.add('collaboration-cursor__caret');
  cursor.style.borderColor = user.color;

  const label = document.createElement('span');
  label.classList.add('collaboration-cursor__label');
  label.style.backgroundColor = user.color;
  label.textContent = user.name;
  cursor.appendChild(label);

  return cursor;
}

export default function Editor({ ydoc, awareness, provider, user: userInfo, synced, onEditorReady }) {
  const hideTimeoutRef = useRef(null);

  const user = useMemo(() => ({
    name: userInfo?.name || 'Anonymous',
    color: userInfo?.color || '#000000',
    picture: userInfo?.picture,
    email: userInfo?.email
  }), [userInfo]);

  // Show all cursor labels, then hide after 2 seconds
  const showCursorLabels = useCallback(() => {
    document.querySelectorAll('.collaboration-cursor__label')
      .forEach(label => label.classList.add('collaboration-cursor__label--visible'));

    // Clear existing timeout
    if (hideTimeoutRef.current) {
      clearTimeout(hideTimeoutRef.current);
    }

    // Hide after 2 seconds (query fresh elements)
    hideTimeoutRef.current = setTimeout(() => {
      document.querySelectorAll('.collaboration-cursor__label')
        .forEach(label => label.classList.remove('collaboration-cursor__label--visible'));
    }, 2000);
  }, []);

  const extensions = useMemo(() => {
    const baseExtensions = [
      StarterKit.configure({
        history: false // Disable built-in history, Yjs handles it
      }),
      Underline,
      Collaboration.configure({
        document: ydoc,
        field: 'default' // Field name in Yjs document for ProseMirror content
      })
    ];

    if (provider) {
      baseExtensions.push(
        CollaborationCursor.configure({
          provider,
          user,
          render: renderCursor
        })
      );
    }

    return baseExtensions;
  }, [ydoc, provider, user]);

  const editor = useEditor({
    extensions,
    // Don't set initial content - let Yjs Collaboration extension handle it
    // The Collaboration extension will sync content from Yjs
  });

  // Notify parent when editor is ready
  useEffect(() => {
    if (editor && onEditorReady) {
      onEditorReady(editor);
    }
  }, [editor, onEditorReady]);

  // Track cursor movements via awareness and show labels
  useEffect(() => {
    if (!awareness) return;

    // Show all labels on initial load (slight delay for DOM to render cursors)
    const initTimeout = setTimeout(showCursorLabels, 100);

    // Track previous cursor positions to detect actual movement
    const prevPositions = new Map();

    const handleAwarenessChange = ({ added, updated }) => {
      const changedIds = [...added, ...updated];
      let hasMovement = false;
      
      changedIds.forEach(clientId => {
        const state = awareness.getStates().get(clientId);
        if (!state?.cursor) return;

        const prevPos = prevPositions.get(clientId);
        const newPos = JSON.stringify(state.cursor);
        
        if (prevPos !== newPos) {
          prevPositions.set(clientId, newPos);
          hasMovement = true;
        }
      });

      if (hasMovement || added.length > 0) {
        showCursorLabels();
      }
    };

    awareness.on('change', handleAwarenessChange);

    return () => {
      clearTimeout(initTimeout);
      if (hideTimeoutRef.current) clearTimeout(hideTimeoutRef.current);
      awareness.off('change', handleAwarenessChange);
    };
  }, [awareness, showCursorLabels]);

  if (!editor || !ydoc || !synced) {
    return <div className="editor-loading">Loading editor... {!synced ? '(syncing...)' : ''}</div>;
  }

  return (
    <div className="editor-container">
      <EditorContent editor={editor} className="editor-content" />
    </div>
  );
}

